import { Redis as RedisCtor, type Redis as RedisClient } from 'ioredis';
import { env } from '../config.js';

class RedisCacheService {
  private client: RedisClient | null = null;

  private getClient(): RedisClient {
    if (!this.client) {
      this.client = new RedisCtor(env.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      this.client.on('error', () => undefined);
    }
    return this.client;
  }

  private async ready(): Promise<RedisClient> {
    const client = this.getClient();
    if (client.status === 'wait') {
      await client.connect();
    }
    return client;
  }

  private key(key: string): string {
    return `${env.redisKeyPrefix}:${key}`;
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const client = await this.ready();
      const value = await client.get(this.key(key));
      return value ? (JSON.parse(value) as T) : null;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttl = env.redisCacheTtlSeconds): Promise<void> {
    try {
      const client = await this.ready();
      await client.set(this.key(key), JSON.stringify(value), 'EX', ttl);
    } catch {
      return;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const client = await this.ready();
      await client.del(this.key(key));
    } catch {
      return;
    }
  }
}

export const cache = new RedisCacheService();
