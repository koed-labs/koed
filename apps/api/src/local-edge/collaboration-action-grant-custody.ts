import {
  updateCollaborationActionGrantCustodyStatus,
  type CollaborationApprovalReview,
  type CollaborationApprovalTier
} from "@koed/shared";

interface CustodyContext {
  backend: { id: string; baseUrl: string };
  localOwnerUserId?: string;
  principalUserId: string;
  upstreamDeviceCredentialId: string | null;
}

export interface ActionGrantRemoteStatus {
  version: 1;
  actionGrant: { id: string };
  approvalTier: CollaborationApprovalTier;
  review: CollaborationApprovalReview | null;
  state:
    | "pending"
    | "review_required"
    | "approved"
    | "consumed"
    | "denied"
    | "revoked"
    | "expired"
    | "canceled";
  activationUrl: string | null;
  expiresAt: string;
}

export const actionGrantAccess = (
  context: CustodyContext,
  referenceId: string
) => ({
  referenceId,
  backendId: context.backend.id,
  deploymentBaseUrl: context.backend.baseUrl,
  deviceCredentialId: context.upstreamDeviceCredentialId ?? "",
  ...(context.localOwnerUserId
    ? { localOwnerUserId: context.localOwnerUserId }
    : {}),
  principalUserId: context.principalUserId
});

export const ambiguousActionGrantUntil = (
  now: () => Date,
  ambiguousResponseWindowMs: number
): string =>
  new Date(now().getTime() + ambiguousResponseWindowMs).toISOString();

export const persistRemoteActionGrantStatus = (
  koedHome: string,
  context: CustodyContext,
  status: ActionGrantRemoteStatus,
  now: () => Date
): void => {
  const common = {
    ...actionGrantAccess(context, status.actionGrant.id),
    approvalTier: status.approvalTier,
    review: status.review,
    expiresAt: status.expiresAt
  };
  if (status.state === "pending" || status.state === "review_required") {
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      { ...common, state: status.state, activationUrl: status.activationUrl },
      { now }
    );
    return;
  }
  if (status.state === "approved") {
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      { ...common, state: "approved" },
      { now }
    );
    return;
  }
  updateCollaborationActionGrantCustodyStatus(
    koedHome,
    {
      ...common,
      state: status.state
    },
    { now }
  );
};

export const persistAmbiguousActionGrantStatus = (
  koedHome: string,
  context: CustodyContext,
  status: Pick<
    ActionGrantRemoteStatus,
    "actionGrant" | "approvalTier" | "review" | "activationUrl"
  > & { state: "pending" | "review_required" | "approved" },
  now: () => Date,
  ambiguousResponseWindowMs: number
): void => {
  const common = {
    ...actionGrantAccess(context, status.actionGrant.id),
    approvalTier: status.approvalTier,
    review: status.review,
    ambiguousUntil: ambiguousActionGrantUntil(now, ambiguousResponseWindowMs)
  };
  if (status.state === "pending" || status.state === "review_required") {
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      { ...common, state: status.state, activationUrl: status.activationUrl },
      { now }
    );
    return;
  }
  updateCollaborationActionGrantCustodyStatus(
    koedHome,
    {
      ...common,
      state: "approved"
    },
    { now }
  );
};
