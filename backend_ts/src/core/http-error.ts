import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config.js';
import { User, UserRoleBinding } from '../models.js';
import type { CurrentUser, Role } from '../types.js';

export class HttpError extends Error {
  status: number;
  expose: boolean;

  constructor(status: number, message: string, expose = true) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = expose;
  }
}

const normalizeText = (value: unknown): string => String(value ?? '').trim();

export const hashPassword = (password: string): string => {
  if (!password) {
    throw new Error('password is required');
  }
  const salt = crypto.randomBytes(16);
  const digest = crypto.pbkdf2Sync(password, salt, env.passwordPbkdf2Rounds, 32, 'sha256');
  return `pbkdf2_sha256$${env.passwordPbkdf2Rounds}$${salt.toString('base64')}$${digest.toString('base64')}`;
};

export const verifyPassword = (plainPassword: string, passwordHash: string): boolean => {
  if (!plainPassword || !passwordHash) {
    return false;
  }
  if (passwordHash.startsWith('pbkdf2_sha256$')) {
    try {
      const [, roundsRaw, saltBase64, digestBase64] = passwordHash.split('$', 4);
      const rounds = Number(roundsRaw);
      const salt = Buffer.from(saltBase64, 'base64');
      const expected = Buffer.from(digestBase64, 'base64');
      const actual = crypto.pbkdf2Sync(plainPassword, salt, rounds, expected.length, 'sha256');
      return crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
  if (passwordHash.startsWith('$2') || passwordHash.startsWith('$bcrypt')) {
    try {
      return bcrypt.compareSync(plainPassword, passwordHash);
    } catch {
      return false;
    }
  }
  return false;
};

export const createAccessToken = (username: string, role: string): string =>
  jwt.sign({ sub: username, role }, env.jwtSecretKey, {
    algorithm: env.jwtAlgorithm as jwt.Algorithm,
    expiresIn: `${env.jwtExpireMinutes}m`,
  });

const normalizeRole = (value: unknown): Role => normalizeText(value).toLowerCase();

export const parseRolesInput = (value: unknown): Role[] => {
  if (Array.isArray(value)) {
    return [...new Set(value.map(normalizeRole).filter(Boolean))];
  }

  const raw = normalizeText(value);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map(normalizeRole).filter(Boolean))];
    }
  } catch {}

  return [...new Set(raw.split(/[,\n，]/).map(normalizeRole).filter(Boolean))];
};

export const resolveRoles = (requestedRoles?: unknown, adminCode?: string | null): Role[] => {
  const roles = parseRolesInput(requestedRoles);
  const normalizedRoles = roles.length ? roles : ['user'];
  if (normalizedRoles.includes('admin')) {
    console.log('adminCode', adminCode,env.adminInviteCode);
    console.log( adminCode == env.adminInviteCode)
    if (env.adminInviteCode && adminCode === env.adminInviteCode) {
      return normalizedRoles;
    }
    throw new HttpError(403, '管理员邀请码错误');
  }
  return normalizedRoles;
};

const parseStoredRoles = (primaryRole: string, bindingRoles: string[]): Role[] => {
  const roles = [...new Set([primaryRole, ...bindingRoles].map(normalizeRole).filter(Boolean))];
  return roles.length ? roles : ['user'];
};

export const setUserRoles = async (userId: number, roles: Role[]): Promise<void> => {
  await UserRoleBinding.destroy({ where: { userId } });
  if (!roles.length) {
    return;
  }
  await UserRoleBinding.bulkCreate(roles.map((role) => ({ userId, role })));
};

export const getCurrentUserByToken = async (token: string): Promise<CurrentUser> => {
  try {
    const payload = jwt.verify(token, env.jwtSecretKey, {
      algorithms: [env.jwtAlgorithm as jwt.Algorithm],
    }) as jwt.JwtPayload;

    const username = normalizeText(payload.sub);
    if (!username) {
      throw new HttpError(401, '无效或过期的认证令牌');
    }

    const user = await User.findOne({ where: { username } });
    if (!user) {
      throw new HttpError(401, '无效或过期的认证令牌');
    }

    const bindings = await UserRoleBinding.findAll({
      where: { userId: user.id },
      attributes: ['role'],
      raw: true,
    });
    const roles = parseStoredRoles(String(user.role || 'user'), bindings.map((item) => String(item.role ?? '')));

    return {
      id: user.id,
      username: user.username,
      role: roles[0],
      roles,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(401, '无效或过期的认证令牌');
  }
};

export const authenticateUser = async (username: string, password: string): Promise<User | null> => {
  const user = await User.findOne({ where: { username } });
  if (!user) {
    return null;
  }
  return verifyPassword(password, user.passwordHash) ? user : null;
};
