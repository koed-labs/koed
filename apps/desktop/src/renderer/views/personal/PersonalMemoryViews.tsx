import { assignmentFrom } from "../preferences/local-ai-client-settings-helpers.js";
import type {
  PersonalConversationPresentation,
  PersonalDesktopApi,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { PERSONAL_CONVERSATION_SETTLE_AFTER_DAYS } from "@koed/shared/personal-desktop";
import type { MarkdownPlatformAdapters } from "@koed/memory-ui";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle
} from "@koed/ui";
import {
  BookText,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Folder,
  Github,
  CirclePlay,
  Clock3,
  Ellipsis,
  GitFork,
  LoaderCircle,
  MonitorSmartphone,
  Paperclip,
  Pencil,
  Pin,
  RefreshCw,
  Settings,
  X
} from "lucide-react";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { DesktopApi } from "../../../types.js";
import { ConversationInput } from "./ConversationInput.js";

import {
  NativeConversationSurface,
  type ConversationSurfaceModel
} from "../../../NativeConversationSurface.js";
import {
  projectIsActive,
  projectLatestAt,
  relativeTime,
  repositoryPresentationFromRemoteDisplay,
  sessionPreview,
  sessionSelectionId
} from "../../../project-memory-ui.js";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { type PersonalMemoryStore } from "../../state/personal-memory.js";
import { usePersonalMemorySnapshot } from "../../state/use-personal-memory.js";
import {
  managedConversationRuntimeStateFromSnapshot,
  reduceManagedConversationRuntime,
  type ManagedConversationRealtimeUpdate,
  type ManagedConversationRuntimeState
} from "../../state/managed-conversation-runtime.js";
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
import { AiClientLogo } from "./AiClientLogo.js";
import { usePersonalMemoryDetail } from "./use-personal-memory-detail.js";
import type {
  ManagedConversationContextUsage,
  ManagedConversationDesktopApi,
  ManagedConversationIdentity,
  ManagedConversationLaunchOptions,
  ManagedConversationRuntimeItem
} from "../../../ipc/managed-conversation-protocol.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import { ManagedProjectCockpit } from "./ManagedProjectCockpit.js";
import "./personal-memory.css";
import {
  NewConversationComposer,
  type InitialConversationPrompt
} from "./NewConversationComposer.js";
import {
  selectionForInstance,
  selectionForAssignment,
  type ConversationSelection
} from "./ConversationSettings.js";
import {
  managedConversationSettingsKey,
  type ManagedConversationSettingsChange,
  type AiClientPermissionMode
} from "@koed/shared/ai-client-contract";

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
  updateSessionPresentation?: PersonalDesktopApi["updateSessionPresentation"];
  managedConversationRevision?: number;
  managedConversationRecoveryRevision?: number;
  managedConversationUpdate?: {
    revision: number;
    update: ManagedConversationRealtimeUpdate;
  } | null;
  managedConversations?: ManagedConversationDesktopApi | null;
  managedConversationDrafts?: ReadonlyMap<string, ManagedConversationDraft>;
  setManagedConversationDrafts?: Dispatch<
    SetStateAction<ReadonlyMap<string, ManagedConversationDraft>>
  >;
  localAiClients?: DesktopApi["localAiClients"];
  managedProject?: ManagedProjectDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
  onInspectEvent?: (selection: PersonalMemoryInspectorEvent) => void;
  onNavigate: (route: PersonalMemoryRoute) => void;
  openExternal?: (url: string) => Promise<void>;
  revealLocalProject?: (localProjectId: string) => Promise<void>;
  onSessionProjectAssigned?: (input: {
    projectId: string | null;
    sessionId: string;
  }) => void;
  onShareToWorkspace?: (request: ShareToWorkspaceRequest) => void;
  projectWorkspaceSuggestions?: readonly ProjectWorkspaceSuggestion[];
  ready?: boolean;
  route: PersonalMemoryRoute;
  sharingRecords?: readonly PersonalMemorySharingRecord[];
  store: PersonalMemoryStore;
  workspaceCandidates?: readonly WorkspaceShareCandidate[];
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

function ProjectRepo({
  onOpenRepository,
  remoteDisplay
}: {
  onOpenRepository?: (url: string) => void;
  remoteDisplay: string;
}) {
  const repository = repositoryPresentationFromRemoteDisplay(remoteDisplay);
  const RepositoryIcon = repository.provider === "github" ? Github : GitFork;
  const actionLabel =
    repository.provider === "github"
      ? `Open ${repository.label} on GitHub`
      : `Open repository ${repository.label}`;
  if (!onOpenRepository) {
    return (
      <span
        aria-label={`Repository ${repository.label}`}
        className="personal-project-repo personal-project-repo-static"
        data-repository-provider={repository.provider}
      >
        <RepositoryIcon aria-hidden="true" />
        <span>{repository.label}</span>
      </span>
    );
  }
  return (
    <button
      aria-label={actionLabel}
      className="personal-project-repo"
      data-repository-provider={repository.provider}
      onClick={() => onOpenRepository(repository.url)}
      title={actionLabel}
      type="button"
    >
      <RepositoryIcon aria-hidden="true" />
      <span>{repository.label}</span>
    </button>
  );
}
const compactTokenCount = (value: number): string => {
  if (value < 1_000) return String(value);
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  }
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
};

const managedProviderLabel = (
  provider: "codex" | "claude" | "pi" | null
): string =>
  provider === "codex"
    ? "Codex"
    : provider === "pi"
      ? "Pi"
      : provider === "claude"
        ? "Claude"
        : "AI Client";

const defaultConversationPresentation = (
  thread: PersonalDesktopProjectThread
): PersonalConversationPresentation => ({
  pinnedAt: null,
  displayMode: "automatic",
  snoozedAt: null,
  snoozedUntil: null,
  version: 0,
  updatedAt: thread.latestAt
});

type ConversationPresentationStatus = "active" | "settled" | "snoozed";

const conversationPresentationStatus = (
  thread: PersonalDesktopProjectThread,
  now: number
): ConversationPresentationStatus => {
  const presentation =
    thread.presentation ?? defaultConversationPresentation(thread);
  const latestAt = Date.parse(thread.latestAt);
  const snoozedAt = presentation.snoozedAt
    ? Date.parse(presentation.snoozedAt)
    : null;
  const snoozedUntil = presentation.snoozedUntil
    ? Date.parse(presentation.snoozedUntil)
    : null;
  if (
    snoozedAt !== null &&
    snoozedUntil !== null &&
    snoozedUntil > now &&
    latestAt <= snoozedAt
  ) {
    return "snoozed";
  }
  if (presentation.displayMode === "active") return "active";
  if (presentation.displayMode === "settled") return "settled";
  const settlementAt =
    latestAt + PERSONAL_CONVERSATION_SETTLE_AFTER_DAYS * 24 * 60 * 60 * 1_000;
  return settlementAt <= now ? "settled" : "active";
};

const nextConversationPresentationDeadline = (
  threads: PersonalDesktopProjectThread[],
  now: number
): number | null => {
  const deadlines = threads.flatMap((thread) => {
    const presentation =
      thread.presentation ?? defaultConversationPresentation(thread);
    const values: number[] = [];
    if (presentation.snoozedUntil) {
      const snoozedUntil = Date.parse(presentation.snoozedUntil);
      if (snoozedUntil > now) values.push(snoozedUntil);
    }
    if (presentation.displayMode === "automatic") {
      const settlementAt =
        Date.parse(thread.latestAt) +
        PERSONAL_CONVERSATION_SETTLE_AFTER_DAYS * 24 * 60 * 60 * 1_000;
      if (settlementAt > now) values.push(settlementAt);
    }
    return values;
  });
  return deadlines.length ? Math.min(...deadlines) : null;
};

function ProjectOverview({
  eventCount,
  localProjectId,
  onOpenRepository,
  onRevealLocalProject,
  projectName,
  remoteDisplay,
  sessionCount
}: {
  eventCount: number;
  localProjectId?: string | null;
  onOpenRepository?: (url: string) => void;
  onRevealLocalProject?: (localProjectId: string) => void;
  projectName?: string;
  remoteDisplay?: string | null;
  sessionCount: number;
}) {
  const revealLabel = `Reveal ${projectName ?? "Project"} in file browser`;
  return (
    <span className="personal-project-overview-group">
      {remoteDisplay ? (
        <ProjectRepo
          onOpenRepository={onOpenRepository}
          remoteDisplay={remoteDisplay}
        />
      ) : null}
      <span
        aria-label={`${countLabel(sessionCount, "Captured Session")} · ${countLabel(eventCount, "Memory Event")}`}
        className="personal-project-overview"
      >
        {localProjectId && onRevealLocalProject ? (
          <>
            <button
              aria-label={revealLabel}
              className="personal-project-folder"
              onClick={() => onRevealLocalProject(localProjectId)}
              title={revealLabel}
              type="button"
            >
              <Folder aria-hidden="true" />
            </button>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
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
    </span>
  );
}

const sourceAiClientIdentity = (
  source: PersonalDesktopProjectThread["sourceAiClient"]
): { id: "claude" | "codex" | "pi"; label: string } | null => {
  if (source === "codex" || source === "codex-cli") {
    return { id: "codex", label: "Codex" };
  }
  if (source === "claude-code") {
    return { id: "claude", label: "Claude Code" };
  }
  if (source === "pi") return { id: "pi", label: "Pi" };
  return null;
};

function AiClientMark({
  ariaLabel,
  id,
  title
}: {
  ariaLabel: string;
  id: "claude" | "codex" | "pi";
  title: string;
}) {
  return (
    <span
      aria-label={ariaLabel}
      className="personal-memory-mark personal-ai-client-mark"
      data-client={id}
      role="img"
      title={title}
    >
      <AiClientLogo id={id} />
    </span>
  );
}

function AiClientSourceMark({
  source
}: {
  source: PersonalDesktopProjectThread["sourceAiClient"];
}) {
  const identity = sourceAiClientIdentity(source);
  if (!identity) {
    return (
      <span className="personal-memory-mark" aria-hidden="true">
        ◇
      </span>
    );
  }
  return (
    <AiClientMark
      ariaLabel={`Captured with ${identity.label}`}
      id={identity.id}
      title={identity.label}
    />
  );
}

function ProjectRow({
  project,
  selected,
  onSelect
}: {
  project: DesktopProject;
  selected: boolean;
  onSelect: () => void;
}) {
  const latestAt = projectLatestAt(project);
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
          remoteDisplay={project.remoteDisplay}
          sessionCount={project.threads.length}
        />
      </span>
      <time dateTime={latestAt ?? undefined}>{relativeTime(latestAt)}</time>
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
  projects: readonly DesktopProject[];
  selectedProjectId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = projects.filter((project) => {
    if (!normalizedQuery) return true;
    return [project.name, project.path ?? "", project.remoteDisplay ?? ""].some(
      (value) => value.toLocaleLowerCase().includes(normalizedQuery)
    );
  });
  const active = filtered.filter(
    (project) =>
      project.contextKind === "independent" || projectIsActive(project)
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
        ) : projects.length === 0 ? null : filtered.length === 0 ? (
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
  actionsOpen,
  busy,
  onActionsOpenChange,
  onChangePresentation,
  presentationStatus,
  onSelect,
  thread
}: {
  actionsOpen: boolean;
  busy: boolean;
  onActionsOpenChange: (open: boolean) => void;
  presentationStatus: ConversationPresentationStatus;
  onChangePresentation: (
    input: Omit<
      Parameters<PersonalDesktopApi["updateSessionPresentation"]>[0],
      "sessionId" | "expectedVersion"
    >
  ) => void;
  onSelect: () => void;
  thread: PersonalDesktopProjectThread;
}) {
  const presentation =
    thread.presentation ?? defaultConversationPresentation(thread);
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const changePresentation = (
    input: Omit<
      Parameters<PersonalDesktopApi["updateSessionPresentation"]>[0],
      "sessionId" | "expectedVersion"
    >
  ) => {
    actionsRef.current?.removeAttribute("open");
    onChangePresentation(input);
  };
  return (
    <div
      className={`personal-session-row${thread.threadKind === "subagent" ? " is-child-agent" : ""}`}
      data-session-id={sessionSelectionId(thread)}
    >
      <button
        className="personal-session-row-select"
        onClick={onSelect}
        type="button"
      >
        <AiClientSourceMark
          source={thread.sessionId ? thread.sourceAiClient : null}
        />
        <span className="personal-session-copy">
          <span>
            <strong>{thread.name || "Untitled session"}</strong>
            {presentation.pinnedAt ? <small>Pinned</small> : null}
            {presentationStatus === "snoozed" ? <small>Snoozed</small> : null}
            {presentation.displayMode === "active" ? (
              <small>Kept active</small>
            ) : null}
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
          <time dateTime={thread.latestAt}>
            {relativeTime(thread.latestAt)}
          </time>
        </span>
      </button>
      {thread.sessionId ? (
        <details
          className="personal-session-actions"
          name="personal-session-actions"
          onToggle={(event) => onActionsOpenChange(event.currentTarget.open)}
          open={actionsOpen}
          ref={actionsRef}
        >
          <summary
            aria-label={`Conversation actions for ${thread.name}`}
            title="Conversation actions"
          >
            <Ellipsis aria-hidden="true" />
          </summary>
          <div aria-label="Conversation actions" role="menu">
            <button
              disabled={busy}
              onClick={() =>
                changePresentation({ pinned: !presentation.pinnedAt })
              }
              role="menuitem"
              type="button"
            >
              <Pin aria-hidden="true" />
              {presentation.pinnedAt ? "Unpin" : "Pin"}
            </button>
            {presentation.displayMode === "automatic" ? (
              <button
                disabled={busy}
                onClick={() => changePresentation({ displayMode: "active" })}
                role="menuitem"
                type="button"
              >
                <CirclePlay aria-hidden="true" />
                Keep active
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => changePresentation({ displayMode: "automatic" })}
                role="menuitem"
                type="button"
              >
                <RefreshCw aria-hidden="true" />
                Automatic
              </button>
            )}
            <button
              disabled={busy || presentation.displayMode === "settled"}
              onClick={() => changePresentation({ displayMode: "settled" })}
              role="menuitem"
              type="button"
            >
              <ChevronDown aria-hidden="true" />
              Settle
            </button>
            <button
              disabled={busy}
              onClick={() =>
                changePresentation({
                  snoozedUntil:
                    presentationStatus === "snoozed"
                      ? null
                      : new Date(
                          Date.now() + 24 * 60 * 60 * 1_000
                        ).toISOString()
                })
              }
              role="menuitem"
              type="button"
            >
              <Clock3 aria-hidden="true" />
              {presentationStatus === "snoozed" ? "Wake now" : "Snooze 1 day"}
            </button>
          </div>
        </details>
      ) : null}
    </div>
  );
}

type ManagedLaunchSelection = ConversationSelection;
type ManagedOwnerCapabilities = {
  resume: boolean;
  send: boolean;
  handoff: boolean;
  fork: boolean;
};
const ManagedCapabilitiesContext = createContext<
  ReadonlyMap<string, ManagedOwnerCapabilities> | undefined
>(undefined);
const managedOwnerKey = (owner: { driverId: string; instanceId: string }) =>
  `${owner.driverId}:${owner.instanceId}`;

type ManagedConversationOwner = {
  aiClientDriverId: "codex" | "claude" | "pi";
  aiClientInstanceId: string;
  displayName: string;
  ready: boolean;
};

const launchOwner = (
  instance: ManagedConversationLaunchOptions["instances"][number]
): ManagedConversationOwner => ({
  aiClientDriverId: instance.driverId,
  aiClientInstanceId: instance.instanceId,
  displayName: instance.displayName,
  ready:
    instance.ready &&
    instance.models.length > 0 &&
    instance.capabilities.permissionModes.some(
      (mode) => mode.support === "supported"
    )
});

const launchSelectionForInstance = selectionForInstance;

function ProjectDetail({
  localAiClients,
  error,
  hasProjects,
  loading,
  managedConversations,
  launchSelection,
  setLaunchSelection,
  onChangeSessionPresentation,
  onManagedConversationStarted,
  onOpenRepository,
  onRevealLocalProject,
  onRetry,
  onSelectSession,
  project
}: {
  localAiClients?: DesktopApi["localAiClients"];
  error: string | null;
  hasProjects: boolean;
  loading: boolean;
  managedConversations?: ManagedConversationDesktopApi | null;
  launchSelection: ManagedLaunchSelection;
  setLaunchSelection: Dispatch<SetStateAction<ManagedLaunchSelection>>;
  onChangeSessionPresentation: (
    thread: PersonalDesktopProjectThread,
    input: Omit<
      Parameters<PersonalDesktopApi["updateSessionPresentation"]>[0],
      "sessionId" | "expectedVersion"
    >
  ) => Promise<void>;
  onManagedConversationStarted: (
    conversation: ManagedConversationIdentity,
    status: "starting" | "ready",
    launchInput: Parameters<ManagedConversationDesktopApi["start"]>[0],
    initialPrompt?: InitialConversationPrompt
  ) => void;
  onOpenRepository?: (url: string) => void;
  onRevealLocalProject?: (localProjectId: string) => void;
  onRetry: () => void;
  onSelectSession: (sessionId: string) => void;
  project: DesktopProject | null;
}) {
  const [startState, setStartState] = useState<{
    status: "idle" | "starting" | "error";
    message: string;
    executionId: string | null;
  }>({ status: "idle", message: "", executionId: null });
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchOptions, setLaunchOptions] =
    useState<ManagedConversationLaunchOptions | null>(null);
  const [presentationNow, setPresentationNow] = useState(() => Date.now());
  const [presentationBusy, setPresentationBusy] = useState<Set<string>>(
    new Set()
  );
  const [presentationError, setPresentationError] = useState("");
  const [openSessionActionsId, setOpenSessionActionsId] = useState<
    string | null
  >(null);
  const threads = [...(project?.threads ?? [])].sort(
    (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
  );
  const nextDeadline = nextConversationPresentationDeadline(
    threads,
    presentationNow
  );
  useEffect(() => {
    if (nextDeadline === null) return;
    const timeout = setTimeout(
      () => setPresentationNow(Date.now()),
      Math.min(Math.max(0, nextDeadline - Date.now() + 50), 2_147_483_647)
    );
    return () => clearTimeout(timeout);
  }, [nextDeadline]);
  useEffect(() => {
    setPresentationError("");
    setPresentationNow(Date.now());
    setLaunchOpen(false);
    setLaunchOptions(null);
    setOpenSessionActionsId(null);
  }, [project?.id]);
  useEffect(() => {
    if (!managedConversations || !project?.id) return;
    let active = true;
    void Promise.all([
      managedConversations.launchOptions(),
      localAiClients?.list()
    ])
      .then(([{ options }, settings]) => {
        if (!active) return;
        const assignment = settings
          ? assignmentFrom(settings.readModel, "conversations")
          : null;
        if (settings && !assignment) {
          throw new Error(
            "The Conversations default is unavailable. Check Agent Configuration."
          );
        }
        setLaunchOptions(options);
        setLaunchSelection((current) => {
          if (assignment) {
            return selectionForAssignment(options, assignment);
          }
          const instance = options.instances.find(
            (candidate) => candidate.instanceId === current.instanceId
          );
          if (
            instance &&
            launchOwner(instance).ready &&
            instance.models.some((model) => model.id === current.model) &&
            instance.capabilities.permissionModes.some(
              (mode) =>
                mode.mode === current.permissionMode &&
                mode.support === "supported"
            )
          )
            return current;
          const firstReady = options.instances.find(
            (candidate) => launchOwner(candidate).ready
          );
          return launchSelectionForInstance(
            options,
            firstReady?.instanceId ?? ""
          );
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLaunchOptions(null);
        setStartState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
          executionId: null
        });
      });
    return () => {
      active = false;
    };
  }, [localAiClients, managedConversations, project?.id, setLaunchSelection]);
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
            {hasProjects ? "Select a Project" : "No Projects yet"}
          </h2>
          <p>
            {hasProjects
              ? "Choose a Project to inspect its Captured Sessions."
              : "Projects appear after the Supported Capture Hook records a Captured Session."}
          </p>
        </div>
      </section>
    );
  }
  const rootThreads = threads.filter(
    (thread) => thread.threadKind !== "subagent" || !thread.parentThreadId
  );
  const pinned = rootThreads.filter((thread) => thread.presentation?.pinnedAt);
  const active = rootThreads.filter(
    (thread) =>
      !thread.presentation?.pinnedAt &&
      conversationPresentationStatus(thread, presentationNow) === "active"
  );
  const inactive = rootThreads.filter(
    (thread) =>
      !thread.presentation?.pinnedAt &&
      conversationPresentationStatus(thread, presentationNow) !== "active"
  );

  const renderSession = (thread: PersonalDesktopProjectThread) => {
    const selectionId = sessionSelectionId(thread);
    return (
      <SessionRow
        actionsOpen={openSessionActionsId === selectionId}
        busy={presentationBusy.has(selectionId)}
        key={selectionId}
        onActionsOpenChange={(open) =>
          setOpenSessionActionsId((current) =>
            open ? selectionId : current === selectionId ? null : current
          )
        }
        onChangePresentation={(input) => {
          setPresentationError("");
          setPresentationBusy((current) => new Set(current).add(selectionId));
          void onChangeSessionPresentation(thread, input)
            .catch((cause: unknown) => {
              setPresentationError(
                cause instanceof Error ? cause.message : String(cause)
              );
            })
            .finally(() => {
              setPresentationBusy((current) => {
                const next = new Set(current);
                next.delete(selectionId);
                return next;
              });
            });
        }}
        onSelect={() => onSelectSession(selectionId)}
        presentationStatus={conversationPresentationStatus(
          thread,
          presentationNow
        )}
        thread={thread}
      />
    );
  };
  const renderSessionTree = (
    thread: PersonalDesktopProjectThread,
    ancestors = new Set<string>()
  ): ReactNode => {
    if (ancestors.has(thread.id)) return renderSession(thread);
    const lineage = new Set(ancestors).add(thread.id);
    const children = threads.filter(
      (candidate) =>
        candidate.threadKind === "subagent" &&
        candidate.parentThreadId === thread.id
    );
    return (
      <div className="personal-session-tree" key={sessionSelectionId(thread)}>
        {renderSession(thread)}
        {children.length ? (
          <div aria-label="Child Agents" className="personal-child-agents">
            {children.map((child) => renderSessionTree(child, lineage))}
          </div>
        ) : null}
      </div>
    );
  };
  if (launchOpen && launchOptions && managedConversations) {
    return (
      <section
        className="personal-session-detail personal-new-conversation-detail"
        aria-label="New Conversation"
      >
        <header>
          <div className="personal-session-header-copy">
            <small>{project.name} · Private to you</small>
            <div className="personal-session-title-row">
              <h2>New Conversation</h2>
            </div>
            {project.remoteDisplay ? (
              <ProjectRepo
                onOpenRepository={onOpenRepository}
                remoteDisplay={project.remoteDisplay}
              />
            ) : null}
            <p
              aria-label={countLabel(0, "Memory Event")}
              className="personal-memory-event-count"
            >
              0
              <Brain aria-hidden="true" />
            </p>
          </div>
          <div className="personal-session-header-actions">
            <button
              aria-label="Back to Project"
              title="Back to Project"
              className="personal-session-manage-button"
              type="button"
              onClick={() => setLaunchOpen(false)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="personal-new-conversation-content" />
        <NewConversationComposer
          contextKind={project.contextKind}
          key={project.id}
          api={managedConversations}
          projectId={project.id}
          options={launchOptions}
          selection={launchSelection}
          onChange={setLaunchSelection}
          onStarted={(...args) => {
            setLaunchOpen(false);
            onManagedConversationStarted(...args);
          }}
        />
      </section>
    );
  }
  return (
    <section className="personal-project-detail">
      <header>
        <span className="personal-project-monogram" aria-hidden="true">
          {Array.from(project.name)[0]?.toLocaleUpperCase() ?? "P"}
        </span>
        <div className="personal-project-detail-heading">
          <h2 data-personal-route-focus="project" tabIndex={-1}>
            {project.name}
          </h2>
          <ProjectOverview
            eventCount={project.eventCount}
            localProjectId={project.localProjectId}
            onOpenRepository={onOpenRepository}
            onRevealLocalProject={onRevealLocalProject}
            projectName={project.name}
            remoteDisplay={project.remoteDisplay}
            sessionCount={project.threads.length}
          />
        </div>
        <button
          className="personal-new-conversation personal-new-conversation-standalone"
          type="button"
          disabled={!managedConversations || !project.path || !launchOptions}
          aria-expanded={launchOpen}
          onClick={() => setLaunchOpen((open) => !open)}
        >
          New
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
      <section className="personal-sessions" aria-label="Captured Sessions">
        {presentationError ? (
          <p className="personal-managed-error" role="alert">
            {presentationError}
          </p>
        ) : null}
        {threads.length ? (
          <div>
            {pinned.length ? (
              <section aria-label="Pinned Conversations">
                <h3>Pinned</h3>
                {pinned.map((thread) => renderSessionTree(thread))}
              </section>
            ) : null}
            {active.length ? (
              <details
                aria-label="Active Conversations"
                className="personal-conversation-section"
                open
              >
                <summary>
                  <span>Active</span>
                  <span>{active.length}</span>
                </summary>
                {active.map((thread) => renderSessionTree(thread))}
              </details>
            ) : null}
            {inactive.length ? (
              <details
                aria-label="Inactive Conversations"
                className="personal-conversation-section"
              >
                <summary>
                  <span>Inactive</span>
                  <span>{inactive.length}</span>
                </summary>
                {inactive.map((thread) => renderSessionTree(thread))}
              </details>
            ) : null}
          </div>
        ) : (
          <div
            className="personal-memory-empty-detail personal-sessions-empty"
            role="status"
          >
            <div>
              <BookText aria-hidden="true" className="personal-empty-icon" />
              <h2>No Captured Sessions yet</h2>
              <p>
                Sessions appear after the Supported Capture Hook records
                activity in this Project.
              </p>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}

function StoreConversation({
  authorizeManagedConversationTransfer,
  managedConversationRevision,
  managedConversationRecoveryRevision,
  managedConversationUpdate,
  managedConversations,
  managedProject,
  markdownAdapters,
  pendingCanonicalConversation,
  managedDraft,
  onRetryManagedConversation,
  onStopControlChange,
  onInspectEvent,
  project,
  routeSessionId,
  store,
  thread
}: {
  authorizeManagedConversationTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  managedConversationRevision: number;
  managedConversationRecoveryRevision: number;
  managedConversationUpdate: PersonalMemoryWorkspaceProps["managedConversationUpdate"];
  managedConversations?: ManagedConversationDesktopApi | null;
  managedProject?: ManagedProjectDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
  pendingCanonicalConversation: boolean;
  managedDraft: ManagedConversationDraft | null;
  onRetryManagedConversation: (() => void) | null;
  onStopControlChange: (control: ManagedConversationStopControl | null) => void;
  onInspectEvent?: (selection: PersonalMemoryInspectorEvent) => void;
  project: PersonalDesktopProject;
  routeSessionId: string;
  store: PersonalMemoryStore;
  thread: PersonalDesktopProjectThread;
}) {
  const initialCanonicalConversation =
    managedDraft?.conversation.executionId &&
    managedDraft.conversation.capturedSessionId !==
      managedDraft.conversation.executionId
      ? managedDraft.conversation
      : null;
  const [canonicalConversation, setCanonicalConversation] =
    useState<ManagedConversationIdentity | null>(initialCanonicalConversation);
  const [optimisticPrompts, setOptimisticPrompts] = useState<
    Array<{
      event: PersonalDesktopConversationEvent;
      clientUserMessageId: string;
    }>
  >(() =>
    managedDraft?.initialPrompt &&
    managedDraft.initialPrompt.status !== "rejected"
      ? [
          {
            clientUserMessageId: managedDraft.initialPrompt.clientUserMessageId,
            event: {
              id: managedDraft.initialPrompt.clientUserMessageId,
              actor: "user",
              eventType: "user_message",
              timestamp: new Date().toISOString(),
              sourceEventTime: null,
              sourceSequence: null,
              content: managedDraft.initialPrompt.prompt,
              contentPreview: managedDraft.initialPrompt.prompt,
              invalidatedAt: null,
              metadata: {}
            }
          }
        ]
      : []
  );
  const [responseActive, setResponseActive] = useState(false);
  const [responseTimestamp] = useState(() => new Date().toISOString());
  const [transientAssistantOutputs, setTransientAssistantOutputs] = useState<
    PersonalDesktopConversationEvent[]
  >([]);
  const [checkoutIdentity, setCheckoutIdentity] = useState<{
    executionId: string;
    executionGeneration: number;
    vcsDriver: "git" | null;
  } | null>(null);
  const [contextAttachments, setContextAttachments] = useState<
    Array<
      | { kind: "file"; reference: string; label: string }
      | { kind: "terminal"; reference: string; label: string }
    >
  >([]);
  const attachContext = useCallback(
    (
      attachment:
        | { kind: "file"; reference: string; label: string }
        | { kind: "terminal"; reference: string; label: string }
    ) => {
      setContextAttachments((current) =>
        current.some(
          (candidate) =>
            candidate.kind === attachment.kind &&
            candidate.reference === attachment.reference
        )
          ? current
          : [...current, attachment]
      );
    },
    []
  );
  const attachFileContext = useCallback(
    ({ commandId, label }: { commandId: string; label: string }) =>
      attachContext({ kind: "file", reference: commandId, label }),
    [attachContext]
  );
  const attachTerminalContext = useCallback(
    ({
      contextReference,
      label
    }: {
      contextReference: string;
      label: string;
    }) =>
      attachContext({ kind: "terminal", reference: contextReference, label }),
    [attachContext]
  );
  const mergeTransientOutputs = useCallback(
    (
      items: ManagedConversationRuntimeItem[],
      command: ManagedConversationRuntimeState["latestCommand"]
    ) => {
      const completed =
        command?.commandKind === "prompt" && command.state === "completed";
      if (completed && command.clientUserMessageId) {
        setOptimisticPrompts((current) =>
          current.some(
            (item) => item.clientUserMessageId === command.clientUserMessageId
          )
            ? current.filter(
                (item) =>
                  item.clientUserMessageId !== command.clientUserMessageId
              )
            : current
        );
      }
      const visible = items.filter(
        (item) =>
          item.state === "pending" && (item.providerItemId || !completed)
      );
      const visibleIds = new Set(visible.map((item) => item.id));
      setTransientAssistantOutputs((current) => {
        const next = new Map(
          current
            .filter(
              (event) =>
                event.metadata.providerItemId || visibleIds.has(event.id)
            )
            .map((event) => [event.id, event] as const)
        );
        let changed = next.size !== current.length;
        for (const item of visible) {
          const text = runtimeText(item.payload.text);
          if (!text) continue;
          const previous = next.get(item.id);
          if (previous?.content === text) continue;
          changed = true;
          next.set(item.id, {
            id: item.id,
            actor: "assistant",
            eventType: "agent_message",
            timestamp: item.updatedAt,
            sourceEventTime: item.updatedAt,
            sourceSequence: null,
            content: text,
            contentPreview: text.slice(0, 16_384),
            invalidatedAt: null,
            presentation: {
              mode: "expanded",
              renderer: "message",
              policyKey: "owned_conversation_transient_agent_message",
              policyRevision: 1,
              reason: "live-owned-conversation-provider-output"
            },
            metadata: {
              ...(item.providerTurnId
                ? { providerTurnId: item.providerTurnId }
                : {}),
              ...(item.providerItemId
                ? { providerItemId: item.providerItemId }
                : {})
            }
          });
        }
        return changed ? [...next.values()] : current;
      });
    },
    []
  );
  useEffect(() => {
    setCanonicalConversation(initialCanonicalConversation);
  }, [
    initialCanonicalConversation?.capturedSessionId,
    initialCanonicalConversation?.executionId,
    initialCanonicalConversation?.threadId,
    routeSessionId
  ]);
  const detailThread = useMemo(
    () =>
      canonicalConversation
        ? {
            ...thread,
            id: canonicalConversation.threadId,
            sessionId: canonicalConversation.capturedSessionId
          }
        : thread,
    [
      thread,
      canonicalConversation?.threadId,
      canonicalConversation?.capturedSessionId
    ]
  );
  const { detail, loadOlder, retry } = usePersonalMemoryDetail(
    store,
    detailThread,
    !pendingCanonicalConversation || canonicalConversation !== null
  );
  const canonicalEvents = detail?.events ?? [];
  const canonicalProviderItems = useMemo(
    () =>
      new Set(
        canonicalEvents.flatMap((event) =>
          event.metadata.providerTurnId && event.metadata.providerItemId
            ? [
                `${event.metadata.providerTurnId}\0${event.metadata.providerItemId}`
              ]
            : []
        )
      ),
    [canonicalEvents]
  );
  const unreconciledTransientOutputs = useMemo(
    () =>
      transientAssistantOutputs.filter((event) => {
        const turnId = event.metadata.providerTurnId;
        const itemId = event.metadata.providerItemId;
        return (
          !turnId ||
          !itemId ||
          !canonicalProviderItems.has(`${turnId}\0${itemId}`)
        );
      }),
    [canonicalProviderItems, transientAssistantOutputs]
  );
  const unreconciledOptimisticPrompts = useMemo(() => {
    const canonicalClientMessageIds = new Set(
      canonicalEvents.flatMap((event) =>
        event.actor === "user" && event.metadata.clientUserMessageId
          ? [event.metadata.clientUserMessageId]
          : []
      )
    );
    return optimisticPrompts.filter(
      ({ clientUserMessageId }) =>
        !canonicalClientMessageIds.has(clientUserMessageId)
    );
  }, [canonicalEvents, optimisticPrompts]);
  useEffect(() => {
    if (unreconciledOptimisticPrompts.length === optimisticPrompts.length)
      return;
    setOptimisticPrompts(unreconciledOptimisticPrompts);
  }, [optimisticPrompts.length, unreconciledOptimisticPrompts]);
  const previousRouteSessionId = useRef(routeSessionId);
  useEffect(() => {
    if (previousRouteSessionId.current === routeSessionId) return;
    previousRouteSessionId.current = routeSessionId;
    setOptimisticPrompts([]);
    setTransientAssistantOutputs([]);
    setContextAttachments([]);
  }, [routeSessionId]);
  const latestPromptTime = Math.max(
    0,
    ...canonicalEvents
      .filter((event) => event.actor === "user")
      .map((event) => Date.parse(event.timestamp) || 0),
    ...unreconciledOptimisticPrompts.map(
      ({ event }) => Date.parse(event.timestamp) || 0
    )
  );
  const streamingOutput = [...unreconciledTransientOutputs]
    .reverse()
    .find((event) => Date.parse(event.timestamp) >= latestPromptTime);
  const overlayEvents = [
    ...unreconciledOptimisticPrompts.map(({ event }) => event),
    ...unreconciledTransientOutputs.map((event) =>
      responseActive && event === streamingOutput
        ? {
            ...event,
            responseStreaming: true
          }
        : event
    ),
    ...(responseActive && !streamingOutput
      ? [
          {
            id: `pending-response:${routeSessionId}`,
            actor: "assistant",
            eventType: "agent_message",
            timestamp: latestPromptTime
              ? new Date(latestPromptTime + 1).toISOString()
              : responseTimestamp,
            sourceEventTime: null,
            sourceSequence: null,
            content: "",
            contentPreview: "",
            invalidatedAt: null,
            metadata: {},
            responseStreaming: true
          }
        ]
      : [])
  ];
  const hasVisibleEvents =
    overlayEvents.length > 0 || (detail?.events.length ?? 0) > 0;
  const model: ConversationSurfaceModel = pendingCanonicalConversation
    ? {
        error: "",
        events: overlayEvents,
        hasOlderEvents: false,
        status: "ready"
      }
    : detail
      ? {
          error: detail.error ?? "",
          events: [...detail.events, ...overlayEvents],
          hasOlderEvents: detail.hasOlder,
          status:
            detail.status === "loading" && hasVisibleEvents
              ? "ready"
              : detail.status
        }
      : {
          error: "",
          events: overlayEvents,
          hasOlderEvents: false,
          status: hasVisibleEvents ? "ready" : "loading"
        };
  return (
    <div className="personal-conversation-shell">
      <div className="personal-conversation-body">
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
        {managedProject && checkoutIdentity ? (
          <ManagedProjectCockpit
            api={managedProject}
            identity={checkoutIdentity}
            onAttachFile={attachFileContext}
            onAttachTerminal={attachTerminalContext}
            revision={managedConversationRevision}
          />
        ) : null}
      </div>
      {thread.sessionId && managedConversations ? (
        <ManagedConversationComposer
          api={managedConversations}
          authorizeTransfer={authorizeManagedConversationTransfer}
          conversation={
            managedDraft?.conversation ?? {
              executionId: null,
              projectId: project.id,
              capturedSessionId: thread.sessionId,
              threadId: thread.id
            }
          }
          draftScopeId={managedDraft?.conversation.executionId ?? null}
          initialSelection={managedDraft?.launchInput}
          initialPrompt={managedDraft?.initialPrompt}
          startupStatus={managedDraft?.status ?? null}
          startupMessage={managedDraft?.message ?? ""}
          onRetryStartup={onRetryManagedConversation}
          onStopControlChange={onStopControlChange}
          managedConversationRecoveryRevision={
            managedConversationRecoveryRevision
          }
          managedConversationUpdate={managedConversationUpdate}
          contextAttachments={contextAttachments}
          onContextAttachmentsChanged={setContextAttachments}
          onOptimisticPrompt={({ clientUserMessageId, prompt }) => {
            const timestamp = new Date().toISOString();
            setOptimisticPrompts((current) => [
              ...current,
              {
                event: {
                  id: clientUserMessageId,
                  actor: "user",
                  eventType: "user_message",
                  timestamp,
                  sourceEventTime: timestamp,
                  sourceSequence: null,
                  content: prompt,
                  contentPreview: prompt.slice(0, 16_384),
                  invalidatedAt: null,
                  presentation: {
                    mode: "expanded",
                    renderer: "message",
                    policyKey: "owned_conversation_user_message",
                    policyRevision: 1,
                    reason: "optimistic-owned-conversation-prompt"
                  },
                  metadata: { clientUserMessageId }
                },
                clientUserMessageId
              }
            ]);
          }}
          onRejectOptimisticPrompt={(clientUserMessageId) => {
            setOptimisticPrompts((current) =>
              current.filter(
                (item) => item.clientUserMessageId !== clientUserMessageId
              )
            );
          }}
          onResponseActiveChange={setResponseActive}
          onTransientOutputs={mergeTransientOutputs}
          onConversationIdentityChanged={setCanonicalConversation}
          onCheckoutIdentityChanged={setCheckoutIdentity}
        />
      ) : null}
    </div>
  );
}

type ComposerState =
  | { status: "attaching"; message: string }
  | { status: "starting"; message: string }
  | { status: "ready"; message: string }
  | { status: "sending"; message: string }
  | { status: "reconciling"; message: string }
  | { status: "read_only"; message: string }
  | { status: "error"; message: string };

type ManagedConversationStopControl = {
  disabled: boolean;
  stop: () => void;
};

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

function ManagedConversationUsage({
  model,
  provider,
  usage
}: {
  model: string | null;
  provider: "codex" | "claude" | "pi";
  usage: ManagedConversationContextUsage | null;
}) {
  const displayModel = usage?.model ?? model;
  const percentage =
    usage?.usedTokens !== null &&
    usage?.usedTokens !== undefined &&
    usage.modelContextWindow &&
    usage.modelContextWindow > 0
      ? Math.min(100, (usage.usedTokens / usage.modelContextWindow) * 100)
      : null;
  const details = [
    usage?.inputTokens !== null && usage?.inputTokens !== undefined
      ? `Input ${compactTokenCount(usage.inputTokens)}`
      : null,
    usage?.cachedInputTokens !== null && usage?.cachedInputTokens !== undefined
      ? `Cached ${compactTokenCount(usage.cachedInputTokens)}`
      : null,
    usage?.outputTokens !== null && usage?.outputTokens !== undefined
      ? `Output ${compactTokenCount(usage.outputTokens)}`
      : null,
    usage?.reasoningOutputTokens !== null &&
    usage?.reasoningOutputTokens !== undefined
      ? `Reasoning output ${compactTokenCount(usage.reasoningOutputTokens)}`
      : null
  ]
    .filter((value): value is string => value !== null)
    .join("; ");
  return (
    <div
      className="personal-managed-usage"
      title={[managedProviderLabel(provider), displayModel, details]
        .filter(Boolean)
        .join(" · ")}
    >
      {usage?.usedTokens !== null && usage?.usedTokens !== undefined ? (
        <>
          <span>Context:</span>
          <span className="personal-managed-usage-count">
            {compactTokenCount(usage.usedTokens)}
          </span>
          {percentage !== null ? (
            <span
              aria-label={`${Math.round(percentage)}% of context window used`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(percentage)}
              className="personal-managed-usage-meter"
              role="progressbar"
            >
              <span style={{ width: `${percentage}%` }} />
            </span>
          ) : null}
          {usage.modelContextWindow ? (
            <span className="personal-managed-usage-count">
              {compactTokenCount(usage.modelContextWindow)}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const runtimeText = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 16_384) : "";

const runtimeJson = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, 16_384);
  } catch {
    return "";
  }
};

function ManagedRuntimeItemView({
  item,
  busy,
  onRespond
}: {
  item: ManagedConversationRuntimeItem;
  busy: boolean;
  onRespond: (input: {
    decision?: "accept" | "acceptForSession" | "decline" | "cancel";
    answers?: Record<string, string[]>;
  }) => void;
}) {
  if (
    item.itemKind === "transient_output" &&
    item.presentation.renderer === "message"
  ) {
    const text = runtimeText(item.payload.text);
    return text ? (
      <div className="personal-managed-transient" aria-live="polite">
        <span>The AI Client is working</span>
        <p>{text}</p>
      </div>
    ) : null;
  }
  if (
    item.itemKind === "user_input" &&
    item.presentation.renderer === "user_input"
  ) {
    const questions = Array.isArray(item.payload.questions)
      ? item.payload.questions
      : [];
    return (
      <div className="personal-managed-interaction">
        <strong>The AI Client needs input</strong>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            const answers: Record<string, string[]> = {};
            for (const question of questions) {
              if (!question || typeof question !== "object") continue;
              const entry = question as Record<string, unknown>;
              const id = runtimeText(entry.id);
              if (!id) continue;
              const answer = String(values.get(id) ?? "");
              const optionLabels = Array.isArray(entry.options)
                ? entry.options
                    .map((option) =>
                      option && typeof option === "object"
                        ? runtimeText((option as Record<string, unknown>).label)
                        : ""
                    )
                    .filter(Boolean)
                : [];
              answers[id] = [
                entry.isOther === true && !optionLabels.includes(answer)
                  ? `user_note: ${answer}`
                  : answer
              ];
            }
            onRespond({ answers });
          }}
        >
          {questions.map((question, index) => {
            const entry =
              question && typeof question === "object"
                ? (question as Record<string, unknown>)
                : {};
            const id = runtimeText(entry.id) || `question-${index}`;
            const options = Array.isArray(entry.options)
              ? entry.options
                  .map((option) =>
                    option && typeof option === "object"
                      ? (option as Record<string, unknown>)
                      : null
                  )
                  .filter(
                    (option): option is Record<string, unknown> =>
                      option !== null && Boolean(runtimeText(option.label))
                  )
              : [];
            return (
              <label key={id}>
                <span>
                  {runtimeText(entry.header) ||
                    runtimeText(entry.question) ||
                    "Response"}
                </span>
                {runtimeText(entry.header) && runtimeText(entry.question) ? (
                  <small>{runtimeText(entry.question)}</small>
                ) : null}
                {options.length && entry.isOther !== true ? (
                  <select defaultValue="" name={id} required>
                    <option disabled value="">
                      Select an answer
                    </option>
                    {options.map((option) => {
                      const label = runtimeText(option.label);
                      return (
                        <option key={label} value={label}>
                          {label}
                          {runtimeText(option.description)
                            ? ` — ${runtimeText(option.description)}`
                            : ""}
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <>
                    <input
                      list={options.length ? `${id}-options` : undefined}
                      name={id}
                      required
                      type={entry.isSecret === true ? "password" : "text"}
                    />
                    {options.length ? (
                      <datalist id={`${id}-options`}>
                        {options.map((option) => {
                          const label = runtimeText(option.label);
                          return <option key={label} value={label} />;
                        })}
                      </datalist>
                    ) : null}
                  </>
                )}
              </label>
            );
          })}
          <button disabled={busy} type="submit">
            <Check aria-hidden="true" /> Submit
          </button>
        </form>
      </div>
    );
  }
  if (item.presentation.renderer !== "approval") return null;
  const command = Array.isArray(item.payload.command)
    ? item.payload.command.map(String).join(" ")
    : runtimeText(item.payload.command);
  const reason = runtimeText(item.payload.reason);
  const toolName = runtimeText(item.payload.toolName);
  const toolInput = toolName ? runtimeJson(item.payload.input) : "";
  const workingDirectory = runtimeText(item.payload.cwd);
  const grantRoot = runtimeText(item.payload.grantRoot);
  const permissions =
    item.itemKind === "permissions_approval"
      ? runtimeJson(item.payload.permissions)
      : "";
  return (
    <div
      className={`personal-managed-interaction personal-managed-interaction--${item.presentation.mode}`}
    >
      <strong>
        {item.itemKind === "file_approval"
          ? "Approve file changes?"
          : item.itemKind === "permissions_approval"
            ? "Approve permissions?"
            : "Approve command?"}
      </strong>
      {command ? <code>{command}</code> : null}
      {toolName ? <code>Tool: {toolName}</code> : null}
      {toolInput ? <pre>{toolInput}</pre> : null}
      {workingDirectory ? (
        <code>Working directory: {workingDirectory}</code>
      ) : null}
      {grantRoot ? <code>Grant root: {grantRoot}</code> : null}
      {permissions ? <code>Permissions: {permissions}</code> : null}
      {reason ? <p>{reason}</p> : null}
      <div>
        <button
          disabled={busy}
          onClick={() => onRespond({ decision: "decline" })}
          type="button"
        >
          <X aria-hidden="true" /> Deny
        </button>
        <button
          disabled={busy}
          onClick={() => onRespond({ decision: "accept" })}
          type="button"
        >
          <Check aria-hidden="true" /> Approve
        </button>
        {item.payload.supportsSessionApproval === true ? (
          <button
            disabled={busy}
            onClick={() => onRespond({ decision: "acceptForSession" })}
            type="button"
          >
            Always allow this session
          </button>
        ) : null}
        <button
          disabled={busy}
          onClick={() => onRespond({ decision: "cancel" })}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ManagedConversationComposer({
  api,
  authorizeTransfer,
  conversation,
  draftScopeId,
  initialSelection,
  initialPrompt,
  startupMessage,
  startupStatus,
  onRetryStartup,
  onStopControlChange,
  managedConversationRecoveryRevision,
  managedConversationUpdate,
  contextAttachments,
  onContextAttachmentsChanged,
  onOptimisticPrompt,
  onRejectOptimisticPrompt,
  onTransientOutputs,
  onResponseActiveChange,
  onConversationIdentityChanged,
  onCheckoutIdentityChanged
}: {
  api: ManagedConversationDesktopApi;
  authorizeTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  conversation: ManagedConversationIdentity;
  draftScopeId: string | null;
  initialSelection?: Parameters<ManagedConversationDesktopApi["start"]>[0];
  initialPrompt?: InitialConversationPrompt;
  startupMessage: string;
  startupStatus: ManagedConversationDraft["status"] | null;
  onRetryStartup: (() => void) | null;
  onStopControlChange: (control: ManagedConversationStopControl | null) => void;
  managedConversationRecoveryRevision: number;
  managedConversationUpdate: PersonalMemoryWorkspaceProps["managedConversationUpdate"];
  contextAttachments: Array<
    | { kind: "file"; reference: string; label: string }
    | { kind: "terminal"; reference: string; label: string }
  >;
  onContextAttachmentsChanged: (
    value: Array<
      | { kind: "file"; reference: string; label: string }
      | { kind: "terminal"; reference: string; label: string }
    >
  ) => void;
  onOptimisticPrompt: (input: {
    clientUserMessageId: string;
    prompt: string;
  }) => void;
  onRejectOptimisticPrompt: (clientUserMessageId: string) => void;
  onResponseActiveChange: (active: boolean) => void;
  onTransientOutputs: (
    items: ManagedConversationRuntimeItem[],
    command: ManagedConversationRuntimeState["latestCommand"]
  ) => void;
  onConversationIdentityChanged: (
    conversation: ManagedConversationIdentity
  ) => void;
  onCheckoutIdentityChanged: (
    value: {
      executionId: string;
      executionGeneration: number;
      vcsDriver: "git" | null;
    } | null
  ) => void;
}) {
  const [draft, setDraft] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [resolvedConversation, setResolvedConversation] =
    useState<ManagedConversationIdentity>(conversation);
  const capabilities = useContext(ManagedCapabilitiesContext);
  const ownerCapabilities = resolvedConversation.executionOwner
    ? capabilities?.get(managedOwnerKey(resolvedConversation.executionOwner))
    : undefined;
  const ownerSendReady =
    capabilities === undefined ||
    Boolean(ownerCapabilities?.resume && ownerCapabilities.send);
  const ownerHandoffReady =
    capabilities === undefined || ownerCapabilities?.handoff === true;
  const ownerForkReady =
    capabilities === undefined || ownerCapabilities?.fork === true;
  const [targetDevices, setTargetDevices] = useState<
    Awaited<ReturnType<ManagedConversationDesktopApi["targets"]>>["devices"]
  >([]);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [transferMessage, setTransferMessage] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [usage, setUsage] = useState<{
    provider: "codex" | "claude" | "pi";
    model: string | null;
    reasoningEffort: string | null;
    permissionMode: AiClientPermissionMode | null;
    usage: ManagedConversationContextUsage | null;
  } | null>(null);
  const [settingsOptions, setSettingsOptions] =
    useState<ManagedConversationLaunchOptions | null>(null);
  const [settingsChange, setSettingsChange] =
    useState<ManagedConversationSettingsChange | null>(null);
  const [settingsError, setSettingsError] = useState(
    initialPrompt?.status === "rejected" ? initialPrompt.message : ""
  );
  const refreshSettingsOptions = useCallback(() => {
    void api
      .launchOptions()
      .then((result) => setSettingsOptions(result.options))
      .catch(() => setSettingsOptions(null));
  }, [api]);
  useEffect(() => {
    refreshSettingsOptions();
  }, [refreshSettingsOptions, resolvedConversation.executionId]);
  const selectedSettings =
    settingsChange?.next ??
    (usage?.model && usage.permissionMode
      ? {
          model: usage.model,
          reasoningEffort: usage.reasoningEffort,
          permissionMode: usage.permissionMode
        }
      : initialSelection
        ? {
            model: initialSelection.model,
            reasoningEffort: initialSelection.reasoningEffort || null,
            permissionMode: initialSelection.permissionMode
          }
        : null);
  const [runtime, setRuntime] =
    useState<ManagedConversationRuntimeState | null>(null);
  const [runtimeActionBusy, setRuntimeActionBusy] = useState(false);
  const [state, setState] = useState<ComposerState>({
    status: "attaching",
    message: "Confirming local AI Client execution…"
  });
  const submissionRef = useRef<{
    idempotencyKey: string;
    prompt: string;
    clientUserMessageId: string;
    fileMentionCommandIds: string[];
    terminalContextReferences: string[];
    settingsChange?: ManagedConversationSettingsChange;
    contextAttachments: Array<
      | { kind: "file"; reference: string; label: string }
      | { kind: "terminal"; reference: string; label: string }
    >;
  } | null>(null);
  const submissionInFlightRef = useRef(false);
  const lastSubmittedRef = useRef<NonNullable<
    typeof submissionRef.current
  > | null>(
    initialPrompt && initialPrompt.status !== "rejected"
      ? {
          idempotencyKey: `desktop-prompt:${initialPrompt.clientUserMessageId}`,
          clientUserMessageId: initialPrompt.clientUserMessageId,
          prompt: initialPrompt.prompt,
          fileMentionCommandIds: [],
          terminalContextReferences: [],
          contextAttachments: []
        }
      : null
  );
  const draftRef = useRef("");
  const draftEditedRef = useRef(false);
  const persistedDraftRef = useRef({ scopeKey: "", value: "" });
  const draftWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const runtimeRef = useRef<ManagedConversationRuntimeState | null>(null);
  const runtimeSnapshotRequestRef = useRef(0);
  const runtimeSnapshotInFlightRef = useRef(false);
  const pendingRuntimeUpdatesRef = useRef<ManagedConversationRealtimeUpdate[]>(
    []
  );
  const draftCapturedSessionId = draftScopeId ?? conversation.capturedSessionId;
  const draftThreadId = draftScopeId ?? conversation.threadId;
  const draftScope = useMemo(
    () => ({
      projectId: conversation.projectId,
      capturedSessionId: draftCapturedSessionId,
      threadId: draftThreadId
    }),
    [conversation.projectId, draftCapturedSessionId, draftThreadId]
  );
  const draftScopeKey = `${draftScope.projectId}\0${draftScope.capturedSessionId}\0${draftScope.threadId}`;
  const persistDraft = useCallback(
    (value: string, reportFailure: boolean) => {
      const scopeKey = draftScopeKey;
      draftWriteChainRef.current = draftWriteChainRef.current
        .catch(() => undefined)
        .then(async () => {
          if (
            persistedDraftRef.current.scopeKey === scopeKey &&
            value === persistedDraftRef.current.value
          ) {
            return;
          }
          if (value) {
            await api.writeDraft({ ...draftScope, value });
          } else {
            await api.deleteDraft(draftScope);
          }
          if (persistedDraftRef.current.scopeKey === scopeKey) {
            persistedDraftRef.current = { scopeKey, value };
          }
        })
        .catch(() => {
          if (reportFailure) {
            setDraftError("Koed could not save this draft securely.");
          }
        });
      return draftWriteChainRef.current;
    },
    [api, draftScope, draftScopeKey]
  );

  const refreshRuntimeSnapshot = useCallback(
    async (executionId: string) => {
      const request = runtimeSnapshotRequestRef.current + 1;
      runtimeSnapshotRequestRef.current = request;
      runtimeSnapshotInFlightRef.current = true;
      try {
        const result = await api.runtime(executionId);
        if (request !== runtimeSnapshotRequestRef.current) return;
        let next = managedConversationRuntimeStateFromSnapshot(result);
        let requiresFollowup = false;
        const queued = pendingRuntimeUpdatesRef.current.splice(0);
        for (const update of queued) {
          if (update.execution.id !== executionId) continue;
          const reduced = reduceManagedConversationRuntime(next, update);
          next = reduced.state;
          requiresFollowup ||= reduced.requiresSnapshot;
        }
        runtimeRef.current = next;
        setRuntime(next);
        setRuntimeActionBusy(false);
        if (requiresFollowup) {
          runtimeSnapshotInFlightRef.current = false;
          void refreshRuntimeSnapshot(executionId);
        }
      } catch {
        if (request === runtimeSnapshotRequestRef.current) {
          setRuntimeActionBusy(false);
        }
      } finally {
        if (request === runtimeSnapshotRequestRef.current) {
          runtimeSnapshotInFlightRef.current = false;
        }
      }
    },
    [api]
  );

  useEffect(() => {
    let active = true;
    setDraft("");
    draftRef.current = "";
    draftEditedRef.current = false;
    persistedDraftRef.current = { scopeKey: draftScopeKey, value: "" };
    setDraftReady(false);
    setDraftError("");
    void api
      .readDraft(draftScope)
      .then((result) => {
        if (!active) return;
        if (!draftEditedRef.current) {
          const restored =
            result.value ||
            (initialPrompt?.status === "rejected" ? initialPrompt.prompt : "");
          setDraft(restored);
          draftRef.current = restored;
        }
        persistedDraftRef.current = {
          scopeKey: draftScopeKey,
          value: result.value
        };
        setDraftReady(true);
      })
      .catch(() => {
        if (!active) return;
        setDraftError("Draft persistence is unavailable on this device.");
        setDraftReady(true);
      });
    return () => {
      active = false;
    };
  }, [api, draftScope, draftScopeKey, initialPrompt]);

  useEffect(() => {
    if (!draftReady) return;
    const timeout = setTimeout(() => {
      void persistDraft(draft, true);
    }, 300);
    return () => clearTimeout(timeout);
  }, [draft, draftReady, persistDraft]);

  useEffect(
    () => () => {
      if (!draftReady || !draftRef.current) return;
      void persistDraft(draftRef.current, false);
    },
    [draftReady, persistDraft]
  );

  useEffect(() => {
    const executionId = resolvedConversation.executionId;
    if (!executionId) {
      setUsage(null);
      return;
    }
    let active = true;
    void api
      .usage(executionId)
      .then((result) => {
        if (active) {
          setUsage({
            provider: result.provider,
            model: result.model,
            reasoningEffort: result.reasoningEffort,
            permissionMode: result.permissionMode ?? null,
            usage: result.usage
          });
        }
      })
      .catch(() => {
        if (active) setUsage(null);
      });
    return () => {
      active = false;
    };
  }, [
    api,
    resolvedConversation.executionId,
    runtime?.executionGeneration,
    runtime?.latestCommand?.state,
    runtime?.latestCommand?.updatedAt
  ]);

  useEffect(() => {
    if (!runtime) return;
    const outputs = runtime.items.filter(
      (item) => item.itemKind === "transient_output"
    );
    onTransientOutputs(outputs, runtime.latestCommand);
  }, [onTransientOutputs, runtime]);

  useEffect(() => {
    onCheckoutIdentityChanged(
      resolvedConversation.executionId && runtime
        ? {
            executionId: resolvedConversation.executionId,
            executionGeneration: runtime.executionGeneration,
            vcsDriver: runtime.vcsDriver
          }
        : null
    );
    return () => onCheckoutIdentityChanged(null);
  }, [onCheckoutIdentityChanged, resolvedConversation.executionId, runtime]);

  useEffect(() => {
    const executionId = resolvedConversation.executionId;
    runtimeSnapshotRequestRef.current += 1;
    runtimeSnapshotInFlightRef.current = false;
    pendingRuntimeUpdatesRef.current = [];
    runtimeRef.current = null;
    setRuntime(null);
    if (!executionId) return;
    void refreshRuntimeSnapshot(executionId);
  }, [
    managedConversationRecoveryRevision,
    refreshRuntimeSnapshot,
    resolvedConversation.executionId
  ]);

  useEffect(() => {
    const envelope = managedConversationUpdate;
    const executionId = resolvedConversation.executionId;
    if (
      !envelope ||
      !executionId ||
      envelope.update.execution.id !== executionId
    ) {
      return;
    }
    if (runtimeSnapshotInFlightRef.current || !runtimeRef.current) {
      pendingRuntimeUpdatesRef.current.push(envelope.update);
      if (!runtimeSnapshotInFlightRef.current) {
        void refreshRuntimeSnapshot(executionId);
      }
      return;
    }
    const reduced = reduceManagedConversationRuntime(
      runtimeRef.current,
      envelope.update
    );
    runtimeRef.current = reduced.state;
    setRuntime(reduced.state);
    setRuntimeActionBusy(false);
    if (reduced.requiresSnapshot) {
      void refreshRuntimeSnapshot(executionId);
    }
  }, [
    managedConversationUpdate,
    refreshRuntimeSnapshot,
    resolvedConversation.executionId
  ]);

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
    managedConversationRecoveryRevision,
    resolvedConversation.executionId,
    transferBusy
  ]);

  useEffect(() => {
    let active = true;
    submissionInFlightRef.current = false;
    submissionRef.current = null;
    setResolvedConversation(conversation);
    if (startupStatus === "starting") {
      setState({
        status: "starting",
        message: startupMessage || "Starting the AI Client in this Project…"
      });
      return () => {
        active = false;
      };
    }
    if (startupStatus === "reconciling") {
      setState({
        status: "reconciling",
        message:
          startupMessage || "Koed is reconciling this Conversation safely."
      });
      return () => {
        active = false;
      };
    }
    if (initialPrompt?.status === "reconciling") {
      setState({ status: "reconciling", message: initialPrompt.message });
      return () => {
        active = false;
      };
    }
    if (startupStatus === "failed") {
      setState({
        status: "error",
        message: startupMessage || "Codex could not start this Conversation."
      });
      return () => {
        active = false;
      };
    }
    setState({
      status: "attaching",
      message: "Confirming local AI Client execution…"
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
        onConversationIdentityChanged(result.conversation);
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
    startupMessage,
    startupStatus,
    initialPrompt
  ]);

  const submit = useCallback(async () => {
    if (
      submissionInFlightRef.current ||
      !ownerSendReady ||
      (state.status !== "ready" && state.status !== "starting") ||
      !resolvedConversation.executionId ||
      !draft.trim()
    ) {
      return;
    }
    if (
      runtimeRef.current?.latestCommand?.commandKind === "prompt" &&
      ["queued", "blocked", "dispatching", "indeterminate"].includes(
        runtimeRef.current.latestCommand.state
      )
    )
      return;
    const fileMentionCommandIds = contextAttachments
      .filter((attachment) => attachment.kind === "file")
      .map((attachment) => attachment.reference);
    const terminalContextReferences = contextAttachments
      .filter((attachment) => attachment.kind === "terminal")
      .map((attachment) => attachment.reference);
    const submission =
      submissionRef.current?.prompt === draft &&
      JSON.stringify(submissionRef.current.fileMentionCommandIds) ===
        JSON.stringify(fileMentionCommandIds) &&
      JSON.stringify(submissionRef.current.terminalContextReferences) ===
        JSON.stringify(terminalContextReferences) &&
      JSON.stringify(submissionRef.current.settingsChange ?? null) ===
        JSON.stringify(settingsChange)
        ? submissionRef.current
        : {
            idempotencyKey: `desktop-prompt:${crypto.randomUUID()}`,
            clientUserMessageId: crypto.randomUUID(),
            prompt: draft,
            fileMentionCommandIds,
            terminalContextReferences,
            contextAttachments,
            ...(settingsChange ? { settingsChange } : {})
          };
    submissionRef.current = submission;
    submissionInFlightRef.current = true;
    onOptimisticPrompt({
      clientUserMessageId: submission.clientUserMessageId,
      prompt: submission.prompt
    });
    void persistDraft(submission.prompt, false);
    draftRef.current = "";
    draftEditedRef.current = false;
    setDraft("");
    onContextAttachmentsChanged([]);
    setState({
      status: "sending",
      message: "Sending prompt to selected AI Client…"
    });
    try {
      const result = await api.send({
        executionId: resolvedConversation.executionId,
        capturedSessionId: resolvedConversation.capturedSessionId,
        threadId: resolvedConversation.threadId,
        idempotencyKey: submission.idempotencyKey,
        clientUserMessageId: submission.clientUserMessageId,
        prompt: submission.prompt,
        fileMentionCommandIds: submission.fileMentionCommandIds,
        terminalContextReferences: submission.terminalContextReferences,
        ...(submission.settingsChange
          ? { settingsChange: submission.settingsChange }
          : {})
      });
      setResolvedConversation(result.conversation);
      onConversationIdentityChanged(result.conversation);
      if (result.status === "rejected") {
        onRejectOptimisticPrompt(submission.clientUserMessageId);
        setDraft(submission.prompt);
        draftRef.current = submission.prompt;
        draftEditedRef.current = true;
        onContextAttachmentsChanged(submission.contextAttachments);
        submissionRef.current = null;
        submissionInFlightRef.current = false;
        setState({
          status: submission.settingsChange ? "ready" : "reconciling",
          message:
            result.message ??
            "This Conversation is not writable. The prompt was not sent."
        });
        setSettingsError(
          result.message ??
            "The prompt was not sent. Review Conversation settings and try again."
        );
        setSettingsChange(null);
        refreshSettingsOptions();
        void refreshRuntimeSnapshot(resolvedConversation.executionId);
        void api
          .usage(resolvedConversation.executionId)
          .then((result) =>
            setUsage({
              ...result,
              permissionMode: result.permissionMode ?? null
            })
          )
          .catch(() => undefined);
        return;
      }
      if (result.status === "reconciling") {
        setState({
          status: "reconciling",
          message:
            result.message ??
            "The AI Client may have accepted this prompt. Koed is reconciling it."
        });
        return;
      }
      submissionRef.current = null;
      submissionInFlightRef.current = false;
      lastSubmittedRef.current = submission;
      if (submission.settingsChange) {
        setUsage((current) =>
          current ? { ...current, ...submission.settingsChange!.next } : current
        );
      }
      setSettingsChange(null);
      setSettingsError("");
      void refreshRuntimeSnapshot(resolvedConversation.executionId);
      void persistDraft("", false);
      setState(
        startupStatus === "starting"
          ? {
              status: "starting",
              message:
                startupMessage || "Starting the AI Client in this Project…"
            }
          : { status: "ready", message: "" }
      );
    } catch {
      setState({
        status: "reconciling",
        message:
          "Koed could not confirm whether the AI Client accepted this prompt. It will not be submitted again automatically."
      });
    }
  }, [
    api,
    resolvedConversation.capturedSessionId,
    resolvedConversation.executionId,
    resolvedConversation.threadId,
    draft,
    contextAttachments,
    onContextAttachmentsChanged,
    onConversationIdentityChanged,
    onOptimisticPrompt,
    onRejectOptimisticPrompt,
    persistDraft,
    ownerSendReady,
    startupMessage,
    startupStatus,
    state.status,
    settingsChange,
    refreshSettingsOptions,
    refreshRuntimeSnapshot
  ]);

  const respondToRuntimeItem = useCallback(
    (
      item: ManagedConversationRuntimeItem,
      response: {
        decision?: "accept" | "acceptForSession" | "decline" | "cancel";
        answers?: Record<string, string[]>;
      }
    ) => {
      const executionId = resolvedConversation.executionId;
      if (!executionId || runtimeActionBusy) return;
      setRuntimeActionBusy(true);
      void api
        .respond({
          executionId,
          itemId: item.id,
          itemKind: item.itemKind as Exclude<
            ManagedConversationRuntimeItem["itemKind"],
            "transient_output"
          >,
          executionGeneration: item.executionGeneration,
          ...response
        })
        .then(() => {
          setRuntime((current) =>
            current
              ? {
                  ...current,
                  items: current.items.filter(
                    (candidate) => candidate.id !== item.id
                  )
                }
              : current
          );
          setRuntimeActionBusy(false);
        })
        .catch(() => setRuntimeActionBusy(false));
    },
    [api, resolvedConversation.executionId, runtimeActionBusy]
  );

  const controlRuntime = useCallback(
    (operation: "interrupt" | "stop") => {
      const executionId = resolvedConversation.executionId;
      if (!executionId || !runtime || runtimeActionBusy) return;
      setRuntimeActionBusy(true);
      void api[operation]({
        executionId,
        executionGeneration: runtime.executionGeneration,
        idempotencyKey: `desktop-${operation}:${crypto.randomUUID()}`
      })
        .then(() => setRuntimeActionBusy(false))
        .catch(() => setRuntimeActionBusy(false));
    },
    [api, resolvedConversation.executionId, runtime, runtimeActionBusy]
  );

  const stopDisabled =
    !runtime ||
    runtimeActionBusy ||
    ["stopping", "stopped", "failed", "fenced"].includes(
      runtime.executionState
    );
  useEffect(() => {
    const command = runtime?.latestCommand;
    if (
      command?.state !== "failed" ||
      command.lastErrorCode !== "ManagedConversationSettingsUnavailableError"
    )
      return;
    const submitted = lastSubmittedRef.current;
    if (submitted?.clientUserMessageId === command.clientUserMessageId) {
      lastSubmittedRef.current = null;
      onRejectOptimisticPrompt(submitted.clientUserMessageId);
      if (!draftRef.current) {
        setDraft(submitted.prompt);
        draftRef.current = submitted.prompt;
        draftEditedRef.current = true;
        onContextAttachmentsChanged(submitted.contextAttachments);
      }
    }
    setSettingsError(
      "The AI Client rejected these settings before receiving the prompt. Refresh its status or choose available settings, then send again."
    );
    refreshSettingsOptions();
  }, [
    runtime?.latestCommand,
    onRejectOptimisticPrompt,
    onContextAttachmentsChanged,
    refreshSettingsOptions
  ]);
  useEffect(() => {
    if (!runtime) {
      onStopControlChange(null);
      return;
    }
    onStopControlChange({
      disabled: stopDisabled,
      stop: () => controlRuntime("stop")
    });
    return () => onStopControlChange(null);
  }, [controlRuntime, onStopControlChange, runtime, stopDisabled]);

  const terminalRuntimeFailure =
    runtime?.executionState === "failed" || startupStatus === "failed";
  const inputDisabled =
    terminalRuntimeFailure ||
    !ownerSendReady ||
    !["ready", "starting", "sending"].includes(state.status);
  const sendDisabled =
    inputDisabled || state.status === "sending" || !draft.trim();
  const promptActive =
    !terminalRuntimeFailure &&
    (state.status === "sending" ||
      (["attaching", "starting", "ready"].includes(state.status) &&
        initialPrompt?.status === "queued" &&
        !runtime?.latestCommand &&
        runtime?.executionState !== "failed") ||
      (runtime?.latestCommand?.commandKind === "prompt" &&
        ["queued", "blocked", "dispatching"].includes(
          runtime.latestCommand.state
        )));
  useEffect(() => {
    onResponseActiveChange(Boolean(promptActive));
  }, [onResponseActiveChange, promptActive]);
  return (
    <div
      aria-busy={state.status === "sending"}
      className={`personal-managed-composer state-${state.status}`}
    >
      {runtime?.latestCommand?.state === "indeterminate" ? (
        <div className="personal-managed-runtime-error" role="alert">
          Koed cannot prove whether the last {runtime.latestCommand.commandKind}{" "}
          reached the AI Client. It will not retry automatically.
        </div>
      ) : (runtime?.latestCommand?.state === "failed" &&
          runtime.latestCommand.lastErrorCode !==
            "ManagedConversationSettingsUnavailableError") ||
        terminalRuntimeFailure ? (
        <div className="personal-managed-runtime-error" role="alert">
          This Conversation stopped after a runtime failure. Start a new
          Conversation from the Project to try again.
        </div>
      ) : null}
      {runtime?.items
        .filter((item) => item.itemKind !== "transient_output")
        .map((item) => (
          <ManagedRuntimeItemView
            busy={runtimeActionBusy}
            item={item}
            key={item.id}
            onRespond={(response) => respondToRuntimeItem(item, response)}
          />
        ))}
      {!terminalRuntimeFailure &&
      (state.status === "error" ||
        (state.status === "reconciling" && startupStatus === "reconciling")) ? (
        <p
          className="personal-managed-status"
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      ) : null}
      {state.status === "error" && !terminalRuntimeFailure && onRetryStartup ? (
        <button
          className="personal-managed-retry"
          onClick={onRetryStartup}
          type="button"
        >
          Retry
        </button>
      ) : null}
      <ConversationInput
        action={{
          kind: promptActive ? "interrupt" : "send",
          label: promptActive ? "Interrupt active turn" : "Send prompt",
          disabled: promptActive
            ? !runtime ||
              runtimeActionBusy ||
              runtime.executionState !== "running"
            : sendDisabled
        }}
        attachments={
          contextAttachments.length ? (
            <div
              className="personal-managed-attachments"
              aria-label="Prompt attachments"
            >
              {contextAttachments.map((attachment) => (
                <span key={`${attachment.kind}:${attachment.reference}`}>
                  <Paperclip aria-hidden="true" />
                  {attachment.label}
                  <button
                    aria-label={`Remove ${attachment.label}`}
                    onClick={() =>
                      onContextAttachmentsChanged(
                        contextAttachments.filter(
                          (candidate) => candidate !== attachment
                        )
                      )
                    }
                    type="button"
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : null
        }
        disabled={inputDisabled}
        label="Prompt selected AI Client"
        onChange={(value) => {
          setDraft(value);
          draftRef.current = value;
          draftEditedRef.current = true;
          setDraftError("");
          submissionRef.current = null;
        }}
        onSubmit={() =>
          promptActive ? controlRuntime("interrupt") : void submit()
        }
        placeholder={
          state.status === "ready" ||
          state.status === "starting" ||
          state.status === "sending"
            ? "Ask the selected AI Client to work in this Project"
            : "Prompt unavailable"
        }
        settings={{
          options: settingsOptions,
          selection: {
            instanceId:
              resolvedConversation.executionOwner?.instanceId ??
              initialSelection?.aiClientInstanceId ??
              "",
            model: selectedSettings?.model ?? usage?.model ?? "",
            reasoningEffort: selectedSettings
              ? (selectedSettings.reasoningEffort ?? "")
              : (usage?.reasoningEffort ?? ""),
            permissionMode: selectedSettings?.permissionMode ?? ""
          },
          clientLabel: usage ? managedProviderLabel(usage.provider) : undefined,
          clientProvider: usage?.provider,
          clientLocked: true,
          disabledReason: promptActive
            ? "Settings are available when this turn finishes."
            : state.status !== "ready" || transferBusy
              ? "Conversation settings are unavailable during this operation."
              : !selectedSettings
                ? "Loading Conversation settings…"
                : undefined,
          onOpen: refreshSettingsOptions,
          onChange: (selection) => {
            if (
              !selectedSettings ||
              !selection.permissionMode ||
              promptActive ||
              state.status !== "ready"
            )
              return;
            const next = {
              model: selection.model,
              reasoningEffort: selection.reasoningEffort || null,
              permissionMode: selection.permissionMode
            };
            const expected = settingsChange?.expected ?? selectedSettings;
            setSettingsChange(
              managedConversationSettingsKey(next) ===
                managedConversationSettingsKey(expected)
                ? null
                : { expected, next }
            );
            setSettingsError("");
          }
        }}
        value={draft}
      />
      {settingsError && (
        <p className="personal-managed-error" role="alert">
          {settingsError}
        </p>
      )}
      {resolvedConversation.executionId && usage ? (
        <div className="personal-managed-meta-row">
          <ManagedConversationUsage
            model={usage.model}
            provider={usage.provider}
            usage={usage.usage}
          />
          {state.status === "ready" && authorizeTransfer ? (
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
                Switch device
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
                        {device.label ??
                          `Device ${device.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={
                    transferBusy || !selectedTarget || !ownerHandoffReady
                  }
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
                  disabled={transferBusy || !selectedTarget || !ownerForkReady}
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
                {transferMessage ? (
                  <p role="status">{transferMessage}</p>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
      {!ownerSendReady && state.status === "ready" ? (
        <p role="status">
          The owning AI Client is unavailable or its capabilities need
          refreshing.
        </p>
      ) : null}
      {draftError ? (
        <p className="personal-managed-error" role="status">
          {draftError}
        </p>
      ) : null}
    </div>
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
  const [open, setOpen] = useState(false);
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
        setOpen(false);
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
    <Dialog onOpenChange={setOpen} open={open}>
      <button
        aria-label="Manage Captured Session"
        className="personal-session-manage-button"
        onClick={() => setOpen(true)}
        title="Manage Captured Session"
        type="button"
      >
        <Settings aria-hidden="true" />
      </button>
      <DialogPopup className="personal-session-assignment-dialog">
        <DialogHeader>
          <DialogTitle>Manage Captured Session</DialogTitle>
          <DialogDescription>
            Move this session to another Project.
          </DialogDescription>
        </DialogHeader>
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
          {error ? (
            <p role="alert" className="personal-memory-error">
              {error}
            </p>
          ) : null}
          <DialogFooter className="personal-session-assignment-actions">
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
            <button
              className="personal-move-button"
              disabled={busy || targets.length === 0}
              type="submit"
            >
              {busy ? "Saving…" : "Move"}
            </button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function SessionDetail({
  assignSessionProject,
  authorizeManagedConversationTransfer,
  candidates,
  managedConversationRevision,
  managedConversationRecoveryRevision,
  managedConversationUpdate,
  managedConversations,
  managedProject,
  markdownAdapters,
  onAssigned,
  onInspectEvent,
  onOpenRepository,
  onShare,
  project,
  projects,
  records,
  routeSessionId,
  store,
  suggestions,
  thread,
  pendingCanonicalConversation,
  managedDraft,
  onRetryManagedConversation
}: {
  assignSessionProject?: PersonalDesktopApi["assignSessionProject"];
  authorizeManagedConversationTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  candidates: readonly WorkspaceShareCandidate[];
  managedConversationRevision: number;
  managedConversationRecoveryRevision: number;
  managedConversationUpdate: PersonalMemoryWorkspaceProps["managedConversationUpdate"];
  managedConversations?: ManagedConversationDesktopApi | null;
  managedProject?: ManagedProjectDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
  onAssigned?: PersonalMemoryWorkspaceProps["onSessionProjectAssigned"];
  onInspectEvent?: PersonalMemoryWorkspaceProps["onInspectEvent"];
  onShare?: PersonalMemoryWorkspaceProps["onShareToWorkspace"];
  onOpenRepository?: (url: string) => void;
  project: DesktopProject;
  projects: readonly PersonalDesktopProject[];
  records: readonly PersonalMemorySharingRecord[];
  routeSessionId: string;
  store: PersonalMemoryStore;
  suggestions: readonly ProjectWorkspaceSuggestion[];
  thread: PersonalDesktopProjectThread;
  pendingCanonicalConversation: boolean;
  managedDraft: ManagedConversationDraft | null;
  onRetryManagedConversation: (() => void) | null;
}) {
  const title = thread.name || "Untitled session";
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [managedStopControl, setManagedStopControl] =
    useState<ManagedConversationStopControl | null>(null);

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
        <div className="personal-session-header-copy">
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
          {project.remoteDisplay ? (
            <ProjectRepo
              onOpenRepository={onOpenRepository}
              remoteDisplay={project.remoteDisplay}
            />
          ) : null}
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
        <div className="personal-session-header-actions">
          <ShareAffordance
            candidates={candidates}
            onShare={onShare}
            projectId={project.id}
            records={records}
            suggestions={suggestions}
            thread={thread}
          />
          <SessionAssignment
            assign={assignSessionProject}
            onAssigned={onAssigned}
            projects={projects}
            store={store}
            thread={thread}
          />
          {managedStopControl ? (
            <button
              aria-label="Stop managed Conversation"
              className="personal-session-stop-button"
              disabled={managedStopControl.disabled}
              onClick={managedStopControl.stop}
              title="Stop managed Conversation"
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      <div className="personal-conversation-host">
        <StoreConversation
          authorizeManagedConversationTransfer={
            authorizeManagedConversationTransfer
          }
          managedConversationRevision={managedConversationRevision}
          managedConversationRecoveryRevision={
            managedConversationRecoveryRevision
          }
          managedConversationUpdate={managedConversationUpdate}
          managedConversations={managedConversations}
          managedProject={managedProject}
          markdownAdapters={markdownAdapters}
          onInspectEvent={onInspectEvent}
          pendingCanonicalConversation={pendingCanonicalConversation}
          managedDraft={managedDraft}
          onRetryManagedConversation={onRetryManagedConversation}
          onStopControlChange={setManagedStopControl}
          project={project}
          routeSessionId={routeSessionId}
          store={store}
          thread={thread}
        />
      </div>
    </section>
  );
}

export type ManagedConversationDraft = {
  conversation: ManagedConversationIdentity;
  launchInput: Parameters<ManagedConversationDesktopApi["start"]>[0];
  initialPrompt?: InitialConversationPrompt;
  status: "starting" | "ready" | "failed" | "reconciling";
  message: string;
  thread: PersonalDesktopProjectThread;
};

export function PersonalMemoryWorkspace({
  assignSessionProject,
  updateSessionPresentation,
  authorizeManagedConversationTransfer,
  managedConversationRevision = 0,
  managedConversationRecoveryRevision = 0,
  managedConversationUpdate = null,
  managedConversations,
  managedConversationDrafts,
  localAiClients,
  managedProject,
  markdownAdapters,
  onInspectEvent,
  onNavigate,
  onSessionProjectAssigned,
  onShareToWorkspace,
  openExternal,
  revealLocalProject,
  projectWorkspaceSuggestions = [],
  ready = true,
  route,
  sharingRecords = [],
  setManagedConversationDrafts,
  store,
  workspaceCandidates = []
}: PersonalMemoryWorkspaceProps) {
  const [launchSelection, setLaunchSelection] =
    useState<ManagedLaunchSelection>({
      instanceId: "",
      model: "",
      reasoningEffort: "",
      permissionMode: ""
    });
  const [managedCapabilities, setManagedCapabilities] = useState<
    ReadonlyMap<string, ManagedOwnerCapabilities>
  >(new Map());
  useEffect(() => {
    if (!localAiClients) return;
    let active = true;
    const load = async () => {
      try {
        const { readModel } = await localAiClients.list();
        if (!active) return;
        const ready = (
          value: { support: string; readiness: string } | undefined
        ) => value?.support === "supported" && value.readiness === "ready";
        setManagedCapabilities(
          new Map(
            readModel.instances.map((instance) => {
              const snapshot = readModel.capabilitySnapshots.find(
                (candidate) => candidate.instanceId === instance.instanceId
              );
              const baseReady =
                instance.enabled &&
                snapshot?.stale === false &&
                Date.parse(snapshot.expiresAt) > Date.now() &&
                snapshot.authenticationState === "authenticated" &&
                snapshot.healthState === "healthy";
              return [
                managedOwnerKey(instance),
                {
                  resume:
                    baseReady && ready(snapshot?.managedConversationResume),
                  send: baseReady && ready(snapshot?.managedConversationSend),
                  handoff:
                    baseReady && ready(snapshot?.managedConversationHandoff),
                  fork: baseReady && ready(snapshot?.managedConversationFork)
                }
              ];
            })
          )
        );
      } catch {
        if (active) setManagedCapabilities(new Map());
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [localAiClients]);
  const onOpenRepository = openExternal
    ? (url: string) => void openExternal(url).catch(() => undefined)
    : undefined;
  const onRevealLocalProject = revealLocalProject
    ? (localProjectId: string) =>
        void revealLocalProject(localProjectId).catch(() => undefined)
    : undefined;
  const snapshot = usePersonalMemorySnapshot(store);
  const requestedRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [localManagedDrafts, setLocalManagedDrafts] = useState<
    ReadonlyMap<string, ManagedConversationDraft>
  >(new Map());
  const managedDrafts = managedConversationDrafts ?? localManagedDrafts;
  const setManagedDrafts =
    setManagedConversationDrafts ?? setLocalManagedDrafts;
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
  const selectedManagedDraft =
    route.kind === "session"
      ? (managedDrafts.get(route.sessionId) ??
        [...managedDrafts.values()].find(
          (draft) =>
            draft.conversation.executionId === route.sessionId ||
            draft.conversation.capturedSessionId === route.sessionId
        ) ??
        null)
      : null;
  const selectedThread =
    route.kind === "session" && selectedProject
      ? (selectedProject.threads.find(
          (thread) => sessionSelectionId(thread) === route.sessionId
        ) ??
        managedDrafts.get(route.sessionId)?.thread ??
        selectedManagedDraft?.thread ??
        null)
      : null;
  const pendingCanonicalConversation =
    selectedManagedDraft !== null && selectedManagedDraft.status !== "ready";

  useEffect(() => {
    if (!managedConversations) return;
    const pending = [...managedDrafts.entries()].filter(
      ([, draft]) =>
        draft.status === "starting" || draft.status === "reconciling"
    );
    if (pending.length === 0) return;
    let active = true;
    for (const [routeId, draft] of pending) {
      const executionId = draft.conversation.executionId;
      if (!executionId) continue;
      void managedConversations
        .inspect(executionId)
        .then((result) => {
          if (!active || result.status === "starting") return;
          if (result.status === "ready" && result.conversation) {
            store.upsertThread({
              ...draft.thread,
              id: result.conversation.threadId,
              sessionId: result.conversation.capturedSessionId
            });
          }
          setManagedDrafts((current) => {
            const existing = current.get(routeId);
            if (!existing || existing.conversation.executionId !== executionId)
              return current;
            const next = new Map(current);
            if (result.status === "ready" && result.conversation) {
              next.set(routeId, {
                ...existing,
                conversation: result.conversation,
                status: "ready",
                message: "",
                thread: {
                  ...existing.thread,
                  id: result.conversation.threadId,
                  sessionId: result.conversation.capturedSessionId
                }
              });
            } else {
              const message =
                result.message ??
                "The AI Client could not establish a writable Conversation.";
              if (
                existing.status === result.status &&
                existing.message === message
              ) {
                return current;
              }
              next.set(routeId, {
                ...existing,
                status: result.status,
                message
              });
            }
            return next;
          });
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setManagedDrafts((current) => {
            const existing = current.get(routeId);
            if (!existing || existing.conversation.executionId !== executionId)
              return current;
            const next = new Map(current);
            next.set(routeId, {
              ...existing,
              status: "failed",
              message: cause instanceof Error ? cause.message : String(cause)
            });
            return next;
          });
        });
    }
    return () => {
      active = false;
    };
  }, [managedConversationRevision, managedConversations, managedDrafts]);
  const retryManagedConversation = useCallback(
    (routeId: string) => {
      if (!managedConversations) return;
      const current = managedDrafts.get(routeId);
      if (!current) return;
      const launchInput = current.launchInput;
      setManagedDrafts((drafts) => {
        const existing = drafts.get(routeId);
        if (!existing) return drafts;
        const next = new Map(drafts);
        next.set(routeId, {
          ...existing,
          launchInput,
          status: "starting",
          message: "Starting the AI Client in this Project…"
        });
        return next;
      });
      void managedConversations
        .start(launchInput)
        .then((result) => {
          setManagedDrafts((drafts) => {
            const existing = drafts.get(routeId);
            if (!existing) return drafts;
            const conversation = result.conversation ?? {
              executionId: result.executionId,
              projectId: launchInput.projectId,
              capturedSessionId: result.executionId,
              threadId: result.executionId
            };
            const next = new Map(drafts);
            next.set(routeId, {
              ...existing,
              conversation,
              launchInput,
              status: result.status,
              message:
                result.status === "starting"
                  ? "Starting the AI Client in this Project…"
                  : "",
              thread: {
                ...existing.thread,
                id: conversation.threadId,
                sessionId: conversation.capturedSessionId
              }
            });
            return next;
          });
        })
        .catch((cause: unknown) => {
          setManagedDrafts((drafts) => {
            const existing = drafts.get(routeId);
            if (!existing) return drafts;
            const next = new Map(drafts);
            next.set(routeId, {
              ...existing,
              status: "failed",
              message: cause instanceof Error ? cause.message : String(cause)
            });
            return next;
          });
        });
    },
    [managedConversations, managedDrafts]
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
    if (!ready || requestedRef.current) return;
    requestedRef.current = true;
    void store.loadProjects();
  }, [ready, store]);

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
    const preserveComposerFocus =
      active instanceof HTMLElement &&
      Boolean(active.closest(".personal-managed-composer"));
    if (preserveComposerFocus) return;
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
    <ManagedCapabilitiesContext.Provider
      value={localAiClients ? managedCapabilities : undefined}
    >
      <div
        className={`personal-memory-workspace route-${effectiveRoute}`}
        data-responsive="master-detail-to-drilldown"
        ref={workspaceRef}
        tabIndex={-1}
      >
        <ProjectsPane
          error={snapshot.error}
          loading={!ready || snapshot.loading}
          onRetry={() => void store.loadProjects()}
          onSelect={(projectId) => onNavigate({ kind: "project", projectId })}
          projects={projects}
          selectedProjectId={selectedProject?.id ?? null}
        />
        <main className="personal-memory-detail-pane">
          {effectiveRoute === "session" && selectedProject && selectedThread ? (
            <SessionDetail
              key={selectedThread.id}
              assignSessionProject={assignSessionProject}
              authorizeManagedConversationTransfer={
                authorizeManagedConversationTransfer
              }
              candidates={workspaceCandidates}
              managedConversationRevision={managedConversationRevision}
              managedConversationRecoveryRevision={
                managedConversationRecoveryRevision
              }
              managedConversationUpdate={managedConversationUpdate}
              managedConversations={managedConversations}
              managedProject={managedProject}
              markdownAdapters={markdownAdapters}
              onAssigned={onSessionProjectAssigned}
              onInspectEvent={onInspectEvent}
              onOpenRepository={onOpenRepository}
              onShare={onShareToWorkspace}
              project={selectedProject}
              projects={projects}
              records={sharingRecords}
              routeSessionId={
                route.kind === "session"
                  ? route.sessionId
                  : sessionSelectionId(selectedThread)
              }
              store={store}
              suggestions={projectWorkspaceSuggestions}
              thread={selectedThread}
              pendingCanonicalConversation={pendingCanonicalConversation}
              managedDraft={selectedManagedDraft}
              onRetryManagedConversation={
                selectedManagedDraft && route.kind === "session"
                  ? () => retryManagedConversation(route.sessionId)
                  : null
              }
            />
          ) : (
            <ProjectDetail
              localAiClients={localAiClients}
              launchSelection={launchSelection}
              setLaunchSelection={setLaunchSelection}
              error={projects.length === 0 ? snapshot.error : null}
              hasProjects={projects.length > 0}
              loading={(!ready || snapshot.loading) && projects.length === 0}
              managedConversations={managedConversations}
              onChangeSessionPresentation={async (thread, input) => {
                if (!thread.sessionId || !updateSessionPresentation) {
                  throw new Error(
                    "Conversation navigation preferences are unavailable."
                  );
                }
                const presentation =
                  thread.presentation ??
                  defaultConversationPresentation(thread);
                await updateSessionPresentation({
                  sessionId: thread.sessionId,
                  expectedVersion: presentation.version,
                  ...input
                });
                await store.loadProjects({ silent: true });
              }}
              onManagedConversationStarted={(
                conversation,
                status,
                launchInput,
                initialPrompt
              ) => {
                if (!selectedProject) return;
                const now = new Date().toISOString();
                const routeId = conversation.executionId!;
                const draft: PersonalDesktopProjectThread = {
                  id: conversation.threadId,
                  name: "New AI Client Conversation",
                  sessionId: conversation.capturedSessionId,
                  sourceAiClient:
                    launchInput.aiClientDriverId === "claude"
                      ? "claude-code"
                      : launchInput.aiClientDriverId,
                  projectId: selectedProject.id,
                  projectName: selectedProject.name,
                  projectPath: selectedProject.path,
                  projectAssignmentSource: "user_override",
                  eventCount: 0,
                  invalidatedCount: 0,
                  latestAt: now,
                  sample: "",
                  presentation: null
                };
                if (
                  status === "ready" &&
                  conversation.capturedSessionId !== conversation.executionId
                ) {
                  store.upsertThread(draft);
                }
                setManagedDrafts((current) => {
                  const next = new Map(current);
                  next.set(routeId, {
                    conversation,
                    launchInput,
                    initialPrompt,
                    status,
                    message:
                      status === "starting"
                        ? "Starting the AI Client in this Project…"
                        : "",
                    thread: draft
                  });
                  return next;
                });
                onNavigate({
                  kind: "session",
                  projectId: selectedProject.id,
                  sessionId: routeId
                });
              }}
              onOpenRepository={onOpenRepository}
              onRevealLocalProject={onRevealLocalProject}
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
    </ManagedCapabilitiesContext.Provider>
  );
}
