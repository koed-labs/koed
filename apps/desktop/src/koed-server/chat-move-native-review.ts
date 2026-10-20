import type { ChatMoveReviewReservation } from "./chat-move-native-client.js";

type Prepared = {
  reservation: ChatMoveReviewReservation;
  authorityKey: string;
  ownerId: string;
};

type Review = {
  title: string;
  description: string;
  details: { label: string; value: string }[];
  consequence: string;
};

type GrantStatus = {
  actionGrant: { id: string };
  approvalTier: string;
  state: string;
  review: Review | null;
};

const reservationFields = [
  "sessionId",
  "batchId",
  "bindingId",
  "commandRequestId",
  "oldProjectId",
  "oldWorkspaceProjectId",
  "oldProjectVersion",
  "targetProjectId",
  "mappingVersion",
  "backendId",
  "logicalMemoryId",
  "teamId",
  "teamWorkspaceId",
  "shareGrantId",
  "actionGrantId",
  "reviewedGrantVersion",
  "manifestHash"
] as const satisfies readonly (keyof ChatMoveReviewReservation)[];

const sameReservation = (
  first: ChatMoveReviewReservation,
  fresh: ChatMoveReviewReservation
) => reservationFields.every((field) => first[field] === fresh[field]);

const sameReview = (first: Review, fresh: Review) =>
  first.title === fresh.title &&
  first.description === fresh.description &&
  first.consequence === fresh.consequence &&
  first.details.length === fresh.details.length &&
  first.details.every(
    (detail, index) =>
      detail.label === fresh.details[index]?.label &&
      detail.value === fresh.details[index]?.value
  );

const assertGrant = (
  grant: GrantStatus,
  actionGrantId: string,
  state: "review_required" | "approved"
) => {
  if (
    grant.actionGrant.id !== actionGrantId ||
    grant.approvalTier !== "native_review" ||
    grant.state !== state
  )
    throw new Error("Conversation move Native review grant changed.");
};

/** Renderer supplies IDs only; the OS process owns review and confirmation. */
export const reviewChatMove = async <Status>(input: {
  sessionId: string;
  batchId: string;
  actionGrantId: string;
  prepare: () => Promise<Prepared>;
  assertAuthority: (key: string, ownerId: string) => Promise<void>;
  awaitGrant: () => Promise<GrantStatus>;
  showReview: (review: Review) => Promise<boolean>;
  confirmGrant: (decision: "approve" | "cancel") => Promise<GrantStatus>;
  advance: () => Promise<Status>;
}): Promise<Status> => {
  const first = await input.prepare();
  if (
    first.reservation.sessionId !== input.sessionId ||
    first.reservation.batchId !== input.batchId ||
    first.reservation.actionGrantId !== input.actionGrantId
  )
    throw new Error("Conversation move review reservation changed.");
  await input.assertAuthority(first.authorityKey, first.ownerId);
  const grant = await input.awaitGrant();
  if (grant.state === "approved") {
    assertGrant(grant, input.actionGrantId, "approved");
  } else {
    assertGrant(grant, input.actionGrantId, "review_required");
    if (!grant.review)
      throw new Error("Conversation move review details are unavailable.");
    const accepted = await input.showReview(grant.review);
    await input.assertAuthority(first.authorityKey, first.ownerId);
    const fresh = await input.prepare();
    if (
      fresh.authorityKey !== first.authorityKey ||
      fresh.ownerId !== first.ownerId ||
      !sameReservation(first.reservation, fresh.reservation)
    )
      throw new Error("Conversation move review reservation changed.");
    const currentGrant = await input.awaitGrant();
    assertGrant(currentGrant, input.actionGrantId, "review_required");
    if (!currentGrant.review || !sameReview(grant.review, currentGrant.review))
      throw new Error("Conversation move review details changed.");
    await input.assertAuthority(first.authorityKey, first.ownerId);
    const confirmed = await input.confirmGrant(accepted ? "approve" : "cancel");
    if (
      confirmed.actionGrant.id !== input.actionGrantId ||
      confirmed.approvalTier !== "native_review" ||
      confirmed.state !== (accepted ? "approved" : "canceled")
    )
      throw new Error(
        "Conversation move review decision was not acknowledged."
      );
  }
  await input.assertAuthority(first.authorityKey, first.ownerId);
  return input.advance();
};
