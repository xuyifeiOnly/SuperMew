import type { LoadedDocumentChunk } from '../types.js';
import { EmbeddingService } from './embedding-service.js';
import { MilvusManager } from './milvus-manager.js';

export class MilvusWriter {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly milvusManager: MilvusManager,
  ) {}

  async writeDocuments(
    documents: LoadedDocumentChunk[],
    batchSize = 50,
    progressCallback?: (processed: number, total: number) => void,
  ): Promise<void> {
    if (!documents.length) {
      return;
    }
    await this.milvusManager.ensureCollection();
    this.embeddingService.incrementAddDocuments(documents.map((item) => item.text));
    const total = documents.length;
    let processed = 0;
    progressCallback?.(processed, total);

    for (let index = 0; index < documents.length; index += batchSize) {
      const batch = documents.slice(index, index + batchSize);
      const texts = batch.map((item) => item.text);
      const [denseEmbeddings, sparseEmbeddings] = await this.embeddingService.getAllEmbeddings(texts);
      const rows = batch.map((doc, rowIndex) => ({
        dense_embedding: denseEmbeddings[rowIndex],
        sparse_embedding: sparseEmbeddings[rowIndex],
        text: doc.text,
        filename: doc.filename,
        file_type: doc.file_type,
        file_path: doc.file_path,
        page_number: doc.page_number,
        chunk_idx: doc.chunk_idx,
        chunk_id: doc.chunk_id,
        parent_chunk_id: doc.parent_chunk_id,
        root_chunk_id: doc.root_chunk_id,
        chunk_level: doc.chunk_level,
      }));
      await this.milvusManager.insert(rows);
      processed += batch.length;
      progressCallback?.(processed, total);
    }
  }
}
