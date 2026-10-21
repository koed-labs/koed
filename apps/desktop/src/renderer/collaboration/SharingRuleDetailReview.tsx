import { useEffect, useRef, useState } from "react";
import type {
  SharedMemoryFidelityCeiling,
  SharingRuleDetailReview,
  SharingRuleDelivery
} from "@koed/shared";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import { failureMessage } from "./collaboration-primitives.js";

export type RuleDetailClient = Pick<
  CollaborationRendererClient,
  "reviewRuleDetail" | "amendRuleDetail"
>;
const label = (detail: SharedMemoryFidelityCeiling) =>
  detail === "memory_events"
    ? "Memory Events"
    : detail === "lcm_leaves"
      ? "LCM Leaves"
      : "LCM Rollups";

export function SharingRuleDetailReview({
  client,
  ruleId,
  teamId,
  workspaceId,
  maximumFidelity,
  includeCuratedMemory,
  disabled = false,
  onDelivery
}: {
  client: RuleDetailClient;
  ruleId: string;
  teamId: string;
  workspaceId: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  disabled?: boolean;
  onDelivery: (delivery: SharingRuleDelivery) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [detail, setDetail] = useState(maximumFidelity),
    [curated, setCurated] = useState(includeCuratedMemory);
  const [review, setReview] = useState<SharingRuleDetailReview | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setOpen(false);
    setBusy(false);
    setError("");
    setReview(null);
    setDetail(maximumFidelity);
    setCurated(includeCuratedMemory);
    return () => {
      epoch.current++;
    };
  }, [ruleId, teamId, workspaceId, maximumFidelity, includeCuratedMemory]);
  const loadReview = async () => {
    const current = epoch.current;
    setBusy(true);
    setError("");
    try {
      const next = await client.reviewRuleDetail({
        ruleId,
        teamId,
        workspaceId,
        maximumFidelity: detail,
        includeCuratedMemory: curated
      });
      if (current === epoch.current) setReview(next);
    } catch (cause) {
      if (current === epoch.current)
        setError(
          failureMessage(
            cause,
            "The rule or policy changed. Refresh sharing and review the detail again."
          )
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (!review) return;
    const current = epoch.current;
    setBusy(true);
    setError("");
    try {
      const delivery = await client.amendRuleDetail({
        operationKind: "detail",
        mutationId: crypto.randomUUID(),
        ruleId,
        teamId,
        workspaceId,
        review
      });
      // The parent records delivery even if this detail panel was closed meanwhile.
      onDelivery(delivery);
      if (current === epoch.current) {
        setOpen(false);
        setReview(null);
      }
    } catch (cause) {
      if (current === epoch.current) {
        setReview(null);
        setError(
          failureMessage(
            cause,
            "The change was not confirmed. Review the current rule and policy again."
          )
        );
      }
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  if (!open)
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        Change rule detail
      </button>
    );
  return (
    <section aria-label="Change rule detail">
      <h4>Change this rule’s shared detail</h4>
      <p>
        This change applies to the whole rule, including existing and future
        eligible Conversations. Other sharing reasons keep their permissions.
      </p>
      {review ? (
        <>
          <p>
            {review.teamName} · {review.workspaceName}
          </p>
          <p>
            {label(review.previousMaximumFidelity)} →{" "}
            {label(review.maximumFidelity)}
            {review.includeCuratedMemory
              ? " with Curated Memory"
              : " without Curated Memory"}
            .
          </p>
          <p>
            {review.memberCount} existing members. Rule remains {review.state}.
          </p>
          {review.ownerPolicyExpansionCount > 0 ? (
            <p>
              Owner permission also broadens for{" "}
              {review.ownerPolicyExpansionCount} existing members.
            </p>
          ) : null}
          <p>
            Reductions restrict this rule when Team acknowledges the change.
            Publication of newly permitted content may take time.
          </p>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void confirm()}
          >
            {review.disclosureIncrease
              ? "Review increased sharing"
              : "Confirm rule detail"}
          </button>
          <button type="button" disabled={busy} onClick={() => setReview(null)}>
            Edit detail
          </button>
        </>
      ) : (
        <>
          <label>
            Shared detail{" "}
            <select
              value={detail}
              disabled={busy}
              onChange={(event) =>
                setDetail(event.target.value as SharedMemoryFidelityCeiling)
              }
            >
              <option value="lcm_rollups">LCM Rollups</option>
              <option value="lcm_leaves">LCM Leaves</option>
              <option value="memory_events">Memory Events</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={curated}
              disabled={busy}
              onChange={(event) => setCurated(event.target.checked)}
            />{" "}
            Include Curated Memory
          </label>
          <button
            type="button"
            disabled={
              busy ||
              disabled ||
              (detail === maximumFidelity && curated === includeCuratedMemory)
            }
            onClick={() => void loadReview()}
          >
            Review detail change
          </button>
        </>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setOpen(false);
          setReview(null);
          setError("");
        }}
      >
        Cancel
      </button>
      {busy ? (
        <p role="status">
          {review
            ? "Waiting for approval and Team delivery…"
            : "Reviewing current rule and policy…"}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
