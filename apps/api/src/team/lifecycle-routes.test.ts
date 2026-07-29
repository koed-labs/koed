import type {
  DeviceCredentialAuthContext,
  MemorySourceRepository,
  TeamMembershipRecord,
  TeamRecord,
  TeamWorkspaceRecord,
  UserRecord
} from "@koed/db";
import Fastify, { type FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CollaborationRateLimitError,
  type CollaborationAdmissionController
} from "../collaboration/admission.js";
import type { ApiRouteContext } from "../server/context.js";
import { registerTeamRoutes } from "./routes.js";

const user: UserRecord = {
  id: randomUUID(),
  email: "owner@example.test",
  displayName: "Owner",
  passwordHash: null
};

const teamId = randomUUID();
const workspaceId = randomUUID();
const membershipId = randomUUID();
const deploymentId = randomUUID();

const now = () => new Date().toISOString();

const team = (overrides: Partial<TeamRecord> = {}): TeamRecord => ({
  id: teamId,
  name: "Lifecycle Team",
  version: 1,
  lifecycle: "active",
  entitlementStatus: "active",
  entitlementReason: null,
  entitlementUpdatedAt: null,
  createdAt: now(),
  updatedAt: now(),
  suspendedAt: null,
  deletionRequestedAt: null,
  tombstonedAt: null,
  retainUntil: null,
  purgeCompletedAt: null,
  ...overrides
});

const workspace = (): TeamWorkspaceRecord => ({
  id: workspaceId,
  teamId,
  name: "General",
  description: null,
  version: 1,
  lifecycle: "active",
  createdAt: now(),
  updatedAt: now(),
  archivedAt: null,
  retentionPolicyId: null,
  retentionPolicyVersion: null,
  retainUntil: null,
  purgeCompletedAt: null
});

const membership = (): TeamMembershipRecord => ({
  id: membershipId,
  teamId,
  userId: user.id,
  role: "owner",
  status: "enabled",
  version: 1,
  createdAt: now(),
  updatedAt: now(),
  acceptedAt: now(),
  disabledAt: null
});

const pendingInvite = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  teamId,
  defaultTeamWorkspaceId: workspaceId,
  defaultWorkspaceAccess: "write" as const,
  email: user.email,
  normalizedEmail: user.email,
  backendOriginHash: "stored-origin-hash",
  role: "member" as const,
  version: 3,
  lifecycle: "pending" as const,
  createdByUserId: randomUUID(),
  acceptedByUserId: null,
  createdAt: now(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  acceptedAt: null,
  revokedAt: null,
  ...overrides
});

const deviceAuth = (): DeviceCredentialAuthContext => ({
  user,
  credential: {
    id: randomUUID(),
    ownerUserId: user.id,
    enrollmentChallengeId: null,
    credentialKeyId: "device-key",
    upstreamBackendId: "backend-1",
    deviceInstanceId: "device-1",
    lineageId: randomUUID(),
    deviceLabel: "Test device",
    credentialVersion: 1,
    verifierKind: "secret_hash",
    operationFamilies: ["action_grant", "team_workspace_read"],
    metadata: {},
    createdAt: now(),
    updatedAt: now(),
    lastUsedAt: null,
    lastValidatedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revocationReason: null
  }
});

const createFixture = async (input?: {
  sessionCreatedAt?: Date;
  deploymentProfile?: ApiRouteContext["config"]["deploymentProfile"];
  workosAuthKitEnabled?: boolean;
  workosProviderEnvironment?: string;
  deviceOperationFamilies?: string[];
  deviceCredentialError?: Error & { statusCode?: number };
  repository?: Record<string, unknown>;
  admitInviteCreation?: CollaborationAdmissionController["admitInviteCreation"];
}) => {
  const access = {
    teamWorkspaceId: workspaceId,
    teamId,
    userId: user.id,
    role: "owner" as const,
    membershipStatus: "enabled" as const,
    access: "write" as const,
    canShareOwnedMemory: true,
    version: 1,
    teamEntitlementStatus: "active" as const,
    teamEntitlementAllowsAccess: true,
    canManageTeam: true,
    canManageWorkspace: true,
    canRecall: true,
    canCreateShare: true
  };
  const repository = {
    listTeams: vi.fn(async () => [team()]),
    createTeam: vi.fn(async () => team()),
    getTeamDefaultWorkspace: vi.fn(async () => workspace()),
    listTeamWorkspaces: vi.fn(async () => [workspace()]),
    getTeamMembership: vi.fn(async () => membership()),
    listTeamRoster: vi.fn(async () => [
      {
        userId: user.id,
        displayName: user.displayName,
        avatarReference: null,
        status: "enabled" as const,
        presence: "unknown" as const
      }
    ]),
    listTeamManagementMembers: vi.fn(async () => []),
    listTeamWorkspaceContexts: vi.fn(async () => []),
    updateTeamMemberRole: vi.fn(async () => membership()),
    disableTeamMember: vi.fn(async () => membership()),
    leaveTeam: vi.fn(async () => membership()),
    listTeamInvites: vi.fn(async () => ({
      invites: [],
      nextCursor: null
    })),
    createTeamInvite: vi.fn(async () => pendingInvite()),
    revokeTeamInvite: vi.fn(async () => ({
      ...pendingInvite(),
      lifecycle: "revoked" as const
    })),
    getPendingTeamInviteByTokenHash: vi.fn(async () => pendingInvite()),
    acceptTeamInvite: vi.fn(async () => ({
      invite: { ...pendingInvite(), lifecycle: "accepted" as const },
      membership: membership(),
      user,
      createdUser: false
    })),
    getVerifiedExternalAuthIdentityForUser: vi.fn(async () => null),
    listTeamAuditEvents: vi.fn(async () => []),
    getTeamEntitlementGate: vi.fn(async () => ({
      teamId,
      version: 1,
      status: "active",
      allowsTeamAccess: true,
      deniedOperationFamilies: [],
      reason: null,
      updatedAt: null
    })),
    setTeamEntitlementState: vi.fn(async () => ({
      teamId,
      version: 2,
      status: "active",
      allowsTeamAccess: true,
      deniedOperationFamilies: [],
      reason: null,
      updatedAt: now()
    })),
    getTeamBillingSeatState: vi.fn(async () => ({ teamId, version: 1 })),
    setTeamBillingSeatPolicy: vi.fn(async () => ({ teamId, version: 2 })),
    getTeamSupportOverview: vi.fn(async () => ({ team: team() })),
    createTeamWorkspace: vi.fn(async () => workspace()),
    getTeamWorkspaceContext: vi.fn(async () => ({
      team: team(),
      teamWorkspace: workspace(),
      access
    })),
    getTeamWorkspaceAccess: vi.fn(async () => access),
    getAuthorizedSnapshot: vi.fn(async () => ({
      scope: "team" as const,
      personalOwnerUserId: null,
      teamId,
      highWaterCursor: 0,
      threads: []
    })),
    listWorkspaceGrants: vi.fn(async () => ({
      entries: [],
      limit: 100,
      offset: 0,
      hasMore: false
    })),
    archiveTeamWorkspace: vi.fn(async () => ({
      ...workspace(),
      lifecycle: "archived" as const,
      archivedAt: now(),
      version: 2
    })),
    restoreTeamWorkspace: vi.fn(async () => workspace()),
    setTeamWorkspaceAccess: vi.fn(async () => access),
    ensureLocalSyncDeployment: vi.fn(async () => ({
      protocolDeploymentId: deploymentId
    })),
    ...input?.repository
  } as unknown as MemorySourceRepository;
  if (!("executeActionGrant" in repository)) {
    (repository as MemorySourceRepository).executeActionGrant = vi.fn(
      async (grantInput: {
        execute: (repositories: {
          team: MemorySourceRepository;
        }) => Promise<unknown>;
      }) =>
        grantInput.execute({
          team: repository as MemorySourceRepository
        } as never)
    ) as unknown as MemorySourceRepository["executeActionGrant"];
  }
  const auth = deviceAuth();
  auth.credential.operationFamilies = input?.deviceOperationFamilies ?? [
    "action_grant",
    "team_workspace_read"
  ];
  const app = Fastify();
  const context = {
    config: {
      deploymentProfile: input?.deploymentProfile ?? "developer",
      collaborationRealtime: {
        cursorSecret: "test-team-invitation-cursor-secret"
      },
      workos: {
        authkitEnabled: input?.workosAuthKitEnabled ?? false,
        providerEnvironment: input?.workosProviderEnvironment ?? "default"
      }
    },
    requireRepository: () => repository,
    auth: {
      hashSecret: (value: string) => value,
      authenticateSession: vi.fn(async () => user),
      authenticateSessionContext: vi.fn(async (request: FastifyRequest) => {
        if (/^Koed-Device(?:\s|$)/i.test(request.headers.authorization ?? "")) {
          throw Object.assign(new Error("Session cookie required"), {
            statusCode: 401
          });
        }
        return {
          sessionId: randomUUID(),
          createdAt: input?.sessionCreatedAt ?? new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          user
        };
      }),
      authenticateDeviceCredential: vi.fn(async () => {
        if (input?.deviceCredentialError) throw input.deviceCredentialError;
        return auth;
      }),
      authenticateSessionOrDeviceCredential: vi.fn(
        async (request: FastifyRequest, operationFamily: string) => {
          if (
            /^Koed-Device(?:\s|$)/i.test(request.headers.authorization ?? "")
          ) {
            if (input?.deviceCredentialError) {
              throw input.deviceCredentialError;
            }
            if (!auth.credential.operationFamilies.includes(operationFamily)) {
              throw Object.assign(
                new Error("Device credential is not allowed"),
                { statusCode: 403 }
              );
            }
          }
          return user;
        }
      )
    },
    rateLimit: {
      auth: async () => undefined,
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    collaboration: {
      admission: {
        admitMessage: async () => [],
        admitChannelCreation: async () => [],
        admitInviteCreation: input?.admitInviteCreation ?? (async () => []),
        admitConnectionFailure: async () => []
      }
    },
    deploymentIdentity: {
      inspect: () => ({
        health: "healthy",
        deploymentId,
        deviceInstanceId: randomUUID(),
        remoteOperationsAllowed: true,
        message: "Test deployment identity is verified.",
        platformProtection: "verified"
      })
    }
  } as unknown as ApiRouteContext;
  registerTeamRoutes(app, context);
  await app.ready();
  return { app, auth, repository };
};

describe("Team lifecycle routes", () => {
  it("returns one authorized Team navigation snapshot", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/teams/navigation"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { id: user.id },
      teams: [
        {
          team: { id: teamId },
          membership: {
            teamId,
            userId: user.id,
            status: "enabled"
          },
          members: [{ userId: user.id }],
          highWaterCursor: 0,
          workspaces: [
            {
              teamWorkspace: { id: workspaceId },
              access: { userId: user.id, access: "write" },
              shareGrants: []
            }
          ]
        }
      ]
    });
    await fixture.app.close();
  });

  it("requires both Team Workspace and Team Chat read scopes for aggregate navigation", async () => {
    const fixture = await createFixture({
      deviceOperationFamilies: ["team_workspace_read"]
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/teams/navigation",
      headers: { authorization: "Koed-Device device-key:secret" }
    });

    expect(response.statusCode).toBe(403);
    await fixture.app.close();
  });

  it("returns opaque, actor-and-filter-bound invitation continuations", async () => {
    const firstInvite = {
      id: randomUUID(),
      teamId: teamId,
      createdAt: new Date().toISOString()
    };
    const secondInvite = {
      id: randomUUID(),
      teamId: teamId,
      createdAt: new Date(Date.now() - 1_000).toISOString()
    };
    const listTeamInvites = vi
      .fn()
      .mockResolvedValueOnce({
        invites: [firstInvite],
        nextCursor: { createdAt: firstInvite.createdAt, id: firstInvite.id }
      })
      .mockResolvedValueOnce({ invites: [secondInvite], nextCursor: null });
    const fixture = await createFixture({ repository: { listTeamInvites } });

    const first = await fixture.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/invites?includeRevoked=false&limit=1`
    });
    const firstBody = first.json<{
      invites: unknown[];
      nextCursor: string | null;
    }>();
    expect(first.statusCode).toBe(200);
    expect(firstBody.nextCursor).toMatch(/^ktic1\./);
    expect(firstBody.nextCursor).not.toContain(firstInvite.id);

    const second = await fixture.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/invites?includeRevoked=false&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      invites: [{ id: secondInvite.id }],
      nextCursor: null
    });
    expect(listTeamInvites.mock.calls[1]?.[1]).toMatchObject({
      cursor: { createdAt: firstInvite.createdAt, id: firstInvite.id }
    });

    const replay = await fixture.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/invites?includeRevoked=true&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    });
    expect(replay.statusCode).toBe(403);
    expect(listTeamInvites).toHaveBeenCalledTimes(2);

    await fixture.app.close();
  });
  it("uses fresh server-side session context for Team administration", async () => {
    const createTeam = vi.fn(async () => team());
    const fixture = await createFixture({
      sessionCreatedAt: new Date(Date.now() - 10 * 60 * 1000),
      repository: { createTeam }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/teams",
      payload: { name: "Stale Session Team" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(createTeam).not.toHaveBeenCalled();
  });

  it("re-checks current verified identity for browser and device Team administration", async () => {
    const createTeam = vi.fn(async () => team());
    const getVerifiedExternalAuthIdentityForUser = vi.fn(async () => null);
    const browser = await createFixture({
      deploymentProfile: "team_self_hosted",
      workosAuthKitEnabled: true,
      repository: { createTeam, getVerifiedExternalAuthIdentityForUser }
    });
    const browserResponse = await browser.app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: { "idempotency-key": randomUUID() },
      payload: { name: "Browser Team" }
    });
    await browser.app.close();

    const device = await createFixture({
      deploymentProfile: "team_self_hosted",
      workosAuthKitEnabled: true,
      repository: { createTeam, getVerifiedExternalAuthIdentityForUser }
    });
    const deviceResponse = await device.app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: {
        authorization: "Koed-Device device-key:secret",
        "x-koed-action-grant": "hrg_team_create",
        "idempotency-key": randomUUID()
      },
      payload: { name: "Device Team" }
    });
    await device.app.close();

    expect(browserResponse.statusCode).toBe(403);
    expect(deviceResponse.statusCode).toBe(403);
    expect(getVerifiedExternalAuthIdentityForUser).toHaveBeenCalledTimes(2);
    expect(createTeam).not.toHaveBeenCalled();
  });

  it("binds device administration to the exact admin action and still applies dynamic role authorization", async () => {
    const updateTeamMemberRole = vi.fn(async () => null);
    const executeActionGrant = vi.fn(
      async (input: {
        operationFamily: string;
        action: string;
        teamId: string | null;
        targetId: string | null;
        scopeHash: string;
        requestHash: string;
        execute: (repositories: {
          team: MemorySourceRepository;
          sync: MemorySourceRepository;
          externalAuth: MemorySourceRepository;
        }) => Promise<unknown>;
      }) =>
        input.execute({
          team: fixture.repository,
          sync: fixture.repository,
          externalAuth: fixture.repository
        })
    );
    const fixture = await createFixture({
      repository: { executeActionGrant, updateTeamMemberRole }
    });
    const targetUserId = randomUUID();
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/v1/teams/${teamId}/members/${targetUserId}/role`,
      headers: {
        authorization: "Koed-Device device-key:secret",
        "x-koed-action-grant": "hrg_role_update"
      },
      payload: { role: "admin", expectedVersion: 1 }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(executeActionGrant).toHaveBeenCalledTimes(1);
    expect(executeActionGrant.mock.calls[0]?.[0]).toMatchObject({
      operationFamily: "admin",
      action: "team.member.role_update",
      teamId,
      targetId: targetUserId,
      scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(executeActionGrant.mock.calls[0]?.[0].operationFamily).not.toContain(
      "*"
    );
    expect(updateTeamMemberRole).toHaveBeenCalledWith(
      { userId: user.id },
      {
        teamId,
        userId: targetUserId,
        role: "admin",
        expectedVersion: 1
      }
    );
  });

  it("keeps ordinary roster fields bounded and management metadata separate", async () => {
    const rosterMember = {
      userId: randomUUID(),
      displayName: "Visible Member",
      avatarReference: "avatar_123",
      status: "enabled" as const,
      presence: "unknown" as const
    };
    const managementMember = {
      ...membership(),
      email: "sensitive@example.test",
      displayName: "Visible Member",
      workspaceAccess: []
    };
    const fixture = await createFixture({
      repository: {
        listTeamRoster: vi.fn(async () => [rosterMember]),
        listTeamManagementMembers: vi.fn(async () => [managementMember])
      }
    });

    const roster = await fixture.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/members`
    });
    const management = await fixture.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/members/manage`
    });
    await fixture.app.close();

    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toEqual({ members: [rosterMember] });
    expect(
      Object.keys(roster.json<{ members: object[] }>().members[0]!)
    ).toEqual([
      "userId",
      "displayName",
      "avatarReference",
      "status",
      "presence"
    ]);
    expect(JSON.stringify(roster.json())).not.toMatch(
      /email|provider|device|disabledAt|role|version/
    );
    expect(management.statusCode).toBe(200);
    expect(management.json()).toMatchObject({
      members: [{ email: "sensitive@example.test", role: "owner" }]
    });
  });

  it("denies Personal API Tokens and exposes no raw member upsert route", async () => {
    const fixture = await createFixture();
    const tokenResponse = await fixture.app.inject({
      method: "GET",
      url: "/v1/teams",
      headers: { authorization: "Bearer personal-token" }
    });
    const upsertResponse = await fixture.app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/members`,
      payload: { userId: randomUUID(), role: "admin", status: "enabled" }
    });
    await fixture.app.close();

    expect(tokenResponse.statusCode).toBe(403);
    expect(upsertResponse.statusCode).toBe(404);
  });

  it("rejects Personal API Tokens before validating Team lifecycle payloads", async () => {
    const leaveTeam = vi.fn();
    const getPendingTeamInviteByTokenHash = vi.fn();
    const fixture = await createFixture({
      repository: { leaveTeam, getPendingTeamInviteByTokenHash }
    });

    const [leaveResponse, acceptResponse] = await Promise.all([
      fixture.app.inject({
        method: "POST",
        url: `/v1/teams/${teamId}/leave`,
        headers: { authorization: "Bearer personal-token" },
        payload: {}
      }),
      fixture.app.inject({
        method: "POST",
        url: "/v1/team-invites/accept",
        headers: { authorization: "Bearer personal-token" },
        payload: {}
      })
    ]);
    await fixture.app.close();

    expect(leaveResponse.statusCode).toBe(403);
    expect(acceptResponse.statusCode).toBe(403);
    expect(leaveTeam).not.toHaveBeenCalled();
    expect(getPendingTeamInviteByTokenHash).not.toHaveBeenCalled();
  });

  it("exercises every Team route across the browser/device credential matrix", async () => {
    type Probe = {
      label: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
      payload?: object;
      headers?: Record<string, string>;
      device: "read" | "admin" | "admin_read" | "browser_only";
    };
    const targetUserId = randomUUID();
    const inviteId = randomUUID();
    const probes: Probe[] = [
      { label: "Team list", method: "GET", url: "/v1/teams", device: "read" },
      {
        label: "Team context",
        method: "GET",
        url: "/v1/team-context",
        device: "read"
      },
      {
        label: "Team creation",
        method: "POST",
        url: "/v1/teams",
        payload: { name: "Matrix Team" },
        headers: { "idempotency-key": randomUUID() },
        device: "admin"
      },
      {
        label: "membership",
        method: "GET",
        url: `/v1/teams/${teamId}/membership`,
        device: "read"
      },
      {
        label: "roster",
        method: "GET",
        url: `/v1/teams/${teamId}/members`,
        device: "read"
      },
      {
        label: "management members",
        method: "GET",
        url: `/v1/teams/${teamId}/members/manage`,
        device: "read"
      },
      {
        label: "role update",
        method: "PATCH",
        url: `/v1/teams/${teamId}/members/${targetUserId}/role`,
        payload: { role: "admin", expectedVersion: 1 },
        device: "admin"
      },
      {
        label: "member disable",
        method: "POST",
        url: `/v1/teams/${teamId}/members/${targetUserId}/disable`,
        payload: { expectedVersion: 1 },
        device: "admin"
      },
      {
        label: "leave",
        method: "POST",
        url: `/v1/teams/${teamId}/leave`,
        payload: { expectedVersion: 1 },
        device: "browser_only"
      },
      {
        label: "invite list",
        method: "GET",
        url: `/v1/teams/${teamId}/invites`,
        device: "read"
      },
      {
        label: "invite creation",
        method: "POST",
        url: `/v1/teams/${teamId}/invites`,
        payload: {
          email: user.email,
          role: "member",
          defaultTeamWorkspaceId: workspaceId,
          defaultWorkspaceAccess: "write",
          ttlHours: 24
        },
        device: "admin"
      },
      {
        label: "invite revocation",
        method: "DELETE",
        url: `/v1/teams/${teamId}/invites/${inviteId}`,
        payload: { expectedVersion: 1 },
        device: "admin"
      },
      {
        label: "invite acceptance",
        method: "POST",
        url: "/v1/team-invites/accept",
        payload: { inviteToken: "matrix-invite" },
        device: "admin"
      },
      {
        label: "audit events",
        method: "GET",
        url: `/v1/teams/${teamId}/audit-events`,
        device: "read"
      },
      {
        label: "entitlement read",
        method: "GET",
        url: `/v1/teams/${teamId}/entitlement`,
        device: "read"
      },
      {
        label: "entitlement update",
        method: "PUT",
        url: `/v1/teams/${teamId}/entitlement`,
        payload: { expectedVersion: 1, status: "active" },
        device: "admin"
      },
      {
        label: "billing seats",
        method: "GET",
        url: `/v1/teams/${teamId}/billing-seats`,
        device: "read"
      },
      {
        label: "support overview",
        method: "GET",
        url: `/v1/teams/${teamId}/support/overview`,
        device: "read"
      },
      {
        label: "billing policy",
        method: "PUT",
        url: `/v1/teams/${teamId}/billing-seats/policy`,
        payload: { expectedVersion: 1, seatLimit: 10 },
        device: "admin"
      },
      {
        label: "Workspace list",
        method: "GET",
        url: `/v1/teams/${teamId}/workspaces`,
        device: "read"
      },
      {
        label: "nested Workspace creation",
        method: "POST",
        url: `/v1/teams/${teamId}/workspaces`,
        payload: { name: "Nested Workspace" },
        device: "admin"
      },
      {
        label: "Workspace creation",
        method: "POST",
        url: "/v1/team-workspaces",
        payload: { teamId, name: "Workspace" },
        device: "admin"
      },
      {
        label: "Workspace context",
        method: "GET",
        url: `/v1/team-workspaces/${workspaceId}/context`,
        device: "read"
      },
      {
        label: "Workspace access read",
        method: "GET",
        url: `/v1/team-workspaces/${workspaceId}/access`,
        device: "read"
      },
      {
        label: "Workspace archive",
        method: "POST",
        url: `/v1/team-workspaces/${workspaceId}/archive`,
        payload: { expectedVersion: 1 },
        device: "admin_read"
      },
      {
        label: "Workspace restore",
        method: "POST",
        url: `/v1/team-workspaces/${workspaceId}/restore`,
        payload: { expectedVersion: 1 },
        device: "admin_read"
      },
      {
        label: "Workspace access update",
        method: "PUT",
        url: `/v1/team-workspaces/${workspaceId}/access`,
        payload: {
          userId: targetUserId,
          access: "read",
          expectedVersion: 1
        },
        device: "admin_read"
      }
    ];
    const request = (probe: Probe, headers: Record<string, string> = {}) => ({
      method: probe.method,
      url: probe.url,
      headers: { ...probe.headers, ...headers },
      ...(probe.payload ? { payload: probe.payload } : {})
    });

    const browser = await createFixture();
    for (const probe of probes) {
      const response = await browser.app.inject(request(probe));
      expect(response.statusCode, `browser: ${probe.label}`).toBe(200);
    }
    await browser.app.close();

    const scopedDevice = await createFixture();
    for (const probe of probes) {
      const response = await scopedDevice.app.inject(
        request(probe, {
          authorization: "Koed-Device device-key:secret",
          ...(probe.device === "admin" || probe.device === "admin_read"
            ? { "x-koed-action-grant": `hrg_${probe.label}` }
            : {})
        })
      );
      expect(response.statusCode, `scoped device: ${probe.label}`).toBe(
        probe.device === "browser_only" ? 401 : 200
      );
    }
    await scopedDevice.app.close();

    const wrongScope = await createFixture({ deviceOperationFamilies: [] });
    for (const probe of probes) {
      const response = await wrongScope.app.inject(
        request(probe, {
          authorization: "Koed-Device device-key:secret",
          "x-koed-action-grant": `hrg_wrong_${probe.label}`
        })
      );
      expect(response.statusCode, `wrong-scope device: ${probe.label}`).toBe(
        probe.device === "browser_only" ? 401 : 403
      );
    }
    await wrongScope.app.close();

    const apiToken = await createFixture();
    for (const probe of probes) {
      const response = await apiToken.app.inject(
        request(probe, { authorization: "Bearer personal-token" })
      );
      expect(response.statusCode, `Personal API Token: ${probe.label}`).toBe(
        403
      );
    }
    await apiToken.app.close();

    for (const state of ["expired", "revoked"] as const) {
      const credentialError = Object.assign(
        new Error(`${state} device credential`),
        { statusCode: 401 }
      );
      const fixture = await createFixture({
        deviceCredentialError: credentialError
      });
      for (const probe of probes) {
        const response = await fixture.app.inject(
          request(probe, {
            authorization: "Koed-Device device-key:secret",
            "x-koed-action-grant": `hrg_${state}_${probe.label}`
          })
        );
        expect(response.statusCode, `${state} device: ${probe.label}`).toBe(
          401
        );
      }
      await fixture.app.close();
    }
  });

  it("does not register the legacy Team deletion route", async () => {
    const executeActionGrant = vi.fn();
    const fixture = await createFixture({
      repository: { executeActionGrant }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/deletion-request`,
      headers: {
        authorization: "Koed-Device device-key:secret",
        "x-koed-action-grant": "hrg_legacy"
      },
      payload: {
        expectedVersion: 1,
        retainUntil: "2099-01-01T00:00:00.000Z"
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(404);
    expect(executeActionGrant).not.toHaveBeenCalled();
  });

  it("does not expose Team archive or Workspace delete routes", async () => {
    const executeActionGrant = vi.fn();
    const fixture = await createFixture({ repository: { executeActionGrant } });
    const unsupported = [
      { method: "POST" as const, url: `/v1/teams/${teamId}/archive` },
      { method: "PATCH" as const, url: `/v1/teams/${teamId}/archive` },
      { method: "DELETE" as const, url: `/v1/teams/${teamId}` },
      { method: "DELETE" as const, url: `/v1/team-workspaces/${workspaceId}` },
      {
        method: "DELETE" as const,
        url: `/v1/teams/${teamId}/workspaces/${workspaceId}`
      }
    ];

    for (const request of unsupported) {
      const response = await fixture.app.inject({
        ...request,
        headers: {
          authorization: "Koed-Device device-key:secret",
          "x-koed-action-grant": "hrg_unsupported"
        }
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
    await fixture.app.close();

    expect(executeActionGrant).not.toHaveBeenCalled();
  });

  it("enforces invite admission before creating an invitation", async () => {
    const createTeamInvite = vi.fn();
    const admitInviteCreation = vi.fn(async () => {
      throw new CollaborationRateLimitError({
        policy: "inviteCreate",
        limit: 10,
        remaining: 0,
        resetAt: Date.now() + 60_000
      });
    });
    const fixture = await createFixture({
      admitInviteCreation,
      repository: { createTeamInvite }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/invites`,
      payload: {
        email: "invitee@example.test",
        role: "member",
        defaultTeamWorkspaceId: workspaceId,
        defaultWorkspaceAccess: "write",
        ttlHours: 24
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(429);
    expect(response.headers["x-ratelimit-policy"]).toBe("inviteCreate");
    expect(admitInviteCreation).toHaveBeenCalledWith({
      userId: user.id,
      teamId
    });
    expect(createTeamInvite).not.toHaveBeenCalled();
  });

  it("surfaces the last-owner guard without disabling the owner", async () => {
    const leaveTeam = vi.fn(async () => null);
    const fixture = await createFixture({ repository: { leaveTeam } });

    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/leave`,
      payload: { expectedVersion: 1 }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(leaveTeam).toHaveBeenCalledWith(
      { userId: user.id },
      { teamId, expectedVersion: 1 }
    );
  });

  it("requires a matching verified WorkOS identity and current backend origin in managed cloud", async () => {
    const deploymentId = randomUUID();
    const invite = pendingInvite();
    const acceptTeamInvite = vi.fn(async () => ({
      invite: { ...invite, lifecycle: "accepted" as const },
      membership: membership(),
      user,
      createdUser: false
    }));
    const repository = {
      getPendingTeamInviteByTokenHash: vi.fn(async () => invite),
      getVerifiedExternalAuthIdentityForUser: vi.fn(async () => ({
        id: randomUUID(),
        provider: "workos_authkit" as const,
        providerEnvironment: "default",
        providerUserId: "provider-user",
        userId: user.id,
        email: user.email,
        emailVerified: true,
        displayName: user.displayName,
        status: "linked" as const,
        profile: {},
        createdAt: now(),
        updatedAt: now(),
        lastSeenAt: now()
      })),
      ensureLocalSyncDeployment: vi.fn(async () => ({
        protocolDeploymentId: deploymentId
      })),
      acceptTeamInvite
    };
    const fixture = await createFixture({
      deploymentProfile: "koed_managed_cloud",
      workosAuthKitEnabled: true,
      repository
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "invite-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(acceptTeamInvite).toHaveBeenCalledWith({
      tokenHash: "invite-token",
      userId: user.id,
      expectedVersion: 3,
      expectedBackendOriginHash: createHash("sha256")
        .update(`koed:backend-origin:v1\n${deploymentId}`)
        .digest("hex")
    });
  });

  it("rejects unverified local-simple invite admission outside the developer profile", async () => {
    const acceptTeamInvite = vi.fn();
    const getVerifiedExternalAuthIdentityForUser = vi.fn();
    const fixture = await createFixture({
      deploymentProfile: "team_self_hosted",
      repository: {
        getPendingTeamInviteByTokenHash: vi.fn(async () => pendingInvite()),
        getVerifiedExternalAuthIdentityForUser,
        acceptTeamInvite
      }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "invite-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(getVerifiedExternalAuthIdentityForUser).not.toHaveBeenCalled();
    expect(acceptTeamInvite).not.toHaveBeenCalled();
  });

  it("accepts a Team Self-Hosted invite with a current verified WorkOS identity", async () => {
    const invite = pendingInvite();
    const acceptTeamInvite = vi.fn(async () => ({
      invite: { ...invite, lifecycle: "accepted" as const },
      membership: membership(),
      user,
      createdUser: false
    }));
    const getVerifiedExternalAuthIdentityForUser = vi.fn(async () => ({
      id: randomUUID(),
      provider: "workos_authkit" as const,
      providerEnvironment: "default",
      providerUserId: "provider-user",
      userId: user.id,
      email: user.email,
      emailVerified: true,
      displayName: user.displayName,
      status: "linked" as const,
      profile: {},
      createdAt: now(),
      updatedAt: now(),
      lastSeenAt: now()
    }));
    const fixture = await createFixture({
      deploymentProfile: "team_self_hosted",
      workosAuthKitEnabled: true,
      repository: {
        getPendingTeamInviteByTokenHash: vi.fn(async () => invite),
        getVerifiedExternalAuthIdentityForUser,
        acceptTeamInvite
      }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "invite-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(getVerifiedExternalAuthIdentityForUser).toHaveBeenCalledWith(
      user.id
    );
    expect(acceptTeamInvite).toHaveBeenCalledTimes(1);
  });

  it("accepts a device-authorized invite exactly once and replays its durable receipt", async () => {
    const invite = pendingInvite();
    const accepted = {
      invite: { ...invite, lifecycle: "accepted" as const },
      membership: membership(),
      user,
      createdUser: false
    };
    const getPendingTeamInviteByTokenHash = vi.fn(async () => invite);
    const acceptTeamInvite = vi.fn(async () => accepted);
    let receipt:
      | { statusCode: number; body: unknown; replayed: boolean }
      | undefined;
    const executeActionGrant = vi.fn(
      async (grantInput: {
        action: string;
        teamId: string | null;
        targetId: string | null;
        requestHash: string;
        execute: (repositories: {
          team: MemorySourceRepository;
          sync: MemorySourceRepository;
          externalAuth: MemorySourceRepository;
        }) => Promise<{ statusCode: number; body: unknown } | null>;
      }) => {
        if (receipt) return { ...receipt, replayed: true };
        const result = await grantInput.execute({
          team: fixture.repository,
          sync: fixture.repository,
          externalAuth: fixture.repository
        });
        receipt = result ? { ...result, replayed: false } : undefined;
        return receipt ?? null;
      }
    );
    const fixture = await createFixture({
      deploymentProfile: "developer",
      repository: {
        getPendingTeamInviteByTokenHash,
        ensureLocalSyncDeployment: vi.fn(async () => ({
          protocolDeploymentId: deploymentId
        })),
        acceptTeamInvite,
        executeActionGrant
      }
    });
    const request = {
      method: "POST" as const,
      url: "/v1/team-invites/accept",
      headers: {
        authorization: "Koed-Device device-key:secret",
        "x-koed-action-grant": "hrg_invite_accept"
      },
      payload: { inviteToken: "one-time-invite-token" }
    };

    const first = await fixture.app.inject(request);
    const replay = await fixture.app.inject(request);
    await fixture.app.close();

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(getPendingTeamInviteByTokenHash).toHaveBeenCalledTimes(1);
    expect(acceptTeamInvite).toHaveBeenCalledTimes(1);
    expect(executeActionGrant).toHaveBeenCalledTimes(2);
    expect(executeActionGrant.mock.calls[0]?.[0]).toMatchObject({
      action: "team.invite.accept",
      teamId: null,
      targetId: null,
      operationFamily: "admin"
    });
  });

  it("rejects a Personal API Token before invite lookup", async () => {
    const getPendingTeamInviteByTokenHash = vi.fn();
    const fixture = await createFixture({
      repository: { getPendingTeamInviteByTokenHash }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      headers: { authorization: "Bearer personal-token" },
      payload: { inviteToken: "one-time-invite-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(getPendingTeamInviteByTokenHash).not.toHaveBeenCalled();
  });

  it("rejects local-only invite acceptance in managed cloud", async () => {
    const acceptTeamInvite = vi.fn();
    const getVerifiedExternalAuthIdentityForUser = vi.fn();
    const fixture = await createFixture({
      deploymentProfile: "koed_managed_cloud",
      repository: {
        getPendingTeamInviteByTokenHash: vi.fn(async () => pendingInvite()),
        getVerifiedExternalAuthIdentityForUser,
        acceptTeamInvite
      }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "invite-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(getVerifiedExternalAuthIdentityForUser).not.toHaveBeenCalled();
    expect(acceptTeamInvite).not.toHaveBeenCalled();
  });

  it("rejects a developer-profile invite when the local session email mismatches", async () => {
    const acceptTeamInvite = vi.fn();
    const fixture = await createFixture({
      deploymentProfile: "developer",
      repository: {
        getPendingTeamInviteByTokenHash: vi.fn(async () =>
          pendingInvite({
            email: "invited@example.test",
            normalizedEmail: "invited@example.test"
          })
        ),
        acceptTeamInvite
      }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "invite-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(400);
    expect(acceptTeamInvite).not.toHaveBeenCalled();
  });

  it("rejects replay of a developer-profile one-time invite token", async () => {
    const invite = pendingInvite();
    const getPendingTeamInviteByTokenHash = vi
      .fn()
      .mockResolvedValueOnce(invite)
      .mockResolvedValueOnce(null);
    const acceptTeamInvite = vi.fn(async () => ({
      invite: { ...invite, lifecycle: "accepted" as const },
      membership: membership(),
      user,
      createdUser: false
    }));
    const fixture = await createFixture({
      deploymentProfile: "developer",
      repository: {
        getPendingTeamInviteByTokenHash,
        ensureLocalSyncDeployment: vi.fn(async () => ({
          protocolDeploymentId: randomUUID()
        })),
        acceptTeamInvite
      }
    });

    const first = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "one-time-token" }
    });
    const replay = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "one-time-token" }
    });
    await fixture.app.close();

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(400);
    expect(acceptTeamInvite).toHaveBeenCalledTimes(1);
  });

  it("rejects a verified identity from a provider capability mismatch", async () => {
    const acceptTeamInvite = vi.fn();
    const fixture = await createFixture({
      deploymentProfile: "koed_managed_cloud",
      workosAuthKitEnabled: true,
      workosProviderEnvironment: "production",
      repository: {
        getPendingTeamInviteByTokenHash: vi.fn(async () => pendingInvite()),
        getVerifiedExternalAuthIdentityForUser: vi.fn(async () => ({
          id: randomUUID(),
          provider: "workos_authkit",
          providerEnvironment: "staging",
          providerUserId: "provider-user",
          userId: user.id,
          email: user.email,
          emailVerified: true,
          displayName: user.displayName,
          status: "linked",
          profile: {},
          createdAt: now(),
          updatedAt: now(),
          lastSeenAt: now()
        })),
        acceptTeamInvite
      }
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: "invite-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(acceptTeamInvite).not.toHaveBeenCalled();
  });
});
