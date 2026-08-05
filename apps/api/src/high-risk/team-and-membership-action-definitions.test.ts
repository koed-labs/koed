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
  member: randomUUID(),
  invite: randomUUID()
};

const baseRepository = () => ({
  getTeamInviteCreationReview: vi.fn(async () => null),
  getTeamInviteAcceptanceReview: vi.fn(async () => ({
    invite: {
      role: "owner" as const,
      defaultWorkspaceAccess: "write" as const
    },
    team: { name: "Koed Team" },
    defaultWorkspace: { name: "Engineering" },
    effectiveRole: "admin" as const
  })),
  getTeamInviteRevocationReview: vi.fn(async () => ({
    managerRole: "admin" as const,
    team: { id: ids.team, name: "Koed Team" },
    invite: {
      id: ids.invite,
      email: "invitee@example.test",
      role: "member" as const,
      version: 4,
      lifecycle: "pending" as const
    }
  })),
  getTeamMembershipActionReview: vi.fn(async () => ({
    managerRole: "owner" as const,
    team: { id: ids.team, name: "Koed Team" },
    member: {
      userId: ids.member,
      role: "member" as const,
      status: "enabled" as const,
      version: 7,
      disabledAt: null,
      email: "member@example.test",
      displayName: "Member Name"
    },
    activeOwnerCount: 2
  })),
  getTeamLeaveReview: vi.fn(async () => ({
    team: { id: ids.team, name: "Koed Team" },
    membership: {
      userId: ids.actor,
      role: "admin" as const,
      status: "enabled" as const,
      version: 9,
      disabledAt: null
    },
    activeOwnerCount: 1
  })),
  getTeamWorkspaceCreationReview: vi.fn(async () => null),
  getTeamWorkspaceLifecycleReview: vi.fn(async () => null),
  getTeamWorkspaceAccessUpdateReview: vi.fn(async () => null),
  getTeamWorkspaceAccess: vi.fn(async () => null),
  lookupLegalHoldTeamId: vi.fn(async () => null)
});

const admit = (
  intent: HighRiskActionGrantIntent,
  repository = baseRepository()
) =>
  admitHighRiskActionGrant({
    repository: repository as never,
    userId: ids.actor,
    clientRequestId: randomUUID(),
    hashSecret: (secret) => `hashed:${secret}`,
    intent
  });

const expectedOperation = (
  input: Omit<
    HighRiskResolvedActionGrantOperation,
    "scopeHash" | "requestHash" | "operationFamily"
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

describe("Team and membership action definitions", () => {
  it("owns Team creation binding and Direct policy without repository context", async () => {
    const repository = baseRepository();
    const intent = {
      action: "team.create",
      body: { name: "New Team" }
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent, repository);

    expect(admitted).toEqual({
      operation: expectedOperation({
        action: intent.action,
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/teams",
        body: intent.body
      }),
      policy: { disposition: "direct", review: null }
    });
    expect(repository.getTeamMembershipActionReview).not.toHaveBeenCalled();
  });

  it("owns invitation acceptance binding, hashed lookup, and effective membership review", async () => {
    const repository = baseRepository();
    const intent = {
      action: "team.invite.accept",
      body: { inviteToken: "kti_validInvitationToken123456" }
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent, repository);

    expect(admitted).toEqual({
      operation: expectedOperation({
        action: intent.action,
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/team-invites/accept",
        body: intent.body
      }),
      policy: {
        disposition: "native_review",
        review: expect.objectContaining({
          version: 1,
          title: "Join Koed Team?",
          details: [
            { label: "Team", value: "Koed Team" },
            { label: "Membership", value: "admin · write" },
            { label: "Initial Workspace", value: "Engineering" }
          ]
        })
      }
    });
    expect(repository.getTeamInviteAcceptanceReview).toHaveBeenCalledWith(
      { userId: ids.actor },
      `hashed:${intent.body.inviteToken}`
    );
  });

  it("owns exact invitation revocation context, version, and Native review", async () => {
    const repository = baseRepository();
    const intent = {
      action: "team.invite.revoke",
      teamId: ids.team,
      inviteId: ids.invite,
      body: { expectedVersion: 4 }
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent, repository);

    expect(admitted).toMatchObject({
      operation: expectedOperation({
        action: intent.action,
        teamId: ids.team,
        targetId: ids.invite,
        method: "DELETE",
        path: `/v1/teams/${ids.team}/invites/${ids.invite}`,
        body: intent.body
      }),
      policy: {
        disposition: "native_review",
        review: {
          title: "Revoke this invitation?",
          details: expect.arrayContaining([
            { label: "Recipient", value: "invitee@example.test" }
          ])
        }
      }
    });
    expect(repository.getTeamInviteRevocationReview).toHaveBeenCalledWith(
      { userId: ids.actor },
      { teamId: ids.team, inviteId: ids.invite }
    );
  });

  it("selects Step-up for a role promotion and Native review for a decrease from authoritative state", async () => {
    const repository = baseRepository();
    const promotion = {
      action: "team.member.role_update",
      teamId: ids.team,
      userId: ids.member,
      body: { role: "admin", expectedVersion: 7 }
    } as const satisfies HighRiskActionGrantIntent;

    const promoted = await admit(promotion, repository);
    repository.getTeamMembershipActionReview.mockResolvedValueOnce({
      managerRole: "owner",
      team: { id: ids.team, name: "Koed Team" },
      member: {
        userId: ids.member,
        role: "admin",
        status: "enabled",
        version: 7,
        disabledAt: null,
        email: "member@example.test",
        displayName: "Member Name"
      },
      activeOwnerCount: 2
    } as never);
    const decreased = await admit(
      { ...promotion, body: { role: "member", expectedVersion: 7 } },
      repository
    );

    expect(promoted).toMatchObject({
      operation: expectedOperation({
        action: promotion.action,
        teamId: ids.team,
        targetId: ids.member,
        method: "PATCH",
        path: `/v1/teams/${ids.team}/members/${ids.member}/role`,
        body: promotion.body
      }),
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Current role", value: "member" },
            { label: "New role", value: "admin" }
          ])
        }
      }
    });
    expect(decreased).toMatchObject({
      policy: {
        disposition: "native_review",
        review: {
          details: expect.arrayContaining([
            { label: "Current role", value: "admin" },
            { label: "New role", value: "member" }
          ])
        }
      }
    });
  });

  it("owns member disablement binding and Step-up review", async () => {
    const intent = {
      action: "team.member.disable",
      teamId: ids.team,
      userId: ids.member,
      body: { expectedVersion: 7 }
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent);

    expect(admitted).toMatchObject({
      operation: expectedOperation({
        action: intent.action,
        teamId: ids.team,
        targetId: ids.member,
        method: "POST",
        path: `/v1/teams/${ids.team}/members/${ids.member}/disable`,
        body: intent.body
      }),
      policy: {
        disposition: "step_up",
        review: {
          title: "Disable Member Name?",
          details: [
            { label: "Team", value: "Koed Team" },
            { label: "Member", value: "Member Name" }
          ]
        }
      }
    });
  });

  it("owns Team leave binding, exact membership version, last-owner guard, and Native review", async () => {
    const repository = baseRepository();
    const intent = {
      action: "team.leave",
      teamId: ids.team,
      body: { expectedVersion: 9 }
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent, repository);

    expect(admitted).toMatchObject({
      operation: expectedOperation({
        action: intent.action,
        teamId: ids.team,
        targetId: ids.team,
        method: "POST",
        path: `/v1/teams/${ids.team}/leave`,
        body: intent.body
      }),
      policy: {
        disposition: "native_review",
        review: {
          title: "Leave Koed Team?",
          details: [{ label: "Team", value: "Koed Team" }]
        }
      }
    });
    expect(repository.getTeamLeaveReview).toHaveBeenCalledWith(
      { userId: ids.actor },
      ids.team
    );

    repository.getTeamLeaveReview.mockResolvedValueOnce({
      team: { id: ids.team, name: "Koed Team" },
      membership: {
        userId: ids.actor,
        role: "owner",
        status: "enabled",
        version: 9,
        disabledAt: null
      },
      activeOwnerCount: 1
    } as never);
    await expect(admit(intent, repository)).rejects.toBeInstanceOf(
      ActionApprovalPolicyError
    );
  });

  it("fails closed for missing invitation and stale membership context", async () => {
    const repository = baseRepository();
    repository.getTeamInviteAcceptanceReview.mockResolvedValueOnce(
      null as never
    );
    await expect(
      admit(
        {
          action: "team.invite.accept",
          body: { inviteToken: "kti_validInvitationToken123456" }
        },
        repository
      )
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);

    repository.getTeamMembershipActionReview.mockResolvedValueOnce({
      managerRole: "owner",
      team: { id: ids.team, name: "Koed Team" },
      member: {
        userId: ids.member,
        role: "member",
        status: "enabled",
        version: 6,
        disabledAt: null,
        email: "member@example.test",
        displayName: "Member Name"
      },
      activeOwnerCount: 2
    });
    await expect(
      admit(
        {
          action: "team.member.disable",
          teamId: ids.team,
          userId: ids.member,
          body: { expectedVersion: 7 }
        },
        repository
      )
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
  });
});
