import type {
  MemorySourceRepository,
  TeamWorkspaceAccessUpdateReviewRecord
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

type WorkspaceAction =
  | "team.workspace.create"
  | "team.workspace.archive"
  | "team.workspace.restore"
  | "team.workspace.access_update";

export type WorkspaceActionIntent = Extract<
  HighRiskActionGrantIntent,
  { action: WorkspaceAction }
>;

type WorkspaceActionRepository = Pick<
  MemorySourceRepository,
  | "getTeamWorkspaceCreationReview"
  | "getTeamWorkspaceLifecycleReview"
  | "getTeamWorkspaceAccessUpdateReview"
>;

interface WorkspaceActionAdmissionInput {
  repository: WorkspaceActionRepository;
  userId: string;
  intent: HighRiskActionGrantIntent;
}

const unavailable = (context: string): never =>
  unavailableAction(
    `${context} review requires complete current authorization context`
  );

const requireReview = <T>(value: T | null, context: string): T =>
  requireActionReview(
    value,
    `${context} review requires complete current authorization context`
  );

const reviewed = (
  disposition: "native_review" | "step_up",
  review: Parameters<typeof reviewedAction>[1]
): ActionApprovalPolicy => reviewedAction(disposition, review);

export const bindTeamWorkspaceCreateOperation = (
  intent: Extract<WorkspaceActionIntent, { action: "team.workspace.create" }>
): HighRiskResolvedActionGrantOperation => {
  const teamId =
    intent.teamId ??
    ("teamId" in intent.body ? String(intent.body.teamId) : null);
  if (!teamId) unavailable("Team Workspace creation");
  if (
    intent.teamId !== undefined &&
    "teamId" in intent.body &&
    intent.body.teamId !== intent.teamId
  ) {
    unavailable("Team Workspace creation");
  }
  return bindTeamAdminOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId,
    targetId: null,
    method: "POST",
    path:
      intent.teamId === undefined
        ? "/v1/team-workspaces"
        : `/v1/teams/${teamId}/workspaces`,
    body: intent.body
  });
};

export const bindTeamWorkspaceLifecycleOperation = (
  intent: Extract<
    WorkspaceActionIntent,
    { action: "team.workspace.archive" | "team.workspace.restore" }
  >,
  teamId: string
): HighRiskResolvedActionGrantOperation =>
  bindTeamAdminOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId,
    targetId: intent.teamWorkspaceId,
    method: "POST",
    path: `/v1/team-workspaces/${intent.teamWorkspaceId}/${
      intent.action === "team.workspace.archive" ? "archive" : "restore"
    }`,
    body: intent.body
  });

export const bindTeamWorkspaceAccessUpdateOperation = (
  intent: Extract<
    WorkspaceActionIntent,
    { action: "team.workspace.access_update" }
  >,
  teamId: string
): HighRiskResolvedActionGrantOperation =>
  bindTeamAdminOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId,
    targetId: intent.teamWorkspaceId,
    method: "PUT",
    path: `/v1/team-workspaces/${intent.teamWorkspaceId}/access`,
    body: intent.body
  });

const teamWorkspaceCreateActionDefinition = {
  operationFamily: "admin" as const,
  async admit(input: WorkspaceActionAdmissionInput) {
    if (input.intent.action !== "team.workspace.create") return null;
    const operation = bindTeamWorkspaceCreateOperation(input.intent);
    const review = await input.repository.getTeamWorkspaceCreationReview(
      { userId: input.userId },
      operation.teamId!
    );
    if (!review) unavailable("Team Workspace creation");
    return {
      operation,
      policy: { disposition: "direct" as const, review: null }
    };
  }
};

const teamWorkspaceArchiveActionDefinition = {
  operationFamily: "admin" as const,
  async admit(input: WorkspaceActionAdmissionInput) {
    if (input.intent.action !== "team.workspace.archive") return null;
    const review = requireReview(
      await input.repository.getTeamWorkspaceLifecycleReview(
        { userId: input.userId },
        {
          teamWorkspaceId: input.intent.teamWorkspaceId,
          lifecycle: "active"
        }
      ),
      "Team Workspace archive"
    );
    if (
      review.workspace.version !== input.intent.body.expectedVersion ||
      (input.intent.teamId !== undefined &&
        input.intent.teamId !== review.team.id)
    ) {
      unavailable("Team Workspace archive");
    }
    return {
      operation: bindTeamWorkspaceLifecycleOperation(
        input.intent,
        review.team.id
      ),
      policy: reviewed("native_review", {
        title: `Archive ${review.workspace.name}?`,
        description:
          "Archiving changes normal availability without deleting retained Team-shared Memory.",
        consequence: "The Workspace can be restored later.",
        confirmLabel: "Archive Workspace",
        details: [
          { label: "Team", value: review.team.name },
          { label: "Workspace", value: review.workspace.name }
        ]
      })
    };
  }
};

const teamWorkspaceRestoreActionDefinition = {
  operationFamily: "admin" as const,
  async admit(input: WorkspaceActionAdmissionInput) {
    if (input.intent.action !== "team.workspace.restore") return null;
    const review = requireReview(
      await input.repository.getTeamWorkspaceLifecycleReview(
        { userId: input.userId },
        {
          teamWorkspaceId: input.intent.teamWorkspaceId,
          lifecycle: "archived"
        }
      ),
      "Team Workspace restore"
    );
    if (
      review.workspace.version !== input.intent.body.expectedVersion ||
      (input.intent.teamId !== undefined &&
        input.intent.teamId !== review.team.id)
    ) {
      unavailable("Team Workspace restore");
    }
    return {
      operation: bindTeamWorkspaceLifecycleOperation(
        input.intent,
        review.team.id
      ),
      policy: { disposition: "direct" as const, review: null }
    };
  }
};

const memberDisplay = (review: TeamWorkspaceAccessUpdateReviewRecord): string =>
  review.member.displayName?.trim() ||
  review.member.email ||
  review.member.userId;

const teamWorkspaceAccessUpdateActionDefinition = {
  operationFamily: "admin" as const,
  async admit(input: WorkspaceActionAdmissionInput) {
    if (input.intent.action !== "team.workspace.access_update") return null;
    const review = requireReview(
      await input.repository.getTeamWorkspaceAccessUpdateReview(
        { userId: input.userId },
        {
          teamWorkspaceId: input.intent.teamWorkspaceId,
          userId: input.intent.body.userId
        }
      ),
      "Team Workspace Access change"
    );
    if (
      review.currentAccessVersion !== input.intent.body.expectedVersion ||
      (input.intent.teamId !== undefined &&
        input.intent.teamId !== review.team.id)
    ) {
      unavailable("Team Workspace Access change");
    }
    const next = input.intent.body.access;
    const nativeDecrease = review.currentAccess === "write" && next === "read";
    return {
      operation: bindTeamWorkspaceAccessUpdateOperation(
        input.intent,
        review.team.id
      ),
      policy: reviewed(nativeDecrease ? "native_review" : "step_up", {
        title: `Change Workspace Access for ${memberDisplay(review)}?`,
        description: "Review the exact before-and-after access value.",
        consequence:
          next === "disabled"
            ? "This removes the member's current Workspace Access."
            : nativeDecrease
              ? "This reduces Workspace Access from write to read."
              : "This grants or expands Workspace Access.",
        confirmLabel: "Apply access change",
        details: [
          { label: "Team", value: review.team.name },
          { label: "Workspace", value: review.workspace.name },
          { label: "Member", value: memberDisplay(review) },
          { label: "Current access", value: review.currentAccess },
          { label: "New access", value: next }
        ]
      })
    };
  }
};

export const workspaceActionDefinitions = {
  "team.workspace.create": teamWorkspaceCreateActionDefinition,
  "team.workspace.archive": teamWorkspaceArchiveActionDefinition,
  "team.workspace.restore": teamWorkspaceRestoreActionDefinition,
  "team.workspace.access_update": teamWorkspaceAccessUpdateActionDefinition
};
