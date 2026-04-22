import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const backendTsRoot = path.resolve(__dirname, '..');
export const projectRoot = path.resolve(backendTsRoot, '..');
export const frontendDir = path.join(projectRoot, 'frontend');
export const dataDir = path.join(projectRoot, 'data');
export const uploadDir = path.join(dataDir, 'documents');
export const defaultBm25StatePath = path.join(dataDir, 'bm25_state.json');

const projectEnvPath = path.join(projectRoot, '.env');
const localEnvPath = path.join(backendTsRoot, '.env');

if (fs.existsSync(projectEnvPath)) {
  dotenv.config({ path: projectEnvPath });
}
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath, override: true });
}

const readString = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim();
const readNumber = (name: string, fallback: number): number => {
  const value = Number(readString(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
};
const readBoolean = (name: string, fallback: boolean): boolean => {
  const value = readString(name, String(fallback)).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
};
const normalizeDatabaseUrl = (value: string): string =>
  value
    .replace(/^postgresql\+psycopg2:\/\//i, 'postgres://')
    .replace(/^postgresql:\/\//i, 'postgres://');

export const env = {
  nodeEnv: readString('NODE_ENV', 'development'),
  host: readString('HOST', '0.0.0.0'),
  port: readNumber('PORT', 9008),
  embeddingBaseUrl: readString('EMBEDDING_BASE_URL', ''),
  databaseUrl: normalizeDatabaseUrl(readString('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/langchain_app')),
  redisUrl: readString('REDIS_URL', 'redis://localhost:6379/0'),
  redisKeyPrefix: readString('REDIS_KEY_PREFIX', 'supermew'),
  redisCacheTtlSeconds: readNumber('REDIS_CACHE_TTL_SECONDS', 300),
  jwtSecretKey: readString('JWT_SECRET_KEY', 'change-this-secret'),
  jwtAlgorithm: readString('JWT_ALGORITHM', 'HS256'),
  jwtExpireMinutes: readNumber('JWT_EXPIRE_MINUTES', 1440),
  adminInviteCode: readString('ADMIN_INVITE_CODE', 'supermew-admin-2026'),
  passwordPbkdf2Rounds: readNumber('PASSWORD_PBKDF2_ROUNDS', 310000),
  arkApiKey: readString('ARK_API_KEY', ''),
  model: readString('MODEL', ''),
  gradeModel: readString('GRADE_MODEL', ''),
  fastModel: readString('FAST_MODEL', ''),
  baseUrl: readString('BASE_URL', ''),
  embeddingProvider: readString('EMBEDDING_PROVIDER', 'hash').toLowerCase(),
  embeddingModel: readString('EMBEDDING_MODEL', ''),
  denseEmbeddingDim: readNumber('DENSE_EMBEDDING_DIM', 1024),
  milvusHost: readString('MILVUS_HOST', '127.0.0.1'),
  milvusPort: readString('MILVUS_PORT', '19530'),
  milvusCollection: readString('MILVUS_COLLECTION', 'embeddings_collection'),
  rerankModel: readString('RERANK_MODEL', ''),
  rerankBindingHost: readString('RERANK_BINDING_HOST', ''),
  rerankApiKey: readString('RERANK_API_KEY', ''),
  autoMergeEnabled: readBoolean('AUTO_MERGE_ENABLED', true),
  autoMergeThreshold: readNumber('AUTO_MERGE_THRESHOLD', 2),
  leafRetrieveLevel: readNumber('LEAF_RETRIEVE_LEVEL', 3),
  amapWeatherApi: readString('AMAP_WEATHER_API', ''),
  amapApiKey: readString('AMAP_API_KEY', ''),
  bm25StatePath: readString('BM25_STATE_PATH', defaultBm25StatePath),
};
