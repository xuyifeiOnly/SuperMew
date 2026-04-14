import Router from '@koa/router';
import type { AppState } from '../types/koa.js';
import authRouter from './auth.js';
import chatRouter from './chat.js';
import documentsRouter from './documents.js';
import sessionsRouter from './sessions.js';

const router = new Router<AppState>();

router.use(authRouter.routes(), authRouter.allowedMethods());
router.use(sessionsRouter.routes(), sessionsRouter.allowedMethods());
router.use(chatRouter.routes(), chatRouter.allowedMethods());
router.use(documentsRouter.routes(), documentsRouter.allowedMethods());

export default router;
