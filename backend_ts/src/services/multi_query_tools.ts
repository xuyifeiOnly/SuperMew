import type Koa from "koa";
import { Milvus } from "@langchain/community/vectorstores/milvus";
import { env } from "../config.js";
import { embeddingService, milvusManager } from "../core.js";
import {
  createChatModel,
  modelResponseToText,
  safeJsonParse,
} from "../core/shared.js";
import type { RetrievedChunk } from "../types.js";

const dedupeChunks = (chunks: RetrievedChunk[]): RetrievedChunk[] => {
  const seen = new Set<string>();
  const result: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    const key =
      chunk.chunk_id || `${chunk.filename}:${chunk.page_number}:${chunk.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(chunk);
  }
  return result;
};

const generateExpandedQueries = async (
  llm: any,
  question: string,
  queryCount: number,
): Promise<string[]> => {
  const prompt = [
    `你是检索查询改写器，请围绕用户问题生成 ${queryCount} 条不同角度的检索查询。`,
    "要求：",
    '1) 只输出 JSON 数组字符串，例如 ["查询1","查询2"]',
    "2) 不要输出任何额外文字，不要用 Markdown",
    "3) 每条查询不超过 50 字，尽量覆盖同义词、别名、相关概念、上下位词",
    `用户问题：${question}`,
  ].join("\n");
  const response = await llm.invoke(prompt);
  const text = modelResponseToText(response?.content ?? response);
  const parsed = safeJsonParse<string[]>(text, []);
  const cleaned = parsed
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  const merged = [question, ...cleaned];
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const item of merged) {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniq.push(item);
    if (uniq.length >= Math.max(1, queryCount)) {
      break;
    }
  }
  return uniq.length ? uniq : [question];
};
/**
 * 多查询检索
 * @param question 用户问题
 * @param options �选项
 * @param options.topK 毀索结果数量，默认 5
 * @param options.queryCount 生成的查询数量，默认 3
 * @param options.filterExpr 过滤表达式，默认 ""
 * * @returns 检索结果
 */
export const multiQueryRetrieveByMilvus = async (
  question: string,
  options?: { topK?: number; queryCount?: number,filterExpr?:string },
): Promise<RetrievedChunk[]> => {
  const rawQuestion = String(question ?? "").trim();

  const llm = createChatModel(env.fastModel || env.model, 0.1);
  if (!llm) {
    throw new Error(
      "未配置可用的 LLM（请检查 env.model/env.fastModel、ARK_API_KEY、BASE_URL 等配置）",
    );
  }

  const topK = Math.max(1, Number(options?.topK ?? 5) || 5);
  const queryCount = Math.max(1, Number(options?.queryCount ?? 3) || 3);

  const baseRetriever = {
    getRelevantDocuments: async (query: string) => {
      await milvusManager.ensureCollection();
      const [denseEmbedding] = await embeddingService.getEmbeddings([query]);
      const sparseEmbedding = embeddingService.getSparseEmbedding(query);
      const hits = await milvusManager.hybridRetrieve(
        denseEmbedding ?? [],
        sparseEmbedding,
        topK,
        options?.filterExpr ?? "",
      );
      return hits.map((hit) => ({
        pageContent: hit.text ?? "",
        metadata: { ...hit },
      }));
    },
  } as any;

  const expandedQueries = await generateExpandedQueries(
    llm,
    rawQuestion,
    queryCount,
  );
  console.log('用户问题:', rawQuestion, '生成的查询:', expandedQueries);
  let docs: Array<{ pageContent?: string; metadata?: any }> = [];
  const batches = await Promise.all(
    expandedQueries.map((q) => baseRetriever.getRelevantDocuments(q)),
  );
  docs = batches.flat();

  const chunks = dedupeChunks(
    docs.map((doc) => ({
      ...(doc.metadata ?? {}),
      text: String(doc.pageContent ?? ""),
    })) as RetrievedChunk[],
  );

  return chunks;
};
