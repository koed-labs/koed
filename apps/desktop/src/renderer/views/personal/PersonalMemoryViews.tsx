import type {
  PersonalDesktopApi,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  NativeConversationSurface,
  type ConversationSurfaceModel
} from "../../../NativeConversationSurface.js";
import {
  projectIsActive,
  relativeTime,
  sessionPreview,
  sessionSelectionId
} from "../../../project-memory-ui.js";
import { type PersonalMemoryStore } from "../../state/personal-memory.js";
import { usePersonalMemorySnapshot } from "../../state/use-personal-memory.js";
import {
  personalMemorySharingSource,
  suggestedWorkspaceId,
  writableWorkspaceDestinations,
  type PersonalMemorySharingRecord,
  type ProjectWorkspaceSuggestion,
  type ShareToWorkspaceRequest,
  type SessionProjectAssignment,
  type WorkspaceShareCandidate
} from "./adapters.js";
import { SemanticThemeWords } from "./SemanticThemeWords.js";
import { projectThemes, sessionThemes } from "./semantic-themes.js";
import { usePersonalMemoryDetail } from "./use-personal-memory-detail.js";
import "./personal-memory.css";

export type PersonalMemoryRoute =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "session"; projectId: string; sessionId: string };

export type PersonalMemoryInspectorEvent = {
  event: PersonalDesktopConversationEvent;
  project: PersonalDesktopProject;
  thread: PersonalDesktopProjectThread;
};

export type PersonalMemoryWorkspaceProps = {
  assignSessionProject?: PersonalDesktopApi["assignSessionProject"];
  onInspectEvent?: (selection: PersonalMemoryInspectorEvent) => void;
  onNavigate: (route: PersonalMemoryRoute) => void;
  onSessionProjectAssigned?: (input: {
    projectId: string | null;
    sessionId: string;
  }) => void;
  onShareToWorkspace?: (request: ShareToWorkspaceRequest) => void;
  projectWorkspaceSuggestions?: readonly ProjectWorkspaceSuggestion[];
  route: PersonalMemoryRoute;
  sharingRecords?: readonly PersonalMemorySharingRecord[];
  store: PersonalMemoryStore;
  workspaceCandidates?: readonly WorkspaceShareCandidate[];
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const projectActivity = (project: PersonalDesktopProject): string | null =>
  project.threads
    .map((thread) => thread.latestAt)
    .filter((timestamp) => Number.isFinite(Date.parse(timestamp)))
    .sort()
    .at(-1) ?? null;

const sourceAiClientLabel = (
  source: PersonalDesktopProjectThread["sourceAiClient"]
): string | null => {
  if (source === "codex") return "Codex";
  if (source === "codex-cli") return "Codex CLI";
  return null;
};

function ProjectRow({
  project,
  selected,
  onSelect
}: {
  project: PersonalDesktopProject;
  selected: boolean;
  onSelect: () => void;
}) {
  const themes = projectThemes(project);
  return (
    <button
      aria-current={selected ? "page" : undefined}
      className="personal-project-row"
      data-project-id={project.id}
      onClick={onSelect}
      type="button"
    >
      <span className="personal-project-monogram" aria-hidden="true">
        {Array.from(project.name)[0]?.toLocaleUpperCase() ?? "P"}
      </span>
      <span className="personal-project-row-copy">
        <strong>{project.name}</strong>
        <small>
          {countLabel(project.threads.length, "Captured Session")} ·{" "}
          {countLabel(project.eventCount, "Memory Event")}
        </small>
        <small title={project.path ?? undefined}>
          {project.path ?? "Project path unavailable"}
        </small>
        <SemanticThemeWords themes={themes} />
      </span>
      <time dateTime={projectActivity(project) ?? undefined}>
        {relativeTime(projectActivity(project))}
      </time>
    </button>
  );
}

function ProjectsPane({
  error,
  loading,
  onRetry,
  onSelect,
  projects,
  selectedProjectId
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onSelect: (projectId: string) => void;
  projects: readonly PersonalDesktopProject[];
  selectedProjectId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = projects.filter((project) => {
    if (!normalizedQuery) return true;
    return [project.name, project.path ?? ""].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    );
  });
  const active = filtered.filter((project) =>
    projectIsActive({
      ...project,
      branch: null,
      catalogued: false,
      discoveredAt: null,
      isWorktree: false,
      lastSeenAt: null,
      localProjectId: null,
      remoteDisplay: null
    })
  );
  const inactive = filtered.filter(
    (project) => !active.some(({ id }) => id === project.id)
  );

  return (
    <aside className="personal-projects-pane" aria-label="Projects">
      <header>
        <div>
          <small>Personal Memory</small>
          <h1 data-personal-route-focus="projects" tabIndex={-1}>
            Projects
          </h1>
        </div>
        <span aria-label={`${projects.length} Projects`}>
          {projects.length}
        </span>
      </header>
      <label className="personal-project-search">
        <span className="sr-only">Search Projects</span>
        <input
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search Projects"
          type="search"
          value={query}
        />
      </label>
      <div className="personal-project-list">
        {loading && projects.length === 0 ? (
          <div className="personal-memory-state" role="status">
            Loading Projects…
          </div>
        ) : error && projects.length === 0 ? (
          <div className="personal-memory-state error" role="alert">
            <strong>Projects could not be loaded</strong>
            <p>{error}</p>
            <button onClick={onRetry} type="button">
              Retry
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div className="personal-memory-state" role="status">
            <strong>No Projects yet</strong>
            <p>
              Projects appear after the Supported Capture Hook records a
              Captured Session.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="personal-memory-state" role="status">
            No Projects match “{query}”.
          </div>
        ) : (
          <>
            <section aria-labelledby="personal-active-projects">
              <h2 id="personal-active-projects">
                Active <span>{active.length}</span>
              </h2>
              {active.map((project) => (
                <ProjectRow
                  key={project.id}
                  onSelect={() => onSelect(project.id)}
                  project={project}
                  selected={project.id === selectedProjectId}
                />
              ))}
            </section>
            {inactive.length ? (
              <section aria-labelledby="personal-inactive-projects">
                <button
                  aria-expanded={showInactive}
                  className="personal-inactive-toggle"
                  onClick={() => setShowInactive((current) => !current)}
                  type="button"
                >
                  <span id="personal-inactive-projects">Inactive</span>
                  <span>{inactive.length}</span>
                </button>
                {showInactive
                  ? inactive.map((project) => (
                      <ProjectRow
                        key={project.id}
                        onSelect={() => onSelect(project.id)}
                        project={project}
                        selected={project.id === selectedProjectId}
                      />
                    ))
                  : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  onSelect,
  project,
  thread
}: {
  onSelect: () => void;
  project: PersonalDesktopProject;
  thread: PersonalDesktopProjectThread;
}) {
  const source = thread.sessionId
    ? sourceAiClientLabel(thread.sourceAiClient)
    : null;
  const themes = sessionThemes(project, thread);
  return (
    <button
      className="personal-session-row"
      data-session-id={sessionSelectionId(thread)}
      onClick={onSelect}
      type="button"
    >
      <span className="personal-memory-mark" aria-hidden="true">
        ◇
      </span>
      <span className="personal-session-copy">
        <span>
          <strong>{thread.name || "Untitled session"}</strong>
          {source ? <small>{source}</small> : null}
          {thread.invalidatedCount ? (
            <small className="personal-invalidated-label">
              {thread.invalidatedCount} invalidated
            </small>
          ) : null}
        </span>
        <small>{sessionPreview(thread)}</small>
        <SemanticThemeWords themes={themes} />
      </span>
      <span className="personal-session-meta">
        <strong>{countLabel(thread.eventCount, "Memory Event")}</strong>
        <time dateTime={thread.latestAt}>{relativeTime(thread.latestAt)}</time>
      </span>
    </button>
  );
}

function ProjectDetail({
  onOpenProjects,
  onSelectSession,
  project
}: {
  onOpenProjects: () => void;
  onSelectSession: (sessionId: string) => void;
  project: PersonalDesktopProject | null;
}) {
  if (!project) {
    return (
      <section className="personal-memory-empty-detail">
        <div>
          <h2 data-personal-route-focus="project" tabIndex={-1}>
            Select a Project
          </h2>
          <p>Choose a Project to inspect its Captured Sessions.</p>
        </div>
      </section>
    );
  }
  const threads = [...project.threads].sort(
    (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
  );
  return (
    <section className="personal-project-detail">
      <nav aria-label="Breadcrumb">
        <button onClick={onOpenProjects} type="button">
          Projects
        </button>
        <span aria-hidden="true">/</span>
        <strong>{project.name}</strong>
      </nav>
      <header>
        <span className="personal-project-monogram" aria-hidden="true">
          {Array.from(project.name)[0]?.toLocaleUpperCase() ?? "P"}
        </span>
        <div>
          <small>Personal · Project · Private to you</small>
          <h2 data-personal-route-focus="project" tabIndex={-1}>
            {project.name}
          </h2>
          <p>
            {countLabel(project.threads.length, "Captured Session")} ·{" "}
            {countLabel(project.eventCount, "Memory Event")} ·{" "}
            {relativeTime(projectActivity(project))}
          </p>
        </div>
      </header>
      <details className="personal-project-details">
        <summary>Project details</summary>
        <dl>
          <div>
            <dt>Local path</dt>
            <dd>{project.path ?? "Unavailable"}</dd>
          </div>
        </dl>
      </details>
      <section className="personal-sessions" aria-labelledby="sessions-heading">
        <header>
          <div>
            <small>Project activity</small>
            <h3 id="sessions-heading">Captured Sessions</h3>
          </div>
          <span>{threads.length}</span>
        </header>
        {threads.length ? (
          <div>
            {threads.map((thread) => (
              <SessionRow
                key={sessionSelectionId(thread)}
                onSelect={() => onSelectSession(sessionSelectionId(thread))}
                project={project}
                thread={thread}
              />
            ))}
          </div>
        ) : (
          <div className="personal-memory-state" role="status">
            <strong>No Captured Sessions yet</strong>
            <p>
              Sessions appear after the Supported Capture Hook records activity
              in this Project.
            </p>
          </div>
        )}
      </section>
    </section>
  );
}

function StoreConversation({
  onInspectEvent,
  project,
  store,
  thread
}: {
  onInspectEvent?: (selection: PersonalMemoryInspectorEvent) => void;
  project: PersonalDesktopProject;
  store: PersonalMemoryStore;
  thread: PersonalDesktopProjectThread;
}) {
  const { detail, loadOlder, retry } = usePersonalMemoryDetail(store, thread);
  const model: ConversationSurfaceModel = detail
    ? {
        error: detail.error ?? "",
        events: detail.events,
        hasOlderEvents: detail.hasOlder,
        status: detail.status
      }
    : {
        error: "",
        events: [],
        hasOlderEvents: false,
        status: "loading"
      };
  return (
    <NativeConversationSurface
      model={model}
      onInspectEvent={
        onInspectEvent
          ? (event) => onInspectEvent({ event, project, thread })
          : undefined
      }
      onLoadOlder={loadOlder}
      onRetry={retry}
      thread={thread}
    />
  );
}

function ShareAffordance({
  candidates,
  onShare,
  projectId,
  records,
  suggestions,
  thread
}: {
  candidates: readonly WorkspaceShareCandidate[];
  onShare?: (request: ShareToWorkspaceRequest) => void;
  projectId: string;
  records: readonly PersonalMemorySharingRecord[];
  suggestions: readonly ProjectWorkspaceSuggestion[];
  thread: PersonalDesktopProjectThread;
}) {
  const source = personalMemorySharingSource(thread, records);
  const destinations = writableWorkspaceDestinations(candidates);
  if (!source || destinations.length === 0 || !onShare) return null;
  const suggested = suggestedWorkspaceId(projectId, destinations, suggestions);
  return (
    <button
      className="personal-share-button"
      onClick={() =>
        onShare({
          destinations,
          source,
          suggestedWorkspaceId: suggested
        })
      }
      type="button"
    >
      Share to Workspace…
    </button>
  );
}

function SessionAssignment({
  assign,
  onAssigned,
  projects,
  store,
  thread
}: {
  assign?: PersonalDesktopApi["assignSessionProject"];
  onAssigned?: PersonalMemoryWorkspaceProps["onSessionProjectAssigned"];
  projects: readonly PersonalDesktopProject[];
  store: PersonalMemoryStore;
  thread: PersonalDesktopProjectThread;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const targets = projects.filter(
    (project) =>
      project.id !== thread.projectId &&
      project.id !== "unassigned" &&
      project.id.trim() &&
      project.name.trim()
  );

  useEffect(() => {
    requestRef.current += 1;
    setBusy(false);
    setError("");
    return () => {
      requestRef.current += 1;
    };
  }, [thread.id, thread.projectId]);

  const run = useCallback(
    async (input: SessionProjectAssignment) => {
      if (!assign || !thread.sessionId) return;
      const request = ++requestRef.current;
      setBusy(true);
      setError("");
      try {
        const result = await assign(input);
        if (request !== requestRef.current) return;
        store.purge(
          ({ thread: cached }) => cached.sessionId === thread.sessionId
        );
        await store.loadProjects();
        if (request !== requestRef.current) return;
        onAssigned?.({
          projectId: result.projectId,
          sessionId: thread.sessionId
        });
      } catch (cause) {
        if (request !== requestRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request === requestRef.current) setBusy(false);
      }
    },
    [assign, onAssigned, store, thread.sessionId]
  );

  if (!assign || !thread.sessionId) return null;
  return (
    <details className="personal-session-assignment">
      <summary>
        Project assignment
        <span>
          {thread.projectAssignmentSource === "user_override"
            ? "Manual"
            : thread.projectAssignmentSource === "detected"
              ? "Automatic"
              : "Unassigned"}
        </span>
      </summary>
      <form
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          const targetProjectId = new FormData(event.currentTarget).get(
            "targetProjectId"
          );
          if (typeof targetProjectId !== "string") return;
          void run({
            action: "move",
            sessionId: thread.sessionId!,
            targetProjectId
          });
        }}
      >
        <label>
          Move to another Project
          <select
            defaultValue=""
            disabled={busy || targets.length === 0}
            name="targetProjectId"
            required
          >
            <option disabled value="">
              {targets.length ? "Select destination…" : "No other Projects"}
            </option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || targets.length === 0} type="submit">
          {busy ? "Saving…" : "Move"}
        </button>
        {thread.projectAssignmentSource === "user_override" ? (
          <button
            disabled={busy}
            onClick={() =>
              void run({
                action: "reset",
                sessionId: thread.sessionId!
              })
            }
            type="button"
          >
            Reset to automatic
          </button>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="personal-memory-error">
          {error}
        </p>
      ) : null}
    </details>
  );
}

function SessionDetail({
  assignSessionProject,
  candidates,
  onAssigned,
  onInspectEvent,
  onNavigate,
  onShare,
  project,
  projects,
  records,
  store,
  suggestions,
  thread
}: {
  assignSessionProject?: PersonalDesktopApi["assignSessionProject"];
  candidates: readonly WorkspaceShareCandidate[];
  onAssigned?: PersonalMemoryWorkspaceProps["onSessionProjectAssigned"];
  onInspectEvent?: PersonalMemoryWorkspaceProps["onInspectEvent"];
  onNavigate: PersonalMemoryWorkspaceProps["onNavigate"];
  onShare?: PersonalMemoryWorkspaceProps["onShareToWorkspace"];
  project: PersonalDesktopProject;
  projects: readonly PersonalDesktopProject[];
  records: readonly PersonalMemorySharingRecord[];
  store: PersonalMemoryStore;
  suggestions: readonly ProjectWorkspaceSuggestion[];
  thread: PersonalDesktopProjectThread;
}) {
  return (
    <section className="personal-session-detail">
      <nav aria-label="Breadcrumb">
        <button onClick={() => onNavigate({ kind: "projects" })} type="button">
          Projects
        </button>
        <span aria-hidden="true">/</span>
        <button
          onClick={() => onNavigate({ kind: "project", projectId: project.id })}
          type="button"
        >
          {project.name}
        </button>
        <span aria-hidden="true">/</span>
        <strong>{thread.name || "Untitled session"}</strong>
      </nav>
      <header>
        <div>
          <small>Personal · Captured Session · Private to you</small>
          <h2 data-personal-route-focus="session" tabIndex={-1}>
            {thread.name || "Untitled session"}
          </h2>
          <p>
            {countLabel(thread.eventCount, "Memory Event")} ·{" "}
            {relativeTime(thread.latestAt)} · {project.name}
          </p>
        </div>
        <ShareAffordance
          candidates={candidates}
          onShare={onShare}
          projectId={project.id}
          records={records}
          suggestions={suggestions}
          thread={thread}
        />
      </header>
      <SessionAssignment
        assign={assignSessionProject}
        onAssigned={onAssigned}
        projects={projects}
        store={store}
        thread={thread}
      />
      <div className="personal-conversation-host">
        <StoreConversation
          onInspectEvent={onInspectEvent}
          project={project}
          store={store}
          thread={thread}
        />
      </div>
    </section>
  );
}

export function PersonalMemoryWorkspace({
  assignSessionProject,
  onInspectEvent,
  onNavigate,
  onSessionProjectAssigned,
  onShareToWorkspace,
  projectWorkspaceSuggestions = [],
  route,
  sharingRecords = [],
  store,
  workspaceCandidates = []
}: PersonalMemoryWorkspaceProps) {
  const snapshot = usePersonalMemorySnapshot(store);
  const requestedRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const projects = useMemo(
    () =>
      snapshot.projectOrder.flatMap((id) => {
        const project = snapshot.projectsById.get(id);
        return project ? [project] : [];
      }),
    [snapshot.projectOrder, snapshot.projectsById]
  );
  const selectedProjectId = route.kind === "projects" ? null : route.projectId;
  const selectedProject =
    (selectedProjectId ? snapshot.projectsById.get(selectedProjectId) : null) ??
    null;
  const selectedThread =
    route.kind === "session" && selectedProject
      ? (selectedProject.threads.find(
          (thread) => sessionSelectionId(thread) === route.sessionId
        ) ?? null)
      : null;
  const effectiveRoute =
    route.kind === "session" && !selectedThread
      ? selectedProject
        ? "project"
        : "projects"
      : route.kind === "project" && !selectedProject
        ? "projects"
        : route.kind;

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void store.loadProjects();
  }, [store]);

  useEffect(() => {
    if (!selectedProject) return;
    const threads = [...selectedProject.threads].sort(
      (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
    );
    store.prewarm(threads, selectedThread ?? undefined);
  }, [selectedProject, selectedThread, store]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const active = document.activeElement;
    const preserveMasterFocus =
      window.matchMedia?.("(min-width: 1041px)").matches &&
      active instanceof HTMLElement &&
      Boolean(active.closest(".personal-projects-pane"));
    if (preserveMasterFocus) return;
    (
      workspace.querySelector<HTMLElement>(
        `[data-personal-route-focus="${effectiveRoute}"]`
      ) ?? workspace
    ).focus({ preventScroll: true });
  }, [effectiveRoute, selectedProjectId, selectedThread?.id]);

  return (
    <div
      className={`personal-memory-workspace route-${effectiveRoute}`}
      data-responsive="master-detail-to-drilldown"
      ref={workspaceRef}
      tabIndex={-1}
    >
      <ProjectsPane
        error={snapshot.error}
        loading={snapshot.loading}
        onRetry={() => void store.loadProjects()}
        onSelect={(projectId) => onNavigate({ kind: "project", projectId })}
        projects={projects}
        selectedProjectId={selectedProject?.id ?? null}
      />
      <main className="personal-memory-detail-pane">
        {effectiveRoute === "session" && selectedProject && selectedThread ? (
          <SessionDetail
            assignSessionProject={assignSessionProject}
            candidates={workspaceCandidates}
            onAssigned={onSessionProjectAssigned}
            onInspectEvent={onInspectEvent}
            onNavigate={onNavigate}
            onShare={onShareToWorkspace}
            project={selectedProject}
            projects={projects}
            records={sharingRecords}
            store={store}
            suggestions={projectWorkspaceSuggestions}
            thread={selectedThread}
          />
        ) : (
          <ProjectDetail
            onOpenProjects={() => onNavigate({ kind: "projects" })}
            onSelectSession={(sessionId) => {
              if (!selectedProject) return;
              onNavigate({
                kind: "session",
                projectId: selectedProject.id,
                sessionId
              });
            }}
            project={effectiveRoute === "project" ? selectedProject : null}
          />
        )}
      </main>
    </div>
  );
}
