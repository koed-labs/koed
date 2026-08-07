import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import { admitHighRiskActionGrant } from "./action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";
import type {
  HighRiskActionGrantIntent,
  HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

const ids = {
  actor: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
  member: randomUUID()
};

const repository = () => ({
  getTeamInviteCreationReview: vi.fn(async () => null),
  getTeamInviteAcceptanceReview: vi.fn(async () => null),
  getTeamInviteRevocationReview: vi.fn(async () => null),
  getTeamMembershipActionReview: vi.fn(async () => null),
  getTeamLeaveReview: vi.fn(async () => null),
  getTeamWorkspaceCreationReview: vi.fn(async () => ({
    managerRole: "admin" as const,
    team: { id: ids.team, name: "Koed Team" }
  })),
  getTeamWorkspaceLifecycleReview: vi.fn(async (_actor, input) => ({
    managerRole: "admin" as const,
    team: { id: ids.team, name: "Koed Team" },
    workspace: {
      id: input.teamWorkspaceId,
      name: "Engineering",
      version: 4,
      lifecycle: input.lifecycle
    }
  })),
  getTeamWorkspaceAccessUpdateReview: vi.fn(async (_actor, input) => ({
    managerRole: "admin" as const,
    team: { id: ids.team, name: "Koed Team" },
    workspace: {
      id: input.teamWorkspaceId,
      name: "Engineering",
      version: 4,
      lifecycle: "active" as const
    },
    member: {
      userId: input.userId,
      email: "member@example.test",
      displayName: "Member Name"
    },
    currentAccess: "write" as const,
    currentAccessVersion: 3
  })),
  getTeamWorkspaceAccess: vi.fn(async () => null),
  lookupLegalHoldTeamId: vi.fn(async () => null)
});

const admit = (intent: HighRiskActionGrantIntent, repo = repository()) =>
  admitHighRiskActionGrant({
    repository: repo as never,
    userId: ids.actor,
    clientRequestId: randomUUID(),
    hashSecret: (secret) => secret,
    intent
  });

const operation = (
  input: Omit<
    HighRiskResolvedActionGrantOperation,
    "operationFamily" | "scopeHash" | "requestHash"
  >
): HighRiskResolvedActionGrantOperation => ({
  operationFamily: "admin",
  ...input,
  scopeHash: teamAdminScopeHash({
    action: input.action,
    teamId: input.teamId,
    targetId: input.targetId
  }),
  requestHash: teamAdminRequestHash({
    method: input.method,
    path: input.path,
    body: input.body
  })
});

describe("Workspace action definitions", () => {
  it("owns current and legacy Workspace creation bindings with Direct policy", async () => {
    const repo = repository();
    const current = {
      action: "team.workspace.create",
      teamId: ids.team,
      body: { name: "Engineering", description: null }
    } as const satisfies HighRiskActionGrantIntent;
    const legacy = {
      action: "team.workspace.create",
      body: { teamId: ids.team, name: "Engineering", description: null }
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(current, repo)).resolves.toEqual({
      operation: operation({
        action: current.action,
        teamId: ids.team,
        targetId: null,
        method: "POST",
        path: `/v1/teams/${ids.team}/workspaces`,
        body: current.body
      }),
      policy: { disposition: "direct", review: null }
    });
    await expect(admit(legacy, repo)).resolves.toEqual({
      operation: operation({
        action: legacy.action,
        teamId: ids.team,
        targetId: null,
        method: "POST",
        path: "/v1/team-workspaces",
        body: legacy.body
      }),
      policy: { disposition: "direct", review: null }
    });
    expect(repo.getTeamWorkspaceCreationReview).toHaveBeenCalledWith(
      { userId: ids.actor },
      ids.team
    );
  });

  it("owns Workspace archive binding, active context, version, and Native review", async () => {
    const repo = repository();
    const intent = {
      action: "team.workspace.archive",
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      body: { expectedVersion: 4 }
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent, repo);

    expect(admitted).toMatchObject({
      operation: operation({
        action: intent.action,
        teamId: ids.team,
        targetId: ids.workspace,
        method: "POST",
        path: `/v1/team-workspaces/${ids.workspace}/archive`,
        body: intent.body
      }),
      policy: {
        disposition: "native_review",
        review: {
          title: "Archive Engineering?",
          details: [
            { label: "Team", value: "Koed Team" },
            { label: "Workspace", value: "Engineering" }
          ]
        }
      }
    });
    expect(repo.getTeamWorkspaceLifecycleReview).toHaveBeenCalledWith(
      { userId: ids.actor },
      { teamWorkspaceId: ids.workspace, lifecycle: "active" }
    );
  });

  it("owns Workspace restore binding and requires archived context for Direct policy", async () => {
    const repo = repository();
    const intent = {
      action: "team.workspace.restore",
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      body: { expectedVersion: 4 }
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).resolves.toEqual({
      operation: operation({
        action: intent.action,
        teamId: ids.team,
        targetId: ids.workspace,
        method: "POST",
        path: `/v1/team-workspaces/${ids.workspace}/restore`,
        body: intent.body
      }),
      policy: { disposition: "direct", review: null }
    });
    expect(repo.getTeamWorkspaceLifecycleReview).toHaveBeenCalledWith(
      { userId: ids.actor },
      { teamWorkspaceId: ids.workspace, lifecycle: "archived" }
    );
  });

  it("uses authoritative Workspace Access for Native decrease and Step-up expansion or disablement", async () => {
    const repo = repository();
    const base = {
      action: "team.workspace.access_update",
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      body: { userId: ids.member, access: "read", expectedVersion: 3 }
    } as const satisfies HighRiskActionGrantIntent;

    const decrease = await admit(base, repo);
    repo.getTeamWorkspaceAccessUpdateReview.mockResolvedValueOnce({
      ...(await repository().getTeamWorkspaceAccessUpdateReview(
        { userId: ids.actor },
        { teamWorkspaceId: ids.workspace, userId: ids.member }
      ))!,
      currentAccess: "read"
    } as never);
    const expansion = await admit(
      { ...base, body: { ...base.body, access: "write" } },
      repo
    );
    const disablement = await admit(
      { ...base, body: { ...base.body, access: "disabled" } },
      repo
    );

    expect(decrease).toMatchObject({
      operation: operation({
        action: base.action,
        teamId: ids.team,
        targetId: ids.workspace,
        method: "PUT",
        path: `/v1/team-workspaces/${ids.workspace}/access`,
        body: base.body
      }),
      policy: {
        disposition: "native_review",
        review: {
          details: expect.arrayContaining([
            { label: "Current access", value: "write" },
            { label: "New access", value: "read" }
          ])
        }
      }
    });
    expect(expansion).toMatchObject({ policy: { disposition: "step_up" } });
    expect(disablement).toMatchObject({ policy: { disposition: "step_up" } });
  });

  it.each(["team", "workspace", "member"] as const)(
    "rejects dangerous Unicode controls in authoritative %s names",
    async (field) => {
      const repo = repository();
      const review = (await repository().getTeamWorkspaceAccessUpdateReview(
        { userId: ids.actor },
        { teamWorkspaceId: ids.workspace, userId: ids.member }
      ))!;
      repo.getTeamWorkspaceAccessUpdateReview.mockResolvedValueOnce({
        ...review,
        team: {
          ...review.team,
          name: field === "team" ? "Safe\u202eAdmin" : review.team.name
        },
        workspace: {
          ...review.workspace,
          name:
            field === "workspace" ? "Safe\u2066Archive" : review.workspace.name
        },
        member: {
          ...review.member,
          displayName:
            field === "member"
              ? "Safe\nAdministrator"
              : review.member.displayName
        }
      } as never);

      await expect(
        admit(
          {
            action: "team.workspace.access_update",
            teamId: ids.team,
            teamWorkspaceId: ids.workspace,
            body: { userId: ids.member, access: "read", expectedVersion: 3 }
          },
          repo
        )
      ).rejects.toThrow("Approval copy must not contain");
    }
  );

  it("fails closed for missing, stale, or mismatched Workspace context", async () => {
    const repo = repository();
    repo.getTeamWorkspaceLifecycleReview.mockResolvedValueOnce(null as never);
    await expect(
      admit(
        {
          action: "team.workspace.archive",
          teamWorkspaceId: ids.workspace,
          body: { expectedVersion: 4 }
        },
        repo
      )
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);

    await expect(
      admit(
        {
          action: "team.workspace.restore",
          teamId: randomUUID(),
          teamWorkspaceId: ids.workspace,
          body: { expectedVersion: 4 }
        },
        repo
      )
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);

    await expect(
      admit(
        {
          action: "team.workspace.access_update",
          teamId: ids.team,
          teamWorkspaceId: ids.workspace,
          body: { userId: ids.member, access: "read", expectedVersion: 2 }
        },
        repo
      )
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
  });
});
