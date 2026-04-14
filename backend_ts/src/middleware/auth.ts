import { getCurrentUserByToken, HttpError } from '../core.js';
import type { AppContext } from '../types/koa.js';

const getBearerToken = (authorization?: string): string => {
  const value = String(authorization ?? '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new HttpError(401, '缺少认证令牌');
  }
  return match[1].trim();
};

export const requireUser = async (ctx: AppContext) => {
  const token = getBearerToken(ctx.headers.authorization);
  const currentUser = await getCurrentUserByToken(token);
  ctx.state.user = currentUser;
  return currentUser;
};

export const requireAdmin = async (ctx: AppContext) => {
  const currentUser = await requireUser(ctx);
  if (currentUser.role !== 'admin') {
    throw new HttpError(403, '管理员权限不足');
  }
  return currentUser;
};
