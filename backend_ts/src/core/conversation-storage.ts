import { cache } from './cache.js';
import { ChatMessage, ChatSession, User } from '../models.js';
import type { RagTrace, SessionInfo, StoredMessage } from '../types.js';

export class ConversationStorage {
  private messagesCacheKey(userId: string, sessionId: string): string {
    return `chat_messages:${userId}:${sessionId}`;
  }

  private sessionsCacheKey(userId: string): string {
    return `chat_sessions:${userId}`;
  }

  async save(
    userId: string,
    sessionId: string,
    messages: Array<{ type: 'human' | 'ai' | 'system'; content: string }>,
    extraMessageData: Array<{ rag_trace?: RagTrace | null } | null> = [],
  ): Promise<void> {
    const user = await User.findOne({ where: { username: userId } });
    if (!user) {
      return;
    }

    const [session] = await ChatSession.findOrCreate({
      where: {
        userId: user.id,
        sessionId,
      },
      defaults: {
        userId: user.id,
        sessionId,
        metadataJson: {},
      },
    });

    session.metadataJson = {};
    session.updatedAt = new Date();
    await session.save();

    await ChatMessage.destroy({ where: { sessionRefId: session.id } });

    const now = new Date();
    const rows = messages.map((message, index) => ({
      sessionRefId: session.id,
      messageType: message.type,
      content: String(message.content),
      timestamp: now,
      ragTrace: (extraMessageData[index]?.rag_trace ?? null) as unknown as Record<string, unknown> | null,
    }));

    if (rows.length) {
      await ChatMessage.bulkCreate(rows);
    }

    const serialized: StoredMessage[] = messages.map((message, index) => ({
      type: message.type,
      content: String(message.content),
      timestamp: now.toISOString(),
      rag_trace: extraMessageData[index]?.rag_trace ?? null,
    }));

    await cache.setJson(this.messagesCacheKey(userId, sessionId), serialized);
    await cache.delete(this.sessionsCacheKey(userId));
  }

  async load(userId: string, sessionId: string): Promise<Array<{ type: 'human' | 'ai' | 'system'; content: string }>> {
    const records = await this.getSessionMessages(userId, sessionId);
    return records.map((item) => ({
      type: item.type,
      content: item.content,
    }));
  }

  async listSessionInfos(userId: string): Promise<SessionInfo[]> {
    const cached = await cache.getJson<SessionInfo[]>(this.sessionsCacheKey(userId));
    if (cached) {
      return cached;
    }

    const user = await User.findOne({ where: { username: userId } });
    if (!user) {
      return [];
    }

    const sessions = await ChatSession.findAll({
      where: { userId: user.id },
      order: [['updated_at', 'DESC']],
    });

    const result: SessionInfo[] = [];
    for (const session of sessions) {
      const count = await ChatMessage.count({ where: { sessionRefId: session.id } });
      result.push({
        session_id: session.sessionId,
        updated_at: session.updatedAt.toISOString(),
        message_count: count,
      });
    }

    await cache.setJson(this.sessionsCacheKey(userId), result);
    return result;
  }

  async getSessionMessages(userId: string, sessionId: string): Promise<StoredMessage[]> {
    const cached = await cache.getJson<StoredMessage[]>(this.messagesCacheKey(userId, sessionId));
    if (cached) {
      return cached;
    }

    const user = await User.findOne({ where: { username: userId } });
    if (!user) {
      return [];
    }
    const session = await ChatSession.findOne({
      where: { userId: user.id, sessionId },
    });
    if (!session) {
      return [];
    }

    const rows = await ChatMessage.findAll({
      where: { sessionRefId: session.id },
      order: [['id', 'ASC']],
    });
    const result: StoredMessage[] = rows.map((row) => ({
      type: row.messageType as 'human' | 'ai' | 'system',
      content: row.content,
      timestamp: row.timestamp.toISOString(),
      rag_trace: (row.ragTrace as unknown as RagTrace | null) ?? null,
    }));
    await cache.setJson(this.messagesCacheKey(userId, sessionId), result);
    return result;
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const user = await User.findOne({ where: { username: userId } });
    if (!user) {
      return false;
    }
    const session = await ChatSession.findOne({
      where: { userId: user.id, sessionId },
    });
    if (!session) {
      return false;
    }
    await session.destroy();
    await cache.delete(this.messagesCacheKey(userId, sessionId));
    await cache.delete(this.sessionsCacheKey(userId));
    return true;
  }
}
