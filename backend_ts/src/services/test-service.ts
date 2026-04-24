import type Koa from "koa";
import { multiQueryRetrieveByMilvus } from "./multi_query_tools.js";

export const testMuliveDuoQuestion = async (ctx: Koa.Context) => {
  const body = (ctx.request as any)?.body ?? {};
  const question = String(
    body.question ?? body.query ?? body.message ?? "",
  ).trim();
  const topK = Number(body.topK ?? 4);
  const queryCount = Number(body.queryCount ?? 3);
  // topK 表示每次检索返回的文档数量，queryCount 表示生成的扩展查询数量
  return await multiQueryRetrieveByMilvus(question, { topK, queryCount });
};
