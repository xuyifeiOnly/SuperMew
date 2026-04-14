import type { AppContext } from '../types/koa.js';
import type { StreamEvent } from '../types.js';

export const openSseStream = (ctx: AppContext): void => {
  ctx.req.setTimeout(0);
  ctx.respond = false;
  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  ctx.res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  ctx.res.setHeader('Connection', 'keep-alive');
  ctx.res.setHeader('X-Accel-Buffering', 'no');
  if (typeof ctx.res.flushHeaders === 'function') {
    ctx.res.flushHeaders();
  }
};

export const writeSseEvent = (ctx: AppContext, event: StreamEvent): void => {
  ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
};

export const writeSseDone = (ctx: AppContext): void => {
  ctx.res.write('data: [DONE]\n\n');
};

export const writeSseError = (ctx: AppContext, error: unknown): void => {
  writeSseEvent(ctx, {
    type: 'error',
    content: error instanceof Error ? error.message : String(error),
  });
};

export const closeSseStream = (ctx: AppContext): void => {
  ctx.res.end();
};
