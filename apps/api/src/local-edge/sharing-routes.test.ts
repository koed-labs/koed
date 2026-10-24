import Fastify from "fastify";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerSharingOverviewRoute } from "./sharing-routes.js";

const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const authorization = "Koed-Desktop test";
const emptyTeam = { projects: [], invitations: [], workspaceAccess: [] };
const backend = (id: string) => ({
  id,
  baseUrl: `https://${id}.example.test/koed`,
  routePolicy: { teamWorkspaceRead: "enabled" }
});

const setup = async (input: {
  backends?: string[];
  down?: string | null;
  poisoned?: boolean;
  incoming?: boolean;
  unenrolled?: string | null;
  disabled?: string | null;
  owner?: string;
  profileDrift?: boolean;
  leaseDrift?: boolean;
  generation?: number;
}) => {
  let currentOwner = input.owner ?? ownerA;
  let currentCredentialKey = "key-a";
  let currentLease = "a".repeat(32);
  const query = vi.fn(async (_sql: string, values: unknown[]) => {
    expect(values[0]).toBe(currentOwner);
    return { rows: [] };
  });
  const fetcher = vi.fn(async (url: URL) => {
    const id = url.hostname.split(".")[0];
    if (id === input.down) throw new Error("offline");
    if (url.pathname.endsWith("/v1/teams/navigation"))
      return Response.json({
        principal: { id: ownerA },
        teams: [
          {
            team: { id: ownerA, name: "Koed team" },
            membership: { role: "owner" }
          }
        ]
      });
    if (url.pathname.endsWith(`/v1/teams/${ownerA}/members/manage`))
      return Response.json({
        members: [
          {
            userId: ownerA,
            displayName: "Owner",
            email: "owner@example.test",
            role: "owner",
            status: "enabled",
            version: 1
          },
          {
            userId: ownerB,
            displayName: "Mark",
            email: "mark@example.test",
            role: "member",
            status: "enabled",
            version: 2
          }
        ]
      });
    if (url.pathname.endsWith("/v1/local-edge/device-credentials/status"))
      return Response.json({
        ok: true,
        auth: "device_credential",
        user: { id: ownerA },
        credential: { id: ownerA }
      });
    if (url.pathname.endsWith("/v1/team-invites/mine"))
      return Response.json({
        invites: input.incoming
          ? [
              {
                id: ownerB,
                team: { id: ownerA, name: "Team" },
                workspace: { id: ownerA, name: "Workspace" },
                project: null,
                inviter: {
                  displayName: "Inviter",
                  agentDisplayName: "Private agent"
                },
                workspaceAccess: "read",
                expiresAt: new Date().toISOString()
              }
            ]
          : []
      });
    if (url.pathname.endsWith("/v1/me/sharing")) {
      if (input.profileDrift) currentCredentialKey = "changed-during-read";
      if (input.leaseDrift) currentLease = "b".repeat(32);
      return Response.json(
        input.poisoned
          ? {
              ...emptyTeam,
              invitations: [
                {
                  kind: "invitation",
                  id: ownerA,
                  teamId: ownerA,
                  workspaceProjectId: null,
                  person: { id: null, displayName: "X" },
                  role: "member",
                  access: "view",
                  status: "invited",
                  since: new Date().toISOString(),
                  canCancel: false,
                  origin: {
                    actorKind: null,
                    accessMode: null,
                    agentDisplayName: null,
                    source: { kind: "conversation", conversationId: ownerB }
                  }
                }
              ]
            }
          : emptyTeam
      );
    }
    throw new Error("Unexpected upstream route");
  });
  const app = Fastify();
  const context = {
    config: { deploymentProfile: "local_personal", koedHome: "/unused" },
    rateLimit: { memoryRead: async () => undefined },
    auth: {},
    requireRepository: () => ({
      getUser: async (id: string) => (id === currentOwner ? { id } : null),
      getManagedConversationExecution: async () => ({
        ownerUserId: currentOwner,
        executionGeneration: input.generation ?? 3,
        state: "running"
      }),
      getLatestManagedConversationCommandForExecution: async (
        _actor: unknown,
        executionId: string
      ) => ({
        id: ownerB,
        ownerUserId: currentOwner,
        executionId,
        executionGeneration: input.generation ?? 3,
        state: "dispatching",
        leaseToken: currentLease,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    }),
    localEdge: {
      upstreamBackendsPath: "/unused/registry",
      fetch: fetcher,
      resolveUpstreamEnrollmentBinding: (id: string) =>
        id === input.unenrolled
          ? null
          : {
              backendId: id,
              enrollmentId: "enroll",
              deviceCredentialId: ownerA,
              principalUserId: ownerA,
              sourceOwnerPrincipalId: ownerA
            },
      resolveUpstreamAuthorization: () => "Koed-Device upstream",
      remoteOperationsAllowed: () => true
    }
  } as unknown as ApiRouteContext;
  registerSharingOverviewRoute(app, context, { query } as unknown as pg.Pool, {
    authenticate: async () => ({ id: currentOwner }),
    readRegistry: () =>
      ({
        backends: (input.backends ?? ["team-a", "team-b"]).map(backend),
        activeBackendId: null
      }) as never,
    readDesktopCredential: () =>
      ({
        authorization,
        ownerUserId: currentOwner,
        credentialKeyId: currentCredentialKey,
        operationFamilies: ["personal_collaboration_read", "managed_execution"]
      }) as never,
    readTeamCredential: (_home, id) =>
      id === input.unenrolled
        ? null
        : {
            backendId: id,
            authorization: "Koed-Client local",
            credentialKeyId: "local",
            operationFamilies: ["team_workspace_read"]
          },
    routeDecision: ({ upstreamBackend }) =>
      ({
        action:
          upstreamBackend?.id === input.disabled
            ? "deny_fail_closed"
            : "live_upstream_proxy"
      }) as never,
    verifyManagedCredential: (_home, token, scope) =>
      token === authorization &&
      scope.ownerUserId === currentOwner &&
      scope.operationFamily === "managed_execution"
        ? {
            version: 1,
            authorization,
            reference: "test",
            credentialKeyId: currentCredentialKey,
            ownerUserId: currentOwner,
            operationFamilies: [
              "managed_execution",
              "personal_collaboration_read"
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        : null
  });
  await app.ready();
  return {
    app,
    query,
    fetcher,
    setOwner: (owner: string) => {
      currentOwner = owner;
      currentCredentialKey = `key-${owner}`;
    }
  };
};

describe("Personal Sharing aggregate", () => {
  it("retains an unavailable backend next to available metadata and does not reuse another owner's last reach", async () => {
    const fixture = await setup({ down: "team-b" });
    try {
      const first = await fixture.app.inject({
        method: "GET",
        url: "/v1/local-edge/sharing",
        headers: { authorization }
      });
      expect(first.statusCode).toBe(200);
      expect(
        first.json().backends.map((item: { status: string }) => item.status)
      ).toEqual(["available", "unavailable"]);
      fixture.setOwner(ownerB);
      const second = await fixture.app.inject({
        method: "GET",
        url: "/v1/local-edge/sharing",
        headers: { authorization }
      });
      expect(second.json().backends[0]).toMatchObject({
        status: "unavailable",
        lastReachedAt: null,
        reason: "unauthorized"
      });
      expect(fixture.query).toHaveBeenCalledWith(
        expect.stringContaining("owner_user_id=$1"),
        [ownerA, "team-a"]
      );
    } finally {
      await fixture.app.close();
    }
  });
  it("reports unenrolled and disabled-policy backends explicitly", async () => {
    const fixture = await setup({ unenrolled: "team-a", disabled: "team-b" });
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/local-edge/sharing",
        headers: { authorization }
      });
      expect(
        response.json().backends.map((item: { reason: string }) => item.reason)
      ).toEqual(["unenrolled", "route_disabled"]);
      expect(fixture.fetcher).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });
  it("rejects a Team response containing a Personal Conversation origin", async () => {
    const fixture = await setup({ backends: ["team-a"], poisoned: true });
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/local-edge/sharing",
        headers: { authorization }
      });
      expect(response.json().backends[0]).toMatchObject({
        status: "unavailable",
        reason: "invalid_response"
      });
      expect(JSON.stringify(response.json())).not.toContain(ownerB);
    } finally {
      await fixture.app.close();
    }
  });
  it("redacts the inviter's Agent name from pending incoming invitations", async () => {
    const fixture = await setup({ backends: ["team-a"], incoming: true });
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/local-edge/sharing",
        headers: { authorization }
      });
      expect(
        response.json().backends[0].incomingInvitations[0].inviter
      ).toEqual({ displayName: "Inviter", agentDisplayName: null });
      expect(response.body).not.toContain("Private agent");
    } finally {
      await fixture.app.close();
    }
  });
  it("fails the whole read when the current Personal profile changes during an upstream await", async () => {
    const fixture = await setup({ backends: ["team-a"], profileDrift: true });
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/local-edge/sharing",
        headers: { authorization }
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("team-a");
    } finally {
      await fixture.app.close();
    }
  });
});

describe("managed Sharing overview", () => {
  const executionId = "33333333-3333-4333-8333-333333333333";
  const url = `/v1/managed-conversations/${executionId}/sharing-overview?executionGeneration=3`;
  it("returns the same aggregate with an unavailable backend for a current leased owner command", async () => {
    const fixture = await setup({ down: "team-b" });
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url,
        headers: { authorization }
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .overview.backends.map((item: { status: string }) => item.status)
      ).toEqual(["available", "unavailable"]);
      expect(
        response.json().teams.map((item: { status: string }) => item.status)
      ).toEqual(["available", "unavailable"]);
      expect(
        response
          .json()
          .teams[0].teams[0].people.find(
            (person: { name: string }) => person.name === "Mark"
          ).canRemove
      ).toBe(true);
    } finally {
      await fixture.app.close();
    }
  });
  it("denies API Tokens and stale generations before reading Team data", async () => {
    const fixture = await setup({});
    try {
      const token = await fixture.app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer owner-token" }
      });
      expect(token.statusCode).toBe(403);
      const stale = await fixture.app.inject({
        method: "GET",
        url: url.replace("=3", "=2"),
        headers: { authorization }
      });
      expect(stale.statusCode).toBe(409);
      expect(fixture.fetcher).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });
  it("fails closed when the lease or Personal profile changes while Team data loads", async () => {
    for (const drift of [{ leaseDrift: true }, { profileDrift: true }]) {
      const fixture = await setup({ backends: ["team-a"], ...drift });
      try {
        const response = await fixture.app.inject({
          method: "GET",
          url,
          headers: { authorization }
        });
        expect(response.statusCode).toBe(409);
        expect(response.body).not.toContain("team-a");
      } finally {
        await fixture.app.close();
      }
    }
  });
});
