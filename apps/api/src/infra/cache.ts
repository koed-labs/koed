import type { Redis } from "ioredis";

export interface CacheProvider {
  getJson<T>(key: string): Promise<T | null>;
  setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
  close?(): Promise<void>;
}

export class NoopCacheProvider implements CacheProvider {
  getJson<T>(key: string): Promise<T | null> {
    void key;
    return Promise.resolve(null);
  }

  setJson<T>(key: string, value: T, ttlSeconds: number) {
    void key;
    void value;
    void ttlSeconds;
    return Promise.resolve();
  }

  deleteByPrefix(prefix: string) {
    void prefix;
    return Promise.resolve();
  }
}

export class RedisCacheProvider implements CacheProvider {
  constructor(private readonly redis: Redis) {}

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number) {
    await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async deleteByPrefix(prefix: string) {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        100
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  close() {
    this.redis.disconnect();
    return Promise.resolve();
  }
}
