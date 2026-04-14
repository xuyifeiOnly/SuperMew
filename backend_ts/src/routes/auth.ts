import Router from '@koa/router';
import {
  authenticateUser,
  createAccessToken,
  hashPassword,
  HttpError,
  resolveRole,
} from '../core/http-error.js';
import { requireUser } from '../middleware/index.js';
import { User } from '../models.js';
import type { AppState } from '../types/koa.js';
import { z } from 'zod';

const router = new Router<AppState>();

const registerSchema = z.object({
  username: z.string().trim().min(1, '用户名不能为空'),
  password: z.string().trim().min(1, '密码不能为空'),
  role: z.string().optional().default('user'),
  admin_code: z.string().optional().nullable(),
});

const loginSchema = z.object({
  username: z.string().trim().min(1, '用户名不能为空'),
  password: z.string().trim().min(1, '密码不能为空'),
});

router.post('/auth/register', async (ctx) => {
  const payload = registerSchema.parse(ctx.request.body ?? {});
  const exists = await User.findOne({ where: { username: payload.username } });
  if (exists) {
    throw new HttpError(409, '用户名已存在');
  }

  const role = resolveRole(payload.role, payload.admin_code);
  const user = await User.create({
    username: payload.username,
    passwordHash: hashPassword(payload.password),
    role,
  });

  ctx.body = {
    access_token: createAccessToken(user.username, role),
    token_type: 'bearer',
    username: user.username,
    role: user.role,
  };
});

router.post('/auth/login', async (ctx) => {
  const payload = loginSchema.parse(ctx.request.body ?? {});
  const user = await authenticateUser(payload.username, payload.password);
  if (!user) {
    throw new HttpError(401, '用户名或密码错误');
  }

  ctx.body = {
    access_token: createAccessToken(user.username, user.role),
    token_type: 'bearer',
    username: user.username,
    role: user.role,
  };
});

router.get('/auth/me', async (ctx) => {
  const currentUser = await requireUser(ctx);
  ctx.body = {
    username: currentUser.username,
    role: currentUser.role,
  };
});

export default router;
