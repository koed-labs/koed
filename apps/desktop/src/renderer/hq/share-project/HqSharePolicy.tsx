import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";

type Policy = Awaited<
  ReturnType<NonNullable<ProjectsDesktopApi["sharedPolicyStatus"]>>
>;
type PolicyView = Pick<
  Policy,
  "status" | "pendingAction" | "reviewRequired" | "eligibleCount"
> & {
  reviewSources: Array<{ reviewLabel: string; eligible: boolean }>;
};
const visiblePolicy = (source: Policy): PolicyView => ({
  status: source.status,
  pendingAction: source.pendingAction,
  reviewRequired: source.reviewRequired,
  eligibleCount: source.eligibleCount,
  reviewSources: source.reviewSources.slice(0, 100).map((item) => ({
    reviewLabel: item.reviewLabel,
    eligible: item.eligible
  }))
});
type StageResult = Awaited<
  ReturnType<NonNullable<ProjectsDesktopApi["sharedPolicyStageInitial"]>>
>;
type InitialStage = StageResult["initialStage"];
const stageReason = (reason?: string | null) => {
  switch (reason) {
    case "result_unknown":
      return "Outcome not confirmed";
    case "occupied":
      return "An existing grant or operation";
    case "already_issued":
      return "Already issued";
    case "source_changed":
      return "Changed since review";
    case "ineligible":
      return "No longer eligible for this summary offer";
    default:
      return null;
  }
};

export function HqSharePolicy({
  personalProjectId,
  projectsApi,
  identityKey,
  autoOfferToken
}: {
  personalProjectId: string;
  projectsApi: ProjectsDesktopApi;
  identityKey: string;
  autoOfferToken?: string | null;
}) {
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [stage, setStage] = useState<InitialStage | null>(null);
  const [resolvedScope, setResolvedScope] = useState("");
  const [busy, setBusy] = useState<
    "loading" | "enabling" | "revoking" | "staging" | null
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const generation = useRef(0);
  const offeredToken = useRef<string | null>(null);
  const scope = `${identityKey}\u0000${personalProjectId}`;
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    generation.current += 1;
  }

  const run = useCallback(
    async (operation: "status" | "enable" | "revoke" | "stage") => {
      const current = ++generation.current;
      setBusy(
        operation === "status"
          ? "loading"
          : operation === "enable"
            ? "enabling"
            : operation === "stage"
              ? "staging"
              : "revoking"
      );
      setError(null);
      setUncertain(false);
      if (operation === "status") {
        setPolicy(null);
        setStage(null);
      }
      try {
        const method =
          operation === "status"
            ? projectsApi.sharedPolicyStatus
            : operation === "enable"
              ? projectsApi.sharedPolicyEnable
              : operation === "stage"
                ? projectsApi.sharedPolicyStageInitial
                : projectsApi.sharedPolicyRevoke;
        if (!method)
          throw new Error(
            "Project summary sharing is unavailable on this Desktop."
          );
        // The renderer selects only its own Personal Project. The broker builds
        // the source manifest and performs the exact Native review.
        const next = await method(personalProjectId);
        if (generation.current !== current || scopeRef.current !== scope)
          return;
        if (operation === "enable" || operation === "stage") {
          const result = next as StageResult;
          setPolicy(visiblePolicy(result.policy));
          setStage(result.initialStage);
        } else {
          setPolicy(visiblePolicy(next as Policy));
          setStage(null);
        }
        setResolvedScope(scope);
      } catch (caught) {
        if (generation.current !== current || scopeRef.current !== scope)
          return;
        const cancelled =
          caught instanceof Error &&
          caught.message === "Project summary sharing was canceled.";
        if (!cancelled) {
          setPolicy(null);
          setStage(null);
          setUncertain(true);
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "Project summary sharing is unavailable."
        );
        setResolvedScope(scope);
      } finally {
        if (generation.current === current && scopeRef.current === scope)
          setBusy(null);
      }
    },
    [personalProjectId, projectsApi, scope]
  );

  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      if (autoOfferToken && offeredToken.current !== autoOfferToken) {
        offeredToken.current = autoOfferToken;
        void run("enable");
      } else {
        void run("status");
      }
    });
    return () => {
      alive = false;
      generation.current += 1;
    };
  }, [autoOfferToken, run]);

  const scopeReady = resolvedScope === scope;
  const shownPolicy = scopeReady ? policy : null;
  const shownStage = scopeReady ? stage : null;
  const shownError = scopeReady ? error : null;
  const active = shownPolicy?.status === "active";
  const pendingAction = shownPolicy?.pendingAction;
  return (
    <section className="hq-share-policy" aria-label="Chat summary sharing">
      <h3>Chat summary sharing</h3>
      <p>
        After your Native review, eligible captured chats in this Project can
        share summaries automatically. Each approved chat’s summary can keep
        updating under its own grant. Existing chats moved in later ask
        separately. Full transcripts and private Agent chats stay private.
        Curated Memory requires a separate review and approval.
      </p>
      {busy === "loading" || !scopeReady ? (
        <p role="status">Checking summary sharing…</p>
      ) : null}
      {shownPolicy && !busy ? (
        <p role="status">
          {pendingAction
            ? `Summary sharing ${pendingAction} result is pending. Check status again before making another change.`
            : shownPolicy.reviewRequired
              ? "Review needed: stop this old summary policy, then review sharing again."
              : active
                ? "Summary sharing policy is on. Approved summaries may still be preparing."
                : shownPolicy.status === "revoked"
                  ? "Summary sharing is off for new chats. Existing grants keep their own consent and may continue summary updates until separately frozen or revoked."
                  : "Summary sharing is off. Review it to include your eligible chats."}
        </p>
      ) : null}
      {shownStage ? (
        <div className="hq-share-policy__sources" role="status">
          <p>
            {shownStage.stagedCount} newly staged · {shownStage.pendingCount}{" "}
            pending or unconfirmed · {shownStage.skippedCount} skipped ·{" "}
            {shownStage.needsReviewCount} need separate review.
          </p>
          {shownStage.items.length ? (
            <ul>
              {shownStage.items.slice(0, 100).map((item, index) => (
                <li key={index}>
                  {item.label} ·{" "}
                  {item.state === "needs_review"
                    ? "Needs review"
                    : item.state === "skipped"
                      ? "Skipped"
                      : "Pending"}
                  {stageReason(item.reason)
                    ? ` · ${stageReason(item.reason)}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {shownPolicy &&
      shownPolicy.reviewSources.some(
        (source: { eligible: boolean }) => source.eligible
      ) ? (
        <div className="hq-share-policy__sources">
          <p>
            {shownPolicy.eligibleCount} eligible captured chat{" "}
            {shownPolicy.eligibleCount === 1 ? "summary" : "summaries"} in the
            current review.
          </p>
          <ul>
            {shownPolicy.reviewSources
              .filter((source: { eligible: boolean }) => source.eligible)
              .slice(0, 100)
              .map((source: { reviewLabel: string }, index: number) => (
                <li key={index}>{source.reviewLabel}</li>
              ))}
          </ul>
        </div>
      ) : null}
      {shownError ? (
        <p role="alert" className="hq-share-sheet__error">
          {shownError}
        </p>
      ) : null}
      <div className="hq-share-policy__actions">
        {!scopeReady || uncertain || pendingAction ? null : active ? (
          <button
            type="button"
            disabled={busy !== null || !projectsApi.sharedPolicyRevoke}
            onClick={() => void run("revoke")}
          >
            {busy === "revoking" ? "Reviewing…" : "Stop future summary sharing"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy !== null || !projectsApi.sharedPolicyEnable}
            onClick={() => void run("enable")}
          >
            {busy === "enabling" ? "Reviewing…" : "Review summary sharing"}
          </button>
        )}
        {active &&
        !uncertain &&
        !pendingAction &&
        !shownPolicy.reviewRequired &&
        projectsApi.sharedPolicyStageInitial ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("stage")}
          >
            {busy === "staging"
              ? "Checking pending summaries…"
              : "Retry pending summaries"}
          </button>
        ) : null}
        {(shownError || pendingAction) &&
        !busy &&
        projectsApi.sharedPolicyStatus ? (
          <button type="button" onClick={() => void run("status")}>
            Check status again
          </button>
        ) : null}
      </div>
    </section>
  );
}
