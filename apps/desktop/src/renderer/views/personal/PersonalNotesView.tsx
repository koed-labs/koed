import type {
  PersonalDesktopApi,
  PersonalDesktopNote,
  PersonalDesktopNoteSummary
} from "@koed/shared/personal-desktop";
import { SecureMarkdown, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import {
  ArrowLeft,
  Check,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent
} from "react";
import "./personal-memory.css";

export function PersonalNotesView({
  api,
  markdownAdapters,
  newNote,
  onBack,
  onNew,
  onSave,
  onSelect,
  onShare,
  selectedNoteId
}: {
  api: PersonalDesktopApi;
  markdownAdapters: MarkdownPlatformAdapters;
  newNote: boolean;
  onBack: () => void;
  onNew: () => void;
  onSave: (body: string) => Promise<void>;
  onSelect: (noteId: string) => void;
  onShare?: (note: PersonalDesktopNote) => void;
  selectedNoteId?: string;
}) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<PersonalDesktopNoteSummary[]>([]);
  const [nextBeforeSequence, setNextBeforeSequence] = useState<number | null>(
    null
  );
  const [detail, setDetail] = useState<PersonalDesktopNote | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [updatingBody, setUpdatingBody] = useState(false);
  const [changeRevision, setChangeRevision] = useState(0);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const { listNotes, loadNote, renameNote, updateNote } = api;

  const refresh = useCallback(async () => {
    if (!listNotes) return;
    try {
      const page = await listNotes({ limit: 50 });
      setNotes(page.notes);
      setNextBeforeSequence(page.nextBeforeSequence);
      setError(null);
    } catch {
      setError(
        "Notes could not be refreshed. The last loaded Notes remain visible."
      );
    }
  }, [listNotes]);

  useEffect(() => {
    void refresh();
  }, [changeRevision, refresh]);

  useEffect(
    () =>
      api.subscribe((change) => {
        if (change.type === "notes_changed") {
          setChangeRevision((revision) => revision + 1);
        }
      }),
    [api]
  );

  useEffect(() => {
    if (!selectedNoteId || !loadNote) {
      setDetail(null);
      return;
    }
    let active = true;
    void loadNote({ noteId: selectedNoteId })
      .then((note) => {
        if (!active) return;
        setDetail(note);
        setRenameTitle(note.title);
        setBodyDraft(note.body);
        setEditingBody(false);
        setError(null);
      })
      .catch(() => {
        if (active) {
          setError(
            "This Note could not be refreshed. The last loaded detail remains visible."
          );
        }
      });
    return () => {
      active = false;
    };
  }, [changeRevision, loadNote, selectedNoteId]);

  const filtered = notes.filter((note) =>
    note.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );
  const detailOpen = newNote || Boolean(selectedNoteId);

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
      await refresh();
    } catch {
      setError("The Note could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !renameNote) return;
    try {
      const renamed = await renameNote({
        noteId: detail.noteId,
        expectedTitleVersion: detail.titleVersion,
        title: renameTitle
      });
      setDetail({ ...detail, ...renamed });
      setNotes((current) =>
        current.map((note) => (note.noteId === renamed.noteId ? renamed : note))
      );
      setRenaming(false);
      setError(null);
    } catch {
      setError("The Note title changed elsewhere. Refresh and try again.");
    }
  };

  const submitBody = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !updateNote || updatingBody) return;
    const body = bodyDraft.trim();
    if (!body) return;
    setUpdatingBody(true);
    setError(null);
    try {
      const updated = await updateNote({
        noteId: detail.noteId,
        expectedRevision: detail.revision,
        body,
        idempotencyKey: crypto.randomUUID()
      });
      setDetail(updated);
      setBodyDraft(updated.body);
      setEditingBody(false);
      await refresh();
    } catch {
      setError(
        "The Note changed elsewhere or could not be saved. Refresh and try again."
      );
    } finally {
      setUpdatingBody(false);
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
          <span aria-label={`${notes.length} Notes`}>{notes.length}</span>
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
          {filtered.map((note) => (
            <button
              aria-current={note.noteId === selectedNoteId ? "page" : undefined}
              key={note.noteId}
              onClick={() => onSelect(note.noteId)}
              type="button"
            >
              <NotebookPen aria-hidden="true" />
              <span>
                <strong>{note.title}</strong>
                <small>{new Date(note.createdAt).toLocaleString()}</small>
              </span>
            </button>
          ))}
          {filtered.length === 0 ? <p>No Notes found.</p> : null}
          {nextBeforeSequence && listNotes ? (
            <button
              onClick={() => {
                void listNotes({
                  limit: 50,
                  beforeSequence: nextBeforeSequence
                })
                  .then((page) => {
                    setNotes((current) => [...current, ...page.notes]);
                    setNextBeforeSequence(page.nextBeforeSequence);
                  })
                  .catch(() => setError("Older Notes could not be loaded."));
              }}
              type="button"
            >
              Load older Notes
            </button>
          ) : null}
        </div>
      </aside>
      <section className="personal-note-detail">
        <button className="personal-notes-back" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" /> Back to Notes
        </button>
        {newNote ? (
          <form onSubmit={(event) => void save(event)}>
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
          </form>
        ) : detail ? (
          <article>
            <header className="personal-note-header">
              <div>
                <small>Personal · Private to you</small>
                {renaming ? (
                  <form
                    className="personal-note-title-editor"
                    onSubmit={(event) => void submitRename(event)}
                  >
                    <label>
                      <span className="sr-only">Note title</span>
                      <input
                        autoFocus
                        onChange={(event) => setRenameTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setRenaming(false);
                        }}
                        value={renameTitle}
                      />
                    </label>
                    <button aria-label="Save Note title" type="submit">
                      <Check aria-hidden="true" />
                    </button>
                    <button
                      aria-label="Cancel Note rename"
                      onClick={() => setRenaming(false)}
                      type="button"
                    >
                      <X aria-hidden="true" />
                    </button>
                  </form>
                ) : (
                  <div className="personal-note-title-row">
                    <h1
                      className="personal-route-heading"
                      ref={detailHeadingRef}
                      tabIndex={-1}
                    >
                      {detail.title}
                    </h1>
                    <button
                      aria-label="Rename Note"
                      className="personal-note-title-edit"
                      disabled={!renameNote}
                      onClick={() => setRenaming(true)}
                      title="Rename Note"
                      type="button"
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                  </div>
                )}
                <time dateTime={detail.createdAt}>
                  {new Date(detail.createdAt).toLocaleString()}
                </time>
              </div>
              <div className="personal-note-header-actions">
                <button
                  aria-label="Edit Note"
                  disabled={!updateNote || editingBody}
                  onClick={() => setEditingBody(true)}
                  type="button"
                >
                  <Pencil aria-hidden="true" /> Edit
                </button>
                <button
                  aria-label="Share Note"
                  className="personal-note-share"
                  disabled={!onShare || detail.projectionState !== "available"}
                  onClick={() => onShare?.(detail)}
                  type="button"
                >
                  Share
                </button>
              </div>
            </header>
            {detail.projectionState !== "available" ? (
              <p className="personal-note-processing" role="status">
                {detail.projectionState === "failed"
                  ? "Memory processing will retry in the background."
                  : "Preparing this Note for Memory…"}
              </p>
            ) : null}
            {editingBody ? (
              <form onSubmit={(event) => void submitBody(event)}>
                <textarea
                  aria-label="Note content"
                  autoFocus
                  onChange={(event) => setBodyDraft(event.target.value)}
                  rows={16}
                  value={bodyDraft}
                />
                <div className="personal-note-edit-actions">
                  <button
                    disabled={updatingBody || !bodyDraft.trim()}
                    type="submit"
                  >
                    {updatingBody ? "Saving…" : "Save"}
                  </button>
                  <button
                    disabled={updatingBody}
                    onClick={() => {
                      setBodyDraft(detail.body);
                      setEditingBody(false);
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <SecureMarkdown
                adapters={markdownAdapters}
                className="personal-note-markdown"
                source={detail.body}
              />
            )}
          </article>
        ) : selectedNoteId ? (
          <div className="personal-note-empty">
            <NotebookPen aria-hidden="true" />
            <h1
              className="personal-route-heading"
              ref={detailHeadingRef}
              tabIndex={-1}
            >
              Loading Note
            </h1>
          </div>
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
        {error ? (
          <div role="status">
            <p>{error}</p>
            <button
              onClick={() => {
                setError(null);
                setChangeRevision((revision) => revision + 1);
              }}
              type="button"
            >
              Retry Notes
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
