import { FileText, GitBranch, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceProjectSource } from "@koed/shared";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type {
  SharedProjectIdentity,
  SharedProjectStore
} from "./shared-project-store.js";
import "../project/hq-project-sources.css";
import "./shared-project.css";

export function SharedProjectSources({
  store,
  identity,
  panelHost,
  deleteSource,
  onOpenChange,
  onContextChange,
  closeSignal
}: {
  store: SharedProjectStore;
  identity: SharedProjectIdentity;
  panelHost?: HTMLElement | null;
  deleteSource?: CollaborationRendererClient["deleteWorkspaceProjectSource"];
  onOpenChange?: (open: boolean) => void;
  onContextChange?: (label: string | null) => void;
  closeSignal?: number;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.current,
    store.current
  );
  const sameIdentity =
    snapshot.identity?.ownerId === identity.ownerId &&
    snapshot.identity.profileKey === identity.profileKey &&
    snapshot.identity.personalProjectId === identity.personalProjectId &&
    snapshot.identity.workspaceProjectId === identity.workspaceProjectId &&
    snapshot.identity.teamBackendId === identity.teamBackendId;
  const sources = sameIdentity ? (snapshot.state?.sources ?? []) : [];
  const readOnly = !sameIdentity || !snapshot.state || snapshot.state.readOnly;
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [removed, setRemoved] = useState<WorkspaceProjectSource | null>(null);
  const [content, setContent] = useState<{
    sourceId: string;
    noteRevisionId: string;
    text: string;
  } | null>(null);
  const [contentError, setContentError] = useState(false);
  const [actionError, setActionError] = useState("");
  const identityGeneration = useRef(0);
  const selected = sources.find((source) => source.id === selectedId) ?? null;
  const setPanelOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    onContextChange?.(next ? "Sources" : null);
  };
  useEffect(() => {
    identityGeneration.current += 1;
    setPanelOpen(false);
    setSelectedId(null);
    setContent(null);
    setContentError(false);
    setEditingName(null);
    setRemoved(null);
    setActionError("");
  }, [
    identity.ownerId,
    identity.profileKey,
    identity.personalProjectId,
    identity.workspaceProjectId,
    identity.teamBackendId
  ]);
  useEffect(() => {
    if (!closeSignal) return;
    setPanelOpen(false);
    setSelectedId(null);
  }, [closeSignal]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editingName !== null) setEditingName(null);
      else {
        setSelectedId(null);
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, editingName]);
  useEffect(() => {
    onContextChange?.(open ? (selected?.name ?? "Sources") : null);
  }, [open, selected?.id, selected?.name, onContextChange]);
  useEffect(() => {
    setContent(null);
    setContentError(false);
    if (
      !open ||
      !selected ||
      selected.kind !== "doc" ||
      selected.status !== "ready"
    )
      return;
    let active = true;
    void store.readSource(selected.id).then((value) => {
      if (!active) return;
      if (value) setContent(value);
      else setContentError(true);
    });
    return () => {
      active = false;
    };
  }, [
    open,
    selected?.id,
    selected?.personalNoteRevisionId,
    selected?.status,
    selected?.version,
    identity.ownerId,
    identity.profileKey,
    identity.workspaceProjectId
  ]);
  const sourceRow = (source: WorkspaceProjectSource) => (
    <button
      type="button"
      className="hq-project-sources__row"
      key={source.id}
      onClick={() => setSelectedId(source.id)}
    >
      <span className="hq-project-sources__icon">
        {source.kind === "repo" ? (
          <GitBranch size={15} />
        ) : (
          <FileText size={15} />
        )}
      </span>
      <span>
        <b>{source.name}</b>
        <em>
          {source.kind === "doc"
            ? "Document"
            : source.kind === "repo"
              ? "Repository"
              : "Source"}
          {source.status !== "ready" ? " · Processing" : ""}
        </em>
      </span>
    </button>
  );
  return (
    <div className="hq-project-sources">
      <div className="hq-project-sources__chips">
        <button
          type="button"
          className="hq-project-sources__count"
          aria-label={`Open ${sources.length} Project sources`}
          onClick={() => setPanelOpen(true)}
        >
          <GitBranch size={14} />
          <b>{sources.length}</b> sources
        </button>
        {sources
          .filter((source) => source.kind === "doc")
          .slice(0, 1)
          .map((source) => (
            <button
              type="button"
              className="hq-project-sources__key"
              key={source.id}
              onClick={() => {
                setSelectedId(source.id);
                setPanelOpen(true);
              }}
            >
              <FileText size={13} />
              {source.name}
            </button>
          ))}
      </div>
      {open && panelHost
        ? createPortal(
            <section
              className="hq-project-sources__panel"
              aria-label={selected?.name ?? "Sources"}
            >
              <div className="hq-project-sources__panel-head">
                <strong>{selected?.name ?? "Sources"}</strong>
                <button
                  type="button"
                  aria-label="Close Sources"
                  onClick={() => {
                    setSelectedId(null);
                    setPanelOpen(false);
                  }}
                >
                  <X size={17} />
                </button>
              </div>
              <div className="hq-project-sources__panel-sub">
                Sources in this Project
              </div>
              <div className="hq-project-sources__panel-body">
                {selected ? (
                  <>
                    {actionError ? <p role="alert">{actionError}</p> : null}
                    <p className="hq-project-sources__detail">
                      {selected.kind === "doc"
                        ? "Document"
                        : selected.kind === "repo"
                          ? "Repository"
                          : "Source"}
                      {selected.status !== "ready"
                        ? ` · ${selected.status}`
                        : ""}
                    </p>
                    {content?.sourceId === selected.sourceProjectSourceId ? (
                      <div className="hq-project-sources__document">
                        <p className="hq-project-sources__revision">Document</p>
                        <pre>{content.text}</pre>
                      </div>
                    ) : contentError &&
                      selected.kind === "doc" &&
                      selected.status === "ready" ? (
                      <p className="hq-project-sources__note">
                        Only the uploader can read this document here.
                      </p>
                    ) : null}
                    {editingName !== null ? (
                      <form
                        className="hq-shared-sources__rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (
                            busy ||
                            readOnly ||
                            !editingName.trim() ||
                            editingName.trim().length > 500
                          )
                            return;
                          setBusy(true);
                          void store
                            .patchSource(selected.id, selected.version, {
                              name: editingName.trim()
                            })
                            .then((source) => {
                              if (source) setEditingName(null);
                            })
                            .finally(() => setBusy(false));
                        }}
                      >
                        <input
                          autoFocus
                          aria-label="Source name"
                          maxLength={500}
                          value={editingName}
                          onChange={(event) =>
                            setEditingName(event.target.value)
                          }
                        />
                        <button
                          type="submit"
                          disabled={busy || readOnly || !editingName.trim()}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingName(null)}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : null}
                    <div className="hq-project-sources__actions">
                      <button
                        type="button"
                        disabled={busy || readOnly}
                        onClick={() => setEditingName(selected.name)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          readOnly ||
                          !deleteSource ||
                          !snapshot.state?.project
                        }
                        onClick={() => {
                          setBusy(true);
                          setActionError("");
                          const project = snapshot.state?.project;
                          if (!project || !deleteSource) {
                            setBusy(false);
                            return;
                          }
                          const generation = identityGeneration.current;
                          void deleteSource({
                            teamId: project.teamId,
                            projectId: project.id,
                            sourceId: selected.id,
                            expectedProjectVersion: project.version,
                            expectedSourceVersion: selected.version
                          })
                            .then(async (result) => {
                              if (generation !== identityGeneration.current)
                                return;
                              setRemoved({
                                ...selected,
                                version: result.version
                              });
                              setSelectedId(null);
                              await store.refresh();
                            })
                            .catch(() => {
                              if (generation !== identityGeneration.current)
                                return;
                              setActionError(
                                "Source removal was not completed. Review the current Source and try again."
                              );
                              void store.refresh();
                            })
                            .finally(() => {
                              if (generation === identityGeneration.current)
                                setBusy(false);
                            });
                        }}
                      >
                        Remove
                      </button>
                      <button type="button" onClick={() => setSelectedId(null)}>
                        All sources
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="hq-project-sources__rows">
                    {removed ? (
                      <p className="hq-shared-sources__undo" role="status">
                        Source removed.{" "}
                        <button
                          type="button"
                          disabled={busy || readOnly}
                          onClick={() => {
                            setBusy(true);
                            void store
                              .patchSource(removed.id, removed.version, {
                                deleted: false
                              })
                              .then((source) => {
                                if (source) setRemoved(null);
                              })
                              .finally(() => setBusy(false));
                          }}
                        >
                          Undo
                        </button>
                      </p>
                    ) : null}
                    {sources.map(sourceRow)}
                    {!sources.length ? (
                      <p className="hq-project-sources__empty">
                        No sources in this Project yet.
                      </p>
                    ) : null}
                    <div className="hq-project-sources__actions">
                      <button
                        type="button"
                        disabled={busy || readOnly}
                        onClick={() =>
                          void (async () => {
                            setBusy(true);
                            try {
                              const source = await store.pickSource();
                              if (source) setSelectedId(source.id);
                            } finally {
                              setBusy(false);
                            }
                          })()
                        }
                      >
                        <Plus size={15} /> Add a document
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>,
            panelHost
          )
        : null}
    </div>
  );
}
