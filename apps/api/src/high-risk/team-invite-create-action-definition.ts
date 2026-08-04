import type { MemorySourceRepository } from "@koed/db";
import { collaborationApprovalReviewSchema } from "@koed/shared";

import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import {
  ActionApprovalPolicyError,
  type ActionApprovalPolicy
} from "./approval-policy.js";
import type {
  HighRiskActionGrantIntent,
  HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

type TeamInviteCreateIntent = Extract<
  HighRiskActionGrantIntent,
  { action: "team.invite.create" }
>;

type TeamInviteCreateRepository = Pick<
  MemorySourceRepository,
  "getTeamInviteCreationReview"
>;

export const resolveTeamInviteCreateActionGrantOperation = (input: {
  clientRequestId: string;
  intent: TeamInviteCreateIntent;
}): HighRiskResolvedActionGrantOperation => {
  const operation = {
    operationFamily: "admin" as const,
    action: input.intent.action,
    teamId: input.intent.teamId,
    targetId: input.intent.body.defaultTeamWorkspaceId,
    method: "POST" as const,
    path: `/v1/teams/${input.intent.teamId}/invites`,
    body: input.intent.body
  };
  return {
    ...operation,
    scopeHash: teamAdminScopeHash({
      action: operation.action,
      teamId: operation.teamId,
      targetId: operation.targetId
    }),
    requestHash: teamAdminRequestHash({
      method: operation.method,
      path: operation.path,
      body: operation.body
    })
  };
};

const resolveTeamInviteCreatePolicy = async (input: {
  repository: TeamInviteCreateRepository;
  userId: string;
  intent: TeamInviteCreateIntent;
}): Promise<ActionApprovalPolicy> => {
  const reviewContext = await input.repository.getTeamInviteCreationReview(
    { userId: input.userId },
    {
      teamId: input.intent.teamId,
      defaultTeamWorkspaceId: input.intent.body.defaultTeamWorkspaceId,
      role: input.intent.body.role
    }
  );
  if (!reviewContext) {
    throw new ActionApprovalPolicyError(
      "Team invitation review requires current manager, Team, and Workspace context"
    );
  }
  return {
    disposition: "native_review",
    review: collaborationApprovalReviewSchema.parse({
      version: 1,
      title: `Invite ${input.intent.body.email}?`,
      description: "Review the exact invitation before it is issued.",
      consequence:
        "The recipient can join with the listed role and initial Workspace Access until the invitation expires.",
      confirmLabel: "Create invitation",
      details: [
        { label: "Team", value: reviewContext.team.name },
        { label: "Recipient", value: input.intent.body.email },
        { label: "Role", value: input.intent.body.role },
        {
          label: "Default Workspace",
          value: reviewContext.defaultWorkspace.name
        },
        {
          label: "Workspace Access",
          value: input.intent.body.defaultWorkspaceAccess
        },
        {
          label: "Expires after",
          value: `${input.intent.body.ttlHours} hours`
        }
      ]
    })
  };
};

export const teamInviteCreateActionDefinition = {
  operationFamily: "admin" as const,
  async admit(input: {
    repository: TeamInviteCreateRepository;
    userId: string;
    clientRequestId: string;
    intent: HighRiskActionGrantIntent;
  }): Promise<{
    operation: HighRiskResolvedActionGrantOperation;
    policy: ActionApprovalPolicy;
  } | null> {
    if (input.intent.action !== "team.invite.create") {
      return null;
    }
    const operation = resolveTeamInviteCreateActionGrantOperation({
      clientRequestId: input.clientRequestId,
      intent: input.intent
    });
    const policy = await resolveTeamInviteCreatePolicy({
      repository: input.repository,
      userId: input.userId,
      intent: input.intent
    });
    return { operation, policy };
  }
};
