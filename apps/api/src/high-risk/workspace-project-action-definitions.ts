import type { HighRiskActionDefinitionRepository } from "./action-definitions.js";
import type { HighRiskActionGrantIntent } from "./action-grant-protocol.js";
import {
  bindTeamAdminOperation,
  reviewedAction
} from "./action-definition-support.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";

type Intent = Extract<
  HighRiskActionGrantIntent,
  {
    action:
      | "workspace_project.leave"
      | "workspace_project.member_remove"
      | "workspace_project.delete";
  }
>;

const denied = (): never => {
  throw new ActionApprovalPolicyError(
    "Current Workspace Project authority is unavailable or stale"
  );
};

const definition = (action: Intent["action"]) => ({
  operationFamily: "admin" as const,
  async admit(input: {
    repository: HighRiskActionDefinitionRepository;
    userId: string;
    intent: HighRiskActionGrantIntent;
  }) {
    if (input.intent.action !== action) return null;
    const intent = input.intent as Intent;
    const review = await input.repository.getLifecycleReview(
      input.userId,
      intent.projectId,
      intent.action === "workspace_project.member_remove"
        ? intent.targetUserId
        : undefined
    );
    if (!review) return denied();
    if (
      review.project.teamId !== intent.teamId ||
      review.project.lifecycle !== "active" ||
      review.project.version !== intent.body.expectedProjectVersion ||
      review.actorAccess === "disabled" ||
      review.actorWorkspaceAccess === "disabled" ||
      (intent.action !== "workspace_project.leave" &&
        (review.actorAccess !== "write" ||
          review.actorWorkspaceAccess !== "write"))
    )
      denied();
    const owner = review.ownerUserId === input.userId;
    if (intent.action === "workspace_project.leave") {
      if (
        owner ||
        review.actorMemberVersion !== intent.body.expectedMemberVersion
      )
        denied();
    } else if (intent.action === "workspace_project.member_remove") {
      if (
        !owner ||
        intent.targetUserId === input.userId ||
        intent.targetUserId === review.ownerUserId ||
        review.targetAccess === null ||
        review.targetAccess === "disabled" ||
        review.targetMemberVersion !== intent.body.expectedMemberVersion
      )
        denied();
    } else if (!owner) denied();
    const path =
      intent.action === "workspace_project.leave"
        ? `/v1/workspace-projects/${intent.projectId}/leave`
        : intent.action === "workspace_project.delete"
          ? `/v1/workspace-projects/${intent.projectId}/delete`
          : `/v1/workspace-projects/${intent.projectId}/members/${intent.targetUserId}/remove`;
    return {
      operation: bindTeamAdminOperation({
        operationFamily: "admin",
        action: intent.action,
        teamId: intent.teamId,
        targetId: intent.projectId,
        method: "POST",
        path,
        body: intent.body
      }),
      policy: reviewedAction("step_up", {
        title:
          intent.action === "workspace_project.delete"
            ? `Delete ${review.project.name}?`
            : intent.action === "workspace_project.leave"
              ? `Leave ${review.project.name}?`
              : `Remove member from ${review.project.name}?`,
        description:
          intent.action === "workspace_project.member_remove"
            ? `Remove Team member ${intent.targetUserId} from this Project?`
            : "Review the exact Workspace Project lifecycle change.",
        consequence:
          intent.action === "workspace_project.delete"
            ? "Every member loses this Project link. The Project Thread is archived, affected grants freeze, and published Team memory remains under current Team access. Members reconcile their own chats and jobs later."
            : "Only the named member loses Project access. Their affected grants freeze; other members retain current access.",
        confirmLabel: "Review Project change",
        details: [
          { label: "Project", value: review.project.name },
          { label: "Project version", value: String(review.project.version) },
          ...(intent.action === "workspace_project.member_remove"
            ? [
                { label: "Member", value: intent.targetUserId },
                {
                  label: "Member link version",
                  value: String(review.targetMemberVersion)
                }
              ]
            : intent.action === "workspace_project.leave"
              ? [
                  {
                    label: "Your link version",
                    value: String(review.actorMemberVersion)
                  }
                ]
              : [])
        ]
      })
    };
  }
});

export const workspaceProjectActionDefinitions = {
  "workspace_project.leave": definition("workspace_project.leave"),
  "workspace_project.member_remove": definition(
    "workspace_project.member_remove"
  ),
  "workspace_project.delete": definition("workspace_project.delete"),
  "project_source.team_metadata.delete": {
    operationFamily: "admin" as const,
    async admit(input: {
      repository: HighRiskActionDefinitionRepository;
      userId: string;
      intent: HighRiskActionGrantIntent;
    }) {
      if (input.intent.action !== "project_source.team_metadata.delete")
        return null;
      const intent = input.intent;
      const review = await input.repository.getSourceDeleteReview(
        input.userId,
        intent.projectId,
        intent.sourceId
      );
      if (
        !review ||
        review.project.teamId !== intent.teamId ||
        review.project.lifecycle !== "active" ||
        review.project.version !== intent.body.expectedProjectVersion ||
        review.sourceVersion !== intent.body.expectedSourceVersion
      )
        return denied();
      const path = `/v1/workspace-projects/${intent.projectId}/sources/${intent.sourceId}/delete`;
      return {
        operation: bindTeamAdminOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.projectId,
          method: "POST",
          path,
          body: intent.body
        }),
        policy: reviewedAction("step_up", {
          title: `Remove ${review.sourceName} from ${review.project.name}?`,
          description: "Remove this Source from the shared Project.",
          consequence:
            "Exact bound Note grants stop advancing at their last published revision. The uploader keeps the original Personal Note and document.",
          confirmLabel: "Review Source removal",
          details: [
            { label: "Project", value: review.project.name },
            { label: "Source", value: review.sourceName },
            { label: "Uploader", value: review.uploaderUserId },
            { label: "Project version", value: String(review.project.version) },
            { label: "Source version", value: String(review.sourceVersion) }
          ]
        })
      };
    }
  }
};
