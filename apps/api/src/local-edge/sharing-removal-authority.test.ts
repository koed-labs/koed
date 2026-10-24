import { describe, expect, it } from "vitest";
import type { SharingAgentOverview } from "@koed/shared";
import { createSharingRemovalAuthority } from "./sharing-removal-authority.js";

const id = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const projectId = id(1),
  teamId = id(2),
  personId = id(3),
  ownerId = id(4),
  inviteId = id(5);
const target = {
  kind: "project_member",
  backendId: "team-a",
  projectId,
  personId
};
const member = {
  kind: "workspace_access" as const,
  person: { id: personId, displayName: "Sam" },
  version: 2,
  canRemove: true
};
const invite = {
  kind: "invitation" as const,
  id: inviteId,
  teamId,
  workspaceProjectId: null,
  person: { id: null, displayName: "Sam" },
  canCancel: true
};
const fixture = (): SharingAgentOverview =>
  ({
    version: 1,
    overview: {
      backends: [
        {
          backendId: "team-a",
          status: "available",
          data: {
            projects: [
              {
                id: projectId,
                teamId,
                ownedByMe: true,
                members: [member],
                invitations: []
              }
            ],
            workspaceAccess: [],
            invitations: [invite]
          },
          incomingInvitations: []
        },
        {
          backendId: "team-b",
          status: "unavailable",
          reason: "unreachable",
          lastReachedAt: null
        }
      ]
    },
    teams: [
      {
        backendId: "team-a",
        status: "available",
        teams: [
          {
            teamId,
            name: "Team",
            role: "owner",
            people: [
              {
                id: ownerId,
                name: "Owner",
                role: "owner",
                status: "enabled",
                version: 1,
                canRemove: false
              },
              {
                id: personId,
                name: "Sam",
                role: "member",
                status: "enabled",
                version: 2,
                canRemove: true
              }
            ]
          }
        ]
      },
      { backendId: "team-b", status: "unavailable", reason: "unreachable" }
    ]
  }) as SharingAgentOverview;

describe("sharing removal proposal authority", () => {
  it("binds exact backend-qualified targets and refuses unavailable, self and duplicate targets", async () => {
    const current = fixture();
    const authority = createSharingRemovalAuthority(async () => current);
    const proposal = await authority.proposal({
      ownerUserId: ownerId,
      targets: [target]
    });
    expect(proposal).toMatchObject([
      { ...target, expectedVersion: 2, personName: "Sam" }
    ]);
    expect(
      await authority.proposal({
        ownerUserId: ownerId,
        targets: [target, target]
      })
    ).toBeNull();
    expect(
      await authority.proposal({
        ownerUserId: ownerId,
        targets: [{ ...target, backendId: "team-b" }]
      })
    ).toBeNull();
    expect(
      await authority.proposal({
        ownerUserId: ownerId,
        targets: [
          {
            kind: "team_member",
            backendId: "team-a",
            teamId,
            personId: ownerId
          }
        ]
      })
    ).toBeNull();
  });
  it("confirms only after every selected exact target disappears from an available backend", async () => {
    const current = fixture();
    let inviteLifecycle = "pending";
    const authority = createSharingRemovalAuthority(
      async () => current,
      async () => inviteLifecycle
    );
    const targets = [
      target,
      {
        kind: "team_invitation",
        backendId: "team-a",
        teamId,
        invitationId: inviteId
      }
    ];
    expect(await authority.receipt({ ownerUserId: ownerId, targets })).toBe(
      false
    );
    const backend = current.overview.backends[0]!;
    if (backend.status !== "available")
      throw new Error("Fixture backend unavailable");
    backend.data.projects[0]!.members = [];
    expect(await authority.receipt({ ownerUserId: ownerId, targets })).toBe(
      false
    );
    backend.data.invitations = [];
    inviteLifecycle = "accepted";
    expect(await authority.receipt({ ownerUserId: ownerId, targets })).toBe(
      false
    );
    inviteLifecycle = "revoked";
    expect(await authority.receipt({ ownerUserId: ownerId, targets })).toBe(
      true
    );
    current.overview.backends[0] = {
      backendId: "team-a",
      status: "unavailable",
      reason: "unreachable",
      lastReachedAt: null
    };
    expect(await authority.receipt({ ownerUserId: ownerId, targets })).toBe(
      false
    );
  });
  it("does not treat lost Team manager authority as a completed standalone removal", async () => {
    const current = fixture();
    const backend = current.overview.backends[0]!;
    if (backend.status !== "available")
      throw new Error("Fixture backend unavailable");
    const roster = current.teams[0]!;
    if (roster.status !== "available")
      throw new Error("Fixture roster unavailable");
    backend.data.invitations = [];
    roster.teams[0]!.role = "member";
    const authority = createSharingRemovalAuthority(
      async () => current,
      async () => "revoked"
    );
    expect(
      await authority.receipt({
        ownerUserId: ownerId,
        targets: [
          {
            kind: "team_invitation",
            backendId: "team-a",
            teamId,
            invitationId: inviteId
          }
        ]
      })
    ).toBe(false);
  });
});
