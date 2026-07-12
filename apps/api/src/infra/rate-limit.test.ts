import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createRateLimitHandlers,
  MemoryRateLimitStore,
  resetMemoryRateLimitStore
} from "./rate-limit.js";

describe("rate limiting", () => {
  beforeEach(() => {
    resetMemoryRateLimitStore();
  });

  it("bounds the in-memory bucket store", async () => {
    const store = new MemoryRateLimitStore(3);
    await store.increment("first", 60_000);
    await store.increment("second", 60_000);
    await store.increment("third", 60_000);
    await store.increment("fourth", 60_000);

    await expect(store.increment("first", 60_000)).resolves.toMatchObject({
      count: 1
    });
  });

  it("keys unauthenticated requests by network identity, not attacker-controlled credentials", async () => {
    const store = new MemoryRateLimitStore(10);
    const handlers = createRateLimitHandlers(
      store,
      (value) => value,
      {
        auth: { windowMs: 60_000, max: 1 },
        memoryRead: { windowMs: 60_000, max: 1 },
        memoryWrite: { windowMs: 60_000, max: 1 },
        memoryRecall: { windowMs: 60_000, max: 1 },
        projectionRebuild: { windowMs: 60_000, max: 1 }
      },
      { authenticatedUserId: () => undefined }
    );
    const reply = {
      header: () => reply
    } as unknown as FastifyReply;
    const request = (authorization: string) =>
      ({
        ip: "203.0.113.7",
        headers: { authorization }
      }) as unknown as FastifyRequest;

    await handlers.memoryRead(request("Bearer attacker-one"), reply);
    await expect(
      handlers.memoryRead(request("Bearer attacker-two"), reply)
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});
