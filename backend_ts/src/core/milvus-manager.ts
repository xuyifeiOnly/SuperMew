import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { env } from '../config.js';
import type { RetrievedChunk } from '../types.js';

type MilvusSearchResult = RetrievedChunk[];
const QUERY_MAX_LIMIT = 16384;
const SEARCH_OUTPUT_FIELDS = [
  'text',
  'filename',
  'file_type',
  'file_path',
  'page_number',
  'chunk_id',
  'parent_chunk_id',
  'root_chunk_id',
  'chunk_level',
  'chunk_idx',
];

export class MilvusManager {
  private client: MilvusClient | null = null;
  private collectionLoaded = false;

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }

  private getClient(): MilvusClient {
    if (!this.client) {
      this.client = new MilvusClient({
        address: `${env.milvusHost}:${env.milvusPort}`,
      });
    }
    return this.client;
  }

  private async hasCollection(): Promise<boolean> {
    try {
      const response = (await this.getClient().hasCollection({
        collection_name: env.milvusCollection,
      })) as unknown as Record<string, unknown>;
      return Boolean(response?.value ?? response?.has_collection ?? response);
    } catch {
      return false;
    }
  }

  async ensureCollection(denseDim = env.denseEmbeddingDim): Promise<void> {
    const exists = await this.hasCollection();
    if (exists) {
      return;
    }
    await this.getClient().createCollection({
      collection_name: env.milvusCollection,
      enable_dynamic_field: true,
      fields: [
        { name: 'id', data_type: 5, is_primary_key: true, autoID: true },
        { name: 'dense_embedding', data_type: 101, dim: denseDim },
        { name: 'sparse_embedding', data_type: 104 },
        { name: 'text', data_type: 21, max_length: 2000 },
        { name: 'filename', data_type: 21, max_length: 255 },
        { name: 'file_type', data_type: 21, max_length: 50 },
        { name: 'file_path', data_type: 21, max_length: 1024 },
        { name: 'page_number', data_type: 5 },
        { name: 'chunk_idx', data_type: 5 },
        { name: 'chunk_id', data_type: 21, max_length: 512 },
        { name: 'parent_chunk_id', data_type: 21, max_length: 512 },
        { name: 'root_chunk_id', data_type: 21, max_length: 512 },
        { name: 'chunk_level', data_type: 5 },
      ],
    });

    try {
      await this.getClient().createIndex({
        collection_name: env.milvusCollection,
        field_name: 'dense_embedding',
        index_name: 'dense_embedding_idx',
        index_type: 'HNSW',
        metric_type: 'IP',
        params: { M: 16, efConstruction: 256 },
      });
      await this.getClient().createIndex({
        collection_name: env.milvusCollection,
        field_name: 'sparse_embedding',
        index_name: 'sparse_embedding_idx',
        index_type: 'SPARSE_INVERTED_INDEX',
        metric_type: 'IP',
        params: { drop_ratio_build: 0.2 },
      });
    } catch {
      return;
    }
  }

  private async ensureCollectionLoaded(): Promise<void> {
    if (this.collectionLoaded) {
      return;
    }
    await this.getClient().loadCollection({
      collection_name: env.milvusCollection,
    });
    this.collectionLoaded = true;
  }

  async insert(data: Array<Record<string, unknown>>): Promise<void> {
    await this.getClient().insert({
      collection_name: env.milvusCollection,
      fields_data: data,
    });
  }

  async query(filterExpr = '', outputFields: string[] = ['filename', 'file_type'], limit = 10000, offset = 0): Promise<any[]> {
    await this.ensureCollection();
    await this.ensureCollectionLoaded();
    const response = await this.getClient().query({
      collection_name: env.milvusCollection,
      expr: filterExpr,
      output_fields: outputFields,
      limit: Math.min(limit, QUERY_MAX_LIMIT),
      offset,
    });
    return (response?.data ?? response ?? []) as any[];
  }

  async queryAll(filterExpr = '', outputFields: string[] = ['filename', 'file_type']): Promise<any[]> {
    const all: any[] = [];
    let offset = 0;
    while (true) {
      const batch = await this.query(filterExpr, outputFields, QUERY_MAX_LIMIT, offset);
      if (!batch.length) {
        break;
      }
      all.push(...batch);
      if (batch.length < QUERY_MAX_LIMIT) {
        break;
      }
      offset += batch.length;
    }
    return all;
  }

  private normalizeHits(raw: any): MilvusSearchResult {
    const groups = raw?.results ?? raw?.data ?? raw ?? [];
    const flattened = Array.isArray(groups[0]) ? groups.flat() : groups;
    return flattened.map((item: any) => {
      const entity = item.entity ?? item;
      return {
        filename: entity.filename ?? '',
        text: entity.text ?? '',
        file_type: entity.file_type ?? '',
        file_path: entity.file_path ?? '',
        page_number: entity.page_number ?? 0,
        chunk_id: entity.chunk_id ?? '',
        parent_chunk_id: entity.parent_chunk_id ?? '',
        root_chunk_id: entity.root_chunk_id ?? '',
        chunk_level: entity.chunk_level ?? 0,
        chunk_idx: entity.chunk_idx ?? 0,
        score: item.score ?? item.distance ?? entity.score ?? 0,
      };
    });
  }

  async denseRetrieve(denseEmbedding: number[], topK = 5, filterExpr = ''): Promise<MilvusSearchResult> {
    await this.ensureCollection();
    await this.ensureCollectionLoaded();
    try {
      const response = await this.getClient().search({
        collection_name: env.milvusCollection,
        data: denseEmbedding,
        anns_field: 'dense_embedding',
        output_fields: SEARCH_OUTPUT_FIELDS,
        limit: topK,
        expr: filterExpr,
        metric_type: 'IP',
        params: { ef: 64 },
      });
      const hits = this.normalizeHits(response);
      if (!hits.length) {
        console.warn(`[Milvus] dense search returned 0 hits. collection=${env.milvusCollection} topK=${topK} expr=${filterExpr || '<empty>'}`);
      }
      return hits;
    } catch (error) {
      console.error(
        `[Milvus] dense search failed. collection=${env.milvusCollection} topK=${topK} expr=${filterExpr || '<empty>'} error=${this.formatError(error)}`,
      );
      throw error;
    }
  }

  async hybridRetrieve(
    denseEmbedding: number[],
    sparseEmbedding: Record<number, number>,
    topK = 5,
    filterExpr = '',
  ): Promise<MilvusSearchResult> {
    try {
      await this.ensureCollection();
      await this.ensureCollectionLoaded();
      const response = await this.getClient().hybridSearch({
        collection_name: env.milvusCollection,
        data: [
          {
            data: denseEmbedding,
            anns_field: 'dense_embedding',
            limit: topK * 2,
            expr: filterExpr,
            metric_type: 'IP',
            params: { ef: 64 },
          },
          {
            data: sparseEmbedding,
            anns_field: 'sparse_embedding',
            limit: topK * 2,
            expr: filterExpr,
            metric_type: 'IP',
            params: { drop_ratio_search: 0.2 },
          },
        ],
        rerank: { strategy: 'rrf', params: { k: 60 } },
        limit: topK,
        output_fields: SEARCH_OUTPUT_FIELDS,
      });
      const hits = this.normalizeHits(response);
      if (!hits.length) {
        console.warn(`[Milvus] hybrid search returned 0 hits. collection=${env.milvusCollection} topK=${topK} expr=${filterExpr || '<empty>'}`);
      }
      return hits;
    } catch (error) {
      console.error(
        `[Milvus] hybrid search failed, falling back to dense search. collection=${env.milvusCollection} topK=${topK} expr=${filterExpr || '<empty>'} error=${this.formatError(error)}`,
      );
      return this.denseRetrieve(denseEmbedding, topK, filterExpr);
    }
  }

  async delete(filterExpr: string): Promise<any> {
    return await this.getClient().deleteEntities({
      collection_name: env.milvusCollection,
      expr: filterExpr,
    });
  }

  async dropCollection(): Promise<void> {
    const exists = await this.hasCollection();
    if (!exists) {
      this.collectionLoaded = false;
      return;
    }
    await this.getClient().dropCollection({
      collection_name: env.milvusCollection,
    });
    this.collectionLoaded = false;
  }
}
