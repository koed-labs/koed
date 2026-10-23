import { useEffect, useRef, useState } from "react";
import {
  noPrivacyLabelsPolicy,
  privacyLabels
} from "@koed/shared/collaboration";
import type {
  PrivacyLabel,
  PrivacyLabelPolicy,
  SharingRuleContentPolicyReview as ContentReview,
  SharingRuleDelivery
} from "@koed/shared";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import { failureMessage } from "./collaboration-primitives.js";

type PolicyClient = Pick<
  CollaborationRendererClient,
  "reviewRuleContentPolicy" | "amendRuleContentPolicy"
>;
const categoryLabels: Record<PrivacyLabel, string> = {
  account_number: "Account numbers",
  private_address: "Private addresses",
  private_email: "Private email addresses",
  private_person: "Private names",
  private_phone: "Private phone numbers",
  private_url: "Private URLs",
  private_date: "Private dates",
  secret: "Secrets"
};
const categories = (labels: PrivacyLabelPolicy) =>
  privacyLabels
    .filter((label) => labels[label])
    .map((label) => categoryLabels[label])
    .join(", ") || "None";

export function SharingRuleContentPolicyReview({
  client,
  ruleId,
  teamId,
  workspaceId,
  authorityVersion,
  disabled = false,
  onDelivery
}: {
  client: PolicyClient;
  ruleId: string;
  teamId: string;
  workspaceId: string;
  authorityVersion: number;
  disabled?: boolean;
  onDelivery: (delivery: SharingRuleDelivery) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [labels, setLabels] = useState(noPrivacyLabelsPolicy);
  const [policyContext, setPolicyContext] = useState<ContentReview | null>(
    null
  );
  const [review, setReview] = useState<ContentReview | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setOpen(false);
    setBusy(false);
    setError("");
    setReview(null);
    setPolicyContext(null);
    setLabels(noPrivacyLabelsPolicy());
    return () => {
      epoch.current++;
    };
  }, [ruleId, teamId, workspaceId, authorityVersion]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(
      () => {
        setReview(null);
        setError("This review expired. Review the current policy again.");
      },
      Math.max(0, Date.parse(review.expiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [review]);

  const load = async (initialize: boolean) => {
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    setReview(null);
    try {
      const next = await client.reviewRuleContentPolicy({
        ruleId,
        teamId,
        workspaceId,
        labels: initialize ? noPrivacyLabelsPolicy() : labels
      });
      if (current !== epoch.current) return;
      setPolicyContext(next);
      // The first read discovers the current mask. Its empty-mask proposal is
      // never offered for approval; the owner reviews their actual draft later.
      if (initialize) setLabels({ ...next.previousLabels });
      else setReview(next);
    } catch (cause) {
      if (current === epoch.current)
        setError(
          failureMessage(
            cause,
            "The rule or policy changed. Refresh sharing and review the policy again."
          )
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (!review || Date.parse(review.expiresAt) <= Date.now()) return;
    const current = epoch.current;
    setBusy(true);
    setError("");
    try {
      const delivery = await client.amendRuleContentPolicy({
        operationKind: "content_policy",
        mutationId: crypto.randomUUID(),
        ruleId,
        teamId,
        workspaceId,
        review
      });
      onDelivery(delivery);
      if (current === epoch.current) {
        setOpen(false);
        setReview(null);
        setPolicyContext(null);
      }
    } catch (cause) {
      if (current === epoch.current) {
        setReview(null);
        setError(
          failureMessage(
            cause,
            "The policy change was not confirmed. Review the current rule again."
          )
        );
      }
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          setPolicyContext(null);
          void load(true);
        }}
      >
        Change content policy
      </button>
    );
  return (
    <section aria-label="Change rule content policy">
      <h4>Change this rule’s content policy</h4>
      <p>
        Choose which Privacy categories this rule hides. The change applies to
        existing and future eligible Memory. Other sharing reasons keep their
        own permissions.
      </p>
      {review ? (
        <>
          <p>
            {review.teamName} · {review.workspaceName}
          </p>
          <p>
            Previous effective redaction:{" "}
            {review.previousEffectiveLabels
              ? categories(review.previousEffectiveLabels)
              : "Previous categories unavailable. Confirmation of increased sharing is required."}
          </p>
          <p>Required redaction: {categories(review.requiredLabels)}.</p>
          <p>Added rule redaction: {categories(review.labels)}.</p>
          <p>New effective redaction: {categories(review.effectiveLabels)}.</p>
          <p>
            {review.memberCount} existing members. Rule remains {review.state}.
            Shared detail limits stay unchanged.
          </p>
          <p>
            Restrictions apply when Team acknowledges this change. Newly
            permitted content may take time to appear.
          </p>
          {review.disclosureIncrease ? (
            <p>
              This policy may share more content. Fresh approval is required.
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void confirm()}
          >
            {review.disclosureIncrease
              ? "Review increased sharing"
              : "Confirm content policy"}
          </button>
          <button type="button" disabled={busy} onClick={() => setReview(null)}>
            Edit categories
          </button>
        </>
      ) : policyContext ? (
        <>
          <p>
            Operator, owner, Team and Workspace requirements remain in effect.
            Required categories cannot be turned off here.
          </p>
          <fieldset disabled={busy || disabled}>
            <legend>Hide these categories</legend>
            {privacyLabels.map((label) => {
              const required = policyContext.requiredLabels[label];
              return (
                <label key={label}>
                  <input
                    type="checkbox"
                    checked={labels[label] || required}
                    disabled={required}
                    onChange={(event) => {
                      setLabels((previous) => ({
                        ...previous,
                        [label]: event.target.checked
                      }));
                      setReview(null);
                    }}
                  />{" "}
                  {categoryLabels[label]}
                  {required ? " (required)" : ""}
                </label>
              );
            })}
          </fieldset>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void load(false)}
          >
            Review content policy
          </button>
        </>
      ) : !busy ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void load(true)}
        >
          Load current policy
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          epoch.current++;
          setOpen(false);
          setReview(null);
          setPolicyContext(null);
          setError("");
        }}
      >
        Cancel
      </button>
      {busy ? (
        <p role="status">
          {review
            ? "Waiting for approval and Team delivery…"
            : "Loading current rule and policy…"}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
