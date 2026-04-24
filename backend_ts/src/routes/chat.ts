import Router from "@koa/router";
import { requireUser } from "../middleware/index.js";
import { createChatStream, runChat } from "../services/chat-service.js";
import type { AppState } from "../types/koa.js";
import {
  closeSseStream,
  openSseStream,
  writeSseDone,
  writeSseError,
  writeSseEvent,
} from "../utils/sse.js";
import { testMuliveDuoQuestion } from "../services/test-service.js";

const router = new Router<AppState>();

router.post("/chat", async (ctx) => {
  const currentUser = await requireUser(ctx);
  ctx.body = await runChat(currentUser, ctx.request.body);
});

router.post("/chat/stream", async (ctx) => {
  const currentUser = await requireUser(ctx);
  const stream = createChatStream(currentUser, ctx.request.body);
  openSseStream(ctx);

  try {
    for await (const event of stream) {
      writeSseEvent(ctx, event);
    }
    writeSseDone(ctx);
  } catch (error) {
    writeSseError(ctx, error);
  } finally {
    closeSseStream(ctx);
  }
});
router.post("/chat/test", async (ctx) => {
  ctx.body = await testMuliveDuoQuestion(ctx);
});
export default router;
