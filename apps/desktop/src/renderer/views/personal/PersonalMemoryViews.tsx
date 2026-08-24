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
  Gauge,
  GitFork,
  LoaderCircle,
  MonitorSmartphone,
  Paperclip,
  Pencil,
  Pin,
  RefreshCw,
  Send,
  Settings,
  Square,
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
import { usePersonalMemoryDetail } from "./use-personal-memory-detail.js";
import type {
  ManagedConversationContextUsage,
  ManagedConversationDesktopApi,
  ManagedConversationIdentity,
  ManagedConversationLaunchOptions,
  ManagedConversationRuntimeItem
} from "../../../ipc/managed-conversation-protocol.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { ManagedWorkspaceDesktopApi } from "../../../ipc/managed-workspace-protocol.js";
import { ManagedWorkspaceCockpit } from "./ManagedWorkspaceCockpit.js";
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
  updateSessionPresentation?: PersonalDesktopApi["updateSessionPresentation"];
  managedConversationRevision?: number;
  managedConversationRecoveryRevision?: number;
  managedConversationUpdate?: {
    revision: number;
    update: ManagedConversationRealtimeUpdate;
  } | null;
  managedConversations?: ManagedConversationDesktopApi | null;
  localAiClients?: DesktopApi["localAiClients"];
  managedWorkspace?: ManagedWorkspaceDesktopApi | null;
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

const usageAccuracyLabel = (
  accuracy: ManagedConversationContextUsage["usageAccuracy"]
): string => {
  if (accuracy === "local_estimate") return "Estimated";
  if (accuracy === "provider_partial") return "Partial provider data";
  if (accuracy === "provider_replayed") return "Provider replay";
  return "Provider reported";
};

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
  onOpenRepository,
  remoteDisplay,
  sessionCount
}: {
  eventCount: number;
  onOpenRepository?: (url: string) => void;
  remoteDisplay?: string | null;
  sessionCount: number;
}) {
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

// Official brand mark, reproduced from simple-icons (CC0): claude.svg
function ClaudeSourceLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

// Official brand mark, reproduced from simple-icons (CC0): openai.svg — Codex is an OpenAI product.
function CodexSourceLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

// Pi's own logo mark, scaled from its 800x800 source viewBox to this
// component's shared 24x24 badge viewBox (scale factor 0.03).
function PiSourceLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        d="M4.959 4.959H15.521V12H12V15.521H8.480V19.042H4.959Z
           M8.480 8.480V12H12V8.480Z"
      />
      <path d="M15.521 12H19.042V19.042H15.521Z" />
    </svg>
  );
}

const aiClientSourceLogos: Record<"claude" | "codex" | "pi", () => ReactNode> =
  {
    claude: ClaudeSourceLogo,
    codex: CodexSourceLogo,
    pi: PiSourceLogo
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
  const Logo = aiClientSourceLogos[id];
  return (
    <span
      aria-label={ariaLabel}
      className="personal-memory-mark personal-ai-client-mark"
      data-client={id}
      role="img"
      title={title}
    >
      <Logo />
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
  const active = filtered.filter((project) => projectIsActive(project));
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
  busy,
  onChangePresentation,
  presentationStatus,
  localProjectId,
  onOpenRepository,
  onRevealLocalProject,
  onSelect,
  projectName,
  remoteDisplay,
  thread
}: {
  busy: boolean;
  presentationStatus: ConversationPresentationStatus;
  onChangePresentation: (
    input: Omit<
      Parameters<PersonalDesktopApi["updateSessionPresentation"]>[0],
      "sessionId" | "expectedVersion"
    >
  ) => void;
  localProjectId?: string | null;
  onOpenRepository?: (url: string) => void;
  onRevealLocalProject?: (localProjectId: string) => void;
  onSelect: () => void;
  projectName: string;
  remoteDisplay?: string | null;
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
  const repository = remoteDisplay
    ? repositoryPresentationFromRemoteDisplay(remoteDisplay)
    : null;
  const RepositoryIcon = repository?.provider === "github" ? Github : GitFork;
  const repositoryActionLabel = repository
    ? repository.provider === "github"
      ? `Open ${repository.label} on GitHub`
      : `Open repository ${repository.label}`
    : null;
  const revealLabel = `Reveal ${projectName} in file browser`;
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
      {(localProjectId && onRevealLocalProject) ||
      (repository && repositoryActionLabel && onOpenRepository) ? (
        <span className="personal-session-links">
          {localProjectId && onRevealLocalProject ? (
            <button
              aria-label={revealLabel}
              className="personal-session-link"
              data-tooltip={revealLabel}
              onClick={() => onRevealLocalProject(localProjectId)}
              type="button"
            >
              <Folder aria-hidden="true" />
            </button>
          ) : null}
          {repository && repositoryActionLabel && onOpenRepository ? (
            <button
              aria-label={repositoryActionLabel}
              className="personal-session-link"
              data-repository-provider={repository.provider}
              data-tooltip={repositoryActionLabel}
              onClick={() => onOpenRepository(repository.url)}
              type="button"
            >
              <RepositoryIcon aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ) : null}
      {thread.sessionId ? (
        <details className="personal-session-actions" ref={actionsRef}>
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
            <button
              disabled={busy || presentation.displayMode === "automatic"}
              onClick={() => changePresentation({ displayMode: "automatic" })}
              role="menuitem"
              type="button"
            >
              <RefreshCw aria-hidden="true" />
              Automatic
            </button>
            <button
              disabled={busy || presentation.displayMode === "active"}
              onClick={() => changePresentation({ displayMode: "active" })}
              role="menuitem"
              type="button"
            >
              <CirclePlay aria-hidden="true" />
              Keep active
            </button>
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

type ManagedLaunchSelection = {
  instanceId: string;
  model: string;
  reasoningEffort: string;
  permissionMode: "" | "supervised" | "auto_edit" | "auto" | "full_access";
};
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

function NewConversationButton({
  disabled,
  managedConversationOwner,
  managedConversationOwners,
  onManagedConversationOwnerChange,
  onStart,
  starting
}: {
  disabled: boolean;
  managedConversationOwner?: ManagedConversationOwner;
  managedConversationOwners?: ManagedConversationOwner[];
  onManagedConversationOwnerChange?: (instanceId: string) => void;
  onStart: () => void;
  starting: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const owners = managedConversationOwners ?? [];
  const pickerDisabled = disabled || !owners.some((owner) => owner.ready);
  return (
    <div className="personal-new-conversation-group" data-starting={starting}>
      <button
        className="personal-new-conversation"
        disabled={disabled || !managedConversationOwner?.ready || starting}
        onClick={onStart}
        type="button"
      >
        {starting ? <LoaderCircle aria-hidden="true" /> : null}
        {starting ? "Starting Conversation…" : "New"}
      </button>
      {pickerDisabled ? (
        <button
          aria-label="No AI Client available for a new session"
          className="personal-new-conversation-owner-picker"
          disabled
          type="button"
        >
          <ChevronDown aria-hidden="true" />
        </button>
      ) : (
        <details
          className="personal-new-conversation-owner-picker"
          ref={detailsRef}
        >
          <summary
            aria-label={
              managedConversationOwner
                ? `New session AI Client: ${managedConversationOwner.displayName}. Change AI Client.`
                : "Choose the AI Client for new sessions"
            }
          >
            {managedConversationOwner ? (
              <AiClientMark
                ariaLabel={managedConversationOwner.displayName}
                id={managedConversationOwner.aiClientDriverId}
                title={managedConversationOwner.displayName}
              />
            ) : null}
            <ChevronDown aria-hidden="true" />
          </summary>
          <ul aria-label="Available AI Clients" role="menu">
            {owners.map((owner) => (
              <li key={owner.aiClientInstanceId} role="none">
                <button
                  aria-checked={
                    owner.aiClientInstanceId ===
                    managedConversationOwner?.aiClientInstanceId
                  }
                  className="personal-new-conversation-owner-option"
                  disabled={!owner.ready}
                  onClick={() => {
                    onManagedConversationOwnerChange?.(
                      owner.aiClientInstanceId
                    );
                    if (detailsRef.current) detailsRef.current.open = false;
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <AiClientMark
                    ariaLabel={
                      owner.ready
                        ? owner.displayName
                        : `${owner.displayName} (unavailable)`
                    }
                    id={owner.aiClientDriverId}
                    title={owner.displayName}
                  />
                  <span>{owner.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const launchSelectionForInstance = (
  options: ManagedConversationLaunchOptions,
  instanceId: string
) => {
  const instance = options.instances.find(
    (candidate) => candidate.instanceId === instanceId
  );
  const model =
    instance?.models.find((candidate) => candidate.isDefault) ??
    instance?.models[0];
  const supportedModes =
    instance?.capabilities.permissionModes.filter(
      (mode) => mode.support === "supported"
    ) ?? [];
  const defaultMode: "" | "supervised" | "auto_edit" | "auto" | "full_access" =
    supportedModes.some(
      (mode) => mode.mode === instance?.capabilities.defaultPermissionMode
    )
      ? instance!.capabilities.defaultPermissionMode
      : (supportedModes[0]?.mode ?? "");
  return {
    instanceId,
    model: model?.id ?? "",
    reasoningEffort:
      model?.defaultReasoningEffort ??
      model?.supportedReasoningEfforts[0] ??
      "",
    permissionMode: defaultMode
  };
};

function ProjectDetail({
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
    launchInput: Parameters<ManagedConversationDesktopApi["start"]>[0]
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
  }, [project?.id]);
  useEffect(() => {
    if (!managedConversations || !project?.id) return;
    let active = true;
    void managedConversations
      .launchOptions()
      .then(({ options }) => {
        if (!active) return;
        setLaunchOptions(options);
        setLaunchSelection((current) => {
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
  }, [managedConversations, project?.id, setLaunchSelection]);
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
  const selectedInstance = launchOptions?.instances.find(
    (instance) => instance.instanceId === launchSelection.instanceId
  );
  const selectedModel = selectedInstance?.models.find(
    (model) => model.id === launchSelection.model
  );

  const renderSession = (thread: PersonalDesktopProjectThread) => {
    const selectionId = sessionSelectionId(thread);
    return (
      <SessionRow
        busy={presentationBusy.has(selectionId)}
        key={selectionId}
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
        localProjectId={project.localProjectId}
        onOpenRepository={onOpenRepository}
        onRevealLocalProject={onRevealLocalProject}
        projectName={project.name}
        remoteDisplay={project.remoteDisplay}
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
  const startConversation = () => {
    if (
      !managedConversations ||
      !selectedInstance ||
      !selectedModel ||
      !launchSelection.permissionMode
    ) {
      return;
    }
    setStartState({
      status: "starting",
      message: "",
      executionId: null
    });
    const launchInput = {
      projectId: project.id,
      aiClientDriverId: selectedInstance.driverId,
      aiClientInstanceId: selectedInstance.instanceId,
      model: selectedModel.id,
      reasoningEffort: launchSelection.reasoningEffort || null,
      permissionMode: launchSelection.permissionMode,
      runnerKind: "local_device",
      idempotencyKey: `desktop-conversation:${crypto.randomUUID()}`
    } satisfies Parameters<ManagedConversationDesktopApi["start"]>[0];
    void managedConversations
      .start(launchInput)
      .then((result) => {
        setLaunchOpen(false);
        setStartState({
          status: "idle",
          message: "",
          executionId: null
        });
        onManagedConversationStarted(
          result.conversation ?? {
            executionId: result.executionId,
            projectId: project.id,
            capturedSessionId: result.executionId,
            threadId: result.executionId
          },
          result.status,
          launchInput
        );
      })
      .catch((cause: unknown) => {
        setStartState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
          executionId: null
        });
      });
  };
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
            onOpenRepository={onOpenRepository}
            remoteDisplay={project.remoteDisplay}
            sessionCount={project.threads.length}
          />
        </div>
        <NewConversationButton
          disabled={!managedConversations || !project.path || !launchOptions}
          managedConversationOwner={launchOptions?.instances
            .map(launchOwner)
            .find(
              (owner) => owner.aiClientInstanceId === launchSelection.instanceId
            )}
          managedConversationOwners={launchOptions?.instances.map(launchOwner)}
          onManagedConversationOwnerChange={(instanceId) => {
            if (launchOptions)
              setLaunchSelection(
                launchSelectionForInstance(launchOptions, instanceId)
              );
          }}
          onStart={startConversation}
          starting={startState.status === "starting"}
        />
        <button
          aria-label="Conversation launch settings"
          disabled={!launchOptions}
          onClick={() => setLaunchOpen((open) => !open)}
          type="button"
        >
          <Settings aria-hidden="true" />
        </button>
      </header>
      {launchOpen && launchOptions ? (
        <form
          className="personal-managed-launch"
          onSubmit={(event) => {
            event.preventDefault();
            startConversation();
          }}
        >
          <label>
            <span>Model</span>
            <select
              disabled={!selectedInstance}
              onChange={(event) => {
                const modelId = event.currentTarget.value;
                const model = selectedInstance?.models.find(
                  (candidate) => candidate.id === modelId
                );
                setLaunchSelection((current) => ({
                  ...current,
                  model: modelId,
                  reasoningEffort:
                    model?.defaultReasoningEffort ??
                    model?.supportedReasoningEfforts[0] ??
                    ""
                }));
              }}
              value={launchSelection.model}
            >
              {selectedInstance?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName ?? model.id}
                </option>
              ))}
            </select>
          </label>
          {selectedModel?.supportedReasoningEfforts.length ? (
            <label>
              <span>Reasoning</span>
              <select
                onChange={(event) => {
                  const reasoningEffort = event.currentTarget.value;
                  setLaunchSelection((current) => ({
                    ...current,
                    reasoningEffort
                  }));
                }}
                value={launchSelection.reasoningEffort}
              >
                {selectedModel.supportedReasoningEfforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>Permissions</span>
            <select
              disabled={!selectedInstance}
              onChange={(event) => {
                const permissionMode = event.currentTarget
                  .value as typeof launchSelection.permissionMode;
                setLaunchSelection((current) => ({
                  ...current,
                  permissionMode
                }));
              }}
              value={launchSelection.permissionMode}
            >
              {selectedInstance?.capabilities.permissionModes
                .filter((mode) => mode.support === "supported")
                .map((mode) => (
                  <option key={mode.mode} value={mode.mode}>
                    {
                      {
                        supervised: "Supervised",
                        auto_edit: "Auto-accept edits",
                        auto: "Auto",
                        full_access: "Full access"
                      }[mode.mode]
                    }
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>Runner</span>
            <select disabled value="local_device">
              {launchOptions.runners.map((runner) => (
                <option key={runner.deviceId} value={runner.kind}>
                  {runner.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={
              !selectedInstance ||
              !selectedModel ||
              !launchSelection.permissionMode ||
              startState.status === "starting"
            }
            type="submit"
          >
            <CirclePlay aria-hidden="true" />
            Start Conversation
          </button>
        </form>
      ) : null}
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
            {active.map((thread) => renderSessionTree(thread))}
            {inactive.length ? (
              <details className="personal-settled-sessions">
                <summary>
                  <span>Settled &amp; snoozed</span>
                  <span>{inactive.length}</span>
                </summary>
                {inactive.map((thread) => renderSessionTree(thread))}
              </details>
            ) : null}
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
  managedConversationRecoveryRevision,
  managedConversationUpdate,
  managedConversations,
  managedWorkspace,
  markdownAdapters,
  pendingCanonicalConversation,
  managedDraft,
  onRetryManagedConversation,
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
  managedWorkspace?: ManagedWorkspaceDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
  pendingCanonicalConversation: boolean;
  managedDraft: ManagedConversationDraft | null;
  onRetryManagedConversation: (() => void) | null;
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
  >([]);
  const [transientAssistantOutputs, setTransientAssistantOutputs] = useState<
    PersonalDesktopConversationEvent[]
  >([]);
  const [workspaceIdentity, setWorkspaceIdentity] = useState<{
    executionId: string;
    executionGeneration: number;
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
  useEffect(() => {
    setOptimisticPrompts([]);
    setTransientAssistantOutputs([]);
  }, [routeSessionId]);
  const overlayEvents = [
    ...unreconciledOptimisticPrompts.map(({ event }) => event),
    ...unreconciledTransientOutputs
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
        {managedWorkspace && workspaceIdentity ? (
          <ManagedWorkspaceCockpit
            api={managedWorkspace}
            identity={workspaceIdentity}
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
          startupStatus={managedDraft?.status ?? null}
          startupMessage={managedDraft?.message ?? ""}
          onRetryStartup={onRetryManagedConversation}
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
          onTransientOutputs={mergeTransientOutputs}
          onConversationIdentityChanged={setCanonicalConversation}
          onWorkspaceIdentityChanged={setWorkspaceIdentity}
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
  provider,
  usage
}: {
  provider: "codex" | "claude" | "pi" | null;
  usage: ManagedConversationContextUsage | null;
}) {
  const providerLabel = managedProviderLabel(provider);
  if (!usage || usage.usedTokens === null) {
    return (
      <div className="personal-managed-usage is-unavailable" role="status">
        <Gauge aria-hidden="true" />
        <span>{providerLabel}</span>
        <span aria-hidden="true">·</span>
        <span>Context usage unavailable</span>
      </div>
    );
  }
  const percentage =
    usage.modelContextWindow && usage.modelContextWindow > 0
      ? Math.min(100, (usage.usedTokens / usage.modelContextWindow) * 100)
      : null;
  const contextLabel = usage.modelContextWindow
    ? `${compactTokenCount(usage.usedTokens)} / ${compactTokenCount(
        usage.modelContextWindow
      )} context`
    : `${compactTokenCount(usage.usedTokens)} context tokens`;
  const details = [
    usage.inputTokens !== null
      ? `Input ${compactTokenCount(usage.inputTokens)}`
      : null,
    usage.cachedInputTokens !== null
      ? `Cached ${compactTokenCount(usage.cachedInputTokens)}`
      : null,
    usage.outputTokens !== null
      ? `Output ${compactTokenCount(usage.outputTokens)}`
      : null,
    usage.totalProcessedTokens !== null
      ? `${compactTokenCount(usage.totalProcessedTokens)} processed`
      : null
  ]
    .filter((value): value is string => value !== null)
    .join("; ");
  return (
    <div
      className="personal-managed-usage"
      title={`${usageAccuracyLabel(usage.usageAccuracy)}. ${details}`}
    >
      <Gauge aria-hidden="true" />
      <span>{providerLabel}</span>
      {usage.model ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="personal-managed-usage-model">{usage.model}</span>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <span className="personal-managed-usage-count">{contextLabel}</span>
      <span aria-hidden="true">·</span>
      <span>{usageAccuracyLabel(usage.usageAccuracy)}</span>
      {usage.totalProcessedTokens !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="personal-managed-usage-processed">
            {compactTokenCount(usage.totalProcessedTokens)} processed
          </span>
        </>
      ) : null}
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
  startupMessage,
  startupStatus,
  onRetryStartup,
  managedConversationRecoveryRevision,
  managedConversationUpdate,
  contextAttachments,
  onContextAttachmentsChanged,
  onOptimisticPrompt,
  onRejectOptimisticPrompt,
  onTransientOutputs,
  onConversationIdentityChanged,
  onWorkspaceIdentityChanged
}: {
  api: ManagedConversationDesktopApi;
  authorizeTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  conversation: ManagedConversationIdentity;
  draftScopeId: string | null;
  startupMessage: string;
  startupStatus: ManagedConversationDraft["status"] | null;
  onRetryStartup: (() => void) | null;
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
  onTransientOutputs: (
    items: ManagedConversationRuntimeItem[],
    command: ManagedConversationRuntimeState["latestCommand"]
  ) => void;
  onConversationIdentityChanged: (
    conversation: ManagedConversationIdentity
  ) => void;
  onWorkspaceIdentityChanged: (
    value: { executionId: string; executionGeneration: number } | null
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
    provider: "codex" | "claude" | "pi" | null;
    usage: ManagedConversationContextUsage | null;
  } | null>(null);
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
    contextAttachments: Array<
      | { kind: "file"; reference: string; label: string }
      | { kind: "terminal"; reference: string; label: string }
    >;
  } | null>(null);
  const submissionInFlightRef = useRef(false);
  const composingRef = useRef(false);
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
          setDraft(result.value);
          draftRef.current = result.value;
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
  }, [api, draftScope, draftScopeKey]);

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
          setUsage({ provider: result.provider, usage: result.usage });
        }
      })
      .catch(() => {
        if (active) setUsage({ provider: null, usage: null });
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
    onWorkspaceIdentityChanged(
      resolvedConversation.executionId && runtime
        ? {
            executionId: resolvedConversation.executionId,
            executionGeneration: runtime.executionGeneration
          }
        : null
    );
    return () => onWorkspaceIdentityChanged(null);
  }, [onWorkspaceIdentityChanged, resolvedConversation.executionId, runtime]);

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
    startupStatus
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
        JSON.stringify(terminalContextReferences)
        ? submissionRef.current
        : {
            idempotencyKey: `desktop-prompt:${crypto.randomUUID()}`,
            clientUserMessageId: crypto.randomUUID(),
            prompt: draft,
            fileMentionCommandIds,
            terminalContextReferences,
            contextAttachments
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
        terminalContextReferences: submission.terminalContextReferences
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
          status: "reconciling",
          message:
            result.message ??
            "This Conversation is not writable. The prompt was not sent."
        });
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
    state.status
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

  const inputDisabled =
    !ownerSendReady || !["ready", "starting", "sending"].includes(state.status);
  const sendDisabled =
    inputDisabled || state.status === "sending" || !draft.trim();
  const promptActive =
    state.status === "sending" ||
    (runtime?.latestCommand?.commandKind === "prompt" &&
      ["queued", "blocked", "dispatching"].includes(
        runtime.latestCommand.state
      ));
  return (
    <div
      aria-busy={state.status === "sending"}
      className={`personal-managed-composer state-${state.status}`}
    >
      {resolvedConversation.executionId && usage ? (
        <ManagedConversationUsage
          provider={usage.provider}
          usage={usage.usage}
        />
      ) : null}
      {runtime ? (
        <div className="personal-managed-runtime-controls">
          <button
            aria-label="Interrupt active turn"
            disabled={runtimeActionBusy || runtime.executionState !== "running"}
            onClick={() => controlRuntime("interrupt")}
            title="Interrupt active turn"
            type="button"
          >
            <Square aria-hidden="true" />
          </button>
          <button
            aria-label="Stop managed Conversation"
            disabled={
              runtimeActionBusy ||
              ["stopping", "stopped", "failed", "fenced"].includes(
                runtime.executionState
              )
            }
            onClick={() => controlRuntime("stop")}
            title="Stop managed Conversation"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {promptActive ? (
        <div className="personal-managed-working" role="status">
          <LoaderCircle aria-hidden="true" />
          <span>The AI Client is working</span>
        </div>
      ) : null}
      {runtime?.latestCommand?.state === "indeterminate" ? (
        <div className="personal-managed-runtime-error" role="alert">
          Koed cannot prove whether the last {runtime.latestCommand.commandKind}{" "}
          reached the AI Client. It will not retry automatically.
        </div>
      ) : runtime?.latestCommand?.state === "failed" ||
        runtime?.executionState === "failed" ? (
        <div className="personal-managed-runtime-error" role="alert">
          The managed Conversation stopped after a runtime failure.
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
      {contextAttachments.length ? (
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
      ) : null}
      {state.status === "starting" ||
      state.status === "error" ||
      (state.status === "reconciling" && startupStatus === "reconciling") ? (
        <p
          className="personal-managed-status"
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      ) : null}
      {state.status === "error" && onRetryStartup ? (
        <button
          className="personal-managed-retry"
          onClick={onRetryStartup}
          type="button"
        >
          Retry
        </button>
      ) : null}
      <div className="personal-managed-composer-field">
        <label>
          <span className="sr-only">Prompt selected AI Client</span>
          <textarea
            disabled={inputDisabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft(value);
              draftRef.current = value;
              draftEditedRef.current = true;
              setDraftError("");
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
              state.status === "ready" ||
              state.status === "starting" ||
              state.status === "sending"
                ? "Ask the selected AI Client to work in this Project"
                : "Prompt unavailable"
            }
            rows={1}
            value={draft}
          />
        </label>
        <button
          aria-label="Send prompt"
          disabled={sendDisabled}
          onClick={() => void submit()}
          type="button"
        >
          {state.status === "sending" ? (
            <LoaderCircle aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
        </button>
      </div>
      {!ownerSendReady && state.status === "ready" ? (
        <p role="status">
          The owning AI Client is unavailable or its capabilities need
          refreshing.
        </p>
      ) : null}
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
              disabled={transferBusy || !selectedTarget || !ownerHandoffReady}
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
            {transferMessage ? <p role="status">{transferMessage}</p> : null}
          </div>
        </details>
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
  managedWorkspace,
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
  managedWorkspace?: ManagedWorkspaceDesktopApi | null;
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
          managedWorkspace={managedWorkspace}
          markdownAdapters={markdownAdapters}
          onInspectEvent={onInspectEvent}
          pendingCanonicalConversation={pendingCanonicalConversation}
          managedDraft={managedDraft}
          onRetryManagedConversation={onRetryManagedConversation}
          project={project}
          routeSessionId={routeSessionId}
          store={store}
          thread={thread}
        />
      </div>
    </section>
  );
}

type ManagedConversationDraft = {
  conversation: ManagedConversationIdentity;
  launchInput: Parameters<ManagedConversationDesktopApi["start"]>[0];
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
  localAiClients,
  managedWorkspace,
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
  const [managedDrafts, setManagedDrafts] = useState<
    ReadonlyMap<string, ManagedConversationDraft>
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
        managedDrafts.get(route.sessionId)?.thread ??
        null)
      : null;
  const selectedManagedDraft =
    route.kind === "session"
      ? (managedDrafts.get(route.sessionId) ?? null)
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
      const launchInput = {
        ...current.launchInput,
        idempotencyKey: `desktop-conversation:${crypto.randomUUID()}`
      };
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
              managedWorkspace={managedWorkspace}
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
                launchInput
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
