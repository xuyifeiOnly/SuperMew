import crypto from 'node:crypto';
import fs from 'node:fs';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { env } from '../config.js';
import type { RagStep, StreamEvent } from '../types.js';

export type JsonObject = Record<string, unknown>;
export type EmitEvent = (event: StreamEvent) => void | Promise<void>;
export type EmitStep = (step: RagStep) => void | Promise<void>;

export const safeJsonParse = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const normalizeText = (value: unknown): string => String(value ?? '').trim();

export const ensureDirectory = (targetPath: string): void => {
  fs.mkdirSync(targetPath, { recursive: true });
};

export const tokenize = (text: string): string[] => {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  let current = '';

  for (const char of lowered) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(char);
      continue;
    }
    if (/[a-z0-9]/.test(char)) {
      current += char;
      continue;
    }
    if (current) {
      tokens.push(current);
      current = '';
    }
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
};

export const hashTextToVector = (text: string, dim: number): number[] => {
  const vector = new Array(dim).fill(0);
  const tokens = tokenize(text);
  if (!tokens.length) {
    return vector;
  }

  for (const token of tokens) {
    const hash = crypto.createHash('sha256').update(token).digest();
    const bucket = hash.readUInt32BE(0) % dim;
    const sign = hash[4] % 2 === 0 ? 1 : -1;
    vector[bucket] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => item / norm);
};

const hasModelEnv = (): boolean => Boolean(env.arkApiKey && env.baseUrl);

export const createChatModel = (model: string, temperature: number): ChatOpenAI | null => {
  if (!model || !hasModelEnv()) {
    return null;
  }
  return new ChatOpenAI({
    model,
    temperature,
    apiKey: env.arkApiKey,
    configuration: {
      baseURL: env.baseUrl,
    },
  });
};

export const createEmbeddingModel = (model: string): OpenAIEmbeddings | null => {
  if (!model || !hasModelEnv()) {
    return null;
  }
  return new OpenAIEmbeddings({
    model,
    apiKey: env.arkApiKey,
    configuration: {
      baseURL: env.embeddingBaseUrl,
    },
  });
};

export const modelResponseToText = (response: unknown): string => {
  if (typeof response === 'string') {
    return normalizeText(response);
  }
  if (Array.isArray(response)) {
    const text = response
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item === 'object' && item && 'type' in item && (item as { type?: unknown }).type === 'text') {
          return normalizeText((item as { text?: unknown }).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return normalizeText(text);
  }
  return '';
};

export const promptModelText = async (prompt: string, model: string, temperature = 0.2): Promise<string> => {
  const llm = createChatModel(model, temperature);
  if (!llm) {
    return '';
  }
  const response = await llm.invoke(prompt);
  return modelResponseToText(response.content);
};

export const embedByModel = async (texts: string[], model: string): Promise<number[][]> => {
  const embeddings = createEmbeddingModel(model);
  if (!embeddings) {
    throw new Error('embedding model not configured');
  }
  return embeddings.embedDocuments(texts);
};
