import { dataDir, uploadDir } from './config.js';
import { AsyncQueue } from './core/async-queue.js';
import { cache } from './core/cache.js';
import { ChatAgentService } from './core/chat-agent-service.js';
import { ConversationStorage } from './core/conversation-storage.js';
import { DocumentLoaderService } from './core/document-loader.js';
import { EmbeddingService } from './core/embedding-service.js';
import {
  authenticateUser,
  createAccessToken,
  getCurrentUserByToken,
  hashPassword,
  HttpError,
  resolveRole,
  verifyPassword,
} from './core/http-error.js';
import { MilvusManager } from './core/milvus-manager.js';
import { MilvusWriter } from './core/milvus-writer.js';
import { ParentChunkStore } from './core/parent-chunk-store.js';
import { RagService } from './core/rag-service.js';
import { ensureDirectory } from './core/shared.js';
import { getCurrentWeather } from './core/weather.js';

export {
  AsyncQueue,
  authenticateUser,
  cache,
  ChatAgentService,
  ConversationStorage,
  createAccessToken,
  DocumentLoaderService,
  EmbeddingService,
  getCurrentUserByToken,
  getCurrentWeather,
  hashPassword,
  HttpError,
  MilvusManager,
  MilvusWriter,
  ParentChunkStore,
  RagService,
  resolveRole,
  verifyPassword,
};

export const conversationStorage = new ConversationStorage();
export const documentLoader = new DocumentLoaderService();
export const embeddingService = new EmbeddingService();
export const milvusManager = new MilvusManager();
export const parentChunkStore = new ParentChunkStore();
export const milvusWriter = new MilvusWriter(embeddingService, milvusManager);
export const ragService = new RagService(embeddingService, milvusManager, parentChunkStore);
export const chatAgentService = new ChatAgentService(conversationStorage, ragService);

export const removeBm25StatsForFilename = async (filename: string): Promise<void> => {
  const rows = await milvusManager.queryAll(`filename == "${filename}"`, ['text']);
  embeddingService.incrementRemoveDocuments(rows.map((item) => String(item.text ?? '')));
};

ensureDirectory(dataDir);
ensureDirectory(uploadDir);
