import type {
  CollaborationApprovalReview,
  CollaborationApprovalTier
} from "@koed/shared";

export type ActionApprovalDisposition =
  | CollaborationApprovalTier
  | "bundled_stage";

export interface ActionApprovalPolicy {
  disposition: ActionApprovalDisposition;
  review: CollaborationApprovalReview | null;
}

export class ActionApprovalPolicyError extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "ActionApprovalPolicyError";
  }
}
