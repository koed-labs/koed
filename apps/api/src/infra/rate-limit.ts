import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export type RateLimitName =
  | "auth"
  | "memoryRead"
  | "memoryWrite"
  | "memoryRecall";

export interface RateLimitStore {
  increment(
    key: string,
    windowMs: number
  ): Promise<{ count: number; resetAt: number }>;
  close?(): Promise<void>;
}

export interface RateLimitPolicy {
  windowMs: number;
  max: number;
}

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export const resetMemoryRateLimitStore = (): void => {
  rateLimitBuckets.clear();
};

export class MemoryRateLimitStore implements RateLimitStore {
  increment(key: string, windowMs: number) {
    const now = Date.now();
    const current = rateLimitBuckets.get(key);
    const bucket =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
    bucket.count += 1;
    rateLimitBuckets.set(key, bucket);
    return Promise.resolve(bucket);
  }
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowMs: number) {
    const redisKey = `koed:rate-limit:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.pexpire(redisKey, windowMs);
    }
    const ttl = await this.redis.pttl(redisKey);
    return {
      count,
      resetAt: Date.now() + (ttl > 0 ? ttl : windowMs)
    };
  }

  close() {
    this.redis.disconnect();
    return Promise.resolve();
  }
}

export type RateLimitHandler = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<void>;

export const createRateLimitHandlers = (
  rateLimitStore: RateLimitStore,
  hashKey: (value: string) => string,
  rateLimits: Record<RateLimitName, RateLimitPolicy>
): Record<RateLimitName, RateLimitHandler> => {
  const rateLimit =
    (name: RateLimitName): RateLimitHandler =>
    async (request, reply) => {
      const policy = rateLimits[name];
      const authorization = request.headers.authorization;
      const keyMaterial = authorization ? hashKey(authorization) : request.ip;
      const key = `${name}:${keyMaterial}`;
      const bucket = await rateLimitStore.increment(key, policy.windowMs);
      reply.header("x-ratelimit-limit", String(policy.max));
      reply.header(
        "x-ratelimit-remaining",
        String(Math.max(0, policy.max - bucket.count))
      );
      reply.header(
        "x-ratelimit-reset",
        String(Math.ceil(bucket.resetAt / 1000))
      );
      if (bucket.count > policy.max) {
        reply.header(
          "retry-after",
          String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)))
        );
        throw Object.assign(new Error("Rate limit exceeded"), {
          statusCode: 429
        });
      }
    };

  return {
    auth: rateLimit("auth"),
    memoryRead: rateLimit("memoryRead"),
    memoryWrite: rateLimit("memoryWrite"),
    memoryRecall: rateLimit("memoryRecall")
  };
};
