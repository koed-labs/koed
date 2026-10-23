import {
  crossIdentitySyncDigest,
  sharingRulePublisherTakeoverLocalReviewSchema,
  type CollaborationRendererCommand,
  type SharingRulePublisherTakeoverLocalReview,
  type SharingRulePublisherTakeoverReviewInput
} from "@koed/shared";
import type { createSelectionSharingJournal } from "@koed/db";

type SourceReader = ReturnType<
  typeof createSelectionSharingJournal
>["resolvePublisherTakeoverSource"];
type ReviewInput = Extract<
  CollaborationRendererCommand,
  { command: "collaboration.review_publisher_takeover" }
>["input"];

export class PublisherTakeoverReviewError extends Error {
  constructor(readonly code: "not_available" | "permission_denied") {
    super(code);
  }
}

/** The local source pointer and selector never enter the Team request. The
 * backend independently proves that this Personal origin is an existing member. */
export const resolvePublisherTakeoverReview = async (options: {
  input: ReviewInput;
  localOwnerUserId: string;
  receivingCredentialId: string | null;
  readSource: SourceReader;
  requestReview(
    input: SharingRulePublisherTakeoverReviewInput
  ): Promise<unknown>;
}): Promise<SharingRulePublisherTakeoverLocalReview> => {
  if (!options.receivingCredentialId)
    throw new PublisherTakeoverReviewError("permission_denied");
  const { localSessionId, target, workspaceId, ...request } = options.input;
  const source = await options.readSource({
    ownerUserId: options.localOwnerUserId,
    sessionId: localSessionId,
    target
  });
  if (!source) throw new PublisherTakeoverReviewError("not_available");
  if (
    source.source.localSessionId !== localSessionId ||
    source.source.portable?.ownerUserId !== options.localOwnerUserId
  )
    throw new PublisherTakeoverReviewError("permission_denied");
  const response = await options.requestReview({
    ...request,
    teamWorkspaceId: workspaceId,
    sourceIdentity: source.sourceIdentity
  });
  const parsed = sharingRulePublisherTakeoverLocalReviewSchema.safeParse({
    review: response,
    localSource: source.source,
    target: source.target
  });
  if (
    !parsed.success ||
    parsed.data.review.ruleId !== request.ruleId ||
    parsed.data.review.teamId !== request.teamId ||
    parsed.data.review.teamWorkspaceId !== workspaceId ||
    parsed.data.review.expectedAuthorityVersion !==
      request.expectedAuthorityVersion ||
    parsed.data.review.publisherFence !== request.publisherFence ||
    parsed.data.review.receivingPublisher.credentialId !==
      options.receivingCredentialId
  )
    throw new PublisherTakeoverReviewError("permission_denied");
  return parsed.data;
};

/** Approval and delivery re-read current evidence. Context may advance while
 * continuing to match the approved selector; a different origin or local source
 * pointer requires another review. No cursor or baseline is reused here. */
export const verifyPublisherTakeoverLocalEvidence = async (options: {
  review: SharingRulePublisherTakeoverLocalReview;
  localOwnerUserId: string;
  receivingCredentialId: string | null;
  readSource: SourceReader;
}): Promise<boolean> => {
  const parsed = sharingRulePublisherTakeoverLocalReviewSchema.safeParse({
    review: options.review.review,
    localSource: options.review.localSource,
    target: options.review.target
  });
  if (
    !parsed.success ||
    parsed.data.review.receivingPublisher.credentialId !==
      options.receivingCredentialId ||
    parsed.data.localSource.portable?.ownerUserId !== options.localOwnerUserId
  )
    return false;
  const current = await options.readSource({
    ownerUserId: options.localOwnerUserId,
    sessionId: parsed.data.localSource.localSessionId,
    target: parsed.data.target
  });
  return (
    !!current &&
    current.source.localSessionId === parsed.data.localSource.localSessionId &&
    current.source.localLogicalSessionId ===
      parsed.data.localSource.localLogicalSessionId &&
    current.source.portable?.ownerUserId === options.localOwnerUserId &&
    crossIdentitySyncDigest(current.sourceIdentity) ===
      crossIdentitySyncDigest(parsed.data.review.sourceIdentity) &&
    crossIdentitySyncDigest(current.target ?? null) ===
      crossIdentitySyncDigest(parsed.data.target ?? null)
  );
};
