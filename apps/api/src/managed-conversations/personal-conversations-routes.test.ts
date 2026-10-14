import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRoutes } from "./routes.js";

describe("Personal conversation HTTP boundaries", () => {
  const setup = async (hosted = false) => {
    const userId = randomUUID();
    const conversationId = randomUUID();
    const directory = mkdtempSync(resolve(tmpdir(), "koed-root-route-"));
    const now = new Date().toISOString();
    const response = {
      conversation: {
        contractVersion: 1,
        conversationId,
        title: "Shared chat",
        projectId: null,
        contextKind: "independent",
        status: "idle",
        activeAgentId: null,
        activeExecutionId: null,
        activeProvider: null,
        sourceExecutionIds: [],
        childExecutionIds: [],
        capturedSessionIds: [],
        participants: [],
        messages: [],
        deliveries: [],
        createdAt: now,
        updatedAt: now
      },
      timelinePage: { hasMore: false, nextCursor: null }
    };
    const get = vi.fn(async () => response);
    const list = vi.fn(async () => ({
      conversations: [],
      hasMore: false,
      nextCursor: null
    }));
    const authenticate = vi.fn(async () => ({ id: userId }));
    const authenticateSessionOrDeviceCredential = vi.fn(async () => ({
      id: userId
    }));
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const typed = error as Error & { statusCode?: number; name: string };
      reply
        .status(typed.statusCode ?? (typed.name === "ZodError" ? 400 : 500))
        .send({ error: typed.message });
    });
    registerManagedConversationRoutes(app, {
      config: { deploymentProfile: hosted ? "private_vps" : "local_personal" },
      encryption: { envelopeEncryptionProvider: {} },
      auth: { authenticate, authenticateSessionOrDeviceCredential },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      localEdge: {
        upstreamBackendsPath: resolve(directory, "upstreams.json"),
        resolveUpstreamAuthorization: () => null,
        fetch: vi.fn()
      },
      requireRepository: () => ({
        getPersonalAgentChat: get,
        listPersonalAgentChats: list
      })
    } as unknown as ApiRouteContext);
    await app.ready();
    return {
      app,
      get,
      list,
      userId,
      conversationId,
      response,
      authenticateSessionOrDeviceCredential,
      close: async () => {
        await app.close();
        rmSync(directory, { recursive: true, force: true });
      }
    };
  };

  it("keeps bounded timeline cursors and owner identity in the repository read", async () => {
    const fixture = await setup();
    try {
      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/personal-conversations/${fixture.conversationId}?limit=20&beforeSequence=42`
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(fixture.response);
      expect(fixture.get).toHaveBeenCalledWith(
        { userId: fixture.userId },
        fixture.conversationId,
        { limit: 20, beforeSequence: 42 }
      );
    } finally {
      await fixture.close();
    }
  });

  it("rejects an unbounded timeline request before reading repository data", async () => {
    const fixture = await setup();
    try {
      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/personal-conversations/${fixture.conversationId}?limit=10000`
      });
      expect(result.statusCode).toBe(400);
      expect(fixture.get).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("returns 404 for a root outside the authenticated owner's visibility", async () => {
    const fixture = await setup();
    fixture.get.mockResolvedValueOnce(null as never);
    try {
      const result = await fixture.app.inject({
        method: "GET",
        url: `/v1/personal-conversations/${fixture.conversationId}`
      });
      expect(result.statusCode).toBe(404);
      expect(fixture.get).toHaveBeenCalledWith(
        { userId: fixture.userId },
        fixture.conversationId,
        expect.anything()
      );
    } finally {
      await fixture.close();
    }
  });

  it("uses session or scoped device authentication for hosted Personal reads", async () => {
    const fixture = await setup(true);
    try {
      const result = await fixture.app.inject({
        method: "GET",
        url: "/v1/personal-conversations?limit=15"
      });
      expect(result.statusCode).toBe(200);
      expect(
        fixture.authenticateSessionOrDeviceCredential
      ).toHaveBeenCalledWith(
        expect.anything(),
        "managed_execution",
        expect.anything()
      );
      expect(fixture.list).toHaveBeenCalledWith(
        { userId: fixture.userId },
        { limit: 15 }
      );
    } finally {
      await fixture.close();
    }
  });
});
