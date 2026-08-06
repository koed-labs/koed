import {
  collaborationApprovalReviewSchema,
  type CollaborationApprovalReview
} from "@koed/shared";

import {
  teamAdminRequestHash,
  teamAdminScopeHash
} from "../team/action-grant-hash.js";
import {
  ActionApprovalPolicyError,
  type ActionApprovalPolicy,
  type ActionApprovalDisposition
} from "./approval-policy.js";
import type { HighRiskResolvedActionGrantOperation } from "./action-grant-protocol.js";

export const unavailableAction = (message: string): never => {
  throw new ActionApprovalPolicyError(message);
};

export const requireActionReview = <T>(value: T | null, message: string): T =>
  value ?? unavailableAction(message);

export const reviewedAction = (
  disposition: Extract<ActionApprovalDisposition, "native_review" | "step_up">,
  review: Omit<CollaborationApprovalReview, "version">
): ActionApprovalPolicy => ({
  disposition,
  review: collaborationApprovalReviewSchema.parse({ version: 1, ...review })
});

export const bindTeamAdminOperation = (
  operation: Omit<
    HighRiskResolvedActionGrantOperation,
    "scopeHash" | "requestHash"
  >
): HighRiskResolvedActionGrantOperation => ({
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
});
