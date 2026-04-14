import Router from '@koa/router';
import { conversationStorage, HttpError } from '../core.js';
import { requireUser } from '../middleware/index.js';
import type { AppState } from '../types/koa.js';

const router = new Router<AppState>();

router.get('/sessions', async (ctx) => {
  const currentUser = await requireUser(ctx);
  const sessions = await conversationStorage.listSessionInfos(currentUser.username);
  sessions.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  ctx.body = { sessions };
});

router.get('/sessions/:sessionId', async (ctx) => {
  const currentUser = await requireUser(ctx);
  const sessionId = String(ctx.params.sessionId ?? '');
  const messages = await conversationStorage.getSessionMessages(currentUser.username, sessionId);
  ctx.body = { messages };
});

router.delete('/sessions/:sessionId', async (ctx) => {
  const currentUser = await requireUser(ctx);
  const sessionId = String(ctx.params.sessionId ?? '');
  const deleted = await conversationStorage.deleteSession(currentUser.username, sessionId);
  if (!deleted) {
    throw new HttpError(404, '会话不存在');
  }

  ctx.body = {
    session_id: sessionId,
    message: '成功删除会话',
  };
});

export default router;
