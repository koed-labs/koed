import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HighRiskBrowserActivation } from "../high-risk/schemas.js";

import {
  authenticationRequired,
  decideHighRiskBrowserActivation,
  loadHighRiskBrowserActivation,
  notFound
} from "./api.js";
import { AuthPanel } from "./AuthPanel.js";
import { ApprovalShell, Detail, formatDate, Status } from "./layout.js";

type PageState =
  | HighRiskBrowserActivation["status"]["state"]
  | "loading"
  | "unauthenticated"
  | "unreconciled"
  | "invalid"
  | "unknown"
  | "error";

const terminalStates = new Set<PageState>([
  "approved",
  "consumed",
  "denied",
  "revoked",
  "canceled",
  "expired",
  "unreconciled",
  "invalid",
  "unknown",
  "error"
]);

const autoCloseStates = new Set<PageState>([
  "approved",
  "consumed",
  "denied",
  "revoked",
  "canceled",
  "expired",
  "invalid",
  "unknown"
]);

export function HighRiskActionApproval({
  selector
}: {
  selector: string | null;
}) {
  const [activation, setActivation] =
    useState<HighRiskBrowserActivation | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!selector) {
      setState("unknown");
      setError("Action confirmation is missing.");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const loaded = await loadHighRiskBrowserActivation(selector);
      if (loaded.status.approvalTier !== "step_up" || !loaded.status.review) {
        setActivation(null);
        setState("invalid");
        setError(
          "This confirmation is missing authoritative approval details. No decision was submitted."
        );
        return;
      }
      setActivation(loaded);
      setState(loaded.status.state);
    } catch (caught) {
      setActivation(null);
      if (authenticationRequired(caught)) {
        setState("unauthenticated");
      } else if (notFound(caught)) {
        setState("unknown");
        setError("This confirmation is unknown or no longer available.");
      } else {
        setState("error");
        setError("Action lookup failed. No decision was submitted.");
      }
    }
  }, [selector]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!terminalStates.has(state)) return;
    statusRef.current?.focus();
    if (!autoCloseStates.has(state)) return;
    if (window.opener === null || window.closed) return;
    const closeFrame = window.requestAnimationFrame(() => window.close());
    return () => window.cancelAnimationFrame(closeFrame);
  }, [state]);

  const copy = useMemo(
    () =>
      activation?.status.review ?? {
        version: 1 as const,
        title: "Sensitive Team action unavailable",
        description:
          "Koed could not load authoritative review details for this confirmation.",
        consequence: "",
        confirmLabel: "Unavailable",
        details: []
      },
    [activation]
  );
  const canAct =
    state === "pending" &&
    activation?.status.approvalTier === "step_up" &&
    !!activation.status.review &&
    !busy;

  const decide = async (decision: "approve" | "deny") => {
    if (!selector || !canAct) return;
    setBusy(decision);
    setError(null);
    try {
      const updated = await decideHighRiskBrowserActivation(selector, decision);
      setActivation(updated);
      setState(updated.status.state);
    } catch (caught) {
      if (authenticationRequired(caught)) {
        setState("unauthenticated");
      } else {
        try {
          const authoritative = await loadHighRiskBrowserActivation(selector);
          if (
            authoritative.status.approvalTier !== "step_up" ||
            !authoritative.status.review
          ) {
            setActivation(null);
            setState("invalid");
            setError("Authoritative approval details are no longer available.");
          } else {
            setActivation(authoritative);
            setState(authoritative.status.state);
            setError(
              authoritative.status.state === "pending"
                ? "The decision was not recorded. Review the action and submit your choice again."
                : null
            );
          }
        } catch {
          setState("unreconciled");
          setError(
            "Koed could not confirm whether the decision was recorded. Keep this page open and check again before taking further action."
          );
        }
      }
    } finally {
      setBusy(null);
    }
  };

  const terminal = terminalStates.has(state);
  return (
    <ApprovalShell
      description={copy.description}
      eyebrow="Koed confirmation"
      title={copy.title}
      tone={
        state === "approved" || state === "consumed"
          ? "success"
          : state === "pending" ||
              state === "loading" ||
              state === "unauthenticated"
            ? "waiting"
            : state === "expired"
              ? "warning"
              : "danger"
      }
    >
      {copy.consequence ? (
        <p className="consequence">{copy.consequence}</p>
      ) : null}
      {activation ? (
        <dl className="details">
          <Detail label="Requested by" value="Enrolled local Koed device" />
          <Detail
            label="Expires"
            value={formatDate(activation.status.expiresAt)}
          />
          {activation.confirmation.teamId ? (
            <Detail label="Team scope" value={activation.confirmation.teamId} />
          ) : null}
          {copy.details.map((entry) => (
            <Detail
              key={`${entry.label}:${entry.value}`}
              label={entry.label}
              value={entry.value}
            />
          ))}
        </dl>
      ) : null}
      <Status
        error={error}
        message={stateMessage(state)}
        statusRef={statusRef}
        terminal={terminal}
      />
      {state === "unauthenticated" ? (
        <AuthPanel onAuthenticated={load} />
      ) : null}
      {state === "pending" ? (
        <div className="actions">
          <button
            className="danger"
            disabled={!canAct}
            onClick={() => void decide("deny")}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <button
            className="primary"
            disabled={!canAct}
            onClick={() => void decide("approve")}
          >
            {busy === "approve" ? "Approving…" : copy.confirmLabel}
          </button>
        </div>
      ) : null}
      {state === "error" || state === "unreconciled" ? (
        <div className="actions">
          <button className="secondary" onClick={() => void load()}>
            {state === "unreconciled"
              ? "Check decision status"
              : "Retry action lookup"}
          </button>
        </div>
      ) : null}
    </ApprovalShell>
  );
}

const stateMessage = (state: PageState): string => {
  switch (state) {
    case "approved":
      return "Approved — Koed Desktop is retrieving the result. You can safely close this page and return to Koed.";
    case "consumed":
      return "Completed — this one-use approval was consumed and cannot be replayed. You can safely close this page and return to Koed.";
    case "denied":
      return "Denied — no change was authorized. You can safely close this page and return to Koed.";
    case "revoked":
      return "Canceled — authority for this request was revoked. You can safely close this page and return to Koed.";
    case "canceled":
      return "Canceled — no change was authorized. You can safely close this page and return to Koed.";
    case "expired":
      return "Expired — no change was authorized. You can safely close this page, return to Koed, and start the action again.";
    case "unauthenticated":
      return "Sign in again to confirm this sensitive action.";
    case "unreconciled":
      return "Outcome unknown — Koed has not confirmed whether your decision was recorded.";
    case "invalid":
      return "Unavailable — this confirmation is incomplete and no decision can be submitted. You can safely close this page and return to Koed.";
    case "unknown":
      return "Unavailable — this confirmation is unknown or no longer available. You can safely close this page and return to Koed.";
    case "error":
      return "Action lookup failed — no decision was submitted.";
    case "loading":
      return "Loading confirmation.";
    default:
      return "Approve only if you initiated this action from your enrolled Koed device.";
  }
};
