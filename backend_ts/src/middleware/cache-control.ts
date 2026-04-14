import type { AppMiddleware } from '../types/koa.js';

export const noCacheMiddleware: AppMiddleware = async (ctx, next) => {
  await next();
  const requestPath = ctx.path || '';
  if (requestPath === '/' || requestPath.endsWith('.html') || requestPath.endsWith('.js') || requestPath.endsWith('.css')) {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.set('Pragma', 'no-cache');
    ctx.set('Expires', '0');
  }
};
