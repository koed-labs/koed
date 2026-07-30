import {
  type CollaborationInvitation,
  type CollaborationSelection,
  type CollaborationSnapshot,
  type CollaborationTeamPerson,
  type CollaborationThread,
  type PersonalMemoryEntry,
  type SharedMemoryGrant,
  type SharedMemoryPreview,
  type SharedMemoryRepresentation,
  type SharedMemorySession,
  type SharedMemorySourceItem,
  type SharedMemorySourcePage,
  TEAM_ACTIVITY_WRITE_THROTTLE_MS,
  coarsePresenceFromTeamPresence,
  deriveTeamPresenceSnapshot
} from "@koed/shared/collaboration";
import {
  LcmSummaryFrame,
  MemoryEventFrame,
  MemorySourceParts,
  VirtualizedTimeline,
  type MarkdownPlatformAdapters
} from "@koed/memory-ui";
import { Dialog, DialogPopup } from "@koed/ui";
import {
  Archive,
  BellOff,
  BookOpen,
  Check,
  Clipboard,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CloudOff,
  FileText,
  FolderKanban,
  Library,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageCircle,
  MessageSquare,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  ToolCase,
  Umbrella,
  UserPlus,
  UsersRound,
  X
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import {
  CollaborationClientError,
  type CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import {
  MessageComposer as RouteMessageComposer,
  ThreadRoute,
  ThreadTimeline as RouteThreadTimeline,
  draftAuthorityForThread,
  type CollaborationDrafts
} from "./ThreadRoute.js";
import { createRendererPlatform } from "../services/platform.js";
import { type DraftAuthority } from "../state/drafts.js";
import "../../collaboration.css";

export type CollaborationModalState =
  | { kind: "create_or_join" }
  | { kind: "create_team" }
  | { kind: "join_team" }
  | { kind: "personal_channel" }
  | { kind: "edit_personal_channel"; threadId: string }
  | {
      kind: "edit_workspace_channel";
      teamId: string;
      workspaceId: string;
      threadId: string;
    }
  | { kind: "workspace_channel"; teamId: string; workspaceId: string }
  | { kind: "direct_message"; teamId: string; group: boolean }
  | { kind: "share_personal_memory"; sessionId: string }
  | { kind: "connection" };

export const modalIsAuthorized = (
  modal: CollaborationModalState,
  snapshot: CollaborationSnapshot,
  localPersonalSessionIds: ReadonlySet<string>
): boolean => {
  if (modal.kind === "edit_personal_channel") {
    return snapshot.navigation.personal.channels.some(
      (thread) => thread.id === modal.threadId
    );
  }
  if (modal.kind === "edit_workspace_channel") {
    const team = snapshot.navigation.teams.find(
      (candidate) =>
        candidate.id === modal.teamId && candidate.lifecycle === "active"
    );
    return Boolean(
      team?.workspaces.some(
        (workspace) =>
          workspace.id === modal.workspaceId &&
          workspace.lifecycle === "active" &&
          workspace.access === "write" &&
          workspace.channels.some(
            (thread) =>
              thread.id === modal.threadId && thread.lifecycle === "active"
          )
      )
    );
  }
  if (modal.kind === "share_personal_memory") {
    return (
      localPersonalSessionIds.has(modal.sessionId) ||
      snapshot.navigation.personal.memory.some(
        (entry) => entry.id === modal.sessionId
      )
    );
  }
  if (modal.kind === "workspace_channel") {
    const team = snapshot.navigation.teams.find(
      (candidate) =>
        candidate.id === modal.teamId && candidate.lifecycle === "active"
    );
    return Boolean(
      team?.workspaces.some(
        (workspace) =>
          workspace.id === modal.workspaceId &&
          workspace.lifecycle === "active" &&
          workspace.access === "write"
      )
    );
  }
  if (modal.kind === "direct_message") {
    return snapshot.navigation.teams.some(
      (team) => team.id === modal.teamId && team.lifecycle === "active"
    );
  }
  return true;
};

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
};

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
};

const normalizedText = (value: string): string => value.normalize("NFC").trim();
const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;
const codePointLength = (value: string): number =>
  [...value.normalize("NFC")].length;

class CollaborationInputError extends Error {}

const failureMessage = (cause: unknown, fallback: string): string =>
  cause instanceof CollaborationClientError
    ? cause.userMessage
    : cause instanceof CollaborationInputError
      ? cause.message
      : fallback;

const selectionTeamId = (selection: CollaborationSelection): string | null =>
  "teamId" in selection ? selection.teamId : null;

const threadTitle = (
  thread: CollaborationThread,
  currentUserId: string
): string => {
  if (thread.kind === "notes_to_self") return "Notes to self";
  if (thread.name) return thread.name;
  if (thread.kind === "dm" || thread.kind === "group_dm") {
    const names = thread.participants
      .filter((person) => person.id !== currentUserId)
      .map((person) => person.displayName);
    return names.join(", ") || "Direct message";
  }
  return "Discussion";
};

const teamPrincipalId = (snapshot: CollaborationSnapshot): string => {
  const principal = snapshot.navigation.teamPrincipal;
  if (!principal) {
    throw new Error("Team state requires an enrolled remote principal.");
  }
  return principal.id;
};

const principalIdForThread = (
  snapshot: CollaborationSnapshot,
  thread: CollaborationThread
): string =>
  thread.scope === "personal"
    ? snapshot.navigation.personalOwner.id
    : teamPrincipalId(snapshot);

const representationLabel = (value: SharedMemoryRepresentation): string => {
  if (value === "memory_events") return "Memory Events";
  if (value === "lcm_leaves") return "LCM leaves";
  return "LCM rollups";
};

const liveStateLabel = (value: SharedMemorySession["liveState"]): string =>
  value === "live"
    ? "Live"
    : value === "reconnecting"
      ? "Reconnecting"
      : "Ended";

const representationStateLabel = (
  value: SharedMemorySession["representationState"]
): string =>
  value === "current"
    ? "Current"
    : value === "pending"
      ? "Preparing"
      : value === "stale"
        ? "Update pending"
        : "Unavailable";

function Modal({
  children,
  label,
  onClose
}: {
  children: ReactNode;
  label: string;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup
        aria-label={label}
        aria-modal="true"
        className="collab-modal"
        initialFocus={() =>
          popupRef.current?.querySelector<HTMLElement>(
            "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), .collab-command-list button:not([disabled]), .collab-modal-actions button:not([disabled])"
          ) ?? true
        }
        ref={popupRef}
        showCloseButton={false}
      >
        {children}
      </DialogPopup>
    </Dialog>
  );
}

function ModalHeader({
  title,
  onClose
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <header className="collab-modal-header">
      <h2>{title}</h2>
      <button
        type="button"
        className="collab-icon-button"
        aria-label={`Close ${title}`}
        title="Close"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
    </header>
  );
}

function StateView({
  action,
  actionLabel,
  icon,
  message,
  role = "status",
  title
}: {
  action?: () => void;
  actionLabel?: string;
  icon: ReactNode;
  message?: string;
  role?: "status" | "alert";
  title: string;
}) {
  return (
    <div className="collab-state" role={role}>
      <span className="collab-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      {message ? <p>{message}</p> : null}
      {action && actionLabel ? (
        <button type="button" onClick={action}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function PersonalMemoryView({
  snapshot,
  onShare
}: {
  snapshot: CollaborationSnapshot;
  onShare: (sessionId: string) => void;
}) {
  const entries =
    snapshot.view.kind === "personal_memory"
      ? snapshot.view.entries
      : snapshot.navigation.personal.memory;
  return (
    <section className="collab-index collab-index-view">
      <header className="collab-content-header">
        <div>
          <h1>Personal Memory</h1>
          <p>Memory visible only to you.</p>
        </div>
      </header>
      {entries.length === 0 ? (
        <StateView
          icon={<Library />}
          title="No Personal Memory yet"
          message="Captured activity will appear here."
        />
      ) : (
        <div className="collab-memory-grid">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="collab-memory-card"
              onClick={() => onShare(entry.id)}
              aria-label={`Open ${entry.title}`}
            >
              <Library aria-hidden="true" />
              <div>
                <h2>{entry.title}</h2>
                {entry.projectName ? (
                  <strong>{entry.projectName}</strong>
                ) : null}
                <p>{entry.preview}</p>
                <time dateTime={entry.updatedAt}>
                  {formatTime(entry.updatedAt)}
                </time>
                <span className={`collab-sync-state ${entry.syncState}`}>
                  {entry.syncState.replaceAll("_", " ")}
                </span>
              </div>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function PeopleView({
  client,
  snapshot,
  onSelectWorkspace
}: {
  client: CollaborationRendererClient;
  snapshot: CollaborationSnapshot;
  onSelectWorkspace: (workspaceId: string) => void;
}) {
  const view = snapshot.view as Extract<
    CollaborationSnapshot["view"],
    { kind: "team_people" }
  >;
  const team = snapshot.navigation.teams.find(
    (candidate) => candidate.id === view.teamId
  )!;
  const canManage = team.role === "owner" || team.role === "admin";
  const principalId = snapshot.navigation.teamPrincipal?.id ?? "";
  const currentPerson = team.people.find((person) => person.id === principalId);
  const enabledOwners = team.people.filter(
    (person) =>
      person.management?.role === "owner" &&
      person.management.status === "enabled"
  ).length;
  const lastOwner = team.role === "owner" && enabledOwners <= 1;
  const membershipVersion =
    team.membershipVersion ?? currentPerson?.management?.version;
  const [invitations, setInvitations] = useState<
    CollaborationInvitation[] | null
  >(null);
  const [invitationState, setInvitationState] = useState<
    "idle" | "loading" | "ready" | "denied"
  >(canManage ? "loading" : "idle");
  const [invitationError, setInvitationError] = useState("");
  const [invitationCursor, setInvitationCursor] = useState<string | null>(null);
  const [operationError, setOperationError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [presenceNow, setPresenceNow] = useState(() => Date.now());
  const effectivePresenceNow = Math.max(presenceNow, Date.now());
  const [createdInvitation, setCreatedInvitation] = useState<{
    invitation: CollaborationInvitation;
    invitationUrl: string | null;
    copied: boolean;
  } | null>(null);
  const presenceStatusLabels = new Map(
    snapshot.teamPresenceStatusCatalogue.statuses.map((status) => [
      status.key,
      status.label
    ])
  );
  const presenceStatusChoices = (
    [
      ["available", CircleCheck],
      ["do_not_disturb", BellOff],
      ["out_of_office", Umbrella]
    ] as const
  ).flatMap(([status, Icon]) => {
    const label = presenceStatusLabels.get(status);
    return label ? [[status, Icon, label] as const] : [];
  });

  useEffect(() => {
    const nextTransition = view.people
      .map(
        (person) =>
          deriveTeamPresenceSnapshot(
            {
              mode: person.teamPresence.mode,
              manualStatus: person.teamPresence.manualStatus,
              lastActivityAt: person.teamPresence.lastActivityAt,
              preferenceVersion: person.teamPresence.preferenceVersion
            },
            effectivePresenceNow
          ).nextTransitionAt
      )
      .filter((value): value is string => Boolean(value))
      .map(Date.parse)
      .filter((value) => Number.isFinite(value) && value > effectivePresenceNow)
      .sort((left, right) => left - right)[0];
    if (!nextTransition) return;
    const now = Date.now();
    const timer = window.setTimeout(
      () => setPresenceNow(Date.now()),
      Math.max(1, nextTransition - now)
    );
    return () => window.clearTimeout(timer);
  }, [effectivePresenceNow, view.people]);

  const presenceAt = (person: CollaborationTeamPerson) => {
    return deriveTeamPresenceSnapshot(
      {
        mode: person.teamPresence.mode,
        manualStatus: person.teamPresence.manualStatus,
        lastActivityAt: person.teamPresence.lastActivityAt,
        preferenceVersion: person.teamPresence.preferenceVersion
      },
      effectivePresenceNow
    );
  };

  const activityLevelAt = (
    person: CollaborationTeamPerson
  ): "active" | "recently_active" | "idle" | "inactive" | null => {
    return presenceAt(person).activityLevel;
  };

  const presenceLabel = (person: CollaborationTeamPerson): string => {
    if (person.teamPresence.mode === "manual") {
      return (
        presenceStatusLabels.get(person.teamPresence.manualStatus) ??
        "Unknown status"
      );
    }
    const activity = activityLevelAt(person);
    return activity === "active"
      ? "Active"
      : activity === "recently_active"
        ? "Recently active"
        : activity === "idle"
          ? "Idle"
          : "Inactive";
  };

  const presenceIcon = (person: CollaborationTeamPerson) => {
    const label = presenceLabel(person);
    if (
      person.teamPresence.mode === "manual" &&
      person.teamPresence.manualStatus === "unknown"
    ) {
      return <CircleAlert aria-label={label} />;
    }
    if (
      person.teamPresence.mode === "manual" &&
      person.teamPresence.manualStatus === "do_not_disturb"
    ) {
      return <BellOff aria-label={label} />;
    }
    if (
      person.teamPresence.mode === "manual" &&
      person.teamPresence.manualStatus === "out_of_office"
    ) {
      return <Umbrella aria-label={label} />;
    }
    return (
      <CircleCheck
        aria-label={label}
        data-activity={activityLevelAt(person) ?? "manual"}
      />
    );
  };

  const loadInvitations = useCallback(
    async (cursor: string | null = null) => {
      if (!canManage) return;
      setInvitationState("loading");
      setInvitationError("");
      try {
        const page = await client.listInvitations({ teamId: team.id, cursor });
        const pending = page.items.filter(
          (item) => item.lifecycle === "pending"
        );
        setInvitations((current) =>
          cursor
            ? [
                ...(current ?? []),
                ...pending.filter(
                  (item) =>
                    !current?.some((existing) => existing.id === item.id)
                )
              ]
            : pending
        );
        setInvitationCursor(page.nextCursor);
        setInvitationState("ready");
      } catch (cause) {
        setInvitations(null);
        setInvitationState("denied");
        setInvitationError(
          failureMessage(cause, "Pending invitations are not available.")
        );
      }
    },
    [canManage, client, team.id]
  );

  useEffect(() => {
    void loadInvitations(null);
  }, [loadInvitations]);

  const runOperation = async (
    key: string,
    operation: () => Promise<unknown>,
    fallback: string
  ) => {
    if (busyKey) return false;
    setBusyKey(key);
    setOperationError("");
    try {
      await operation();
      return true;
    } catch (cause) {
      setOperationError(failureMessage(cause, fallback));
      return false;
    } finally {
      setBusyKey("");
    }
  };

  const submitWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = normalizedText(data.get("name")?.toString() ?? "");
    const description = normalizedText(
      data.get("description")?.toString() ?? ""
    );
    if (!name) {
      setOperationError("Enter a Workspace name.");
      return;
    }
    if (codePointLength(name) > snapshot.limits.nameMaxNormalizedCodePoints) {
      setOperationError(
        `Names can be at most ${snapshot.limits.nameMaxNormalizedCodePoints} characters.`
      );
      return;
    }
    if (
      utf8ByteLength(description) > snapshot.limits.topicDescriptionMaxUtf8Bytes
    ) {
      setOperationError(
        `Descriptions can be at most ${snapshot.limits.topicDescriptionMaxUtf8Bytes} bytes.`
      );
      return;
    }
    const completed = await runOperation(
      "create-workspace",
      () =>
        client.createWorkspace({
          teamId: team.id,
          name,
          description: description || null
        }),
      "The Workspace could not be created."
    );
    if (completed) setWorkspaceOpen(false);
  };

  const submitInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = normalizedText(data.get("email")?.toString() ?? "");
    const role = data.get("role")?.toString() as "owner" | "admin" | "member";
    const defaultWorkspaceId = data.get("workspaceId")?.toString() ?? "";
    const defaultWorkspaceAccess = data.get("access")?.toString() as
      | "read"
      | "write";
    if (!email || !email.includes("@")) {
      setOperationError("Enter a valid email address.");
      return;
    }
    const created = await runOperation(
      "create-invitation",
      async () => {
        const result = await client.createInvitation({
          teamId: team.id,
          email,
          role,
          defaultWorkspaceId,
          defaultWorkspaceAccess,
          ttlHours: 72
        });
        setCreatedInvitation({
          invitation: result.invitation,
          invitationUrl: result.invitationUrl,
          copied: false
        });
        setInvitations((current) => [
          result.invitation,
          ...(current ?? []).filter(
            (invitation) => invitation.id !== result.invitation.id
          )
        ]);
      },
      "The invitation could not be created."
    );
    if (!created) setCreatedInvitation(null);
  };

  const copyInvitation = async () => {
    if (!createdInvitation?.invitationUrl || busyKey) return;
    setBusyKey("copy-invitation");
    setOperationError("");
    try {
      await createRendererPlatform().copyText(createdInvitation.invitationUrl);
      setCreatedInvitation({
        ...createdInvitation,
        invitationUrl: null,
        copied: true
      });
    } catch {
      setOperationError("The invitation link could not be copied.");
    } finally {
      setBusyKey("");
    }
  };

  const roleControl = (person: CollaborationTeamPerson) => {
    const management = person.management;
    if (!canManage || !management || management.status !== "enabled") {
      return null;
    }
    const protectedOwner =
      management.role === "owner" &&
      (team.role !== "owner" || enabledOwners <= 1);
    return (
      <select
        aria-label={`Role for ${person.displayName}`}
        value={management.role}
        disabled={Boolean(busyKey) || protectedOwner}
        title={
          protectedOwner ? "The last owner must remain an owner." : undefined
        }
        onChange={(event) =>
          void runOperation(
            `role-${person.id}`,
            () =>
              client.updateMemberRole({
                teamId: team.id,
                userId: person.id,
                role: event.currentTarget.value as "owner" | "admin" | "member",
                expectedVersion: management.version
              }),
            "The member role could not be changed."
          )
        }
      >
        <option value="owner">Owner</option>
        <option value="admin">Admin</option>
        <option value="member">Member</option>
      </select>
    );
  };

  return (
    <section className="collab-index collab-index-view collab-team-admin">
      <header className="collab-content-header">
        <div>
          <h1>People</h1>
          <p>{team.name}</p>
        </div>
        {canManage ? (
          <div className="collab-header-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setOperationError("");
                setWorkspaceOpen(true);
              }}
            >
              <Plus aria-hidden="true" /> Create Workspace
            </button>
            <button
              type="button"
              onClick={() => {
                setOperationError("");
                setCreatedInvitation(null);
                setInviteOpen(true);
              }}
            >
              <UserPlus aria-hidden="true" /> Invite member
            </button>
          </div>
        ) : null}
      </header>
      <div className="collab-admin-scroll">
        {operationError ? (
          <p className="collab-admin-error" role="alert">
            {operationError}
          </p>
        ) : null}

        <section
          className="collab-admin-section"
          aria-labelledby="workspace-heading"
        >
          <header>
            <h2 id="workspace-heading">Workspaces</h2>
          </header>
          {team.workspaces.length === 0 ? (
            <p className="collab-admin-empty">No Workspaces available.</p>
          ) : (
            <div className="collab-admin-list">
              {team.workspaces.map((workspace) => (
                <div className="collab-workspace-admin-row" key={workspace.id}>
                  <button
                    type="button"
                    className="collab-row-link"
                    aria-label={`Open ${workspace.name}`}
                    disabled={workspace.lifecycle !== "active"}
                    onClick={() => onSelectWorkspace(workspace.id)}
                  >
                    <FolderKanban aria-hidden="true" />
                    <span>
                      <strong>{workspace.name}</strong>
                      <small>
                        {workspace.lifecycle === "active"
                          ? workspace.description || "Active Workspace"
                          : "Archived"}
                      </small>
                    </span>
                  </button>
                  {canManage ? (
                    workspace.lifecycle === "archived" ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busyKey)}
                        onClick={() =>
                          void runOperation(
                            `restore-${workspace.id}`,
                            () =>
                              client.restoreWorkspace({
                                teamId: team.id,
                                workspaceId: workspace.id,
                                expectedVersion: workspace.version
                              }),
                            "The Workspace could not be restored."
                          )
                        }
                      >
                        <RotateCcw aria-hidden="true" /> Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="danger-secondary"
                        disabled={Boolean(busyKey)}
                        onClick={() =>
                          void runOperation(
                            `archive-${workspace.id}`,
                            () =>
                              client.archiveWorkspace({
                                teamId: team.id,
                                workspaceId: workspace.id,
                                expectedVersion: workspace.version
                              }),
                            "The Workspace could not be archived."
                          )
                        }
                      >
                        <Archive aria-hidden="true" /> Archive
                      </button>
                    )
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section
          className="collab-admin-section"
          aria-labelledby="members-heading"
        >
          <header>
            <h2 id="members-heading">Members</h2>
          </header>
          {view.people.length === 0 ? (
            <p className="collab-admin-empty">No Team members available.</p>
          ) : (
            <div className="collab-people-list">
              {view.people.map((person) => {
                const management = person.management;
                const isCurrent = person.id === principalId;
                const canChangeTarget =
                  canManage &&
                  management?.status === "enabled" &&
                  (management.role !== "owner" || team.role === "owner");
                const targetLastOwner =
                  management?.role === "owner" && enabledOwners <= 1;
                return (
                  <div key={person.id} className="collab-person-admin-row">
                    <span className="collab-avatar">
                      {initials(person.displayName)}
                    </span>
                    <div className="collab-person-identity">
                      <strong>
                        <span
                          className="collab-presence-icon"
                          title={presenceLabel(person)}
                        >
                          {presenceIcon(person)}
                        </span>
                        {person.displayName}
                      </strong>
                      <span>
                        {management?.email ??
                          coarsePresenceFromTeamPresence(presenceAt(person))}
                        {isCurrent ? " · You" : ""}
                      </span>
                    </div>
                    {isCurrent ? (
                      <div
                        className="collab-presence-controls"
                        aria-label="Your Team presence"
                      >
                        <label className="collab-presence-auto">
                          <input
                            type="checkbox"
                            checked={person.teamPresence.mode === "auto"}
                            disabled={Boolean(busyKey)}
                            onChange={(event) =>
                              void runOperation(
                                "presence-mode",
                                () =>
                                  client.setTeamPresence({
                                    teamId: team.id,
                                    mode: event.currentTarget.checked
                                      ? "auto"
                                      : "manual",
                                    manualStatus:
                                      person.teamPresence.manualStatus ===
                                      "unknown"
                                        ? (presenceStatusChoices[0]?.[0] ??
                                          "available")
                                        : person.teamPresence.manualStatus,
                                    expectedVersion:
                                      person.teamPresence.preferenceVersion
                                  }),
                                "Your presence could not be changed."
                              )
                            }
                          />
                          <span>Auto</span>
                        </label>
                        <div className="collab-presence-choices">
                          {presenceStatusChoices.map(
                            ([status, Icon, label]) => (
                              <button
                                key={status}
                                type="button"
                                className={
                                  person.teamPresence.mode === "manual" &&
                                  person.teamPresence.manualStatus === status
                                    ? "selected"
                                    : ""
                                }
                                aria-label={label}
                                aria-pressed={
                                  person.teamPresence.mode === "manual" &&
                                  person.teamPresence.manualStatus === status
                                }
                                title={label}
                                disabled={
                                  Boolean(busyKey) ||
                                  person.teamPresence.mode === "auto"
                                }
                                onClick={() =>
                                  void runOperation(
                                    `presence-${status}`,
                                    () =>
                                      client.setTeamPresence({
                                        teamId: team.id,
                                        mode: "manual",
                                        manualStatus: status,
                                        expectedVersion:
                                          person.teamPresence.preferenceVersion
                                      }),
                                    "Your presence could not be changed."
                                  )
                                }
                              >
                                <Icon aria-hidden="true" />
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    ) : null}
                    {roleControl(person)}
                    {person.membershipState === "disabled" ? (
                      <span className="collab-member-state">Disabled</span>
                    ) : null}
                    {canManage && management ? (
                      <div className="collab-access-grid">
                        {team.workspaces
                          .filter(
                            (workspace) => workspace.lifecycle === "active"
                          )
                          .map((workspace) => {
                            const currentAccess =
                              management.workspaceAccess.find(
                                (access) => access.workspaceId === workspace.id
                              ) ?? {
                                workspaceId: workspace.id,
                                userId: person.id,
                                access: "disabled" as const,
                                version: null
                              };
                            return (
                              <label key={workspace.id}>
                                <span>{workspace.name}</span>
                                <select
                                  aria-label={`${workspace.name} access for ${person.displayName}`}
                                  value={currentAccess.access}
                                  disabled={
                                    Boolean(busyKey) ||
                                    !canChangeTarget ||
                                    workspace.lifecycle !== "active"
                                  }
                                  onChange={(event) =>
                                    void runOperation(
                                      `access-${workspace.id}-${person.id}`,
                                      () =>
                                        client.setWorkspaceAccess({
                                          teamId: team.id,
                                          workspaceId: workspace.id,
                                          userId: person.id,
                                          access: event.currentTarget.value as
                                            | "disabled"
                                            | "read"
                                            | "write",
                                          expectedVersion: currentAccess.version
                                        }),
                                      "Workspace Access could not be changed."
                                    )
                                  }
                                >
                                  <option value="disabled">No access</option>
                                  <option value="read">Read</option>
                                  <option value="write">Write</option>
                                </select>
                              </label>
                            );
                          })}
                      </div>
                    ) : null}
                    {canChangeTarget && !isCurrent ? (
                      <button
                        type="button"
                        className="danger-secondary"
                        disabled={Boolean(busyKey) || targetLastOwner}
                        title={
                          targetLastOwner
                            ? "The last owner cannot be disabled."
                            : undefined
                        }
                        onClick={() =>
                          void runOperation(
                            `disable-${person.id}`,
                            () =>
                              client.disableMember({
                                teamId: team.id,
                                userId: person.id,
                                expectedVersion: management!.version
                              }),
                            "The Team member could not be disabled."
                          )
                        }
                      >
                        Disable
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {canManage ? (
          <section
            className="collab-admin-section"
            aria-labelledby="invites-heading"
          >
            <header>
              <h2 id="invites-heading">Pending invitations</h2>
              {invitationState === "denied" ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void loadInvitations(null)}
                >
                  Retry
                </button>
              ) : null}
            </header>
            {invitationState === "loading" ? (
              <p className="collab-admin-empty" role="status">
                Loading pending invitations…
              </p>
            ) : invitationState === "denied" ? (
              <p className="collab-admin-error" role="alert">
                {invitationError}
              </p>
            ) : invitations?.length ? (
              <div className="collab-admin-list">
                {invitations.map((invitation) => (
                  <div className="collab-invitation-row" key={invitation.id}>
                    <div>
                      <strong>{invitation.email}</strong>
                      <span>
                        {invitation.role} · expires{" "}
                        {formatTime(invitation.expiresAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="danger-secondary"
                      disabled={Boolean(busyKey)}
                      onClick={() =>
                        void runOperation(
                          `revoke-${invitation.id}`,
                          async () => {
                            await client.revokeInvitation({
                              teamId: team.id,
                              invitationId: invitation.id,
                              expectedVersion: invitation.version
                            });
                            setInvitations(
                              (current) =>
                                current?.filter(
                                  (candidate) => candidate.id !== invitation.id
                                ) ?? []
                            );
                          },
                          "The invitation could not be revoked."
                        )
                      }
                    >
                      Revoke
                    </button>
                  </div>
                ))}
                {invitationCursor ? (
                  <button
                    type="button"
                    className="collab-load-more secondary"
                    onClick={() => void loadInvitations(invitationCursor)}
                  >
                    Load more
                  </button>
                ) : null}
              </div>
            ) : invitationState === "ready" ? (
              <p className="collab-admin-empty">No pending invitations.</p>
            ) : null}
          </section>
        ) : null}

        <section className="collab-admin-section collab-leave-section">
          <header>
            <h2>Team membership</h2>
          </header>
          {membershipVersion ? (
            <button
              type="button"
              className="danger-secondary"
              disabled={Boolean(busyKey) || lastOwner}
              title={
                lastOwner ? "Add another owner before leaving." : undefined
              }
              onClick={() =>
                void runOperation(
                  "leave-team",
                  () =>
                    client.leaveTeam({
                      teamId: team.id,
                      expectedVersion: membershipVersion
                    }),
                  "The Team could not be left."
                )
              }
            >
              <LogOut aria-hidden="true" /> Leave Team
            </button>
          ) : null}
          {lastOwner ? (
            <p>The last owner must assign another owner before leaving.</p>
          ) : null}
        </section>
      </div>

      {workspaceOpen ? (
        <Modal label="Create Workspace" onClose={() => setWorkspaceOpen(false)}>
          <ModalHeader
            title="Create Workspace"
            onClose={() => setWorkspaceOpen(false)}
          />
          <form
            className="collab-form"
            onSubmit={(event) => void submitWorkspace(event)}
          >
            <label>
              Name
              <input name="name" autoFocus />
            </label>
            <label>
              Description
              <textarea name="description" rows={3} />
            </label>
            {operationError ? (
              <p className="collab-form-error" role="alert">
                {operationError}
              </p>
            ) : null}
            <footer>
              <button
                type="button"
                className="secondary"
                onClick={() => setWorkspaceOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" disabled={Boolean(busyKey)}>
                {busyKey === "create-workspace"
                  ? "Creating…"
                  : "Create Workspace"}
              </button>
            </footer>
          </form>
        </Modal>
      ) : null}

      {inviteOpen ? (
        <Modal label="Invite member" onClose={() => setInviteOpen(false)}>
          <ModalHeader
            title="Invite member"
            onClose={() => setInviteOpen(false)}
          />
          {createdInvitation ? (
            <div className="collab-invitation-created">
              <Check aria-hidden="true" />
              <strong>
                Invitation created for {createdInvitation.invitation.email}
              </strong>
              <p>The invitation link is available only in this confirmation.</p>
              {createdInvitation.invitationUrl ? (
                <button
                  type="button"
                  disabled={busyKey === "copy-invitation"}
                  onClick={() => void copyInvitation()}
                >
                  <Clipboard aria-hidden="true" /> Copy invitation link
                </button>
              ) : createdInvitation.copied ? (
                <p role="status">Invitation link copied.</p>
              ) : null}
              {operationError ? (
                <p className="collab-form-error" role="alert">
                  {operationError}
                </p>
              ) : null}
            </div>
          ) : (
            <form
              className="collab-form"
              onSubmit={(event) => void submitInvitation(event)}
            >
              <label>
                Email
                <input name="email" type="email" autoComplete="off" autoFocus />
              </label>
              <label>
                Role
                <select name="role" defaultValue="member">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  {team.role === "owner" ? (
                    <option value="owner">Owner</option>
                  ) : null}
                </select>
              </label>
              <label>
                Workspace
                <select
                  name="workspaceId"
                  defaultValue={
                    team.workspaces.find(
                      (workspace) => workspace.lifecycle === "active"
                    )?.id
                  }
                >
                  {team.workspaces
                    .filter((workspace) => workspace.lifecycle === "active")
                    .map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Workspace Access
                <select name="access" defaultValue="write">
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                </select>
              </label>
              {operationError ? (
                <p className="collab-form-error" role="alert">
                  {operationError}
                </p>
              ) : null}
              <footer>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setInviteOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    Boolean(busyKey) ||
                    !team.workspaces.some(
                      (workspace) => workspace.lifecycle === "active"
                    )
                  }
                >
                  {busyKey === "create-invitation"
                    ? "Creating…"
                    : "Create invitation"}
                </button>
              </footer>
            </form>
          )}
        </Modal>
      ) : null}
    </section>
  );
}

export function SharedMemoryIndex({
  snapshot,
  onSelect
}: {
  snapshot: CollaborationSnapshot;
  onSelect: (selection: CollaborationSelection) => void;
}) {
  if (snapshot.view.kind !== "shared_memory_index") return null;
  const view = snapshot.view;
  const team = snapshot.navigation.teams.find(
    (item) => item.id === view.teamId
  );
  const workspace = team?.workspaces.find(
    (item) => item.id === view.workspaceId
  );
  return (
    <section className="collab-index collab-index-view">
      <header className="collab-content-header">
        <div>
          <h1>Shared Memory</h1>
          <p>{workspace?.name ?? "Workspace"}</p>
        </div>
      </header>
      {view.sessions.length === 0 ? (
        <StateView
          icon={<BookOpen />}
          title="No Team-shared Memory"
          message="Shared Captured Sessions will appear here when access is granted."
        />
      ) : (
        <div className="collab-shared-list">
          {view.sessions.map((session) => (
            <button
              type="button"
              key={session.id}
              className="collab-shared-row"
              aria-label={session.title}
              onClick={() =>
                onSelect({
                  kind: "shared_session",
                  teamId: session.teamId,
                  workspaceId: session.workspaceId,
                  sharedSessionId: session.id
                })
              }
            >
              <BookOpen aria-hidden="true" />
              <span>
                <strong>{session.title}</strong>
                <small>
                  {session.owner.displayName} ·{" "}
                  {representationLabel(session.representation)}
                </small>
              </span>
              <time dateTime={session.latestActivityAt}>
                {formatTime(session.latestActivityAt)}
              </time>
              {session.unreadCompanionCount > 0 ? (
                <span
                  className="collab-nav-unread"
                  aria-label={`${session.unreadCompanionCount} unread discussion messages`}
                >
                  {session.unreadCompanionCount > 99
                    ? "99+"
                    : session.unreadCompanionCount}
                </span>
              ) : null}
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceItemRow({ item }: { item: SharedMemorySourceItem }) {
  if (item.representation === "memory_events") {
    return (
      <MemoryEventFrame
        className="collab-source-event memory-event"
        contentType="memory_event"
        header={
          <>
            <strong>Memory Event</strong>
            <time dateTime={item.occurredAt}>
              {formatTime(item.occurredAt)}
            </time>
          </>
        }
        role="listitem"
        scope="workspace"
      >
        <MemorySourceParts
          parts={item.sourceItems}
          renderIcon={(source) =>
            source.sourceKind === "tool_call" ||
            source.sourceKind === "tool_result" ? (
              <ToolCase />
            ) : (
              <MessageSquare />
            )
          }
        />
      </MemoryEventFrame>
    );
  }
  return (
    <LcmSummaryFrame
      occurredAt={item.occurredAt}
      representation={item.representation}
      sourceCount={item.sourceCount}
      summary={<p>{item.summaryText}</p>}
      timeLabel={formatTime(item.occurredAt)}
    />
  );
}

function SourceTimeline({
  client,
  page,
  session
}: {
  client: CollaborationRendererClient;
  page: SharedMemorySourcePage;
  session: SharedMemorySession;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const rows = page.items;
  if (session.sourceState === "loading") {
    return (
      <StateView
        icon={<LoaderCircle className="collab-spin" />}
        title="Loading shared source"
      />
    );
  }
  if (session.sourceState === "permission_denied") {
    return (
      <StateView
        icon={<LockKeyhole />}
        title="Source access denied"
        message="You do not have access to this shared source representation."
      />
    );
  }
  if (session.sourceState === "revoked") {
    return (
      <StateView
        icon={<LockKeyhole />}
        title="Shared source revoked"
        message="This source is no longer available."
      />
    );
  }
  if (session.sourceState === "unavailable") {
    return <StateView icon={<CloudOff />} title="Shared source unavailable" />;
  }
  const loadPage = async (direction: "older" | "newer") => {
    if (loading || (direction === "older" ? !page.hasOlder : !page.hasNewer))
      return;
    setLoading(true);
    setError("");
    try {
      await client.loadSharedSourcePage({
        teamId: session.teamId,
        workspaceId: session.workspaceId,
        sharedSessionId: session.id,
        direction,
        cursor: direction === "older" ? page.olderCursor : page.newerCursor
      });
    } catch (cause) {
      setError(failureMessage(cause, "Shared source history is unavailable."));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="collab-source-history" data-rendered-count={rows.length}>
      <div className="collab-history-control">
        {page.hasOlder ? (
          <button
            type="button"
            className="collab-text-button"
            disabled={loading}
            onClick={() => void loadPage("older")}
          >
            {loading ? (
              <LoaderCircle className="collab-spin" aria-hidden="true" />
            ) : (
              <Archive aria-hidden="true" />
            )}
            {loading ? "Loading history" : "Load older source"}
          </button>
        ) : rows.length > 0 ? (
          <span>Beginning of source</span>
        ) : null}
        {error ? <span className="collab-inline-error">{error}</span> : null}
      </div>
      {rows.length === 0 ? (
        <div className="collab-empty-inline">No source items available.</div>
      ) : null}
      {rows.length > 0 ? (
        <VirtualizedTimeline
          ariaLabel={`${representationLabel(session.representation)} source items`}
          className="collab-source-list collab-virtual-list"
          estimatedItemHeight={132}
          events={rows}
          hasOlderEvents={page.hasOlder}
          hasNewerEvents={page.hasNewer}
          onLoadOlder={() => loadPage("older")}
          onLoadNewer={() => loadPage("newer")}
          renderEvent={(item) => <SourceItemRow key={item.id} item={item} />}
          threadKey={`${session.id}:${session.representation}`}
        />
      ) : null}
      {page.hasNewer ? (
        <div className="collab-history-control collab-newer-control">
          <button
            type="button"
            className="collab-text-button"
            disabled={loading}
            onClick={() => void loadPage("newer")}
          >
            <RefreshCw aria-hidden="true" />
            {loading ? "Loading recent source" : "Return to recent source"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function SharedSessionView({
  client,
  drafts,
  markdownAdapters,
  snapshot
}: {
  client: CollaborationRendererClient;
  drafts: CollaborationDrafts;
  markdownAdapters: MarkdownPlatformAdapters;
  snapshot: CollaborationSnapshot;
}) {
  if (snapshot.view.kind !== "shared_session") return null;
  const { session, source, companion } = snapshot.view;
  const [sourcePercent, setSourcePercent] = useState(62);
  const [narrowTab, setNarrowTab] = useState<"source" | "discussion">("source");
  const [narrowLayout, setNarrowLayout] = useState(
    () => window.matchMedia("(max-width: 900px)").matches
  );
  const splitRef = useRef<HTMLDivElement>(null);
  const sourceTabRef = useRef<HTMLButtonElement>(null);
  const discussionTabRef = useRef<HTMLButtonElement>(null);
  const style = {
    "--collab-source-size": `${sourcePercent}%`
  } as CSSProperties;
  const updateFromClientX = useCallback((clientX: number) => {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    setSourcePercent(
      Math.max(35, Math.min(70, ((clientX - bounds.left) / bounds.width) * 100))
    );
  }, []);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromClientX(event.clientX);
  };
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const split = splitRef.current;
    const update = () =>
      setNarrowLayout(
        media.matches || (split?.clientWidth ?? Number.POSITIVE_INFINITY) < 687
      );
    update();
    media.addEventListener("change", update);
    const observer =
      split && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(update)
        : null;
    if (observer && split) observer.observe(split);
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  const title = threadTitle(
    companion.thread,
    principalIdForThread(snapshot, companion.thread)
  );
  if (session.sourceState === "revoked") {
    return (
      <StateView
        icon={<LockKeyhole />}
        role="alert"
        title="Shared Memory access revoked"
        message="The shared source and its discussion are no longer available."
      />
    );
  }
  if (session.sourceState === "permission_denied") {
    return (
      <StateView
        icon={<LockKeyhole />}
        role="alert"
        title="Shared Memory unavailable"
        message="You no longer have access to this shared source or its discussion."
      />
    );
  }
  return (
    <section className="collab-shared-session">
      <header className="collab-content-header shared">
        <div>
          <h1>{session.title}</h1>
          <p>
            {session.owner.displayName} ·{" "}
            {representationLabel(session.representation)}
          </p>
        </div>
        <span className={`collab-source-state ${session.liveState}`}>
          {liveStateLabel(session.liveState)}
        </span>
      </header>
      {session.liveState === "reconnecting" ? (
        <div className="collab-offline-banner" role="status">
          <RefreshCw className="collab-spin" aria-hidden="true" /> Reconnecting
          shared source
        </div>
      ) : null}
      <div
        className="collab-narrow-tabs"
        data-visible={narrowLayout}
        role="tablist"
        aria-label="Shared session panes"
      >
        <button
          type="button"
          role="tab"
          id="collab-shared-source-tab"
          ref={sourceTabRef}
          aria-controls="collab-shared-source-panel"
          aria-selected={narrowTab === "source"}
          tabIndex={narrowTab === "source" ? 0 : -1}
          onClick={() => setNarrowTab("source")}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "End") {
              event.preventDefault();
              setNarrowTab("discussion");
              discussionTabRef.current?.focus();
            }
          }}
        >
          <FileText aria-hidden="true" /> Source
        </button>
        <button
          type="button"
          role="tab"
          id="collab-shared-discussion-tab"
          ref={discussionTabRef}
          aria-controls="collab-shared-discussion-panel"
          aria-selected={narrowTab === "discussion"}
          tabIndex={narrowTab === "discussion" ? 0 : -1}
          onClick={() => setNarrowTab("discussion")}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "Home") {
              event.preventDefault();
              setNarrowTab("source");
              sourceTabRef.current?.focus();
            }
          }}
        >
          <MessageCircle aria-hidden="true" /> Discussion
          {session.unreadCompanionCount > 0 ? (
            <span
              className="collab-nav-unread"
              aria-label={`${session.unreadCompanionCount} unread`}
            >
              {session.unreadCompanionCount > 99
                ? "99+"
                : session.unreadCompanionCount}
            </span>
          ) : null}
        </button>
      </div>
      <div
        ref={splitRef}
        className="collab-split"
        data-layout={narrowLayout ? "narrow" : "split"}
        style={style}
        data-narrow-tab={narrowTab}
      >
        <section
          id="collab-shared-source-panel"
          className="collab-source-pane"
          role="tabpanel"
          aria-labelledby="collab-shared-source-tab"
          tabIndex={0}
        >
          <header className="collab-pane-header">
            <FileText aria-hidden="true" />
            <strong>{representationLabel(session.representation)}</strong>
            <span>{representationStateLabel(session.representationState)}</span>
          </header>
          <SourceTimeline client={client} page={source} session={session} />
        </section>
        <div
          className="collab-divider"
          role="separator"
          tabIndex={0}
          aria-label="Resize shared source and discussion"
          aria-orientation="vertical"
          aria-valuemin={35}
          aria-valuemax={70}
          aria-valuenow={Math.round(sourcePercent)}
          onPointerDown={pointerDown}
          onPointerMove={(event) =>
            event.currentTarget.hasPointerCapture(event.pointerId) &&
            updateFromClientX(event.clientX)
          }
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setSourcePercent((value) =>
                Math.max(
                  35,
                  Math.min(70, value + (event.key === "ArrowLeft" ? -2 : 2))
                )
              );
            }
          }}
        />
        <section
          id="collab-shared-discussion-panel"
          className="collab-discussion-pane"
          role="tabpanel"
          aria-labelledby="collab-shared-discussion-tab"
          tabIndex={0}
        >
          <header className="collab-pane-header">
            <MessageCircle aria-hidden="true" />
            <strong>Discussion</strong>
          </header>
          <RouteThreadTimeline
            client={client}
            currentUserId={
              snapshot.navigation.teamPrincipal?.id ??
              snapshot.navigation.personalOwner.id
            }
            label={title}
            markdownAdapters={markdownAdapters}
            page={companion.messages}
            readEligible={!narrowLayout || narrowTab === "discussion"}
            thread={companion.thread}
          />
          <RouteMessageComposer
            client={client}
            drafts={drafts}
            snapshot={snapshot}
            thread={companion.thread}
          />
        </section>
      </div>
    </section>
  );
}

const SHARED_MEMORY_REPRESENTATIONS = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
] as const satisfies readonly SharedMemoryRepresentation[];

function SharedMemoryOwnerModal({
  client,
  entry,
  snapshot,
  onClose
}: {
  client: CollaborationRendererClient;
  entry: PersonalMemoryEntry;
  snapshot: CollaborationSnapshot;
  onClose: () => void;
}) {
  const availableTeams = snapshot.navigation.teams.filter(
    (team) => team.lifecycle === "active"
  );
  const initialTeam = availableTeams[0] ?? null;
  const initialWorkspace =
    initialTeam?.workspaces.find(
      (workspace) => workspace.lifecycle === "active"
    ) ?? null;
  const [teamId, setTeamId] = useState(initialTeam?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace?.id ?? "");
  const [representation, setRepresentation] =
    useState<SharedMemoryRepresentation>("memory_events");
  const [mode, setMode] = useState<"snapshot" | "continuous">("continuous");
  const [currentEntry, setCurrentEntry] = useState(entry);
  const [ownerGrants, setOwnerGrants] = useState<SharedMemoryGrant[]>([]);
  const [loadingGrants, setLoadingGrants] = useState(
    entry.logicalMemoryId !== null
  );
  const [workflow, setWorkflow] = useState<
    { kind: "new" } | { kind: "change"; grant: SharedMemoryGrant } | null
  >(entry.logicalMemoryId ? null : { kind: "new" });
  const [preview, setPreview] = useState<SharedMemoryPreview | null>(null);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [stoppingSync, setStoppingSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedTeam =
    availableTeams.find((team) => team.id === teamId) ?? null;
  const workspaces =
    selectedTeam?.workspaces.filter(
      (workspace) =>
        workspace.lifecycle === "active" && workspace.access === "write"
    ) ?? [];
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const destinationInvalid =
    Boolean(teamId && !selectedTeam) ||
    Boolean(workspaceId && !selectedWorkspace);
  const selectedDestinationGrant = ownerGrants.find(
    (grant) => grant.teamId === teamId && grant.workspaceId === workspaceId
  );

  useEffect(() => {
    const liveEntry = snapshot.navigation.personal.memory.find(
      (candidate) => candidate.id === entry.id
    );
    if (liveEntry) setCurrentEntry(liveEntry);
  }, [entry.id, snapshot.navigation.personal.memory]);

  useEffect(() => {
    let active = true;
    if (!entry.logicalMemoryId) {
      setLoadingGrants(false);
      setWorkflow({ kind: "new" });
      return () => {
        active = false;
      };
    }
    setLoadingGrants(true);
    void client
      .listOwnedSharedMemoryGrants({ logicalMemoryId: entry.logicalMemoryId })
      .then((grants) => {
        if (!active) return;
        setOwnerGrants(grants);
        if (grants.length === 0) {
          setWorkflow({ kind: "new" });
        }
      })
      .catch((cause) => {
        if (active) {
          setError(
            failureMessage(cause, "Existing Shared Memory could not be loaded.")
          );
        }
      })
      .finally(() => {
        if (active) setLoadingGrants(false);
      });
    return () => {
      active = false;
    };
  }, [client, entry.logicalMemoryId]);

  useEffect(() => {
    if (destinationInvalid) onClose();
  }, [destinationInvalid, onClose]);

  const requireDestination = () => {
    if (!selectedTeam || !selectedWorkspace) {
      throw new CollaborationInputError(
        "This Shared Memory destination is no longer available."
      );
    }
  };

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(failureMessage(cause, "Shared Memory could not be prepared."));
    } finally {
      setBusy(false);
    }
  };

  const prepareAndPreview = () =>
    run(async () => {
      requireDestination();
      let prepared = currentEntry;
      if (!prepared.logicalMemoryId || !prepared.hasSynchronizedRevision) {
        prepared = await client.prepareSharedMemorySource({
          sessionId: prepared.id
        });
        setCurrentEntry(prepared);
      }
      if (!prepared.logicalMemoryId || !prepared.hasSynchronizedRevision) {
        throw new CollaborationInputError(
          "The source is being prepared. Reopen it when sync is ready."
        );
      }
      setPreview(
        await client.previewSharedMemory({
          logicalMemoryId: prepared.logicalMemoryId,
          teamId,
          workspaceId,
          representation,
          allowedRepresentations: [representation]
        })
      );
    });

  const beginNewShare = () => {
    const team = availableTeams[0] ?? null;
    const workspace =
      team?.workspaces.find((item) => item.lifecycle === "active") ?? null;
    setTeamId(team?.id ?? "");
    setWorkspaceId(workspace?.id ?? "");
    setRepresentation("memory_events");
    setPreview(null);
    setRevokingGrantId(null);
    setWorkflow({ kind: "new" });
    setError("");
  };

  const beginRepresentationChange = (grant: SharedMemoryGrant) => {
    setTeamId(grant.teamId);
    setWorkspaceId(grant.workspaceId);
    setRepresentation(grant.activeRepresentation ?? "memory_events");
    setPreview(null);
    setRevokingGrantId(null);
    setWorkflow({ kind: "change", grant });
    setError("");
  };

  const stopSharing = (grant: SharedMemoryGrant) =>
    run(async () => {
      const revoked = await client.revokeSharedMemory({
        mutationId: crypto.randomUUID(),
        teamId: grant.teamId,
        workspaceId: grant.workspaceId,
        shareGrantId: grant.id,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_revoked"
      });
      setOwnerGrants((current) =>
        current.map((item) => (item.id === revoked.id ? revoked : item))
      );
      setRevokingGrantId(null);
    });

  const toggleSync = () =>
    run(async () => {
      const updated =
        currentEntry.syncState === "paused"
          ? await client.resumeSharedMemorySync({ sessionId: currentEntry.id })
          : currentEntry.syncState === "failed"
            ? await client.prepareSharedMemorySource({
                sessionId: currentEntry.id
              })
            : await client.pauseSharedMemorySync({
                sessionId: currentEntry.id
              });
      setCurrentEntry(updated);
    });

  const stopSync = () =>
    run(async () => {
      const updated = await client.revokeSharedMemorySync({
        sessionId: currentEntry.id
      });
      setCurrentEntry(updated);
      setStoppingSync(false);
    });

  const loadMore = () =>
    run(async () => {
      if (!preview?.nextCursor) return;
      const page = await client.loadSharedMemoryPreviewPage({
        previewHash: preview.previewHash,
        cursor: preview.nextCursor
      });
      const items = new Map(preview.items.map((item) => [item.id, item]));
      for (const item of page.items) items.set(item.id, item);
      setPreview({ ...page, items: [...items.values()] });
    });

  const confirmShare = () =>
    run(async () => {
      if (!preview || !currentEntry.logicalMemoryId || !workflow) return;
      requireDestination();
      const consent = await client.consentSharedMemory({
        consentId: crypto.randomUUID(),
        logicalMemoryId: currentEntry.logicalMemoryId,
        teamId,
        workspaceId,
        mode,
        allowedRepresentations: [representation],
        selectedRepresentation: representation,
        previewRevision: preview.previewRevision,
        previewHash: preview.previewHash,
        expiresAt: null
      });
      const targetGrant =
        workflow.kind === "change" ? workflow.grant : selectedDestinationGrant;
      if (targetGrant) {
        const refreshedGrants = await client.listOwnedSharedMemoryGrants({
          logicalMemoryId: currentEntry.logicalMemoryId
        });
        setOwnerGrants(refreshedGrants);
        const refreshedGrant = refreshedGrants.find(
          (grant) => grant.id === targetGrant.id
        );
        if (
          !refreshedGrant ||
          refreshedGrant.logicalMemoryId !== currentEntry.logicalMemoryId ||
          refreshedGrant.teamId !== teamId ||
          refreshedGrant.workspaceId !== workspaceId
        ) {
          throw new CollaborationInputError(
            "This Shared Memory changed while consent was being recorded. Reload it and try again."
          );
        }
        const changed = await client.changeSharedMemoryRepresentation({
          mutationId: crypto.randomUUID(),
          teamId,
          workspaceId,
          shareGrantId: refreshedGrant.id,
          consentId: consent.id,
          representation,
          expectedGrantVersion: refreshedGrant.grantVersion
        });
        setOwnerGrants((current) =>
          current.map((grant) => (grant.id === changed.id ? changed : grant))
        );
      } else {
        const shared = await client.shareMemory({
          mutationId: crypto.randomUUID(),
          logicalGrantId: crypto.randomUUID(),
          logicalMemoryId: currentEntry.logicalMemoryId,
          teamId,
          workspaceId,
          consentId: consent.id
        });
        setOwnerGrants((current) => [shared, ...current]);
      }
      setPreview(null);
      setWorkflow(null);
    });

  const grantDestination = (grant: SharedMemoryGrant) => {
    const team = availableTeams.find((item) => item.id === grant.teamId);
    const workspace = team?.workspaces.find(
      (item) => item.id === grant.workspaceId
    );
    return {
      team: team?.name ?? "Unavailable Team",
      workspace: workspace?.name ?? "Unavailable Workspace"
    };
  };

  if (destinationInvalid) return null;

  return (
    <Modal label={`Share ${entry.title}`} onClose={onClose}>
      <ModalHeader title={entry.title} onClose={onClose} />
      <div className="collab-form collab-share-memory-form">
        {loadingGrants ? (
          <div className="collab-modal-state" role="status">
            <LoaderCircle className="collab-spin" aria-hidden="true" />
            Loading shared destinations
          </div>
        ) : workflow === null ? (
          <>
            <p className="collab-form-context">
              Manage where this Personal Memory is shared and which level of
              detail each Workspace receives.
            </p>
            {currentEntry.logicalMemoryId &&
            currentEntry.syncState !== "not_started" ? (
              <div className="collab-sync-control">
                <span>
                  Updates:{" "}
                  {currentEntry.syncState === "revoked"
                    ? "stopped"
                    : currentEntry.syncState.replaceAll("_", " ")}
                </span>
                {currentEntry.syncState !== "revoked" ? (
                  stoppingSync ? (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => setStoppingSync(false)}
                      >
                        Keep updates
                      </button>
                      <button
                        type="button"
                        className="danger-secondary"
                        disabled={busy}
                        onClick={() => void stopSync()}
                      >
                        Confirm stop updates
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void toggleSync()}
                      >
                        {currentEntry.syncState === "paused"
                          ? "Resume updates"
                          : currentEntry.syncState === "failed"
                            ? "Retry updates"
                            : "Pause updates"}
                      </button>
                      <button
                        type="button"
                        className="danger-secondary"
                        disabled={busy}
                        onClick={() => setStoppingSync(true)}
                      >
                        Stop updates
                      </button>
                    </>
                  )
                ) : null}
              </div>
            ) : null}
            {ownerGrants.length === 0 ? (
              <div className="collab-empty-inline">Not shared yet.</div>
            ) : (
              <ol
                className="collab-owner-grant-list"
                aria-label="Shared destinations"
              >
                {ownerGrants.map((grant) => {
                  const destination = grantDestination(grant);
                  const active = grant.lifecycle === "active";
                  const recoverable = grant.lifecycle === "unavailable";
                  return (
                    <li key={grant.id} className="collab-owner-grant-row">
                      <div>
                        <strong>{destination.workspace}</strong>
                        <span>{destination.team}</span>
                        <small>
                          {active && grant.activeRepresentation
                            ? representationLabel(grant.activeRepresentation)
                            : recoverable
                              ? "Sharing unavailable"
                              : "Sharing stopped"}
                        </small>
                      </div>
                      {active || recoverable ? (
                        <div className="collab-owner-grant-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => beginRepresentationChange(grant)}
                          >
                            {recoverable ? "Review detail" : "Change detail"}
                          </button>
                          {revokingGrantId === grant.id ? (
                            <>
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() => setRevokingGrantId(null)}
                              >
                                Keep sharing
                              </button>
                              <button
                                type="button"
                                className="danger-secondary"
                                disabled={busy}
                                onClick={() => void stopSharing(grant)}
                              >
                                Confirm stop
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="danger-secondary"
                              disabled={busy}
                              onClick={() => setRevokingGrantId(grant.id)}
                            >
                              Stop sharing
                            </button>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        ) : preview ? (
          <>
            <div className="collab-share-summary">
              <strong>{representationLabel(preview.representation)}</strong>
              <span>
                {preview.itemCount} {preview.itemCount === 1 ? "item" : "items"}
              </span>
            </div>
            <ol className="collab-source-list collab-preview-list">
              {preview.items.map((item) => (
                <SourceItemRow key={item.id} item={item} />
              ))}
            </ol>
            {preview.nextCursor ? (
              <button
                type="button"
                className="secondary"
                onClick={() => void loadMore()}
                disabled={busy}
              >
                Load more
              </button>
            ) : null}
            <fieldset>
              <legend>Updates</legend>
              <label className="collab-check">
                <input
                  type="radio"
                  checked={mode === "continuous"}
                  onChange={() => setMode("continuous")}
                />
                Keep this shared source up to date
              </label>
              <label className="collab-check">
                <input
                  type="radio"
                  checked={mode === "snapshot"}
                  onChange={() => setMode("snapshot")}
                />
                Share only this revision
              </label>
            </fieldset>
          </>
        ) : (
          <>
            <p className="collab-form-context">
              {workflow.kind === "change"
                ? `${grantDestination(workflow.grant).team} · ${grantDestination(workflow.grant).workspace}`
                : `${entry.projectName ?? "Personal Memory"} · ${entry.preview}`}
            </p>
            {availableTeams.length === 0 ? (
              <p className="collab-form-error" role="alert">
                Connect to a Team before sharing Personal Memory.
              </p>
            ) : (
              <>
                {workflow.kind === "new" ? (
                  <>
                    <label>
                      Team
                      <select
                        value={teamId}
                        onChange={(event) => {
                          const nextTeam = availableTeams.find(
                            (team) => team.id === event.currentTarget.value
                          );
                          setTeamId(event.currentTarget.value);
                          setWorkspaceId(
                            nextTeam?.workspaces.find(
                              (workspace) => workspace.lifecycle === "active"
                            )?.id ?? ""
                          );
                          setPreview(null);
                        }}
                      >
                        {availableTeams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Workspace
                      <select
                        value={workspaceId}
                        onChange={(event) => {
                          setWorkspaceId(event.currentTarget.value);
                          setPreview(null);
                        }}
                      >
                        {workspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedDestinationGrant?.lifecycle === "active" ? (
                      <p className="collab-form-error" role="alert">
                        This Workspace already has this Shared Memory. Manage
                        its detail from the shared destinations list.
                      </p>
                    ) : selectedDestinationGrant?.lifecycle === "revoked" ? (
                      <p className="collab-form-context">
                        Sharing was stopped for this Workspace. New consent will
                        restore the existing share and its discussion.
                      </p>
                    ) : null}
                  </>
                ) : null}
                <fieldset>
                  <legend>Shared detail</legend>
                  {SHARED_MEMORY_REPRESENTATIONS.map((value) => (
                    <label key={value} className="collab-check">
                      <input
                        type="radio"
                        checked={representation === value}
                        disabled={
                          workflow.kind === "change" &&
                          workflow.grant.activeRepresentation === value
                        }
                        onChange={() => {
                          setRepresentation(value);
                          setPreview(null);
                        }}
                      />
                      {representationLabel(value)}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
          </>
        )}
        {error ? (
          <p className="collab-form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="collab-modal-actions">
          {workflow === null ? (
            <>
              <button type="button" className="secondary" onClick={onClose}>
                Close
              </button>
              <button type="button" disabled={busy} onClick={beginNewShare}>
                Share with another Workspace
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (ownerGrants.length > 0) {
                    setPreview(null);
                    setWorkflow(null);
                    setError("");
                  } else {
                    onClose();
                  }
                }}
              >
                {ownerGrants.length > 0 ? "Back" : "Cancel"}
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !teamId ||
                  !workspaceId ||
                  availableTeams.length === 0 ||
                  (workflow.kind === "new" &&
                    selectedDestinationGrant?.lifecycle === "active") ||
                  (workflow.kind === "change" &&
                    workflow.grant.activeRepresentation === representation)
                }
                onClick={() =>
                  void (preview ? confirmShare() : prepareAndPreview())
                }
              >
                {busy
                  ? "Working..."
                  : preview
                    ? workflow.kind === "change"
                      ? "Consent and replace"
                      : selectedDestinationGrant?.lifecycle === "revoked"
                        ? "Consent and restore"
                        : "Consent and share"
                    : "Review source"}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  );
}

function ModalLayer({
  client,
  modal,
  snapshot,
  onClose,
  onOpen
}: {
  client: CollaborationRendererClient;
  modal: CollaborationModalState;
  snapshot: CollaborationSnapshot;
  onClose: () => void;
  onOpen: (modal: CollaborationModalState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (
      modal.kind === "connection" &&
      (snapshot.connection.state === "live" ||
        snapshot.connection.state === "disconnected")
    ) {
      setError("");
    }
  }, [modal.kind, snapshot.connection.state]);
  const submit = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      onClose();
    } catch (cause) {
      setError(failureMessage(cause, "The collaboration request failed."));
    } finally {
      setBusy(false);
    }
  };
  const value = (form: HTMLFormElement, name: string) =>
    normalizedText(new FormData(form).get(name)?.toString() ?? "");
  const validateName = (name: string) => {
    if (!name) return "Enter a name.";
    if (codePointLength(name) > snapshot.limits.nameMaxNormalizedCodePoints) {
      return `Names can be at most ${snapshot.limits.nameMaxNormalizedCodePoints} characters.`;
    }
    return "";
  };
  const validateTopic = (topic: string) => {
    if (utf8ByteLength(topic) > snapshot.limits.topicDescriptionMaxUtf8Bytes) {
      return `Topics can be at most ${snapshot.limits.topicDescriptionMaxUtf8Bytes} bytes.`;
    }
    return "";
  };
  const formError = error ? (
    <p className="collab-form-error" role="alert">
      {error}
    </p>
  ) : null;

  if (modal.kind === "share_personal_memory") {
    const entry = snapshot.navigation.personal.memory.find(
      (candidate) => candidate.id === modal.sessionId
    );
    return entry ? (
      <SharedMemoryOwnerModal
        client={client}
        entry={entry}
        snapshot={snapshot}
        onClose={onClose}
      />
    ) : (
      <Modal label="Personal Memory unavailable" onClose={onClose}>
        <ModalHeader title="Personal Memory unavailable" onClose={onClose} />
        <div className="collab-modal-state">
          This source is no longer available.
        </div>
      </Modal>
    );
  }

  if (modal.kind === "create_or_join") {
    return (
      <Modal label="Create or join a Team" onClose={onClose}>
        <ModalHeader title="Create or join a Team" onClose={onClose} />
        <div className="collab-command-list">
          <button type="button" onClick={() => onOpen({ kind: "create_team" })}>
            <UsersRound aria-hidden="true" />
            <span>
              <strong>Create a Team</strong>
            </span>
          </button>
          <button type="button" onClick={() => onOpen({ kind: "join_team" })}>
            <UserPlus aria-hidden="true" />
            <span>
              <strong>Join a Team</strong>
            </span>
          </button>
        </div>
      </Modal>
    );
  }

  const form = (
    title: string,
    children: ReactNode,
    onSubmit: (form: HTMLFormElement) => Promise<unknown>
  ) => (
    <Modal label={title} onClose={onClose}>
      <ModalHeader title={title} onClose={onClose} />
      <form
        className="collab-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void submit(() => onSubmit(event.currentTarget));
        }}
      >
        {children}
        {formError}
        <footer className="collab-modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Working..." : title}
          </button>
        </footer>
      </form>
    </Modal>
  );

  if (modal.kind === "create_team") {
    return form(
      "Create a Team",
      <>
        <label>
          Team name
          <input name="name" autoComplete="off" />
        </label>
        <p className="collab-form-context">
          A default Workspace and #general are created automatically.
        </p>
      </>,
      async (target) => {
        const name = value(target, "name");
        const issue = validateName(name);
        if (issue) throw new CollaborationInputError(issue);
        return client.createTeam({ name });
      }
    );
  }
  if (modal.kind === "join_team") {
    return form(
      "Join a Team",
      <label>
        Invitation
        <input name="invitation" autoComplete="off" />
      </label>,
      (target) => client.joinTeam({ invitation: value(target, "invitation") })
    );
  }
  if (modal.kind === "personal_channel") {
    return form(
      "Create Personal channel",
      <>
        <label>
          Name
          <input name="name" autoComplete="off" />
        </label>
        <label>
          Topic
          <textarea name="topic" />
        </label>
      </>,
      async (target) => {
        const name = value(target, "name");
        const issue = validateName(name);
        if (issue) throw new CollaborationInputError(issue);
        const topic = value(target, "topic");
        const topicIssue = validateTopic(topic);
        if (topicIssue) throw new CollaborationInputError(topicIssue);
        return client.createPersonalChannel({ name, topic: topic || null });
      }
    );
  }
  if (
    modal.kind === "edit_personal_channel" ||
    modal.kind === "edit_workspace_channel"
  ) {
    const workspace =
      modal.kind === "edit_workspace_channel"
        ? snapshot.navigation.teams
            .find((team) => team.id === modal.teamId)
            ?.workspaces.find(
              (candidate) =>
                candidate.id === modal.workspaceId &&
                candidate.access === "write"
            )
        : null;
    const channel =
      modal.kind === "edit_personal_channel"
        ? snapshot.navigation.personal.channels.find(
            (thread) =>
              thread.id === modal.threadId && thread.kind === "personal_channel"
          )
        : workspace?.channels.find(
            (thread) =>
              thread.id === modal.threadId &&
              thread.kind === "workspace_channel"
          );
    const channelKind =
      modal.kind === "edit_personal_channel" ? "Personal" : "Workspace";
    if (!channel || channel.lifecycle !== "active") {
      return (
        <Modal label={`${channelKind} channel unavailable`} onClose={onClose}>
          <ModalHeader
            title={`${channelKind} channel unavailable`}
            onClose={onClose}
          />
          <div className="collab-modal-state">
            This channel is no longer available.
          </div>
        </Modal>
      );
    }
    const currentChannel = () =>
      modal.kind === "edit_personal_channel"
        ? client
            .current()
            ?.navigation.personal.channels.find(
              (thread) =>
                thread.id === modal.threadId &&
                thread.kind === "personal_channel"
            )
        : client
            .current()
            ?.navigation.teams.find((team) => team.id === modal.teamId)
            ?.workspaces.find((candidate) => candidate.id === modal.workspaceId)
            ?.channels.find(
              (thread) =>
                thread.id === modal.threadId &&
                thread.kind === "workspace_channel"
            );
    return (
      <Modal label={`Edit ${channel.name}`} onClose={onClose}>
        <ModalHeader title={`${channelKind} channel`} onClose={onClose} />
        <form
          className="collab-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = event.currentTarget;
            void submit(async () => {
              const name = value(target, "name");
              const topic = value(target, "topic");
              const issue = validateName(name) || validateTopic(topic);
              if (issue) throw new CollaborationInputError(issue);
              let current = channel;
              if (name !== channel.name) {
                await client.renameThread({ thread: current, name });
                current = currentChannel() ?? current;
              }
              if (topic !== (channel.topic ?? "")) {
                await client.updateThreadTopic({
                  thread: current,
                  topic: topic || null
                });
              }
            });
          }}
        >
          <label>
            Name
            <input
              name="name"
              defaultValue={channel.name ?? ""}
              autoComplete="off"
            />
          </label>
          <label>
            Topic
            <textarea name="topic" defaultValue={channel.topic ?? ""} />
          </label>
          {formError}
          <footer className="collab-modal-actions">
            <button
              type="button"
              className="danger-secondary"
              disabled={busy}
              onClick={() =>
                void submit(async () => {
                  await client.archiveThread({ thread: channel });
                  await client.select(
                    modal.kind === "edit_personal_channel"
                      ? { kind: "notes_to_self" }
                      : {
                          kind: "workspace_shared_memory",
                          teamId: modal.teamId,
                          workspaceId: modal.workspaceId
                        }
                  );
                })
              }
            >
              <Archive aria-hidden="true" /> Archive
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={busy}>
              {busy ? "Working..." : "Save changes"}
            </button>
          </footer>
        </form>
      </Modal>
    );
  }
  if (modal.kind === "workspace_channel") {
    return form(
      "Create channel",
      <>
        <label>
          Name
          <input name="name" autoComplete="off" />
        </label>
        <label>
          Topic
          <textarea name="topic" />
        </label>
      </>,
      async (target) => {
        const name = value(target, "name");
        const issue = validateName(name);
        if (issue) throw new CollaborationInputError(issue);
        const topic = value(target, "topic");
        const topicIssue = validateTopic(topic);
        if (topicIssue) throw new CollaborationInputError(topicIssue);
        return client.createWorkspaceChannel({
          teamId: modal.teamId,
          workspaceId: modal.workspaceId,
          name,
          topic: topic || null
        });
      }
    );
  }
  if (modal.kind === "direct_message") {
    const team = snapshot.navigation.teams.find(
      (item) => item.id === modal.teamId
    );
    const people =
      team?.people.filter(
        (person) =>
          person.id !== teamPrincipalId(snapshot) &&
          person.membershipState === "enabled"
      ) ?? [];
    return form(
      modal.group ? "Start group message" : "Start direct message",
      modal.group ? (
        <fieldset>
          <legend>People</legend>
          {people.map((person) => (
            <label key={person.id} className="collab-check">
              <input type="checkbox" name="personIds" value={person.id} />
              {person.displayName}
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <label>
            Person
            <select name="personId">
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              onOpen({
                kind: "direct_message",
                teamId: modal.teamId,
                group: true
              })
            }
          >
            <UsersRound aria-hidden="true" /> Group message
          </button>
        </>
      ),
      (target) => {
        if (modal.group) {
          const participantUserIds = new FormData(target)
            .getAll("personIds")
            .map(String);
          return client.startGroupDirectMessage({
            teamId: modal.teamId,
            participantUserIds
          });
        }
        return client.startDirectMessage({
          teamId: modal.teamId,
          participantUserId: value(target, "personId")
        });
      }
    );
  }

  const state = snapshot.connection.state;
  return (
    <Modal label="Connection" onClose={onClose}>
      <ModalHeader title="Connection" onClose={onClose} />
      <form
        className="collab-form"
        onSubmit={(event) => {
          event.preventDefault();
          const remoteUrl = value(event.currentTarget, "remoteUrl");
          void submit(() => client.connectRemote({ remoteUrl }));
        }}
      >
        <div className={`collab-connection-state ${state}`}>
          <Network aria-hidden="true" />
          <span>
            <strong>
              {state === "live" ? "Connected" : state.replaceAll("_", " ")}
            </strong>
            <small>Personal collaboration remains local and available.</small>
          </span>
        </div>
        <label>
          Remote URL
          <input
            name="remoteUrl"
            type="url"
            defaultValue={client.currentRemoteUrl() ?? ""}
            placeholder="https://team.example.com"
            autoComplete="url"
          />
        </label>
        {state === "live" ? (
          <p className="collab-form-context">
            Changing backend clears Team state on this device. Personal content
            remains available.
          </p>
        ) : null}
        {formError}
        <footer className="collab-modal-actions connection-actions">
          {state !== "disconnected" ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void submit(() => client.disconnect())}
            >
              Disconnect
            </button>
          ) : null}
          {state !== "live" && snapshot.connection.backendId ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void submit(() => client.reconnect())}
            >
              Reconnect
            </button>
          ) : null}
          <button type="submit" disabled={busy}>
            {busy
              ? state === "live"
                ? "Changing..."
                : "Connecting..."
              : state === "live"
                ? "Change backend"
                : "Connect"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function MainContent({
  client,
  drafts,
  markdownAdapters,
  snapshot,
  onEditChannel,
  onSharePersonalMemory,
  onSelect
}: {
  client: CollaborationRendererClient;
  drafts: CollaborationDrafts;
  markdownAdapters: MarkdownPlatformAdapters;
  snapshot: CollaborationSnapshot;
  onEditChannel: (threadId: string) => void;
  onSharePersonalMemory: (sessionId: string) => void;
  onSelect: (selection: CollaborationSelection) => void;
}) {
  const teamId = selectionTeamId(snapshot.selection);
  const team = teamId
    ? snapshot.navigation.teams.find((item) => item.id === teamId)
    : null;
  if (teamId && !team) {
    return (
      <StateView
        icon={<LockKeyhole />}
        title="Access revoked"
        message="This Team is no longer available."
      />
    );
  }
  if (team && team.lifecycle !== "active") {
    const lifecycleState =
      team.lifecycle === "suspended"
        ? {
            title: "Team access suspended",
            message: "Team content is unavailable while access is suspended."
          }
        : team.lifecycle === "deletion_requested" ||
            team.lifecycle === "tombstoned"
          ? {
              title: "Team deletion in progress",
              message: "Team content is blocked while deletion is processed."
            }
          : {
              title: "Access revoked",
              message: "This Team is no longer available."
            };
    return (
      <StateView
        icon={<CircleAlert />}
        role="alert"
        title={lifecycleState.title}
        message={lifecycleState.message}
      />
    );
  }
  const workspaceId =
    "workspaceId" in snapshot.selection ? snapshot.selection.workspaceId : null;
  const workspace = workspaceId
    ? team?.workspaces.find((item) => item.id === workspaceId)
    : null;
  if (workspaceId && (!workspace || workspace.lifecycle !== "active")) {
    return (
      <StateView
        icon={<Archive />}
        role="alert"
        title={workspace ? "Workspace archived" : "Workspace unavailable"}
        message="This Workspace content is not currently available."
      />
    );
  }
  if (
    team &&
    snapshot.connection.state !== "live" &&
    snapshot.connection.state !== "connecting" &&
    snapshot.connection.state !== "reconnecting"
  ) {
    return (
      <StateView
        icon={<CloudOff />}
        title="Team unavailable"
        message="Personal Memory, notes, and Personal channels remain available."
      />
    );
  }
  switch (snapshot.view.kind) {
    case "empty":
      return <StateView icon={<CircleAlert />} title="Nothing selected" />;
    case "personal_memory":
      return (
        <PersonalMemoryView
          snapshot={snapshot}
          onShare={onSharePersonalMemory}
        />
      );
    case "thread":
      return (
        <ThreadRoute
          client={client}
          drafts={drafts}
          markdownAdapters={markdownAdapters}
          onEditChannel={
            snapshot.view.thread.kind === "personal_channel" ||
            (snapshot.view.thread.kind === "workspace_channel" &&
              workspace?.access === "write")
              ? onEditChannel
              : undefined
          }
          snapshot={snapshot}
          thread={snapshot.view.thread}
          page={snapshot.view.messages}
        />
      );
    case "team_people":
      return (
        <PeopleView
          client={client}
          snapshot={snapshot}
          onSelectWorkspace={(selectedWorkspaceId) => {
            const selectedWorkspace = team?.workspaces.find(
              (candidate) => candidate.id === selectedWorkspaceId
            );
            const firstChannel = selectedWorkspace?.channels[0];
            onSelect(
              firstChannel
                ? {
                    kind: "workspace_channel",
                    teamId: team!.id,
                    workspaceId: selectedWorkspaceId,
                    threadId: firstChannel.id
                  }
                : {
                    kind: "workspace_shared_memory",
                    teamId: team!.id,
                    workspaceId: selectedWorkspaceId
                  }
            );
          }}
        />
      );
    case "shared_memory_index":
      return <SharedMemoryIndex snapshot={snapshot} onSelect={onSelect} />;
    case "shared_session":
      return (
        <SharedSessionView
          client={client}
          drafts={drafts}
          markdownAdapters={markdownAdapters}
          snapshot={snapshot}
        />
      );
  }
}

export type CollaborationSelectionFailure = {
  message: string;
  retryable: boolean;
  selection: CollaborationSelection;
};

export type CollaborationRoutesProps = {
  client: CollaborationRendererClient;
  drafts: CollaborationDrafts & {
    reconcileAuthorized?: (
      isAuthorized: (authority: DraftAuthority) => boolean
    ) => void;
  };
  markdownAdapters: MarkdownPlatformAdapters;
  modal?: CollaborationModalState | null;
  onModalChange: (modal: CollaborationModalState | null) => void;
  onRequestSelection: (selection: CollaborationSelection) => void;
  selectionFailure?: CollaborationSelectionFailure | null;
  snapshot: CollaborationSnapshot;
};

const threadForDraftAuthority = (
  snapshot: CollaborationSnapshot,
  authority: DraftAuthority
): CollaborationThread | null => {
  if (authority.scope === "personal") {
    if (authority.principalId !== snapshot.navigation.personalOwner.id) {
      return null;
    }
    return (
      [
        snapshot.navigation.personal.notesToSelf,
        ...snapshot.navigation.personal.channels
      ].find((thread) => thread.id === authority.threadId) ?? null
    );
  }
  if (
    authority.backendId !== snapshot.connection.backendId ||
    authority.principalId !== snapshot.navigation.teamPrincipal?.id
  ) {
    return null;
  }
  const team = snapshot.navigation.teams.find(
    (candidate) =>
      candidate.id === authority.teamId && candidate.lifecycle === "active"
  );
  if (!team) return null;
  const directMessage = team.directMessages.find(
    (thread) => thread.id === authority.threadId
  );
  if (directMessage) return directMessage;
  const workspace = authority.workspaceId
    ? team.workspaces.find(
        (candidate) =>
          candidate.id === authority.workspaceId &&
          candidate.lifecycle === "active"
      )
    : null;
  const channel = workspace?.channels.find(
    (thread) => thread.id === authority.threadId
  );
  if (channel) return channel;
  if (
    snapshot.view.kind === "shared_session" &&
    snapshot.view.companion.thread.id === authority.threadId &&
    snapshot.view.companion.thread.teamId === authority.teamId &&
    snapshot.view.companion.thread.workspaceId === authority.workspaceId
  ) {
    return snapshot.view.companion.thread;
  }
  return null;
};

export function CollaborationRoutes({
  client,
  drafts,
  markdownAdapters,
  onModalChange,
  onRequestSelection,
  selectionFailure = null,
  snapshot
}: CollaborationRoutesProps) {
  const lastActivityReportAt = useRef(0);

  useEffect(() => {
    const teamIds = snapshot.navigation.teams
      .filter((team) => team.lifecycle === "active")
      .map((team) => team.id);
    if (teamIds.length === 0) return;
    const report = () => {
      if (
        document.visibilityState !== "visible" ||
        Date.now() - lastActivityReportAt.current <
          TEAM_ACTIVITY_WRITE_THROTTLE_MS
      ) {
        return;
      }
      lastActivityReportAt.current = Date.now();
      void client.reportTeamActivity(teamIds).catch(() => {
        lastActivityReportAt.current = 0;
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") report();
    };
    window.addEventListener("pointerdown", report, { capture: true });
    window.addEventListener("keydown", report, { capture: true });
    window.addEventListener("focus", report);
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible" && document.hasFocus()) {
      report();
    }
    return () => {
      window.removeEventListener("pointerdown", report, { capture: true });
      window.removeEventListener("keydown", report, { capture: true });
      window.removeEventListener("focus", report);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, snapshot.navigation.teams]);

  useEffect(() => {
    drafts.reconcileAuthorized?.((authority) => {
      const thread = threadForDraftAuthority(snapshot, authority);
      return Boolean(
        thread &&
        thread.lifecycle === "active" &&
        thread.canPost &&
        draftAuthorityForThread(snapshot, thread)
      );
    });
  }, [drafts, snapshot]);

  return (
    <div className="collab-route-root">
      {selectionFailure ? (
        <StateView
          icon={<CircleAlert />}
          role="alert"
          title="Selection unavailable"
          message={selectionFailure.message}
          action={
            selectionFailure.retryable
              ? () => onRequestSelection(selectionFailure.selection)
              : undefined
          }
          actionLabel={selectionFailure.retryable ? "Retry" : undefined}
        />
      ) : (
        <MainContent
          client={client}
          drafts={drafts}
          markdownAdapters={markdownAdapters}
          snapshot={snapshot}
          onEditChannel={(threadId) => {
            if (
              snapshot.view.kind === "thread" &&
              snapshot.view.thread.kind === "workspace_channel"
            ) {
              onModalChange({
                kind: "edit_workspace_channel",
                teamId: snapshot.view.thread.teamId,
                workspaceId: snapshot.view.thread.workspaceId,
                threadId
              });
              return;
            }
            onModalChange({ kind: "edit_personal_channel", threadId });
          }}
          onSharePersonalMemory={(sessionId) =>
            onModalChange({ kind: "share_personal_memory", sessionId })
          }
          onSelect={onRequestSelection}
        />
      )}
    </div>
  );
}

export function CollaborationModalLayer({
  client,
  localPersonalSessionIds = new Set<string>(),
  modal,
  onModalChange,
  snapshot
}: {
  client: CollaborationRendererClient;
  localPersonalSessionIds?: ReadonlySet<string>;
  modal: CollaborationModalState | null;
  onModalChange: (modal: CollaborationModalState | null) => void;
  snapshot: CollaborationSnapshot;
}) {
  const authorizedModal =
    modal && modalIsAuthorized(modal, snapshot, localPersonalSessionIds)
      ? modal
      : null;
  useEffect(() => {
    if (modal && !authorizedModal) onModalChange(null);
  }, [authorizedModal, modal, onModalChange]);
  if (!authorizedModal) return null;
  return (
    <ModalLayer
      key={
        authorizedModal.kind +
        ("teamId" in authorizedModal ? authorizedModal.teamId : "") +
        ("threadId" in authorizedModal ? authorizedModal.threadId : "")
      }
      client={client}
      modal={authorizedModal}
      snapshot={snapshot}
      onClose={() => onModalChange(null)}
      onOpen={onModalChange}
    />
  );
}
