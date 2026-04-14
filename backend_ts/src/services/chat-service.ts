import { chatAgentService, HttpError } from '../core.js';
import type { CurrentUser, StreamEvent } from '../types.js';
import { z } from 'zod';

export interface ChatRequest {
  message: string;
  sessionId: string;
}

const chatSchema = z.object({
  message: z.string().trim().min(1, '消息不能为空'),
  session_id: z.string().trim().optional().nullable(),
});

const mapChatError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Error code:\s*(\d{3})/);
  if (match) {
    const code = Number(match[1]);
    if (code === 429) {
      throw new HttpError(
        429,
        `上游模型服务触发限流/额度限制（429）。请检查账号额度/模型状态。\n原始错误：${message}`,
      );
    }
    throw new HttpError(code, message);
  }
  throw error instanceof HttpError ? error : new HttpError(500, message);
};

export const parseChatRequest = (body: unknown): ChatRequest => {
  const payload = chatSchema.parse(body ?? {});
  return {
    message: payload.message,
    sessionId: payload.session_id || 'default_session',
  };
};

export const runChat = async (currentUser: CurrentUser, body: unknown) => {
  const request = parseChatRequest(body);
  try {
    return await chatAgentService.chat(request.message, currentUser.username, request.sessionId);
  } catch (error) {
    mapChatError(error);
  }
};

export const createChatStream = (currentUser: CurrentUser, body: unknown): AsyncIterable<StreamEvent> => {
  const request = parseChatRequest(body);
  return chatAgentService.chatStream(request.message, currentUser.username, request.sessionId);
};
