import { randomBytes, randomUUID } from "node:crypto";

import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationRendererCommandSchema,
  collaborationSnapshotSchema,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type CollaborationSnapshot
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createCollaborationTeamControlCursorCodec,
  dispatchCollaborationTeamControlCommand,
  type CollaborationTeamControlActionBinding,
  type CollaborationTeamControlContext,
  type CollaborationTeamControlDispatchResult
} from "./collaboration-team-control.js";
import type { LocalEdgeUpstreamBackend } from "./upstream-routing.js";

const iso = "2026-07-17T00:00:00.000Z";
const teamPresence = {
  mode: "auto" as const,
  manualStatus: "available" as const,
  activityLevel: "active" as const,
  lastActivityAt: iso,
  nextTransitionAt: "2026-07-17T00:05:00.001Z",
  preferenceVersion: 1
};
const grantSecret = `hrg_${"g".repeat(43)}`;
const deviceAuthorization = "Koed-Device device-key:device-secret";

const ids = {
  principal: randomUUID(),
  localOwner: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
  workspaceTwo: randomUUID(),
  channel: randomUUID(),
  channelLogical: randomUUID(),
  invitation: randomUUID(),
  invitationTwo: randomUUID(),
  membership: randomUUID(),
  targetUser: randomUUID(),
  deviceCredential: randomUUID(),
  actionGrant: randomUUID()
};

const backend = (
  overrides: Partial<LocalEdgeUpstreamBackend> = {}
): LocalEdgeUpstreamBackend => ({
  id: "team-vps",
  baseUrl: "https://team.example.test/koed",
  routePolicy: {
    teamWorkspaceRead: "enabled",
    admin: "enabled"
  },
  ...overrides
});

const workspaceChannel = (input: {
  id?: string;
  workspaceId?: string;
  name?: string;
}) => ({
  id: input.id ?? ids.channel,
  logicalId: ids.channelLogical,
  scope: "team" as const,
  kind: "workspace_channel" as const,
  teamId: ids.team,
  workspaceId: input.workspaceId ?? ids.workspace,
  name: input.name ?? "general",
  topic: null,
  version: 1,
  lifecycle: "active" as const,
  canPost: true,
  latestSequence: 0,
  unreadCount: 0,
  lastReadMessageId: null,
  lastReadSequence: 0,
  createdAt: iso,
  updatedAt: iso,
  lastActivityAt: iso,
  archivedAt: null
});

const snapshot = (
  input: {
    workspaceId?: string;
    generalCount?: number;
    includeTeam?: boolean;
  } = {}
): CollaborationSnapshot => {
  const workspaceId = input.workspaceId ?? ids.workspace;
  const channels = Array.from({ length: input.generalCount ?? 1 }, (_, index) =>
    workspaceChannel({
      id: index === 0 ? ids.channel : randomUUID(),
      workspaceId
    })
  );
  const value = {
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: "ctr1.abcdefghijklmnop",
    generatedAt: iso,
    connection: {
      state: "live" as const,
      backendId: "team-vps",
      connectedAt: iso,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: {
      personalOwner: {
        id: ids.localOwner,
        displayName: "Local User",
        presence: "offline" as const,
        membershipState: "enabled" as const
      },
      teamPrincipal:
        input.includeTeam === false
          ? null
          : {
              id: ids.principal,
              displayName: "Remote User",
              presence: "available" as const,
              membershipState: "enabled" as const
            },
      personal: {
        memory: [],
        channels: []
      },
      teams:
        input.includeTeam === false
          ? []
          : [
              {
                id: ids.team,
                name: "Product Team",
                role: "owner" as const,
                lifecycle: "active" as const,
                unreadCount: 0,
                people: [
                  {
                    id: ids.principal,
                    displayName: "Remote User",
                    presence: "available" as const,
                    teamPresence,
                    membershipState: "enabled" as const
                  }
                ],
                directMessages: [],
                workspaces: [
                  {
                    id: workspaceId,
                    name: "Default",
                    description: null,
                    access: "write" as const,
                    lifecycle: "active" as const,
                    version: 1,
                    channels,
                    sharedMemory: []
                  }
                ],
                version: 1
              }
            ]
    },
    selection:
      input.includeTeam === false
        ? ({ kind: "personal_memory" } as const)
        : ({ kind: "team_people", teamId: ids.team } as const),
    view:
      input.includeTeam === false
        ? {
            kind: "personal_memory" as const,
            entries: []
          }
        : {
            kind: "team_people" as const,
            teamId: ids.team,
            people: [
              {
                id: ids.principal,
                displayName: "Remote User",
                presence: "available" as const,
                teamPresence,
                membershipState: "enabled" as const
              }
            ]
          }
  };
  return collaborationSnapshotSchema.parse(value);
};

const workspaceRecord = (overrides: Record<string, unknown> = {}) => ({
  id: ids.workspace,
  teamId: ids.team,
  name: "Default",
  description: null,
  lifecycle: "active",
  version: 1,
  createdAt: iso,
  updatedAt: iso,
  archivedAt: null,
  retentionPolicyId: null,
  retentionPolicyVersion: null,
  retainUntil: null,
  purgeCompletedAt: null,
  ...overrides
});

const invitationRecord = (overrides: Record<string, unknown> = {}) => ({
  id: ids.invitation,
  teamId: ids.team,
  defaultTeamWorkspaceId: ids.workspace,
  defaultWorkspaceAccess: "write",
  email: "member@example.test",
  normalizedEmail: "member@example.test",
  backendOriginHash: "a".repeat(64),
  role: "member",
  version: 1,
  lifecycle: "pending",
  createdByUserId: ids.principal,
  acceptedByUserId: null,
  createdAt: iso,
  expiresAt: "2026-07-18T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  ...overrides
});

const membershipRecord = (overrides: Record<string, unknown> = {}) => ({
  id: ids.membership,
  teamId: ids.team,
  userId: ids.targetUser,
  role: "member",
  status: "enabled",
  version: 2,
  createdAt: iso,
  updatedAt: iso,
  acceptedAt: iso,
  disabledAt: null,
  ...overrides
});

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });

const parsedCommand = <T extends CollaborationRendererCommand>(
  value: Omit<T, "contractVersion" | "requestId"> & { requestId?: string }
): T =>
  collaborationRendererCommandSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: value.requestId ?? randomUUID(),
    ...value
  }) as T;

const context = (
  input: Partial<CollaborationTeamControlContext> & {
    response?: unknown;
  } = {}
): CollaborationTeamControlContext & { fetch: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(async () => jsonResponse(input.response ?? {}));
  return {
    backend: backend(),
    principalUserId: ids.principal,
    upstreamDeviceCredentialId: ids.deviceCredential,
    upstreamDeviceAuthorization: deviceAuthorization,
    operationFamilies: new Set(["team_workspace_read", "action_grant"]),
    fetch: fetchMock as unknown as typeof fetch,
    teamCreationRequestIdempotency: true,
    loadSnapshot: async () => snapshot(),
    cursorCodec: createCollaborationTeamControlCursorCodec(randomBytes(32)),
    resolveActionGrantSecret: async () => grantSecret,
    ...input
  } as CollaborationTeamControlContext & {
    fetch: ReturnType<typeof vi.fn>;
  };
};

const handled = (
  value: CollaborationTeamControlDispatchResult
): CollaborationCommandResult => {
  expect(value.status).toBe("handled");
  if (value.status !== "handled") throw new Error("Expected handled result");
  return value.result;
};

const expectError = (
  value: CollaborationTeamControlDispatchResult,
  code: string
) => {
  const result = handled(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected command failure");
  expect(result.error.code).toBe(code);
};

describe("Team-control integration requirements", () => {
  it("does not claim unrelated collaboration commands", async () => {
    const command = parsedCommand({
      command: "collaboration.load",
      input: {}
    });

    await expect(
      dispatchCollaborationTeamControlCommand(command, context())
    ).resolves.toEqual({ status: "not_handled" });
  });

  it("fails closed when Team creation idempotency is not guaranteed", async () => {
    const command = parsedCommand({
      command: "collaboration.create_team",
      input: {
        name: "Product Team",
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({ teamCreationRequestIdempotency: false });

    const result = await dispatchCollaborationTeamControlCommand(
      command,
      fixture
    );

    expect(result).toMatchObject({
      status: "integration_required",
      requirement: { code: "team_creation_request_idempotency" }
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      command: () =>
        parsedCommand({
          command: "collaboration.create_team",
          input: {
            name: "Product Team",
            actionGrant: { id: ids.actionGrant }
          }
        }),
      code: "action_grant_secret_custody"
    },
    {
      command: () =>
        parsedCommand({
          command: "collaboration.join_team",
          input: {
            invitation: `https://team.example.test/koed/invitations/accept?token=kti_${"t".repeat(43)}`,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      code: "action_grant_secret_custody"
    },
    {
      command: () =>
        parsedCommand({
          command: "collaboration.leave_team",
          input: {
            teamId: ids.team,
            expectedVersion: 1,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      code: "action_grant_secret_custody"
    }
  ])(
    "requires server-side Action Grant custody for $code",
    async ({ command, code }) => {
      const fixture = context({ resolveActionGrantSecret: undefined });
      const result = await dispatchCollaborationTeamControlCommand(
        command(),
        fixture
      );

      expect(result).toMatchObject({
        status: "integration_required",
        requirement: { code }
      });
      expect(fixture.fetch).not.toHaveBeenCalled();
    }
  );

  it("requires an Action Grant custody resolver instead of deriving a secret from its ID", async () => {
    const command = parsedCommand({
      command: "collaboration.archive_workspace",
      input: {
        teamId: ids.team,
        workspaceId: ids.workspace,
        expectedVersion: 1,
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({ resolveActionGrantSecret: undefined });

    const result = await dispatchCollaborationTeamControlCommand(
      command,
      fixture
    );

    expect(result).toMatchObject({
      status: "integration_required",
      requirement: { code: "action_grant_secret_custody" }
    });
    expect(JSON.stringify(result)).not.toContain(ids.actionGrant);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("requires the remote device credential UUID for Action Grant binding", async () => {
    const command = parsedCommand({
      command: "collaboration.archive_workspace",
      input: {
        teamId: ids.team,
        workspaceId: ids.workspace,
        expectedVersion: 1,
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({ upstreamDeviceCredentialId: null });

    const result = await dispatchCollaborationTeamControlCommand(
      command,
      fixture
    );

    expect(result).toMatchObject({
      status: "integration_required",
      requirement: { code: "upstream_device_credential_identity" }
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("requires a local authenticated invitation cursor codec", async () => {
    const command = parsedCommand({
      command: "collaboration.list_invitations",
      input: {
        teamId: ids.team,
        includeRevoked: false,
        cursor: null,
        limit: 20
      }
    });
    const fixture = context({ cursorCodec: undefined });

    const result = await dispatchCollaborationTeamControlCommand(
      command,
      fixture
    );

    expect(result).toMatchObject({
      status: "integration_required",
      requirement: { code: "invitation_cursor_codec" }
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});

describe("Team and Workspace creation", () => {
  it("creates a Team with request idempotency and verifies one mandatory general channel", async () => {
    const requestId = randomUUID();
    const command = parsedCommand({
      requestId,
      command: "collaboration.create_team",
      input: {
        name: "Product Team",
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({
      response: {
        team: {
          id: ids.team,
          name: "Product Team",
          lifecycle: "active",
          version: 1
        },
        defaultWorkspace: workspaceRecord()
      }
    });

    const result = handled(
      await dispatchCollaborationTeamControlCommand(command, fixture)
    );

    expect(result).toMatchObject({
      ok: true,
      command: "collaboration.create_team",
      data: {
        snapshot: {
          navigation: { teams: [{ id: ids.team }] },
          selection: {
            kind: "workspace_shared_memory",
            teamId: ids.team,
            workspaceId: ids.workspace
          },
          view: {
            kind: "shared_memory_index",
            teamId: ids.team,
            workspaceId: ids.workspace
          }
        }
      }
    });
    const [url, init] = fixture.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://team.example.test/koed/v1/teams");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBe(deviceAuthorization);
    expect(headers.get("x-koed-action-grant")).toBe(grantSecret);
    expect(headers.get("idempotency-key")).toBe(requestId);
    expect(init?.body).toBe(JSON.stringify({ name: "Product Team" }));
  });

  it.each([0, 2])(
    "rejects a Team snapshot containing %i general channels",
    async (generalCount) => {
      const command = parsedCommand({
        command: "collaboration.create_team",
        input: {
          name: "Product Team",
          actionGrant: { id: ids.actionGrant }
        }
      });
      const fixture = context({
        response: {
          team: {
            id: ids.team,
            name: "Product Team",
            lifecycle: "active"
          },
          defaultWorkspace: workspaceRecord()
        },
        loadSnapshot: async () => snapshot({ generalCount })
      });

      expectError(
        await dispatchCollaborationTeamControlCommand(command, fixture),
        "temporarily_unavailable"
      );
    }
  );

  it("reports a post-mutation snapshot outage as retryable", async () => {
    const command = parsedCommand({
      command: "collaboration.create_team",
      input: {
        name: "Product Team",
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({
      response: {
        team: {
          id: ids.team,
          name: "Product Team",
          lifecycle: "active"
        },
        defaultWorkspace: workspaceRecord()
      },
      loadSnapshot: async () => {
        throw new Error("snapshot transport unavailable");
      }
    });

    expectError(
      await dispatchCollaborationTeamControlCommand(command, fixture),
      "temporarily_unavailable"
    );
  });

  it("binds Workspace creation to the exact action and verifies its structural channel", async () => {
    const bindings: CollaborationTeamControlActionBinding[] = [];
    const requestId = randomUUID();
    const command = parsedCommand({
      requestId,
      command: "collaboration.create_workspace",
      input: {
        teamId: ids.team,
        name: "Research",
        description: "Shared research",
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({
      response: {
        teamWorkspace: workspaceRecord({
          id: ids.workspaceTwo,
          name: "Research",
          description: "Shared research"
        })
      },
      loadSnapshot: async () => snapshot({ workspaceId: ids.workspaceTwo }),
      resolveActionGrantSecret: async (binding) => {
        bindings.push(binding);
        return grantSecret;
      }
    });

    const result = handled(
      await dispatchCollaborationTeamControlCommand(command, fixture)
    );

    expect(result.ok).toBe(true);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      reference: { id: ids.actionGrant },
      backendId: "team-vps",
      deviceCredentialId: ids.deviceCredential,
      principalUserId: ids.principal,
      operationFamily: "admin",
      action: "team.workspace.create",
      teamId: ids.team,
      targetId: null,
      method: "POST",
      path: `/v1/teams/${ids.team}/workspaces`,
      body: { name: "Research", description: "Shared research" }
    });
    expect(bindings[0]?.scopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bindings[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    const [, init] = fixture.fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(deviceAuthorization);
    expect(headers.get("x-koed-action-grant")).toBe(grantSecret);
    expect(headers.get("idempotency-key")).toBe(requestId);
    expect(JSON.stringify(result)).not.toContain(grantSecret);
  });

  it.each([0, 2])(
    "rejects a created Workspace snapshot containing %i general channels",
    async (generalCount) => {
      const command = parsedCommand({
        command: "collaboration.create_workspace",
        input: {
          teamId: ids.team,
          name: "Research",
          description: null,
          actionGrant: { id: ids.actionGrant }
        }
      });
      const fixture = context({
        response: {
          teamWorkspace: workspaceRecord({
            id: ids.workspaceTwo,
            name: "Research"
          })
        },
        loadSnapshot: async () =>
          snapshot({ workspaceId: ids.workspaceTwo, generalCount })
      });

      expectError(
        await dispatchCollaborationTeamControlCommand(command, fixture),
        "temporarily_unavailable"
      );
    }
  );
});

describe("invitation control", () => {
  it("returns a backend-bound one-time URL without exposing the raw token field", async () => {
    const token = `kti_${"t".repeat(43)}`;
    const command = parsedCommand({
      command: "collaboration.create_invitation",
      input: {
        teamId: ids.team,
        email: "MEMBER@EXAMPLE.TEST",
        role: "member",
        defaultWorkspaceId: ids.workspace,
        defaultWorkspaceAccess: "write",
        ttlHours: 24,
        actionGrant: { id: ids.actionGrant }
      }
    });
    const bindings: CollaborationTeamControlActionBinding[] = [];
    const fixture = context({
      response: { invite: invitationRecord(), inviteToken: token },
      resolveActionGrantSecret: async (binding) => {
        bindings.push(binding);
        return grantSecret;
      }
    });

    const result = handled(
      await dispatchCollaborationTeamControlCommand(command, fixture)
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        invitation: { id: ids.invitation, email: "member@example.test" },
        invitationUrl: `https://team.example.test/koed/invitations/accept?token=${token}`
      }
    });
    expect(Object.keys((result as { data: object }).data)).toEqual([
      "invitation",
      "invitationUrl"
    ]);
    expect(bindings[0]).toMatchObject({
      action: "team.invite.create",
      targetId: ids.workspace,
      body: {
        email: "member@example.test",
        defaultTeamWorkspaceId: ids.workspace
      }
    });
  });

  it("accepts only a URL bound to the enrolled backend and keeps its token in the request body", async () => {
    const token = `kti_${"j".repeat(43)}`;
    const command = parsedCommand({
      command: "collaboration.join_team",
      input: {
        invitation: `https://team.example.test/koed/invitations/accept?token=${token}`,
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({
      response: {
        invite: invitationRecord({
          lifecycle: "accepted",
          version: 2,
          acceptedAt: iso,
          acceptedByUserId: ids.principal
        }),
        membership: membershipRecord({
          userId: ids.principal,
          version: 1
        }),
        user: { id: ids.principal, email: "member@example.test" },
        createdUser: false
      }
    });

    const result = handled(
      await dispatchCollaborationTeamControlCommand(command, fixture)
    );

    expect(result).toMatchObject({
      ok: true,
      command: "collaboration.join_team",
      data: {
        snapshot: {
          selection: {
            kind: "workspace_shared_memory",
            teamId: ids.team,
            workspaceId: ids.workspace
          },
          view: {
            kind: "shared_memory_index",
            teamId: ids.team,
            workspaceId: ids.workspace
          }
        }
      }
    });
    const [url, init] = fixture.fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://team.example.test/koed/v1/team-invites/accept"
    );
    expect(init?.body).toBe(JSON.stringify({ inviteToken: token }));
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    `https://other.example.test/koed/invitations/accept?token=kti_${"x".repeat(43)}`,
    `https://team.example.test/invitations/accept?token=kti_${"x".repeat(43)}`,
    `https://team.example.test/koed/invitations/accept?token=kti_${"x".repeat(43)}&next=evil`,
    `https://user:pass@team.example.test/koed/invitations/accept?token=kti_${"x".repeat(43)}`,
    `kti_${"x".repeat(43)}`
  ])("rejects an unbound or malformed invitation value", async (invitation) => {
    const command = parsedCommand({
      command: "collaboration.join_team",
      input: { invitation, actionGrant: { id: ids.actionGrant } }
    });
    const fixture = context();

    expectError(
      await dispatchCollaborationTeamControlCommand(command, fixture),
      "invalid_input"
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("paginates upstream invites with a backend/principal/Team-bound opaque cursor", async () => {
    const invitations = [
      invitationRecord(),
      invitationRecord({ id: ids.invitationTwo, email: "two@example.test" })
    ];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      return jsonResponse(
        parsed.searchParams.get("cursor") === "remote-page-2"
          ? { invites: [invitations[1]], nextCursor: null }
          : { invites: [invitations[0]], nextCursor: "remote-page-2" }
      );
    });
    const fixture = context({ fetch: fetchMock as unknown as typeof fetch });
    const firstCommand = parsedCommand({
      command: "collaboration.list_invitations",
      input: {
        teamId: ids.team,
        includeRevoked: false,
        cursor: null,
        limit: 1
      }
    });

    const first = handled(
      await dispatchCollaborationTeamControlCommand(firstCommand, fixture)
    );
    expect(first).toMatchObject({
      ok: true,
      data: {
        page: {
          teamId: ids.team,
          items: [{ id: ids.invitation }]
        }
      }
    });
    if (!first.ok || first.command !== "collaboration.list_invitations") {
      throw new Error("Expected invitation page");
    }
    const cursor = first.data.page.nextCursor;
    expect(cursor).toMatch(/^ctic1\./);
    expect(cursor).not.toContain(ids.team);
    expect(cursor).not.toContain("remote-page-2");

    const second = handled(
      await dispatchCollaborationTeamControlCommand(
        parsedCommand({
          command: "collaboration.list_invitations",
          input: {
            teamId: ids.team,
            includeRevoked: false,
            cursor,
            limit: 1
          }
        }),
        fixture
      )
    );
    expect(second).toMatchObject({
      ok: true,
      data: { page: { items: [{ id: ids.invitationTwo }], nextCursor: null } }
    });
    const [firstUrl] = fixture.fetch.mock.calls[0]!;
    const [secondUrl] = fixture.fetch.mock.calls[1]!;
    expect(String(firstUrl)).toContain("includeRevoked=false&limit=1");
    expect(String(firstUrl)).not.toContain("cursor=");
    expect(String(secondUrl)).toContain("cursor=remote-page-2");
  });

  it("rejects tampered and cross-Team cursor replay before a remote request", async () => {
    const codec = createCollaborationTeamControlCursorCodec(randomBytes(32));
    const cursor = await codec.encode({
      version: 1,
      kind: "team_invitation_page",
      backendId: "team-vps",
      principalUserId: ids.principal,
      teamId: ids.team,
      includeRevoked: false,
      upstreamCursor: "remote-page-2"
    });
    for (const candidate of [
      `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
      cursor
    ]) {
      const fixture = context({ cursorCodec: codec });
      const command = parsedCommand({
        command: "collaboration.list_invitations",
        input: {
          teamId: candidate === cursor ? randomUUID() : ids.team,
          includeRevoked: false,
          cursor: candidate,
          limit: 1
        }
      });
      expectError(
        await dispatchCollaborationTeamControlCommand(command, fixture),
        "permission_denied"
      );
      expect(fixture.fetch).not.toHaveBeenCalled();
    }
  });

  it("rejects a cursor replay with different filters before a remote request", async () => {
    const codec = createCollaborationTeamControlCursorCodec(randomBytes(32));
    const cursor = await codec.encode({
      version: 1,
      kind: "team_invitation_page",
      backendId: "team-vps",
      principalUserId: ids.principal,
      teamId: ids.team,
      includeRevoked: false,
      upstreamCursor: "remote-page-2"
    });
    const fixture = context({
      cursorCodec: codec,
      response: { invites: [invitationRecord()], nextCursor: null }
    });

    expectError(
      await dispatchCollaborationTeamControlCommand(
        parsedCommand({
          command: "collaboration.list_invitations",
          input: {
            teamId: ids.team,
            includeRevoked: true,
            cursor,
            limit: 1
          }
        }),
        fixture
      ),
      "permission_denied"
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("returns the authoritative upstream continuation without a local row ceiling", async () => {
    const fixture = context({
      response: {
        invites: Array.from({ length: 100 }, (_, index) =>
          invitationRecord({
            id: randomUUID(),
            email: `user${index}@example.test`
          })
        ),
        nextCursor: "remote-page-2"
      }
    });
    const result = await dispatchCollaborationTeamControlCommand(
      parsedCommand({
        command: "collaboration.list_invitations",
        input: {
          teamId: ids.team,
          includeRevoked: false,
          cursor: null,
          limit: 100
        }
      }),
      fixture
    );

    expect(result).toMatchObject({
      status: "handled",
      result: { ok: true }
    });
    if (
      result.status !== "handled" ||
      !result.result.ok ||
      result.result.command !== "collaboration.list_invitations"
    ) {
      return;
    }
    const nextCursor = result.result.data.page.nextCursor;
    expect(nextCursor).toMatch(/^ctic1\./);
    expect(nextCursor).not.toContain("remote-page-2");
  });
});

describe("member and lifecycle administration", () => {
  it.each([
    {
      name: "revoke invitation",
      command: () =>
        parsedCommand({
          command: "collaboration.revoke_invitation",
          input: {
            teamId: ids.team,
            invitationId: ids.invitation,
            expectedVersion: 1,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      response: () => ({
        invite: invitationRecord({
          lifecycle: "revoked",
          version: 2,
          revokedAt: iso
        })
      }),
      method: "DELETE",
      path: `/v1/teams/${ids.team}/invites/${ids.invitation}`,
      action: "team.invite.revoke"
    },
    {
      name: "update role",
      command: () =>
        parsedCommand({
          command: "collaboration.update_member_role",
          input: {
            teamId: ids.team,
            userId: ids.targetUser,
            role: "admin",
            expectedVersion: 1,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      response: () => ({
        membership: membershipRecord({ role: "admin" })
      }),
      method: "PATCH",
      path: `/v1/teams/${ids.team}/members/${ids.targetUser}/role`,
      action: "team.member.role_update"
    },
    {
      name: "disable member",
      command: () =>
        parsedCommand({
          command: "collaboration.disable_member",
          input: {
            teamId: ids.team,
            userId: ids.targetUser,
            expectedVersion: 1,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      response: () => ({
        membership: membershipRecord({ status: "disabled", disabledAt: iso })
      }),
      method: "POST",
      path: `/v1/teams/${ids.team}/members/${ids.targetUser}/disable`,
      action: "team.member.disable"
    },
    {
      name: "archive Workspace",
      command: () =>
        parsedCommand({
          command: "collaboration.archive_workspace",
          input: {
            teamId: ids.team,
            workspaceId: ids.workspace,
            expectedVersion: 1,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      response: () => ({
        teamWorkspace: workspaceRecord({
          lifecycle: "archived",
          version: 2,
          archivedAt: iso
        })
      }),
      method: "POST",
      path: `/v1/team-workspaces/${ids.workspace}/archive`,
      action: "team.workspace.archive"
    },
    {
      name: "restore Workspace",
      command: () =>
        parsedCommand({
          command: "collaboration.restore_workspace",
          input: {
            teamId: ids.team,
            workspaceId: ids.workspace,
            expectedVersion: 1,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      response: () => ({
        teamWorkspace: workspaceRecord({ version: 2 })
      }),
      method: "POST",
      path: `/v1/team-workspaces/${ids.workspace}/restore`,
      action: "team.workspace.restore"
    },
    {
      name: "change Workspace Access",
      command: () =>
        parsedCommand({
          command: "collaboration.set_workspace_access",
          input: {
            teamId: ids.team,
            workspaceId: ids.workspace,
            userId: ids.targetUser,
            access: "read",
            expectedVersion: 1,
            actionGrant: { id: ids.actionGrant }
          }
        }),
      response: () => ({
        access: {
          teamWorkspaceId: ids.workspace,
          teamId: ids.team,
          userId: ids.targetUser,
          access: "read",
          version: 2
        }
      }),
      method: "PUT",
      path: `/v1/team-workspaces/${ids.workspace}/access`,
      action: "team.workspace.access_update"
    }
  ])(
    "dispatches $name with an exact one-time grant binding",
    async (testCase) => {
      const bindings: CollaborationTeamControlActionBinding[] = [];
      const fixture = context({
        response: testCase.response(),
        resolveActionGrantSecret: async (binding) => {
          bindings.push(binding);
          return grantSecret;
        }
      });

      const result = handled(
        await dispatchCollaborationTeamControlCommand(
          testCase.command(),
          fixture
        )
      );

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(bindings[0]).toMatchObject({
        action: testCase.action,
        method: testCase.method,
        path: testCase.path
      });
      const [url, init] = fixture.fetch.mock.calls[0]!;
      expect(new URL(String(url)).pathname).toBe(`/koed${testCase.path}`);
      expect(init?.method).toBe(testCase.method);
      expect(new Headers(init?.headers).get("x-koed-action-grant")).toBe(
        grantSecret
      );
      expect(JSON.stringify(result)).not.toContain(grantSecret);
    }
  );

  it("leaves a Team only through one-use Action Grant custody", async () => {
    const command = parsedCommand({
      command: "collaboration.leave_team",
      input: {
        teamId: ids.team,
        expectedVersion: 1,
        actionGrant: { id: ids.actionGrant }
      }
    });
    const fixture = context({
      response: {
        membership: membershipRecord({
          userId: ids.principal,
          status: "disabled",
          disabledAt: iso
        })
      }
    });

    const result = handled(
      await dispatchCollaborationTeamControlCommand(command, fixture)
    );

    expect(result).toMatchObject({
      ok: true,
      data: { membership: { userId: ids.principal, status: "disabled" } }
    });
    const [, init] = fixture.fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBe(deviceAuthorization);
    expect(headers.get("x-koed-action-grant")).toBe(grantSecret);
  });

  it.each([
    { resolver: async () => null, label: "missing" },
    { resolver: async () => ids.actionGrant, label: "malformed" }
  ])(
    "denies a $label grant secret without network I/O",
    async ({ resolver }) => {
      const fixture = context({ resolveActionGrantSecret: resolver });
      const command = parsedCommand({
        command: "collaboration.disable_member",
        input: {
          teamId: ids.team,
          userId: ids.targetUser,
          expectedVersion: 1,
          actionGrant: { id: ids.actionGrant }
        }
      });

      expectError(
        await dispatchCollaborationTeamControlCommand(command, fixture),
        "permission_denied"
      );
      expect(fixture.fetch).not.toHaveBeenCalled();
    }
  );

  it("denies an operation family that was not granted locally", async () => {
    const fixture = context({
      operationFamilies: new Set(["team_workspace_read"]),
      response: {
        teamWorkspace: workspaceRecord({
          lifecycle: "archived",
          version: 2,
          archivedAt: iso
        })
      }
    });
    const command = parsedCommand({
      command: "collaboration.archive_workspace",
      input: {
        teamId: ids.team,
        workspaceId: ids.workspace,
        expectedVersion: 1,
        actionGrant: { id: ids.actionGrant }
      }
    });

    expectError(
      await dispatchCollaborationTeamControlCommand(command, fixture),
      "permission_denied"
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});

describe("safe failure handling", () => {
  it.each([
    [400, "invalid_input"],
    [401, "permission_denied"],
    [403, "permission_denied"],
    [404, "not_available"],
    [409, "conflict"],
    [410, "access_revoked"],
    [429, "rate_limited"],
    [503, "temporarily_unavailable"],
    [500, "internal_error"]
  ])(
    "maps HTTP %i to %s without reflecting an upstream body",
    async (status, code) => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: grantSecret }, status, { "retry-after": "2" })
      );
      const fixture = context({ fetch: fetchMock as unknown as typeof fetch });
      const command = parsedCommand({
        command: "collaboration.archive_workspace",
        input: {
          teamId: ids.team,
          workspaceId: ids.workspace,
          expectedVersion: 1,
          actionGrant: { id: ids.actionGrant }
        }
      });

      const result = await dispatchCollaborationTeamControlCommand(
        command,
        fixture
      );
      expectError(result, code);
      expect(JSON.stringify(result)).not.toContain(grantSecret);
      if (
        code === "rate_limited" &&
        result.status === "handled" &&
        !result.result.ok
      ) {
        expect(result.result.error.retryAfterMs).toBe(2_000);
      }
    }
  );

  it("rejects malformed or cross-scope success payloads", async () => {
    const command = parsedCommand({
      command: "collaboration.archive_workspace",
      input: {
        teamId: ids.team,
        workspaceId: ids.workspace,
        expectedVersion: 1,
        actionGrant: { id: ids.actionGrant }
      }
    });
    for (const response of [
      { teamWorkspace: { id: ids.workspace } },
      {
        teamWorkspace: workspaceRecord({
          teamId: randomUUID(),
          lifecycle: "archived",
          version: 2,
          archivedAt: iso
        })
      },
      {
        teamWorkspace: workspaceRecord({
          lifecycle: "active",
          version: 2
        })
      }
    ]) {
      expectError(
        await dispatchCollaborationTeamControlCommand(
          command,
          context({ response })
        ),
        "internal_error"
      );
    }
  });

  it("rejects unsafe upstream device authorization", async () => {
    const list = parsedCommand({
      command: "collaboration.list_invitations",
      input: {
        teamId: ids.team,
        includeRevoked: false,
        cursor: null,
        limit: 20
      }
    });
    const readFixture = context({ upstreamDeviceAuthorization: "bad\nheader" });
    expectError(
      await dispatchCollaborationTeamControlCommand(list, readFixture),
      "permission_denied"
    );
    expect(readFixture.fetch).not.toHaveBeenCalled();

    const create = parsedCommand({
      command: "collaboration.create_team",
      input: {
        name: "Product Team",
        actionGrant: { id: ids.actionGrant }
      }
    });
    const browserFixture = context({
      upstreamDeviceAuthorization: "bad\r\nauthorization"
    });
    expectError(
      await dispatchCollaborationTeamControlCommand(create, browserFixture),
      "permission_denied"
    );
    expect(browserFixture.fetch).not.toHaveBeenCalled();
  });

  it("requires a strong cursor key and rejects tampering", async () => {
    expect(() =>
      createCollaborationTeamControlCursorCodec(Buffer.alloc(31))
    ).toThrow("at least 32 bytes");
    const codec = createCollaborationTeamControlCursorCodec(
      Buffer.alloc(32, 7)
    );
    const cursor = await codec.encode({
      version: 1,
      kind: "team_invitation_page",
      backendId: "team-vps",
      principalUserId: ids.principal,
      teamId: ids.team,
      includeRevoked: true,
      upstreamCursor: "remote-page-2"
    });
    expect(await codec.decode(cursor)).toMatchObject({ teamId: ids.team });
    expect(await codec.decode(`${cursor}x`)).toBeNull();
  });
});
