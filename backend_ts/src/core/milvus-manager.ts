import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { env } from '../config.js';
import type { RetrievedChunk } from '../types.js';

type MilvusSearchResult = RetrievedChunk[];
const QUERY_MAX_LIMIT = 16384;

export class MilvusManager {
  private client: any;
  private collectionLoaded = false;

  constructor() {
    this.client = new MilvusClient({
      address: `${env.milvusHost}:${env.milvusPort}`,
    });
  }

  private async hasCollection(): Promise<boolean> {
    try {
      const response = await this.client.hasCollection({ collection_name: env.milvusCollection });
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
    await this.client.createCollection({
      collection_name: env.milvusCollection,
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
      await this.client.createIndex({
        collection_name: env.milvusCollection,
        field_name: 'dense_embedding',
        index_name: 'dense_embedding_idx',
        index_type: 'HNSW',
        metric_type: 'IP',
        params: { M: 16, efConstruction: 256 },
      });
      await this.client.createIndex({
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
    await this.client.loadCollection({
      collection_name: env.milvusCollection,
    });
    this.collectionLoaded = true;
  }

  async insert(data: Array<Record<string, unknown>>): Promise<void> {
    await this.client.insert({
      collection_name: env.milvusCollection,
      fields_data: data,
    });
  }

  async query(filterExpr = '', outputFields: string[] = ['filename', 'file_type'], limit = 10000, offset = 0): Promise<any[]> {
    await this.ensureCollection();
    await this.ensureCollectionLoaded();
    const response = await this.client.query({
      collection_name: env.milvusCollection,
      expr: filterExpr,
      output_fields: outputFields,
      limit: Math.min(limit, QUERY_MAX_LIMIT),
      offset,
    });
    return response?.data ?? response ?? [];
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
    const response = await this.client.search({
      collection_name: env.milvusCollection,
      vector: denseEmbedding,
      anns_field: 'dense_embedding',
      output_fields: [
        'text',
        'filename',
        'file_type',
        'page_number',
        'chunk_id',
        'parent_chunk_id',
        'root_chunk_id',
        'chunk_level',
        'chunk_idx',
      ],
      limit: topK,
      expr: filterExpr,
      search_params: {
        metric_type: 'IP',
        params: JSON.stringify({ ef: 64 }),
      },
    });
    return this.normalizeHits(response);
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
      const response = await this.client.hybridSearch({
        collection_name: env.milvusCollection,
        reqs: [
          {
            data: [denseEmbedding],
            anns_field: 'dense_embedding',
            limit: topK * 2,
            expr: filterExpr,
            param: { metric_type: 'IP', params: { ef: 64 } },
          },
          {
            data: [sparseEmbedding],
            anns_field: 'sparse_embedding',
            limit: topK * 2,
            expr: filterExpr,
            param: { metric_type: 'IP', params: { drop_ratio_search: 0.2 } },
          },
        ],
        ranker: { strategy: 'rrf', params: { k: 60 } },
        limit: topK,
        output_fields: [
          'text',
          'filename',
          'file_type',
          'page_number',
          'chunk_id',
          'parent_chunk_id',
          'root_chunk_id',
          'chunk_level',
          'chunk_idx',
        ],
      });
      return this.normalizeHits(response);
    } catch {
      return this.denseRetrieve(denseEmbedding, topK, filterExpr);
    }
  }

  async delete(filterExpr: string): Promise<any> {
    return await this.client.deleteEntities({
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
    await this.client.dropCollection({
      collection_name: env.milvusCollection,
    });
    this.collectionLoaded = false;
  }
}
