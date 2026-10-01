"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  createDesktopRecallFeedbackDraftStore,
  createRecallFeedbackDraftStore,
  type RecallFeedbackDraftIdentity,
  type RecallFeedbackDraftStore
} from "../../lib/recall-feedback-drafts";
import type {
  RecallFeedback,
  RecallFeedbackChange,
  RecallFeedbackRating
} from "../../lib/recall-feedback";

export type RecallFeedbackAccess = Readonly<{
  backendId: string;
  ownerId: string;
  executionId: string;
  load: (
    messageId: string,
    signal: AbortSignal
  ) => Promise<RecallFeedback | null>;
  update: (
    messageId: string,
    change: RecallFeedbackChange,
    signal: AbortSignal
  ) => Promise<RecallFeedback | null>;
}>;

let browserDraftStore: RecallFeedbackDraftStore | null = null;

function feedbackDraftStore(): RecallFeedbackDraftStore {
  const desktop = createDesktopRecallFeedbackDraftStore();
  if (desktop) return desktop;
  if (!browserDraftStore) browserDraftStore = createRecallFeedbackDraftStore();
  return browserDraftStore;
}

export function RecallFeedbackControls({
  messageId,
  access
}: {
  messageId: string;
  access: RecallFeedbackAccess;
}) {
  const scopeKey = `${access.backendId}\n${access.ownerId}\n${access.executionId}\n${messageId}`;
  const [saved, setSaved] = useState<RecallFeedback | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine
  );
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const commentRef = useRef("");
  const writeSequence = useRef(0);
  const currentScopeRef = useRef(scopeKey);
  const loadedRef = useRef(false);
  const updateControllerRef = useRef<AbortController | null>(null);
  const draftStoreRef = useRef<RecallFeedbackDraftStore | null>(null);
  const identity: RecallFeedbackDraftIdentity = {
    backendId: access.backendId,
    ownerId: access.ownerId,
    executionId: access.executionId,
    messageId
  };
  useEffect(() => {
    const onlineChanged = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && !loadedRef.current) {
        setLoadAttempt((attempt) => attempt + 1);
      }
    };
    window.addEventListener("online", onlineChanged);
    window.addEventListener("offline", onlineChanged);
    return () => {
      window.removeEventListener("online", onlineChanged);
      window.removeEventListener("offline", onlineChanged);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    currentScopeRef.current = scopeKey;
    // This component can be reused outside the keyed answer renderers. Reset
    // its answer-specific state before starting the scoped authenticated GET.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaved(null);
    setLoaded(false);
    loadedRef.current = false;
    setComment("");
    commentRef.current = "";
    setCommentOpen(false);
    setStatus("");
    setError("");
    setDraftError("");
    void (async () => {
      try {
        const feedback = await access.load(messageId, controller.signal);
        if (
          controller.signal.aborted ||
          !current ||
          currentScopeRef.current !== scopeKey
        )
          return;
        setSaved(feedback);
        try {
          const draftStore = feedbackDraftStore();
          draftStoreRef.current = draftStore;
          const storedDraft = await draftStore.load(identity);
          if (
            controller.signal.aborted ||
            !current ||
            currentScopeRef.current !== scopeKey
          )
            return;
          if (storedDraft !== null) {
            commentRef.current = storedDraft;
            setComment(storedDraft);
            setCommentOpen(true);
          } else if (feedback?.comment) {
            commentRef.current = feedback.comment;
          }
        } catch {
          if (
            !controller.signal.aborted &&
            current &&
            currentScopeRef.current === scopeKey
          ) {
            setDraftError(
              "This device could not open the encrypted comment draft."
            );
          }
        }
        if (
          !controller.signal.aborted &&
          current &&
          currentScopeRef.current === scopeKey
        ) {
          loadedRef.current = true;
          setLoaded(true);
        }
      } catch {
        if (
          !controller.signal.aborted &&
          current &&
          currentScopeRef.current === scopeKey
        ) {
          setError(
            "Feedback is unavailable. Reconnect to load saved feedback."
          );
        }
      }
    })();
    return () => {
      current = false;
      controller.abort();
      updateControllerRef.current?.abort();
      updateControllerRef.current = null;
    };
    // Identity fields are intentionally captured as one immutable answer scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, loadAttempt]);

  const persistCommentDraft = async (next: string) => {
    const sequence = ++writeSequence.current;
    const scopeAtStart = scopeKey;
    try {
      const draftStore = draftStoreRef.current ?? feedbackDraftStore();
      draftStoreRef.current = draftStore;
      await draftStore.save(identity, next);
      if (
        sequence === writeSequence.current &&
        currentScopeRef.current === scopeAtStart
      )
        setDraftError("");
    } catch {
      if (
        sequence === writeSequence.current &&
        currentScopeRef.current === scopeAtStart
      ) {
        setDraftError(
          "This device could not save the encrypted comment draft."
        );
      }
    }
  };

  const update = async (change: RecallFeedbackChange) => {
    if (!loaded || busy || !online) return;
    const scopeAtStart = scopeKey;
    setBusy(true);
    setError("");
    setStatus("");
    const controller = new AbortController();
    updateControllerRef.current = controller;
    try {
      const feedback = await access.update(
        messageId,
        change,
        controller.signal
      );
      if (
        currentScopeRef.current !== scopeAtStart ||
        controller.signal.aborted
      ) {
        return undefined;
      }
      setSaved(feedback);
      setStatus("Feedback saved");
      return feedback;
    } catch {
      if (
        currentScopeRef.current === scopeAtStart &&
        !controller.signal.aborted
      ) {
        setError(
          "Feedback could not be saved. Your saved feedback and comment draft are unchanged."
        );
      }
      return undefined;
    } finally {
      controller.abort();
      if (updateControllerRef.current === controller) {
        updateControllerRef.current = null;
        if (currentScopeRef.current === scopeAtStart) setBusy(false);
      }
    }
  };

  const submitRating = async (rating: RecallFeedbackRating) => {
    if (saved?.rating === rating) {
      await update({ rating: null });
    } else {
      await update({ rating });
    }
  };

  const saveComment = async () => {
    const submitted = commentRef.current;
    const result = await update({
      comment: submitted.trim() ? submitted : null
    });
    if (result === undefined) return;
    if (commentRef.current !== submitted) {
      setStatus("Comment saved; newer edits remain on this device");
      return;
    }
    if (commentRef.current === submitted) {
      try {
        const draftStore = draftStoreRef.current;
        if (!draftStore)
          throw new Error("Encrypted feedback draft storage is unavailable.");
        await draftStore.delete(identity);
        if (
          currentScopeRef.current !== scopeKey ||
          commentRef.current !== submitted
        )
          return;
        setDraftError("");
        const next = result?.comment ?? "";
        commentRef.current = next;
        setComment(next);
        setCommentOpen(Boolean(next));
      } catch {
        if (currentScopeRef.current === scopeKey) {
          setDraftError(
            "Feedback was saved, but this device could not clear its encrypted draft."
          );
        }
      }
    }
  };

  const handleCommentChange = (next: string) => {
    commentRef.current = next;
    setComment(next);
    setStatus("");
    void persistCommentDraft(next);
  };

  if (!loaded) {
    return (
      <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-muted">
        {error ? (
          <span role="status">{error}</span>
        ) : (
          <span>Loading feedback…</span>
        )}
      </div>
    );
  }

  const displayedComment = saved?.comment;

  return (
    <div
      className="mt-2 border-t border-border/60 pt-2"
      data-recall-feedback-message-id={messageId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="This is right"
            aria-pressed={saved?.rating === "up"}
            disabled={!online || busy}
            onClick={() => void submitRating("up")}
            className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${saved?.rating === "up" ? "text-success" : "text-faint hover:bg-surface-hover hover:text-foreground-secondary"}`}
          >
            <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="This isn’t right"
            aria-pressed={saved?.rating === "down"}
            disabled={!online || busy}
            onClick={() => void submitRating("down")}
            className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${saved?.rating === "down" ? "text-danger" : "text-faint hover:bg-surface-hover hover:text-foreground-secondary"}`}
          >
            <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!commentOpen) {
                const initial = commentRef.current;
                commentRef.current = initial;
                setComment(initial);
                setCommentOpen(true);
              } else {
                setCommentOpen(false);
              }
            }}
            className="ml-1 rounded px-2 py-1 text-[11px] text-subtle hover:bg-surface-hover disabled:opacity-40"
          >
            {displayedComment ? "Edit comment" : "Add comment"}
          </button>
        </div>
        {status ? (
          <span role="status" className="text-[11px] text-success">
            {status}
          </span>
        ) : null}
      </div>
      {displayedComment && !commentOpen ? (
        <p className="mt-1 whitespace-pre-wrap break-words pl-1 text-[11px] text-foreground-secondary">
          {displayedComment}
        </p>
      ) : null}
      {commentOpen ? (
        <div className="mt-1 space-y-1.5">
          <label className="sr-only" htmlFor={`recall-feedback-${messageId}`}>
            Feedback comment
          </label>
          <textarea
            id={`recall-feedback-${messageId}`}
            aria-label="Feedback comment"
            value={comment}
            maxLength={4_000}
            onChange={(event) => handleCommentChange(event.currentTarget.value)}
            rows={2}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-accent"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[10px] text-muted">
              {!online ? "Offline · comment stays on this device" : null}
              {draftError ? <span role="status">{draftError}</span> : null}
            </div>
            <button
              type="button"
              disabled={!online || busy}
              onClick={() => void saveComment()}
              className="rounded-md bg-accent px-2.5 py-1 text-[10px] font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save comment
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-danger">
          {error}
        </p>
      ) : null}
      {!online && !commentOpen ? (
        <p className="mt-1 text-[10px] text-muted">
          Offline · ratings are unavailable
        </p>
      ) : null}
    </div>
  );
}
