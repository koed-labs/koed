import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ChatDeleteNotFoundError } from "@koed/db";
import type {
  ChatDeleteOperation,
  ChatDeleteRepository,
  ChatForgetRepository,
  MemorySourceRepository
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { registerChatDeleteRoutes } from "./chat-delete-routes.js";

const ownerId = randomUUID();
const foreignId = randomUUID();
const sessionId = randomUUID();
const batchId = randomUUID();
const operation = (state: string): ChatDeleteOperation => ({
  chatRemoval: true,
  ownerUserId: ownerId,
  sessionId,
  batchId,
  state,
  sources: [
    {
      kind: "captured_session",
      sessionId,
      logicalMemoryId: randomUUID(),
      backends: [{ backendId: "team-test", relationshipIds: [randomUUID()] }]
    }
  ],
  executions: [],
  backendAcks: [],
  grantFreezeAcks: [],
  runtimeAcks: [],
  sourceManifestHash: "a".repeat(64),
  executionSetHash: "b".repeat(64)
});

const fixture = async () => {
  const app = Fastify();
  let current = operation("freezing");
  let teamOnline = false;
  const repository = {
    beginChatDelete: vi.fn(async (owner: string) => {
      if (owner !== ownerId)
        throw new ChatDeleteNotFoundError("Conversation not found");
      return current;
    }),
    getChatDeleteOperation: vi.fn(
      async (owner: string, session: string, batch?: string) =>
        owner === ownerId &&
        session === sessionId &&
        (!batch || batch === batchId)
          ? current
          : null
    ),
    markChatDeleteReady: vi.fn(async () => {
      current = operation("ready");
      return current;
    }),
    completeChatDelete: vi.fn(async () => {
      current = operation("complete");
      return current;
    }),
    restoreChat: vi.fn(
      async (_owner: string, _session: string, batch: string) => {
        if (batch !== batchId) throw new Error("wrong restore batch");
        current = operation("restored");
        return current;
      }
    ),
    listPendingChatDeletes: vi.fn(async () => [current])
  };
  const forgetRepository = {
    beginForgetChat: vi.fn(async (owner: string) => {
      if (owner !== ownerId)
        throw new ChatDeleteNotFoundError("Conversation not found");
      return { batch_id: batchId };
    }),
    getForgetChatOperation: vi.fn(async () => ({
      state: "complete",
      batch_id: batchId,
      forgotten_at: new Date(),
      assertion_snapshots: []
    })),
    undoForgetChat: vi.fn(async (owner: string) => {
      if (owner !== ownerId)
        throw new ChatDeleteNotFoundError("Conversation not found");
      return { outcome: "undone" };
    }),
    listPendingForgetChats: vi.fn(async () => [])
  };
  const context = {
    auth: {
      authenticate: vi.fn(
        async (request: { headers: { authorization?: string } }) => {
          if (request.headers.authorization === "Bearer personal-owner")
            return { id: ownerId };
          if (request.headers.authorization === "Bearer personal-foreign")
            return { id: foreignId };
          throw Object.assign(new Error("Personal authentication required"), {
            statusCode: 401
          });
        }
      )
    },
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    graph: { cacheProvider: { deleteByPrefix: vi.fn(async () => undefined) } },
    requireRepository: () => ({
      listTrashedCapturedSessions: vi.fn(async () => ({
        sessions: [],
        nextBefore: null
      })),
      restoreTrashedCapturedSession: vi.fn(async () => "not_found")
    })
  } as unknown as ApiRouteContext;
  registerChatDeleteRoutes(app, context, {
    repository: repository as unknown as ChatDeleteRepository,
    forgetRepository: forgetRepository as unknown as ChatForgetRepository,
    managedRepository: {} as MemorySourceRepository,
    coordinator: {
      advance: vi.fn(async () => {
        if (!teamOnline) throw new Error("Team offline");
      }),
      cancel: vi.fn(async () => false)
    } as never
  });
  await app.ready();
  return {
    app,
    repository,
    forgetRepository,
    setState: (state: string) => {
      current = operation(state);
    },
    sealTeam: () => {
      teamOnline = true;
      current = {
        ...current,
        backendAcks: [
          {
            logicalMemoryId: current.sources[0]!.logicalMemoryId!,
            backendId: "team-test",
            generation: 1,
            holdVersion: 1,
            sealed: true
          }
        ]
      };
    }
  };
};

describe("chat lifecycle routes", () => {
  it("uses Personal owner auth, returns pending while freeze is unacknowledged, and requires the exact batch", async () => {
    const { app, repository, setState } = await fixture();
    try {
      const url = `/v1/memory/graph/sessions/${sessionId}`;
      const unauthorized = await app.inject({
        method: "DELETE",
        url,
        payload: { batchId },
        headers: { authorization: "Bearer team-only" }
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(repository.beginChatDelete).not.toHaveBeenCalled();
      const foreign = await app.inject({
        method: "DELETE",
        url,
        payload: { batchId },
        headers: { authorization: "Bearer personal-foreign" }
      });
      expect(foreign.statusCode).toBe(404);
      expect(repository.beginChatDelete).toHaveBeenCalledWith(
        foreignId,
        sessionId,
        batchId
      );
      const pending = await app.inject({
        method: "DELETE",
        url,
        payload: { batchId },
        headers: { authorization: "Bearer personal-owner" }
      });
      expect(pending.statusCode).toBe(202);
      expect(pending.json()).toMatchObject({
        sessionId,
        batchId,
        pending: true,
        complete: false
      });
      expect(repository.completeChatDelete).not.toHaveBeenCalled();
      const wrong = await app.inject({
        method: "POST",
        url: `${url}/delete-progress`,
        payload: { batchId: randomUUID() },
        headers: { authorization: "Bearer personal-owner" }
      });
      expect(wrong.statusCode).toBe(404);
      setState("complete");
      const restore = await app.inject({
        method: "POST",
        url: `${url}/restore`,
        payload: { batchId },
        headers: { authorization: "Bearer personal-owner" }
      });
      expect(restore.statusCode).toBe(200);
      expect(repository.restoreChat).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
    } finally {
      await app.close();
    }
  });

  it("completes only after the Team seal and keeps Forget/Undo behind Personal ownership", async () => {
    const { app, repository, forgetRepository, sealTeam } = await fixture();
    try {
      const url = `/v1/memory/graph/sessions/${sessionId}`;
      const ownerHeaders = { authorization: "Bearer personal-owner" };
      const foreignHeaders = { authorization: "Bearer personal-foreign" };
      const pending = await app.inject({
        method: "DELETE",
        url,
        payload: { batchId },
        headers: ownerHeaders
      });
      expect(pending.statusCode).toBe(202);
      sealTeam();
      const complete = await app.inject({
        method: "POST",
        url: `${url}/delete-progress`,
        payload: { batchId },
        headers: ownerHeaders
      });
      expect(complete.statusCode).toBe(200);
      expect(complete.json()).toMatchObject({
        sessionId,
        batchId,
        complete: true
      });
      expect(repository.markChatDeleteReady).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
      expect(repository.completeChatDelete).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
      const foreignRestore = await app.inject({
        method: "POST",
        url: `${url}/restore`,
        payload: { batchId },
        headers: foreignHeaders
      });
      expect(foreignRestore.statusCode).toBe(404);
      const foreignForget = await app.inject({
        method: "POST",
        url: `${url}/forget`,
        payload: { batchId },
        headers: foreignHeaders
      });
      expect(foreignForget.statusCode).toBe(404);
      const forget = await app.inject({
        method: "POST",
        url: `${url}/forget`,
        payload: { batchId },
        headers: ownerHeaders
      });
      expect(forget.statusCode).toBe(200);
      expect(forget.json()).toMatchObject({ pending: false, batchId });
      const undo = await app.inject({
        method: "POST",
        url: `${url}/forget-undo`,
        payload: { batchId },
        headers: ownerHeaders
      });
      expect(undo.statusCode).toBe(200);
      expect(forgetRepository.undoForgetChat).toHaveBeenCalledWith(
        ownerId,
        sessionId,
        batchId
      );
    } finally {
      await app.close();
    }
  });
});
