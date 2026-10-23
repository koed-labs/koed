import type { SharingRuleDelivery } from "@koed/shared/collaboration";

const requestLabel = (intent: SharingRuleDelivery["intent"]) => {
  if ("scope" in intent)
    return "restoration" in intent ? "Remove exclusion" : "Workspace exclusion";
  if ("operationKind" in intent)
    return intent.operationKind === "publisher_takeover"
      ? "Publisher transfer"
      : intent.operationKind === "detail"
        ? "Rule detail change"
        : "Content policy change";
  if (!("controlAction" in intent))
    return "snapshotConversion" in intent && intent.snapshotConversion
      ? "Snapshot conversion"
      : "Continuous sharing";
  return {
    stop: "Stop",
    pause: "Pause",
    resume: "Resume",
    retry: "Catch-up retry"
  }[intent.controlAction];
};

export function SharingRuleDeliveryStatus({
  deliveries,
  onRefresh
}: {
  deliveries: SharingRuleDelivery[];
  onRefresh: () => void;
}) {
  const pending = deliveries.filter(
    (delivery) => delivery.state !== "acknowledged"
  );
  if (pending.length === 0) return null;
  return (
    <section
      className="collab-rule-delivery-status"
      aria-label="Recent sharing requests"
    >
      <h2>Recent sharing requests</h2>
      {pending.map((delivery) => (
        <article key={delivery.intent.mutationId}>
          <strong>{delivery.presentation.sourceTitle}</strong>
          <p>
            {delivery.presentation.teamName} ·{" "}
            {delivery.presentation.workspaceName}
          </p>
          <p role={delivery.state === "queued" ? "status" : "alert"}>
            {delivery.state === "queued" &&
            delivery.failureCode === "source_unavailable"
              ? "The verified Conversation source is unavailable on this device. This request remains pending until its source is available."
              : delivery.state === "queued"
                ? `${requestLabel(delivery.intent)} requested here. Waiting for Team acknowledgment.${"restoration" in delivery.intent ? " The exclusion remains in effect until acknowledged." : ""}${("scope" in delivery.intent && !("restoration" in delivery.intent)) || ("controlAction" in delivery.intent && delivery.intent.controlAction === "stop") || ("operationKind" in delivery.intent && delivery.intent.operationKind === "content_policy") ? " Team access may remain until acknowledged." : ""}`
                : `Team acknowledgment could not be confirmed. Refresh sharing and review the ${"scope" in delivery.intent ? "exclusion" : "rule"} again.`}
          </p>
          {delivery.state === "needs_review" ? (
            <button type="button" onClick={onRefresh}>
              Refresh sharing
            </button>
          ) : null}
        </article>
      ))}
      {deliveries.length >= 100 ? (
        <p>Showing recent requests and requests for the open Share.</p>
      ) : null}
    </section>
  );
}
