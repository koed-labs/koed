import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PersonalDesktopApi,
  PersonalDesktopAskTurn,
  PersonalDesktopNoteSummary
} from "@koed/shared/personal-desktop";
import { SecureMarkdown } from "@koed/memory-ui";
import { createRendererPlatform } from "../services/platform.js";

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function V1MemoryPanel({
  api,
  onClose
}: {
  api: PersonalDesktopApi;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<PersonalDesktopNoteSummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [turn, setTurn] = useState<PersonalDesktopAskTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ query: string; key: string } | null>(null);
  const platform = useMemo(() => createRendererPlatform(), []);
  const adapters = {
    openExternal: platform.openExternal,
    writeClipboard: platform.copyText
  };
  useEffect(() => {
    let active = true;
    void api
      .listNotes?.({ limit: 50 })
      .then((result) => {
        if (active) {
          setNotes(result.notes);
          setCursor(result.nextBeforeSequence);
        }
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    if (!turn || turn.status !== "pending" || !api.loadAskThread) return;
    let active = true,
      loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const turns = await api.loadAskThread!({
          askThreadId: turn.askThreadId
        });
        const next = turns.find((item) => item.id === turn.id);
        if (active && next) setTurn(next);
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        loading = false;
      }
    };
    const unsubscribe = api.subscribe(() => {
      void refresh();
    });
    const interval = setInterval(() => {
      void refresh();
    }, 2500);
    void refresh();
    return () => {
      active = false;
      unsubscribe();
      clearInterval(interval);
    };
  }, [api, turn?.id, turn?.status]);
  const ask = async () => {
    if (!api.submitAsk || !query.trim() || busy || turn?.status === "pending")
      return;
    setBusy(true);
    setError("");
    if (request.current?.query !== query.trim())
      request.current = { query: query.trim(), key: crypto.randomUUID() };
    try {
      setTurn(
        await api.submitAsk({
          query: request.current.query,
          idempotencyKey: request.current.key
        })
      );
      request.current = null;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="v1-memory-panel" aria-label="Personal Memory">
      <header>
        <h2>Memory</h2>
        <button type="button" onClick={onClose} aria-label="Close memory">
          ×
        </button>
      </header>
      <p>
        Personal Memory from your work. Imported conversations contribute to
        memory without appearing in your chat history.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <label>
          Ask your memory
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="What do you remember?"
          />
        </label>
        <button
          type="submit"
          disabled={busy || turn?.status === "pending" || !query.trim()}
        >
          {busy || turn?.status === "pending" ? "Recalling…" : "Ask"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {turn && (
        <section aria-live="polite">
          <h3>{turn.query}</h3>
          {turn.status === "pending" ? (
            <p>Looking for relevant memory…</p>
          ) : turn.status === "error" ? (
            <p role="alert">
              {turn.errorMessage ?? "Recall could not finish."}
            </p>
          ) : (
            <SecureMarkdown
              adapters={adapters}
              source={turn.answerMarkdown ?? "No answer was returned."}
            />
          )}
        </section>
      )}
      <h3>Personal notes</h3>
      {notes.length === 0 && <p>No notes yet.</p>}
      {notes.map((note) => (
        <article key={note.noteId}>
          <strong>{note.title}</strong>
          <small>
            {note.projectionState === "available"
              ? "Available to recall"
              : note.projectionState === "pending"
                ? "Preparing memory"
                : "Needs attention"}
          </small>
        </article>
      ))}
      {cursor !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .listNotes?.({ limit: 50, beforeSequence: cursor })
              .then((result) => {
                setNotes((current) => [...current, ...result.notes]);
                setCursor(result.nextBeforeSequence);
              })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setBusy(false));
          }}
        >
          Show more
        </button>
      )}
    </aside>
  );
}
