import type { CollaborationMessage } from "@koed/shared/collaboration";
import { SecureMarkdown, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import { ArrowLeft, NotebookPen, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import "./personal-memory.css";

export function PersonalNotesView({
  markdownAdapters,
  messages,
  newNote,
  onBack,
  onNew,
  onSave,
  onSelect,
  selectedNoteId
}: {
  markdownAdapters: MarkdownPlatformAdapters;
  messages: readonly CollaborationMessage[];
  newNote: boolean;
  onBack: () => void;
  onNew: () => void;
  onSave: (body: string) => Promise<void>;
  onSelect: (noteId: string) => void;
  selectedNoteId?: string;
}) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const ordered = useMemo(
    () => [...messages].sort((left, right) => right.sequence - left.sequence),
    [messages]
  );
  const filtered = ordered.filter((message) =>
    message.body.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );
  const selected = ordered.find((message) => message.id === selectedNoteId);
  const detailOpen = newNote || Boolean(selected);

  useEffect(() => {
    (detailOpen ? detailHeadingRef : listHeadingRef).current?.focus({
      preventScroll: true
    });
  }, [detailOpen, newNote, selectedNoteId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(body);
      setDraft("");
    } catch {
      setError("The Note was saved to Inbox for recovery.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="personal-notes-workspace"
      data-narrow-view={detailOpen ? "detail" : "list"}
      data-responsive="master-detail-to-drilldown"
    >
      <aside className="personal-notes-list">
        <header>
          <h1
            className="personal-route-heading"
            ref={listHeadingRef}
            tabIndex={-1}
          >
            Notes
          </h1>
          <span aria-label={`${messages.length} Notes`}>{messages.length}</span>
        </header>
        <label className="personal-notes-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search Notes</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Notes"
            type="search"
            value={search}
          />
        </label>
        <div className="personal-note-items">
          <button
            aria-current={newNote ? "page" : undefined}
            aria-label="New Note"
            className="personal-note-new"
            onClick={onNew}
            type="button"
          >
            <Plus aria-hidden="true" />
            <span>
              <strong>New Note</strong>
            </span>
          </button>
          {filtered.map((message) => (
            <button
              aria-current={message.id === selectedNoteId ? "page" : undefined}
              key={message.id}
              onClick={() => onSelect(message.id)}
              type="button"
            >
              <NotebookPen aria-hidden="true" />
              <span>
                <strong>
                  {message.body.split(/\r?\n/u)[0] || "Untitled Note"}
                </strong>
                <small>{new Date(message.createdAt).toLocaleString()}</small>
              </span>
            </button>
          ))}
          {filtered.length === 0 ? <p>No Notes found.</p> : null}
        </div>
      </aside>
      <section className="personal-note-detail">
        <button className="personal-notes-back" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" /> Back to Notes
        </button>
        {newNote ? (
          <form
            onSubmit={(event) => {
              void save(event);
            }}
          >
            <h1
              className="personal-route-heading"
              ref={detailHeadingRef}
              tabIndex={-1}
            >
              New Note
            </h1>
            <textarea
              aria-label="Note content"
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a Note…"
              rows={12}
              value={draft}
            />
            <button disabled={saving || !draft.trim()} type="submit">
              {saving ? "Saving…" : "Save Note"}
            </button>
            {error ? <p role="status">{error}</p> : null}
          </form>
        ) : selected ? (
          <article>
            <h1
              className="personal-route-heading"
              ref={detailHeadingRef}
              tabIndex={-1}
            >
              Note
            </h1>
            <time dateTime={selected.createdAt}>
              {new Date(selected.createdAt).toLocaleString()}
            </time>
            <SecureMarkdown
              adapters={markdownAdapters}
              className="personal-note-markdown"
              source={selected.body}
            />
          </article>
        ) : (
          <div className="personal-note-empty">
            <NotebookPen aria-hidden="true" />
            <h1
              className="personal-route-heading"
              ref={detailHeadingRef}
              tabIndex={-1}
            >
              Select a Note
            </h1>
            <p>Choose a Note from the list or create a new one.</p>
          </div>
        )}
      </section>
    </div>
  );
}
