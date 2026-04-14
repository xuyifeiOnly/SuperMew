import fs from 'node:fs';
import path from 'node:path';
import type { LoadedDocumentChunk } from '../types.js';
import {
  documentLoader,
  HttpError,
  milvusManager,
  milvusWriter,
  parentChunkStore,
  removeBm25StatsForFilename,
} from '../core.js';
import { uploadDir } from '../config.js';

const quoteMilvusString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export interface UploadedDocumentFile {
  originalname?: string;
  buffer: Buffer;
}

const ensureSupportedFilename = (filename: string): string => {
  const normalized = path.basename(String(filename || ''));
  const lower = normalized.toLowerCase();
  if (!normalized) {
    throw new HttpError(400, '文件名不能为空');
  }
  if (!(lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.doc') || lower.endsWith('.xlsx') || lower.endsWith('.xls'))) {
    throw new HttpError(400, '仅支持 PDF、Word 和 Excel 文档');
  }
  return normalized;
};

const splitDocumentsByLevel = (documents: LoadedDocumentChunk[]) => {
  const parentDocs = documents.filter((item) => item.chunk_level === 1 || item.chunk_level === 2);
  const leafDocs = documents.filter((item) => item.chunk_level === 3);
  return { parentDocs, leafDocs };
};

export const listDocuments = async (): Promise<Array<{ filename: string; file_type: string; chunk_count: number }>> => {
  await milvusManager.ensureCollection();
  const results = await milvusManager.query('', ['filename', 'file_type'], 10000);

  const fileStats = new Map<string, { filename: string; file_type: string; chunk_count: number }>();
  for (const item of results) {
    const filename = String(item.filename ?? '');
    const fileType = String(item.file_type ?? '');
    if (!filename) {
      continue;
    }

    const current = fileStats.get(filename) ?? {
      filename,
      file_type: fileType,
      chunk_count: 0,
    };
    current.chunk_count += 1;
    fileStats.set(filename, current);
  }

  return [...fileStats.values()];
};

export const uploadDocument = async (file?: UploadedDocumentFile) => {
  if (!file) {
    throw new HttpError(400, '缺少上传文件');
  }

  const filename = ensureSupportedFilename(String(file.originalname || ''));
  fs.mkdirSync(uploadDir, { recursive: true });
  await milvusManager.ensureCollection();

  const deleteExpr = `filename == "${quoteMilvusString(filename)}"`;
  try {
    await removeBm25StatsForFilename(filename);
  } catch {}
  try {
    await milvusManager.delete(deleteExpr);
  } catch {}
  try {
    await parentChunkStore.deleteByFilename(filename);
  } catch {}

  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, file.buffer);

  let documents: LoadedDocumentChunk[];
  try {
    documents = await documentLoader.loadDocument(filePath, filename, file.buffer);
  } catch (error) {
    throw new HttpError(500, `文档处理失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!documents.length) {
    throw new HttpError(500, '文档处理失败，未能提取内容');
  }

  const { parentDocs, leafDocs } = splitDocumentsByLevel(documents);
  if (!leafDocs.length) {
    throw new HttpError(500, '文档处理失败，未生成可检索叶子分块');
  }

  await parentChunkStore.upsertDocuments(parentDocs);
  await milvusWriter.writeDocuments(leafDocs);

  return {
    filename,
    chunks_processed: leafDocs.length,
    message: `成功上传并处理 ${filename}，叶子分块 ${leafDocs.length} 个，父级分块 ${parentDocs.length} 个（存入 PostgreSQL）`,
  };
};

export const deleteDocument = async (rawFilename: string) => {
  const filename = path.basename(String(rawFilename ?? ''));
  if (!filename) {
    throw new HttpError(400, '文件名不能为空');
  }

  await milvusManager.ensureCollection();
  await removeBm25StatsForFilename(filename);
  const deleteExpr = `filename == "${quoteMilvusString(filename)}"`;
  const result = await milvusManager.delete(deleteExpr);
  await parentChunkStore.deleteByFilename(filename);

  return {
    filename,
    chunks_deleted: Number(result?.delete_count ?? 0),
    message: `成功删除文档 ${filename} 的向量数据（本地文件已保留）`,
  };
};
