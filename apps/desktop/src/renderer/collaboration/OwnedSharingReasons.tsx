import type { ReactNode } from "react";
import type {
  OwnedSharingReason,
  SharingRuleDelivery,
  ConversationSharingRuleControlIntent,
  SharedMemoryRepresentation
} from "@koed/shared/collaboration";

const updateLabel: Record<OwnedSharingReason["updateState"], string> = {
  fixed_snapshot: "Fixed snapshot",
  active: "Updates active",
  paused: "Updates paused",
  stopped: "Stopped",
  expired: "Consent expired",
  pending: "Publication pending"
};

export function OwnedSharingReasons({
  reasons,
  pending,
  representationLabel,
  deliveries = [],
  busy = false,
  workspaceExcluded = false,
  onControl,
  detailReview
}: {
  reasons: OwnedSharingReason[];
  detailReview?: (reason: OwnedSharingReason, queued: boolean) => ReactNode;
  deliveries?: SharingRuleDelivery[];
  busy?: boolean;
  workspaceExcluded?: boolean;
  onControl?: (
    reason: OwnedSharingReason,
    action: ConversationSharingRuleControlIntent["controlAction"]
  ) => void;
  pending: boolean;
  representationLabel: (representation: SharedMemoryRepresentation) => string;
}) {
  return (
    <section className="collab-sharing-reasons" aria-label="Sharing reasons">
      {reasons.length === 0 ? (
        <p>{pending ? "Preparing share" : "No published sharing reasons"}</p>
      ) : (
        <ul className="collab-sharing-reason-list">
          {reasons.map((reason) => {
            const delivery = deliveries.find(
              (item) =>
                ("snapshotConversion" in item.intent &&
                  item.intent.snapshotConversion?.reasonId === reason.id &&
                  item.intent.snapshotConversion.consentId ===
                    reason.consentId) ||
                ("ruleId" in item.intent &&
                  item.intent.ruleId === reason.rule?.id &&
                  (!("reasonId" in item.intent) ||
                    item.intent.reasonId === reason.id))
            );
            const queued = delivery?.state === "queued";
            const expired =
              reason.updateState === "expired" ||
              (reason.expiresAt !== null &&
                Date.parse(reason.expiresAt) <= Date.now());
            const publicationRevision = reason.publishedRepresentations.length
              ? Math.max(
                  ...reason.publishedRepresentations.map(
                    (entry) => entry.sourceRevision
                  )
                )
              : null;
            const allowedDetail = (
              ["memory_events", "lcm_leaves", "lcm_rollups"] as const
            ).find((detail) =>
              reason.permittedRepresentations.includes(detail)
            );
            const curated =
              reason.permittedRepresentations.includes("curated_assertions");
            const state = workspaceExcluded
              ? "Excluded"
              : expired
                ? "Consent expired"
                : updateLabel[reason.updateState];
            const waiting = queued
              ? "controlAction" in delivery.intent &&
                delivery.intent.controlAction === "stop"
                ? "Stop pending"
                : "Change pending"
              : delivery?.state === "needs_review"
                ? "Needs review"
                : null;
            const catchUp =
              !workspaceExcluded && !expired && reason.updateState === "active"
                ? reason.rule?.catchUpState === "needs_attention"
                  ? "Needs attention"
                  : reason.rule?.catchUpState === "queued"
                    ? reason.rule.failureCode === "source_not_ready"
                      ? "Waiting for content"
                      : "Catching up"
                    : null
                : null;
            return (
              <li key={reason.id}>
                <div className="collab-sharing-reason-row">
                  <strong>
                    {reason.kind === "direct"
                      ? "Direct share"
                      : reason.rule?.selectorKind === "folder"
                        ? "Folder sharing rule"
                        : reason.rule?.selectorKind === "project"
                          ? "Project sharing rule"
                          : reason.rule?.selectorKind === "repository"
                            ? "Git Anchor sharing rule"
                            : "Conversation sharing rule"}
                  </strong>
                  <span className="collab-sharing-reason-detail">
                    {allowedDetail
                      ? representationLabel(allowedDetail)
                      : curated
                        ? "Curated Memory"
                        : "No permitted detail"}
                    {allowedDetail && curated ? " + Curated Memory" : ""}
                    {publicationRevision !== null ? (
                      <small
                        aria-label={`Published source revision ${publicationRevision}`}
                      >
                        {" "}
                        · r{publicationRevision}
                      </small>
                    ) : null}
                  </span>
                  <span className="collab-sharing-reason-state">
                    <span>{waiting ? state : (catchUp ?? state)}</span>
                    {waiting ? (
                      <span role={queued ? "status" : "alert"}>{waiting}</span>
                    ) : null}
                  </span>
                </div>
                {detailReview?.(reason, queued)}
                {onControl && reason.rule && reason.rule.state !== "stopped" ? (
                  <div
                    className="collab-share-header-actions"
                    aria-label="Control this sharing rule"
                  >
                    {!expired && reason.rule.state === "active" ? (
                      <button
                        type="button"
                        disabled={busy || queued || workspaceExcluded}
                        onClick={() => onControl(reason, "pause")}
                      >
                        Pause updates
                      </button>
                    ) : null}
                    {!expired && reason.rule.state === "paused" ? (
                      <button
                        type="button"
                        disabled={busy || queued || workspaceExcluded}
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
                        disabled={busy || queued || workspaceExcluded}
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
