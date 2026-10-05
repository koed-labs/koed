"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, RotateCw } from "lucide-react";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
import {
  TeamAgentRequestError,
  TeamAgentRequestsClient
} from "@/lib/team-agent-requests-client";
import { AgentThinkingIndicator } from "./AgentThinkingIndicator";
import { teamRequestProgress } from "@/lib/agent-chat-progress";
import { teamAgentRequestCardActions } from "@/lib/team-agent-request-view-state";

type RequestState = "loading" | "ready" | "unavailable" | "access-lost";

export function TeamAgentRequestInbox({
  teamId,
  viewerId,
  authorityKey,
  refreshRevision,
  client,
  onAuthorizationLost,
  onReview,
  onViewWork
}: {
  teamId: string;
  viewerId: string;
  authorityKey: string;
  refreshRevision: number;
  client: TeamAgentRequestsClient;
  onAuthorizationLost: () => void;
  onReview: (request: TeamAgentRequest) => void;
  onViewWork: (request: TeamAgentRequest) => void;
}) {
  const [items, setItems] = useState<TeamAgentRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<RequestState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const viewKey = `${authorityKey}\u0000${teamId}`;
  const [loadedViewKey, setLoadedViewKey] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      const capturedGeneration = ++generation.current;
      if (append) setLoadingMore(true);
      else {
        setState("loading");
        setError(null);
      }
      try {
        const page = await client.listInbox(teamId, {
          limit: 50,
          ...(cursor ? { cursor } : {})
        });
        if (capturedGeneration !== generation.current) return;
        setItems((current) =>
          append ? [...current, ...page.requests] : page.requests
        );
        setNextCursor(page.nextCursor);
        setLoadedViewKey(viewKey);
        setState("ready");
      } catch (failure) {
        if (capturedGeneration !== generation.current) return;
        if (
          failure instanceof TeamAgentRequestError &&
          [401, 403].includes(failure.status)
        ) {
          setItems([]);
          setNextCursor(null);
          setLoadedViewKey(viewKey);
          setState("access-lost");
          onAuthorizationLost();
        } else {
          setError(
            failure instanceof Error
              ? failure.message
              : "Team requests are unavailable."
          );
          setLoadedViewKey(viewKey);
          setState("unavailable");
        }
      } finally {
        if (capturedGeneration === generation.current) setLoadingMore(false);
      }
    },
    [client, onAuthorizationLost, teamId, viewKey]
  );

  useEffect(() => {
    // The effect synchronizes the current Team's authorized inbox with its server source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      generation.current += 1;
    };
  }, [authorityKey, load, refreshRevision]);

  const visibleState = loadedViewKey === viewKey ? state : "loading";
  const visibleItems = loadedViewKey === viewKey ? items : [];
  const visibleCursor = loadedViewKey === viewKey ? nextCursor : null;
  const pending = visibleItems.filter(
    (item) => item.status === "awaiting_owner" && item.canReview
  );
  const acceptedOwnerWork = visibleItems.filter(
    (item) => item.status === "accepted" && item.ownerId === viewerId
  );
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-8 pt-6 sm:px-6">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight text-foreground">
          For you
        </h1>
        <p className="mt-1 text-sm text-subtle">
          Agent requests that need your review in {"this Team"}.
        </p>
      </header>
      {visibleState === "loading" && (
        <Status label="Loading Team requests…" loading />
      )}
      {visibleState === "access-lost" && (
        <Status
          label="Team access changed. Refresh to check your access."
          error
        />
      )}
      {visibleState === "unavailable" && (
        <Status
          label={error ?? "Team requests are unavailable right now."}
          error
          onRetry={() => void load()}
        />
      )}
      {visibleState === "ready" &&
        pending.length === 0 &&
        acceptedOwnerWork.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-4 py-7 text-sm text-subtle">
            No Agent requests are waiting for you.
          </div>
        )}
      {visibleState === "ready" && pending.length > 0 && (
        <>
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-medium text-foreground">
              Waiting for your review
            </h2>
            <span className="text-[11px] text-faint">
              {pending.length} {pending.length === 1 ? "request" : "requests"}
            </span>
          </div>
          <div className="space-y-3">
            {pending.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                viewerId={viewerId}
                onReview={onReview}
                onViewWork={onViewWork}
              />
            ))}
          </div>
        </>
      )}
      {visibleState === "ready" && acceptedOwnerWork.length > 0 && (
        <>
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-medium text-foreground">
              Accepted assignments
            </h2>
            <span className="text-[11px] text-faint">
              {acceptedOwnerWork.length}
            </span>
          </div>
          <div className="space-y-3">
            {acceptedOwnerWork.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                viewerId={viewerId}
                onReview={onReview}
                onViewWork={onViewWork}
              />
            ))}
          </div>
        </>
      )}
      {visibleState === "ready" && visibleCursor && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void load(visibleCursor, true)}
          className="w-full rounded-lg border border-border px-3 py-2 text-xs text-subtle hover:bg-surface-hover disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load more requests"}
        </button>
      )}
    </div>
  );
}

export function TeamChannelAgentRequests({
  teamId,
  channelId,
  originRootMessageId = null,
  viewerId,
  authorityKey,
  refreshRevision,
  client,
  onAuthorizationLost,
  onReview,
  onViewWork,
  onRequestsChanged
}: {
  teamId: string;
  channelId: string;
  originRootMessageId?: string | null;
  viewerId: string;
  authorityKey: string;
  refreshRevision: number;
  client: TeamAgentRequestsClient;
  onAuthorizationLost: () => void;
  onReview: (request: TeamAgentRequest) => void;
  onViewWork: (request: TeamAgentRequest) => void;
  onRequestsChanged?: (requests: TeamAgentRequest[]) => void;
}) {
  const [items, setItems] = useState<TeamAgentRequest[]>([]);
  const [state, setState] = useState<RequestState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const viewKey = `${authorityKey}\u0000${teamId}\u0000${channelId}\u0000${originRootMessageId ?? "channel"}`;
  const [loadedViewKey, setLoadedViewKey] = useState<string | null>(null);
  const generation = useRef(0);
  const onRequestsChangedRef = useRef(onRequestsChanged);
  useEffect(() => {
    onRequestsChangedRef.current = onRequestsChanged;
  }, [onRequestsChanged]);
  const load = useCallback(async () => {
    const capturedGeneration = ++generation.current;
    setState("loading");
    setError(null);
    try {
      const page = await client.listRequests(teamId, { channelId, limit: 100 });
      if (capturedGeneration !== generation.current) return;
      setItems(
        page.requests.filter(
          (request) => request.originRootMessageId === originRootMessageId
        )
      );
      setNextCursor(page.nextCursor);
      setLoadedViewKey(viewKey);
      setState("ready");
    } catch (failure) {
      if (capturedGeneration !== generation.current) return;
      if (
        failure instanceof TeamAgentRequestError &&
        [401, 403].includes(failure.status)
      ) {
        setItems([]);
        setLoadedViewKey(viewKey);
        setState("access-lost");
        onAuthorizationLost();
      } else {
        setError(
          failure instanceof Error
            ? failure.message
            : "Channel requests are unavailable."
        );
        setLoadedViewKey(viewKey);
        setState("unavailable");
      }
    }
  }, [
    channelId,
    client,
    onAuthorizationLost,
    originRootMessageId,
    teamId,
    viewKey
  ]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const capturedGeneration = generation.current;
    const capturedViewKey = viewKey;
    setLoadingMore(true);
    try {
      const page = await client.listRequests(teamId, {
        channelId,
        limit: 100,
        cursor: nextCursor
      });
      if (
        capturedGeneration !== generation.current ||
        capturedViewKey !== viewKey
      )
        return;
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...page.requests.filter(
            (item) =>
              item.originRootMessageId === originRootMessageId &&
              !ids.has(item.id)
          )
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (failure) {
      if (
        capturedGeneration !== generation.current ||
        capturedViewKey !== viewKey
      )
        return;
      if (
        failure instanceof TeamAgentRequestError &&
        [401, 403].includes(failure.status)
      )
        onAuthorizationLost();
      setError(
        failure instanceof Error
          ? failure.message
          : "Older channel requests are unavailable."
      );
      void load();
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    // The effect synchronizes this selected channel's authorized request state with its server source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      generation.current += 1;
    };
  }, [authorityKey, load, refreshRevision]);

  useEffect(() => {
    onRequestsChangedRef.current?.(
      loadedViewKey === viewKey && state === "ready" ? items : []
    );
  }, [items, loadedViewKey, state, viewKey]);

  const withdraw = async (request: TeamAgentRequest) => {
    setPendingId(request.id);
    setError(null);
    try {
      await client.withdrawRequest({
        teamId,
        requestId: request.id,
        expectedVersion: request.version
      });
      await load();
    } catch (failure) {
      if (
        failure instanceof TeamAgentRequestError &&
        [401, 403].includes(failure.status)
      )
        onAuthorizationLost();
      setError(
        failure instanceof Error
          ? failure.message
          : "The request could not be withdrawn."
      );
      // The write may have succeeded even if its response was lost. Reload authoritatively.
      void load();
    } finally {
      setPendingId(null);
    }
  };

  const visibleState = loadedViewKey === viewKey ? state : "loading";
  const visibleItems = loadedViewKey === viewKey ? items : [];
  const visibleCursor = loadedViewKey === viewKey ? nextCursor : null;
  if (!channelId || (visibleState === "ready" && visibleItems.length === 0))
    return null;
  return (
    <section
      aria-label="Agent requests in this channel"
      className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6"
    >
      {visibleState === "loading" && (
        <Status label="Loading Agent request status…" loading />
      )}
      {visibleState === "access-lost" && (
        <Status label="Team access changed." error />
      )}
      {visibleState === "unavailable" && (
        <Status
          label={error ?? "Agent request status is unavailable."}
          error
          onRetry={() => void load()}
        />
      )}
      {visibleState === "ready" && visibleItems.length > 0 && (
        <div className="space-y-2">
          {visibleItems.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              viewerId={viewerId}
              onReview={onReview}
              onViewWork={onViewWork}
              onWithdraw={
                request.canWithdraw ? () => void withdraw(request) : undefined
              }
              pending={pendingId === request.id}
            />
          ))}
        </div>
      )}
      {visibleState === "ready" && visibleCursor && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-xs text-subtle hover:bg-surface-hover disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load older requests"}
        </button>
      )}
      {error && visibleState === "ready" && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

export function TeamAgentRequestReviewPanel({
  teamId,
  requestId,
  executionId,
  client,
  onAuthorizationLost,
  onAccepted,
  summaryDraftStatus = "idle",
  summaryDraftText = "",
  onDraftSummary,
  questionDraft = "",
  onQuestionDraftConsumed,
  onShareQuestion,
  onReviewSaved
}: {
  teamId: string;
  requestId: string;
  executionId: string | null;
  client: TeamAgentRequestsClient;
  onAuthorizationLost: () => void;
  onAccepted: () => void;
  summaryDraftStatus?: "idle" | "drafting" | "ready" | "error";
  summaryDraftText?: string;
  onDraftSummary?: (request: TeamAgentRequest) => void;
  questionDraft?: string;
  onQuestionDraftConsumed?: () => void;
  onShareQuestion?: (
    request: TeamAgentRequest,
    text: string,
    clientMessageId: string
  ) => Promise<void>;
  onReviewSaved?: (
    review: import("@koed/shared/team-agent-requests").TeamAgentRequestReview
  ) => void;
}) {
  const [request, setRequest] = useState<TeamAgentRequest | null>(null);
  const [review, setReview] = useState<
    import("@koed/shared/team-agent-requests").TeamAgentRequestReview | null
  >(null);
  const [goal, setGoal] = useState("");
  const [summary, setSummary] = useState("");
  const [question, setQuestion] = useState("");
  const [questionPostError, setQuestionPostError] = useState<string | null>(
    null
  );
  const [sharingQuestion, setSharingQuestion] = useState(false);
  const questionSendIdentities = useRef(new Map<string, string>());
  const [state, setState] = useState<RequestState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = `${teamId}\u0000${requestId}`;
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const captured = ++generation.current;
    setState("loading");
    setError(null);
    try {
      const savedReview = await client.getReview(teamId, requestId);
      let cursor: string | null = null;
      let found: TeamAgentRequest | null = null;
      do {
        const page = await client.listRequests(teamId, {
          limit: 100,
          ...(cursor ? { cursor } : {})
        });
        found = page.requests.find((item) => item.id === requestId) ?? null;
        cursor = found ? null : page.nextCursor;
      } while (!found && cursor);
      if (captured !== generation.current) return;
      if (!found)
        throw new TeamAgentRequestError(
          "This Team request is no longer available.",
          404
        );
      setRequest(found);
      setReview(savedReview);
      setGoal(savedReview.privateGoal);
      onReviewSaved?.(savedReview);
      setLoadedScopeKey(scopeKey);
      setState("ready");
    } catch (failure) {
      if (captured !== generation.current) return;
      if (
        failure instanceof TeamAgentRequestError &&
        [401, 403].includes(failure.status)
      ) {
        setRequest(null);
        setReview(null);
        setLoadedScopeKey(scopeKey);
        setState("access-lost");
        onAuthorizationLost();
      } else {
        setError(
          failure instanceof Error
            ? failure.message
            : "The private request review is unavailable."
        );
        setLoadedScopeKey(scopeKey);
        setState("unavailable");
      }
    }
  }, [
    client,
    executionId,
    onAuthorizationLost,
    onReviewSaved,
    requestId,
    scopeKey,
    teamId
  ]);

  useEffect(() => {
    // The private owner review is loaded only for the explicit request handoff.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (summaryDraftText) setSummary(summaryDraftText);
  }, [summaryDraftText]);

  useEffect(() => {
    // The owner selected a completed Agent message in the private execution.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (questionDraft) setQuestion(questionDraft);
  }, [questionDraft]);

  useEffect(() => {
    if (
      request?.status !== "accepted" ||
      request.jobStatus === "succeeded" ||
      request.jobStatus === "failed" ||
      request.jobStatus === "canceled" ||
      request.jobStatus === "interrupted"
    )
      return;
    const timer = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load, request?.jobStatus, request?.status]);

  const save = async () => {
    if (!request || !review || !goal.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await client.updateReview({
        teamId,
        requestId,
        expectedVersion: review.version,
        privateGoal: goal,
        executionId: executionId ?? review.executionId
      });
      setReview(updated);
      onReviewSaved?.(updated);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The private brief could not be saved."
      );
      void load();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "accept" | "decline") => {
    if (
      !request ||
      !review ||
      (decision === "accept" &&
        (!goal.trim() ||
          !executionId ||
          review.executionId !== executionId ||
          review.privateGoal !== goal))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const updated = await client.decideRequest({
        teamId,
        requestId,
        expectedVersion: request.version,
        decision
      });
      setRequest(updated);
      if (decision === "accept") onAccepted();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The request decision could not be saved."
      );
      void load();
    } finally {
      setBusy(false);
    }
  };

  const postOutcome = async () => {
    if (!request || request.status !== "accepted" || !summary.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await client.postOutcome({
        teamId,
        requestId,
        expectedVersion: request.version,
        summary: summary.trim()
      });
      setRequest(updated);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The reviewed summary could not be shared."
      );
      void load();
    } finally {
      setBusy(false);
    }
  };

  const shareQuestion = async () => {
    if (
      !request ||
      request.status !== "accepted" ||
      !question.trim() ||
      !onShareQuestion
    )
      return;
    const body = question.trim().slice(0, 2_000);
    const sendScope = `${request.teamId}\u0000${request.id}\u0000${request.originRootMessageId ?? "channel"}`;
    const identityKey = `${sendScope}\u0000${body}`;
    const clientMessageId =
      questionSendIdentities.current.get(identityKey) ?? crypto.randomUUID();
    questionSendIdentities.current.set(identityKey, clientMessageId);
    setSharingQuestion(true);
    setQuestionPostError(null);
    try {
      await onShareQuestion(request, body, clientMessageId);
      questionSendIdentities.current.delete(identityKey);
      setQuestion("");
      setQuestionPostError(null);
      onQuestionDraftConsumed?.();
    } catch (failure) {
      setQuestionPostError(
        failure instanceof Error
          ? failure.message
          : "The reviewed question could not be posted."
      );
    } finally {
      setSharingQuestion(false);
    }
  };

  const visibleState = loadedScopeKey === scopeKey ? state : "loading";
  const visibleRequest = loadedScopeKey === scopeKey ? request : null;
  const visibleReview = loadedScopeKey === scopeKey ? review : null;

  return (
    <section
      aria-label="Private Team Agent request review"
      className="mx-auto w-full max-w-3xl border-b border-border bg-surface/60 px-4 py-4 sm:px-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">
            Private request review
          </p>
          <h2 className="mt-1 text-sm font-medium text-foreground">
            {visibleRequest
              ? `${visibleRequest.agentName} · ${visibleRequest.requesterName}`
              : "Team Agent request"}
          </h2>
          <p className="mt-1 text-xs text-subtle">
            Refine the private execution in this chat, then save the concise
            assignment brief here. It stays private; Accept assigns it to the
            owner’s private execution.
          </p>
        </div>
        {visibleRequest?.status === "accepted" && (
          <span className="rounded-full border border-border px-2 py-1 text-[10px] text-subtle">
            Accepted
            {visibleRequest.jobStatus ? ` · ${visibleRequest.jobStatus}` : ""}
          </span>
        )}
      </div>
      {visibleState === "loading" && (
        <div className="mt-3">
          <Status label="Loading owner-only request details…" loading />
        </div>
      )}
      {visibleState === "access-lost" && (
        <div className="mt-3">
          <Status label="Team access changed." error />
        </div>
      )}
      {visibleState === "unavailable" && (
        <div className="mt-3">
          <Status
            label={error ?? "The request review is unavailable."}
            error
            onRetry={() => void load()}
          />
        </div>
      )}
      {visibleState === "ready" &&
        visibleRequest &&
        visibleReview &&
        visibleRequest.status === "awaiting_owner" && (
          <>
            {!executionId && (
              <p className="mt-3 text-xs text-warning">
                Save a concise private brief before starting this chat. The
                request remains pending until you explicitly accept it.
              </p>
            )}
            {executionId &&
              visibleReview.executionId &&
              visibleReview.executionId !== executionId && (
                <p className="mt-3 text-xs text-warning">
                  This is a different private execution. Reopen the original
                  review chat to continue; its binding cannot be changed.
                </p>
              )}
            <label className="mt-3 block text-[11px] font-medium text-subtle">
              Private assignment brief
              <textarea
                disabled={Boolean(
                  visibleReview.executionId &&
                  visibleReview.executionId !== executionId
                )}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                maxLength={8_000}
                rows={3}
                placeholder="What should the Agent do, and how should it approach the work?"
                className="mt-1 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent disabled:opacity-60"
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={
                  busy ||
                  !goal.trim() ||
                  Boolean(
                    visibleReview.executionId &&
                    visibleReview.executionId !== executionId
                  )
                }
                onClick={() => void save()}
                className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-foreground hover:bg-surface-hover disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save private brief"}
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !executionId ||
                  !goal.trim() ||
                  visibleReview.executionId !== executionId ||
                  visibleReview.privateGoal !== goal
                }
                onClick={() => void decide("accept")}
                className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              >
                Accept and assign
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide("decline")}
                className="rounded-md px-2.5 py-1.5 text-[11px] text-subtle hover:bg-surface-hover disabled:opacity-50"
              >
                Decline
              </button>
              {visibleReview.executionId === executionId &&
                visibleReview.privateGoal === goal &&
                goal.length > 0 && (
                  <span role="status" className="text-[10px] text-subtle">
                    Saved for this private execution
                  </span>
                )}
            </div>
          </>
        )}
      {visibleState === "ready" && visibleRequest?.status === "accepted" && (
        <>
          <p className="mt-3 text-xs text-subtle">
            This assignment is accepted. Continue the private execution in this
            chat; only the approved shared brief is visible to the Team.
          </p>
          {onShareQuestion && (
            <div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
              <div>
                <p className="text-xs font-medium text-foreground">
                  Share a question with the Team
                </p>
                <p className="mt-0.5 text-[10px] text-faint">
                  Select an Agent message, review or edit it, then post it to
                  the request’s channel.
                </p>
              </div>
              <label className="block text-[11px] font-medium text-subtle">
                Question for the channel
                <textarea
                  value={question}
                  onChange={(event) => {
                    setQuestion(event.target.value);
                    setQuestionPostError(null);
                  }}
                  maxLength={2_000}
                  rows={2}
                  className="mt-1 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                />
              </label>
              <button
                type="button"
                disabled={sharingQuestion || !question.trim()}
                onClick={() => void shareQuestion()}
                className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-subtle hover:bg-surface-hover disabled:opacity-50"
              >
                {sharingQuestion
                  ? "Posting reviewed question…"
                  : "Post reviewed question"}
              </button>
              {questionPostError && (
                <p role="alert" className="text-xs text-danger">
                  {questionPostError}
                </p>
              )}
            </div>
          )}
          {["succeeded", "failed", "canceled"].includes(
            visibleRequest.jobStatus ?? ""
          ) && (
            <div className="mt-4 space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
              <div>
                <p className="text-xs font-medium text-foreground">
                  Share an outcome summary
                </p>
                <p className="mt-0.5 text-[10px] text-faint">
                  The connected Agent drafts it in this private execution.
                  Review and edit it before posting to the Team channel.
                </p>
              </div>
              {summaryDraftStatus !== "ready" && (
                <button
                  type="button"
                  disabled={
                    busy || summaryDraftStatus === "drafting" || !onDraftSummary
                  }
                  onClick={() => onDraftSummary?.(visibleRequest)}
                  className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-subtle hover:bg-surface-hover disabled:opacity-50"
                >
                  {summaryDraftStatus === "drafting"
                    ? "Drafting privately…"
                    : summaryDraftStatus === "error"
                      ? "Try summary draft again"
                      : "Draft summary privately"}
                </button>
              )}
              {summaryDraftStatus === "drafting" && (
                <Status
                  label="Waiting for the private Agent response…"
                  loading
                />
              )}
              {summaryDraftStatus === "error" && (
                <Status
                  label="The private summary draft could not be generated. Retry when the execution is ready."
                  error
                />
              )}
              {summaryDraftStatus === "ready" && (
                <>
                  <label className="block text-[11px] font-medium text-subtle">
                    Review summary before sharing
                    <textarea
                      value={summary}
                      onChange={(event) => setSummary(event.target.value)}
                      maxLength={2_000}
                      rows={4}
                      className="mt-1 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !summary.trim() ||
                        Boolean(visibleRequest.outcomeMessageId)
                      }
                      onClick={() => void postOutcome()}
                      className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                    >
                      {busy
                        ? "Sharing…"
                        : visibleRequest.outcomeMessageId
                          ? "Summary shared"
                          : "Share reviewed summary"}
                    </button>
                    {visibleRequest.outcomeMessageId && (
                      <span className="text-[10px] text-subtle">
                        Posted in the request channel.
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      {error && visibleState === "ready" && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function RequestCard({
  request,
  viewerId,
  onReview,
  onViewWork,
  onWithdraw,
  pending = false
}: {
  request: TeamAgentRequest;
  viewerId: string;
  onReview: (request: TeamAgentRequest) => void;
  onViewWork?: (request: TeamAgentRequest) => void;
  onWithdraw?: () => void;
  pending?: boolean;
}) {
  const actions = teamAgentRequestCardActions(request, viewerId);
  const progress = teamRequestProgress(request);
  const status =
    request.status === "awaiting_owner"
      ? "Awaiting owner"
      : request.status === "accepted"
        ? request.jobStatus
          ? `Accepted · ${request.jobStatus}`
          : "Accepted · waiting to start"
        : request.status === "unavailable"
          ? "No longer available"
          : request.status[0]!.toUpperCase() + request.status.slice(1);
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-surface/25 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-foreground">
          {request.agentName}
          <span className="font-normal text-faint"> · {request.ownerName}</span>
        </p>
        <p className="mt-1 text-[11px] text-subtle">
          {request.requesterName} · {status}
        </p>
        {progress && <AgentThinkingIndicator progress={progress} />}
      </div>
      <div className="flex items-center gap-2">
        {actions.canReview && (
          <button
            type="button"
            onClick={() => onReview(request)}
            className="rounded-md bg-accent px-2.5 py-1.5 text-[10px] font-medium text-white hover:bg-accent/90"
          >
            Review privately
          </button>
        )}
        {actions.canOpenPrivateChat && (
          <button
            type="button"
            onClick={() => onReview(request)}
            className="rounded-md border border-border px-2.5 py-1.5 text-[10px] font-medium text-subtle hover:bg-surface-hover"
          >
            Open private chat
          </button>
        )}
        {actions.canViewWork && (
          <button
            type="button"
            onClick={() => onViewWork?.(request)}
            className="rounded-md border border-border px-2.5 py-1.5 text-[10px] font-medium text-subtle hover:bg-surface-hover"
          >
            View work
          </button>
        )}
        {onWithdraw && request.status === "awaiting_owner" && (
          <button
            type="button"
            disabled={pending}
            onClick={onWithdraw}
            className="rounded-md border border-border px-2.5 py-1.5 text-[10px] font-medium text-subtle hover:bg-surface-hover disabled:opacity-50"
          >
            {pending ? "Withdrawing…" : "Withdraw"}
          </button>
        )}
        {request.outcomeMessageId && (
          <span className="text-[10px] text-faint">Outcome in channel</span>
        )}
      </div>
    </article>
  );
}

function Status({
  label,
  loading = false,
  error = false,
  onRetry
}: {
  label: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface/20 px-3 py-2 text-xs text-subtle"
    >
      {loading ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent" />
      ) : error ? (
        <AlertCircle className="h-3.5 w-3.5 text-danger" />
      ) : null}
      <span className="flex-1">{label}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-surface-hover"
        >
          <RotateCw className="h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}
