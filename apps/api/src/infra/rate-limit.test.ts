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
        managedConversationRead: { windowMs: 60_000, max: 1 },
        managedConversationWrite: { windowMs: 60_000, max: 1 },
        aiClientControl: { windowMs: 60_000, max: 1 },
        sourceJournal: { windowMs: 60_000, max: 1 },
        projectionRebuild: { windowMs: 60_000, max: 1 }
      },
      { resolveAuthenticatedUserId: () => undefined }
    );
    const reply = {
      header: () => reply
    } as unknown as FastifyReply;
    const request = (authorization: string) =>
      ({
        ip: "203.0.113.7",
        headers: { authorization }
      }) as unknown as FastifyRequest;

    const interactiveRequest = {
      ...request("Bearer attacker-one"),
      headers: { "x-koed-request-class": "managed-conversation" }
    } as FastifyRequest;
    for (const kind of ["memoryWrite", "sourceJournal"] as const) {
      await handlers[kind](request("Bearer attacker-one"), reply);
      await expect(
        handlers[kind](request("Bearer attacker-one"), reply)
      ).rejects.toMatchObject({ statusCode: 429 });
      await expect(
        handlers[kind](interactiveRequest, reply)
      ).rejects.toMatchObject({ statusCode: 429 });
    }

    await handlers.memoryRead(request("Bearer attacker-one"), reply);
    await expect(
      handlers.memoryRead(request("Bearer attacker-two"), reply)
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("gives validated users behind one network address independent buckets", async () => {
    const store = new MemoryRateLimitStore(10);
    const handlers = createRateLimitHandlers(
      store,
      (value) => value,
      {
        auth: { windowMs: 60_000, max: 1 },
        memoryRead: { windowMs: 60_000, max: 1 },
        memoryWrite: { windowMs: 60_000, max: 1 },
        memoryRecall: { windowMs: 60_000, max: 1 },
        managedConversationRead: { windowMs: 60_000, max: 1 },
        managedConversationWrite: { windowMs: 60_000, max: 1 },
        aiClientControl: { windowMs: 60_000, max: 1 },
        sourceJournal: { windowMs: 60_000, max: 1 },
        projectionRebuild: { windowMs: 60_000, max: 1 }
      },
      {
        resolveAuthenticatedUserId: async (request) =>
          request.headers.authorization === "Bearer valid-alice"
            ? "alice"
            : request.headers.authorization === "Bearer valid-bob"
              ? "bob"
              : undefined
      }
    );
    const reply = {
      header: () => reply
    } as unknown as FastifyReply;
    const request = (authorization: string) =>
      ({
        ip: "203.0.113.7",
        headers: { authorization }
      }) as unknown as FastifyRequest;

    await handlers.memoryRead(request("Bearer valid-alice"), reply);
    await handlers.memoryRead(request("Bearer valid-bob"), reply);
    await expect(
      handlers.memoryRead(
        {
          ...request("Bearer valid-alice"),
          headers: {
            authorization: "Bearer valid-alice",
            "x-koed-request-class": "managed-conversation"
          }
        } as FastifyRequest,
        reply
      )
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      handlers.memoryRead(request("Bearer valid-alice"), reply)
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("keeps managed Conversation requests independent from background memory traffic", async () => {
    const store = new MemoryRateLimitStore(10);
    const handlers = createRateLimitHandlers(
      store,
      (value) => value,
      {
        auth: { windowMs: 60_000, max: 1 },
        memoryRead: { windowMs: 60_000, max: 1 },
        memoryWrite: { windowMs: 60_000, max: 1 },
        memoryRecall: { windowMs: 60_000, max: 1 },
        managedConversationRead: { windowMs: 60_000, max: 1 },
        managedConversationWrite: { windowMs: 60_000, max: 1 },
        aiClientControl: { windowMs: 60_000, max: 1 },
        sourceJournal: { windowMs: 60_000, max: 1 },
        projectionRebuild: { windowMs: 60_000, max: 1 }
      },
      { resolveAuthenticatedUserId: () => "local-user" }
    );
    const reply = {
      header: () => reply
    } as unknown as FastifyReply;
    const localRequest = {
      ip: "127.0.0.1",
      headers: {}
    } as unknown as FastifyRequest;

    await handlers.memoryRead(localRequest, reply);
    await handlers.memoryWrite(localRequest, reply);
    await expect(
      handlers.memoryRead(localRequest, reply)
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      handlers.memoryWrite(localRequest, reply)
    ).rejects.toMatchObject({ statusCode: 429 });

    await expect(
      handlers.managedConversationRead(localRequest, reply)
    ).resolves.toBeUndefined();
    await expect(
      handlers.managedConversationWrite(localRequest, reply)
    ).resolves.toBeUndefined();
  });
});
