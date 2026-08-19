import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ApiRouteContext } from "../server/context.js";
import {
  assertManagedCapability,
  registerManagedConversationRoutes
} from "./routes.js";

const writeManagedUpstreamRegistry = (): string => {
  const path = resolve(
    mkdtempSync(resolve(tmpdir(), "koed-managed-upstream-")),
    "upstream-backends.json"
  );
  writeFileSync(
    path,
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
                "memory.managedConversations": {
                  availability: "available"
                }
              }
            }
          }
        }
      ]
    })
  );
  return path;
};

const managedOwner = {
  provider: "codex",
  aiClientInstanceId: "codex.default"
};
const ownerIdentityHash = "f".repeat(64);
const managedCapabilityRepository = {
  listAiClientInstances: async () => [
    {
      instanceId: "codex.default",
      driverId: "codex",
      enabled: true,
      configIdentityHash: ownerIdentityHash
    }
  ],
  listCurrentAiClientCapabilitySnapshots: async () => [
    {
      instanceId: "codex.default",
      installationIdentityHash: ownerIdentityHash,
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
      }
    }
  ]
};

describe("managed Conversation capability admission", () => {
  it("rejects unsupported, stale, and unavailable owners", async () => {
    await expect(
      assertManagedCapability(
        managedCapabilityRepository as unknown as Parameters<
          typeof assertManagedCapability
        >[0],
        randomUUID(),
        {
          provider: "pi",
          aiClientInstanceId: "codex.default",
          capability: "managed_conversation_start"
        }
      )
    ).rejects.toThrow("belongs to another AI Client driver");

    const pi = {
      listAiClientInstances: async () => [
        {
          instanceId: "pi.default",
          driverId: "pi",
          enabled: true,
          configIdentityHash: ownerIdentityHash
        }
      ],
      listCurrentAiClientCapabilitySnapshots: async () => [
        {
          instanceId: "pi.default",
          installationIdentityHash: ownerIdentityHash,
          authenticationState: "authenticated",
          healthState: "healthy",
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilities: {
            descriptors: {
              managed_conversation_start: {
                support: "unsupported",
                readiness: "not_ready"
              }
            }
          }
        }
      ]
    };
    await expect(
      assertManagedCapability(
        pi as unknown as Parameters<typeof assertManagedCapability>[0],
        randomUUID(),
        {
          provider: "pi",
          aiClientInstanceId: "pi.default",
          capability: "managed_conversation_start"
        }
      )
    ).rejects.toThrow("cannot run");

    const disabled = {
      ...managedCapabilityRepository,
      listAiClientInstances: async () => [
        { instanceId: "codex.default", driverId: "codex", enabled: false }
      ]
    };
    await expect(
      assertManagedCapability(
        disabled as unknown as Parameters<typeof assertManagedCapability>[0],
        randomUUID(),
        {
          provider: "codex",
          aiClientInstanceId: "codex.default",
          capability: "managed_conversation_start"
        }
      )
    ).rejects.toThrow("unavailable");

    const stale = {
      ...managedCapabilityRepository,
      listCurrentAiClientCapabilitySnapshots: async () => [
        {
          instanceId: "codex.default",
          installationIdentityHash: ownerIdentityHash,
          authenticationState: "authenticated",
          healthState: "healthy",
          expiresAt: "2020-01-01T00:00:00.000Z",
          capabilities: {
            descriptors: {
              managed_conversation_start: {
                support: "supported",
                readiness: "ready"
              }
            }
          }
        }
      ]
    };
    await expect(
      assertManagedCapability(
        stale as unknown as Parameters<typeof assertManagedCapability>[0],
        randomUUID(),
        {
          provider: "codex",
          aiClientInstanceId: "codex.default",
          capability: "managed_conversation_start"
        }
      )
    ).rejects.toThrow("cannot run");

    const mismatched = {
      ...managedCapabilityRepository,
      listCurrentAiClientCapabilitySnapshots: async () => [
        {
          instanceId: "codex.default",
          installationIdentityHash: "e".repeat(64),
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
          }
        }
      ]
    };
    await expect(
      assertManagedCapability(
        mismatched as unknown as Parameters<typeof assertManagedCapability>[0],
        randomUUID(),
        {
          provider: "codex",
          aiClientInstanceId: "codex.default",
          capability: "managed_conversation_start"
        }
      )
    ).rejects.toThrow("cannot run");

    const upsertRace = {
      ...managedCapabilityRepository,
      listAiClientInstances: async () => [
        {
          instanceId: "codex.default",
          driverId: "codex",
          enabled: true,
          configIdentityHash: null
        }
      ]
    };
    await expect(
      assertManagedCapability(
        upsertRace as unknown as Parameters<typeof assertManagedCapability>[0],
        randomUUID(),
        {
          provider: "codex",
          aiClientInstanceId: "codex.default",
          capability: "managed_conversation_start"
        }
      )
    ).rejects.toThrow("cannot run");
  });
});

describe("managed Conversation routes", () => {
  it("starts the first Conversation from trusted local Project metadata", async () => {
    const userId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const projectId = "lp_new_project";
    const projectPath = mkdtempSync(resolve(tmpdir(), "koed-managed-project-"));
    const canonicalProjectPath = realpathSync(projectPath);
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-managed-home-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config", "projects.json"),
      JSON.stringify({
        schemaVersion: 3,
        projects: [
          {
            localProjectId: projectId,
            path: { cwd: projectPath, projectRoot: projectPath }
          }
        ]
      })
    );
    const upsert = vi.fn();
    const app = Fastify({ logger: false });
    registerManagedConversationRoutes(app, {
      config: { deploymentProfile: "local_personal", koedHome },
      encryption: { envelopeEncryptionProvider: {} },
      auth: {
        authenticate: async () => ({
          id: userId,
          email: "alice@example.invalid",
          displayName: "Alice",
          passwordHash: null
        })
      },
      deploymentIdentity: {
        inspect: () => ({
          health: "healthy",
          deploymentId,
          deviceInstanceId: deviceId
        })
      },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      localEdge: {
        upstreamBackendsPath: writeManagedUpstreamRegistry(),
        resolveUpstreamAuthorization: () =>
          "Koed-Device upstream-key:upstream-secret",
        fetch: vi.fn(async (input: URL | RequestInfo) => {
          const readiness = String(input).endsWith("/runtime-binding-ready");
          return new Response(
            JSON.stringify(
              readiness
                ? { ready: true }
                : {
                    execution: {
                      id: executionId,
                      projectId,
                      provider: managedOwner.provider,
                      aiClientInstanceId: managedOwner.aiClientInstanceId,
                      executionGeneration: 1,
                      state: "starting"
                    },
                    command: { id: commandId, state: "blocked" }
                  }
            ),
            {
              status: readiness ? 200 : 202,
              headers: { "content-type": "application/json" }
            }
          );
        })
      },
      requireRepository: () => ({
        ...managedCapabilityRepository,
        listLcmGraphThreads: async () => [],
        upsertManagedConversationRuntimeBinding: upsert,
        getManagedConversationRuntimeBinding: async () => null
      })
    } as unknown as ApiRouteContext);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/managed-conversations",
      payload: {
        projectId,
        ...managedOwner,
        idempotencyKey: "phase7-first-project-start"
      }
    });
    await app.close();

    expect(response.statusCode).toBe(202);
    expect(upsert).toHaveBeenCalledWith(
      { userId },
      expect.objectContaining({
        executionId,
        projectPath: canonicalProjectPath
      })
    );
  });

  it("binds a proxied start locally before releasing the remote command", async () => {
    const userId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const projectId = "lp_verified";
    const projectPath = "/work/verified-project";
    const upstreamCalls: Array<{ url: URL; body: unknown }> = [];
    const upsert = vi.fn(async (actor, input) => ({
      ...input,
      ownerUserId: actor.userId,
      localSessionId: null
    }));
    const getBinding = vi.fn(async () => ({
      localSessionId: null,
      providerThreadId: null
    }));
    const app = Fastify({ logger: false });
    registerManagedConversationRoutes(app, {
      config: { deploymentProfile: "local_personal" },
      encryption: { envelopeEncryptionProvider: {} },
      auth: {
        authenticate: async () => ({
          id: userId,
          email: "alice@example.invalid",
          displayName: "Alice",
          passwordHash: null
        })
      },
      deploymentIdentity: {
        inspect: () => ({
          health: "healthy",
          deploymentId,
          deviceInstanceId: deviceId
        })
      },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      localEdge: {
        upstreamBackendsPath: writeManagedUpstreamRegistry(),
        resolveUpstreamAuthorization: () =>
          "Koed-Device upstream-key:upstream-secret",
        fetch: vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
          upstreamCalls.push({
            url: new URL(String(input)),
            body: init?.body ? JSON.parse(String(init.body)) : null
          });
          if (String(input).endsWith("/runtime-binding-ready")) {
            return new Response(JSON.stringify({ ready: true }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
          return new Response(
            JSON.stringify({
              execution: {
                id: executionId,
                projectId,
                provider: managedOwner.provider,
                aiClientInstanceId: managedOwner.aiClientInstanceId,
                executionGeneration: 1,
                state: "starting"
              },
              command: { id: commandId, state: "blocked" }
            }),
            {
              status: 202,
              headers: { "content-type": "application/json" }
            }
          );
        })
      },
      requireRepository: () => ({
        ...managedCapabilityRepository,
        listLcmGraphThreads: async () => [{ id: projectId, path: projectPath }],
        upsertManagedConversationRuntimeBinding: upsert,
        getManagedConversationRuntimeBinding: getBinding
      })
    } as unknown as ApiRouteContext);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/managed-conversations",
      payload: {
        projectId,
        ...managedOwner,
        idempotencyKey: "phase7-start-binding"
      }
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/managed-conversations",
      payload: {
        projectId,
        ...managedOwner,
        idempotencyKey: "phase7-start-binding"
      }
    });
    await app.close();

    expect(response.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(upstreamCalls).toHaveLength(4);
    expect(upstreamCalls[0]?.body).toEqual({
      projectId,
      aiClientInstanceId: "codex.default",
      idempotencyKey: "phase7-start-binding",
      deferUntilRuntimeBinding: true,
      provider: "codex"
    });
    expect(JSON.stringify(upstreamCalls[0]?.body)).not.toContain(projectPath);
    expect(upsert).toHaveBeenCalledWith(
      { userId },
      {
        executionId,
        deploymentId,
        deviceId,
        executionGeneration: 1,
        projectPath
      }
    );
    expect(upstreamCalls[1]).toMatchObject({
      body: { executionGeneration: 1 }
    });
    expect(upstreamCalls[1]?.url.pathname).toBe(
      `/koed/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-ready`
    );
    expect(upstreamCalls[3]?.url.pathname).toBe(
      `/koed/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-ready`
    );
  });

  it("rejects malformed proxied starts before persisting a local binding", async () => {
    const userId = randomUUID();
    const upsert = vi.fn();
    const app = Fastify({ logger: false });
    registerManagedConversationRoutes(app, {
      config: { deploymentProfile: "local_personal" },
      encryption: { envelopeEncryptionProvider: {} },
      auth: {
        authenticate: async () => ({
          id: userId,
          email: "alice@example.invalid",
          displayName: "Alice",
          passwordHash: null
        })
      },
      deploymentIdentity: {
        inspect: () => ({
          health: "healthy",
          deploymentId: randomUUID(),
          deviceInstanceId: randomUUID()
        })
      },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      localEdge: {
        upstreamBackendsPath: writeManagedUpstreamRegistry(),
        resolveUpstreamAuthorization: () =>
          "Koed-Device upstream-key:upstream-secret",
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ execution: { id: "not-a-uuid" } }), {
              status: 202,
              headers: { "content-type": "application/json" }
            })
        )
      },
      requireRepository: () => ({
        ...managedCapabilityRepository,
        listLcmGraphThreads: async () => [
          { id: "lp_verified", path: "/work/verified-project" }
        ],
        upsertManagedConversationRuntimeBinding: upsert
      })
    } as unknown as ApiRouteContext);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/v1/managed-conversations",
      payload: {
        projectId: "lp_verified",
        ...managedOwner,
        idempotencyKey: "phase7-malformed-start"
      }
    });
    await app.close();

    expect(response.statusCode).toBe(502);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("forwards list filters as a query string without encoding them into the upstream path", async () => {
    const userId = randomUUID();
    const projectId = "project with spaces";
    const upstreamCalls: URL[] = [];
    const app = Fastify({ logger: false });
    registerManagedConversationRoutes(app, {
      config: { deploymentProfile: "local_personal" },
      encryption: { envelopeEncryptionProvider: {} },
      auth: {
        authenticate: async () => ({
          id: userId,
          email: "alice@example.invalid",
          displayName: "Alice",
          passwordHash: null
        })
      },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      localEdge: {
        upstreamBackendsPath: writeManagedUpstreamRegistry(),
        resolveUpstreamAuthorization: () =>
          "Koed-Device upstream-key:upstream-secret",
        fetch: vi.fn(async (input: URL | RequestInfo) => {
          upstreamCalls.push(new URL(String(input)));
          return new Response(JSON.stringify({ executions: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        })
      },
      requireRepository: () => ({
        ...managedCapabilityRepository,
        getManagedConversationRuntimeBinding: async () => null
      })
    } as unknown as ApiRouteContext);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/v1/managed-conversations?limit=37&projectId=${encodeURIComponent(projectId)}`
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ executions: [] });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.pathname).toBe("/koed/v1/managed-conversations");
    expect(upstreamCalls[0]?.searchParams.get("limit")).toBe("37");
    expect(upstreamCalls[0]?.searchParams.get("projectId")).toBe(projectId);
    expect(upstreamCalls[0]?.pathname).not.toContain("%3F");
  });
});
