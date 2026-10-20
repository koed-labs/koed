import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { createAuthHelpers } from "../auth/session.js";
import { authenticateHqManagedWrite } from "./hq-auth.js";
import { registerManagedConversationRoutes } from "./routes.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const fixture = (
  profile = "local_personal",
  authenticate = vi.fn(async (_request: unknown, _family: string) => {
    void _request;
    void _family;
    return { id: "fallback-owner" };
  })
) => {
  const home = mkdtempSync(join(tmpdir(), "koed-hq-auth-"));
  homes.push(home);
  const app = Fastify();
  const context = {
    config: { deploymentProfile: profile, koedHome: home },
    auth: { authenticateSessionOrDeviceCredential: authenticate }
  } as unknown as ApiRouteContext;
  // Exercise the real helper through HTTP request headers and socket address.
  app.post("/start-authority", async (request) =>
    authenticateHqManagedWrite(request, context)
  );
  return { app, home, authenticate };
};

describe("HQ managed launch authority", () => {
  it("binds the existing encrypted Desktop credential to its owner only with both write families", async () => {
    const owner = randomUUID();
    const { app, home, authenticate } = fixture();
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const response = await app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: credential.authorization },
        remoteAddress: "127.0.0.1"
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: owner });
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["read only", ["personal_collaboration_read"]],
    ["write without managed", ["personal_collaboration_write"]],
    ["managed without write", ["managed_execution"]]
  ] as const)("denies %s Desktop authority", async (_label, families) => {
    const { app, home, authenticate } = fixture();
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: randomUUID(),
        operationFamilies: [...families]
      });
      const response = await app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: credential.authorization }
      });
      expect(response.statusCode).toBe(403);
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("denies forged, revoked, nonloopback and nonlocal Desktop credentials", async () => {
    const owner = randomUUID();
    const { app, home, authenticate } = fixture();
    const other = fixture("private_vps");
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const good = credential.authorization;
      const forged = `${good.slice(0, -1)}${good.endsWith("a") ? "b" : "a"}`;
      for (const [authorization, remoteAddress] of [
        [forged, "127.0.0.1"],
        [good, "203.0.113.10"]
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/start-authority",
          headers: { authorization },
          remoteAddress
        });
        expect(response.statusCode).toBe(403);
      }
      const nonlocal = await other.app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: good },
        remoteAddress: "127.0.0.1"
      });
      expect(nonlocal.statusCode).toBe(403);
      deleteDesktopLocalCredential(home);
      const revoked = await app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: good }
      });
      expect(revoked.statusCode).toBe(403);
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await other.app.close();
    }
  });

  it("preserves session/device two-family owner matching and delegates bearer denial", async () => {
    const owner = randomUUID();
    const authenticate = vi.fn(async (_request: unknown, _family: string) => {
      void _request;
      void _family;
      return { id: owner };
    });
    const { app } = fixture("local_personal", authenticate);
    try {
      const allowed = await app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: "Koed-Device existing" }
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ id: owner });
      expect(authenticate.mock.calls.map((call) => call[1])).toEqual([
        "personal_collaboration_write",
        "managed_execution"
      ]);
      authenticate
        .mockImplementationOnce(async () => ({ id: owner }))
        .mockImplementationOnce(async () => ({ id: randomUUID() }));
      const mismatch = await app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: "Koed-Device existing" }
      });
      expect(mismatch.statusCode).toBe(403);
      authenticate.mockImplementationOnce(async () => {
        throw Object.assign(
          new Error("API Tokens cannot authorize Project HQ launch"),
          { statusCode: 403 }
        );
      });
      const bearer = await app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: "Bearer denied" }
      });
      expect(bearer.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejects API bearer tokens through the actual session/device auth policy", async () => {
    const repository = {
      getApiTokenUser: vi.fn(async () => ({ id: randomUUID() }))
    };
    const auth = createAuthHelpers(() => repository as never, {
      hashSecret: (value) => value,
      cookieSecure: false
    });
    const app = Fastify();
    const home = mkdtempSync(join(tmpdir(), "koed-hq-bearer-"));
    homes.push(home);
    app.post("/start-authority", async (request) =>
      authenticateHqManagedWrite(request, {
        config: { deploymentProfile: "local_personal", koedHome: home },
        auth
      } as unknown as ApiRouteContext)
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/start-authority",
        headers: { authorization: "Bearer fixture-token" }
      });
      expect(response.statusCode).toBe(403);
      expect(repository.getApiTokenUser).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("HQ managed start HTTP admission", () => {
  it("rejects forged HQ payload fields and a missing Chief before runtime or database creation", async () => {
    const owner = randomUUID();
    const projectId = randomUUID();
    const home = mkdtempSync(join(tmpdir(), "koed-hq-start-"));
    homes.push(home);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const typed = error as Error & { statusCode?: number };
      return reply
        .code(typed.name === "ZodError" ? 400 : (typed.statusCode ?? 500))
        .send({ message: typed.message });
    });
    const list = vi.fn(async () => []);
    const requireRepository = vi.fn();
    registerManagedConversationRoutes(
      app,
      {
        config: { deploymentProfile: "local_personal", koedHome: home },
        encryption: { envelopeEncryptionProvider: {} },
        auth: { authenticateSessionOrDeviceCredential: vi.fn() },
        rateLimit: {
          memoryRead: async () => undefined,
          memoryWrite: async () => undefined,
          managedConversationRead: async () => undefined,
          managedConversationWrite: async () => undefined
        },
        localEdge: {
          upstreamBackendsPath: join(home, "upstreams.json"),
          resolveUpstreamAuthorization: () => null,
          fetch: vi.fn()
        },
        requireRepository
      } as unknown as ApiRouteContext,
      { list } as never
    );
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const headers = { authorization: credential.authorization };
      const forged = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/conversation:start`,
        headers,
        payload: { prompt: "Please help", projectId }
      });
      expect(forged.statusCode).toBe(400);
      expect(list).not.toHaveBeenCalled();
      const missingChief = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/conversation:start`,
        headers,
        payload: { prompt: "Please help" }
      });
      expect(missingChief.statusCode, missingChief.body).toBe(409);
      expect(list).toHaveBeenCalledExactlyOnceWith(owner);
      expect(requireRepository).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("starts with the exact first prompt and a private owner-bound Project HQ path", async () => {
    const owner = randomUUID();
    const projectId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const home = mkdtempSync(join(tmpdir(), "koed-hq-launch-"));
    homes.push(home);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const typed = error as Error & { statusCode?: number };
      return reply
        .code(typed.name === "ZodError" ? 400 : (typed.statusCode ?? 500))
        .send({ message: typed.message });
    });
    const createdAt = "2026-10-20T00:00:00.000Z";
    const createManagedConversation = vi.fn(
      async (_actor: unknown, selection: Record<string, unknown>) => ({
        execution: {
          id: executionId,
          projectId: selection.projectId,
          provider: selection.provider,
          aiClientInstanceId: selection.aiClientInstanceId,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
          permissionMode: selection.permissionMode,
          runnerKind: selection.runnerKind,
          state: "starting",
          stateVersion: 1,
          executionGeneration: 1,
          logicalSessionId: null,
          providerThreadId: null,
          providerCliVersion: null,
          lastErrorCode: null,
          createdAt,
          updatedAt: createdAt,
          startedAt: null,
          quiescedAt: null,
          stoppedAt: null
        },
        command: { id: commandId, state: "queued" }
      })
    );
    const upsertBinding = vi.fn(async () => undefined);
    const repository = {
      listAiClientInstances: vi.fn(async () => [
        {
          instanceId: "codex.default",
          driverId: "codex",
          displayName: "Codex",
          enabled: true,
          configIdentityHash: "f".repeat(64)
        }
      ]),
      listCurrentAiClientCapabilitySnapshots: vi.fn(async () => [
        {
          instanceId: "codex.default",
          installationIdentityHash: "f".repeat(64),
          authenticationState: "authenticated",
          healthState: "healthy",
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilities: {
            descriptors: {
              managed_conversation_start: {
                support: "supported",
                readiness: "ready"
              }
            }
          },
          models: [
            {
              id: "gpt-test",
              provenance: "reported",
              supportedReasoningEfforts: ["low"]
            }
          ]
        }
      ]),
      createManagedConversation,
      upsertManagedConversationRuntimeBinding: upsertBinding,
      getManagedConversationRuntimeBinding: vi.fn(async () => null)
    };
    const list = vi.fn(async () => [
      {
        isChiefOfStaff: true,
        aiClientInstanceId: "codex.default",
        defaultModel: "gpt-test"
      }
    ]);
    registerManagedConversationRoutes(
      app,
      {
        config: { deploymentProfile: "local_personal", koedHome: home },
        encryption: { envelopeEncryptionProvider: {} },
        auth: { authenticateSessionOrDeviceCredential: vi.fn() },
        deploymentIdentity: {
          inspect: () => ({
            health: "healthy",
            deploymentId,
            deviceInstanceId: deviceId
          })
        },
        rateLimit: {
          memoryRead: async () => undefined,
          memoryWrite: async () => undefined,
          managedConversationRead: async () => undefined,
          managedConversationWrite: async () => undefined
        },
        localEdge: {
          upstreamBackendsPath: join(home, "upstreams.json"),
          resolveUpstreamAuthorization: () => null,
          fetch: vi.fn()
        },
        requireRepository: () => repository
      } as unknown as ApiRouteContext,
      { list } as never
    );
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const prompt = "  Review the Project plan.\nKeep these exact words.  ";
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/conversation:start`,
        headers: { authorization: credential.authorization },
        payload: { prompt }
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        execution: {
          id: executionId,
          projectId,
          model: "gpt-test",
          permissionMode: "supervised"
        },
        command: { id: commandId }
      });
      expect(list).toHaveBeenCalledExactlyOnceWith(owner);
      expect(createManagedConversation).toHaveBeenCalledWith(
        { userId: owner },
        expect.objectContaining({
          hqProjectId: projectId,
          initialPrompt: prompt,
          projectId,
          contextKind: "independent",
          permissionMode: "supervised",
          runnerDeploymentId: deploymentId,
          runnerDeviceId: deviceId,
          deferUntilRuntimeBinding: true,
          hqPrivatePath: expect.stringContaining(`${owner}/${projectId}`)
        })
      );
      expect(upsertBinding).toHaveBeenCalledExactlyOnceWith(
        { userId: owner },
        expect.objectContaining({
          executionId,
          projectPath: expect.stringContaining(`${owner}/${projectId}`)
        })
      );
    } finally {
      await app.close();
    }
  });
});
