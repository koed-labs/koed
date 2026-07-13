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
  type LocalEdgeUpstreamBackend
} from "./upstream-routing.js";

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
        deviceCredential: credential(["sync"])
      })
    ).toMatchObject({
      action: "queued_sync_handoff",
      reason: "queued_sync_handoff"
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

  it("keeps upstream proxy paths matched to the authorized operation family", () => {
    expect(() =>
      assertUpstreamOperationPathAllowed(
        "team_workspace_read",
        "POST",
        "/v1/memory/answer?team_workspace_id=workspace"
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
    ).not.toThrow();
  });
});
