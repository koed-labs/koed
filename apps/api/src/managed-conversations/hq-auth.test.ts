import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("HQ selected document prompt HTTP admission", () => {
  it("rejects a generic API Token before looking up or decrypting a selected Source", async () => {
    const owner = randomUUID();
    const home = mkdtempSync(join(tmpdir(), "koed-hq-document-authority-"));
    homes.push(home);
    const repository = {
      getApiTokenUser: vi.fn(async () => ({ id: owner })),
      getManagedConversationExecution: vi.fn()
    };
    const auth = createAuthHelpers(() => repository as never, {
      hashSecret: (value) => value,
      cookieSecure: false
    });
    const sources = { readDocument: vi.fn(), list: vi.fn() };
    const app = Fastify();
    registerManagedConversationRoutes(
      app,
      {
        config: { deploymentProfile: "local_personal", koedHome: home },
        encryption: { envelopeEncryptionProvider: {} },
        auth,
        rateLimit: {
          memoryRead: async () => undefined,
          memoryWrite: async () => undefined
        },
        requireRepository: () => repository
      } as unknown as ApiRouteContext,
      null,
      null,
      sources as never
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/managed-conversations/${randomUUID()}/prompts`,
        headers: { authorization: "Bearer fixture-token" },
        payload: {
          executionGeneration: 1,
          idempotencyKey: randomUUID(),
          clientUserMessageId: randomUUID(),
          prompt: "Turn Plan.md into tickets",
          selectedDocumentSourceId: randomUUID()
        }
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(repository.getApiTokenUser).toHaveBeenCalledOnce();
      expect(repository.getManagedConversationExecution).not.toHaveBeenCalled();
      expect(sources.readDocument).not.toHaveBeenCalled();
      expect(sources.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("HQ managed start HTTP admission", () => {
  it("rejects dispatch before local mutation when remote Managed Conversation authority is selected", async () => {
    const owner = randomUUID();
    const projectId = randomUUID();
    const itemId = randomUUID();
    const agentId = randomUUID();
    const home = mkdtempSync(join(tmpdir(), "koed-work-remote-authority-"));
    homes.push(home);
    writeFileSync(
      join(home, "upstreams.json"),
      JSON.stringify({
        schemaVersion: 2,
        updatedAt: "2026-07-27T00:00:00.000Z",
        activeBackendId: "personal-authority",
        backends: [
          {
            id: "personal-authority",
            displayName: "Personal authority",
            baseUrl: "https://personal.example.test/koed",
            profile: "private_vps",
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
            routePolicy: { managedExecution: "enabled" },
            credential: { status: "configured" },
            capabilities: {
              state: "validated",
              checkedAt: "2026-07-27T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
              schemaVersion: 3,
              profile: "private_vps",
              payload: {
                capabilities: {
                  "memory.managedConversations": { availability: "available" }
                }
              }
            }
          }
        ]
      })
    );
    const getForRealtime = vi.fn();
    const createManagedConversation = vi.fn();
    const retryWorkItemConversation = vi.fn();
    const enqueueManagedConversationControl = vi.fn();
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as Error & { statusCode?: number }).statusCode ?? 500)
        .send({
          message: error instanceof Error ? error.message : "Request failed"
        })
    );
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
          remoteOperationsAllowed: () => true,
          resolveUpstreamAuthorization: () => "Koed-Device fixture:secret",
          fetch: vi.fn()
        },
        requireRepository: () => ({
          createManagedConversation,
          retryWorkItemConversation,
          enqueueManagedConversationControl
        })
      } as unknown as ApiRouteContext,
      { list: vi.fn() } as never,
      { getForRealtime } as never,
      {} as never,
      {} as never,
      {} as never,
      true
    );
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      for (const version of [1, 2]) {
        const response = await app.inject({
          method: "POST",
          url: `/v1/projects/${projectId}/work-items/${itemId}/dispatch`,
          headers: { authorization: credential.authorization },
          payload: { agentId, version }
        });
        expect(response.statusCode, response.body).toBe(503);
        expect(response.json()).toMatchObject({
          message: expect.stringContaining("remote Managed Conversations")
        });
      }
      for (const [url, payload] of [
        [
          `/v1/projects/${projectId}/hq/conversation:start`,
          { prompt: "Hello" }
        ],
        [`/v1/projects/${projectId}/hq/catch-up`, {}],
        [
          `/v1/projects/${projectId}/hq/catch-up/retry`,
          { failedCommandId: randomUUID(), retryRequestId: randomUUID() }
        ]
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { authorization: credential.authorization },
          payload
        });
        expect(response.statusCode, response.body).toBe(503);
        expect(response.json().message).toContain(
          "remote Managed Conversations"
        );
      }
      expect(getForRealtime).not.toHaveBeenCalled();
      expect(createManagedConversation).not.toHaveBeenCalled();
      expect(retryWorkItemConversation).not.toHaveBeenCalled();
      expect(enqueueManagedConversationControl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("launches a chosen Agent with a Source-bound brief through the scoped Desktop route", async () => {
    const owner = randomUUID();
    const projectId = randomUUID();
    const itemId = randomUUID();
    const agentId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const home = mkdtempSync(join(tmpdir(), "koed-work-send-http-"));
    homes.push(home);
    const config = join(home, "config", "projects.json");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 3,
        projects: [
          {
            localProjectId: projectId,
            path: { cwd: home, projectRoot: home }
          }
        ]
      })
    );
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as Error & { statusCode?: number }).statusCode ?? 500)
        .send({
          message: error instanceof Error ? error.message : "Request failed"
        })
    );
    const todo = {
      id: itemId,
      projectId,
      kind: "todo",
      title: "Ship brief",
      goal: "Explain the release",
      version: 1,
      status: "todo",
      executionId: null
    };
    const doing = {
      ...todo,
      version: 2,
      status: "doing",
      executionId,
      assigneeAgentId: agentId,
      dispatchKey: `${itemId}:1`
    };
    const getForRealtime = vi
      .fn()
      .mockResolvedValueOnce(todo)
      .mockResolvedValue(doing);
    const createManagedConversation = vi.fn(async () => ({
      execution: { id: executionId, executionGeneration: 1 },
      command: { id: randomUUID(), state: "blocked" }
    }));
    const upsertManagedConversationRuntimeBinding = vi.fn(
      async () => undefined
    );
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
        requireRepository: () => ({
          listAiClientInstances: async () => [
            {
              instanceId: "codex.default",
              driverId: "codex",
              displayName: "Codex",
              enabled: true,
              configIdentityHash: "f".repeat(64)
            }
          ],
          listCurrentAiClientCapabilitySnapshots: async () => [
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
          ],
          createManagedConversation,
          upsertManagedConversationRuntimeBinding
        })
      } as unknown as ApiRouteContext,
      {
        list: async () => [
          {
            id: agentId,
            name: "Quinn",
            role: "Builder",
            aiClientInstanceId: "codex.default",
            defaultModel: "gpt-test",
            defaultPermissionMode: "supervised"
          }
        ]
      } as never,
      {
        getForRealtime,
        briefSources: async () => [
          {
            id: randomUUID(),
            kind: "repo",
            name: "Project repo",
            uri: "https://github.com/acme/repo",
            currentRevisionId: null
          }
        ]
      } as never
    );
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/work-items/${itemId}/dispatch`,
        headers: { authorization: credential.authorization },
        payload: { agentId, version: 1 }
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        item: doing,
        executionId,
        reused: false
      });
      expect(createManagedConversation).toHaveBeenCalledWith(
        { userId: owner },
        expect.objectContaining({
          projectId,
          contextKind: "project",
          provider: "codex",
          aiClientInstanceId: "codex.default",
          model: "gpt-test",
          workItemDispatch: expect.objectContaining({
            itemId,
            agentId,
            version: 1,
            sources: [expect.objectContaining({ currentRevisionId: null })]
          }),
          initialPrompt: expect.stringContaining("Explain the release")
        })
      );
      expect(upsertManagedConversationRuntimeBinding).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
  it("reuses a dispatched Work Item through the scoped Desktop HTTP route", async () => {
    const owner = randomUUID();
    const projectId = randomUUID();
    const itemId = randomUUID();
    const agentId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const home = mkdtempSync(join(tmpdir(), "koed-work-dispatch-http-"));
    homes.push(home);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as Error & { statusCode?: number }).statusCode ?? 500)
        .send({
          message: error instanceof Error ? error.message : "Request failed"
        })
    );
    const item = {
      id: itemId,
      projectId,
      version: 2,
      status: "doing",
      executionId,
      assigneeAgentId: agentId,
      dispatchKey: `${itemId}:1`
    };
    const getForRealtime = vi.fn(async () => item);
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
        requireRepository: () => ({
          getManagedConversationExecution: async () => ({
            id: executionId,
            projectId,
            runnerDeploymentId: deploymentId,
            runnerDeviceId: deviceId,
            executionGeneration: 1
          }),
          getManagedConversationRuntimeBinding: async () => ({
            deploymentId,
            deviceId,
            executionGeneration: 1
          })
        })
      } as unknown as ApiRouteContext,
      { list: async () => [] } as never,
      { getForRealtime } as never
    );
    try {
      const insufficient = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write"]
      });
      const denied = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/work-items/${itemId}/dispatch`,
        headers: { authorization: insufficient.authorization },
        payload: { agentId, version: 2 }
      });
      expect(denied.statusCode).toBe(403);
      expect(getForRealtime).not.toHaveBeenCalled();
      deleteDesktopLocalCredential(home);
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/work-items/${itemId}/dispatch`,
        headers: { authorization: credential.authorization },
        payload: { agentId, version: 2 }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        item,
        executionId,
        reused: true
      });
      expect(getForRealtime).toHaveBeenCalledWith(owner, itemId);
    } finally {
      await app.close();
    }
  });
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

  it.each(["human start", "cold catch-up won the HQ race"] as const)(
    "starts with the exact first prompt and a private owner-bound Project HQ path: %s",
    async (scenario) => {
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
          command: {
            id: commandId,
            state: "queued",
            payload: {
              ...(scenario === "human start"
                ? { prompt: selection.initialPrompt }
                : {})
            }
          }
        })
      );
      const upsertBinding = vi.fn(async () => undefined);
      const enqueuePrompt = vi.fn(async () => ({
        id: randomUUID(),
        state: "queued"
      }));
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
        enqueueManagedConversationPrompt: enqueuePrompt,
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
        { list } as never,
        undefined,
        undefined,
        undefined,
        {
          readHqConversation: vi.fn(async () => ({ conversation: null }))
        } as never
      );
      try {
        const credential = storeDesktopLocalCredential(home, {
          ownerUserId: owner,
          operationFamilies: [
            "personal_collaboration_write",
            "managed_execution"
          ]
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
          command: {
            id:
              scenario === "human start"
                ? commandId
                : (await enqueuePrompt.mock.results[0]?.value)?.id
          }
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
        if (scenario === "human start") {
          expect(upsertBinding).toHaveBeenCalledExactlyOnceWith(
            { userId: owner },
            expect.objectContaining({
              executionId,
              projectPath: expect.stringContaining(`${owner}/${projectId}`)
            })
          );
          expect(enqueuePrompt).not.toHaveBeenCalled();
        } else {
          expect(upsertBinding).not.toHaveBeenCalled();
          expect(enqueuePrompt).toHaveBeenCalledWith(
            { userId: owner },
            expect.objectContaining({
              executionId,
              idempotencyKey: `project-hq-first-user:${projectId}`,
              prompt
            })
          );
        }
      } finally {
        await app.close();
      }
    }
  );
});
