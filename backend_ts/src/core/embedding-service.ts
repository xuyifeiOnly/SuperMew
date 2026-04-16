import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';
import { embedByModel, ensureDirectory, hashTextToVector, safeJsonParse, tokenize } from './shared.js';

export class EmbeddingService {
  private statePath = env.bm25StatePath;
  private vocab = new Map<string, number>();
  private docFreq = new Map<string, number>();
  private totalDocs = 0;
  private sumTokenLength = 0;
  private avgDocLength = 1;
  private k1 = 1.5;
  private b = 0.75;

  constructor() {
    ensureDirectory(path.dirname(this.statePath));
    this.loadState();
  }

  private loadState(): void {
    if (!fs.existsSync(this.statePath)) {
      return;
    }
    try {
      const raw = safeJsonParse<{
        version?: number;
        vocab?: Record<string, number>;
        doc_freq?: Record<string, number>;
        total_docs?: number;
        sum_token_len?: number;
      }>(fs.readFileSync(this.statePath, 'utf-8'), {});

      if (raw.version !== 1) {
        return;
      }
      this.vocab = new Map(Object.entries(raw.vocab ?? {}));
      this.docFreq = new Map(Object.entries(raw.doc_freq ?? {}).map(([key, value]) => [key, Number(value)]));
      this.totalDocs = Number(raw.total_docs ?? 0);
      this.sumTokenLength = Number(raw.sum_token_len ?? 0);
      this.recomputeAvgLength();
    } catch {
      return;
    }
  }

  private persist(): void {
    ensureDirectory(path.dirname(this.statePath));
    const payload = {
      version: 1,
      total_docs: this.totalDocs,
      sum_token_len: this.sumTokenLength,
      vocab: Object.fromEntries(this.vocab.entries()),
      doc_freq: Object.fromEntries(this.docFreq.entries()),
    };
    fs.writeFileSync(this.statePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  private recomputeAvgLength(): void {
    this.avgDocLength = this.totalDocs > 0 ? this.sumTokenLength / this.totalDocs : 1;
  }

  incrementAddDocuments(texts: string[]): void {
    for (const text of texts) {
      const tokens = tokenize(text);
      this.sumTokenLength += tokens.length;
      this.totalDocs += 1;
      for (const token of new Set(tokens)) {
        if (!this.vocab.has(token)) {
          this.vocab.set(token, this.vocab.size);
        }
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
      }
    }
    this.recomputeAvgLength();
    this.persist();
  }

  incrementRemoveDocuments(texts: string[]): void {
    for (const text of texts) {
      const tokens = tokenize(text);
      this.sumTokenLength = Math.max(0, this.sumTokenLength - tokens.length);
      this.totalDocs = Math.max(0, this.totalDocs - 1);
      for (const token of new Set(tokens)) {
        const current = this.docFreq.get(token) ?? 0;
        if (current <= 1) {
          this.docFreq.delete(token);
        } else {
          this.docFreq.set(token, current - 1);
        }
      }
    }
    this.recomputeAvgLength();
    this.persist();
  }

  resetCorpusStats(): void {
    this.vocab.clear();
    this.docFreq.clear();
    this.totalDocs = 0;
    this.sumTokenLength = 0;
    this.recomputeAvgLength();
    this.persist();
  }

  private async getRemoteEmbeddings(texts: string[]): Promise<number[][]> {
    if (!env.embeddingModel) {
      throw new Error('embedding model not configured');
    }
    return embedByModel(texts, env.embeddingModel);
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }
    if (env.embeddingProvider === 'glm' && env.embeddingModel) {
      try {
        return await this.getRemoteEmbeddings(texts);
      } catch {
        return texts.map((text) => hashTextToVector(text, env.denseEmbeddingDim));
      }
    }
    return texts.map((text) => hashTextToVector(text, env.denseEmbeddingDim));
  }

  getSparseEmbedding(text: string): Record<number, number> {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      if (!this.vocab.has(token)) {
        this.vocab.set(token, this.vocab.size);
      }
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    const sparse: Record<number, number> = {};
    const n = Math.max(this.totalDocs, 1);
    const avg = Math.max(this.avgDocLength, 1);
    for (const [token, freq] of tf.entries()) {
      const idx = this.vocab.get(token);
      if (idx === undefined) {
        continue;
      }
      const df = this.docFreq.get(token) ?? 0;
      const idf = df === 0 ? Math.log((n + 1) / 1) : Math.log((n - df + 0.5) / (df + 0.5) + 1);
      const numerator = freq * (this.k1 + 1);
      const denominator = freq + this.k1 * (1 - this.b + (this.b * tokens.length) / avg);
      const score = idf * (numerator / denominator);
      if (score > 0) {
        sparse[idx] = Number(score);
      }
    }
    return sparse;
  }

  async getAllEmbeddings(texts: string[]): Promise<[number[][], Array<Record<number, number>>]> {
    return [await this.getEmbeddings(texts), texts.map((text) => this.getSparseEmbedding(text))];
  }
}
