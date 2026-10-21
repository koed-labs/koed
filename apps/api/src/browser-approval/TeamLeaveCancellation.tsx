import { useCallback, useEffect, useState } from "react";
import { AuthPanel } from "./AuthPanel.js";
import { ApprovalShell } from "./layout.js";
import {
  authenticationRequired,
  loadTeamLeaveBrowserReview,
  cancelTeamLeaveBrowserOperation
} from "./api.js";

export function TeamLeaveCancellation({ teamId }: { teamId: string | null }) {
  const [review, setReview] = useState<Awaited<
    ReturnType<typeof loadTeamLeaveBrowserReview>
  > | null>(null);
  const [state, setState] = useState<
    "loading" | "unauthenticated" | "ready" | "canceled" | "error"
  >("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!teamId) {
      setState("error");
      setMessage("Team link is invalid.");
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      const next = await loadTeamLeaveBrowserReview(teamId);
      if (next.team.id !== teamId || next.membership.status !== "enabled")
        throw new Error("Current Team membership is unavailable.");
      setReview(next);
      setState("ready");
    } catch (error) {
      setReview(null);
      setState(authenticationRequired(error) ? "unauthenticated" : "error");
      if (!authenticationRequired(error))
        setMessage(
          error instanceof Error ? error.message : "Review unavailable."
        );
    }
  }, [teamId]);
  useEffect(() => {
    void load();
  }, [load]);
  const cancel = async () => {
    if (!teamId || !review?.pendingLeaveOperationId || busy) return;
    const operationId = review.pendingLeaveOperationId;
    setBusy(true);
    setMessage(null);
    try {
      await cancelTeamLeaveBrowserOperation(teamId, operationId);
      const refreshed = await loadTeamLeaveBrowserReview(teamId);
      if (refreshed.pendingLeaveOperationId === operationId)
        throw new Error(
          "Cancellation is not confirmed. Check again before another leave review."
        );
      setReview(refreshed);
      setState("canceled");
    } catch (error) {
      if (authenticationRequired(error)) setState("unauthenticated");
      else
        setMessage(
          "Cancellation outcome is unknown. Refresh and check the current Team review before acting again."
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <ApprovalShell
      eyebrow="Koed Team departure"
      title="Review pending departure"
      description="The departing member can cancel a prepared departure with a fresh browser session. No Personal copy becomes active through cancellation."
      tone={
        state === "canceled"
          ? "success"
          : state === "error"
            ? "danger"
            : "waiting"
      }
    >
      {state === "unauthenticated" ? (
        <AuthPanel onAuthenticated={load} />
      ) : null}
      {state === "loading" ? (
        <p role="status">Loading current Team review…</p>
      ) : null}
      {review && state !== "unauthenticated" ? (
        <>
          <p>{review.team.name}</p>
          {review.pendingLeaveOperationId ? (
            <>
              <p>
                A departure is prepared. Cancel it here before starting a fresh
                review on your device.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void cancel()}
              >
                {busy ? "Checking…" : "Cancel prepared departure"}
              </button>
            </>
          ) : (
            <p role="status">
              No prepared departure remains. Return to Koed and review again.
            </p>
          )}
        </>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      {state === "error" ? (
        <button type="button" onClick={() => void load()}>
          Check again
        </button>
      ) : null}
    </ApprovalShell>
  );
}
