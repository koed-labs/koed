import { projectSourceRemovalStatusSchema } from "@koed/shared/project-source-contract";
import type { z } from "zod";

type ProjectSourceRemovalStatus = z.infer<
  typeof projectSourceRemovalStatusSchema
>;

type Reservation = {
  batchId: string;
  sourceId: string;
  backendId: string;
  shareGrantId: string;
  actionGrantId: string;
  reviewedGrantVersion: number;
};
type Prepared = {
  reservation: Reservation;
  authorityKey: string;
  ownerId: string;
};
type Review = {
  title: string;
  description: string;
  details: { label: string; value: string }[];
  consequence: string;
};
type Status = {
  actionGrant: { id: string };
  approvalTier: string;
  state: string;
  review: Review | null;
};

// The renderer supplies identities only. The native process obtains the exact
// reserved review, asks the enrolled-device broker, and owns the OS decision.
export const reviewProjectSourceRemoval = async (input: {
  projectId: string;
  sourceId: string;
  batchId: string;
  actionGrantId: string;
  prepare: () => Promise<Prepared>;
  assertAuthority: (key: string, ownerId: string) => Promise<void>;
  awaitGrant: () => Promise<Status>;
  showReview: (review: Review) => Promise<boolean>;
  confirmGrant: (decision: "approve" | "cancel") => Promise<Status>;
  advance: () => Promise<ProjectSourceRemovalStatus>;
}): Promise<ProjectSourceRemovalStatus> => {
  const first = await input.prepare();
  if (
    first.reservation.batchId !== input.batchId ||
    first.reservation.sourceId !== input.sourceId ||
    first.reservation.actionGrantId !== input.actionGrantId
  )
    throw new Error("Project Source Native review reservation changed.");
  const status = await input.awaitGrant();
  if (
    status.actionGrant.id !== input.actionGrantId ||
    status.approvalTier !== "native_review" ||
    (status.state !== "review_required" && status.state !== "approved")
  )
    throw new Error("Project Source Native review identity changed.");
  if (status.state === "review_required") {
    if (!status.review)
      throw new Error("Project Source Native review details are unavailable.");
    const accepted = await input.showReview(status.review);
    await input.assertAuthority(first.authorityKey, first.ownerId);
    const fresh = await input.prepare();
    if (
      fresh.authorityKey !== first.authorityKey ||
      fresh.ownerId !== first.ownerId ||
      fresh.reservation.batchId !== first.reservation.batchId ||
      fresh.reservation.sourceId !== first.reservation.sourceId ||
      fresh.reservation.backendId !== first.reservation.backendId ||
      fresh.reservation.shareGrantId !== first.reservation.shareGrantId ||
      fresh.reservation.actionGrantId !== first.reservation.actionGrantId ||
      fresh.reservation.reviewedGrantVersion !==
        first.reservation.reviewedGrantVersion
    )
      throw new Error("Project Source Native review reservation changed.");
    const confirmed = await input.confirmGrant(accepted ? "approve" : "cancel");
    if (
      confirmed.actionGrant.id !== input.actionGrantId ||
      (accepted && confirmed.state !== "approved") ||
      (!accepted && confirmed.state !== "canceled")
    )
      throw new Error(
        "Project Source Native review decision was not acknowledged."
      );
  }
  await input.assertAuthority(first.authorityKey, first.ownerId);
  return input.advance();
};
