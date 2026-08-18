import type {
  PersonalDesktopApi,
  PersonalDesktopAskTurn
} from "@koed/shared/personal-desktop";
import { SecureMarkdown, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import { ArrowUp, LoaderCircle, Plus, Sparkles } from "lucide-react";
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

  useEffect(
    () =>
      api.subscribe((change) => {
        if (change.type !== "ask_questions_changed") return;
        if (selectedThreadId) {
          void api
            .loadAskThread?.({ askThreadId: selectedThreadId })
            .then((loaded) => loaded && setTurns(loaded));
        }
      }),
    [api, selectedThreadId]
  );

  useEffect(() => {
    headingRef.current?.focus();
    if (!selectedThreadId) {
      setTurns([]);
      return;
    }
    let active = true;
    void api
      .loadAskThread?.({ askThreadId: selectedThreadId })
      .then((loaded) => {
        if (active && loaded) setTurns(loaded);
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
    setQuery("");
    setBusy(true);
    setError(null);
    setRetryRequest(null);
    setTurns((current) => [...current, pending]);
    try {
      const completed = await api.submitAsk({
        ...(selectedThreadId ? { askThreadId: selectedThreadId } : {}),
        idempotencyKey,
        query: trimmed
      });
      setTurns((current) => [...current.slice(0, -1), completed]);
      if (!selectedThreadId) onSelectThread(completed.askThreadId);
      onThreadsChanged?.();
    } catch {
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
      setBusy(false);
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
        <span>
          <Sparkles aria-hidden="true" /> Personal Memory
        </span>
        <button
          aria-label="Submit question"
          disabled={busy || !query.trim()}
          type="submit"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" />
          ) : (
            <ArrowUp aria-hidden="true" />
          )}
        </button>
      </div>
    </form>
  );

  return (
    <div className="personal-ask-layout">
      <section className="personal-ask-main">
        {turns.length === 0 ? (
          <div className="personal-ask-welcome">
            <h1 ref={headingRef} tabIndex={-1}>
              What would you like to do?
            </h1>
            {composer}
          </div>
        ) : (
          <div className="personal-ask-conversation">
            <div className="personal-ask-conversation-heading">
              <h1 ref={headingRef} tabIndex={-1}>
                Ask
              </h1>
              <button onClick={onNew} type="button">
                <Plus aria-hidden="true" /> New
              </button>
            </div>
            <div aria-live="polite" className="personal-ask-turns">
              {turns.map((turn) => (
                <article className="personal-ask-turn" key={turn.id}>
                  <p className="personal-ask-question">{turn.query}</p>
                  {turn.status === "pending" ? (
                    <p className="personal-ask-pending">
                      <LoaderCircle aria-hidden="true" /> Searching Personal
                      Memory…
                    </p>
                  ) : turn.status === "error" ? (
                    <p className="personal-ask-error">
                      {turn.errorMessage ?? "Memory Answer failed."}
                    </p>
                  ) : turn.answerMarkdown ? (
                    <SecureMarkdown
                      adapters={markdownAdapters}
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
