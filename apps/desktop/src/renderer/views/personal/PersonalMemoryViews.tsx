import type {
  PersonalDesktopApi,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
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
  GitFork,
  LoaderCircle,
  MonitorSmartphone,
  Pencil,
  Send,
  Settings,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

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
import type { LocalAiClientReadModel } from "../../../ipc/local-ai-client-protocol.js";
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
  localAiClients?: {
    list: () => Promise<{ readModel: LocalAiClientReadModel }>;
  };
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
  localProjectId,
  onOpenRepository,
  onRevealLocalProject,
  onSelect,
  projectName,
  remoteDisplay,
  thread
}: {
  localProjectId?: string | null;
  onOpenRepository?: (url: string) => void;
  onRevealLocalProject?: (localProjectId: string) => void;
  onSelect: () => void;
  projectName: string;
  remoteDisplay?: string | null;
  thread: PersonalDesktopProjectThread;
}) {
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
      className="personal-session-row"
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
    </div>
  );
}

type ManagedConversationCapability = {
  support: "supported" | "unsupported" | "unknown";
  readiness: "ready" | "not_ready" | "unknown";
};

type ManagedConversationOwner = {
  aiClientDriverId: "codex" | "claude" | "pi";
  aiClientInstanceId: string;
  displayName: string;
  ready: boolean;
  resume: ManagedConversationCapability;
  send: ManagedConversationCapability;
  handoff: ManagedConversationCapability;
  fork: ManagedConversationCapability;
};

const capabilityReady = (capability: ManagedConversationCapability) =>
  capability.support === "supported" && capability.readiness === "ready";

const unknownManagedCapability = (): ManagedConversationCapability => ({
  support: "unknown",
  readiness: "unknown"
});

const unavailableManagedCapability = (): ManagedConversationCapability => ({
  support: "unsupported",
  readiness: "not_ready"
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

function ProjectDetail({
  error,
  hasProjects,
  loading,
  managedAiLoadError,
  managedAiReadModel,
  managedConversationOwner,
  managedConversationOwners,
  onManagedConversationOwnerChange,
  managedConversationRevision,
  managedConversations,
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
  managedAiLoadError?: string | null;
  managedAiReadModel?: LocalAiClientReadModel | null;
  managedConversationOwner?: ManagedConversationOwner;
  managedConversationOwners?: ManagedConversationOwner[];
  onManagedConversationOwnerChange?: (instanceId: string) => void;
  managedConversationRevision: number;
  managedConversations?: ManagedConversationDesktopApi | null;
  onManagedConversationStarted: (
    conversation: ManagedConversationIdentity
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
              "Selected AI Client could not establish a writable Conversation.",
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
  const threads = [...project.threads].sort(
    (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
  );
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
          managedConversationOwner={managedConversationOwner}
          managedConversationOwners={managedConversationOwners}
          onManagedConversationOwnerChange={onManagedConversationOwnerChange}
          onStart={() => {
            if (!managedConversations || !managedConversationOwner) return;
            setStartState({
              status: "starting",
              message: "",
              executionId: null
            });
            const idempotencyKey = `desktop-conversation:${crypto.randomUUID()}`;
            void managedConversations
              .start(project.id, idempotencyKey, {
                aiClientDriverId: managedConversationOwner.aiClientDriverId,
                aiClientInstanceId: managedConversationOwner.aiClientInstanceId
              })
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
                  message: "Starting AI Client Conversation in this Project…",
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
          starting={startState.status === "starting"}
          disabled={
            !managedConversations || !project.path || !managedAiReadModel
          }
        />
      </header>
      {managedAiLoadError ? (
        <p className="personal-managed-error" role="alert">
          AI Client discovery unavailable: {managedAiLoadError}
        </p>
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
        {threads.length ? (
          <div>
            {threads.map((thread) => (
              <SessionRow
                key={sessionSelectionId(thread)}
                localProjectId={project.localProjectId}
                onOpenRepository={onOpenRepository}
                onRevealLocalProject={onRevealLocalProject}
                onSelect={() => onSelectSession(sessionSelectionId(thread))}
                projectName={project.name}
                remoteDisplay={project.remoteDisplay}
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
  managedConversationOwners,
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
  managedConversationOwners?: ManagedConversationOwner[];
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
          managedConversationOwners={managedConversationOwners}
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
    provider_stopped: "AI Client stopped on the source device",
    source_sealed: "Conversation source sealed",
    source_prepared: "Conversation and workspace prepared",
    source_attested: "Source verified; waiting for the target device",
    workspace_prepared: "Workspace transferred; verifying target",
    target_verified: "Target device verified",
    lease_transferred: "Execution authority moved to the target",
    restoring: "Restoring AI Client on the target device",
    identity_verified: "Native Conversation identity verified",
    provider_created: "Independent AI Client Conversation created",
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
  managedConversationOwners,
  managedConversationRevision
}: {
  api: ManagedConversationDesktopApi;
  authorizeTransfer?: PersonalMemoryWorkspaceProps["authorizeManagedConversationTransfer"];
  conversation: ManagedConversationIdentity;
  managedConversationOwners?: ManagedConversationOwner[];
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
    message: "Confirming selected AI Client execution…"
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
      message: "Confirming selected AI Client execution…"
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
        const owner = managedConversationOwners?.find(
          (candidate) =>
            candidate.aiClientDriverId ===
              result.conversation.executionOwner?.driverId &&
            candidate.aiClientInstanceId ===
              result.conversation.executionOwner?.instanceId
        );
        const resumeUnsupported =
          managedConversationOwners !== undefined &&
          (!owner || !capabilityReady(owner.resume));
        setState(
          resumeUnsupported
            ? {
                status: "read_only",
                message:
                  "Selected AI Client does not publish Conversation resume."
              }
            : result.status === "ready"
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
    conversation.executionOwner?.driverId,
    conversation.executionOwner?.instanceId,
    managedConversationOwners,
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
    setState({
      status: "sending",
      message: "Sending prompt to selected AI Client…"
    });
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
            "AI Client may have accepted this prompt. Koed is reconciling it."
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
          "Koed could not confirm whether AI Client accepted this prompt. It will not be submitted again automatically."
      });
    }
  }, [
    api,
    resolvedConversation.capturedSessionId,
    resolvedConversation.threadId,
    draft,
    state.status
  ]);

  const executionOwner = resolvedConversation.executionOwner;
  const owner = managedConversationOwners?.find(
    (candidate) =>
      candidate.aiClientDriverId === executionOwner?.driverId &&
      candidate.aiClientInstanceId === executionOwner?.instanceId
  );
  const ownerSendReady = managedConversationOwners
    ? owner !== undefined && capabilityReady(owner.send)
    : true;
  const ownerHandoffReady = managedConversationOwners
    ? owner !== undefined && capabilityReady(owner.handoff)
    : true;
  const ownerForkReady = managedConversationOwners
    ? owner !== undefined && capabilityReady(owner.fork)
    : true;
  const disabled = state.status !== "ready" || !ownerSendReady;
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
          <span className="sr-only">Prompt selected AI Client</span>
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
                ? "Ask selected AI Client to work in this Project"
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
  managedConversationOwners,
  managedConversations,
  markdownAdapters,
  onAssigned,
  onInspectEvent,
  onOpenRepository,
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
  managedConversationOwners?: ManagedConversationOwner[];
  managedConversations?: ManagedConversationDesktopApi | null;
  markdownAdapters?: MarkdownPlatformAdapters;
  onAssigned?: PersonalMemoryWorkspaceProps["onSessionProjectAssigned"];
  onInspectEvent?: PersonalMemoryWorkspaceProps["onInspectEvent"];
  onShare?: PersonalMemoryWorkspaceProps["onShareToWorkspace"];
  onOpenRepository?: (url: string) => void;
  project: DesktopProject;
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
          managedConversationOwners={managedConversationOwners}
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
  localAiClients,
  markdownAdapters,
  onInspectEvent,
  onNavigate,
  onSessionProjectAssigned,
  onShareToWorkspace,
  openExternal,
  revealLocalProject,
  projectWorkspaceSuggestions = [],
  route,
  sharingRecords = [],
  store,
  workspaceCandidates = []
}: PersonalMemoryWorkspaceProps) {
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
    ReadonlyMap<string, PersonalDesktopProjectThread>
  >(new Map());
  const [managedAiReadModel, setManagedAiReadModel] =
    useState<LocalAiClientReadModel | null>(null);
  const [managedAiLoadError, setManagedAiLoadError] = useState<string | null>(
    null
  );
  const [selectedManagedOwner, setSelectedManagedOwner] = useState("");
  useEffect(() => {
    if (!localAiClients) return;
    let active = true;
    const load = () => {
      void localAiClients
        .list()
        .then((result) => {
          if (!active) return;
          setManagedAiReadModel(result.readModel);
          setManagedAiLoadError(null);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setManagedAiReadModel(null);
          setManagedAiLoadError(
            cause instanceof Error ? cause.message : String(cause)
          );
        });
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [localAiClients]);
  const managedConversationOwners = useMemo<ManagedConversationOwner[]>(
    () =>
      managedAiReadModel?.instances.map(
        (instance): ManagedConversationOwner => {
          const snapshot = managedAiReadModel.capabilitySnapshots.find(
            (candidate) => candidate.instanceId === instance.instanceId
          );
          const snapshotCurrent =
            snapshot !== undefined &&
            snapshot.stale === false &&
            Number.isFinite(Date.parse(snapshot.expiresAt)) &&
            Date.parse(snapshot.expiresAt) > Date.now();
          const baseReady =
            instance.enabled &&
            snapshotCurrent &&
            snapshot.authenticationState === "authenticated" &&
            snapshot.healthState === "healthy";
          const managedConversationStart =
            snapshot?.managedConversationStart ?? unknownManagedCapability();
          const resume =
            snapshot?.managedConversationResume ?? unknownManagedCapability();
          const send =
            snapshot?.managedConversationSend ?? unknownManagedCapability();
          const handoff =
            snapshot?.managedConversationHandoff ?? unknownManagedCapability();
          const fork =
            snapshot?.managedConversationFork ?? unknownManagedCapability();
          return {
            aiClientDriverId: instance.driverId,
            aiClientInstanceId: instance.instanceId,
            displayName: instance.displayName,
            ready:
              baseReady &&
              instance.driverId !== "pi" &&
              capabilityReady(managedConversationStart),
            resume: baseReady ? resume : unavailableManagedCapability(),
            send: baseReady ? send : unavailableManagedCapability(),
            handoff: baseReady ? handoff : unavailableManagedCapability(),
            fork: baseReady ? fork : unavailableManagedCapability()
          };
        }
      ) ?? [],
    [managedAiReadModel]
  );
  const managedConversationOwner = managedConversationOwners.find(
    (owner) => owner.aiClientInstanceId === selectedManagedOwner
  );
  useEffect(() => {
    if (managedConversationOwners.length === 0) return;
    setSelectedManagedOwner((current) => {
      const currentOwner = managedConversationOwners.find(
        (owner) => owner.aiClientInstanceId === current
      );
      if (currentOwner?.ready) return current;
      const fallback = managedConversationOwners.find((owner) => owner.ready);
      return fallback ? fallback.aiClientInstanceId : current;
    });
  }, [managedConversationOwners]);
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
            key={selectedThread.id}
            assignSessionProject={assignSessionProject}
            authorizeManagedConversationTransfer={
              authorizeManagedConversationTransfer
            }
            candidates={workspaceCandidates}
            managedConversationRevision={managedConversationRevision}
            managedConversationOwners={
              localAiClients ? managedConversationOwners : undefined
            }
            managedConversations={managedConversations}
            markdownAdapters={markdownAdapters}
            onAssigned={onSessionProjectAssigned}
            onInspectEvent={onInspectEvent}
            onOpenRepository={onOpenRepository}
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
            hasProjects={projects.length > 0}
            loading={snapshot.loading && projects.length === 0}
            managedAiLoadError={managedAiLoadError}
            managedAiReadModel={managedAiReadModel}
            managedConversationRevision={managedConversationRevision}
            managedConversationOwner={managedConversationOwner}
            managedConversationOwners={
              localAiClients ? managedConversationOwners : undefined
            }
            onManagedConversationOwnerChange={setSelectedManagedOwner}
            managedConversations={managedConversations}
            onManagedConversationStarted={(conversation) => {
              if (!selectedProject) return;
              const now = new Date().toISOString();
              const draft: PersonalDesktopProjectThread = {
                id: conversation.threadId,
                name: "New AI Client Conversation",
                sessionId: conversation.capturedSessionId,
                sourceAiClient:
                  conversation.executionOwner?.driverId === "claude"
                    ? "claude-code"
                    : conversation.executionOwner?.driverId === "pi"
                      ? "pi"
                      : "codex",
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
  );
}
