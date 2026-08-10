import { createHash, randomUUID } from "node:crypto";
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
  bobSession: randomUUID(),
  staleSession: randomUUID(),
  activeDevice: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
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
  approvalTier: "step_up" as const,
  review: {
    version: 1 as const,
    title: "Disable Bob",
    description: "Bob will no longer be able to use this team.",
    consequence: "Their existing sessions and access will be revoked.",
    confirmLabel: "Disable member",
    details: [{ label: "Member", value: "Bob" }]
  },
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

const managedTargetCredential = (input: {
  createdAt: string;
  deploymentId: string;
}) => ({
  ...deviceAuth(["sync", "managed_execution"]).credential,
  id: randomUUID(),
  credentialKeyId: `target-${randomUUID()}`,
  deviceInstanceId: ids.target,
  deviceLabel: "Target device",
  metadata: { protocolDeploymentId: input.deploymentId },
  createdAt: input.createdAt
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
    "bob-session",
    {
      sessionId: ids.bobSession,
      createdAt: new Date(now - 30_000),
      expiresAt: new Date(now + 60_000),
      user: {
        id: ids.bob,
        email: "bob@example.test",
        displayName: "Bob",
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
  hashSecret?: HighRiskRouteContext["hashSecret"];
}) => {
  const repository: ReturnType<HighRiskRouteContext["requireRepository"]> = {
    createActionGrant: vi.fn(async (input) => ({
      ...binding,
      state:
        input.approvalTier === "direct" ? ("approved" as const) : binding.state,
      approvalTier: input.approvalTier,
      review: input.review
    })),
    getActionGrant: vi.fn(async () => binding),
    awaitActionGrant: vi.fn(async () => binding),
    cancelActionGrant: vi.fn(async () => true),
    getBrowserActivation: vi.fn(async () => binding),
    decideBrowserActivation: vi.fn(async () => ({
      ...binding,
      state: "approved"
    })),
    decideNativeActionReview: vi.fn(async () => ({
      ...binding,
      state: "approved",
      approvalTier: "native_review"
    })),
    listTeams: vi.fn(async () => []),
    listTeamManagementMembers: vi.fn(async () => []),
    getTeamInviteCreationReview: vi.fn(async () => null),
    getTeamInviteAcceptanceReview: vi.fn(async () => ({
      invite: {
        role: "member",
        defaultWorkspaceAccess: "read"
      },
      team: { name: "Koed Team" },
      defaultWorkspace: { name: "Product" },
      effectiveRole: "member"
    })),
    getTeamInviteRevocationReview: vi.fn(async () => ({
      managerRole: "admin",
      team: { id: ids.team, name: "Koed Team" },
      invite: {
        id: ids.target,
        email: "member@example.test",
        role: "member",
        version: 1,
        lifecycle: "pending"
      }
    })),
    getTeamMembershipActionReview: vi.fn(async () => ({
      managerRole: "admin",
      team: { id: ids.team, name: "Koed Team" },
      member: {
        userId: ids.target,
        role: "member",
        status: "enabled",
        version: 1,
        disabledAt: null,
        email: "bob@example.test",
        displayName: "Bob"
      },
      activeOwnerCount: 1
    })),
    getTeamLeaveReview: vi.fn(async () => ({
      team: { id: ids.team, name: "Koed Team" },
      membership: {
        userId: ids.alice,
        role: "member",
        status: "enabled",
        version: 3,
        disabledAt: null
      },
      activeOwnerCount: 1
    })),
    getTeamWorkspaceCreationReview: vi.fn(async () => ({
      managerRole: "admin",
      team: { id: ids.team, name: "Koed Team" }
    })),
    getTeamWorkspaceLifecycleReview: vi.fn(async (_actor, input) => ({
      managerRole: "admin",
      team: { id: ids.team, name: "Koed Team" },
      workspace: {
        id: input.teamWorkspaceId,
        name: "Product",
        version: 1,
        lifecycle: input.lifecycle
      }
    })),
    getTeamWorkspaceAccessUpdateReview: vi.fn(async (_actor, input) => ({
      managerRole: "admin",
      team: { id: ids.team, name: "Koed Team" },
      workspace: {
        id: input.teamWorkspaceId,
        name: "Product",
        version: 1,
        lifecycle: "active"
      },
      member: {
        userId: input.userId,
        email: "bob@example.test",
        displayName: "Bob"
      },
      currentAccess: "write",
      currentAccessVersion: 1
    })),
    getSharedMemoryPreviewAdmission: vi.fn(async (_actor, input) => ({
      source: {
        logicalMemoryId: input.logicalMemoryId,
        title: "Captured Session",
        ownerPrincipalId: ids.alice
      },
      team: { id: input.teamId, name: "Koed Team" },
      workspace: { id: input.teamWorkspaceId, name: "Product" },
      remoteReplicaId: input.remoteReplicaId,
      representation: input.representation,
      requestedAllowedRepresentations: input.allowedRepresentations,
      effectivePolicyIntersection: input.allowedRepresentations,
      sourceOwnerPolicyWillChange: false
    })),
    getSharedMemoryShareReview: vi.fn(async (_actor, input) => ({
      source: {
        logicalMemoryId: input.logicalMemoryId,
        title: "Captured Session",
        ownerPrincipalId: ids.alice
      },
      team: { id: input.teamId, name: "Koed Team" },
      workspace: { id: input.teamWorkspaceId, name: "Product" },
      preview: {
        previewId: input.preview.previewId,
        previewHash: input.preview.previewHash,
        previewRevision: input.previewRevision,
        remoteReplicaId: ids.target,
        representation: input.selectedRepresentation,
        sourceRevision: 1
      },
      effectivePolicyIntersection: input.allowedRepresentations,
      sourceOwnerPolicyWillActivate: false,
      sourceOwnerPolicyWillReplace: false
    })),
    getSharedMemoryRevokeReview: vi.fn(async (_actor, input) => ({
      source: {
        logicalMemoryId: ids.target,
        title: "Captured Session"
      },
      team: { id: input.teamId, name: "Koed Team" },
      workspace: { id: input.teamWorkspaceId, name: "Product" },
      grant: {
        id: input.shareGrantId,
        grantVersion: input.expectedGrantVersion,
        lifecycle: "active" as const,
        activeRepresentation: "lcm_rollups" as const
      }
    })),
    getSharedMemoryRepresentationChangeReview: vi.fn(async (_actor, input) => ({
      source: {
        logicalMemoryId: input.logicalMemoryId,
        title: "Captured Session",
        ownerPrincipalId: ids.alice
      },
      team: { id: input.teamId, name: "Koed Team" },
      workspace: { id: input.teamWorkspaceId, name: "Product" },
      preview: {
        previewId: input.preview.previewId,
        previewHash: input.preview.previewHash,
        previewRevision: input.previewRevision,
        remoteReplicaId: ids.target,
        representation: input.representation,
        sourceRevision: 1
      },
      effectivePolicyIntersection: input.allowedRepresentations,
      sourceOwnerPolicyWillActivate: false,
      sourceOwnerPolicyWillReplace: false,
      grant: {
        id: input.shareGrantId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        grantVersion: input.expectedGrantVersion,
        lifecycle: "active" as const,
        activeRepresentation: "lcm_rollups" as const
      },
      willReactivate: false
    })),
    getManagedConversationExecution: vi.fn(async () => null),
    listDeviceCredentials: vi.fn(async () => []),
    getTeamEntitlementGate: vi.fn(async () => null),
    getTeamBillingSeatState: vi.fn(async () => null),
    getCapturedSessionSummaryByLogicalMemoryId: vi.fn(async () => null),
    listOwnerGrants: vi.fn(async () => ({
      entries: [],
      limit: 100,
      offset: 0,
      hasMore: false
    })),
    readGrantRepresentation: vi.fn(async () => null),
    listTeamInvites: vi.fn(async () => ({
      invites: [],
      nextCursor: null
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
    hashSecret:
      overrides?.hashSecret ??
      ((secret) => createHash("sha256").update(secret).digest("hex")),
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
    }
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
        activationPath: `/high-risk/browser-activations/${binding.selector}`
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

  it("persists Direct actions as approved without review or browser activation", async () => {
    const fixture = await buildServer();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"a".repeat(64)}`,
        intent: { action: "team.create", body: { name: "Koed" } }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(jsonBody(response)).toMatchObject({
      status: {
        approvalTier: "direct",
        review: null,
        state: "approved",
        activationPath: null
      }
    });
    expect(
      (fixture.repository.createActionGrant as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]
    ).toMatchObject({ approvalTier: "direct", review: null });
    await fixture.app.close();
  });

  it("admits Team invitation creation with authoritative manager and Workspace review", async () => {
    const reviewLookup = vi.fn(async () => ({
      managerRole: "admin" as const,
      team: { id: ids.team, name: "Koed Team" },
      defaultWorkspace: {
        id: ids.workspace,
        name: "Product",
        lifecycle: "active" as const
      }
    }));
    const fixture = await buildServer({
      repository: { getTeamInviteCreationReview: reviewLookup }
    });
    const body = {
      defaultTeamWorkspaceId: ids.workspace,
      defaultWorkspaceAccess: "read",
      email: "member@example.test",
      role: "member",
      ttlHours: 72
    };

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"c".repeat(64)}`,
        intent: { action: "team.invite.create", teamId: ids.team, body }
      }
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(jsonBody(response)).toMatchObject({
      status: {
        approvalTier: "native_review",
        state: "review_required",
        activationPath: null,
        review: {
          title: "Invite member@example.test?",
          confirmLabel: "Create invitation",
          details: [
            { label: "Team", value: "Koed Team" },
            { label: "Recipient", value: "member@example.test" },
            { label: "Role", value: "member" },
            { label: "Default Workspace", value: "Product" },
            { label: "Workspace Access", value: "read" },
            { label: "Expires after", value: "72 hours" }
          ]
        }
      }
    });
    expect(reviewLookup).toHaveBeenCalledWith(
      { userId: ids.alice },
      {
        teamId: ids.team,
        defaultTeamWorkspaceId: ids.workspace,
        role: "member"
      }
    );
    expect(fixture.repository.listTeams).not.toHaveBeenCalled();
    expect(fixture.repository.createActionGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        operationFamily: "admin",
        action: "team.invite.create",
        teamId: ids.team,
        targetId: ids.workspace,
        approvalTier: "native_review",
        review: expect.objectContaining({ confirmLabel: "Create invitation" })
      })
    );
    await fixture.app.close();
  });

  it("fails Team invitation creation closed before issuing a grant when context is incomplete", async () => {
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
          action: "team.invite.create",
          teamId: ids.team,
          body: {
            defaultTeamWorkspaceId: ids.workspace,
            defaultWorkspaceAccess: "read",
            email: "member@example.test",
            role: "member",
            ttlHours: 72
          }
        }
      }
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.repository.createActionGrant).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("persists Native review, exposes no browser activation, and binds the native decision", async () => {
    const nativeGrant = {
      ...binding,
      action: "team.invite.accept",
      teamId: null,
      targetId: null,
      approvalTier: "native_review" as const,
      review: {
        version: 1 as const,
        title: "Join this Team?",
        description: "Review the membership granted by this invitation.",
        consequence: "Your User will join the Team.",
        confirmLabel: "Join Team",
        details: []
      }
    };
    const fixture = await buildServer({
      repository: {
        createActionGrant: vi.fn(async (input) => ({
          ...nativeGrant,
          approvalTier: input.approvalTier,
          review: input.review
        })),
        getActionGrant: vi.fn(async () => nativeGrant),
        decideNativeActionReview: vi.fn(async () => ({
          ...nativeGrant,
          state: "approved" as const
        }))
      }
    });
    const clientRequestId = randomUUID();
    const created = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId,
        grantCommitment: `v1:${"b".repeat(64)}`,
        intent: {
          action: "team.invite.accept",
          body: { inviteToken: "kti_validInvitationToken123456" }
        }
      }
    });

    expect(created.statusCode).toBe(201);
    expect(jsonBody(created)).toMatchObject({
      status: {
        approvalTier: "native_review",
        state: "review_required",
        activationPath: null,
        review: { confirmLabel: "Join Team" }
      }
    });

    const decided = await fixture.app.inject({
      method: "POST",
      url: `/v1/high-risk/action-grants/${clientRequestId}/native-decision`,
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: { decision: "approve" }
    });

    expect(decided.statusCode).toBe(200);
    expect(jsonBody(decided)).toMatchObject({
      status: {
        approvalTier: "native_review",
        state: "approved",
        activationPath: null
      }
    });
    expect(
      (fixture.repository.decideNativeActionReview as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0]
    ).toEqual({
      clientRequestId,
      ownerUserId: ids.alice,
      deviceCredentialId: ids.activeDevice,
      upstreamBackendId: "team-vps",
      decision: "approve"
    });
    await fixture.app.close();
  });

  it("uses the configured token pepper for authoritative invitation review details", async () => {
    const inviteToken = "kti_validInvitationToken123456";
    const pepper = "non-empty-test-pepper";
    const expectedHash = createHash("sha256")
      .update(`${pepper}${inviteToken}`)
      .digest("hex");
    const workspaceId = randomUUID();
    const lookup = vi.fn(
      async () =>
        ({
          invite: {
            teamId: ids.team,
            defaultTeamWorkspaceId: workspaceId,
            role: "member" as const,
            defaultWorkspaceAccess: "write" as const
          },
          team: { name: "Koed Engineering" },
          defaultWorkspace: { name: "Platform" },
          effectiveRole: "member" as const
        }) as never
    );
    const fixture = await buildServer({
      hashSecret: (secret) =>
        createHash("sha256").update(`${pepper}${secret}`).digest("hex"),
      repository: { getTeamInviteAcceptanceReview: lookup }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"d".repeat(64)}`,
        intent: {
          action: "team.invite.accept",
          body: { inviteToken }
        }
      }
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(lookup).toHaveBeenCalledWith({ userId: ids.alice }, expectedHash);
    expect(jsonBody(response)).toMatchObject({
      status: {
        review: {
          title: "Join Koed Engineering?",
          details: [
            { label: "Team", value: "Koed Engineering" },
            { label: "Membership", value: "member · write" },
            { label: "Initial Workspace", value: "Platform" }
          ]
        }
      }
    });
    await fixture.app.close();
  });

  it("rejects native decisions for a non-Native grant", async () => {
    const fixture = await buildServer();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/high-risk/action-grants/${binding.id}/native-decision`,
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: { decision: "approve" }
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.repository.decideNativeActionReview).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it.each([
    {
      name: "established target on the running current device",
      executionState: "running",
      runnerDeviceId: "device-1",
      targetAgesMs: [25 * 60 * 60 * 1_000],
      deploymentIds: [randomUUID()],
      expected: "native_review"
    },
    {
      name: "new target device",
      executionState: "running",
      runnerDeviceId: "device-1",
      targetAgesMs: [60 * 60 * 1_000],
      deploymentIds: [randomUUID()],
      expected: "step_up"
    },
    {
      name: "stale execution assignment",
      executionState: "stopped",
      runnerDeviceId: "device-1",
      targetAgesMs: [25 * 60 * 60 * 1_000],
      deploymentIds: [randomUUID()],
      expected: "step_up"
    },
    {
      name: "ambiguous target deployment",
      executionState: "running",
      runnerDeviceId: "device-1",
      targetAgesMs: [25 * 60 * 60 * 1_000, 25 * 60 * 60 * 1_000],
      deploymentIds: [randomUUID(), randomUUID()],
      expected: "step_up"
    }
  ])(
    "classifies a managed transfer with $name as $expected",
    async ({
      executionState,
      runnerDeviceId,
      targetAgesMs,
      deploymentIds,
      expected
    }) => {
      const fixture = await buildServer({
        deviceOperationFamilies: ["managed_execution"],
        repository: {
          getManagedConversationExecution: vi.fn(
            async () =>
              ({
                id: ids.target,
                ownerUserId: ids.alice,
                projectId: randomUUID(),
                provider: "codex",
                state: executionState,
                stateVersion: 1,
                executionGeneration: 1,
                runnerDeploymentId: randomUUID(),
                runnerDeviceId,
                runnerId: "runner-1",
                runnerLeaseExpiresAt: null,
                logicalSessionId: null,
                providerThreadId: null,
                providerCliVersion: null,
                sourceGenerationId: null,
                lastErrorCode: null,
                createdAt: new Date(now - 48 * 60 * 60 * 1_000).toISOString(),
                updatedAt: new Date(now).toISOString(),
                startedAt: new Date(now - 48 * 60 * 60 * 1_000).toISOString(),
                quiescedAt: null,
                stoppedAt: null
              }) as never
          ),
          listDeviceCredentials: vi.fn(async () =>
            targetAgesMs.map((age, index) =>
              managedTargetCredential({
                createdAt: new Date(now - age).toISOString(),
                deploymentId: deploymentIds[index]!
              })
            )
          )
        }
      });
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/high-risk/action-grants",
        headers: { authorization: "Koed-Device device-key:secret" },
        payload: {
          version: 1,
          clientRequestId: randomUUID(),
          grantCommitment: `v1:${"e".repeat(64)}`,
          intent: {
            action: "managed_conversation.handoff",
            executionId: ids.target,
            body: {
              operationId: randomUUID(),
              targetDeviceId: ids.target
            }
          }
        }
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(
        (fixture.repository.createActionGrant as ReturnType<typeof vi.fn>).mock
          .calls[0]?.[0]
      ).toMatchObject({ approvalTier: expected });
      await fixture.app.close();
    }
  );

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

  it("uses an authoritative Captured Session title while retaining the exact logical Memory binding", async () => {
    const logicalMemoryId = randomUUID();
    const fixture = await buildServer({
      deviceOperationFamilies: ["share_grant_management"],
      repository: {
        getSharedMemoryShareReview: vi.fn(async (_actor, input) => ({
          source: {
            logicalMemoryId,
            title: "Quarterly planning with Platform",
            ownerPrincipalId: ids.alice
          },
          team: { id: input.teamId, name: "Koed Team" },
          workspace: { id: input.teamWorkspaceId, name: "Product" },
          preview: {
            previewId: input.preview.previewId,
            previewHash: input.preview.previewHash,
            previewRevision: input.previewRevision,
            remoteReplicaId: ids.target,
            representation: input.selectedRepresentation,
            sourceRevision: 1
          },
          effectivePolicyIntersection: input.allowedRepresentations,
          sourceOwnerPolicyWillActivate: false,
          sourceOwnerPolicyWillReplace: false
        }))
      }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/high-risk/action-grants",
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: `v1:${"a".repeat(64)}`,
        intent: {
          action: "shared_memory.share",
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          logicalMemoryId,
          teamId: ids.team,
          teamWorkspaceId: randomUUID(),
          consentId: randomUUID(),
          previewId: randomUUID(),
          mode: "snapshot",
          allowedRepresentations: ["lcm_rollups"],
          selectedRepresentation: "lcm_rollups",
          previewRevision: 1,
          previewHash: "b".repeat(64),
          expiresAt: null
        }
      }
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(jsonBody(response)).toMatchObject({
      status: {
        approvalTier: "native_review",
        review: {
          details: expect.arrayContaining([
            {
              label: "Personal Memory",
              value: "Quarterly planning with Platform"
            },
            { label: "Logical Memory", value: logicalMemoryId }
          ])
        }
      }
    });
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

  it("keeps the JSON endpoint authenticated even for HTML accept headers", async () => {
    const fixture = await buildServer();

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

    expect(browserNavigation.statusCode).toBe(401);
    expect(programmaticRequest.statusCode).toBe(401);
    expect(fixture.repository.getBrowserActivation).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it.each([
    ["missing credentials", {}, 401],
    ["an API Token", { authorization: "Bearer api-token" }, 403],
    [
      "a device credential",
      { authorization: "Koed-Device device-key:secret" },
      403
    ]
  ])(
    "rejects activation decisions authenticated with %s",
    async (_label, headers, expectedStatus) => {
      const fixture = await buildServer();

      const response = await fixture.app.inject({
        method: "POST",
        url: `/v1/high-risk/browser-activations/${binding.selector}/decision`,
        headers,
        payload: { decision: "approve" }
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(fixture.repository.decideBrowserActivation).not.toHaveBeenCalled();
      await fixture.app.close();
    }
  );

  it("does not let another User inspect or decide an activation", async () => {
    const getBrowserActivation = vi.fn(
      async (input: { ownerUserId: string }) =>
        input.ownerUserId === ids.alice ? binding : null
    );
    const decideBrowserActivation = vi.fn(
      async (input: { ownerUserId: string }) =>
        input.ownerUserId === ids.alice
          ? { ...binding, state: "approved" as const }
          : null
    );
    const fixture = await buildServer({
      repository: { getBrowserActivation, decideBrowserActivation }
    });

    const inspected = await fixture.app.inject({
      method: "GET",
      url: `/v1/high-risk/browser-activations/${binding.selector}`,
      headers: { cookie: "cm_session=bob-session" }
    });
    const decided = await fixture.app.inject({
      method: "POST",
      url: `/v1/high-risk/browser-activations/${binding.selector}/decision`,
      headers: { cookie: "cm_session=bob-session" },
      payload: { decision: "approve" }
    });

    expect(inspected.statusCode).toBe(403);
    expect(decided.statusCode).toBe(403);
    expect(getBrowserActivation).toHaveBeenCalledWith({
      selector: binding.selector,
      ownerUserId: ids.bob
    });
    expect(decideBrowserActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: binding.selector,
        ownerUserId: ids.bob,
        userSessionId: ids.bobSession
      })
    );
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

  it("requires a fresh browser session before showing or deciding an activation", async () => {
    const fixture = await buildServer();

    const staleInspection = await fixture.app.inject({
      method: "GET",
      url: `/v1/high-risk/browser-activations/${binding.selector}`,
      headers: { cookie: "cm_session=stale-session" }
    });
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

    expect(staleInspection.statusCode).toBe(403);
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

  it("lets a matching freshly authenticated User decide exactly once", async () => {
    const decideBrowserActivation = vi
      .fn()
      .mockResolvedValueOnce({ ...binding, state: "denied" as const })
      .mockResolvedValueOnce(null);
    const fixture = await buildServer({
      repository: { decideBrowserActivation }
    });

    const first = await fixture.app.inject({
      method: "POST",
      url: `/v1/high-risk/browser-activations/${binding.selector}/decision`,
      headers: { cookie: "cm_session=alice-session" },
      payload: { decision: "deny" }
    });
    const replay = await fixture.app.inject({
      method: "POST",
      url: `/v1/high-risk/browser-activations/${binding.selector}/decision`,
      headers: { cookie: "cm_session=alice-session" },
      payload: { decision: "approve" }
    });

    expect(first.statusCode).toBe(200);
    expect(jsonBody<{ status: { state: string } }>(first).status.state).toBe(
      "denied"
    );
    expect(replay.statusCode).toBe(403);
    expect(decideBrowserActivation).toHaveBeenCalledTimes(2);
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
