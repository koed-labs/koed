import type {
  MemorySourceRepository,
  TeamMembershipActionReviewRecord
} from "@koed/db";

import type { ActionApprovalPolicy } from "./approval-policy.js";
import {
  bindTeamAdminOperation,
  requireActionReview,
  reviewedAction,
  unavailableAction
} from "./action-definition-support.js";
import type {
  HighRiskActionGrantIntent,
  HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

type TeamAndMembershipAction =
  | "team.create"
  | "team.invite.accept"
  | "team.invite.revoke"
  | "team.member.role_update"
  | "team.member.disable"
  | "team.leave";

export type TeamAndMembershipIntent = Extract<
  HighRiskActionGrantIntent,
  { action: TeamAndMembershipAction }
>;

type TeamAndMembershipRepository = Pick<
  MemorySourceRepository,
  | "getTeamInviteAcceptanceReview"
  | "getTeamInviteRevocationReview"
  | "getTeamMembershipActionReview"
  | "getTeamLeaveReview"
>;

interface TeamActionAdmissionInput {
  repository: TeamAndMembershipRepository;
  userId: string;
  clientRequestId: string;
  hashSecret(secret: string): string;
  intent: HighRiskActionGrantIntent;
}

interface TeamActionAdmission {
  operation: HighRiskResolvedActionGrantOperation;
  policy: ActionApprovalPolicy;
}

const nativeReview = (
  review: Parameters<typeof reviewedAction>[1]
): ActionApprovalPolicy => reviewedAction("native_review", review);

const stepUp = (
  review: Parameters<typeof reviewedAction>[1]
): ActionApprovalPolicy => reviewedAction("step_up", review);

const unavailable = (context: string): never =>
  unavailableAction(
    `${context} review requires complete current authorization context`
  );

const requireReview = <T>(value: T | null, context: string): T =>
  requireActionReview(
    value,
    `${context} review requires complete current authorization context`
  );

const memberDisplay = (review: TeamMembershipActionReviewRecord): string =>
  review.member.displayName?.trim() ||
  review.member.email ||
  review.member.userId;

const roleRank = { member: 0, admin: 1, owner: 2 } as const;

const defineTeamAction = <TIntent extends TeamAndMembershipIntent>(definition: {
  action: TIntent["action"];
  resolveOperation(intent: TIntent): HighRiskResolvedActionGrantOperation;
  resolvePolicy(input: {
    repository: TeamAndMembershipRepository;
    userId: string;
    hashSecret(secret: string): string;
    intent: TIntent;
  }): ActionApprovalPolicy | Promise<ActionApprovalPolicy>;
}) => ({
  operationFamily: "admin" as const,
  resolveOperation: definition.resolveOperation,
  async admit(
    input: TeamActionAdmissionInput
  ): Promise<TeamActionAdmission | null> {
    if (input.intent.action !== definition.action) {
      return null;
    }
    const intent = input.intent as TIntent;
    const operation = definition.resolveOperation(intent);
    const policy = await definition.resolvePolicy({
      repository: input.repository,
      userId: input.userId,
      hashSecret: input.hashSecret,
      intent
    });
    return { operation, policy };
  }
});

const teamCreateActionDefinition = defineTeamAction<
  Extract<TeamAndMembershipIntent, { action: "team.create" }>
>({
  action: "team.create",
  resolveOperation: (intent) =>
    bindTeamAdminOperation({
      operationFamily: "admin",
      action: intent.action,
      teamId: null,
      targetId: null,
      method: "POST",
      path: "/v1/teams",
      body: intent.body
    }),
  resolvePolicy: () => ({ disposition: "direct", review: null })
});

const teamInviteAcceptActionDefinition = defineTeamAction<
  Extract<TeamAndMembershipIntent, { action: "team.invite.accept" }>
>({
  action: "team.invite.accept",
  resolveOperation: (intent) =>
    bindTeamAdminOperation({
      operationFamily: "admin",
      action: intent.action,
      teamId: null,
      targetId: null,
      method: "POST",
      path: "/v1/team-invites/accept",
      body: intent.body
    }),
  resolvePolicy: async ({ repository, userId, hashSecret, intent }) => {
    const review = requireReview(
      await repository.getTeamInviteAcceptanceReview(
        { userId },
        hashSecret(intent.body.inviteToken)
      ),
      "Team invitation acceptance"
    );
    return nativeReview({
      title: `Join ${review.team.name}?`,
      description:
        "Review the membership and initial Workspace Access granted by this invitation.",
      consequence:
        "Joining adds your User to the Team with the invitation's exact role and Workspace Access.",
      confirmLabel: "Join Team",
      details: [
        { label: "Team", value: review.team.name },
        {
          label: "Membership",
          value: `${review.effectiveRole} · ${review.invite.defaultWorkspaceAccess}`
        },
        { label: "Initial Workspace", value: review.defaultWorkspace.name }
      ]
    });
  }
});

const teamInviteRevokeActionDefinition = defineTeamAction<
  Extract<TeamAndMembershipIntent, { action: "team.invite.revoke" }>
>({
  action: "team.invite.revoke",
  resolveOperation: (intent) =>
    bindTeamAdminOperation({
      operationFamily: "admin",
      action: intent.action,
      teamId: intent.teamId,
      targetId: intent.inviteId,
      method: "DELETE",
      path: `/v1/teams/${intent.teamId}/invites/${intent.inviteId}`,
      body: intent.body
    }),
  resolvePolicy: async ({ repository, userId, intent }) => {
    const review = requireReview(
      await repository.getTeamInviteRevocationReview(
        { userId },
        { teamId: intent.teamId, inviteId: intent.inviteId }
      ),
      "Team invitation revocation"
    );
    if (review.invite.version !== intent.body.expectedVersion) {
      unavailable("Team invitation revocation");
    }
    return nativeReview({
      title: "Revoke this invitation?",
      description:
        "Revocation prevents future acceptance and does not disable an existing Team member.",
      consequence: "The selected pending invitation will no longer be usable.",
      confirmLabel: "Revoke invitation",
      details: [
        { label: "Team", value: review.team.name },
        { label: "Recipient", value: review.invite.email },
        { label: "Invitation", value: review.invite.id }
      ]
    });
  }
});

const teamMemberRoleUpdateActionDefinition = defineTeamAction<
  Extract<TeamAndMembershipIntent, { action: "team.member.role_update" }>
>({
  action: "team.member.role_update",
  resolveOperation: (intent) =>
    bindTeamAdminOperation({
      operationFamily: "admin",
      action: intent.action,
      teamId: intent.teamId,
      targetId: intent.userId,
      method: "PATCH",
      path: `/v1/teams/${intent.teamId}/members/${intent.userId}/role`,
      body: intent.body
    }),
  resolvePolicy: async ({ repository, userId, intent }) => {
    const review = requireReview(
      await repository.getTeamMembershipActionReview(
        { userId },
        { teamId: intent.teamId, userId: intent.userId }
      ),
      "Team member role change"
    );
    if (
      review.member.status !== "enabled" ||
      review.member.disabledAt !== null ||
      review.member.version !== intent.body.expectedVersion ||
      (review.managerRole !== "owner" &&
        (review.member.role === "owner" || intent.body.role === "owner")) ||
      (review.member.role === "owner" &&
        intent.body.role !== "owner" &&
        review.activeOwnerCount <= 1)
    ) {
      unavailable("Team member role change");
    }
    const promotes = roleRank[intent.body.role] > roleRank[review.member.role];
    const policy = promotes ? stepUp : nativeReview;
    return policy({
      title: `Change ${memberDisplay(review)}'s role?`,
      description: "Review the current and resulting Team authority.",
      consequence: promotes
        ? "This grants additional Team administration authority."
        : "This removes Team administration authority.",
      confirmLabel: "Change role",
      details: [
        { label: "Team", value: review.team.name },
        { label: "Member", value: memberDisplay(review) },
        { label: "Current role", value: review.member.role },
        { label: "New role", value: intent.body.role }
      ]
    });
  }
});

const teamMemberDisableActionDefinition = defineTeamAction<
  Extract<TeamAndMembershipIntent, { action: "team.member.disable" }>
>({
  action: "team.member.disable",
  resolveOperation: (intent) =>
    bindTeamAdminOperation({
      operationFamily: "admin",
      action: intent.action,
      teamId: intent.teamId,
      targetId: intent.userId,
      method: "POST",
      path: `/v1/teams/${intent.teamId}/members/${intent.userId}/disable`,
      body: intent.body
    }),
  resolvePolicy: async ({ repository, userId, intent }) => {
    const review = requireReview(
      await repository.getTeamMembershipActionReview(
        { userId },
        { teamId: intent.teamId, userId: intent.userId }
      ),
      "Team member disablement"
    );
    if (
      intent.userId === userId ||
      review.member.version !== intent.body.expectedVersion ||
      (review.member.role === "owner" && review.managerRole !== "owner") ||
      (review.member.role === "owner" && review.activeOwnerCount <= 1)
    ) {
      unavailable("Team member disablement");
    }
    return stepUp({
      title: `Disable ${memberDisplay(review)}?`,
      description: "This immediately removes the member's current Team access.",
      consequence:
        "Active work may be interrupted. Owner and last-owner safeguards are rechecked before execution.",
      confirmLabel: "Disable member",
      details: [
        { label: "Team", value: review.team.name },
        { label: "Member", value: memberDisplay(review) }
      ]
    });
  }
});

const teamLeaveActionDefinition = defineTeamAction<
  Extract<TeamAndMembershipIntent, { action: "team.leave" }>
>({
  action: "team.leave",
  resolveOperation: (intent) =>
    bindTeamAdminOperation({
      operationFamily: "admin",
      action: intent.action,
      teamId: intent.teamId,
      targetId: intent.teamId,
      method: "POST",
      path: `/v1/teams/${intent.teamId}/leave`,
      body: intent.body
    }),
  resolvePolicy: async ({ repository, userId, intent }) => {
    const review = requireReview(
      await repository.getTeamLeaveReview({ userId }, intent.teamId),
      "Team leave"
    );
    if (
      review.membership.userId !== userId ||
      review.membership.status !== "enabled" ||
      review.membership.disabledAt !== null ||
      review.membership.version !== intent.body.expectedVersion ||
      (review.membership.role === "owner" && review.activeOwnerCount <= 1)
    ) {
      unavailable("Team leave");
    }
    return nativeReview({
      title: `Leave ${review.team.name}?`,
      description: "You will lose Team and Workspace Access.",
      consequence:
        "Your membership is removed. Last-owner protection is checked again before execution.",
      confirmLabel: "Leave Team",
      details: [{ label: "Team", value: review.team.name }]
    });
  }
});

export const teamAndMembershipActionDefinitions = {
  "team.create": teamCreateActionDefinition,
  "team.invite.accept": teamInviteAcceptActionDefinition,
  "team.invite.revoke": teamInviteRevokeActionDefinition,
  "team.member.role_update": teamMemberRoleUpdateActionDefinition,
  "team.member.disable": teamMemberDisableActionDefinition,
  "team.leave": teamLeaveActionDefinition
};

export const resolveTeamAndMembershipActionGrantOperation = (input: {
  clientRequestId: string;
  intent: TeamAndMembershipIntent;
}): HighRiskResolvedActionGrantOperation => {
  switch (input.intent.action) {
    case "team.create":
      return teamCreateActionDefinition.resolveOperation(input.intent);
    case "team.invite.accept":
      return teamInviteAcceptActionDefinition.resolveOperation(input.intent);
    case "team.invite.revoke":
      return teamInviteRevokeActionDefinition.resolveOperation(input.intent);
    case "team.member.role_update":
      return teamMemberRoleUpdateActionDefinition.resolveOperation(
        input.intent
      );
    case "team.member.disable":
      return teamMemberDisableActionDefinition.resolveOperation(input.intent);
    case "team.leave":
      return teamLeaveActionDefinition.resolveOperation(input.intent);
  }
};
