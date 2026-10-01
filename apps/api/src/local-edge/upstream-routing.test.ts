import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceCredentialRecord } from "@koed/db";
import {
  assertUpstreamOperationPathAllowed,
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  safeUpstreamProxyUrl,
  upstreamAdvertisesCapability,
  upstreamSupportsCollaborationRealtime,
  type LocalEdgeUpstreamBackend
} from "./upstream-routing.js";
import { collaborationRealtimeProtocolVersion } from "../server/capabilities.js";
import {
  localEdgeTeamMemoryAnswerSchema,
  localEdgeTeamMemoryExpandSchema,
  localEdgeTeamMemorySearchSchema
} from "./schemas.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const path of tempDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const backend = (
  overrides: Partial<LocalEdgeUpstreamBackend> = {}
): LocalEdgeUpstreamBackend => ({
  id: "team-vps",
  baseUrl: "https://team.example.test/koed",
  routePolicy: {
    personalMemoryRead: "disabled",
    teamWorkspaceRead: "enabled",
    shareGrantManagement: "enabled",
    captureWrites: "disabled",
    sync: "enabled",
    admin: "enabled"
  },
  credential: { status: "configured" },
  capabilities: {
    state: "validated",
    expiresAt: "2099-01-01T00:15:00.000Z"
  },
  ...overrides
});

const credential = (
  operationFamilies: string[] = ["team_workspace_read", "sync"]
): DeviceCredentialRecord => ({
  id: "credential-id",
  ownerUserId: "user-id",
  enrollmentChallengeId: "challenge-id",
  credentialKeyId: "credential-key",
  upstreamBackendId: "team-vps",
  deviceInstanceId: "device-1",
  deviceLabel: "Desktop",
  credentialVersion: 1,
  lineageId: "credential-lineage-id",
  verifierKind: "secret_hash",
  operationFamilies,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  lastValidatedAt: null,
  expiresAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null
});

describe("local edge upstream routing", () => {
  it("accepts scoped Team Memory evidence operations for credentialed routing", () => {
    const teamWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const nodeId = "22222222-2222-4222-8222-222222222222";

    for (const [schema, input] of [
      [
        localEdgeTeamMemorySearchSchema,
        {
          upstream_backend_id: "team-vps",
          input: { query: "search", team_workspace_id: teamWorkspaceId }
        }
      ],
      [
        localEdgeTeamMemoryAnswerSchema,
        {
          upstream_backend_id: "team-vps",
          input: { query: "answer", team_workspace_id: teamWorkspaceId }
        }
      ],
      [
        localEdgeTeamMemoryExpandSchema,
        {
          upstream_backend_id: "team-vps",
          node_id: nodeId,
          input: { team_workspace_id: teamWorkspaceId }
        }
      ]
    ] as const) {
      const result = schema.safeParse(input);
      expect(result.success).toBe(true);
    }
  });

  it("limits action-grant routing to browser-confirmed control and exact high-risk paths", () => {
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "action_grant",
        "POST",
        "/v1/high-risk/action-grants"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed("action_grant", "POST", "/v1/teams")
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "action_grant",
        "POST",
        "/v1/memory/search"
      )
    ).toThrow("Upstream path is not allowed for operation family");
  });

  it("requires the cached upstream to advertise the exact capability", () => {
    expect(
      upstreamAdvertisesCapability(backend(), "memory.crossIdentitySync")
    ).toBe(false);
    expect(
      upstreamAdvertisesCapability(
        backend({
          capabilities: {
            state: "validated",
            expiresAt: "2099-01-01T00:15:00.000Z",
            payload: {
              capabilities: {
                "memory.crossIdentitySync": { availability: "available" }
              }
            }
          }
        }),
        "memory.crossIdentitySync"
      )
    ).toBe(true);
  });

  it("requires capability schema 7, memory.collaboration, and the current realtime protocol", () => {
    const supported = backend({
      capabilities: {
        state: "validated",
        expiresAt: "2099-01-01T00:15:00.000Z",
        schemaVersion: 9,
        payload: {
          capabilitySchemaVersion: 9,
          capabilities: {
            "memory.collaboration": { availability: "partial" }
          },
          protocols: {
            collaborationRealtime: {
              version: collaborationRealtimeProtocolVersion,
              transport: "sse"
            }
          }
        }
      }
    });
    expect(upstreamSupportsCollaborationRealtime(supported)).toBe(true);
    expect(
      upstreamSupportsCollaborationRealtime({
        ...supported,
        capabilities: {
          ...supported.capabilities,
          schemaVersion: 5
        }
      })
    ).toBe(false);
    expect(
      upstreamSupportsCollaborationRealtime({
        ...supported,
        capabilities: {
          ...supported.capabilities,
          payload: {
            ...supported.capabilities?.payload,
            protocols: { collaborationRealtime: { version: 1 } }
          }
        }
      })
    ).toBe(false);
  });
  it("keeps Personal Memory local unless an upstream is explicit", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "personal_memory_read"
      })
    ).toMatchObject({
      action: "local_only",
      reason: "local_personal_default",
      credentialState: "not_required"
    });
  });

  it("keeps local Personal Memory available but blocks remote routing when identity is unhealthy", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "personal_memory_read",
        identityRemoteOperationsAllowed: false
      })
    ).toMatchObject({ action: "local_only", reason: "local_personal_default" });
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "team_workspace_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        deviceCredential: credential(),
        upstreamCredentialAvailable: true,
        identityRemoteOperationsAllowed: false
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "device_identity_unhealthy"
    });
  });

  it("fails closed for stale upstream capabilities and asks for refresh first", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "team_workspace_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend({
          capabilities: {
            state: "validated",
            expiresAt: "2026-01-01T00:00:00.000Z"
          }
        }),
        deviceCredential: credential(),
        now: new Date("2026-01-01T00:00:01.000Z")
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "capabilities_not_validated",
      capabilityState: "stale",
      retryAfterCapabilityRefresh: true
    });
  });

  it("does not enable upstream capture from registration alone", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "capture_writes",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        deviceCredential: credential(["capture_writes"]),
        capturePolicy: {
          captureState: "enabled",
          visibility: "personal",
          paused: false,
          pauseUntil: null,
          source: "default",
          policy: null
        }
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "route_policy_disabled"
    });
  });

  it("blocks capture writes when the effective Capture Policy is disabled", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "capture_writes",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend({ routePolicy: { captureWrites: "enabled" } }),
        deviceCredential: credential(["capture_writes"]),
        capturePolicy: {
          captureState: "disabled",
          visibility: "personal",
          paused: false,
          pauseUntil: null,
          source: "default",
          policy: null
        }
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "capture_disabled"
    });
  });

  it("applies Capture Policy before local capture decisions", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "capture_writes",
        capturePolicy: {
          captureState: "disabled",
          visibility: "personal",
          paused: false,
          pauseUntil: null,
          source: "default",
          policy: null
        }
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "capture_disabled"
    });
  });

  it("blocks capture writes when Capture Policy is paused/ask or not personal", () => {
    const basePolicy = {
      paused: false,
      pauseUntil: null,
      source: "default" as const,
      policy: null
    };

    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "capture_writes",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend({ routePolicy: { captureWrites: "enabled" } }),
        deviceCredential: credential(["capture_writes"]),
        capturePolicy: {
          ...basePolicy,
          captureState: "ask",
          visibility: "personal"
        }
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "capture_disabled"
    });

    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "capture_writes",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend({ routePolicy: { captureWrites: "enabled" } }),
        deviceCredential: credential(["capture_writes"]),
        capturePolicy: {
          ...basePolicy,
          captureState: "enabled",
          visibility: "team"
        } as unknown as Parameters<
          typeof resolveLocalEdgeRouteDecision
        >[0]["capturePolicy"]
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "unsupported_capture_visibility"
    });
  });

  it("returns queued-sync handoff when sync policy, capabilities, and credential pass", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "sync",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        upstreamCredentialAvailable: true
      })
    ).toMatchObject({
      action: "queued_sync_handoff",
      reason: "queued_sync_handoff"
    });
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "sync",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        deviceCredential: credential(["sync"]),
        upstreamCredentialAvailable: false
      })
    ).toMatchObject({ action: "deny_fail_closed", reason: "missing" });
  });

  it("does not authorize capture writes from a relay credential alone", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "capture_writes",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend({ routePolicy: { captureWrites: "enabled" } }),
        upstreamCredentialAvailable: true,
        capturePolicy: {
          captureState: "enabled",
          visibility: "personal",
          paused: false,
          pauseUntil: null,
          source: "default",
          policy: null
        }
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "missing",
      credentialState: "missing"
    });
  });

  it("fails closed when the device credential does not allow the operation family", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "team_workspace_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        deviceCredential: credential(["sync"])
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "operation_not_allowed",
      credentialState: "operation_not_allowed"
    });
  });

  it("does not treat a legacy wildcard as authorization", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "team_workspace_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        deviceCredential: credential(["*"]),
        upstreamCredentialAvailable: true
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "operation_not_allowed",
      credentialState: "operation_not_allowed"
    });
  });

  it("requires a distinct upstream relay credential for live proxy decisions", () => {
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "team_workspace_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        deviceCredential: credential(["team_workspace_read"])
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "upstream_credential_missing",
      credentialState: "configured",
      relayCredentialState: "missing"
    });

    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "team_workspace_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: backend(),
        deviceCredential: credential(["team_workspace_read"]),
        upstreamCredentialAvailable: true
      })
    ).toMatchObject({
      action: "live_upstream_proxy",
      reason: "live_upstream_proxy",
      credentialState: "configured",
      relayCredentialState: "configured"
    });
  });

  it("keeps upstream proxy paths inside non-local-edge v1 APIs", () => {
    const target = safeUpstreamProxyUrl(backend(), "/v1/memory/answer?limit=1");
    expect(String(target)).toBe(
      "https://team.example.test/koed/v1/memory/answer?limit=1"
    );
    expect(() => safeUpstreamProxyUrl(backend(), "/v1/../admin")).toThrow(
      "Unsupported upstream proxy path"
    );
    expect(() =>
      safeUpstreamProxyUrl(backend(), "/v1/local-edge/route-decisions")
    ).toThrow("Unsupported upstream proxy path");
    expect(() =>
      safeUpstreamProxyUrl(
        backend({ baseUrl: "http://team.example.test" }),
        "/v1/memory/answer"
      )
    ).toThrow("must use HTTPS unless it targets localhost");
    expect(() =>
      safeUpstreamProxyUrl(
        backend({ baseUrl: "http://127.0.0.1:3300" }),
        "/v1/memory/answer"
      )
    ).not.toThrow();
  });

  it("drops insecure remote HTTP entries from a hand-edited registry", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "koed-upstream-routing-"));
    tempDirectories.push(directory);
    const path = resolve(directory, "upstream-backends.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        activeBackendId: "loopback",
        backends: [
          { id: "insecure", baseUrl: "http://team.example.test" },
          { id: "loopback", baseUrl: "http://127.0.0.1:3300" },
          { id: "secure", baseUrl: "https://team.example.test" }
        ]
      })
    );

    expect(
      readLocalEdgeUpstreamRegistry(path).backends.map(({ id }) => id)
    ).toEqual(["loopback", "secure"]);
  });

  it("observes an atomically replaced registry immediately", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "koed-upstream-routing-"));
    tempDirectories.push(directory);
    const path = resolve(directory, "upstream-backends.json");
    let mtimeMs = 1;
    let activeBackendId = "first";
    const readFileSync = () =>
      JSON.stringify({
        schemaVersion: 2,
        activeBackendId,
        backends: [
          {
            id: activeBackendId,
            baseUrl: "https://team.example.test",
            routePolicy: {}
          }
        ]
      });
    const dependencies = {
      existsSync: () => true,
      statSync: () => ({ mtimeMs }),
      readFileSync
    } as unknown as Parameters<typeof readLocalEdgeUpstreamRegistry>[1];

    expect(
      readLocalEdgeUpstreamRegistry(path, dependencies).activeBackendId
    ).toBe("first");
    activeBackendId = "second";
    mtimeMs = 2;
    expect(
      readLocalEdgeUpstreamRegistry(path, dependencies).activeBackendId
    ).toBe("second");
  });

  it("keeps upstream proxy paths matched to the authorized operation family", () => {
    for (const [method, path] of [
      ["POST", "/v1/memory/search"],
      ["POST", "/v1/memory/answer?team_workspace_id=workspace"],
      ["GET", "/v1/memory/nodes/node-id/expand"],
      ["GET", "/v1/memory/graph/nodes?teamWorkspaceId=workspace"]
    ] as const) {
      expect(() =>
        assertUpstreamOperationPathAllowed("team_workspace_read", method, path)
      ).toThrow("not allowed for operation family");
    }
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "personal_memory_read",
        "POST",
        "/v1/memory/answer"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "POST",
        "/v1/collaboration/realtime/snapshot"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "GET",
        "/v1/collaboration/realtime/stream?scope=team"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "POST",
        "/v1/collaboration/realtime/ack"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "GET",
        "/v1/collaboration/realtime/ack"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "POST",
        "/v1/collaboration/realtime/snapshot/extra"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "GET",
        "/v1/team-context"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "POST",
        "/v1/teams/team-id/members"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "capture_writes",
        "POST",
        "/v1/memory/conversation-items"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "capture_writes",
        "DELETE",
        "/v1/memory/conversation-items"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "share_grant_management",
        "DELETE",
        "/v1/team-workspaces/workspace-id/session-share-grants/grant-id"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_read",
        "GET",
        "/v1/team-chat/stream?teamId=team-id"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_read",
        "POST",
        "/v1/team-chat/threads/thread-id/messages"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_write",
        "POST",
        "/v1/team-chat/threads/thread-id/messages"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_write",
        "POST",
        "/v1/memory/conversation-items"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_file_read",
        "POST",
        "/v1/managed-conversations/execution-id/files"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_file_read",
        "GET",
        "/v1/managed-conversations/execution-id/files/command-id"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "GET",
        "/v1/managed-conversations/execution-id/files/command-id"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_file_read",
        "GET",
        "/v1/managed-conversations/execution-id/runtime"
      )
    ).toThrow("not allowed for operation family");
  });

  it("limits Public Square upstream routes to the exact Team read/write contract", () => {
    const team = "018f47b2-3f6d-7a45-8c52-5a1f62090001";
    const project = "018f47b2-3f6d-7a45-8c52-5a1f62090002";
    const publication = "018f47b2-3f6d-7a45-8c52-5a1f62090003";
    for (const path of [
      `/v1/collaboration/teams/${team}/public-square?limit=50&cursor=abc`,
      `/v1/collaboration/teams/${team}/public-square/projects/${project}/connection`,
      `/v1/collaboration/teams/${team}/public-square/${publication}/brief-draft`
    ])
      expect(() =>
        assertUpstreamOperationPathAllowed("team_chat_read", "GET", path)
      ).not.toThrow();
    for (const [method, path] of [
      [
        "PUT",
        `/v1/collaboration/teams/${team}/public-square/projects/${project}/connection`
      ],
      [
        "POST",
        `/v1/collaboration/teams/${team}/public-square/projects/${project}/unshare`
      ],
      [
        "PUT",
        `/v1/collaboration/teams/${team}/public-square/${publication}/brief`
      ]
    ] as const)
      expect(() =>
        assertUpstreamOperationPathAllowed("team_chat_write", method, path)
      ).not.toThrow();
    for (const [family, method, path] of [
      [
        "team_chat_read",
        "GET",
        `/v1/collaboration/teams/${team}/public-square?offset=1`
      ],
      [
        "team_chat_read",
        "POST",
        `/v1/collaboration/teams/${team}/public-square/projects/${project}/unshare`
      ],
      [
        "team_chat_write",
        "PUT",
        `/v1/collaboration/teams/${team}/public-square/${publication}/brief-draft`
      ],
      [
        "team_chat_read",
        "GET",
        `/v1/collaboration/teams/${team}/public-square/projects/not-a-uuid/connection`
      ]
    ] as const)
      expect(() =>
        assertUpstreamOperationPathAllowed(family, method, path)
      ).toThrow("not allowed for operation family");
  });

  it("allows only the exact GET paths for Team memory retention settings", () => {
    const teamId = "11111111-1111-4111-8111-111111111111";
    for (const path of [
      `/v1/teams/${teamId}/memory-retention`,
      `/v1/teams/${teamId}/memory-retention/members`
    ]) {
      expect(() =>
        assertUpstreamOperationPathAllowed("team_workspace_read", "GET", path)
      ).not.toThrow();
    }

    for (const [method, path] of [
      ["POST", `/v1/teams/${teamId}/memory-retention`],
      ["PATCH", `/v1/teams/${teamId}/memory-retention/members`],
      ["GET", `/v1/teams/${teamId}/memory-retention/members/extra`],
      ["GET", `/v1/teams/not-a-uuid/memory-retention`],
      ["GET", `/v1/teams/${teamId}/members/${teamId}/memory-retention`],
      ["GET", `/v1/teams/${teamId}/billing-seats`]
    ] as const) {
      expect(() =>
        assertUpstreamOperationPathAllowed("team_workspace_read", method, path)
      ).toThrow("not allowed for operation family");
    }
  });

  it("routes file inspection only for its explicit enrolled family", () => {
    const managedBackend = backend({
      routePolicy: { managedExecution: "enabled" }
    });
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "managed_file_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: managedBackend,
        deviceCredential: credential(["managed_execution"]),
        upstreamCredentialAvailable: true
      })
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "operation_not_allowed"
    });
    expect(
      resolveLocalEdgeRouteDecision({
        operationFamily: "managed_file_read",
        upstreamBackendId: "team-vps",
        upstreamBackend: managedBackend,
        deviceCredential: credential(["managed_file_read"]),
        upstreamCredentialAvailable: true
      })
    ).toMatchObject({
      action: "live_upstream_proxy",
      reason: "live_upstream_proxy"
    });
  });

  it("allows only owner history reads through managed execution routing", () => {
    const path =
      "/v1/managed-conversations/execution-id/agent-state?limit=5&before=prompt%3A9";
    expect(() =>
      assertUpstreamOperationPathAllowed("managed_execution", "GET", path)
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed("managed_execution", "POST", path)
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "GET",
        "/v1/managed-conversations/execution-id/agent-state/extra"
      )
    ).toThrow("not allowed for operation family");
  });

  it("proxies only exact recalled-answer feedback reads and writes", () => {
    const executionId = "11111111-1111-4111-8111-111111111111";
    const messageId = "provider:22222222-2222-4222-8222-222222222222";
    const path = `/v1/managed-conversations/${executionId}/recall-feedback/${encodeURIComponent(messageId)}`;
    for (const method of ["GET", "PUT"] as const) {
      expect(() =>
        assertUpstreamOperationPathAllowed("managed_execution", method, path)
      ).not.toThrow();
    }
    for (const [method, invalidPath] of [
      ["POST", path],
      ["GET", `${path}/extra`],
      ["PUT", `${path}?other=1`],
      ["PUT", path.replace("provider%3A", "provider%253A")]
    ] as const) {
      expect(() =>
        assertUpstreamOperationPathAllowed(
          "managed_execution",
          method,
          invalidPath
        )
      ).toThrow("not allowed for operation family");
    }
  });

  it("allows bounded Personal Agent library routes through managed execution credentials", () => {
    const agentId = "7bd960fe-6ff0-4bff-8101-4232aa61cb69";
    const allowed: Array<["GET" | "POST" | "PATCH", string]> = [
      ["GET", "/v1/personal-agent-role-templates"],
      ["GET", "/v1/personal-agents"],
      ["GET", "/v1/personal-agents/capabilities"],
      ["GET", `/v1/personal-agents/activity?agentId=${agentId}`],
      ["GET", `/v1/personal-agents/${agentId}/jobs?limit=20&before=abc_123`],
      ["GET", `/v1/personal-agents/${agentId}`],
      ["POST", "/v1/personal-agents"],
      ["PATCH", `/v1/personal-agents/${agentId}`],
      ["POST", `/v1/personal-agents/${agentId}/retire`],
      ["POST", `/v1/personal-agents/${agentId}/restore`]
    ];
    for (const [method, path] of allowed) {
      expect(() =>
        assertUpstreamOperationPathAllowed("managed_execution", method, path)
      ).not.toThrow();
    }
    for (const [method, path] of [
      ["DELETE", `/v1/personal-agents/${agentId}`],
      ["POST", `/v1/personal-agents/${agentId}/clone`],
      ["GET", `/v1/personal-agents/${agentId}/versions`],
      ["POST", "/v1/personal-agents/not-a-uuid/retire"],
      ["GET", `/v1/personal-agents/activity?agentId=${agentId}&owner=x`],
      [
        "GET",
        `/v1/personal-agents/activity?agentId=${agentId}&agentId=${agentId}`
      ],
      ["GET", `/v1/personal-agents/${agentId}/jobs?limit=100`],
      ["GET", `/v1/personal-agents/${agentId}/jobs?limit=20&before=a.b`]
    ] as const) {
      expect(() =>
        assertUpstreamOperationPathAllowed("managed_execution", method, path)
      ).toThrow("not allowed for operation family");
    }
  });

  it("allows only POST prompt cancellation through managed execution routing", () => {
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "POST",
        "/v1/managed-conversations/execution-id/prompts/command-id/cancel"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "GET",
        "/v1/managed-conversations/execution-id/prompts/command-id/cancel"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "POST",
        "/v1/managed-conversations/execution-id/prompts/command-id/cancel/extra"
      )
    ).toThrow("not allowed for operation family");
  });

  it("allows only POST start cancellation through managed execution routing", () => {
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "POST",
        "/v1/managed-conversations/execution-id/start/cancel"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "GET",
        "/v1/managed-conversations/execution-id/start/cancel"
      )
    ).toThrow("not allowed for operation family");
  });

  it("allows only GET recovery lookup through managed execution routing", () => {
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "GET",
        "/v1/managed-conversations/recovery/lookup"
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "POST",
        "/v1/managed-conversations/recovery/lookup"
      )
    ).toThrow("not allowed for operation family");
  });

  it("admits command-scoped Agent signals only as managed runner POSTs", () => {
    for (const suffix of [
      "personal-agent-intent",
      "personal-agent-turn-status"
    ]) {
      const path = `/v1/managed-conversation-runner/commands/11111111-1111-4111-8111-111111111111/${suffix}`;
      expect(() =>
        assertUpstreamOperationPathAllowed("managed_execution", "POST", path)
      ).not.toThrow();
      expect(() =>
        assertUpstreamOperationPathAllowed("managed_execution", "GET", path)
      ).toThrow();
      expect(() =>
        assertUpstreamOperationPathAllowed(
          "managed_execution",
          "POST",
          `${path}?ownerId=other`
        )
      ).toThrow();
      expect(() =>
        assertUpstreamOperationPathAllowed("team_chat_write", "POST", path)
      ).toThrow();
      expect(() =>
        assertUpstreamOperationPathAllowed(
          "managed_execution",
          "POST",
          path.replace("11111111-1111-4111-8111-111111111111", "invalid")
        )
      ).toThrow();
    }
  });

  it("routes the Personal Agent runner job lifecycle only on its declared methods", () => {
    const allowed = [
      [
        "GET",
        "/v1/managed-conversation-runner/personal-agent/jobs?conversationId=execution-id"
      ],
      ["GET", "/v1/managed-conversation-runner/personal-agent/jobs/job-id"],
      [
        "GET",
        "/v1/managed-conversation-runner/personal-agent/jobs/job-id/attempts"
      ],
      [
        "POST",
        "/v1/managed-conversation-runner/personal-agent/jobs/job-id/attempts"
      ],
      [
        "POST",
        "/v1/managed-conversation-runner/personal-agent/jobs/job-id/attempts/attempt-id/output"
      ],
      [
        "POST",
        "/v1/managed-conversation-runner/personal-agent/jobs/job-id/attempts/attempt-id/complete"
      ]
    ] as const;
    for (const [method, path] of allowed) {
      expect(() =>
        assertUpstreamOperationPathAllowed("managed_execution", method, path)
      ).not.toThrow();
    }
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "DELETE",
        "/v1/managed-conversation-runner/personal-agent/jobs/job-id"
      )
    ).toThrow("not allowed for operation family");
  });

  it("routes only the Project Move methods required by owner and runner", () => {
    const allowed = [
      ["POST", "/v1/managed-conversations/execution-id/project-moves"],
      ["GET", "/v1/managed-conversations/execution-id/project-moves/move-id"],
      [
        "POST",
        "/v1/managed-conversations/execution-id/project-moves/move-id/cancel"
      ],
      ["POST", "/v1/managed-conversation-runner/project-moves/claim"],
      ["POST", "/v1/managed-conversation-runner/project-moves/move-id/lease"],
      [
        "POST",
        "/v1/managed-conversation-runner/project-moves/move-id/complete"
      ],
      ["POST", "/v1/managed-conversation-runner/project-moves/move-id/fail"]
    ] as const;
    for (const [method, path] of allowed) {
      expect(() =>
        assertUpstreamOperationPathAllowed("managed_execution", method, path)
      ).not.toThrow();
    }
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "GET",
        "/v1/managed-conversations/execution-id/project-moves"
      )
    ).toThrow("not allowed for operation family");
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "managed_execution",
        "GET",
        "/v1/managed-conversation-runner/project-moves/claim"
      )
    ).toThrow("not allowed for operation family");
  });

  it("confines AI Client capability publishing to instance and snapshot writes", () => {
    const allowed = [
      ["PUT", "/v1/memory/ai-client-instances/codex.default"],
      [
        "POST",
        "/v1/memory/ai-client-instances/codex.default/capability-snapshots"
      ]
    ] as const;
    for (const [method, path] of allowed) {
      expect(() =>
        assertUpstreamOperationPathAllowed(
          "ai_client_capability_publish",
          method,
          path
        )
      ).not.toThrow();
    }
    const denied = [
      ["GET", "/v1/memory/ai-client-instances"],
      ["DELETE", "/v1/memory/ai-client-instances/codex.default"],
      ["PUT", "/v1/memory/ai-client-instances/codex.default?owner=other"],
      [
        "POST",
        "/v1/memory/ai-client-instances/codex.default/capability-snapshots/other"
      ],
      ["POST", "/v1/memory/ai-client-instances/../teams"]
    ] as const;
    for (const [method, path] of denied) {
      expect(() =>
        assertUpstreamOperationPathAllowed(
          "ai_client_capability_publish",
          method,
          path
        )
      ).toThrow("not allowed for operation family");
    }
  });
});

describe("Team Agent request upstream route grants", () => {
  const team = "8138c7cd-b96d-49eb-b647-6f03a8486033";
  const id = "0b014db6-a942-5e80-8ccf-4949130c51a7";
  const prefix = `/v1/collaboration/teams/${team}`;
  it("permits explicit read routes and bounded request filters", () => {
    for (const path of [
      `${prefix}/agent-offers`,
      `${prefix}/agent-requests/inbox?limit=50&cursor=page`,
      `${prefix}/agent-requests/${id}/review`,
      `${prefix}/agent-requests?channelId=${id}&status=awaiting_owner&limit=5&cursor=page`
    ])
      expect(() =>
        assertUpstreamOperationPathAllowed("team_chat_read", "GET", path)
      ).not.toThrow();
  });
  it("permits only explicit request mutation routes", () => {
    for (const [method, path] of [
      ["POST", `${prefix}/agent-requests`],
      ["PUT", `${prefix}/agent-offers/${id}`],
      ["PUT", `${prefix}/agent-requests/${id}/review`],
      ["PUT", `${prefix}/agent-requests/${id}/decision`],
      ["DELETE", `${prefix}/agent-requests/${id}`],
      ["POST", `${prefix}/agent-requests/${id}/outcome`]
    ] as const)
      expect(() =>
        assertUpstreamOperationPathAllowed("team_chat_write", method, path)
      ).not.toThrow();
  });
  it("rejects widened scopes, invalid filters and method escalation", () => {
    for (const [family, method, path] of [
      ["personal_collaboration_read", "GET", `${prefix}/agent-offers`],
      ["managed_execution", "PUT", `${prefix}/agent-offers/${id}`],
      ["team_chat_read", "PUT", `${prefix}/agent-requests/${id}/decision`],
      ["team_chat_write", "POST", `${prefix}/agent-requests/${id}/stop`],
      ["team_chat_read", "GET", `${prefix}/agent-requests?ownerId=${id}`],
      ["team_chat_read", "GET", `${prefix}/agent-requests?channelId=invalid`],
      ["team_chat_read", "GET", `${prefix}/agent-requests?limit=101`],
      ["team_chat_read", "GET", `${prefix}/agent-requests?limit=5&limit=7`],
      ["team_chat_read", "GET", `${prefix}/agent-requests/inbox?ownerId=${id}`],
      [
        "team_chat_write",
        "DELETE",
        `${prefix}/agent-requests/${id}?ownerId=${id}`
      ]
    ] as const)
      expect(() =>
        assertUpstreamOperationPathAllowed(family, method, path)
      ).toThrow();
  });
});

describe("Team message upstream route grants", () => {
  const team = "8138c7cd-b96d-49eb-b647-6f03a8486033";
  const thread = "0b014db6-a942-5e80-8ccf-4949130c51a7";
  const message = "1c125efc-c053-4f91-9dd5-0a6e7761b32b";
  const root = "2d236f0d-d164-40a2-8ee6-1b7f8872c43c";
  const prefix = `/v1/collaboration/teams/${team}/threads/${thread}`;

  it("permits bounded root-scoped message reads and read cursors", () => {
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_read",
        "GET",
        `${prefix}/messages?beforeSequence=20&limit=50&rootMessageId=${root}`
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_read",
        "GET",
        `${prefix}/messages?afterSequence=101&beforeSequence=9007199254740991&limit=100&rootMessageId=${root}`
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_read",
        "GET",
        `${prefix}/messages?afterSequence=0&limit=50`
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_read",
        "PUT",
        `${prefix}/read-state`
      )
    ).not.toThrow();
  });

  it("permits only the message edit and reaction mutation paths", () => {
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_write",
        "POST",
        `${prefix}/messages`
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_write",
        "PATCH",
        `${prefix}/messages/${message}`
      )
    ).not.toThrow();
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_chat_write",
        "PUT",
        `${prefix}/messages/${message}/reactions`
      )
    ).not.toThrow();
  });

  it("rejects unbounded filters and unrelated message mutation routes", () => {
    for (const [family, method, path] of [
      ["team_chat_read", "GET", `${prefix}/messages?rootMessageId=bad`],
      ["team_chat_read", "GET", `${prefix}/messages?offset=0`],
      ["team_chat_read", "GET", `${prefix}/messages?limit=101`],
      [
        "team_chat_read",
        "GET",
        `${prefix}/messages?beforeSequence=9007199254740992`
      ],
      ["team_chat_write", "PATCH", `${prefix}/messages/${message}/reactions`],
      ["team_chat_write", "PUT", `${prefix}/messages/${message}`],
      ["personal_collaboration_read", "GET", `${prefix}/messages`]
    ] as const) {
      expect(() =>
        assertUpstreamOperationPathAllowed(family, method, path)
      ).toThrow();
    }
  });
});
