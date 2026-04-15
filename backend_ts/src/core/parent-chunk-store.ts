import { Op } from 'sequelize';
import { cache } from './cache.js';
import { ParentChunk } from '../models.js';
import type { LoadedDocumentChunk } from '../types.js';

export class ParentChunkStore {
  private cacheKey(chunkId: string): string {
    return `parent_chunk:${chunkId}`;
  }

  async upsertDocuments(docs: LoadedDocumentChunk[]): Promise<number> {
    let count = 0;
    for (const doc of docs) {
      if (!doc.chunk_id) {
        continue;
      }
      await ParentChunk.upsert({
        chunkId: doc.chunk_id,
        text: doc.text,
        filename: doc.filename,
        fileType: doc.file_type,
        filePath: doc.file_path,
        pageNumber: doc.page_number,
        parentChunkId: doc.parent_chunk_id,
        rootChunkId: doc.root_chunk_id,
        chunkLevel: doc.chunk_level,
        chunkIdx: doc.chunk_idx,
        updatedAt: new Date(),
      });
      await cache.setJson(this.cacheKey(doc.chunk_id), doc);
      count += 1;
    }
    return count;
  }

  async getDocumentsByIds(chunkIds: string[]): Promise<LoadedDocumentChunk[]> {
    const ordered = new Map<string, LoadedDocumentChunk>();
    const missing: string[] = [];

    for (const chunkId of chunkIds) {
      const cached = await cache.getJson<LoadedDocumentChunk>(this.cacheKey(chunkId));
      if (cached) {
        ordered.set(chunkId, cached);
      } else {
        missing.push(chunkId);
      }
    }

    if (missing.length) {
      const rows = await ParentChunk.findAll({ where: { chunkId: { [Op.in]: missing } } });
      for (const row of rows) {
        const doc: LoadedDocumentChunk = {
          text: row.text,
          filename: row.filename,
          file_type: row.fileType,
          file_path: row.filePath,
          page_number: row.pageNumber,
          chunk_id: row.chunkId,
          parent_chunk_id: row.parentChunkId,
          root_chunk_id: row.rootChunkId,
          chunk_level: row.chunkLevel,
          chunk_idx: row.chunkIdx,
        };
        ordered.set(row.chunkId, doc);
        await cache.setJson(this.cacheKey(row.chunkId), doc);
      }
    }

    return chunkIds.map((id) => ordered.get(id)).filter(Boolean) as LoadedDocumentChunk[];
  }

  async deleteByFilename(filename: string): Promise<number> {
    const rows = await ParentChunk.findAll({ where: { filename } });
    if (!rows.length) {
      return 0;
    }
    await ParentChunk.destroy({ where: { filename } });
    for (const row of rows) {
      await cache.delete(this.cacheKey(row.chunkId));
    }
    return rows.length;
  }

  async deleteAll(): Promise<number> {
    const rows = await ParentChunk.findAll();
    if (!rows.length) {
      return 0;
    }
    await ParentChunk.destroy({ where: {} });
    for (const row of rows) {
      await cache.delete(this.cacheKey(row.chunkId));
    }
    return rows.length;
  }
}
