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

  it("requires capability schema 6, memory.collaboration, and the current realtime protocol", () => {
    const supported = backend({
      capabilities: {
        state: "validated",
        expiresAt: "2099-01-01T00:15:00.000Z",
        schemaVersion: 6,
        payload: {
          capabilitySchemaVersion: 6,
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
  });
});
