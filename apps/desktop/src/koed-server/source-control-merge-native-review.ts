import type { MessageBoxOptions } from "electron";
import type { SourceControlV2Result } from "@koed/shared/source-control-v2";

type Prepared = Extract<
  SourceControlV2Result,
  { kind: "review_request_merge_prepared" }
>;

/** The same exact operation is reviewed for every Conversation permission mode. */
export const sourceControlMergeReviewOptions = (
  prepared: Prepared
): MessageBoxOptions => {
  const review = prepared.readiness;
  return {
    type: "warning",
    title: "Review pull request merge",
    message: `Merge ${review.repository} #${review.reviewRequestNumber}?`,
    detail: [
      review.title,
      `Account: ${review.accountLabel}`,
      `Target: ${review.targetBranch}`,
      `Head: ${review.expectedHeadObjectId}`,
      `Method: ${review.mergeMethod}`,
      `Checks (${review.checks.length}):`,
      ...review.checks.map(
        (check) =>
          `  ${check.required ? "Required" : "Other"}: ${check.name} · ${check.state} · ${check.source} #${check.id}`
      ),
      `Reviews (${review.reviews.length}; ${review.approvedReviewCount} of ${review.requiredReviewCount} required):`,
      ...review.reviews.map(
        (item) =>
          `  ${item.user}: ${item.state} · ${item.commitObjectId.slice(0, 12)} · #${item.id}`
      ),
      `Readiness: ${prepared.readinessSnapshotDigest}`,
      `Expires: ${prepared.expiresAt}`
    ].join("\n"),
    buttons: ["Cancel", "Merge"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
};
