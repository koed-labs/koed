import type {
  PersonalDesktopApi,
  PersonalDesktopAskTurn
} from "@koed/shared/personal-desktop";
import { SecureMarkdown, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import { ArrowUp, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import "./personal-memory.css";

const optimisticTurn = (query: string): PersonalDesktopAskTurn => {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    askThreadId: crypto.randomUUID(),
    askTurnIndex: 0,
    query,
    answerMarkdown: null,
    errorMessage: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    answeredAt: null
  };
};

const askTurnErrorMessage = (message: string | null): string => {
  if (message === "codex_failed") {
    return "This Ask failed before the Codex worker recorded a detailed reason. Try again.";
  }
  return message ?? "Memory Answer failed.";
};

export function PersonalAskView({
  api,
  markdownAdapters,
  onNew,
  onSelectThread,
  onThreadsChanged,
  selectedThreadId
}: {
  api: PersonalDesktopApi;
  markdownAdapters: MarkdownPlatformAdapters;
  onNew: () => void;
  onSelectThread: (askThreadId: string) => void;
  onThreadsChanged?: () => void;
  selectedThreadId?: string;
}) {
  const [turns, setTurns] = useState<PersonalDesktopAskTurn[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryRequest, setRetryRequest] = useState<{
    idempotencyKey: string;
    query: string;
  } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const selectedThreadIdRef = useRef(selectedThreadId);
  const activeRequestRef = useRef(0);
  selectedThreadIdRef.current = selectedThreadId;

  useEffect(
    () =>
      api.subscribe((change) => {
        if (change.type !== "ask_questions_changed") return;
        if (selectedThreadId) {
          void api
            .loadAskThread?.({ askThreadId: selectedThreadId })
            .then((loaded) => {
              if (!loaded) return;
              setTurns(loaded);
              setError(null);
            });
        }
      }),
    [api, selectedThreadId]
  );

  useEffect(() => {
    activeRequestRef.current += 1;
    setBusy(false);
    setRetryRequest(null);
    headingRef.current?.focus();
    if (!selectedThreadId) {
      setTurns([]);
      return;
    }
    let active = true;
    void api
      .loadAskThread?.({ askThreadId: selectedThreadId })
      .then((loaded) => {
        if (active && loaded) {
          setTurns(loaded);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError("This Ask thread could not be opened.");
      });
    return () => {
      active = false;
    };
  }, [api, selectedThreadId]);

  const submit = async (
    event?: FormEvent,
    retry?: { idempotencyKey: string; query: string }
  ) => {
    event?.preventDefault();
    const trimmed = (retry?.query ?? query).trim();
    if (!trimmed || busy || !api.submitAsk) return;
    const idempotencyKey = retry?.idempotencyKey ?? crypto.randomUUID();
    const pending = optimisticTurn(trimmed);
    const originatingThreadId = selectedThreadId;
    const requestId = ++activeRequestRef.current;
    setQuery("");
    setBusy(true);
    setError(null);
    setRetryRequest(null);
    setTurns((current) => [...current, pending]);
    try {
      const completed = await api.submitAsk({
        ...(originatingThreadId ? { askThreadId: originatingThreadId } : {}),
        idempotencyKey,
        query: trimmed
      });
      if (
        activeRequestRef.current !== requestId ||
        selectedThreadIdRef.current !== originatingThreadId
      ) {
        onThreadsChanged?.();
        return;
      }
      setTurns((current) => [...current.slice(0, -1), completed]);
      if (!originatingThreadId) onSelectThread(completed.askThreadId);
      onThreadsChanged?.();
    } catch {
      if (
        activeRequestRef.current !== requestId ||
        selectedThreadIdRef.current !== originatingThreadId
      ) {
        onThreadsChanged?.();
        return;
      }
      setTurns((current) => [
        ...current.slice(0, -1),
        {
          ...pending,
          status: "error",
          errorMessage: "Koed could not answer this question. Try again."
        }
      ]);
      setError("The answer could not be completed.");
      setRetryRequest({ idempotencyKey, query: trimmed });
    } finally {
      if (activeRequestRef.current === requestId) setBusy(false);
    }
  };

  const composer = (
    <form
      className="personal-ask-composer"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <textarea
        aria-label="Ask Personal Memory"
        disabled={busy}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Ask about your Personal Memory…"
        rows={3}
        value={query}
      />
      <div className="personal-ask-composer-footer">
        <button
          aria-label="Submit question"
          disabled={busy || !query.trim()}
          type="submit"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="personal-ask-spinner" />
          ) : (
            <ArrowUp aria-hidden="true" />
          )}
        </button>
      </div>
    </form>
  );

  return (
    <div className="personal-ask-layout">
      <section
        className="personal-ask-main"
        data-view={turns.length === 0 ? "welcome" : "conversation"}
      >
        {turns.length === 0 ? (
          <div className="personal-ask-welcome">
            <h1
              className="personal-route-heading"
              ref={headingRef}
              tabIndex={-1}
            >
              What would you like to know?
            </h1>
            {composer}
          </div>
        ) : (
          <div className="personal-ask-conversation">
            <header
              aria-label="Conversation actions"
              className="personal-ask-conversation-heading"
            >
              <button
                className="personal-new-conversation personal-new-conversation-standalone"
                onClick={onNew}
                type="button"
              >
                <Plus aria-hidden="true" /> New
              </button>
            </header>
            <div aria-live="polite" className="personal-ask-turns">
              {turns.map((turn) => (
                <article className="personal-ask-turn" key={turn.id}>
                  <p className="personal-ask-question">{turn.query}</p>
                  {turn.status === "pending" ? (
                    <p className="personal-ask-pending">
                      <LoaderCircle aria-hidden="true" /> Searching...
                    </p>
                  ) : turn.status === "error" ? (
                    <p className="personal-ask-error">
                      {askTurnErrorMessage(turn.errorMessage)}
                    </p>
                  ) : turn.answerMarkdown ? (
                    <SecureMarkdown
                      adapters={markdownAdapters}
                      className="personal-ask-answer"
                      source={turn.answerMarkdown}
                    />
                  ) : null}
                </article>
              ))}
            </div>
            {composer}
          </div>
        )}
        {error ? (
          <div className="personal-ask-global-error" role="status">
            <p>{error}</p>
            {retryRequest ? (
              <button
                disabled={busy}
                onClick={() => void submit(undefined, retryRequest)}
                type="button"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
