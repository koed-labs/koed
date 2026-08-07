import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import {
  admitHighRiskActionGrant,
  highRiskActionGrantOperationFamilyForIntent
} from "./action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";
import type { HighRiskActionGrantIntent } from "./action-grant-protocol.js";

const ids = {
  user: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID()
};

const invitationIntent = {
  action: "team.invite.create",
  teamId: ids.team,
  body: {
    defaultTeamWorkspaceId: ids.workspace,
    defaultWorkspaceAccess: "read",
    email: "member@example.test",
    role: "member",
    ttlHours: 72
  }
} as const satisfies HighRiskActionGrantIntent;

const repository = (reviewContext: object | null) => ({
  getTeamInviteCreationReview: vi.fn(async () => reviewContext),
  getTeamInviteAcceptanceReview: vi.fn(async () => null),
  getTeamInviteRevocationReview: vi.fn(async () => null),
  getTeamMembershipActionReview: vi.fn(async () => null),
  getTeamLeaveReview: vi.fn(async () => null),
  getTeamWorkspaceCreationReview: vi.fn(async () => null),
  getTeamWorkspaceLifecycleReview: vi.fn(async () => null),
  getTeamWorkspaceAccessUpdateReview: vi.fn(async () => null),
  getTeamWorkspaceAccess: vi.fn(async () => null),
  lookupLegalHoldTeamId: vi.fn(async () => null)
});

describe("high-risk action definitions", () => {
  it("admits Team invitation creation through one authoritative definition", async () => {
    const repo = repository({
      managerRole: "admin",
      team: { id: ids.team, name: "Koed Team" },
      defaultWorkspace: {
        id: ids.workspace,
        name: "Product",
        lifecycle: "active"
      }
    });
    const clientRequestId = randomUUID();

    const admitted = await admitHighRiskActionGrant({
      repository: repo as never,
      userId: ids.user,
      clientRequestId,
      hashSecret: (secret) => secret,
      intent: invitationIntent
    });

    const expectedOperation = {
      operationFamily: "admin",
      action: "team.invite.create",
      teamId: ids.team,
      targetId: ids.workspace,
      method: "POST",
      path: `/v1/teams/${ids.team}/invites`,
      body: invitationIntent.body
    } as const;
    expect(admitted).toEqual({
      operation: {
        ...expectedOperation,
        scopeHash: teamAdminScopeHash({
          action: expectedOperation.action,
          teamId: expectedOperation.teamId,
          targetId: expectedOperation.targetId
        }),
        requestHash: teamAdminRequestHash({
          method: expectedOperation.method,
          path: expectedOperation.path,
          body: expectedOperation.body
        })
      },
      policy: {
        disposition: "native_review",
        review: {
          version: 1,
          title: "Invite member@example.test?",
          description: "Review the exact invitation before it is issued.",
          consequence:
            "The recipient can join with the listed role and initial Workspace Access until the invitation expires.",
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
    expect(repo.getTeamInviteCreationReview).toHaveBeenCalledWith(
      { userId: ids.user },
      {
        teamId: ids.team,
        defaultTeamWorkspaceId: ids.workspace,
        role: "member"
      }
    );
    expect(highRiskActionGrantOperationFamilyForIntent(invitationIntent)).toBe(
      "admin"
    );
  });

  it("fails closed when authoritative Team invitation context is unavailable", async () => {
    const repo = repository(null);

    await expect(
      admitHighRiskActionGrant({
        repository: repo as never,
        userId: ids.user,
        clientRequestId: randomUUID(),
        hashSecret: (secret) => secret,
        intent: invitationIntent
      })
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
  });
});
