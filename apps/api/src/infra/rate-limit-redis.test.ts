import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { RedisRateLimitStore } from "./rate-limit.js";

const redisUrl = process.env.KOED_TEST_REDIS_URL;

describe.skipIf(!redisUrl)("shared Redis rate-limit counters", () => {
  const redis = new Redis(redisUrl ?? "redis://127.0.0.1:6379", {
    lazyConnect: true
  });
  const store = new RedisRateLimitStore(redis);
  const prefix = `workos-test:${randomUUID()}`;
  const keys: string[] = [];
  afterAll(async () => {
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  it("counts concurrent attempts across API instances in one expiring window", async () => {
    const key = `${prefix}:concurrent`;
    keys.push(`koed:rate-limit:${key}`);
    const otherInstance = new RedisRateLimitStore(redis);
    const attempts = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 ? otherInstance : store).increment(key, 60_000)
      )
    );
    expect(attempts.map((item) => item.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1)
    );
    const ttl = await redis.pttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
  it("repairs a counter without an expiry so admission cannot remain blocked forever", async () => {
    const key = `${prefix}:orphan`;
    const redisKey = `koed:rate-limit:${key}`;
    keys.push(redisKey);
    await redis.set(redisKey, "3");
    expect((await store.increment(key, 60_000)).count).toBe(4);
    expect(await redis.pttl(redisKey)).toBeGreaterThan(0);
  });
});
