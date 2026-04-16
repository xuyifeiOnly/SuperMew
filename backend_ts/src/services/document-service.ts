import fs from 'node:fs';
import path from 'node:path';
import type { LoadedDocumentChunk } from '../types.js';
import {
  clearDocumentAccessRules,
  deleteDocumentAccessRule,
  listDocumentAccessRules,
  parseAllowedRoles,
  setDocumentAllowedRoles,
} from '../core/document-access-control.js';
import {
  documentLoader,
  embeddingService,
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

const replaceStoredDocument = async (filename: string, documents: LoadedDocumentChunk[], allowedRoles: string[]) => {
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

  const { parentDocs, leafDocs } = splitDocumentsByLevel(documents);
  if (!leafDocs.length) {
    throw new HttpError(500, `文档 ${filename} 处理失败，未生成可检索叶子分块`);
  }

  await parentChunkStore.upsertDocuments(parentDocs);
  await milvusWriter.writeDocuments(leafDocs);
  await setDocumentAllowedRoles(filename, allowedRoles);

  return {
    filename,
    parentChunkCount: parentDocs.length,
    leafChunkCount: leafDocs.length,
  };
};

export const listDocuments = async (): Promise<Array<{ filename: string; file_type: string; chunk_count: number; allowed_roles: string[] }>> => {
  await milvusManager.ensureCollection();
  const results = await milvusManager.query('', ['filename', 'file_type'], 10000);
  const accessRules = new Map((await listDocumentAccessRules()).map((item) => [item.filename, item.allowed_roles]));

  const fileStats = new Map<string, { filename: string; file_type: string; chunk_count: number; allowed_roles: string[] }>();
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
      allowed_roles: accessRules.get(filename) ?? [],
    };
    current.chunk_count += 1;
    fileStats.set(filename, current);
  }

  return [...fileStats.values()];
};

export const uploadDocument = async (file?: UploadedDocumentFile, allowedRolesInput?: unknown) => {
  if (!file) {
    throw new HttpError(400, '缺少上传文件');
  }

  const filename = ensureSupportedFilename(String(file.originalname || ''));
  const allowedRoles = parseAllowedRoles(allowedRolesInput);
  fs.mkdirSync(uploadDir, { recursive: true });
  await milvusManager.ensureCollection();

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
  const result = await replaceStoredDocument(filename, documents, allowedRoles);

  return {
    filename,
    allowed_roles: allowedRoles,
    chunks_processed: result.leafChunkCount,
    parent_chunks_processed: result.parentChunkCount,
    message: `成功上传并处理 ${filename}，叶子分块 ${result.leafChunkCount} 个，父级分块 ${result.parentChunkCount} 个（存入 PostgreSQL）`,
  };
};

export const importDocumentsFromFolder = async (rawFolderPath: string, allowedRolesInput?: unknown) => {
  const inputFolderPath = String(rawFolderPath ?? '').trim();
  if (!inputFolderPath) {
    throw new HttpError(400, '目录路径不能为空');
  }
  const allowedRoles = parseAllowedRoles(allowedRolesInput);
  const folderPath = path.resolve(inputFolderPath);
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new HttpError(400, `目录不存在: ${folderPath}`);
  }

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((filename) => {
      const lower = filename.toLowerCase();
      return lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.doc') || lower.endsWith('.xlsx') || lower.endsWith('.xls');
    });

  if (!filenames.length) {
    throw new HttpError(400, '目录中没有可导入的 PDF、Word 或 Excel 文件');
  }

  fs.mkdirSync(uploadDir, { recursive: true });
  await milvusManager.ensureCollection();

  const allDocuments = await documentLoader.loadDocumentsFromFolder(folderPath);
  const documentsByFilename = new Map<string, LoadedDocumentChunk[]>();
  for (const doc of allDocuments) {
    const current = documentsByFilename.get(doc.filename) ?? [];
    current.push(doc);
    documentsByFilename.set(doc.filename, current);
  }

  const imported: Array<{ filename: string; leaf_chunks: number; parent_chunks: number }> = [];
  const skipped: string[] = [];
  for (const filename of filenames) {
    const documents = documentsByFilename.get(filename) ?? [];
    if (!documents.length) {
      skipped.push(filename);
      continue;
    }

    const targetPath = path.join(uploadDir, filename);
    fs.copyFileSync(path.join(folderPath, filename), targetPath);
    const normalizedDocuments = documents.map((doc) => ({
      ...doc,
      file_path: targetPath,
    }));
    const result = await replaceStoredDocument(filename, normalizedDocuments, allowedRoles);
    imported.push({
      filename,
      leaf_chunks: result.leafChunkCount,
      parent_chunks: result.parentChunkCount,
    });
  }

  return {
    folder_path: folderPath,
    allowed_roles: allowedRoles,
    imported_count: imported.length,
    skipped_count: skipped.length,
    imported,
    skipped,
    message: `目录导入完成，成功 ${imported.length} 个，跳过 ${skipped.length} 个`,
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
  await deleteDocumentAccessRule(filename);

  return {
    filename,
    chunks_deleted: Number(result?.delete_count ?? 0),
    message: `成功删除文档 ${filename} 的向量数据（本地文件已保留）`,
  };
};

export const resetDocumentCollection = async () => {
  await milvusManager.dropCollection();
  const parentChunkCount = await parentChunkStore.deleteAll();
  const accessRuleCount = await clearDocumentAccessRules();
  embeddingService.resetCorpusStats();

  return {
    parent_chunks_deleted: parentChunkCount,
    document_access_rules_deleted: accessRuleCount,
    message: '已清空 Milvus collection、父块存储、文档访问规则和 BM25 统计状态',
  };
};
