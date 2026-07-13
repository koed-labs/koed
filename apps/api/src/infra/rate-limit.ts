import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export type RateLimitName =
  | "auth"
  | "memoryRead"
  | "memoryWrite"
  | "memoryRecall"
  | "projectionRebuild";

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
const MAX_MEMORY_RATE_LIMIT_BUCKETS = 100_000;
let memoryRateLimitOperations = 0;

export const resetMemoryRateLimitStore = (): void => {
  rateLimitBuckets.clear();
  memoryRateLimitOperations = 0;
};

export class MemoryRateLimitStore implements RateLimitStore {
  constructor(
    private readonly maxBuckets: number = MAX_MEMORY_RATE_LIMIT_BUCKETS
  ) {
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
      throw new Error("Memory rate-limit bucket capacity must be positive");
    }
  }

  increment(key: string, windowMs: number) {
    const now = Date.now();
    memoryRateLimitOperations += 1;
    if (
      memoryRateLimitOperations % 256 === 0 ||
      rateLimitBuckets.size >= this.maxBuckets
    ) {
      for (const [bucketKey, value] of rateLimitBuckets) {
        if (value.resetAt <= now) {
          rateLimitBuckets.delete(bucketKey);
        }
      }
    }
    while (rateLimitBuckets.size >= this.maxBuckets) {
      const oldestKey = rateLimitBuckets.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) {
        break;
      }
      rateLimitBuckets.delete(oldestKey);
    }
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

export interface RateLimitIdentityOptions {
  resolveAuthenticatedUserId(
    request: FastifyRequest
  ): string | undefined | Promise<string | undefined>;
}

export const createRateLimitHandlers = (
  rateLimitStore: RateLimitStore,
  hashKey: (value: string) => string,
  rateLimits: Record<RateLimitName, RateLimitPolicy>,
  identityOptions?: RateLimitIdentityOptions
): Record<RateLimitName, RateLimitHandler> => {
  const rateLimit =
    (name: RateLimitName): RateLimitHandler =>
    async (request, reply) => {
      const policy = rateLimits[name];
      const authenticatedUserId =
        await identityOptions?.resolveAuthenticatedUserId(request);
      if (name === "projectionRebuild" && !authenticatedUserId) {
        throw Object.assign(
          new Error("Authentication required before Projection rate limiting"),
          { statusCode: 401 }
        );
      }
      const keyMaterial = authenticatedUserId
        ? `user:${hashKey(authenticatedUserId)}`
        : `ip:${request.ip}`;
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
    memoryRecall: rateLimit("memoryRecall"),
    projectionRebuild: rateLimit("projectionRebuild")
  };
};
