import { z } from 'zod';
import { HttpError } from '../core.js';
import type { AppMiddleware } from '../types/koa.js';

export const errorHandlerMiddleware: AppMiddleware = async (ctx, next) => {
  try {
    await next();
    if (ctx.status === 404 && !ctx.body) {
      ctx.body = { detail: '接口不存在' };
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      ctx.status = 400;
      ctx.body = { detail: error.issues[0]?.message ?? '请求参数错误' };
      return;
    }
    if (error instanceof HttpError) {
      ctx.status = error.status;
      ctx.body = { detail: error.message };
      return;
    }
    ctx.status = 500;
    ctx.body = { detail: error instanceof Error ? error.message : String(error) };
  }
};
