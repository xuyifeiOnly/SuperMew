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

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatDateValue = (value: Date): string => {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
};

const isNumericLike = (value: string): boolean => /^[-+]?\d+(?:\.\d+)?$/.test(value);

export class DocumentLoaderService {
  private buildTextFilename(rawFilename: string): string {
    const normalized = path.basename(String(rawFilename ?? '').trim());
    if (!normalized) {
      return `text_${Date.now()}.txt`;
    }
    return normalized.toLowerCase().endsWith('.txt') ? normalized : `${normalized}.txt`;
  }

  private decodeTextBuffer(buffer: Buffer): string {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return buffer.subarray(3).toString('utf-8');
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.subarray(2).toString('utf16le');
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      const sliced = buffer.subarray(2);
      const swapped = Buffer.allocUnsafe(sliced.length);
      for (let i = 0; i < sliced.length; i += 2) {
        swapped[i] = sliced[i + 1] ?? 0;
        swapped[i + 1] = sliced[i] ?? 0;
      }
      return swapped.toString('utf16le');
    }
    return buffer.toString('utf-8');
  }

  private formatExcelCell(value: unknown, cell: XLSX.CellObject | undefined): string {
    if (value == null) {
      return '';
    }

    if (value instanceof Date) {
      return formatDateValue(value);
    }

    if (typeof value === 'number') {
      const maybeDate = XLSX.SSF.is_date?.(cell?.z ?? '') || cell?.t === 'd';
      if (maybeDate) {
        const parsed = XLSX.SSF.parse_date_code(value);
        if (parsed) {
          return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
        }
      }
      const formatted = cell ? String(XLSX.utils.format_cell(cell) ?? '').trim() : '';
      if (formatted && formatted !== String(value)) {
        return normalizeText(formatted);
      }
      return String(value);
    }

    return normalizeText(String(value));
  }

  private buildExcelMatrix(sheet: XLSX.WorkSheet, range: XLSX.Range): string[][] {
    const rows: string[][] = [];
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      const values: string[] = [];
      for (let col = range.s.c; col <= range.e.c; col += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = sheet[address];
        values.push(this.formatExcelCell(cell?.v, cell));
      }
      rows.push(values);
    }
    return rows;
  }

  private getRowStats(row: string[]): { nonEmpty: number; textCells: number; numericCells: number } {
    let nonEmpty = 0;
    let textCells = 0;
    let numericCells = 0;
    for (const cell of row) {
      const value = normalizeText(cell);
      if (!value) {
        continue;
      }
      nonEmpty += 1;
      if (isNumericLike(value)) {
        numericCells += 1;
      } else {
        textCells += 1;
      }
    }
    return { nonEmpty, textCells, numericCells };
  }

  private detectHeaderRows(rows: string[][]): { headerStart: number; headerEnd: number } {
    const candidateWindow = Math.min(rows.length, 10);
    let headerStart = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < candidateWindow; index += 1) {
      const stats = this.getRowStats(rows[index]);
      if (!stats.nonEmpty) {
        continue;
      }
      const score = stats.textCells * 3 + stats.nonEmpty - stats.numericCells * 2;
      if (score > bestScore) {
        bestScore = score;
        headerStart = index;
      }
    }

    let headerEnd = headerStart;
    for (let index = headerStart + 1; index < Math.min(rows.length, headerStart + 3); index += 1) {
      const stats = this.getRowStats(rows[index]);
      if (!stats.nonEmpty) {
        break;
      }
      if (stats.textCells >= stats.numericCells && stats.textCells >= Math.ceil(stats.nonEmpty / 2)) {
        headerEnd = index;
        continue;
      }
      break;
    }

    return { headerStart, headerEnd };
  }

  private buildExcelHeaders(rows: string[][], headerStart: number, headerEnd: number): string[] {
    const width = Math.max(...rows.map((row) => row.length), 0);
    const headers: string[] = [];
    for (let col = 0; col < width; col += 1) {
      const parts: string[] = [];
      for (let row = headerStart; row <= headerEnd; row += 1) {
        const value = normalizeText(rows[row]?.[col] ?? '');
        if (!value || parts.includes(value)) {
          continue;
        }
        parts.push(value);
      }
      headers.push(parts.join(' / ') || `列${col + 1}`);
    }
    return headers;
  }

  private summarizeExcelRow(fields: Array<{ header: string; value: string }>): string {
    const brief = fields
      .slice(0, 6)
      .map(({ header, value }) => `${header}为${value}`)
      .join('；');
    return brief ? `记录摘要：${brief}` : '';
  }

  private normalizeExcelSheet(sheetName: string, sheet: XLSX.WorkSheet): string {
    const ref = sheet['!ref'];
    if (!ref) {
      return `工作表：${sheetName}`;
    }

    const range = XLSX.utils.decode_range(ref);
    const rows = this.buildExcelMatrix(sheet, range);
    if (!rows.length) {
      return `工作表：${sheetName}`;
    }
    const { headerStart, headerEnd } = this.detectHeaderRows(rows);
    const headers = this.buildExcelHeaders(rows, headerStart, headerEnd);

    const lines: string[] = [`工作表：${sheetName}`, `表头：${headers.join(' | ')}`];

    for (let row = headerEnd + 1; row < rows.length; row += 1) {
      const rowValues = rows[row] ?? [];
      const fields: Array<{ header: string; value: string }> = [];
      for (let col = 0; col < headers.length; col += 1) {
        const header = headers[col];
        const value = normalizeText(rowValues[col] ?? '');
        if (!value) {
          continue;
        }
        fields.push({ header, value });
      }
      if (!fields.length) {
        continue;
      }
      lines.push(`第${row - headerEnd}行`);
      const summary = this.summarizeExcelRow(fields);
      if (summary) {
        lines.push(summary);
      }
      lines.push(...fields.map((field) => `${field.header}: ${field.value}`));
    }

    return lines.join('\n');
  }

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
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sections: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      sections.push(this.normalizeExcelSheet(sheetName, sheet));
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
    } else if (lower.endsWith('.txt')) {
      fileType = 'Text';
      const text = this.decodeTextBuffer(buffer);
      pages = this.splitTextByPageBreak(text);
      if (!pages.length) {
        pages = [{ pageNumber: 1, text: normalizeText(text) }];
      }
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

  loadPlainText(rawText: string, rawFilename: string, filePath: string): LoadedDocumentChunk[] {
    const filename = this.buildTextFilename(rawFilename);
    const normalized = normalizeText(String(rawText ?? ''));
    const pages = this.splitTextByPageBreak(normalized);
    const safePages = pages.length ? pages : [{ pageNumber: 1, text: normalized }];

    const documents: LoadedDocumentChunk[] = [];
    let pageGlobalChunkIndex = 0;
    for (const page of safePages) {
      const baseDoc = {
        filename,
        file_type: 'Text',
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
      if (
        !(
          lower.endsWith('.pdf') ||
          lower.endsWith('.docx') ||
          lower.endsWith('.doc') ||
          lower.endsWith('.xlsx') ||
          lower.endsWith('.xls') ||
          lower.endsWith('.txt')
        )
      ) {
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
