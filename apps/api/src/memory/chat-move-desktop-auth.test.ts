import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import { registerGraphRoutes } from "./graph-routes.js";

describe("HQ-107 Desktop move route authentication", () => {
  it("uses the owner-bound local credential on all move routes and keeps legacy Bearer auth", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-chat-move-auth-"));
    const owner = randomUUID();
    const sessionId = randomUUID();
    const grantId = randomUUID();
    const batchId = randomUUID();
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: owner,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const app = Fastify();
    const authenticate = vi.fn(async () => {
      throw Object.assign(new Error("Legacy Bearer only"), { statusCode: 401 });
    });
    const repo = { getCapturedSession: vi.fn(async () => null) };
    registerGraphRoutes(app, {
      requireRepository: () => repo,
      config: { deploymentProfile: "local_personal", koedHome: home },
      auth: {
        authenticate,
        authenticateSessionOrDeviceCredential: vi.fn()
      },
      graph: {
        cacheProvider: { deleteByPrefix: vi.fn() },
        graphCacheTtlSeconds: 30,
        hashCacheKey: vi.fn()
      },
      encryption: { envelopeEncryptionProvider: null },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as never);
    try {
      const headers = { authorization: credential.authorization };
      const patch = await app.inject({
        method: "PATCH",
        url: `/v1/memory/graph/sessions/${sessionId}/project`,
        headers,
        remoteAddress: "127.0.0.1",
        payload: { action: "loose", expectedProjectId: null }
      });
      expect(patch.statusCode).toBe(404);
      expect(repo.getCapturedSession).toHaveBeenCalledWith(
        { userId: owner },
        sessionId
      );
      const review = await app.inject({
        method: "GET",
        url: `/v1/memory/graph/sessions/${sessionId}/move-reviews/${grantId}?batchId=${batchId}`,
        headers,
        remoteAddress: "127.0.0.1"
      });
      expect(review.statusCode).toBe(503);
      const progress = await app.inject({
        method: "POST",
        url: `/v1/memory/graph/sessions/${sessionId}/move-progress`,
        headers,
        remoteAddress: "127.0.0.1",
        payload: { batchId }
      });
      expect(progress.statusCode).toBe(503);
      expect(authenticate).not.toHaveBeenCalled();
      const remote = await app.inject({
        method: "PATCH",
        url: `/v1/memory/graph/sessions/${sessionId}/project`,
        headers,
        remoteAddress: "192.0.2.10",
        payload: { action: "loose", expectedProjectId: null }
      });
      expect(remote.statusCode).toBe(403);
      const bearer = await app.inject({
        method: "PATCH",
        url: `/v1/memory/graph/sessions/${sessionId}/project`,
        headers: { authorization: "Bearer existing-token" },
        payload: { action: "loose", expectedProjectId: null }
      });
      expect(bearer.statusCode).toBe(401);
      expect(authenticate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
