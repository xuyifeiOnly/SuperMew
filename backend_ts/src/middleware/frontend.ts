import fs from 'node:fs';
import path from 'node:path';
import serve from 'koa-static';
import { frontendDir } from '../config.js';
import type { AppMiddleware } from '../types/koa.js';

const apiPrefixes = ['/auth', '/chat', '/sessions', '/documents'];

export const frontendStaticMiddleware = fs.existsSync(frontendDir) ? serve(frontendDir) : null;

export const frontendFallbackMiddleware: AppMiddleware = async (ctx, next) => {
  if (!fs.existsSync(frontendDir)) {
    await next();
    return;
  }

  if (ctx.method !== 'GET' || apiPrefixes.some((prefix) => ctx.path.startsWith(prefix))) {
    await next();
    return;
  }

  const indexPath = path.join(frontendDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    ctx.type = 'html';
    ctx.body = fs.createReadStream(indexPath);
    return;
  }

  await next();
};
