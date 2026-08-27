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
  onSave: (body: string, idempotencyKey: string) => Promise<void>;
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
  const createMutationRef = useRef<{
    body: string;
    idempotencyKey: string;
  } | null>(null);
  const updateMutationRef = useRef<{
    body: string;
    expectedRevision: number;
    idempotencyKey: string;
    noteId: string;
  } | null>(null);
  const editingBodyRef = useRef(false);
  const renamingRef = useRef(false);
  const selectionGenerationRef = useRef(0);
  const selectedNoteIdRef = useRef(selectedNoteId);
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
    editingBodyRef.current = editingBody;
  }, [editingBody]);

  useEffect(() => {
    renamingRef.current = renaming;
  }, [renaming]);

  useEffect(() => {
    selectionGenerationRef.current += 1;
    selectedNoteIdRef.current = selectedNoteId;
    updateMutationRef.current = null;
    setEditingBody(false);
    setRenaming(false);
    setUpdatingBody(false);
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
  }, [loadNote, selectedNoteId]);

  useEffect(() => {
    if (changeRevision === 0 || !selectedNoteId || !loadNote) return;
    let active = true;
    void loadNote({ noteId: selectedNoteId })
      .then((note) => {
        if (!active || selectedNoteIdRef.current !== note.noteId) return;
        setDetail(note);
        if (!renamingRef.current) setRenameTitle(note.title);
        if (!editingBodyRef.current) setBodyDraft(note.body);
        setError(null);
      })
      .catch(() => {
        if (active && selectedNoteIdRef.current === selectedNoteId) {
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
    const mutation =
      createMutationRef.current?.body === body
        ? createMutationRef.current
        : { body, idempotencyKey: crypto.randomUUID() };
    createMutationRef.current = mutation;
    try {
      await onSave(body, mutation.idempotencyKey);
      if (createMutationRef.current === mutation) {
        createMutationRef.current = null;
      }
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
    const noteId = detail.noteId;
    const selectionGeneration = selectionGenerationRef.current;
    try {
      const renamed = await renameNote({
        noteId,
        expectedTitleVersion: detail.titleVersion,
        title: renameTitle
      });
      if (
        selectedNoteIdRef.current === noteId &&
        selectionGenerationRef.current === selectionGeneration
      ) {
        setDetail((current) =>
          current?.noteId === noteId ? { ...current, ...renamed } : current
        );
        setRenaming(false);
        setError(null);
      }
      setNotes((current) =>
        current.map((note) => (note.noteId === renamed.noteId ? renamed : note))
      );
    } catch {
      if (
        selectedNoteIdRef.current === noteId &&
        selectionGenerationRef.current === selectionGeneration
      ) {
        setError("The Note title changed elsewhere. Refresh and try again.");
      }
    }
  };

  const submitBody = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !updateNote || updatingBody) return;
    const body = bodyDraft.trim();
    if (!body) return;
    const noteId = detail.noteId;
    const expectedRevision = detail.revision;
    const selectionGeneration = selectionGenerationRef.current;
    const mutation = updateMutationRef.current;
    const attempt =
      mutation?.noteId === noteId &&
      mutation.expectedRevision === expectedRevision &&
      mutation.body === body
        ? mutation
        : {
            body,
            expectedRevision,
            idempotencyKey: crypto.randomUUID(),
            noteId
          };
    updateMutationRef.current = attempt;
    setUpdatingBody(true);
    setError(null);
    try {
      const updated = await updateNote({
        noteId,
        expectedRevision,
        body,
        idempotencyKey: attempt.idempotencyKey
      });
      if (updateMutationRef.current === attempt) {
        updateMutationRef.current = null;
      }
      if (
        selectedNoteIdRef.current === noteId &&
        selectionGenerationRef.current === selectionGeneration
      ) {
        setDetail(updated);
        setBodyDraft(updated.body);
        setEditingBody(false);
      }
      await refresh();
    } catch {
      if (
        selectedNoteIdRef.current === noteId &&
        selectionGenerationRef.current === selectionGeneration
      ) {
        setError(
          "The Note changed elsewhere or could not be saved. Refresh and try again."
        );
      }
    } finally {
      if (
        selectedNoteIdRef.current === noteId &&
        selectionGenerationRef.current === selectionGeneration
      ) {
        setUpdatingBody(false);
      }
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
              onChange={(event) => {
                setDraft(event.target.value);
                if (
                  createMutationRef.current?.body !== event.target.value.trim()
                ) {
                  createMutationRef.current = null;
                }
              }}
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
                {onShare ? (
                  <button
                    aria-label="Share Note"
                    className="personal-note-share"
                    disabled={detail.projectionState !== "available"}
                    onClick={() => onShare(detail)}
                    type="button"
                  >
                    Share
                  </button>
                ) : null}
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
                  onChange={(event) => {
                    setBodyDraft(event.target.value);
                    if (
                      updateMutationRef.current?.body !==
                      event.target.value.trim()
                    ) {
                      updateMutationRef.current = null;
                    }
                  }}
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
                      updateMutationRef.current = null;
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
              <div
                className="personal-note-body-trigger"
                data-editable={Boolean(updateNote)}
                onClick={(event) => {
                  if (
                    !updateNote ||
                    (event.target instanceof Element &&
                      event.target.closest("button"))
                  ) {
                    return;
                  }
                  setEditingBody(true);
                }}
              >
                {updateNote ? (
                  <button
                    aria-label="Edit Note content"
                    className="sr-only"
                    onClick={() => setEditingBody(true)}
                    type="button"
                  >
                    Edit Note content
                  </button>
                ) : null}
                <SecureMarkdown
                  adapters={markdownAdapters}
                  className="personal-note-markdown"
                  source={detail.body}
                />
              </div>
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
