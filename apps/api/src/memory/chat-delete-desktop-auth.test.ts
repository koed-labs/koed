import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  rotateDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
import { registerChatDeleteRoutes } from "./chat-delete-routes.js";

const ownerId = randomUUID();
const sessionId = randomUUID();
const batchId = randomUUID();
const actionGrantId = randomUUID();
const base = `/v1/memory/graph/sessions/${sessionId}`;
const routes = [
  { method: "DELETE", url: base, payload: { batchId }, write: true },
  {
    method: "POST",
    url: `${base}/delete-progress`,
    payload: { batchId },
    write: true
  },
  {
    method: "GET",
    url: `${base}/delete-reviews/${actionGrantId}?batchId=${batchId}`,
    write: false
  },
  { method: "GET", url: "/v1/memory/graph/sessions/deleted", write: false },
  {
    method: "GET",
    url: "/v1/memory/graph/sessions/delete-pending",
    write: false
  },
  { method: "POST", url: `${base}/restore`, payload: { batchId }, write: true },
  { method: "POST", url: `${base}/forget`, payload: { batchId }, write: true },
  {
    method: "POST",
    url: `${base}/forget-progress`,
    payload: { batchId },
    write: true
  },
  {
    method: "GET",
    url: "/v1/memory/graph/sessions/forget-pending",
    write: false
  },
  {
    method: "POST",
    url: `${base}/forget-undo`,
    payload: { batchId },
    write: true
  }
] as const;

const fixture = async (home: string, deploymentProfile = "local_personal") => {
  const app = Fastify();
  const authenticate = vi.fn(
    async (request: { headers: { authorization?: string } }) => {
      if (request.headers.authorization === "Bearer legacy-owner")
        return { id: ownerId };
      throw Object.assign(new Error("Legacy authentication required"), {
        statusCode: 401
      });
    }
  );
  const operation = {
    sessionId,
    batchId,
    state: "complete",
    executions: [],
    sources: [],
    grantFreezeAcks: []
  };
  const repository = {
    beginChatDelete: vi.fn(async () => operation),
    getChatDeleteOperation: vi.fn(async () => operation),
    listPendingChatDeletes: vi.fn(async () => [operation]),
    restoreChat: vi.fn(async () => operation)
  };
  const forgetRepository = {
    beginForgetChat: vi.fn(async () => ({ batch_id: batchId })),
    getForgetChatOperation: vi.fn(async () => ({
      state: "complete",
      forgotten_at: new Date(),
      assertion_snapshots: []
    })),
    listPendingForgetChats: vi.fn(async () => []),
    undoForgetChat: vi.fn(async () => ({ outcome: "undone" }))
  };
  const captured = {
    listTrashedCapturedSessions: vi.fn(async () => ({
      sessions: [],
      nextBefore: null
    }))
  };
  registerChatDeleteRoutes(
    app,
    {
      config: { deploymentProfile, koedHome: home },
      auth: { authenticate },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      graph: {
        cacheProvider: { deleteByPrefix: vi.fn(async () => undefined) }
      },
      requireRepository: () => captured
    } as never,
    {
      repository: repository as never,
      forgetRepository: forgetRepository as never,
      managedRepository: {} as never,
      coordinator: null
    }
  );
  await app.ready();
  return { app, authenticate, repository, forgetRepository, captured };
};

describe("HQ-106 Desktop chat lifecycle authentication", () => {
  it("accepts the owner Desktop credential on every route and reaches the operation", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-chat-delete-auth-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: ownerId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const { app, authenticate, repository, forgetRepository, captured } =
      await fixture(home);
    try {
      for (const route of routes) {
        const response = await app.inject({
          ...route,
          headers: { authorization: credential.authorization },
          remoteAddress: "127.0.0.1"
        });
        expect(response.statusCode, route.url).toBe(
          route.url.includes("delete-reviews") ? 409 : 200
        );
      }
      expect(authenticate).not.toHaveBeenCalled();
      expect(repository.beginChatDelete).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
      expect(repository.getChatDeleteOperation).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
      expect(repository.restoreChat).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
      expect(forgetRepository.beginForgetChat).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
      expect(forgetRepository.undoForgetChat).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
      expect(captured.listTrashedCapturedSessions).toHaveBeenCalledWith(
        { userId: ownerId },
        undefined
      );
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects wrong, rotated, remote, and nonlocal Desktop credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-chat-delete-auth-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: ownerId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const local = await fixture(home);
    const hosted = await fixture(home, "team_self_hosted");
    try {
      const route = routes[0];
      const valid = credential.authorization;
      const wrong = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
      for (const [app, authorization, remoteAddress, code] of [
        [local.app, wrong, "127.0.0.1", 401],
        [local.app, valid, "192.0.2.10", 403],
        [hosted.app, valid, "127.0.0.1", 403]
      ] as const) {
        const response = await app.inject({
          ...route,
          headers: { authorization },
          remoteAddress
        });
        expect(response.statusCode).toBe(code);
      }
      expect(rotateDesktopLocalCredential(home)).not.toBeNull();
      const expired = await local.app.inject({
        ...route,
        headers: { authorization: valid },
        remoteAddress: "127.0.0.1"
      });
      expect(expired.statusCode).toBe(401);
      expect(local.repository.beginChatDelete).not.toHaveBeenCalled();
      expect(hosted.repository.beginChatDelete).not.toHaveBeenCalled();
    } finally {
      await local.app.close();
      await hosted.app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("limits a read-only Desktop credential to the read route family", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-chat-delete-auth-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: ownerId,
      operationFamilies: ["personal_collaboration_read"]
    });
    const { app, repository } = await fixture(home);
    try {
      for (const route of routes) {
        const response = await app.inject({
          ...route,
          headers: { authorization: credential.authorization },
          remoteAddress: "127.0.0.1"
        });
        expect(response.statusCode, route.url).toBe(
          route.write ? 401 : route.url.includes("delete-reviews") ? 409 : 200
        );
      }
      expect(repository.beginChatDelete).not.toHaveBeenCalled();
      expect(repository.restoreChat).not.toHaveBeenCalled();
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves legacy Bearer authentication on all routes", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-chat-delete-auth-"));
    const { app, authenticate, repository } = await fixture(home);
    try {
      for (const route of routes) {
        const response = await app.inject({
          ...route,
          headers: { authorization: "Bearer legacy-owner" }
        });
        expect(response.statusCode, route.url).toBe(
          route.url.includes("delete-reviews") ? 409 : 200
        );
      }
      expect(authenticate).toHaveBeenCalledTimes(routes.length);
      expect(repository.beginChatDelete).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
