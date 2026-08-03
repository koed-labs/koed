import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type {
  DeviceCredentialAuthContext,
  HighRiskActionGrantBindingRecord,
  UserSessionContext
} from "@koed/db";
import Fastify from "fastify";
import { sharedMemoryPreviewActionGrantBinding } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import { registerHighRiskRoutes, type HighRiskRouteContext } from "./routes.js";

const jsonBody = <T>(response: { body: string }): T =>
  JSON.parse(response.body) as T;

const now = Date.now();
const ids = {
  alice: randomUUID(),
  bob: randomUUID(),
  aliceSession: randomUUID(),
  staleSession: randomUUID(),
  activeDevice: randomUUID(),
  team: randomUUID(),
  target: randomUUID()
};

const binding = {
  id: randomUUID(),
  selector: randomUUID(),
  state: "pending" as const,
  ownerUserId: ids.alice,
  deviceCredentialId: ids.activeDevice,
  upstreamBackendId: "team-vps",
  teamId: ids.team,
  operationFamily: "admin",
  action: "team.member.disable",
  targetId: ids.target,
  scopeHash: "a".repeat(64),
  requestHash: "b".repeat(64),
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString()
} satisfies HighRiskActionGrantBindingRecord;

const deviceAuth = (
  operationFamilies: string[] = ["action_grant"]
): DeviceCredentialAuthContext => ({
  user: {
    id: ids.alice,
    email: "alice@example.test",
    displayName: "Alice",
    passwordHash: null
  },
  credential: {
    id: ids.activeDevice,
    ownerUserId: ids.alice,
    enrollmentChallengeId: null,
    credentialKeyId: "device-key",
    upstreamBackendId: "team-vps",
    deviceInstanceId: "device-1",
    lineageId: randomUUID(),
    deviceLabel: "Device",
    credentialVersion: 1,
    verifierKind: "secret_hash",
    operationFamilies,
    metadata: {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastUsedAt: null,
    lastValidatedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revocationReason: null
  }
});

const sessions = new Map<string, UserSessionContext>([
  [
    "alice-session",
    {
      sessionId: ids.aliceSession,
      createdAt: new Date(now - 30_000),
      expiresAt: new Date(now + 60_000),
      user: {
        id: ids.alice,
        email: "alice@example.test",
        displayName: "Alice",
        passwordHash: null
      }
    }
  ],
  [
    "stale-session",
    {
      sessionId: ids.staleSession,
      createdAt: new Date(now - 10 * 60_000),
      expiresAt: new Date(now + 60_000),
      user: {
        id: ids.alice,
        email: "alice@example.test",
        displayName: "Alice",
        passwordHash: null
      }
    }
  ]
]);

const buildServer = async (overrides?: {
  repository?: Partial<ReturnType<HighRiskRouteContext["requireRepository"]>>;
  deviceOperationFamilies?: string[];
  explorerPublicUrl?: string;
}) => {
  const repository: ReturnType<HighRiskRouteContext["requireRepository"]> = {
    createActionGrant: vi.fn(async () => binding),
    getActionGrant: vi.fn(async () => binding),
    awaitActionGrant: vi.fn(async () => binding),
    cancelActionGrant: vi.fn(async () => true),
    getBrowserActivation: vi.fn(async () => binding),
    decideBrowserActivation: vi.fn(async () => ({
      ...binding,
      state: "approved"
    })),
    lookupLegalHoldTeamId: vi.fn(async () => ids.team),
    getTeamWorkspaceAccess: vi.fn(async () => ({
      teamId: ids.team
    })),
    ...overrides?.repository
  } as never;

  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof candidate === "number"
          ? candidate
          : 500;
    reply.status(statusCode).send({
      error:
        error instanceof z.ZodError
          ? "Invalid request payload"
          : error instanceof Error
            ? error.message
            : String(error)
    });
  });
  registerHighRiskRoutes(app, {
    requireRepository: () => repository,
    authenticateSessionContext: async (request) => {
      const context = sessions.get(request.cookies.cm_session ?? "");
      if (!context) {
        throw Object.assign(new Error("Session cookie required"), {
          statusCode: 401
        });
      }
      return context;
    },
    authenticateDeviceCredential: async () =>
      deviceAuth(overrides?.deviceOperationFamilies),
    rateLimit: {
      browser: async () => undefined,
      deviceRead: async () => undefined,
      deviceWrite: async () => undefined
    },
    ...(overrides?.explorerPublicUrl
      ? { explorerPublicUrl: overrides.explorerPublicUrl }
      : {})
  });
  await app.ready();
  return { app, repository };
};

describe("high-risk action grant routes", () => {
  it("bounds Action Grant waits below the local transport deadline", async () => {
    const fixture = await buildServer();
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/high-risk/action-grants/${binding.id}/await`,
      headers: { authorization: "Koed-Device device-key:secret" }
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.awaitActionGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: binding.id,
        maxWaitMs: 20_000,
        signal: expect.any(AbortSignal)
      })
    );
    await fixture.app.close();
  });

  it("requires a device credential for create and never returns a grant secret", async () => {
    const fixture = await buildServer();

    const unauthorized = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"c".repeat(64)}`,
        intent: {
          action: "team.member.disable",
          teamId: ids.team,
          userId: ids.target,
          body: { expectedVersion: 1 }
        }
      }
    });
    const authorized = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"c".repeat(64)}`,
        intent: {
          action: "team.member.disable",
          teamId: ids.team,
          userId: ids.target,
          body: { expectedVersion: 1 }
        }
      }
    });

    expect(unauthorized.statusCode).toBe(403);
    expect(authorized.statusCode).toBe(201);
    expect(JSON.stringify(jsonBody(authorized))).not.toContain("hrg_");
    expect(JSON.stringify(jsonBody(authorized))).not.toContain("bindings");
    expect(
      jsonBody<{ status: { selector: string; activationPath: string } }>(
        authorized
      )
    ).toMatchObject({
      status: {
        selector: binding.selector,
        activationPath: `/v1/high-risk/browser-activations/${binding.selector}`
      }
    });
    expect(
      (fixture.repository.createActionGrant as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]
    ).toEqual(
      expect.objectContaining({
        ownerUserId: ids.alice,
        deviceCredentialId: ids.activeDevice,
        upstreamBackendId: "team-vps",
        operationFamily: "admin",
        action: "team.member.disable",
        teamId: ids.team,
        targetId: ids.target
      })
    );
    await fixture.app.close();
  });

  it("rejects Personal API Tokens before validating action-grant payloads", async () => {
    const fixture = await buildServer();

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Bearer personal-token" },
      payload: {}
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.repository.createActionGrant).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("rejects reusable admin authority as a substitute for action-grant enrollment", async () => {
    const fixture = await buildServer({
      deviceOperationFamilies: ["admin"]
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"c".repeat(64)}`,
        intent: {
          action: "team.member.disable",
          teamId: ids.team,
          userId: ids.target,
          body: { expectedVersion: 1 }
        }
      }
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.repository.createActionGrant).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("derives join, leave, and shared-memory bindings from the canonical intent without trusting local binding input", async () => {
    const fixture = await buildServer();

    await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: binding.id,
        grantCommitment: `v1:${"d".repeat(64)}`,
        intent: {
          action: "team.invite.accept",
          body: { inviteToken: "kti_validInvitationToken123456" }
        }
      }
    });
    await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"e".repeat(64)}`,
        intent: {
          action: "team.leave",
          teamId: ids.team,
          body: { expectedVersion: 3 }
        }
      }
    });

    const sharedFixture = await buildServer({
      repository: {
        createActionGrant: vi.fn(async () => ({
          ...binding,
          operationFamily: "share_grant_management",
          action:
            "shared_memory.preview.memory_events.lcm_leaves:memory_events",
          targetId: ids.target
        }))
      },
      deviceOperationFamilies: ["share_grant_management"]
    });
    await sharedFixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: binding.id,
        grantCommitment: `v1:${"f".repeat(64)}`,
        intent: {
          action: "shared_memory.preview",
          logicalMemoryId: ids.target,
          remoteReplicaId: ids.target,
          teamId: ids.team,
          teamWorkspaceId: ids.target,
          representation: "memory_events",
          allowedRepresentations: ["memory_events", "lcm_leaves"]
        }
      }
    });

    const createCalls = (
      fixture.repository.createActionGrant as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(createCalls[0]?.[0]).toMatchObject({
      action: "team.invite.accept",
      teamId: null,
      targetId: null,
      scopeHash: teamAdminScopeHash({
        action: "team.invite.accept",
        teamId: null,
        targetId: null
      }),
      requestHash: teamAdminRequestHash({
        method: "POST",
        path: "/v1/team-invites/accept",
        body: { inviteToken: "kti_validInvitationToken123456" }
      })
    });
    expect(createCalls[1]?.[0]).toMatchObject({
      action: "team.leave",
      teamId: ids.team,
      targetId: ids.team,
      scopeHash: teamAdminScopeHash({
        action: "team.leave",
        teamId: ids.team,
        targetId: ids.team
      }),
      requestHash: teamAdminRequestHash({
        method: "POST",
        path: `/v1/teams/${ids.team}/leave`,
        body: { expectedVersion: 3 }
      })
    });
    const expectedSharedBinding = sharedMemoryPreviewActionGrantBinding({
      referenceId: binding.id,
      logicalMemoryId: ids.target,
      remoteReplicaId: ids.target,
      teamId: ids.team,
      teamWorkspaceId: ids.target,
      representation: "memory_events",
      allowedRepresentations: ["memory_events", "lcm_leaves"]
    });
    expect(
      (sharedFixture.repository.createActionGrant as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0]
    ).toMatchObject({
      operationFamily: "share_grant_management",
      action: "shared_memory.preview.memory_events.lcm_leaves:memory_events",
      teamId: ids.team,
      targetId: ids.target,
      scopeHash: expectedSharedBinding.scopeHash,
      requestHash: expectedSharedBinding.requestHash
    });
    await fixture.app.close();
    await sharedFixture.app.close();
  });

  it("requires the exact device operation family for share-grant-management intents", async () => {
    const fixture = await buildServer();

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"c".repeat(64)}`,
        intent: {
          action: "shared_memory.preview",
          logicalMemoryId: ids.target,
          remoteReplicaId: ids.target,
          teamId: ids.team,
          teamWorkspaceId: ids.target,
          representation: "memory_events",
          allowedRepresentations: ["memory_events"]
        }
      }
    });

    expect(response.statusCode).toBe(403);
    await fixture.app.close();
  });

  it("supports device poll and cancel by client request ID", async () => {
    const fixture = await buildServer();

    const polled = await fixture.app.inject({
      method: "GET",
      url: `/v1/high-risk/action-grants/${binding.id}`,
      headers: { authorization: "Koed-Device device-key:secret" }
    });
    const cancelled = await fixture.app.inject({
      method: "DELETE",
      url: `/v1/high-risk/action-grants/${binding.id}`,
      headers: { authorization: "Koed-Device device-key:secret" }
    });

    expect(polled.statusCode).toBe(200);
    expect(
      jsonBody<{ status: { selector: string; state: string } }>(polled)
    ).toEqual(
      expect.objectContaining({
        status: expect.objectContaining({
          selector: binding.selector,
          state: binding.state
        })
      })
    );
    expect(cancelled.statusCode).toBe(204);
    await fixture.app.close();
  });

  it("redirects browser navigation to Explorer without weakening JSON authentication", async () => {
    const fixture = await buildServer({
      explorerPublicUrl: "https://koed.example/explorer"
    });

    const browserNavigation = await fixture.app.inject({
      method: "GET",
      url: `/v1/high-risk/browser-activations/${binding.selector}`,
      headers: { accept: "text/html,application/xhtml+xml" }
    });
    const programmaticRequest = await fixture.app.inject({
      method: "GET",
      url: `/v1/high-risk/browser-activations/${binding.selector}`,
      headers: { accept: "application/json" }
    });

    expect(browserNavigation.statusCode).toBe(302);
    expect(browserNavigation.headers.location).toBe(
      `https://koed.example/explorer/high-risk/browser-activations/${binding.selector}`
    );
    expect(programmaticRequest.statusCode).toBe(401);
    expect(fixture.repository.getBrowserActivation).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("returns only safe action and scope details to the authenticated browser", async () => {
    const fixture = await buildServer();

    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/high-risk/browser-activations/${binding.selector}`,
      headers: {
        accept: "application/json",
        cookie: "cm_session=alice-session"
      }
    });
    const body = jsonBody<{
      confirmation: Record<string, unknown>;
      status: Record<string, unknown>;
    }>(response);

    expect(response.statusCode).toBe(200);
    expect(body.confirmation).toEqual({
      action: binding.action,
      operationFamily: binding.operationFamily,
      teamId: binding.teamId,
      targetId: binding.targetId
    });
    expect(JSON.stringify(body)).not.toContain(binding.deviceCredentialId);
    expect(JSON.stringify(body)).not.toContain(binding.scopeHash);
    expect(JSON.stringify(body)).not.toContain(binding.requestHash);
    expect(JSON.stringify(body)).not.toContain("grantCommitment");
    expect(JSON.stringify(body)).not.toContain("hrg_");
    await fixture.app.close();
  });

  it("requires a fresh browser session for activation decisions", async () => {
    const fixture = await buildServer();

    const stale = await fixture.app.inject({
      method: "POST",
      url: `/v1/high-risk/browser-activations/${binding.selector}/decision`,
      headers: { cookie: "cm_session=stale-session" },
      payload: { decision: "approve" }
    });
    const fresh = await fixture.app.inject({
      method: "POST",
      url: `/v1/high-risk/browser-activations/${binding.selector}/decision`,
      headers: { cookie: "cm_session=alice-session" },
      payload: { decision: "approve" }
    });

    expect(stale.statusCode).toBe(403);
    expect(fresh.statusCode).toBe(200);
    expect(
      (fixture.repository.decideBrowserActivation as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0]
    ).toEqual(
      expect.objectContaining({
        ownerUserId: ids.alice,
        userSessionId: ids.aliceSession,
        decision: "approve"
      })
    );
    await fixture.app.close();
  });

  it.each(["source_download", "managed_execution"] as const)(
    "serializes %s browser confirmation responses",
    async (operationFamily) => {
      const fixture = await buildServer();
      (
        fixture.repository.getBrowserActivation as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...binding,
        operationFamily,
        action:
          operationFamily === "source_download"
            ? "conversation_source.discover"
            : "managed_conversation.handoff"
      });

      const response = await fixture.app.inject({
        method: "GET",
        url: `/v1/high-risk/browser-activations/${binding.selector}`,
        headers: { cookie: "cm_session=alice-session" }
      });

      expect(response.statusCode).toBe(200);
      expect(
        jsonBody<{
          confirmation: { operationFamily: string; action: string };
        }>(response).confirmation
      ).toMatchObject({ operationFamily });
      await fixture.app.close();
    }
  );
});
