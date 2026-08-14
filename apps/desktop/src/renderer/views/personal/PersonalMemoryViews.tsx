import type {
  PersonalDesktopApi,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import type { MarkdownPlatformAdapters } from "@koed/memory-ui";
import {
  BookText,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  GitFork,
  LoaderCircle,
  MonitorSmartphone,
  Pencil,
  Send,
  X
} from "lucide-react";
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
import { usePersonalMemoryDetail } from "./use-personal-memory-detail.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationIdentity
} from "../../../ipc/managed-conversation-protocol.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
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
  authorizeManagedConversationTransfer?: CollaborationRendererClient["authorizeManagedConversationTransfer"];
  assignSessionProject?: PersonalDesktopApi["assignSessionProject"];
  managedConversationRevision?: number;
  managedConversations?: ManagedConversationDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
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

function ProjectOverview({
  eventCount,
  sessionCount
}: {
  eventCount: number;
  sessionCount: number;
}) {
  return (
    <span
      aria-label={`${countLabel(sessionCount, "Captured Session")} · ${countLabel(eventCount, "Memory Event")}`}
      className="personal-project-overview"
    >
      <span>
        {sessionCount}
        <BookText aria-hidden="true" />
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {eventCount}
        <Brain aria-hidden="true" />
      </span>
    </span>
  );
}

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
  if (source === "codex-cli") return null;
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
        <ProjectOverview
          eventCount={project.eventCount}
          sessionCount={project.threads.length}
        />
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
        <h1 data-personal-route-focus="projects" tabIndex={-1}>
          Projects
        </h1>
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
          <div
            aria-label="Loading Projects"
            className="personal-projects-narrow-state"
            role="status"
          >
            <LoaderCircle
              aria-hidden="true"
              className="personal-loading-icon"
            />
          </div>
        ) : error && projects.length === 0 ? (
          <div className="personal-projects-narrow-state error" role="alert">
            <CircleAlert aria-hidden="true" className="personal-error-icon" />
            <strong>Projects unavailable</strong>
            <p>Koed could not load your Projects.</p>
            <button
              className="personal-retry-button"
              onClick={onRetry}
              type="button"
            >
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
            <section aria-label="Active Projects">
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
  thread
}: {
  onSelect: () => void;
  thread: PersonalDesktopProjectThread;
}) {
  const source = thread.sessionId
    ? sourceAiClientLabel(thread.sourceAiClient)
    : null;
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
      </span>
      <span className="personal-session-meta">
        <span
          aria-label={countLabel(thread.eventCount, "Memory Event")}
          className="personal-memory-event-count"
        >
          {thread.eventCount}
          <Brain aria-hidden="true" />
        </span>
        <time dateTime={thread.latestAt}>{relativeTime(thread.latestAt)}</time>
      </span>
    </button>
  );
}

function ProjectDetail({
  error,
  loading,
  managedConversationRevision,
  managedConversations,
  onManagedConversationStarted,
  onRetry,
  onSelectSession,
  project
}: {
  error: string | null;
  loading: boolean;
  managedConversationRevision: number;
  managedConversations?: ManagedConversationDesktopApi | null;
  onManagedConversationStarted: (
    conversation: ManagedConversationIdentity
  ) => void;
  onRetry: () => void;
  onSelectSession: (sessionId: string) => void;
  project: PersonalDesktopProject | null;
}) {
  const [startState, setStartState] = useState<{
    status: "idle" | "starting" | "error";
    message: string;
    executionId: string | null;
  }>({ status: "idle", message: "", executionId: null });
  const onStartedRef = useRef(onManagedConversationStarted);
  onStartedRef.current = onManagedConversationStarted;
  useEffect(() => {
    if (
      !managedConversations ||
      startState.status !== "starting" ||
      !startState.executionId
    ) {
      return;
    }
    let active = true;
    void managedConversations
      .inspect(startState.executionId)
      .then((result) => {
        if (!active) return;
        if (result.status === "ready" && result.conversation) {
          setStartState({
            status: "idle",
            message: "",
            executionId: null
          });
          onStartedRef.current(result.conversation);
        } else if (
          result.status === "failed" ||
          result.status === "reconciling"
        ) {
          setStartState({
            status: "error",
            message:
              result.message ??
              "Codex could not establish a writable Conversation.",
            executionId: null
          });
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setStartState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
          executionId: null
        });
      });
    return () => {
      active = false;
    };
  }, [
    managedConversationRevision,
    managedConversations,
    startState.executionId,
    startState.status
  ]);
  if (!project && loading) {
    return (
      <section
        aria-label="Loading Projects"
        className="personal-memory-empty-detail"
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="personal-loading-icon" />
      </section>
    );
  }
  if (!project && error) {
    return (
      <section className="personal-memory-empty-detail error" role="alert">
        <div>
          <CircleAlert aria-hidden="true" className="personal-error-icon" />
          <h2 data-personal-route-focus="project" tabIndex={-1}>
            Projects unavailable
          </h2>
          <p>Koed could not load your Projects.</p>
          <button
            className="personal-retry-button"
            onClick={onRetry}
            type="button"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!project) {
    return (
      <section className="personal-memory-empty-detail">
        <div>
          <BookText aria-hidden="true" className="personal-empty-icon" />
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
      <header>
        <span className="personal-project-monogram" aria-hidden="true">
          {Array.from(project.name)[0]?.toLocaleUpperCase() ?? "P"}
        </span>
        <div>
          <h2 data-personal-route-focus="project" tabIndex={-1}>
            {project.name}
          </h2>
          <ProjectOverview
            eventCount={project.eventCount}
            sessionCount={project.threads.length}
          />
        </div>
        <button
          className="personal-new-conversation"
          disabled={
            !managedConversations ||
            !project.path ||
            startState.status === "starting"
          }
          onClick={() => {
            if (!managedConversations) return;
            setStartState({
              status: "starting",
              message: "",
              executionId: null
            });
            void managedConversations
              .start(project.id, `desktop-conversation:${crypto.randomUUID()}`)
              .then((result) => {
                if (result.status === "ready" && result.conversation) {
                  setStartState({
                    status: "idle",
                    message: "",
                    executionId: null
                  });
                  onManagedConversationStarted(result.conversation);
                  return;
                }
                setStartState({
                  status: "starting",
                  message: "Starting Codex in this Project…",
                  executionId: result.executionId
                });
              })
              .catch((cause: unknown) => {
                setStartState({
                  status: "error",
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                  executionId: null
                });
              });
          }}
          type="button"
        >
          {startState.status === "starting" ? (
            <LoaderCircle aria-hidden="true" />
          ) : null}
          {startState.status === "starting" ? "Starting Conversation…" : "New"}
        </button>
      </header>
      {startState.message ? (
        <p
          className={
            startState.status === "error"
              ? "personal-managed-error"
              : "personal-managed-status"
          }
          role={startState.status === "error" ? "alert" : "status"}
        >
          {startState.message}
        </p>
      ) : null}
      <details className="personal-project-details">
        <summary>Project details</summary>
        <dl>
          <div>
            <dt>Local path:</dt>
            <dd>{project.path ?? "Unavailable"}</dd>
          </div>
        </dl>
      </details>
      <section className="personal-sessions" aria-label="Captured Sessions">
        {threads.length ? (
          <div>
            {threads.map((thread) => (
              <SessionRow
                key={sessionSelectionId(thread)}
                onSelect={() => onSelectSession(sessionSelectionId(thread))}
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
  authorizeManagedConversationTransfer,
  managedConversationRevision,
  managedConversations,
  markdownAdapters,
  pendingCanonicalConversation,
  onInspectEvent,
  project,
  store,
  thread
}: {
  authorizeManagedConversationTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  managedConversationRevision: number;
  managedConversations?: ManagedConversationDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
  pendingCanonicalConversation: boolean;
  onInspectEvent?: (selection: PersonalMemoryInspectorEvent) => void;
  project: PersonalDesktopProject;
  store: PersonalMemoryStore;
  thread: PersonalDesktopProjectThread;
}) {
  const { detail, loadOlder, retry } = usePersonalMemoryDetail(
    store,
    thread,
    !pendingCanonicalConversation
  );
  const model: ConversationSurfaceModel = pendingCanonicalConversation
    ? {
        error: "",
        events: [],
        hasOlderEvents: false,
        status: "ready"
      }
    : detail
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
    <div className="personal-conversation-shell">
      <div className="personal-conversation-timeline">
        <NativeConversationSurface
          markdownAdapters={markdownAdapters}
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
      </div>
      {thread.sessionId && managedConversations ? (
        <ManagedConversationComposer
          api={managedConversations}
          authorizeTransfer={authorizeManagedConversationTransfer}
          conversation={{
            executionId: null,
            projectId: project.id,
            capturedSessionId: thread.sessionId,
            threadId: thread.id
          }}
          managedConversationRevision={managedConversationRevision}
        />
      ) : null}
    </div>
  );
}

type ComposerState =
  | { status: "attaching"; message: string }
  | { status: "ready"; message: string }
  | { status: "sending"; message: string }
  | { status: "reconciling"; message: string }
  | { status: "read_only"; message: string }
  | { status: "error"; message: string };

const transferLifecycleMessage = (
  transfer: Awaited<
    ReturnType<ManagedConversationDesktopApi["transferStatus"]>
  >["handoff" | "fork"]
): string => {
  if (!transfer) return "";
  if (transfer.failureCode) {
    return `${
      transfer.operation === "handoff" ? "Move" : "Fork"
    } stopped safely: ${transfer.failureCode}`;
  }
  const label = transfer.operation === "handoff" ? "Move" : "Fork";
  const states: Record<string, string> = {
    requested: `${label} requested`,
    quiesce_requested: "Stopping writes at a safe boundary",
    provider_stopped: "Codex stopped on the source device",
    source_sealed: "Conversation source sealed",
    source_prepared: "Conversation and workspace prepared",
    source_attested: "Source verified; waiting for the target device",
    workspace_prepared: "Workspace transferred; verifying target",
    target_verified: "Target device verified",
    lease_transferred: "Execution authority moved to the target",
    restoring: "Restoring Codex on the target device",
    identity_verified: "Native Conversation identity verified",
    provider_created: "Independent Codex Conversation created",
    child_bound: "Fork lineage verified",
    running:
      transfer.operation === "handoff"
        ? "Move complete. This Conversation is writable on the target device."
        : "Fork complete. The independent Conversation is ready on the target device.",
    indeterminate:
      "Koed cannot prove the provider outcome. It will not retry automatically.",
    failed: `${label} failed without transferring execution authority`,
    quarantined:
      "Conflicting transfer authority was detected. This Conversation is quarantined."
  };
  return states[transfer.state] ?? `${label}: ${transfer.state}`;
};

function ManagedConversationComposer({
  api,
  authorizeTransfer,
  conversation,
  managedConversationRevision
}: {
  api: ManagedConversationDesktopApi;
  authorizeTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  conversation: ManagedConversationIdentity;
  managedConversationRevision: number;
}) {
  const [draft, setDraft] = useState("");
  const [resolvedConversation, setResolvedConversation] =
    useState<ManagedConversationIdentity>(conversation);
  const [targetDevices, setTargetDevices] = useState<
    Awaited<ReturnType<ManagedConversationDesktopApi["targets"]>>["devices"]
  >([]);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [transferMessage, setTransferMessage] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [state, setState] = useState<ComposerState>({
    status: "attaching",
    message: "Confirming local Codex execution…"
  });
  const submissionRef = useRef<{
    idempotencyKey: string;
    prompt: string;
  } | null>(null);
  const submissionInFlightRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    const executionId = resolvedConversation.executionId;
    if (!executionId) return;
    let active = true;
    void api
      .transferStatus(executionId)
      .then((result) => {
        if (!active) return;
        const latest = [result.handoff, result.fork]
          .filter((value): value is NonNullable<typeof value> => value !== null)
          .sort(
            (left, right) =>
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
          )[0];
        if (latest) setTransferMessage(transferLifecycleMessage(latest));
      })
      .catch(() => {
        if (active && transferBusy) {
          setTransferMessage(
            "Koed could not refresh transfer progress. The durable operation is still recoverable."
          );
        }
      });
    return () => {
      active = false;
    };
  }, [
    api,
    managedConversationRevision,
    resolvedConversation.executionId,
    transferBusy
  ]);

  useEffect(() => {
    let active = true;
    submissionInFlightRef.current = false;
    submissionRef.current = null;
    setState({
      status: "attaching",
      message: "Confirming local Codex execution…"
    });
    void api
      .resume({
        projectId: conversation.projectId,
        capturedSessionId: conversation.capturedSessionId,
        threadId: conversation.threadId
      })
      .then((result) => {
        if (!active) return;
        setResolvedConversation(result.conversation);
        setState(
          result.status === "ready"
            ? { status: "ready", message: "" }
            : {
                status: result.status,
                message:
                  result.message ??
                  (result.status === "read_only"
                    ? "This Captured Session is read-only."
                    : "Koed is reconciling this Conversation.")
              }
        );
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
    return () => {
      active = false;
    };
  }, [
    api,
    conversation.capturedSessionId,
    conversation.projectId,
    conversation.threadId,
    managedConversationRevision
  ]);

  const submit = useCallback(async () => {
    if (
      submissionInFlightRef.current ||
      state.status !== "ready" ||
      !draft.trim()
    ) {
      return;
    }
    const submission =
      submissionRef.current?.prompt === draft
        ? submissionRef.current
        : {
            idempotencyKey: `desktop-prompt:${crypto.randomUUID()}`,
            prompt: draft
          };
    submissionRef.current = submission;
    submissionInFlightRef.current = true;
    setState({ status: "sending", message: "Sending prompt to Codex…" });
    try {
      const result = await api.send({
        capturedSessionId: resolvedConversation.capturedSessionId,
        threadId: resolvedConversation.threadId,
        idempotencyKey: submission.idempotencyKey,
        prompt: submission.prompt
      });
      if (result.status === "reconciling") {
        setState({
          status: "reconciling",
          message:
            result.message ??
            "Codex may have accepted this prompt. Koed is reconciling it."
        });
        return;
      }
      submissionRef.current = null;
      submissionInFlightRef.current = false;
      setDraft("");
      setState({ status: "ready", message: "" });
    } catch {
      setState({
        status: "reconciling",
        message:
          "Koed could not confirm whether Codex accepted this prompt. It will not be submitted again automatically."
      });
    }
  }, [
    api,
    resolvedConversation.capturedSessionId,
    resolvedConversation.threadId,
    draft,
    state.status
  ]);

  const disabled = state.status !== "ready";
  return (
    <form
      aria-busy={state.status === "sending"}
      className={`personal-managed-composer state-${state.status}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="personal-managed-composer-field">
        <label>
          <span className="sr-only">Prompt Codex</span>
          <textarea
            disabled={disabled}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              submissionRef.current = null;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onKeyDown={(event) => {
              const nativeEvent = event.nativeEvent as KeyboardEvent;
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !nativeEvent.isComposing &&
                !composingRef.current
              ) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={
              state.status === "ready"
                ? "Ask Codex to work in this Project"
                : "Prompt unavailable"
            }
            rows={1}
            value={draft}
          />
        </label>
        <button
          aria-label="Send prompt"
          disabled={disabled || !draft.trim()}
          type="submit"
        >
          {state.status === "sending" ? (
            <LoaderCircle aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
        </button>
      </div>
      {state.status === "ready" &&
      resolvedConversation.executionId &&
      authorizeTransfer ? (
        <details
          className="personal-managed-transfer"
          onToggle={(event) => {
            if (!event.currentTarget.open || targetDevices.length) return;
            setTransferMessage("Loading Personal Devices…");
            void api
              .targets()
              .then((result) => {
                setTargetDevices(result.devices);
                setSelectedTarget(result.devices[0]?.deviceId ?? "");
                setTransferMessage(
                  result.devices.length
                    ? ""
                    : "No other enrolled Personal Device is available."
                );
              })
              .catch((cause: unknown) => {
                setTransferMessage(
                  cause instanceof Error ? cause.message : String(cause)
                );
              });
          }}
        >
          <summary>
            <MonitorSmartphone aria-hidden="true" />
            Continue on another device
          </summary>
          <div>
            <label>
              <span>Personal Device</span>
              <select
                disabled={transferBusy || !targetDevices.length}
                onChange={(event) =>
                  setSelectedTarget(event.currentTarget.value)
                }
                value={selectedTarget}
              >
                {targetDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label ?? `Device ${device.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={transferBusy || !selectedTarget}
              onClick={() => {
                const operationId = crypto.randomUUID();
                setTransferBusy(true);
                setTransferMessage("Waiting for your approval…");
                void authorizeTransfer({
                  operation: "handoff",
                  executionId: resolvedConversation.executionId!,
                  operationId,
                  targetDeviceId: selectedTarget
                })
                  .then((actionGrant) => {
                    setTransferMessage("Preparing an exact handoff…");
                    return api.handoff({
                      actionGrantId: actionGrant.id,
                      executionId: resolvedConversation.executionId!,
                      operationId,
                      targetDeviceId: selectedTarget
                    });
                  })
                  .then(() => {
                    setTransferMessage(
                      "Handoff queued. This device will stop writing after the verified boundary."
                    );
                  })
                  .catch((cause: unknown) => {
                    setTransferMessage(
                      cause instanceof Error ? cause.message : String(cause)
                    );
                  })
                  .finally(() => setTransferBusy(false));
              }}
              type="button"
            >
              <MonitorSmartphone aria-hidden="true" />
              Move
            </button>
            <button
              disabled={transferBusy || !selectedTarget}
              onClick={() => {
                const operationId = crypto.randomUUID();
                setTransferBusy(true);
                setTransferMessage("Waiting for your approval…");
                void authorizeTransfer({
                  operation: "fork",
                  executionId: resolvedConversation.executionId!,
                  operationId,
                  targetDeviceId: selectedTarget,
                  reason: "user_requested"
                })
                  .then((actionGrant) => {
                    setTransferMessage("Preparing an independent fork…");
                    return api.fork({
                      actionGrantId: actionGrant.id,
                      executionId: resolvedConversation.executionId!,
                      operationId,
                      targetDeviceId: selectedTarget,
                      reason: "user_requested"
                    });
                  })
                  .then(() => {
                    setTransferMessage(
                      "Fork queued. The original Conversation remains on this device."
                    );
                  })
                  .catch((cause: unknown) => {
                    setTransferMessage(
                      cause instanceof Error ? cause.message : String(cause)
                    );
                  })
                  .finally(() => setTransferBusy(false));
              }}
              type="button"
            >
              <GitFork aria-hidden="true" />
              Fork
            </button>
            {transferMessage ? <p role="status">{transferMessage}</p> : null}
          </div>
        </details>
      ) : null}
    </form>
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
      Share
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
        <ChevronDown aria-hidden="true" />
        <span className="personal-session-assignment-label">Manage</span>
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
        <label className="personal-session-move-control">
          <span>Move to Project:</span>
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
        <button
          className="personal-move-button"
          disabled={busy || targets.length === 0}
          type="submit"
        >
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
  authorizeManagedConversationTransfer,
  candidates,
  managedConversationRevision,
  managedConversations,
  markdownAdapters,
  onAssigned,
  onInspectEvent,
  onShare,
  project,
  projects,
  records,
  store,
  suggestions,
  thread,
  pendingCanonicalConversation
}: {
  assignSessionProject?: PersonalDesktopApi["assignSessionProject"];
  authorizeManagedConversationTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  candidates: readonly WorkspaceShareCandidate[];
  managedConversationRevision: number;
  managedConversations?: ManagedConversationDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
  onAssigned?: PersonalMemoryWorkspaceProps["onSessionProjectAssigned"];
  onInspectEvent?: PersonalMemoryWorkspaceProps["onInspectEvent"];
  onShare?: PersonalMemoryWorkspaceProps["onShareToWorkspace"];
  project: PersonalDesktopProject;
  projects: readonly PersonalDesktopProject[];
  records: readonly PersonalMemorySharingRecord[];
  store: PersonalMemoryStore;
  suggestions: readonly ProjectWorkspaceSuggestion[];
  thread: PersonalDesktopProjectThread;
  pendingCanonicalConversation: boolean;
}) {
  const title = thread.name || "Untitled session";
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(title);
  }, [editingTitle, title]);

  const cancelTitleEdit = () => {
    setTitleDraft(title);
    setTitleError(null);
    setEditingTitle(false);
  };

  const saveTitle = async () => {
    const nextTitle = titleDraft.trim();
    if (!thread.sessionId || titleBusy) return;
    if (!nextTitle) {
      setTitleError("Enter a name for this Captured Session.");
      return;
    }
    if (nextTitle === title) {
      cancelTitleEdit();
      return;
    }
    setTitleBusy(true);
    setTitleError(null);
    try {
      await store.updateSessionTitle({
        sessionId: thread.sessionId,
        title: nextTitle
      });
      setEditingTitle(false);
    } catch {
      setTitleError("Koed could not rename this Captured Session.");
    } finally {
      setTitleBusy(false);
    }
  };

  return (
    <section className="personal-session-detail">
      <header>
        <div>
          <small>{project.name} · Private to you</small>
          {editingTitle ? (
            <form
              className="personal-session-title-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void saveTitle();
              }}
            >
              <label className="sr-only" htmlFor="personal-session-title">
                Captured Session name
              </label>
              <input
                autoFocus
                disabled={titleBusy}
                id="personal-session-title"
                maxLength={120}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") cancelTitleEdit();
                }}
                value={titleDraft}
              />
              <button
                aria-label="Save Captured Session name"
                disabled={titleBusy}
                type="submit"
              >
                {titleBusy ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="personal-session-title-spinner"
                  />
                ) : (
                  <Check aria-hidden="true" />
                )}
              </button>
              <button
                aria-label="Cancel Captured Session rename"
                disabled={titleBusy}
                onClick={cancelTitleEdit}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </form>
          ) : (
            <div className="personal-session-title-row">
              <h2 data-personal-route-focus="session" tabIndex={-1}>
                {title}
              </h2>
              {thread.sessionId ? (
                <button
                  aria-label="Rename Captured Session"
                  className="personal-session-title-edit"
                  onClick={() => {
                    setTitleDraft(title);
                    setTitleError(null);
                    setEditingTitle(true);
                  }}
                  title="Rename Captured Session"
                  type="button"
                >
                  <Pencil aria-hidden="true" />
                </button>
              ) : null}
            </div>
          )}
          {titleError ? (
            <p className="personal-session-title-error" role="alert">
              {titleError}
            </p>
          ) : null}
          <p
            aria-label={countLabel(thread.eventCount, "Memory Event")}
            className="personal-memory-event-count"
          >
            {thread.eventCount}
            <Brain aria-hidden="true" />
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
          authorizeManagedConversationTransfer={
            authorizeManagedConversationTransfer
          }
          managedConversationRevision={managedConversationRevision}
          managedConversations={managedConversations}
          markdownAdapters={markdownAdapters}
          onInspectEvent={onInspectEvent}
          pendingCanonicalConversation={pendingCanonicalConversation}
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
  authorizeManagedConversationTransfer,
  managedConversationRevision = 0,
  managedConversations,
  markdownAdapters,
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
  const [managedDrafts, setManagedDrafts] = useState<
    ReadonlyMap<string, PersonalDesktopProjectThread>
  >(new Map());
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
        ) ??
        managedDrafts.get(route.sessionId) ??
        null)
      : null;
  const pendingCanonicalConversation =
    selectedThread?.sessionId != null &&
    managedDrafts.has(selectedThread.sessionId) &&
    !selectedProject?.threads.some(
      (thread) => thread.sessionId === selectedThread.sessionId
    );
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
            authorizeManagedConversationTransfer={
              authorizeManagedConversationTransfer
            }
            candidates={workspaceCandidates}
            managedConversationRevision={managedConversationRevision}
            managedConversations={managedConversations}
            markdownAdapters={markdownAdapters}
            onAssigned={onSessionProjectAssigned}
            onInspectEvent={onInspectEvent}
            onShare={onShareToWorkspace}
            project={selectedProject}
            projects={projects}
            records={sharingRecords}
            store={store}
            suggestions={projectWorkspaceSuggestions}
            thread={selectedThread}
            pendingCanonicalConversation={pendingCanonicalConversation}
          />
        ) : (
          <ProjectDetail
            error={projects.length === 0 ? snapshot.error : null}
            loading={snapshot.loading && projects.length === 0}
            managedConversationRevision={managedConversationRevision}
            managedConversations={managedConversations}
            onManagedConversationStarted={(conversation) => {
              if (!selectedProject) return;
              const now = new Date().toISOString();
              const draft: PersonalDesktopProjectThread = {
                id: conversation.threadId,
                name: "New Codex Conversation",
                sessionId: conversation.capturedSessionId,
                sourceAiClient: "codex",
                projectId: selectedProject.id,
                projectName: selectedProject.name,
                projectPath: selectedProject.path,
                projectAssignmentSource: "user_override",
                eventCount: 0,
                invalidatedCount: 0,
                latestAt: now,
                sample: ""
              };
              setManagedDrafts((current) => {
                const next = new Map(current);
                next.set(conversation.capturedSessionId, draft);
                return next;
              });
              onNavigate({
                kind: "session",
                projectId: selectedProject.id,
                sessionId: conversation.capturedSessionId
              });
            }}
            onRetry={() => void store.loadProjects()}
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
