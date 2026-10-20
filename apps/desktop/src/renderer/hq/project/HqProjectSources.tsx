import { FileText, Folder, GitBranch, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectSource } from "@koed/shared";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import "./hq-project-sources.css";

const icon = (kind: ProjectSource["kind"]) =>
  kind === "doc" ? (
    <FileText size={15} />
  ) : kind === "folder" ? (
    <Folder size={15} />
  ) : kind === "repo" ? (
    <GitBranch size={15} />
  ) : (
    <Sparkles size={15} />
  );
const meta = (source: ProjectSource) =>
  source.status === "failed"
    ? `Could not read · ${source.failureReason?.replaceAll("_", " ") ?? "unknown reason"}`
    : source.kind === "skill"
      ? "Skill reference"
      : source.kind === "doc"
        ? source.currentRevisionId
          ? "Readable document"
          : "Document is not readable yet"
        : source.kind === "folder"
          ? "Folder reference · files stay in place"
          : "Repository remote reference";

export function HqProjectSources({
  projectId,
  projectName,
  api,
  visibilityOwnerId,
  visibilityProfileKey,
  panelHost,
  onOpenChange,
  onContextChange,
  closeSignal
}: {
  projectId: string;
  projectName: string;
  api: ProjectsDesktopApi;
  visibilityOwnerId?: string | null;
  visibilityProfileKey?: string | null;
  panelHost?: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
  onContextChange?: (label: string | null) => void;
  closeSignal?: number;
}) {
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [repos, setRepos] = useState<Array<{ name: string; uri: string }>>([]);
  const [reposOpen, setReposOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<Awaited<
    ReturnType<NonNullable<ProjectsDesktopApi["sourceRead"]>>
  > | null>(null);
  const [reading, setReading] = useState(false);
  const [removal, setRemoval] = useState<Awaited<
    ReturnType<NonNullable<ProjectsDesktopApi["sourceRemoval"]>>
  > | null>(null);
  const view = useRef({ selected, open });
  view.current = { selected, open };
  useLayoutEffect(() => {
    setRemoval(null);
  }, [selected, open]);
  const setPanelOpen = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
  };
  const identity = useRef({
    api,
    projectId,
    visibilityOwnerId,
    visibilityProfileKey,
    generation: 0
  });
  if (
    identity.current.api !== api ||
    identity.current.projectId !== projectId ||
    identity.current.visibilityOwnerId !== visibilityOwnerId ||
    identity.current.visibilityProfileKey !== visibilityProfileKey
  ) {
    identity.current = {
      api,
      projectId,
      visibilityOwnerId,
      visibilityProfileKey,
      generation: identity.current.generation + 1
    };
  }
  useLayoutEffect(() => {
    const generation = identity.current.generation;
    const current = () => identity.current.generation === generation;
    setSources([]);
    setPanelOpen(false);
    setSelected(null);
    setRepos([]);
    setReposOpen(false);
    setBusy(false);
    setError("");
    setDocument(null);
    setReading(false);
    setRemoval(null);
    void api
      .sourceList(projectId)
      .then((value) => {
        if (current()) setSources(value);
      })
      .catch(() => {
        if (current()) setError("Sources could not be loaded. Retry.");
      });
    return () => {
      if (current()) identity.current.generation += 1;
    };
  }, [api, projectId, visibilityOwnerId, visibilityProfileKey]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPanelOpen(false);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const refresh = async (current: () => boolean) => {
    const result = await api.sourceList(projectId);
    if (current()) {
      setSources(result);
      setError("");
    }
  };
  const keyItems = useMemo(
    () =>
      sources
        .filter(
          (source) =>
            source.kind === "doc" &&
            source.status === "ready" &&
            source.currentRevisionId !== null
        )
        .sort(
          (a, b) =>
            b.uses - a.uses ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id)
        )
        .slice(0, 3),
    [sources]
  );
  const source = selected ? sources.find((item) => item.id === selected) : null;
  useEffect(() => {
    if (
      !open ||
      !sources.some(
        (item) => item.status === "extracting" || item.status === "uploading"
      )
    )
      return;
    const generation = identity.current.generation;
    const timer = window.setInterval(() => {
      if (identity.current.generation === generation)
        void refresh(() => identity.current.generation === generation).catch(
          () => undefined
        );
    }, 1500);
    return () => window.clearInterval(timer);
  }, [api, open, projectId, sources]);
  useEffect(() => {
    let live = true;
    setDocument(null);
    setReading(false);
    if (
      !open ||
      !selected ||
      source?.kind !== "doc" ||
      source.status !== "ready" ||
      !source.currentRevisionId ||
      !api.sourceRead
    )
      return () => {
        live = false;
      };
    const generation = identity.current.generation;
    const noteRevisionId = source.currentRevisionId;
    setReading(true);
    void api
      .sourceRead(projectId, selected, noteRevisionId)
      .then((value) => {
        if (
          live &&
          identity.current.generation === generation &&
          value.sourceId === selected &&
          value.noteRevisionId === noteRevisionId
        )
          setDocument(value);
      })
      .catch((cause) => {
        if (live && identity.current.generation === generation)
          setError(
            cause instanceof Error
              ? cause.message
              : "Document could not be read."
          );
      })
      .finally(() => {
        if (live && identity.current.generation === generation)
          setReading(false);
      });
    return () => {
      live = false;
    };
  }, [
    api,
    open,
    projectId,
    selected,
    source?.currentRevisionId,
    source?.kind,
    source?.status
  ]);
  useEffect(() => {
    onContextChange?.(open && source?.kind === "doc" ? source.name : null);
  }, [open, source?.id, source?.kind, source?.name, onContextChange]);
  useEffect(() => {
    if (!closeSignal) return;
    setPanelOpen(false);
    setSelected(null);
  }, [closeSignal]);
  const act = async (
    run: (current: () => boolean) => Promise<unknown>,
    shouldRefresh = true
  ) => {
    const generation = identity.current.generation;
    const current = () => identity.current.generation === generation;
    setBusy(true);
    setError("");
    try {
      await run(current);
      if (current() && shouldRefresh) await refresh(current);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Source action failed. Retry."
        );
    } finally {
      if (current()) setBusy(false);
    }
  };
  const panel = open ? (
    <section
      className="hq-project-sources__panel"
      aria-label={source ? source.name : "Sources"}
    >
      <div className="hq-project-sources__panel-head">
        <strong>{source ? source.name : "Sources"}</strong>
        <button
          type="button"
          aria-label="Close Sources"
          onClick={() => {
            setPanelOpen(false);
            setSelected(null);
          }}
        >
          <X size={17} />
        </button>
      </div>
      <div className="hq-project-sources__panel-sub">
        {source
          ? `${source.kind === "skill" ? "Skill" : "Source"} · ${projectName}`
          : `${projectName} reads these`}
      </div>
      <div className="hq-project-sources__panel-body">
        {source ? (
          <>
            <p className="hq-project-sources__detail">{meta(source)}</p>
            {source.uri ? (
              <p className="hq-project-sources__uri">{source.uri}</p>
            ) : null}
            <p className="hq-project-sources__note">
              {source.kind === "skill"
                ? "This skill is listed as a Project reference. Ask your Chief of Staff to use it by name. Listing it does not run the skill or add its outputs to memory."
                : source.kind === "doc"
                  ? source.status === "ready"
                    ? "Read this document here. Its text is also available in your Personal Memory."
                    : "This document is being prepared for your Personal Memory."
                  : "The folder or repository stays in place. Agents may read its files through their own tools during your Conversation; Koed does not ingest them."}
            </p>
            {source.kind === "doc" && source.status === "ready" ? (
              <div className="hq-project-sources__document">
                {reading ? (
                  <p>Reading document…</p>
                ) : document &&
                  document.sourceId === source.id &&
                  document.noteRevisionId === source.currentRevisionId ? (
                  <>
                    <p className="hq-project-sources__revision">
                      Personal document
                    </p>
                    <pre>{document.text}</pre>
                  </>
                ) : null}
              </div>
            ) : null}
            {removal && !removal.complete ? (
              <p role="status" className="hq-project-sources__note">
                {removal.pendingReviews.length
                  ? "Source removal is waiting for Native approval."
                  : removal.cancellationPending
                    ? "Source removal cancellation is finishing."
                    : "Source removal is waiting for Share Grant freeze."}
              </p>
            ) : null}
            <div className="hq-project-sources__actions">
              {source.status === "failed" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.sourceRetry(projectId, source.id))
                  }
                >
                  Retry
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async (current) => {
                    const sameSource = () =>
                      current() &&
                      view.current.open &&
                      view.current.selected === source.id;
                    if (
                      source.kind === "doc" &&
                      source.currentRevisionId &&
                      api.sourceRemoval
                    ) {
                      const status = await api.sourceRemoval(
                        projectId,
                        source.id
                      );
                      if (sameSource()) {
                        setRemoval(status);
                        if (status.complete) setSelected(null);
                      }
                    } else {
                      await api.sourceRemove(projectId, source.id);
                      if (sameSource()) setSelected(null);
                    }
                  })
                }
              >
                Remove
              </button>
              {removal &&
              !removal.complete &&
              removal.pendingReviews.length > 0 &&
              api.sourceReview ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async (current) => {
                      const review = removal.pendingReviews[0]!;
                      const status = await api.sourceReview!(
                        projectId,
                        source.id,
                        removal.batchId,
                        review.actionGrantId
                      );
                      if (
                        current() &&
                        view.current.open &&
                        view.current.selected === source.id
                      ) {
                        setRemoval(status);
                        if (status.complete) setSelected(null);
                      }
                    })
                  }
                >
                  Review Share Grant
                </button>
              ) : null}
              {removal && !removal.complete && api.sourceRemoval ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async (current) => {
                      const status = await api.sourceRemoval!(
                        projectId,
                        source.id
                      );
                      if (
                        current() &&
                        view.current.open &&
                        view.current.selected === source.id
                      ) {
                        setRemoval(status);
                        if (status.complete) setSelected(null);
                      }
                    })
                  }
                >
                  Check status
                </button>
              ) : null}
              <button type="button" onClick={() => setSelected(null)}>
                All sources
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="hq-project-sources__rows">
              {sources
                .filter((item) => item.kind !== "skill")
                .map((item) => (
                  <button
                    type="button"
                    className="hq-project-sources__row"
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="hq-project-sources__icon">
                      {icon(item.kind)}
                    </span>
                    <span>
                      <b>{item.name}</b>
                      <em>{meta(item)}</em>
                    </span>
                  </button>
                ))}
            </div>
            {sources.some((item) => item.kind === "skill") ? (
              <>
                <div className="hq-project-sources__label">
                  Skills used here
                </div>
                <div className="hq-project-sources__rows">
                  {sources
                    .filter((item) => item.kind === "skill")
                    .map((item) => (
                      <button
                        type="button"
                        className="hq-project-sources__row"
                        key={item.id}
                        onClick={() => setSelected(item.id)}
                      >
                        <span className="hq-project-sources__icon">
                          {icon(item.kind)}
                        </span>
                        <span>
                          <b>{item.name}</b>
                          <em>{meta(item)}</em>
                        </span>
                      </button>
                    ))}
                </div>
              </>
            ) : null}
            {!sources.length ? (
              <p className="hq-project-sources__empty">
                No sources in this Project yet.
              </p>
            ) : null}
            <div className="hq-project-sources__actions">
              <button
                type="button"
                disabled={busy || !api.sourceUpload}
                onClick={() =>
                  void act(async (current) => {
                    const uploaded = await api.sourceUpload?.(projectId);
                    if (current() && uploaded) {
                      setSelected(uploaded.id);
                      setPanelOpen(true);
                    }
                  })
                }
              >
                <Plus size={15} />
                Add a doc
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async (current) => {
                    const found = await api.sourceDiscoverRepos(projectId);
                    if (current()) {
                      setRepos(found);
                      setReposOpen(true);
                    }
                  }, false)
                }
              >
                <GitBranch size={15} />
                Link a repo
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async (current) => {
                    const folder = await api.pickFolder();
                    if (current() && folder)
                      await api.sourceCreate(projectId, {
                        kind: "folder",
                        name:
                          folder.split(/[\\/]/).filter(Boolean).at(-1) ??
                          folder,
                        uri: folder
                      });
                  })
                }
              >
                <Folder size={15} />
                Add a folder
              </button>
            </div>
            {reposOpen ? (
              <div className="hq-project-sources__repos">
                <div className="hq-project-sources__label">
                  Remotes in this Project folder
                </div>
                {repos.length ? (
                  repos.map((repo) => (
                    <button
                      type="button"
                      key={repo.uri}
                      disabled={busy}
                      onClick={() =>
                        void act(async (current) => {
                          await api.sourceCreate(projectId, {
                            kind: "repo",
                            name: repo.name,
                            uri: repo.uri
                          });
                          if (current()) setReposOpen(false);
                        })
                      }
                    >
                      {repo.name}
                    </button>
                  ))
                ) : (
                  <p>No portable Git remotes found.</p>
                )}
              </div>
            ) : null}
            <p className="hq-project-sources__note">
              Your Chief of Staff can read the Project folder with its own
              tools. Folders and repositories are references; their files are
              not ingested. Documents become readable after ingestion creates a
              Personal Note revision.
            </p>
          </>
        )}
        {error ? (
          <p role="alert" className="hq-project-sources__error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  ) : null;
  return (
    <div className="hq-project-sources">
      <div className="hq-project-sources__chips">
        <button
          type="button"
          className="hq-project-sources__count"
          onClick={() => setPanelOpen(true)}
          aria-label={`Open ${sources.length} Project sources`}
        >
          <GitBranch size={14} />
          <b>{sources.length}</b> sources
        </button>
        {keyItems.map((item) => (
          <button
            type="button"
            className="hq-project-sources__key"
            key={item.id}
            onClick={() => {
              setSelected(item.id);
              setPanelOpen(true);
            }}
            title="Key to this Project"
          >
            <FileText size={13} />
            {item.name}
          </button>
        ))}
      </div>
      {error && !open ? (
        <p role="alert" className="hq-project-sources__error">
          {error}{" "}
          <button type="button" onClick={() => void act(refresh, false)}>
            Retry
          </button>
        </p>
      ) : null}
      {panel &&
        (onOpenChange
          ? panelHost
            ? createPortal(panel, panelHost)
            : null
          : panel)}
    </div>
  );
}
