import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import {
  errorHandlerMiddleware,
  frontendFallbackMiddleware,
  frontendStaticMiddleware,
  noCacheMiddleware,
  requestLoggerMiddleware,
} from './middleware/index.js';
import apiRouter from './routes/index.js';
import type { AppState } from './types/koa.js';

export const createApp = (): Koa<AppState> => {
  const app = new Koa<AppState>();

  app.use(errorHandlerMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(
    cors({
      origin: '*',
      credentials: true,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['*'],
    }),
  );
  app.use(bodyParser({ enableTypes: ['json'] }));
  app.use(noCacheMiddleware);
  app.use(apiRouter.routes());
  app.use(apiRouter.allowedMethods());

  if (frontendStaticMiddleware) {
    app.use(frontendStaticMiddleware);
    app.use(frontendFallbackMiddleware);
  }

  return app;
};
