import { env } from '../config.js';
import type { RagTrace, RetrievedChunk } from '../types.js';
import { z } from 'zod';
import { EmbeddingService } from './embedding-service.js';
import { MilvusManager } from './milvus-manager.js';
import { ParentChunkStore } from './parent-chunk-store.js';
import { EmitStep, JsonObject, createChatModel, normalizeText, promptModelText, tokenize } from './shared.js';

const formatDocs = (docs: RetrievedChunk[]): string =>
  docs
    .map(
      (doc, index) =>
        `[${index + 1}] ${doc.filename || 'Unknown'} (Page ${doc.page_number ?? 'N/A'}):\n${doc.text ?? ''}`,
    )
    .join('\n\n---\n\n');

const getRerankEndpoint = (): string => {
  if (!env.rerankBindingHost) {
    return '';
  }
  const host = env.rerankBindingHost.replace(/\/+$/, '');
  return host.endsWith('/v1/rerank') ? host : `${host}/v1/rerank`;
};

export class RagService {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly milvusManager: MilvusManager,
    private readonly parentChunkStore: ParentChunkStore,
  ) {}

  private async chatCompletion(prompt: string, model = env.fastModel || env.model, temperature = 0.2): Promise<string> {
    if (!model) {
      return '';
    }
    return normalizeText(await promptModelText(prompt, model, temperature));
  }

  private emitStep(emit: EmitStep | undefined, icon: string, label: string, detail = ''): Promise<void> {
    return Promise.resolve(emit?.({ icon, label, detail }));
  }

  private async gradeDocuments(question: string, context: string): Promise<{ score: string; route: string; error?: string }> {
    const graderModel = createChatModel(env.gradeModel || env.model, 0);
    if (!graderModel) {
      return {
        score: context ? 'yes' : 'no',
        route: context ? 'generate_answer' : 'rewrite_question',
      };
    }
    const prompt = [
      '你是一个文档相关性评估器。',
      '请只输出 JSON，例如 {"binary_score":"yes"} 或 {"binary_score":"no"}。',
      `检索内容：${context}`,
      `用户问题：${question}`,
    ].join('\n\n');

    try {
      const GradeSchema = z.object({
        binary_score: z.string(),
      });
      const response = await graderModel.withStructuredOutput(GradeSchema).invoke(prompt);
      const score = normalizeText(response.binary_score || '').toLowerCase() === 'yes' ? 'yes' : context ? 'yes' : 'no';
      return {
        score,
        route: score === 'yes' ? 'generate_answer' : 'rewrite_question',
      };
    } catch (error) {
      const score = context ? 'yes' : 'no';
      return {
        score,
        route: score === 'yes' ? 'generate_answer' : 'rewrite_question',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async chooseRewriteStrategy(question: string): Promise<'step_back' | 'hyde' | 'complex'> {
    const routerModel = createChatModel(env.fastModel || env.model, 0);
    if (!routerModel) {
      return 'step_back';
    }
    const prompt = [
      '请为用户问题选择最合适的查询扩展策略，只输出 JSON：{"strategy":"step_back"}。',
      '可选值只有：step_back、hyde、complex。',
      `用户问题：${question}`,
    ].join('\n\n');
    try {
      const StrategySchema = z.object({
        strategy: z.enum(['step_back', 'hyde', 'complex']),
      });
      const decision = await routerModel.withStructuredOutput(StrategySchema).invoke(prompt);
      return decision.strategy;
    } catch {
      return 'step_back';
    }
  }

  private async stepBackExpand(question: string): Promise<{
    stepBackQuestion: string;
    stepBackAnswer: string;
    expandedQuery: string;
  }> {
    const stepBackQuestion = await this.chatCompletion(
      `请把下面问题抽象成更通用的退步问题，只输出一句话：\n${question}`,
      env.fastModel || env.model,
      0.2,
    );
    const stepBackAnswer = stepBackQuestion
      ? await this.chatCompletion(
          `请在 120 字内回答下面退步问题，只输出答案：\n${stepBackQuestion}`,
          env.fastModel || env.model,
          0.2,
        )
      : '';
    const expandedQuery =
      stepBackQuestion || stepBackAnswer
        ? `${question}\n\n退步问题：${stepBackQuestion}\n退步问题答案：${stepBackAnswer}`
        : question;
    return { stepBackQuestion, stepBackAnswer, expandedQuery };
  }

  private async generateHypotheticalDocument(question: string): Promise<string> {
    return await this.chatCompletion(
      `请基于用户问题生成一段可用于检索的假设性文档，只输出正文：\n${question}`,
      env.fastModel || env.model,
      0.4,
    );
  }

  private async rerankDocuments(
    query: string,
    docs: RetrievedChunk[],
    topK: number,
  ): Promise<{ docs: RetrievedChunk[]; meta: JsonObject }> {
    const docsWithRank = docs.map((doc, index) => ({ ...doc, rrf_rank: index + 1 }));
    const meta: JsonObject = {
      rerank_enabled: Boolean(env.rerankModel && env.rerankApiKey && env.rerankBindingHost),
      rerank_applied: false,
      rerank_model: env.rerankModel || null,
      rerank_endpoint: getRerankEndpoint() || null,
      rerank_error: null,
      candidate_count: docsWithRank.length,
    };
    
    if (!meta.rerank_enabled || !docsWithRank.length) {
      return { docs: docsWithRank.slice(0, topK), meta };
    }

    try {
      const response = await fetch(getRerankEndpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.rerankApiKey}`,
        },
        body: JSON.stringify({
          model: env.rerankModel,
          query,
          documents: docsWithRank.map((item) => item.text ?? ''),
          top_n: Math.min(topK, docsWithRank.length),
          return_documents: false,
        }),
      });
      meta.rerank_applied = true;
      if (!response.ok) {
        meta.rerank_error = `HTTP ${response.status}: ${await response.text()}`;
        return { docs: docsWithRank.slice(0, topK), meta };
      }
      const payload = (await response.json()) as { results?: Array<{ index?: number; relevance_score?: number }> };
      const reranked = (payload.results ?? [])
        .map((item) => {
          const idx = Number(item.index);
          if (!Number.isInteger(idx) || idx < 0 || idx >= docsWithRank.length) {
            return null;
          }
          return {
            ...docsWithRank[idx],
            rerank_score: item.relevance_score,
          };
        })
        .filter(Boolean) as RetrievedChunk[];
      if (!reranked.length) {
        meta.rerank_error = 'empty_rerank_results';
      }
      return { docs: (reranked.length ? reranked : docsWithRank).slice(0, topK), meta };
    } catch (error) {
      meta.rerank_error = error instanceof Error ? error.message : String(error);
      return { docs: docsWithRank.slice(0, topK), meta };
    }
  }

  private async autoMergeDocuments(
    docs: RetrievedChunk[],
    topK: number,
  ): Promise<{ docs: RetrievedChunk[]; meta: JsonObject }> {
    if (!env.autoMergeEnabled || !docs.length) {
      return {
        docs: docs.slice(0, topK),
        meta: {
          auto_merge_enabled: env.autoMergeEnabled,
          auto_merge_applied: false,
          auto_merge_threshold: env.autoMergeThreshold,
          auto_merge_replaced_chunks: 0,
          auto_merge_steps: 0,
        },
      };
    }

    const mergeOnce = async (source: RetrievedChunk[]): Promise<{ docs: RetrievedChunk[]; replaced: number }> => {
      const groups = new Map<string, RetrievedChunk[]>();
      for (const doc of source) {
        const parentId = normalizeText(doc.parent_chunk_id);
        if (!parentId) {
          continue;
        }
        const current = groups.get(parentId) ?? [];
        current.push(doc);
        groups.set(parentId, current);
      }

      const parentIds = [...groups.entries()]
        .filter(([, children]) => children.length >= env.autoMergeThreshold)
        .map(([parentId]) => parentId);
      if (!parentIds.length) {
        return { docs: source, replaced: 0 };
      }

      const parentDocs = await this.parentChunkStore.getDocumentsByIds(parentIds);
      const parentMap = new Map(parentDocs.map((item) => [item.chunk_id, item]));
      const merged: RetrievedChunk[] = [];
      let replaced = 0;

      for (const doc of source) {
        const parentId = normalizeText(doc.parent_chunk_id);
        if (!parentId || !parentMap.has(parentId)) {
          merged.push(doc);
          continue;
        }
        const parent = parentMap.get(parentId)!;
        merged.push({
          ...parent,
          score: doc.score,
        });
        replaced += 1;
      }

      const deduped: RetrievedChunk[] = [];
      const seen = new Set<string>();
      for (const doc of merged) {
        const key = doc.chunk_id || `${doc.filename}:${doc.page_number}:${doc.text}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(doc);
      }
      deduped.sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0));
      return { docs: deduped, replaced };
    };

    const first = await mergeOnce(docs);
    const second = await mergeOnce(first.docs);
    return {
      docs: second.docs.slice(0, topK),
      meta: {
        auto_merge_enabled: env.autoMergeEnabled,
        auto_merge_applied: first.replaced + second.replaced > 0,
        auto_merge_threshold: env.autoMergeThreshold,
        auto_merge_replaced_chunks: first.replaced + second.replaced,
        auto_merge_steps: Number(first.replaced > 0) + Number(second.replaced > 0),
      },
    };
  }

  private async keywordFallbackRetrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length) {
      return [];
    }

    const rows = await this.milvusManager.queryAll(`chunk_level == ${env.leafRetrieveLevel}`, [
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
    ]);

    const scored = rows
      .map((row) => {
        const text = String(row.text ?? '');
        if (!text) {
          return null;
        }
        const textTokens = new Set(tokenize(text));
        let overlap = 0;
        for (const token of queryTokens) {
          if (textTokens.has(token)) {
            overlap += 1;
          }
        }
        const includesFullQuery = text.includes(query) ? 1 : 0;
        const score = overlap + includesFullQuery * 2;
        if (score <= 0) {
          return null;
        }
        return {
          filename: String(row.filename ?? ''),
          text,
          file_type: String(row.file_type ?? ''),
          file_path: String(row.file_path ?? ''),
          page_number: Number(row.page_number ?? 0),
          chunk_id: String(row.chunk_id ?? ''),
          parent_chunk_id: String(row.parent_chunk_id ?? ''),
          root_chunk_id: String(row.root_chunk_id ?? ''),
          chunk_level: Number(row.chunk_level ?? env.leafRetrieveLevel),
          chunk_idx: Number(row.chunk_idx ?? 0),
          score,
        } as RetrievedChunk;
      })
      .filter(Boolean) as RetrievedChunk[];

    scored.sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0));
    return scored.slice(0, topK);
  }

  async retrieveDocuments(query: string, topK = 5): Promise<{ docs: RetrievedChunk[]; meta: JsonObject }> {
    const candidateK = Math.max(topK * 3, topK);
    const filterExpr = `chunk_level == ${env.leafRetrieveLevel}`;
    const runKeywordFallback = async (): Promise<{ docs: RetrievedChunk[]; meta: JsonObject }> => {
      const fallbackDocs = await this.keywordFallbackRetrieve(query, topK);
      // 兜底召回也走 rerank + auto-merge，保证 trace 字段与主链路一致。
      const reranked = await this.rerankDocuments(query, fallbackDocs, topK);
      const merged = await this.autoMergeDocuments(reranked.docs, topK);
      return {
        docs: merged.docs,
        meta: {
          ...reranked.meta,
          ...merged.meta,
          retrieval_mode: 'keyword_fallback',
          candidate_k: candidateK,
          leaf_retrieve_level: env.leafRetrieveLevel,
        },
      };
    };
    try {
      await this.milvusManager.ensureCollection();
      // 将用户 query 转成 dense 向量（语义向量），用于 Milvus 的 dense_embedding 近邻检索召回候选。
      const denseEmbedding = (await this.embeddingService.getEmbeddings([query]))[0];
      // 将同一个 query 转成 sparse 向量（BM25 风格稀疏向量），用于 sparse_embedding 关键词/词项召回。
      const sparseEmbedding = this.embeddingService.getSparseEmbedding(query);
      // 进行 hybrid 检索：dense + sparse 两路召回后用 RRF 融合排序，得到候选集合（数量为 candidateK）。
      const retrieved = await this.milvusManager.hybridRetrieve(denseEmbedding, sparseEmbedding, candidateK, filterExpr);
      if (!retrieved.length) {
        return runKeywordFallback();
      }
      const reranked = await this.rerankDocuments(query, retrieved, topK);
      const merged = await this.autoMergeDocuments(reranked.docs, topK);
      return {
        docs: merged.docs,
        meta: {
          ...reranked.meta,
          ...merged.meta,
          retrieval_mode: 'hybrid',
          candidate_k: candidateK,
          leaf_retrieve_level: env.leafRetrieveLevel,
        },
      };
    } catch {
      try {
        const denseEmbedding = (await this.embeddingService.getEmbeddings([query]))[0];
        const retrieved = await this.milvusManager.denseRetrieve(denseEmbedding, candidateK, filterExpr);
        if (!retrieved.length) {
          return runKeywordFallback();
        }
        const reranked = await this.rerankDocuments(query, retrieved, topK);
        const merged = await this.autoMergeDocuments(reranked.docs, topK);
        return {
          docs: merged.docs,
          meta: {
            ...reranked.meta,
            ...merged.meta,
            retrieval_mode: 'dense_fallback',
            candidate_k: candidateK,
            leaf_retrieve_level: env.leafRetrieveLevel,
          },
        };
      } catch {
        return {
          docs: [],
          meta: {
            rerank_enabled: Boolean(env.rerankModel && env.rerankApiKey && env.rerankBindingHost),
            rerank_applied: false,
            rerank_model: env.rerankModel || null,
            rerank_endpoint: getRerankEndpoint() || null,
            rerank_error: 'retrieve_failed',
            retrieval_mode: 'failed',
            candidate_k: candidateK,
            leaf_retrieve_level: env.leafRetrieveLevel,
            auto_merge_enabled: env.autoMergeEnabled,
            auto_merge_applied: false,
            auto_merge_threshold: env.autoMergeThreshold,
            auto_merge_replaced_chunks: 0,
            auto_merge_steps: 0,
          },
        };
      }
    }
  }

  async searchKnowledgeBase(query: string, emit?: EmitStep): Promise<{ text: string; ragTrace: RagTrace }> {
    // 阶段 1：先用原始 query 做一次基础检索，并把关键过程通过 emit 输出给前端。
    await this.emitStep(emit, '🔍', '正在检索知识库...', `查询: ${query.slice(0, 50)}`);
    const initial = await this.retrieveDocuments(query, 5);
    const initialDocs = initial.docs;
    const initialContext = formatDocs(initialDocs);
    await this.emitStep(
      emit,
      '🧱',
      '三级分块检索',
      `叶子层 L${initial.meta.leaf_retrieve_level ?? 3} 召回，候选 ${initial.meta.candidate_k ?? 0}`,
    );
    await this.emitStep(
      emit,
      '🧩',
      'Auto-merging 合并',
      `启用: ${Boolean(initial.meta.auto_merge_enabled)}，应用: ${Boolean(initial.meta.auto_merge_applied)}，替换片段: ${initial.meta.auto_merge_replaced_chunks ?? 0}`,
    );
    await this.emitStep(
      emit,
      '🧭',
      '检索路径',
      `模式: ${String(initial.meta.retrieval_mode ?? 'hybrid')}`,
    );

    // 初始化 RAG 追踪信息：先记录“初次检索”阶段的召回结果和元数据。
    let ragTrace: RagTrace = {
      tool_used: true,
      tool_name: 'search_knowledge_base',
      query,
      expanded_query: query,
      retrieved_chunks: initialDocs,
      initial_retrieved_chunks: initialDocs,
      retrieval_stage: 'initial',
      rerank_enabled: Boolean(initial.meta.rerank_enabled),
      rerank_applied: Boolean(initial.meta.rerank_applied),
      rerank_model: String(initial.meta.rerank_model ?? ''),
      rerank_endpoint: String(initial.meta.rerank_endpoint ?? ''),
      rerank_error: String(initial.meta.rerank_error ?? ''),
      retrieval_mode: String(initial.meta.retrieval_mode ?? 'hybrid'),
      candidate_k: Number(initial.meta.candidate_k ?? 0),
      leaf_retrieve_level: Number(initial.meta.leaf_retrieve_level ?? 3),
      auto_merge_enabled: Boolean(initial.meta.auto_merge_enabled),
      auto_merge_applied: Boolean(initial.meta.auto_merge_applied),
      auto_merge_threshold: Number(initial.meta.auto_merge_threshold ?? env.autoMergeThreshold),
      auto_merge_replaced_chunks: Number(initial.meta.auto_merge_replaced_chunks ?? 0),
      auto_merge_steps: Number(initial.meta.auto_merge_steps ?? 0),
    };

    // 阶段 2：评估初检索上下文是否足够回答，决定“直接回答”还是“重写查询”。
    const grade = await this.gradeDocuments(query, initialContext);
    ragTrace = {
      ...ragTrace,
      grade_score: grade.score,
      grade_route: grade.route,
      rewrite_needed: grade.route !== 'generate_answer',
      grade_error: grade.error ?? null,
    };

    // 相关性足够：直接返回初次检索结果，不再进入扩展检索流程。
    if (grade.route === 'generate_answer') {
      await this.emitStep(emit, '✅', '文档相关性评估通过', `评分: ${grade.score}`);
      return {
        text: initialDocs.length ? `Retrieved Chunks:\n${initialContext}` : 'No relevant documents found in the knowledge base.',
        ragTrace,
      };
    }

    await this.emitStep(emit, '⚠️', '文档相关性不足，将重写查询', `评分: ${grade.score}`);
    await this.emitStep(emit, '✏️', '正在重写查询...');
    // 阶段 3：选择查询扩展策略（step_back / hyde / complex）。
    const strategy = await this.chooseRewriteStrategy(query);
    let expandedQuery = query;
    let stepBackQuestion = '';
    let stepBackAnswer = '';
    let hypotheticalDoc = '';

    if (strategy === 'step_back' || strategy === 'complex') {
      await this.emitStep(emit, '🧠', `使用策略: ${strategy}`, '生成退步问题');
      const result = await this.stepBackExpand(query);
      expandedQuery = result.expandedQuery;
      stepBackQuestion = result.stepBackQuestion;
      stepBackAnswer = result.stepBackAnswer;
    }
    if (strategy === 'hyde' || strategy === 'complex') {
      await this.emitStep(emit, '📝', 'HyDE 假设性文档生成中...');
      hypotheticalDoc = await this.generateHypotheticalDocument(query);
    }

    const mergedDocs: RetrievedChunk[] = [];
    const rerankErrors: string[] = [];
    let retrievalMode = '';
    let candidateK = 0;
    let leafRetrieveLevel = env.leafRetrieveLevel;
    let autoMergeApplied = false;
    let autoMergeEnabled = env.autoMergeEnabled;
    let autoMergeThreshold = env.autoMergeThreshold;
    let autoMergeReplacedChunks = 0;
    let autoMergeSteps = 0;
    let rerankApplied = false;
    let rerankEnabled = false;
    let rerankModel = '';
    let rerankEndpoint = '';

    // 按策略执行检索并汇总结果，同时累计 rerank/merge 等可观测元数据。
    const collect = async (sourceQuery: string, label: string): Promise<void> => {
      const response = await this.retrieveDocuments(sourceQuery, 5);
      mergedDocs.push(...response.docs);
      retrievalMode = retrievalMode || String(response.meta.retrieval_mode ?? '');
      candidateK = candidateK || Number(response.meta.candidate_k ?? 0);
      leafRetrieveLevel = Number(response.meta.leaf_retrieve_level ?? leafRetrieveLevel);
      autoMergeEnabled = Boolean(response.meta.auto_merge_enabled);
      autoMergeApplied = autoMergeApplied || Boolean(response.meta.auto_merge_applied);
      autoMergeThreshold = Number(response.meta.auto_merge_threshold ?? autoMergeThreshold);
      autoMergeReplacedChunks += Number(response.meta.auto_merge_replaced_chunks ?? 0);
      autoMergeSteps += Number(response.meta.auto_merge_steps ?? 0);
      rerankApplied = rerankApplied || Boolean(response.meta.rerank_applied);
      rerankEnabled = rerankEnabled || Boolean(response.meta.rerank_enabled);
      rerankModel = rerankModel || String(response.meta.rerank_model ?? '');
      rerankEndpoint = rerankEndpoint || String(response.meta.rerank_endpoint ?? '');
      if (response.meta.rerank_error) {
        rerankErrors.push(`${label}:${String(response.meta.rerank_error)}`);
      }
      await this.emitStep(
        emit,
        '🧱',
        `${label} 三级检索`,
        `L${response.meta.leaf_retrieve_level ?? env.leafRetrieveLevel} 召回，候选 ${response.meta.candidate_k ?? 0}，合并替换 ${response.meta.auto_merge_replaced_chunks ?? 0}`,
      );
    };

    // HyDE：使用“假设文档”作为检索输入，适合语义补全场景。
    if (strategy === 'hyde' || strategy === 'complex') {
      await collect(hypotheticalDoc || query, 'HyDE');
    }
    // Step-back：使用“退步问题扩展后查询”检索，适合抽象归纳场景。
    if (strategy === 'step_back' || strategy === 'complex') {
      await collect(expandedQuery, 'Step-back');
    }

    // 阶段 4：对扩展阶段多路召回做去重，并重排 rrf_rank 以便前端一致展示。
    const deduped: RetrievedChunk[] = [];
    const seen = new Set<string>();
    for (const doc of mergedDocs) {
      const key = doc.chunk_id || `${doc.filename}:${doc.page_number}:${doc.text}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push({ ...doc, rrf_rank: deduped.length + 1 });
    }

    await this.emitStep(emit, '✅', `扩展检索完成，共 ${deduped.length} 个片段`);
    // 回填扩展阶段追踪信息，覆盖为最终返回给上层的 ragTrace。
    ragTrace = {
      ...ragTrace,
      expanded_query: expandedQuery,
      step_back_question: stepBackQuestion,
      step_back_answer: stepBackAnswer,
      hypothetical_doc: hypotheticalDoc,
      expansion_type: strategy,
      rewrite_strategy: strategy,
      rewrite_query: expandedQuery,
      retrieved_chunks: deduped,
      expanded_retrieved_chunks: deduped,
      retrieval_stage: 'expanded',
      rerank_enabled: rerankEnabled,
      rerank_applied: rerankApplied,
      rerank_model: rerankModel,
      rerank_endpoint: rerankEndpoint,
      rerank_error: rerankErrors.length ? rerankErrors.join('; ') : null,
      retrieval_mode: retrievalMode,
      candidate_k: candidateK,
      leaf_retrieve_level: leafRetrieveLevel,
      auto_merge_enabled: autoMergeEnabled,
      auto_merge_applied: autoMergeApplied,
      auto_merge_threshold: autoMergeThreshold,
      auto_merge_replaced_chunks: autoMergeReplacedChunks,
      auto_merge_steps: autoMergeSteps,
    };

    // 阶段 5：返回最终检索文本和完整追踪信息；若为空则返回标准兜底文案。
    return {
      text: deduped.length ? `Retrieved Chunks:\n${formatDocs(deduped)}` : 'No relevant documents found in the knowledge base.',
      ragTrace,
    };
  }
}
