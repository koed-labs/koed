import type { ReactNode } from "react";
import type {
  ConversationSharingRuleControlIntent,
  OwnedSharingReason,
  SharingRuleDelivery
} from "@koed/shared";

export const ownedSharingReasonChangePending = (
  reason: OwnedSharingReason,
  deliveries: SharingRuleDelivery[]
) =>
  deliveries.some(
    (delivery) =>
      delivery.state === "queued" &&
      (("ruleId" in delivery.intent &&
        delivery.intent.ruleId === reason.rule?.id &&
        (!("reasonId" in delivery.intent) ||
          delivery.intent.reasonId === reason.id)) ||
        ("snapshotConversion" in delivery.intent &&
          delivery.intent.snapshotConversion?.reasonId === reason.id &&
          delivery.intent.snapshotConversion.consentId === reason.consentId))
  );

export const ownedSharingRuleTitle = (reason: OwnedSharingReason) =>
  reason.rule?.selectorKind === "folder"
    ? "Folder sharing rule"
    : reason.rule?.selectorKind === "project"
      ? "Project sharing rule"
      : reason.rule?.selectorKind === "repository"
        ? "Git Anchor sharing rule"
        : "Conversation sharing rule";

export function OwnedShareRules({
  reasons,
  deliveries,
  busy,
  workspaceExcluded,
  onControl,
  detailReview
}: {
  reasons: OwnedSharingReason[];
  deliveries: SharingRuleDelivery[];
  busy: boolean;
  workspaceExcluded: boolean;
  onControl: (
    reason: OwnedSharingReason,
    action: ConversationSharingRuleControlIntent["controlAction"]
  ) => void;
  detailReview: (reason: OwnedSharingReason, queued: boolean) => ReactNode;
}) {
  return reasons.map((reason) => {
    const queued = ownedSharingReasonChangePending(reason, deliveries);
    if (!reason.rule) {
      const controls = detailReview(reason, queued);
      return controls ? (
        <details className="collab-sharing-disclosure" key={reason.id}>
          <summary>Snapshot controls</summary>
          {controls}
        </details>
      ) : null;
    }
    const expired =
      reason.updateState === "expired" ||
      (reason.expiresAt !== null && Date.parse(reason.expiresAt) <= Date.now());
    const disabled = busy || queued;
    const active = !expired && reason.rule.state === "active";
    const paused = !expired && reason.rule.state === "paused";
    return (
      <section
        className="collab-owned-rule"
        key={reason.id}
        aria-label={`Manage sharing rule ${reason.id}`}
      >
        <div className="collab-sharing-control-row">
          <span className={`collab-sharing-state ${active ? "active" : ""}`}>
            {workspaceExcluded
              ? "Blocked by exclusion"
              : queued
                ? "Change awaiting acknowledgment"
                : expired
                  ? "Consent expired"
                  : paused
                    ? "Updates paused"
                    : active
                      ? "Sharing updates"
                      : "Stopped"}
          </span>
          {active || paused ? (
            <button
              type="button"
              className="secondary"
              disabled={disabled || workspaceExcluded}
              onClick={() => onControl(reason, paused ? "resume" : "pause")}
            >
              {paused ? "Resume updates" : "Pause updates"}
            </button>
          ) : null}
        </div>
        <div className="collab-sharing-control-row collab-sharing-rule-heading">
          <div>
            <h3>{ownedSharingRuleTitle(reason)}</h3>
            <small>
              {reason.rule.selectorKind === "captured_session"
                ? "This Conversation"
                : "Existing & future Conversations"}
            </small>
          </div>
        </div>
        {queued ? (
          <p role="status" className="collab-form-context">
            Waiting for Team acknowledgment. Current access remains until
            acknowledged.
          </p>
        ) : null}
        {detailReview(reason, queued)}
      </section>
    );
  });
}
