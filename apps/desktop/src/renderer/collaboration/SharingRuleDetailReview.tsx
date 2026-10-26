import { useEffect, useRef, useState } from "react";
import type {
  SharedMemoryFidelityCeiling,
  SharingRuleDetailReview,
  SharingRuleDelivery
} from "@koed/shared";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import {
  Modal,
  ModalHeader,
  failureMessage
} from "./collaboration-primitives.js";
import {
  SharingDetailChoices,
  SharingRow,
  sharingDetailTitle
} from "./SharingControls.js";

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
  trigger = "button",
  onDelivery
}: {
  client: RuleDetailClient;
  ruleId: string;
  teamId: string;
  workspaceId: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  disabled?: boolean;
  trigger?: "button" | "row";
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
  const close = () => {
    epoch.current++;
    setOpen(false);
    setReview(null);
    setError("");
    setBusy(false);
  };
  if (!open && trigger === "row")
    return (
      <SharingRow
        label="Shared detail"
        value={sharingDetailTitle(maximumFidelity)}
        disabled={disabled}
        onClick={() => setOpen(true)}
      />
    );
  if (!open)
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        Change rule detail
      </button>
    );
  return (
    <Modal
      label="Change rule detail"
      className="collab-sharing-modal collab-rule-detail-modal"
      onClose={close}
    >
      <ModalHeader title="Change shared detail" onClose={close} />
      <section
        className="collab-form collab-sharing-form"
        aria-label="Change rule detail"
      >
        <p className="collab-form-context">
          Applies to this whole rule · Existing & future Conversations
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
              {review.memberCount} existing members. Rule remains {review.state}
              .
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
          </>
        ) : (
          <>
            <SharingDetailChoices
              value={detail}
              disabled={busy}
              onChange={setDetail}
            />
            <label className="collab-check">
              <input
                type="checkbox"
                checked={curated}
                disabled={busy}
                onChange={(event) => setCurated(event.target.checked)}
              />{" "}
              Include Curated Memory
            </label>
          </>
        )}
        {busy ? (
          <p role="status">
            {review
              ? "Waiting for approval and Team delivery…"
              : "Reviewing current rule and policy…"}
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <footer className="collab-modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          {review ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Edit detail
            </button>
          ) : null}
          <button
            type="button"
            disabled={
              busy ||
              disabled ||
              (!review &&
                detail === maximumFidelity &&
                curated === includeCuratedMemory)
            }
            onClick={() => void (review ? confirm() : loadReview())}
          >
            {review
              ? review.disclosureIncrease
                ? "Review increased sharing"
                : "Confirm rule detail"
              : "Review detail change"}
          </button>
        </footer>
      </section>
    </Modal>
  );
}
