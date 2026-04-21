import Router from '@koa/router';
import {
  authenticateUser,
  createAccessToken,
  getCurrentUserByToken,
  hashPassword,
  HttpError,
  resolveRoles,
  setUserRoles,
} from '../core/http-error.js';
import { requireUser } from '../middleware/index.js';
import { User } from '../models.js';
import type { AppState } from '../types/koa.js';
import { z } from 'zod';

const router = new Router<AppState>();

const registerSchema = z.object({
  username: z
    .string({ required_error: '用户名不能为空', invalid_type_error: '用户名不能为空' })
    .trim()
    .min(1, '用户名不能为空'),
  password: z
    .string({ required_error: '密码不能为空', invalid_type_error: '密码不能为空' })
    .trim()
    .min(1, '密码不能为空'),
  roles: z.union([z.array(z.string()), z.string()]).optional(),
  admin_code: z.string().optional().nullable(),
});

const loginSchema = z.object({
  username: z
    .string({ required_error: '用户名不能为空', invalid_type_error: '用户名不能为空' })
    .trim()
    .min(1, '用户名不能为空'),
  password: z
    .string({ required_error: '密码不能为空', invalid_type_error: '密码不能为空' })
    .trim()
    .min(1, '密码不能为空'),
});

router.post('/auth/register', async (ctx) => {
  const payload = registerSchema.parse(ctx.request.body ?? {});
  const exists = await User.findOne({ where: { username: payload.username } });
  if (exists) {
    throw new HttpError(409, '用户名已存在');
  }
  const roles = resolveRoles(payload.roles, payload.admin_code);
  const user = await User.create({
    username: payload.username,
    passwordHash: hashPassword(payload.password),
    role: roles[0],
  });
  await setUserRoles(user.id, roles);

  ctx.body = {
    access_token: createAccessToken(user.username, roles[0]),
    token_type: 'bearer',
    username: user.username,
    role: roles[0],
    roles,
  };
});

router.post('/auth/login', async (ctx) => {
  const payload = loginSchema.parse(ctx.request.body ?? {});
  const user = await authenticateUser(payload.username, payload.password);
  if (!user) {
    throw new HttpError(401, '用户名或密码错误');
  }
  const accessToken = createAccessToken(user.username, user.role);
  const currentUser = await getCurrentUserByToken(accessToken);

  ctx.body = {
    access_token: accessToken,
    token_type: 'bearer',
    username: user.username,
    role: currentUser.role,
    roles: currentUser.roles,
  };
});

router.get('/auth/me', async (ctx) => {
  const currentUser = await requireUser(ctx);
  ctx.body = {
    username: currentUser.username,
    role: currentUser.role,
    roles: currentUser.roles,
  };
});

export default router;
