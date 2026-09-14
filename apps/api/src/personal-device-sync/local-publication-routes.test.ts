import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerPersonalDeviceSyncRoutes } from "./routes.js";

const groupId = "AAAAAAAAAAAAAAAAAAAAAA";
const sessionId = "00000000-0000-4000-8000-000000000001";

describe("joined device local publication", () => {
  it("publishes and controls its local queue without an Authority private key", async () => {
    const repository = {
      closePdsSourceSession: vi.fn(async () => ({
        sourceSequence: "1",
        state: "pending"
      })),
      requestPdsOutboxRetry: vi.fn(async () => 1),
      setPdsPublicationPaused: vi.fn(async () => true),
      getPdsLocalSyncStatus: vi.fn(async () => ({ pending: 1 }))
    };
    const getSourceContext = vi.fn(async () => ({
      originDeploymentId: "deployment",
      originDeviceId: "device"
    }));
    const app = Fastify();
    registerPersonalDeviceSyncRoutes(app, {
      requireRepository: () => repository,
      rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} },
      auth: { authenticateSession: async () => ({ id: "owner" }) },
      personalDeviceSync: {
        authoritySigner: null,
        secureKeyProvider: { getSourceContext }
      },
      encryption: { envelopeEncryptionProvider: {} }
    } as unknown as ApiRouteContext);
    try {
      const base = `/v1/personal-device-sync/groups/${groupId}`;
      for (const request of [
        { method: "POST" as const, url: `${base}/sessions/${sessionId}/close` },
        { method: "POST" as const, url: `${base}/retry` },
        {
          method: "PUT" as const,
          url: `${base}/pause`,
          payload: { paused: true }
        },
        { method: "GET" as const, url: `${base}/local-status` }
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode, response.body).toBe(200);
        const denied = await app.inject({
          ...request,
          headers: { authorization: "Bearer token" }
        });
        expect(denied.statusCode).toBe(403);
      }
      expect(repository.closePdsSourceSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          userId: "owner",
          groupId,
          sessionId,
          originDeviceId: "device"
        })
      );
      expect(repository.requestPdsOutboxRetry).toHaveBeenCalledExactlyOnceWith({
        userId: "owner",
        groupId
      });
      expect(getSourceContext).toHaveBeenCalledExactlyOnceWith({
        userId: "owner",
        groupId
      });
      getSourceContext.mockResolvedValueOnce(null as never);
      const missing = await app.inject({
        method: "POST",
        url: `${base}/sessions/${sessionId}/close`
      });
      expect(missing.statusCode).toBe(503);
      expect(repository.closePdsSourceSession).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
