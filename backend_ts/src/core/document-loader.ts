import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import WordExtractor from 'word-extractor';
import XLSX from 'xlsx';
import type { LoadedDocumentChunk } from '../types.js';
import { normalizeText } from './shared.js';

const chunkText = (text: string, chunkSize: number, overlap: number): string[] => {
  const clean = normalizeText(text.replace(/\r/g, '\n'));
  if (!clean) {
    return [];
  }

  const separators = ['\n\n', '\n', '。', '！', '？', '，', '、', ' ', ''];
  const chunks: string[] = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    if (end < clean.length) {
      for (const separator of separators) {
        if (!separator) {
          break;
        }
        const found = clean.lastIndexOf(separator, end);
        if (found > start + Math.floor(chunkSize / 2)) {
          end = found + separator.length;
          break;
        }
      }
    }

    const piece = clean.slice(start, end).trim();
    if (piece) {
      chunks.push(piece);
    }
    if (end >= clean.length) {
      break;
    }
    start = Math.max(0, end - overlap);
  }

  return chunks;
};

export class DocumentLoaderService {
  private splitTextByPageBreak(text: string): Array<{ pageNumber: number; text: string }> {
    const normalized = String(text ?? "").replace(/\r/g, "\n");
    const chunks = normalized
      .split(/\f+/)
      .map((item) => normalizeText(item))
      .filter(Boolean);
    if (!chunks.length) {
      return [];
    }
    return chunks.map((chunk, index) => ({
      pageNumber: index + 1,
      text: chunk,
    }));
  }

  private async extractPdfPages(buffer: Buffer): Promise<Array<{ pageNumber: number; text: string }>> {
    const pages: Array<{ pageNumber: number; text: string }> = [];
    await pdfParse(buffer, {
      pagerender: async (pageData: any) => {
        const content = await pageData.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });
        const text = (content.items ?? [])
          .map((item: any) => normalizeText(item?.str))
          .filter(Boolean)
          .join(" ");
        pages.push({
          pageNumber: pages.length + 1,
          text,
        });
        return text;
      },
    } as any);
    return pages.filter((page) => Boolean(normalizeText(page.text)));
  }

  private buildChunkId(filename: string, pageNumber: number, level: number, index: number): string {
    return `${filename}::p${pageNumber}::l${level}::${index}`;
  }

  private splitPageToThreeLevels(
    text: string,
    baseDoc: Omit<LoadedDocumentChunk, 'text' | 'chunk_id' | 'parent_chunk_id' | 'root_chunk_id' | 'chunk_level' | 'chunk_idx'>,
    pageGlobalChunkIndex: number,
  ): LoadedDocumentChunk[] {
    const out: LoadedDocumentChunk[] = [];
    if (!text) {
      return out;
    }

    const level1Chunks = chunkText(text, Math.max(1200, 1000), Math.max(240, 200));
    let level1Counter = 0;
    let level2Counter = 0;
    let level3Counter = 0;
    let chunkIndex = pageGlobalChunkIndex;

    for (const level1Text of level1Chunks) {
      const level1Id = this.buildChunkId(baseDoc.filename, baseDoc.page_number, 1, level1Counter++);
      out.push({
        ...baseDoc,
        text: level1Text,
        chunk_id: level1Id,
        parent_chunk_id: '',
        root_chunk_id: level1Id,
        chunk_level: 1,
        chunk_idx: chunkIndex++,
      });

      const level2Chunks = chunkText(level1Text, Math.max(600, 500), Math.max(120, 100));
      for (const level2Text of level2Chunks) {
        const level2Id = this.buildChunkId(baseDoc.filename, baseDoc.page_number, 2, level2Counter++);
        out.push({
          ...baseDoc,
          text: level2Text,
          chunk_id: level2Id,
          parent_chunk_id: level1Id,
          root_chunk_id: level1Id,
          chunk_level: 2,
          chunk_idx: chunkIndex++,
        });

        const level3Chunks = chunkText(level2Text, Math.max(300, 250), Math.max(60, 50));
        for (const level3Text of level3Chunks) {
          out.push({
            ...baseDoc,
            text: level3Text,
            chunk_id: this.buildChunkId(baseDoc.filename, baseDoc.page_number, 3, level3Counter++),
            parent_chunk_id: level2Id,
            root_chunk_id: level1Id,
            chunk_level: 3,
            chunk_idx: chunkIndex++,
          });
        }
      }
    }

    return out;
  }

  private normalizeWorkbook(buffer: Buffer): string {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sections: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
      const body = rows.map((row) => row.map((item) => String(item ?? '')).join('\t')).join('\n');
      sections.push(`工作表：${sheetName}\n${body}`);
    }
    return sections.join('\n\n');
  }

  private async extractLegacyWordText(filePath: string, fileBuffer?: Buffer): Promise<string> {
    const extractor = new WordExtractor();
    const document = await extractor.extract(fileBuffer ?? filePath);
    return normalizeText(document.getBody?.() ?? '');
  }

  async loadDocument(filePath: string, filename: string, fileBuffer?: Buffer): Promise<LoadedDocumentChunk[]> {
    const lower = filename.toLowerCase();
    const buffer = fileBuffer ?? fs.readFileSync(filePath);
    let fileType = '';
    let pages: Array<{ pageNumber: number; text: string }> = [];

    if (lower.endsWith('.pdf')) {
      fileType = 'PDF';
      pages = await this.extractPdfPages(buffer);
      if (!pages.length) {
        const parsed = await pdfParse(buffer);
        pages = [{ pageNumber: 1, text: parsed.text ?? '' }];
      }
    } else if (lower.endsWith('.docx')) {
      fileType = 'Word';
      const result = await mammoth.extractRawText({ buffer });
      pages = this.splitTextByPageBreak(result.value ?? '');
      if (!pages.length) {
        pages = [{ pageNumber: 1, text: result.value ?? '' }];
      }
    } else if (lower.endsWith('.doc')) {
      fileType = 'Word';
      const text = await this.extractLegacyWordText(filePath, fileBuffer);
      pages = this.splitTextByPageBreak(text);
      if (!pages.length) {
        pages = [{ pageNumber: 1, text }];
      }
    } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      fileType = 'Excel';
      pages = [{ pageNumber: 1, text: this.normalizeWorkbook(buffer) }];
    } else {
      throw new Error(`不支持的文件类型: ${filename}`);
    }

    const documents: LoadedDocumentChunk[] = [];
    let pageGlobalChunkIndex = 0;
    for (const page of pages) {
      const baseDoc = {
        filename,
        file_type: fileType,
        file_path: filePath,
        page_number: page.pageNumber,
      };
      const chunks = this.splitPageToThreeLevels(page.text, baseDoc, pageGlobalChunkIndex);
      pageGlobalChunkIndex += chunks.length;
      documents.push(...chunks);
    }
    return documents;
  }

  async loadDocumentsFromFolder(folderPath: string): Promise<LoadedDocumentChunk[]> {
    const allDocuments: LoadedDocumentChunk[] = [];
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filename = entry.name;
      const lower = filename.toLowerCase();
      if (!(lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.doc') || lower.endsWith('.xlsx') || lower.endsWith('.xls'))) {
        continue;
      }

      const filePath = path.join(folderPath, filename);
      try {
        const documents = await this.loadDocument(filePath, filename);
        allDocuments.push(...documents);
      } catch {
        continue;
      }
    }

    return allDocuments;
  }
}
