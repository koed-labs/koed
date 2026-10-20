import type { ChatDeleteReviewReservation } from "./chat-delete-native-client.js";

type Prepared = {
  reservation: ChatDeleteReviewReservation;
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

/** Renderer provides IDs only; the OS process owns review and device confirmation. */
export const reviewChatDeletion = async <Status>(input: {
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
    throw new Error("Conversation deletion review reservation changed.");
  const grant = await input.awaitGrant();
  if (
    grant.actionGrant.id !== input.actionGrantId ||
    grant.approvalTier !== "native_review" ||
    !["review_required", "approved"].includes(grant.state)
  )
    throw new Error("Conversation deletion review identity changed.");
  if (grant.state === "review_required") {
    if (!grant.review)
      throw new Error("Conversation deletion review details are unavailable.");
    const accepted = await input.showReview(grant.review);
    await input.assertAuthority(first.authorityKey, first.ownerId);
    const fresh = await input.prepare();
    if (
      fresh.authorityKey !== first.authorityKey ||
      fresh.ownerId !== first.ownerId ||
      Object.keys(first.reservation).some(
        (key) =>
          fresh.reservation[key as keyof ChatDeleteReviewReservation] !==
          first.reservation[key as keyof ChatDeleteReviewReservation]
      )
    )
      throw new Error("Conversation deletion review reservation changed.");
    const confirmed = await input.confirmGrant(accepted ? "approve" : "cancel");
    if (
      confirmed.actionGrant.id !== input.actionGrantId ||
      (accepted
        ? confirmed.state !== "approved"
        : confirmed.state !== "canceled")
    )
      throw new Error(
        "Conversation deletion review decision was not acknowledged."
      );
  }
  await input.assertAuthority(first.authorityKey, first.ownerId);
  return input.advance();
};
