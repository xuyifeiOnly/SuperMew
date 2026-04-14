import type { AppMiddleware } from '../types/koa.js';

export const requestLoggerMiddleware: AppMiddleware = async (ctx, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  console.log(`${ctx.method} ${ctx.path} -> ${ctx.status} (${duration}ms)`);
};
