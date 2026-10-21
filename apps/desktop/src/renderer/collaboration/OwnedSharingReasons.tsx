import type { ReactNode } from "react";
import type {
  OwnedSharingReason,
  SharingRuleDelivery,
  ConversationSharingRuleControlIntent,
  SharedMemoryRepresentation
} from "@koed/shared/collaboration";

const updateExplanation: Record<OwnedSharingReason["updateState"], string> = {
  fixed_snapshot: "Fixed snapshot. Later content is not included.",
  active: "Updates active for this Conversation only.",
  paused: "Updates paused. Previously authorized content remains shared.",
  stopped: "Sharing stopped. This reason no longer grants access.",
  expired: "Consent expired. This reason no longer grants access.",
  pending: "Publication pending. Content becomes available after processing."
};

export function OwnedSharingReasons({
  reasons,
  pending,
  representationLabel,
  deliveries = [],
  busy = false,
  onControl,
  detailReview
}: {
  reasons: OwnedSharingReason[];
  detailReview?: (reason: OwnedSharingReason, queued: boolean) => ReactNode;
  deliveries?: SharingRuleDelivery[];
  busy?: boolean;
  onControl?: (
    reason: OwnedSharingReason,
    action: ConversationSharingRuleControlIntent["controlAction"]
  ) => void;

  pending: boolean;
  representationLabel: (representation: SharedMemoryRepresentation) => string;
}) {
  return (
    <section
      className="collab-sharing-reasons"
      aria-label="Why this Conversation is shared"
    >
      <h3>Why this Conversation is shared</h3>
      {reasons.length === 0 ? (
        <p>
          {pending
            ? "Preparing a direct share. No Workspace content access has been granted yet."
            : "No published sharing reason."}
        </p>
      ) : (
        reasons.map((reason) => {
          const delivery = deliveries.find(
            (item) =>
              item.intent.ruleId === reason.rule?.id &&
              (!("reasonId" in item.intent) ||
                item.intent.reasonId === reason.id)
          );
          const queued = delivery?.state === "queued";
          const expired =
            reason.updateState === "expired" ||
            (reason.expiresAt !== null &&
              Date.parse(reason.expiresAt) <= Date.now());
          return (
            <div key={reason.id}>
              <p>
                <strong>
                  {reason.kind === "rule"
                    ? reason.rule?.selectorKind === "folder"
                      ? "Folder sharing rule"
                      : reason.rule?.selectorKind === "project"
                        ? "Project sharing rule"
                        : reason.rule?.selectorKind === "repository"
                          ? "Git Anchor sharing rule"
                          : "Continuous sharing rule"
                    : "Direct share"}
                </strong>{" "}
                ·{" "}
                {reason.updateState === "active" &&
                reason.rule?.selectorKind === "folder"
                  ? "Updates active for eligible Conversations in this exact Folder."
                  : reason.updateState === "active" &&
                      reason.rule?.selectorKind === "project"
                    ? "Updates active while this Conversation remains in the private Project."
                    : reason.updateState === "active" &&
                        reason.rule?.selectorKind === "repository"
                      ? "Updates active for eligible Conversations matching this Git Anchor."
                      : updateExplanation[reason.updateState]}
              </p>
              <p>
                Consent permits{" "}
                {reason.permittedRepresentations
                  .map(representationLabel)
                  .join(", ") || "no representations"}
                .
                {reason.maximumAuthorizedSourceRevision !== null
                  ? ` Limited to source revision ${reason.maximumAuthorizedSourceRevision}.`
                  : " Future eligible revisions are permitted while updates are active."}
              </p>
              {reason.rule?.catchUpState === "needs_attention" ? (
                <p>
                  Catch-up needs attention. Automatic retries continue while
                  authority remains valid.
                </p>
              ) : reason.rule?.catchUpState === "queued" ? (
                <p>
                  {reason.rule.failureCode === "source_not_ready"
                    ? "Waiting for eligible source content. Catch-up will retry automatically."
                    : "Catch-up queued. New content appears after processing."}
                </p>
              ) : null}
              {reason.expiresAt ? (
                <p>
                  Consent expires {new Date(reason.expiresAt).toLocaleString()}.
                </p>
              ) : null}
              <p>
                Approved repository:{" "}
                {reason.repositorySnapshot.label ??
                  reason.repositorySnapshot.classification}
                {reason.repositorySnapshotSourceRevision !== null
                  ? ` · source revision ${reason.repositorySnapshotSourceRevision}`
                  : ""}
                .
              </p>
              {reason.publishedRepresentations.length > 0 ? (
                <p>
                  Published content:{" "}
                  {reason.publishedRepresentations
                    .map(
                      (entry) =>
                        `${representationLabel(entry.representation)} at revision ${entry.sourceRevision}${entry.state === "stale" ? " (stale)" : ""}`
                    )
                    .join(", ")}
                  . Current access and policy still apply.
                </p>
              ) : (
                <p>No content is currently published under this consent.</p>
              )}
              {queued ? (
                <p role="status">
                  {"controlAction" in delivery.intent &&
                  delivery.intent.controlAction === "stop"
                    ? "Stop"
                    : "Sharing change"}{" "}
                  requested here. Waiting for Team acknowledgment.
                  {"controlAction" in delivery.intent &&
                  delivery.intent.controlAction === "stop"
                    ? " Team access may remain until acknowledged."
                    : " Current Team state is shown above."}
                </p>
              ) : delivery?.state === "needs_review" ? (
                <p role="alert">
                  Team acknowledgment could not be confirmed. Refresh and review
                  this rule again.
                </p>
              ) : null}
              {reason.rule ? detailReview?.(reason, queued) : null}
              {onControl && reason.rule && reason.rule.state !== "stopped" ? (
                <div
                  className="collab-share-header-actions"
                  aria-label="Control this sharing rule"
                >
                  {!expired && reason.rule.state === "active" ? (
                    <button
                      type="button"
                      disabled={busy || queued}
                      onClick={() => onControl(reason, "pause")}
                    >
                      Pause updates
                    </button>
                  ) : null}
                  {!expired && reason.rule.state === "paused" ? (
                    <button
                      type="button"
                      disabled={busy || queued}
                      onClick={() => onControl(reason, "resume")}
                    >
                      Resume updates
                    </button>
                  ) : null}
                  {!expired &&
                  reason.rule.state === "active" &&
                  reason.rule.catchUpState === "needs_attention" ? (
                    <button
                      type="button"
                      disabled={busy || queued}
                      onClick={() => onControl(reason, "retry")}
                    >
                      Retry catch-up
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="danger-secondary"
                    disabled={busy || queued}
                    onClick={() => onControl(reason, "stop")}
                  >
                    Stop this rule
                  </button>
                </div>
              ) : null}
              <p>Conversation Source Access requires separate authorization.</p>
            </div>
          );
        })
      )}
    </section>
  );
}
