import {
  type CollaborationInvitation,
  type CollaborationSelection,
  type CollaborationSnapshot,
  type CollaborationTeamPerson,
  type CollaborationThread,
  type PersonalMemoryEntry,
  type PendingShare,
  type SharedMemoryCandidatePreview,
  type SharedMemoryGrant,
  type SharedMemoryFidelityCeiling,
  type SharedMemoryPreview,
  type SharedMemoryRepresentation,
  type SharedMemorySession,
  type SharedMemorySourceItem,
  type SharedMemorySourcePage,
  deriveTeamPresenceSnapshot
} from "@koed/shared/collaboration";
import type { PersonalDesktopNote } from "@koed/shared/personal-desktop";
import {
  LcmSummaryFrame,
  MemoryEventFrame,
  MemorySourceParts,
  SecureMarkdown,
  VirtualizedTimeline,
  type MarkdownPlatformAdapters
} from "@koed/memory-ui";

type BoundSharedMemoryCandidatePreview = SharedMemoryCandidatePreview & {
  source: NonNullable<SharedMemoryCandidatePreview["source"]>;
};
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
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ToolCase,
  Trash2,
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
import { sharedMemoryConversationEvents } from "../../collaboration/shared-memory-conversation.js";
import {
  ConversationRows,
  ConversationTimeline
} from "../../NativeConversationSurface.js";
import { teamDiscIndex, teamInitials } from "../shell/AppShell.js";
import { SharesStatusView } from "../views/personal/SharesStatusView.js";
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
  | { kind: "workspace"; teamId: string }
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
  | {
      kind: "share_personal_memory";
      localEntry?: PersonalMemoryEntry;
      sessionId: string;
    }
  | {
      kind: "share_personal_note";
      note: PersonalDesktopNote;
    }
  | { kind: "connection" };

export const modalIsAuthorized = (
  modal: CollaborationModalState,
  snapshot: CollaborationSnapshot
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
    const snapshotEntry = snapshot.navigation.personal.memory.some(
      (entry) => entry.id === modal.sessionId
    );
    const localEntry = modal.localEntry;
    return (
      snapshotEntry ||
      Boolean(
        localEntry &&
        localEntry.id === modal.sessionId &&
        localEntry.logicalMemoryId !== null &&
        !localEntry.hasSynchronizedRevision &&
        localEntry.syncState === "not_started"
      )
    );
  }
  if (modal.kind === "share_personal_note") {
    return (
      modal.note.noteId.length > 0 &&
      modal.note.event !== null &&
      modal.note.memoryEventId === modal.note.event.id &&
      modal.note.event.invalidatedAt === null
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
  if (modal.kind === "workspace") {
    return snapshot.navigation.teams.some(
      (team) =>
        team.id === modal.teamId &&
        team.lifecycle === "active" &&
        (team.role === "owner" || team.role === "admin")
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

export const formatShareListTime = (
  value: string,
  now = Date.now()
): string => {
  const date = new Date(value);
  const current = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) {
    return value;
  }
  const sameDay =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === current.getFullYear()
      ? {}
      : { year: "numeric" as const })
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
  if (value === "lcm_leaves") return "LCM Leaves";
  if (value === "lcm_rollups") return "LCM Rollups";
  return "Curated Assertions";
};

const fidelityLabel = (value: SharedMemoryFidelityCeiling): string =>
  `Up to ${representationLabel(value)}`;

const pendingShareStageLabel = (stage: PendingShare["stage"]): string => {
  if (stage === "accepted") return "accepted";
  if (stage === "syncing") return "preparing source";
  if (stage === "uploading") return "uploading source";
  if (stage === "processing") return "privacy filtering";
  if (stage === "activating") return "publishing";
  return "complete";
};

const liveStateLabel = (value: SharedMemorySession["liveState"]): string =>
  value === "live"
    ? "Live"
    : value === "reconnecting"
      ? "Reconnecting"
      : "Ended";

function Modal({
  children,
  className,
  label,
  onClose
}: {
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup
        aria-label={label}
        aria-modal="true"
        className={`collab-modal${className ? ` ${className}` : ""}`}
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
      <div className="collab-modal-title">
        <h2>{title}</h2>
      </div>
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

type OwnedShareItem = Awaited<
  ReturnType<CollaborationRendererClient["listOwnedShares"]>
>["shares"][number];

function PersonalMemoryProjectsView({
  onShare,
  snapshot
}: {
  onShare: (sessionId: string) => void;
  snapshot: CollaborationSnapshot;
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

type OwnedShareSection = "pending" | "active" | "revoked";

const ownedShareRecord = (item: OwnedShareItem) =>
  item.kind === "pending" ? item.pendingShare : item.grant;

const ownedShareKey = (item: OwnedShareItem): string =>
  `${item.kind}:${ownedShareRecord(item).id}`;

const ownedShareRepresentation = (
  item: OwnedShareItem
): SharedMemoryRepresentation | null =>
  item.kind === "pending"
    ? item.pendingShare.activationRepresentation
    : item.grant.activationRepresentation;

const ownedShareSection = (item: OwnedShareItem): OwnedShareSection => {
  if (
    (item.kind === "pending" && item.pendingShare.state === "revoked") ||
    (item.kind === "grant" &&
      ["revoked", "tombstoned", "purge_pending", "purged"].includes(
        item.grant.lifecycle
      ))
  ) {
    return "revoked";
  }
  if (
    (item.kind === "pending" &&
      item.pendingShare.workspaceAccessState === "active") ||
    item.kind === "grant"
  ) {
    return "active";
  }
  return "pending";
};

const ownedShareStatus = (item: OwnedShareItem): string => {
  if (item.kind === "grant") {
    return item.grant.lifecycle === "active"
      ? item.summary.mode === "continuous"
        ? "Sharing updates"
        : "Shared snapshot"
      : item.grant.lifecycle.replaceAll("_", " ");
  }
  if (item.pendingShare.workspaceAccessState === "active") {
    return item.pendingShare.sourceUpdateState === "paused"
      ? "Updates paused"
      : item.pendingShare.sourceUpdateState === "failed"
        ? "Update needs attention"
        : item.summary.mode === "continuous"
          ? "Sharing updates"
          : "Shared snapshot";
  }
  return item.pendingShare.state === "needs_attention"
    ? "Needs attention"
    : item.pendingShare.state.replaceAll("_", " ");
};

const ownedShareHasError = (item: OwnedShareItem): boolean =>
  item.kind === "pending" &&
  (item.pendingShare.redactedFailureCode !== null ||
    item.pendingShare.state === "failed" ||
    item.pendingShare.state === "needs_attention" ||
    item.pendingShare.sourceUpdateState === "failed");

function OwnedSharePreview({
  markdownAdapters,
  preview,
  state,
  authorizedRevision
}: {
  markdownAdapters: MarkdownPlatformAdapters;
  preview: SharedMemoryPreview | SharedMemoryCandidatePreview | null;
  state: "idle" | "loading" | "ready" | "failed";
  authorizedRevision: number | null;
}) {
  if (state === "loading") {
    return (
      <StateView
        icon={<LoaderCircle className="collab-spin" />}
        title="Loading source preview"
      />
    );
  }
  if (state === "failed") {
    return (
      <StateView
        icon={<CircleAlert />}
        title="Source preview unavailable"
        message="The share settings are still available from Modify."
      />
    );
  }
  if (!preview || preview.items.length === 0) {
    return (
      <StateView
        icon={<BookOpen />}
        title="Nothing to preview"
        message="This shared representation does not currently contain previewable items."
      />
    );
  }
  const exact = "previewHash" in preview;
  const revisionChanged =
    !exact &&
    authorizedRevision !== null &&
    authorizedRevision !== preview.sourceRevision;
  return (
    <div className="collab-share-preview-body">
      <p className="collab-share-preview-notice">
        This owner-only view shows your Personal source. Team members receive a
        separately privacy-filtered representation.
      </p>
      {revisionChanged ? (
        <p className="collab-share-preview-notice" role="status">
          This source is now at revision {preview.sourceRevision}. Revision{" "}
          {authorizedRevision} was authorized for this share.
        </p>
      ) : null}
      {preview.activationRepresentation === "memory_events" ? (
        <div className="shared-conversation-preview">
          <ConversationRows
            events={sharedMemoryConversationEvents(preview.items)}
            markdownAdapters={markdownAdapters}
            scope="workspace"
          />
        </div>
      ) : (
        <ol className="collab-source-list collab-owned-share-preview-list">
          {preview.items.map((item) => (
            <SourceItemRow
              item={item}
              key={item.id}
              markdownAdapters={markdownAdapters}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function OwnedSharesWorkspace({
  client,
  initialShareKey,
  markdownAdapters,
  onAvailabilityChange,
  onSelectShare,
  snapshot
}: {
  client: CollaborationRendererClient;
  initialShareKey?: string;
  markdownAdapters: MarkdownPlatformAdapters;
  onAvailabilityChange?: (unavailable: boolean) => void;
  onSelectShare?: (shareKey: string) => void;
  snapshot: CollaborationSnapshot;
}) {
  const [ownedShares, setOwnedShares] = useState<OwnedShareItem[]>([]);
  const [sharesState, setSharesState] = useState<
    "loading" | "ready" | "failed"
  >("loading");

  useEffect(() => {
    onAvailabilityChange?.(sharesState === "failed");
  }, [onAvailabilityChange, sharesState]);
  const [selectedShareKey, setSelectedShareKey] = useState<string | null>(
    initialShareKey ?? null
  );
  const [narrowDetailOpen, setNarrowDetailOpen] = useState(
    Boolean(initialShareKey)
  );
  const [query, setQuery] = useState("");
  const [shareAnnouncement, setShareAnnouncement] = useState("");
  const [shareEventRevision, setShareEventRevision] = useState(0);
  const [modifyShareKey, setModifyShareKey] = useState<string | null>(null);
  const [revokeShareKey, setRevokeShareKey] = useState<string | null>(null);
  const revokeApprovalBaselineRef = useRef<ReadonlySet<string> | null>(null);
  const shareRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastFocusedShareKeyRef = useRef<string | null>(null);
  const shareFocusRestoreKeyRef = useRef<string | null>(null);
  const updatesControlRef = useRef<HTMLButtonElement>(null);
  const restoreUpdatesControlFocusRef = useRef(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [preview, setPreview] = useState<
    SharedMemoryPreview | SharedMemoryCandidatePreview | null
  >(null);
  const [previewState, setPreviewState] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const [loadingMorePreview, setLoadingMorePreview] = useState(false);
  const [sourceSyncState, setSourceSyncState] = useState<
    PersonalMemoryEntry["syncState"] | null
  >(null);
  const [sourceReviewEntry, setSourceReviewEntry] =
    useState<PersonalMemoryEntry | null>(null);
  const [detailChange, setDetailChange] = useState<{
    entry: PersonalMemoryEntry;
    share: OwnedShareItem;
  } | null>(null);
  const detailRequestRef = useRef<{
    key: string;
    promise: ReturnType<CollaborationRendererClient["getOwnedShare"]>;
  } | null>(null);

  useEffect(
    () =>
      client.subscribe((_next, update) => {
        if (
          (update.kind === "realtime" &&
            update.realtimeUpdate?.type === "owned_share_status_changed") ||
          update.authoritativeRecovery === true
        ) {
          for (const [shareKey, row] of shareRowRefs.current) {
            if (row === document.activeElement) {
              shareFocusRestoreKeyRef.current = shareKey;
              break;
            }
          }
          if (
            !shareFocusRestoreKeyRef.current &&
            document.activeElement instanceof HTMLElement &&
            document.activeElement.matches("[data-route-focus='main']")
          ) {
            shareFocusRestoreKeyRef.current = lastFocusedShareKeyRef.current;
          }
          setShareEventRevision((revision) => revision + 1);
        }
      }),
    [client]
  );

  useEffect(() => {
    let active = true;
    const loadAllPages = async (history: boolean) => {
      const shares: OwnedShareItem[] = [];
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const page = await client.listOwnedShares({
          cursor,
          limit: 100,
          history
        });
        shares.push(...page.shares);
        if (!page.nextCursor) return shares;
        cursor = page.nextCursor;
      }
      throw new Error(
        "Owned Shares pagination exceeded its bounded page limit"
      );
    };
    const loadShares = async () => {
      try {
        const [current, history] = await Promise.all([
          loadAllPages(false),
          loadAllPages(true)
        ]);
        if (!active) return;
        const nextShares = [
          ...new Map(
            [...current, ...history].map((item) => [ownedShareKey(item), item])
          ).values()
        ].sort(
          (left, right) =>
            Date.parse(ownedShareRecord(right).updatedAt) -
              Date.parse(ownedShareRecord(left).updatedAt) ||
            ownedShareKey(right).localeCompare(ownedShareKey(left))
        );
        setOwnedShares((priorShares) => {
          const prior = new Map(
            priorShares.map((item) => [ownedShareKey(item), item])
          );
          const changed = nextShares.find((item) => {
            const previous = prior.get(ownedShareKey(item));
            return (
              previous && ownedShareStatus(previous) !== ownedShareStatus(item)
            );
          });
          if (changed) {
            setShareAnnouncement(
              `${changed.summary.sourceTitle}: ${ownedShareStatus(changed)}`
            );
          }
          return nextShares.map((item) => {
            const previous = prior.get(ownedShareKey(item));
            return previous?.preview &&
              previous.summary.authorizedPreview?.previewHash ===
                item.summary.authorizedPreview?.previewHash
              ? { ...item, preview: previous.preview }
              : item;
          });
        });
        setSharesState("ready");
      } catch {
        if (active) setSharesState("failed");
      }
    };
    void loadShares();
    return () => {
      active = false;
    };
  }, [client, shareEventRevision, snapshot.snapshotRevision]);

  useEffect(() => {
    const shareKey = shareFocusRestoreKeyRef.current;
    if (!shareKey) return;
    const row = shareRowRefs.current.get(shareKey);
    if (!row) return;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement !== row &&
      activeElement.isConnected &&
      !activeElement.matches("[data-route-focus='main']")
    ) {
      shareFocusRestoreKeyRef.current = null;
      return;
    }
    row.focus();
    shareFocusRestoreKeyRef.current = null;
  }, [ownedShares, sharesState]);

  useEffect(() => {
    setNarrowDetailOpen(Boolean(initialShareKey));
    if (initialShareKey) setSelectedShareKey(initialShareKey);
  }, [initialShareKey]);

  useEffect(() => {
    if (ownedShares.length === 0) {
      if (sharesState === "ready") setSelectedShareKey(null);
      return;
    }
    if (
      !selectedShareKey ||
      !ownedShares.some((item) => ownedShareKey(item) === selectedShareKey)
    ) {
      setSelectedShareKey(ownedShareKey(ownedShares[0]!));
    }
  }, [initialShareKey, ownedShares, selectedShareKey, sharesState]);

  const selectedShare = ownedShares.find(
    (item) => ownedShareKey(item) === selectedShareKey
  );
  const selectedSharePreviewRevision = selectedShare
    ? `${selectedShare.summary.authorizedPreview?.previewHash ?? "none"}:${ownedShareRecord(selectedShare).sourceRevision}`
    : "none";

  useEffect(() => {
    if (!selectedShareKey) {
      setPreview(null);
      setPreviewState("idle");
      return;
    }
    const separator = selectedShareKey.indexOf(":");
    const kind = selectedShareKey.slice(0, separator);
    const id = selectedShareKey.slice(separator + 1);
    const listedShare = ownedShares.find(
      (item) => ownedShareKey(item) === selectedShareKey
    );
    if ((kind !== "pending" && kind !== "grant") || !id || !listedShare) {
      return;
    }
    let active = true;
    setPreview(listedShare.preview ?? null);
    setPreviewState("loading");
    setSourceSyncState(
      listedShare.summary.sourceSessionId
        ? (snapshot.navigation.personal.memory.find(
            (entry) => entry.id === listedShare.summary.sourceSessionId
          )?.syncState ?? null)
        : null
    );
    if (listedShare.summary.workspaceContentAccess === "unavailable") {
      setPreview(null);
      setPreviewState("ready");
      return;
    }
    const requestKey = `${selectedShareKey}:${listedShare.summary.authorizedPreview?.previewHash ?? "none"}`;
    const request =
      detailRequestRef.current?.key === requestKey
        ? detailRequestRef.current.promise
        : client.getOwnedShare({ kind, id });
    detailRequestRef.current = { key: requestKey, promise: request };
    void request
      .then(async (detail) => {
        if (!active) return;
        setOwnedShares((current) =>
          current.map((item) =>
            ownedShareKey(item) === selectedShareKey ? detail : item
          )
        );
        if (detail.preview) {
          setPreview(detail.preview);
          setPreviewState("ready");
          return;
        }
        const representation = ownedShareRepresentation(detail);
        const record = ownedShareRecord(detail);
        if (!record.source || !representation) {
          setPreview(null);
          setPreviewState("failed");
          return;
        }
        const candidate = await client.previewSharedMemoryCandidate({
          source: record.source,
          activationRepresentation: representation,
          mode: record.mode
        });
        if (!active) return;
        setPreview(candidate);
        setPreviewState("ready");
      })
      .catch(() => {
        if (!active) return;
        setPreview(null);
        setPreviewState("failed");
      })
      .finally(() => {
        if (detailRequestRef.current?.promise === request) {
          detailRequestRef.current = null;
        }
      });
    return () => {
      active = false;
    };
  }, [
    client,
    selectedShareKey,
    selectedSharePreviewRevision,
    snapshot.snapshotRevision
  ]);

  const runOperation = useCallback(async (operation: () => Promise<void>) => {
    setOperationBusy(true);
    setOperationError("");
    try {
      await operation();
    } catch (cause) {
      setOperationError(
        failureMessage(cause, "The share could not be updated.")
      );
    } finally {
      setOperationBusy(false);
    }
  }, []);

  useEffect(() => {
    if (operationBusy || !restoreUpdatesControlFocusRef.current) return;
    restoreUpdatesControlFocusRef.current = false;
    updatesControlRef.current?.focus();
  }, [modifyShareKey, operationBusy, ownedShares, sourceSyncState]);

  useEffect(() => {
    if (!client.subscribeActionGrants || !client.currentActionGrants) return;
    return client.subscribeActionGrants(() => {
      const baseline = revokeApprovalBaselineRef.current;
      if (!baseline) return;
      const approvedRevoke = client
        .currentActionGrants?.()
        .find(
          (grant) =>
            !baseline.has(grant.id) &&
            grant.operation === "Revoke Shared Memory" &&
            ["approved", "executing", "completed"].includes(grant.state)
        );
      if (!approvedRevoke) return;
      revokeApprovalBaselineRef.current = null;
      setRevokeShareKey(null);
    });
  }, [client]);

  const openSourceReview = useCallback(
    async (sessionId: string) => {
      await runOperation(async () => {
        const entry =
          snapshot.navigation.personal.memory.find(
            (candidate) => candidate.id === sessionId
          ) ?? (await client.prepareSharedMemorySource({ sessionId }));
        setSourceReviewEntry(entry);
        setModifyShareKey(null);
      });
    },
    [client, runOperation, snapshot.navigation.personal.memory]
  );

  const openDetailChange = useCallback(
    async (share: OwnedShareItem) => {
      if (share.summary.workspaceContentAccess === "unavailable") {
        setOperationError(
          "Workspace access is unavailable. You can still revoke this Share."
        );
        return;
      }
      const sessionId = share.summary.sourceSessionId;
      const shareGrantId =
        share.kind === "grant" ? share.grant.id : share.pendingShare.grantId;
      const representation = ownedShareRepresentation(share);
      if (!sessionId || !shareGrantId || !representation) {
        setOperationError("This Share is not ready for a detail change.");
        return;
      }
      await runOperation(async () => {
        const entry =
          snapshot.navigation.personal.memory.find(
            (candidate) => candidate.id === sessionId
          ) ?? (await client.prepareSharedMemorySource({ sessionId }));
        setDetailChange({ entry, share });
        setModifyShareKey(null);
      });
    },
    [client, runOperation, snapshot.navigation.personal.memory]
  );

  const loadMorePreview = useCallback(async () => {
    if (!preview || !("previewHash" in preview) || !preview.nextCursor) return;
    setLoadingMorePreview(true);
    try {
      const page = await client.loadSharedMemoryPreviewPage({
        previewHash: preview.previewHash,
        cursor: preview.nextCursor
      });
      const items = new Map(preview.items.map((item) => [item.id, item]));
      for (const item of page.items) items.set(item.id, item);
      setPreview({ ...page, items: [...items.values()] });
    } catch (cause) {
      setOperationError(
        failureMessage(cause, "More shared preview items could not be loaded.")
      );
    } finally {
      setLoadingMorePreview(false);
    }
  }, [client, preview]);

  const controlConversationSource = useCallback(
    async (
      item: OwnedShareItem,
      action: "snapshot" | "continuous" | "revoke"
    ) => {
      const share = ownedShareRecord(item);
      const shareGrantId =
        item.kind === "pending" ? item.pendingShare.grantId : item.grant.id;
      if (!shareGrantId) return;
      const sourceAccess =
        action === "revoke"
          ? await client.revokeConversationSource({
              teamId: share.teamId,
              shareGrantId,
              expectedVersion: item.sourceAccess?.version ?? 1,
              reasonCode: "owner_revoked"
            })
          : await client.shareConversationSource({
              teamId: share.teamId,
              shareGrantId,
              expectedVersion: item.sourceAccess?.version ?? 0,
              mode: action
            });
      setOwnedShares(
        (current) =>
          current.map((currentItem) =>
            ownedShareKey(currentItem) === ownedShareKey(item)
              ? {
                  ...currentItem,
                  sourceAccess: {
                    mode: sourceAccess.mode,
                    lifecycle: sourceAccess.lifecycle,
                    version: sourceAccess.version
                  }
                }
              : currentItem
          ) as OwnedShareItem[]
      );
    },
    [client]
  );

  const revokeShare = useCallback(
    async (item: OwnedShareItem) => {
      if (item.kind === "pending" && !item.pendingShare.grantId) {
        const updated = await client.controlPendingShare({
          pendingShareId: item.pendingShare.id,
          expectedOperationVersion: item.pendingShare.operationVersion,
          action: "revoke"
        });
        setOwnedShares((current) =>
          current.map((entry) =>
            ownedShareKey(entry) === ownedShareKey(item)
              ? { ...entry, pendingShare: updated }
              : entry
          )
        );
      } else {
        const shareGrantId =
          item.kind === "grant" ? item.grant.id : item.pendingShare.grantId;
        const expectedGrantVersion =
          item.kind === "grant"
            ? item.grant.grantVersion
            : item.pendingShare.grantVersion;
        if (!shareGrantId || !expectedGrantVersion) {
          throw new CollaborationInputError(
            "This Share changed while it was being revoked. Reload it and try again."
          );
        }
        if (item.kind === "grant" && item.grant.lifecycle !== "active") {
          throw new CollaborationInputError(
            "This Share is no longer available to revoke."
          );
        }
        const revoked = await client.revokeSharedMemory({
          mutationId: crypto.randomUUID(),
          teamId:
            item.kind === "grant"
              ? item.grant.teamId
              : item.pendingShare.teamId,
          workspaceId:
            item.kind === "grant"
              ? item.grant.workspaceId
              : item.pendingShare.workspaceId,
          shareGrantId,
          expectedGrantVersion,
          reasonCode: "owner_revoked"
        });
        setOwnedShares(
          (current) =>
            current.map((entry) =>
              ownedShareKey(entry) === ownedShareKey(item)
                ? entry.kind === "grant"
                  ? { ...entry, grant: revoked }
                  : {
                      ...entry,
                      pendingShare: {
                        ...entry.pendingShare,
                        state: "revoked",
                        stage: "complete",
                        workspaceAccessState: "revoked",
                        sourceUpdateState: "stopped",
                        operationVersion:
                          entry.pendingShare.operationVersion + 1,
                        updatedAt: revoked.updatedAt,
                        revokedAt: revoked.revokedAt
                      }
                    }
                : entry
            ) as OwnedShareItem[]
        );
      }
      setShareAnnouncement(
        `${item.summary.sourceTitle}: Workspace access revoked`
      );
      setModifyShareKey(null);
      setRevokeShareKey(null);
    },
    [client]
  );

  const confirmRevokeShare = useCallback(
    (item: OwnedShareItem) => {
      const approvalBaseline = new Set(
        client.currentActionGrants?.().map((grant) => grant.id) ?? []
      );
      revokeApprovalBaselineRef.current = approvalBaseline;
      void runOperation(() => revokeShare(item)).finally(() => {
        if (revokeApprovalBaselineRef.current === approvalBaseline) {
          revokeApprovalBaselineRef.current = null;
        }
      });
    },
    [client, revokeShare, runOperation]
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleShares = ownedShares.filter((item) => {
    if (!normalizedQuery) return true;
    const representation = ownedShareRepresentation(item);
    return [
      item.summary.sourceTitle,
      item.summary.teamName,
      item.summary.workspaceName,
      ownedShareStatus(item),
      representation ? representationLabel(representation) : ""
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const sectionOrder = visibleShares.some(
    (item) => ownedShareSection(item) === "pending"
  )
    ? (["pending", "active", "revoked"] as const)
    : (["active", "pending", "revoked"] as const);
  const sections = sectionOrder.map((section) => ({
    section,
    items: visibleShares.filter((item) => ownedShareSection(item) === section)
  }));
  const modifiedShare = ownedShares.find(
    (item) => ownedShareKey(item) === modifyShareKey
  );
  const sharePendingRevocation = ownedShares.find(
    (item) => ownedShareKey(item) === revokeShareKey
  );
  const selectedSection = selectedShare
    ? ownedShareSection(selectedShare)
    : null;
  const activationRepresentation = selectedShare
    ? ownedShareRepresentation(selectedShare)
    : null;
  const selectedActive =
    selectedShare &&
    selectedShare.summary.workspaceContentAccess === "available" &&
    selectedSection === "active" &&
    (selectedShare.kind === "grant" ||
      selectedShare.pendingShare.workspaceAccessState === "active");

  if (sharesState === "loading") {
    return <SharesStatusView state="loading" />;
  }
  if (sharesState === "failed") {
    return (
      <SharesStatusView
        actionLabel="Retry"
        message="Koed could not load your Shares."
        onAction={() => {
          setSharesState("loading");
          setShareEventRevision((revision) => revision + 1);
        }}
        state="unavailable"
      />
    );
  }

  return (
    <section
      className="collab-route-root collab-shares-workspace"
      data-narrow-view={narrowDetailOpen ? "detail" : "list"}
      data-responsive="master-detail-to-drilldown"
    >
      <aside className="collab-shares-pane" aria-label="Shares">
        <header>
          <h1 tabIndex={-1}>Shares</h1>
          <span aria-label={`${ownedShares.length} Shares`}>
            {ownedShares.length}
          </span>
        </header>
        <label className="collab-share-search">
          <span className="collab-visually-hidden">Search Shares</span>
          <input
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search Shares"
            type="search"
            value={query}
          />
        </label>
        <span
          className="collab-visually-hidden"
          role="status"
          aria-live="polite"
        >
          {shareAnnouncement}
        </span>
        <div className="collab-shares-scroll">
          {ownedShares.length === 0 ? (
            <StateView icon={<Library />} title="No shares yet" />
          ) : visibleShares.length === 0 ? (
            <div className="collab-shares-empty" role="status">
              No Shares match “{query}”.
            </div>
          ) : (
            sections.map(({ section, items }) => (
              <section
                aria-labelledby={`collab-${section}-shares`}
                className="collab-share-section"
                data-empty={items.length === 0 ? "true" : undefined}
                key={section}
              >
                <header>
                  <h2 id={`collab-${section}-shares`}>
                    {section[0]!.toUpperCase() + section.slice(1)}
                  </h2>
                  <span>{items.length}</span>
                </header>
                {items.map((item) => {
                  const record = ownedShareRecord(item);
                  return (
                    <button
                      aria-label={`${item.summary.sourceTitle}, ${item.summary.workspaceName}, ${ownedShareStatus(item)}`}
                      aria-current={
                        selectedShareKey === ownedShareKey(item)
                          ? "page"
                          : undefined
                      }
                      className="collab-share-row"
                      key={ownedShareKey(item)}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        const shareKey = ownedShareKey(item);
                        setSelectedShareKey(shareKey);
                        setNarrowDetailOpen(true);
                        onSelectShare?.(shareKey);
                      }}
                      onFocus={() => {
                        lastFocusedShareKeyRef.current = ownedShareKey(item);
                      }}
                      ref={(row) => {
                        const shareKey = ownedShareKey(item);
                        if (row) shareRowRefs.current.set(shareKey, row);
                        else shareRowRefs.current.delete(shareKey);
                      }}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="desktop-team-disc collab-share-team-badge"
                        data-swatch={teamDiscIndex(record.teamId)}
                      >
                        {teamInitials(item.summary.teamName)}
                      </span>
                      <span className="collab-share-row-copy">
                        <span className="collab-share-row-title">
                          <strong>{item.summary.sourceTitle}</strong>
                          {ownedShareHasError(item) ? (
                            <CircleAlert
                              aria-hidden="true"
                              className="collab-share-row-error"
                            />
                          ) : null}
                        </span>
                        <small>{item.summary.workspaceName}</small>
                      </span>
                      <time dateTime={record.updatedAt}>
                        {formatShareListTime(record.updatedAt)}
                      </time>
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </aside>

      {selectedShare ? (
        <article
          className="collab-share-detail-workspace"
          aria-label={`Share details for ${selectedShare.summary.sourceTitle}`}
        >
          <header className="collab-share-detail-header">
            <div>
              <h2>{selectedShare.summary.sourceTitle}</h2>
              <p>
                {selectedShare.summary.teamName} ·{" "}
                {selectedShare.summary.workspaceName}
              </p>
            </div>
            <div className="collab-share-header-actions">
              <button
                className="collab-share-modify-button"
                disabled={
                  selectedSection === "revoked" ||
                  selectedShare.summary.workspaceContentAccess === "unavailable"
                }
                onClick={() => {
                  setOperationError("");
                  setModifyShareKey(ownedShareKey(selectedShare));
                }}
                type="button"
              >
                <Pencil aria-hidden="true" />
                Modify
              </button>
              <button
                className="danger-secondary collab-share-revoke-button"
                disabled={selectedSection === "revoked" || operationBusy}
                onClick={() => {
                  setOperationError("");
                  setRevokeShareKey(ownedShareKey(selectedShare));
                }}
                type="button"
              >
                <Trash2 aria-hidden="true" />
                Revoke
              </button>
            </div>
          </header>
          <div className="collab-share-facts" aria-label="Share summary">
            <span>
              <strong>Status</strong>
              <span className={`collab-share-state ${selectedSection}`}>
                {selectedSection}
              </span>
            </span>
            <span>
              <strong>Shared detail</strong>
              {activationRepresentation
                ? representationLabel(activationRepresentation)
                : "Unavailable"}
            </span>
            <span>
              <strong>Updates</strong>
              {selectedShare.kind === "grant" && sourceSyncState === "paused"
                ? "Updates paused"
                : ownedShareStatus(selectedShare)}
            </span>
            <span>
              <strong>Source access</strong>
              {selectedShare.sourceAccess?.lifecycle === "active"
                ? selectedShare.sourceAccess.mode
                : "Not allowed"}
            </span>
            <span>
              <strong>Workspace access</strong>
              {selectedShare.summary.workspaceContentAccess === "available"
                ? "Available"
                : "Unavailable"}
            </span>
          </div>
          <section className="collab-share-preview">
            {preview ? (
              <header>
                <p>
                  {`${representationLabel(preview.activationRepresentation)} · ${preview.itemCount} ${preview.itemCount === 1 ? "item" : "items"} · Revision ${preview.sourceRevision}`}
                </p>
              </header>
            ) : null}
            <div className="collab-share-preview-window">
              {selectedShare.summary.workspaceContentAccess ===
              "unavailable" ? (
                <StateView
                  icon={<CircleAlert />}
                  title="Workspace content unavailable"
                  message="You can manage or revoke this Share, but its Team content and discussion are no longer available to you."
                />
              ) : (
                <OwnedSharePreview
                  authorizedRevision={
                    selectedShare.summary.authorizedPreview?.sourceRevision ??
                    null
                  }
                  markdownAdapters={markdownAdapters}
                  preview={preview}
                  state={previewState}
                />
              )}
              {preview && "previewHash" in preview && preview.nextCursor ? (
                <button
                  className="collab-share-preview-more secondary"
                  disabled={loadingMorePreview}
                  onClick={() => void loadMorePreview()}
                  type="button"
                >
                  {loadingMorePreview ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </div>
          </section>
        </article>
      ) : (
        <section className="collab-share-empty-detail">
          <StateView
            icon={<Library />}
            title={sharesState === "ready" ? "Select a Share" : "Shares"}
            message="Choose a Share to inspect exactly what the Workspace can access."
          />
        </section>
      )}

      {modifiedShare ? (
        <Modal
          className="collab-modify-share-modal"
          label={`Modify ${modifiedShare.summary.sourceTitle}`}
          onClose={() => setModifyShareKey(null)}
        >
          <ModalHeader
            onClose={() => setModifyShareKey(null)}
            title={modifiedShare.summary.sourceTitle}
          />
          <div className="collab-form collab-modify-share-form">
            <div className="collab-modify-share-context">
              <span>
                {modifiedShare.summary.teamName} ·{" "}
                {modifiedShare.summary.workspaceName}
              </span>
            </div>
            <section>
              <div>
                <h3>Updates</h3>
                <p>
                  {modifiedShare.kind === "grant" &&
                  sourceSyncState === "paused"
                    ? "Updates paused"
                    : ownedShareStatus(modifiedShare)}
                </p>
              </div>
              {modifiedShare.kind === "pending" &&
              modifiedShare.pendingShare.mode === "continuous" &&
              modifiedShare.pendingShare.state === "activated" ? (
                <button
                  className="secondary"
                  disabled={operationBusy}
                  onClick={() => {
                    restoreUpdatesControlFocusRef.current = true;
                    void runOperation(async () => {
                      const updated = await client.controlPendingShare({
                        pendingShareId: modifiedShare.pendingShare.id,
                        expectedOperationVersion:
                          modifiedShare.pendingShare.operationVersion,
                        action:
                          modifiedShare.pendingShare.sourceUpdateState ===
                          "paused"
                            ? "resume"
                            : "pause"
                      });
                      setOwnedShares((current) =>
                        current.map((item) =>
                          item.kind === "pending" &&
                          item.pendingShare.id === updated.id
                            ? { ...item, pendingShare: updated }
                            : item
                        )
                      );
                    });
                  }}
                  ref={updatesControlRef}
                  type="button"
                >
                  {modifiedShare.pendingShare.sourceUpdateState === "paused" ? (
                    <Play aria-hidden="true" />
                  ) : (
                    <Pause aria-hidden="true" />
                  )}
                  {modifiedShare.pendingShare.sourceUpdateState === "paused"
                    ? "Resume updates"
                    : "Pause updates"}
                </button>
              ) : modifiedShare.kind === "grant" &&
                modifiedShare.summary.mode === "continuous" &&
                modifiedShare.summary.sourceSessionId &&
                sourceSyncState &&
                sourceSyncState !== "revoked" ? (
                <button
                  className="secondary"
                  disabled={operationBusy}
                  onClick={() => {
                    restoreUpdatesControlFocusRef.current = true;
                    void runOperation(async () => {
                      const updated =
                        sourceSyncState === "paused"
                          ? await client.resumeSharedMemorySync({
                              sessionId: modifiedShare.summary.sourceSessionId!
                            })
                          : await client.pauseSharedMemorySync({
                              sessionId: modifiedShare.summary.sourceSessionId!
                            });
                      setSourceSyncState(updated.syncState);
                    });
                  }}
                  ref={updatesControlRef}
                  type="button"
                >
                  {sourceSyncState === "paused" ? (
                    <Play aria-hidden="true" />
                  ) : (
                    <Pause aria-hidden="true" />
                  )}
                  {sourceSyncState === "paused"
                    ? "Resume updates"
                    : "Pause updates"}
                </button>
              ) : modifiedShare.kind === "pending" &&
                modifiedShare.pendingShare.state === "failed" &&
                modifiedShare.pendingShare.redactedFailureCode ===
                  "candidate_source_advanced" &&
                modifiedShare.summary.sourceSessionId ? (
                <button
                  className="secondary"
                  disabled={operationBusy}
                  onClick={() =>
                    void openSourceReview(
                      modifiedShare.summary.sourceSessionId!
                    )
                  }
                  type="button"
                >
                  <RefreshCw aria-hidden="true" />
                  Review again
                </button>
              ) : modifiedShare.kind === "pending" &&
                ["failed", "needs_attention"].includes(
                  modifiedShare.pendingShare.state
                ) ? (
                <button
                  className="secondary"
                  disabled={operationBusy}
                  onClick={() =>
                    void runOperation(async () => {
                      const updated = await client.controlPendingShare({
                        pendingShareId: modifiedShare.pendingShare.id,
                        expectedOperationVersion:
                          modifiedShare.pendingShare.operationVersion,
                        action: "retry"
                      });
                      setOwnedShares((current) =>
                        current.map((item) =>
                          item.kind === "pending" &&
                          item.pendingShare.id === updated.id
                            ? { ...item, pendingShare: updated }
                            : item
                        )
                      );
                    })
                  }
                  type="button"
                >
                  <RefreshCw aria-hidden="true" />
                  Retry
                </button>
              ) : null}
            </section>
            <section>
              <div>
                <h3>Shared detail</h3>
                <p>
                  {ownedShareRepresentation(modifiedShare)
                    ? representationLabel(
                        ownedShareRepresentation(modifiedShare)!
                      )
                    : "Unavailable"}
                </p>
              </div>
              {modifiedShare.summary.sourceSessionId &&
              (modifiedShare.kind === "grant" ||
                modifiedShare.pendingShare.grantId) ? (
                <button
                  className="secondary"
                  disabled={operationBusy}
                  onClick={() => void openDetailChange(modifiedShare)}
                  type="button"
                >
                  Change detail
                </button>
              ) : null}
            </section>
            {selectedActive &&
            ownedShareKey(modifiedShare) === selectedShareKey ? (
              <section>
                <div>
                  <h3>Source access</h3>
                  <p>
                    {modifiedShare.sourceAccess?.lifecycle === "active"
                      ? `${modifiedShare.sourceAccess.mode} access allowed`
                      : "Not allowed"}
                  </p>
                </div>
                {modifiedShare.sourceAccess?.lifecycle === "active" ? (
                  <button
                    className="secondary"
                    disabled={operationBusy}
                    onClick={() =>
                      void runOperation(() =>
                        controlConversationSource(modifiedShare, "revoke")
                      )
                    }
                    type="button"
                  >
                    Revoke source access
                  </button>
                ) : (
                  <div className="collab-modify-source-actions">
                    <button
                      className="secondary"
                      disabled={operationBusy}
                      onClick={() =>
                        void runOperation(() =>
                          controlConversationSource(modifiedShare, "snapshot")
                        )
                      }
                      type="button"
                    >
                      Allow snapshot
                    </button>
                    <button
                      className="secondary"
                      disabled={operationBusy}
                      onClick={() =>
                        void runOperation(() =>
                          controlConversationSource(modifiedShare, "continuous")
                        )
                      }
                      type="button"
                    >
                      Allow continuous
                    </button>
                  </div>
                )}
              </section>
            ) : null}
            <p className="collab-modify-source-note">
              Source access can include prompts, tool calls, tool results,
              Approval Activity, and other records that are not Memory.
            </p>
            {operationError ? (
              <p className="collab-form-error" role="alert">
                {operationError}
              </p>
            ) : null}
            <footer className="collab-modal-actions">
              <button
                className="secondary"
                disabled={operationBusy}
                onClick={() => setModifyShareKey(null)}
                type="button"
              >
                Done
              </button>
            </footer>
          </div>
        </Modal>
      ) : null}
      {sharePendingRevocation ? (
        <Modal
          className="collab-revoke-share-modal"
          label={`Revoke ${sharePendingRevocation.summary.sourceTitle}`}
          onClose={() => setRevokeShareKey(null)}
        >
          <ModalHeader
            title={
              sharePendingRevocation.kind === "pending" &&
              !sharePendingRevocation.pendingShare.grantId
                ? "Stop Pending Share"
                : "Revoke Share"
            }
            onClose={() => setRevokeShareKey(null)}
          />
          <div className="collab-form">
            <p>
              {sharePendingRevocation.kind === "pending" &&
              !sharePendingRevocation.pendingShare.grantId
                ? "Stop this Pending Share and move it to Revoked?"
                : "Revoke this Share and remove Workspace access?"}{" "}
              Your Personal Memory will not be deleted.
            </p>
            {operationError ? (
              <p className="collab-form-error" role="alert">
                {operationError}
              </p>
            ) : null}
            <footer className="collab-modal-actions">
              <button
                className="secondary"
                disabled={operationBusy}
                onClick={() => setRevokeShareKey(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="danger-secondary"
                disabled={operationBusy}
                onClick={() => confirmRevokeShare(sharePendingRevocation)}
                type="button"
              >
                <Trash2 aria-hidden="true" />
                {operationBusy
                  ? "Revoking…"
                  : sharePendingRevocation.kind === "pending" &&
                      !sharePendingRevocation.pendingShare.grantId
                    ? "Stop Share"
                    : "Revoke Share"}
              </button>
            </footer>
          </div>
        </Modal>
      ) : null}
      {sourceReviewEntry ? (
        <SharedMemoryOwnerModal
          client={client}
          entry={sourceReviewEntry}
          markdownAdapters={markdownAdapters}
          onClose={() => setSourceReviewEntry(null)}
          onViewShare={(shareKey) => {
            setSourceReviewEntry(null);
            setSelectedShareKey(shareKey);
            setNarrowDetailOpen(true);
            onSelectShare?.(shareKey);
          }}
          snapshot={snapshot}
        />
      ) : null}
      {detailChange ? (
        <SharedMemoryOwnerModal
          client={client}
          detailChange={{
            grantId:
              detailChange.share.kind === "grant"
                ? detailChange.share.grant.id
                : detailChange.share.pendingShare.grantId!,
            logicalMemoryId: ownedShareRecord(detailChange.share)
              .logicalMemoryId,
            mode: detailChange.share.summary.mode,
            maximumFidelity: ownedShareRecord(detailChange.share)
              .maximumFidelity,
            includeCuratedMemory: ownedShareRecord(detailChange.share)
              .includeCuratedMemory,
            teamId: ownedShareRecord(detailChange.share).teamId,
            workspaceId: ownedShareRecord(detailChange.share).workspaceId
          }}
          entry={detailChange.entry}
          markdownAdapters={markdownAdapters}
          onClose={() => setDetailChange(null)}
          onDetailChangeQueued={() => {
            setShareAnnouncement(
              `${detailChange.share.summary.sourceTitle}: Detail change is being prepared`
            );
            setShareEventRevision((revision) => revision + 1);
          }}
          onViewShare={() => undefined}
          snapshot={snapshot}
        />
      ) : null}
    </section>
  );
}

export function PersonalMemoryView({
  client,
  initialSection = "projects",
  initialShareKey,
  markdownAdapters,
  onAvailabilityChange,
  onSelectShare,
  onShare,
  snapshot
}: {
  client: CollaborationRendererClient;
  initialSection?: "projects" | "shares" | "history";
  initialShareKey?: string;
  markdownAdapters?: MarkdownPlatformAdapters;
  onAvailabilityChange?: (unavailable: boolean) => void;
  onOpenProjects?: () => void;
  onSelectShare?: (shareKey: string) => void;
  onShare: (sessionId: string) => void;
  snapshot: CollaborationSnapshot;
}) {
  if (initialSection !== "projects" && markdownAdapters) {
    return (
      <OwnedSharesWorkspace
        client={client}
        initialShareKey={initialShareKey}
        markdownAdapters={markdownAdapters}
        onAvailabilityChange={onAvailabilityChange}
        onSelectShare={onSelectShare}
        snapshot={snapshot}
      />
    );
  }
  return <PersonalMemoryProjectsView onShare={onShare} snapshot={snapshot} />;
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
  const orderedPeople = [...view.people].sort((left, right) => {
    if (left.id === principalId) return -1;
    if (right.id === principalId) return 1;
    return left.displayName.localeCompare(right.displayName);
  });
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
  const [accessDraft, setAccessDraft] = useState<
    Record<
      string,
      {
        teamId: string;
        workspaceId: string;
        workspaceName: string;
        userId: string;
        userName: string;
        before: "disabled" | "read" | "write";
        after: "disabled" | "read" | "write";
        expectedVersion: number | null;
      }
    >
  >({});
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
      setOperationError("This description is too long.");
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
        className="collab-member-role"
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

  const applyAccessDraft = async () => {
    const changes = Object.entries(accessDraft);
    if (changes.length === 0) return;
    await runOperation(
      "apply-access-draft",
      async () => {
        for (const [key, change] of changes) {
          await client.setWorkspaceAccess({
            teamId: change.teamId,
            workspaceId: change.workspaceId,
            userId: change.userId,
            access: change.after,
            expectedVersion: change.expectedVersion
          });
          setAccessDraft((current) => {
            const remaining = { ...current };
            delete remaining[key];
            return remaining;
          });
        }
      },
      "The remaining Workspace Access draft could not be applied. Successful changes are already reflected in the authoritative view."
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
            {canManage && Object.keys(accessDraft).length > 0 ? (
              <div className="collab-header-actions">
                <span role="status">
                  {Object.keys(accessDraft).length} pending access{" "}
                  {Object.keys(accessDraft).length === 1 ? "change" : "changes"}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={Boolean(busyKey)}
                  onClick={() => setAccessDraft({})}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={Boolean(busyKey)}
                  onClick={() => void applyAccessDraft()}
                >
                  {busyKey === "apply-access-draft"
                    ? "Applying…"
                    : "Review and apply"}
                </button>
              </div>
            ) : null}
          </header>
          {canManage && Object.keys(accessDraft).length > 0 ? (
            <ul
              className="collab-admin-list"
              aria-label="Workspace Access draft"
            >
              {Object.values(accessDraft).map((change) => (
                <li key={`${change.userId}:${change.workspaceId}`}>
                  <strong>{change.userName}</strong> · {change.workspaceName}:{" "}
                  {change.before} → {change.after}
                </li>
              ))}
            </ul>
          ) : null}
          {orderedPeople.length === 0 ? (
            <p className="collab-admin-empty">No Team members available.</p>
          ) : (
            <div className="collab-people-list">
              {orderedPeople.map((person) => {
                const management = person.management;
                const isCurrent = person.id === principalId;
                const canChangeTarget =
                  canManage &&
                  management?.status === "enabled" &&
                  (management.role !== "owner" || team.role === "owner");
                const targetLastOwner =
                  management?.role === "owner" && enabledOwners <= 1;
                return (
                  <div
                    key={person.id}
                    className="collab-person-admin-row"
                    data-current-user={isCurrent || undefined}
                  >
                    <span className="collab-avatar collab-person-avatar">
                      {initials(person.displayName)}
                      <span
                        className="collab-presence-icon"
                        title={presenceLabel(person)}
                      >
                        {presenceIcon(person)}
                      </span>
                    </span>
                    <div className="collab-person-identity">
                      <strong>
                        {person.displayName}
                        {isCurrent ? (
                          <span className="collab-me-badge">Me</span>
                        ) : null}
                      </strong>
                      <span>
                        {presenceLabel(person)}
                        {management?.email ? ` · ${management.email}` : ""}
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
                            const draftKey = `${person.id}:${workspace.id}`;
                            const drafted = accessDraft[draftKey];
                            return (
                              <label key={workspace.id}>
                                <span>{workspace.name}</span>
                                <select
                                  aria-label={`${workspace.name} access for ${person.displayName}`}
                                  value={drafted?.after ?? currentAccess.access}
                                  disabled={
                                    Boolean(busyKey) ||
                                    !canChangeTarget ||
                                    workspace.lifecycle !== "active"
                                  }
                                  onChange={(event) => {
                                    const after = event.currentTarget.value as
                                      | "disabled"
                                      | "read"
                                      | "write";
                                    setAccessDraft((current) => {
                                      if (after === currentAccess.access) {
                                        const remaining = { ...current };
                                        delete remaining[draftKey];
                                        return remaining;
                                      }
                                      return {
                                        ...current,
                                        [draftKey]: {
                                          teamId: team.id,
                                          workspaceId: workspace.id,
                                          workspaceName: workspace.name,
                                          userId: person.id,
                                          userName: person.displayName,
                                          before: currentAccess.access,
                                          after,
                                          expectedVersion: currentAccess.version
                                        }
                                      };
                                    });
                                  }}
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
                        className="danger-secondary collab-member-disable"
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
              <h2 id="invites-heading">Invites</h2>
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

        {membershipVersion || lastOwner ? (
          <section
            aria-label="Team membership actions"
            className="collab-leave-section"
            data-invites-visible={canManage || undefined}
          >
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
        ) : null}
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
                  {fidelityLabel(session.maximumFidelity)}
                  {session.includeCuratedMemory ? " + Curated Memory" : ""}
                </small>
              </span>
              <time dateTime={session.latestActivityAt}>
                {formatTime(session.latestActivityAt)}
              </time>
              {session.unreadCompanionCount > 0 ? (
                <span
                  className="collab-nav-unread koed-inbox-unread-count"
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

function SharedSourceMarkdown({
  markdownAdapters,
  source
}: {
  markdownAdapters: MarkdownPlatformAdapters;
  source: string;
}) {
  return (
    <SecureMarkdown
      adapters={markdownAdapters}
      className="shared-memory-markdown"
      source={source}
      oversizedFallback={
        <p role="alert">This source item is too large to display safely.</p>
      }
    />
  );
}

function SourceItemRow({
  item,
  markdownAdapters
}: {
  item: SharedMemorySourceItem;
  markdownAdapters: MarkdownPlatformAdapters;
}) {
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
          parts={item.sourceItems.map((source) => ({
            ...source,
            body: (
              <SharedSourceMarkdown
                markdownAdapters={markdownAdapters}
                source={source.body}
              />
            )
          }))}
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
  if (item.representation === "curated_assertions") {
    return (
      <article className="collab-source-event memory-event" role="listitem">
        <header className="memory-event-header">
          <strong>{item.topicTitle ?? "Curated assertion"}</strong>
          <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
        </header>
        <SharedSourceMarkdown
          markdownAdapters={markdownAdapters}
          source={item.assertionText}
        />
        {item.tags.length > 0 ? (
          <p className="collab-form-context">{item.tags.join(" · ")}</p>
        ) : null}
      </article>
    );
  }
  return (
    <LcmSummaryFrame
      occurredAt={item.occurredAt}
      representation={item.representation}
      sourceCount={item.sourceCount}
      summary={
        <SharedSourceMarkdown
          markdownAdapters={markdownAdapters}
          source={item.summaryText}
        />
      }
      timeLabel={formatTime(item.occurredAt)}
    />
  );
}

function SourceTimeline({
  client,
  markdownAdapters,
  page,
  session
}: {
  client: CollaborationRendererClient;
  markdownAdapters: MarkdownPlatformAdapters;
  page: SharedMemorySourcePage;
  session: SharedMemorySession;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const rows = page.items;
  const conversationEvents = sharedMemoryConversationEvents(rows);
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
        page.representation === "memory_events" ? (
          <ConversationTimeline
            ariaLabel="Memory Events source items"
            className="collab-source-list collab-virtual-list native-timeline-scroll shared-conversation-timeline"
            events={conversationEvents}
            hasOlderEvents={page.hasOlder}
            hasNewerEvents={page.hasNewer}
            markdownAdapters={markdownAdapters}
            onLoadOlder={() => loadPage("older")}
            onLoadNewer={() => loadPage("newer")}
            scope="workspace"
            threadKey={`${session.id}:${page.representation}`}
          />
        ) : (
          <VirtualizedTimeline
            ariaLabel={`${representationLabel(page.representation)} source items`}
            className="collab-source-list collab-virtual-list"
            estimatedItemHeight={132}
            events={rows}
            hasOlderEvents={page.hasOlder}
            hasNewerEvents={page.hasNewer}
            onLoadOlder={() => loadPage("older")}
            onLoadNewer={() => loadPage("newer")}
            renderEvent={(item) => (
              <SourceItemRow
                key={item.id}
                item={item}
                markdownAdapters={markdownAdapters}
              />
            )}
            threadKey={`${session.id}:${page.representation}`}
          />
        )
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
            {fidelityLabel(session.maximumFidelity)}
            {session.includeCuratedMemory ? " + Curated Memory" : ""}
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
              className="collab-nav-unread koed-inbox-unread-count"
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
            <strong>{representationLabel(source.representation)}</strong>
            <span>{source.items.length} source items</span>
          </header>
          <SourceTimeline
            client={client}
            markdownAdapters={markdownAdapters}
            page={source}
            session={session}
          />
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

const SHARED_MEMORY_FIDELITIES = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
] as const satisfies readonly SharedMemoryFidelityCeiling[];

const sharedMemoryPreparationCopy = (
  syncState: PersonalMemoryEntry["syncState"]
): { detail: string; label: string; title: string } => {
  switch (syncState) {
    case "not_started":
      return {
        title: "Starting secure sync",
        detail:
          "Koed is setting up this memory for sharing. You can keep this window open.",
        label: "Starting"
      };
    case "partially_available":
      return {
        title: "Finishing preparation",
        detail:
          "The memory has arrived and is finishing processing. The preview will open here when it is ready.",
        label: "Finishing"
      };
    case "ready":
      return {
        title: "Preparing your preview",
        detail:
          "The synchronized revision is ready. Koed is building the source review.",
        label: "Ready"
      };
    case "stale":
      return {
        title: "Refreshing this memory",
        detail:
          "Koed is refreshing the synchronized revision before opening the source review.",
        label: "Refreshing"
      };
    default:
      return {
        title: "Syncing this memory",
        detail:
          "Koed is preparing the first synchronized revision. The preview will open here when it is ready.",
        label: "Processing"
      };
  }
};

const firstWritableWorkspace = (
  team: CollaborationSnapshot["navigation"]["teams"][number] | null | undefined
) =>
  team?.workspaces.find(
    (workspace) =>
      workspace.lifecycle === "active" && workspace.access === "write"
  ) ?? null;

function SharedMemoryOwnerModal({
  client,
  detailChange,
  entry,
  markdownAdapters,
  onDetailChangeQueued,
  onViewShare,
  snapshot,
  onClose
}: {
  client: CollaborationRendererClient;
  detailChange?: {
    grantId: string;
    logicalMemoryId: string;
    mode: "snapshot" | "continuous";
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
    teamId: string;
    workspaceId: string;
  };
  entry: PersonalMemoryEntry;
  markdownAdapters: MarkdownPlatformAdapters;
  onDetailChangeQueued?: (pendingShare: PendingShare) => void;
  onViewShare: (shareKey: string) => void;
  snapshot: CollaborationSnapshot;
  onClose: () => void;
}) {
  const focusedDetailChange = Boolean(detailChange);
  const detailChangeGrantId = detailChange?.grantId;
  const detailChangeMode = detailChange?.mode;
  const detailChangeMaximumFidelity = detailChange?.maximumFidelity;
  const detailChangeIncludeCuratedMemory =
    detailChange?.includeCuratedMemory ?? false;
  const detailChangeTeamId = detailChange?.teamId;
  const detailChangeWorkspaceId = detailChange?.workspaceId;
  const ownerLogicalMemoryId =
    detailChange?.logicalMemoryId ?? entry.logicalMemoryId;
  const availableTeams = snapshot.navigation.teams.filter(
    (team) => team.lifecycle === "active"
  );
  const initialTeam = detailChange
    ? (availableTeams.find((team) => team.id === detailChange.teamId) ?? null)
    : (availableTeams.find((team) => firstWritableWorkspace(team)) ??
      availableTeams[0] ??
      null);
  const initialWorkspace = detailChange
    ? (initialTeam?.workspaces.find(
        (workspace) => workspace.id === detailChange.workspaceId
      ) ?? null)
    : firstWritableWorkspace(initialTeam);
  const [teamId, setTeamId] = useState(
    detailChange?.teamId ?? initialTeam?.id ?? ""
  );
  const [workspaceId, setWorkspaceId] = useState(
    detailChange?.workspaceId ?? initialWorkspace?.id ?? ""
  );
  const [maximumFidelity, setMaximumFidelity] =
    useState<SharedMemoryFidelityCeiling>(
      detailChange?.maximumFidelity ?? "memory_events"
    );
  const [includeCuratedMemory, setIncludeCuratedMemory] = useState(
    detailChange?.includeCuratedMemory ?? false
  );
  const [mode, setMode] = useState<"snapshot" | "continuous">(
    detailChange?.mode ?? "continuous"
  );
  const [currentEntry, setCurrentEntry] = useState(entry);
  const shareTitle = entry.title;
  const [ownerGrants, setOwnerGrants] = useState<SharedMemoryGrant[]>([]);
  const [ownerPendingShares, setOwnerPendingShares] = useState<PendingShare[]>(
    []
  );
  const [loadingGrants, setLoadingGrants] = useState(
    ownerLogicalMemoryId !== null
  );
  const [workflow, setWorkflow] = useState<
    { kind: "new" } | { kind: "change"; grant: SharedMemoryGrant } | null
  >(entry.logicalMemoryId ? null : { kind: "new" });
  const [preview, setPreview] = useState<SharedMemoryPreview | null>(null);
  const [candidate, setCandidate] =
    useState<BoundSharedMemoryCandidatePreview | null>(null);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [stoppingSync, setStoppingSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completedShare, setCompletedShare] = useState<{
    key: string;
    title: string;
    workspaceName: string;
  } | null>(null);
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
  const selectedDestinationPendingShare = ownerPendingShares.find(
    (share) =>
      share.teamId === teamId &&
      share.workspaceId === workspaceId &&
      share.state !== "revoked" &&
      !(
        share.state === "failed" &&
        share.redactedFailureCode === "candidate_source_advanced"
      )
  );
  const consentActionLabel =
    workflow?.kind === "change"
      ? "Apply change"
      : selectedDestinationGrant?.lifecycle === "revoked"
        ? "Consent and restore"
        : "Share";
  const consentActionPending = busy || preparingPreview;

  useEffect(() => {
    const liveEntry = snapshot.navigation.personal.memory.find(
      (candidate) => candidate.id === entry.id
    );
    if (liveEntry) {
      setCurrentEntry((current) => {
        if (
          preparingPreview &&
          current.syncState !== "not_started" &&
          liveEntry.syncState === "not_started"
        ) {
          return current;
        }
        return liveEntry;
      });
    }
  }, [entry.id, preparingPreview, snapshot.navigation.personal.memory]);

  useEffect(() => {
    let active = true;
    if (!ownerLogicalMemoryId) {
      setLoadingGrants(false);
      setWorkflow({ kind: "new" });
      return () => {
        active = false;
      };
    }
    setLoadingGrants(true);
    void Promise.all([
      client.listOwnedSharedMemoryGrants({
        logicalMemoryId: ownerLogicalMemoryId
      }),
      client.listOwnedShares({ cursor: null, limit: 100, history: false })
    ])
      .then(([grants, page]) => {
        if (!active) return;
        const pendingShares = page.shares.flatMap((item) =>
          item.kind === "pending" &&
          item.pendingShare.logicalMemoryId === ownerLogicalMemoryId &&
          item.pendingShare.state !== "revoked" &&
          !(
            item.pendingShare.state === "failed" &&
            item.pendingShare.redactedFailureCode ===
              "candidate_source_advanced"
          )
            ? [item.pendingShare]
            : []
        );
        setOwnerGrants(grants);
        setOwnerPendingShares(pendingShares);
        if (
          detailChangeGrantId &&
          detailChangeMode &&
          detailChangeMaximumFidelity &&
          detailChangeTeamId &&
          detailChangeWorkspaceId
        ) {
          const targetGrant = grants.find(
            (grant) => grant.id === detailChangeGrantId
          );
          if (
            !targetGrant ||
            !["active", "unavailable"].includes(targetGrant.lifecycle)
          ) {
            setWorkflow(null);
            setError("This Share is no longer available for a detail change.");
            return;
          }
          setTeamId(detailChangeTeamId);
          setWorkspaceId(detailChangeWorkspaceId);
          setMaximumFidelity(detailChangeMaximumFidelity);
          setIncludeCuratedMemory(detailChangeIncludeCuratedMemory);
          setMode(detailChangeMode);
          setWorkflow({ kind: "change", grant: targetGrant });
          return;
        }
        if (grants.length === 0 && pendingShares.length === 0) {
          setWorkflow({ kind: "new" });
        }
      })
      .catch((cause) => {
        if (active) {
          setError(
            failureMessage(
              cause,
              focusedDetailChange
                ? "Share details could not be loaded."
                : "Existing Shared Memory could not be loaded."
            )
          );
        }
      })
      .finally(() => {
        if (active) setLoadingGrants(false);
      });
    return () => {
      active = false;
    };
  }, [
    client,
    detailChangeGrantId,
    detailChangeIncludeCuratedMemory,
    detailChangeMode,
    detailChangeMaximumFidelity,
    detailChangeTeamId,
    detailChangeWorkspaceId,
    focusedDetailChange,
    ownerLogicalMemoryId
  ]);

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
      setPreparingPreview(true);
      try {
        requireDestination();
        if (!currentEntry.logicalMemoryId) {
          throw new CollaborationInputError(
            "This Personal Memory source is not ready yet."
          );
        }
        const source =
          workflow?.kind === "change"
            ? workflow.grant.source
            : {
                kind: "captured_session" as const,
                sessionId: currentEntry.id,
                logicalMemoryId: currentEntry.logicalMemoryId
              };
        if (source.kind !== "captured_session") {
          throw new CollaborationInputError(
            "Personal Notes do not support Shared Memory fidelity changes."
          );
        }
        const localCandidate = await client.previewSharedMemoryCandidate({
          source,
          activationRepresentation: maximumFidelity,
          mode
        });
        if (
          localCandidate.source?.kind !== "captured_session" ||
          localCandidate.source.sessionId !== source.sessionId ||
          localCandidate.source.logicalMemoryId !== source.logicalMemoryId ||
          localCandidate.logicalMemoryId !== source.logicalMemoryId ||
          localCandidate.items.length === 0
        ) {
          throw new CollaborationInputError(
            `No ${representationLabel(maximumFidelity)} are available for this Personal Memory.`
          );
        }
        setCandidate({ ...localCandidate, source: localCandidate.source });
      } catch (cause) {
        setPreparingPreview(false);
        throw cause;
      }
    });

  useEffect(() => {
    if (!preparingPreview || !candidate) {
      return;
    }
    let active = true;
    setError("");
    void client
      .previewSharedMemory({
        source: candidate.source,
        sourceCapabilities: candidate.sourceCapabilities,
        logicalMemoryId: candidate.logicalMemoryId,
        teamId,
        workspaceId,
        activationRepresentation: maximumFidelity,
        maximumFidelity,
        includeCuratedMemory,
        mode,
        candidate: {
          source: candidate.source,
          sourceCapabilities: candidate.sourceCapabilities,
          activationRepresentation: candidate.activationRepresentation,
          candidateHash: candidate.candidateHash,
          sourceRevision: candidate.sourceRevision,
          itemCount: candidate.itemCount,
          excludedItemCount: candidate.excludedItemCount,
          manifest: candidate.manifest,
          byteCount: candidate.byteCount,
          mode,
          expiresAt: null
        }
      })
      .then((nextPreview) => {
        if (!active) return;
        setPreview(nextPreview);
        setPreparingPreview(false);
      })
      .catch((cause) => {
        if (!active) return;
        setPreparingPreview(false);
        setError(failureMessage(cause, "Shared Memory could not be prepared."));
      });
    return () => {
      active = false;
    };
  }, [
    client,
    candidate,
    mode,
    preparingPreview,
    includeCuratedMemory,
    maximumFidelity,
    teamId,
    workspaceId
  ]);

  const beginNewShare = () => {
    const team =
      availableTeams.find((candidate) => firstWritableWorkspace(candidate)) ??
      availableTeams[0] ??
      null;
    const workspace = firstWritableWorkspace(team);
    setTeamId(team?.id ?? "");
    setWorkspaceId(workspace?.id ?? "");
    setMaximumFidelity("memory_events");
    setIncludeCuratedMemory(false);
    setPreview(null);
    setCandidate(null);
    setPreparingPreview(false);
    setRevokingGrantId(null);
    setWorkflow({ kind: "new" });
    setError("");
  };

  const beginFidelityChange = (grant: SharedMemoryGrant) => {
    setTeamId(grant.teamId);
    setWorkspaceId(grant.workspaceId);
    setMaximumFidelity(grant.maximumFidelity);
    setIncludeCuratedMemory(grant.includeCuratedMemory);
    setPreview(null);
    setCandidate(null);
    setPreparingPreview(false);
    setRevokingGrantId(null);
    setWorkflow({ kind: "change", grant });
    setError("");
  };

  const selectMode = (nextMode: "snapshot" | "continuous") => {
    if (nextMode === mode) return;
    setMode(nextMode);
    if (candidate) {
      setPreview(null);
      setPreparingPreview(true);
    }
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
        current.map((item) =>
          item.id === revoked.id ? { ...item, ...revoked } : item
        )
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
      if (!preview || !candidate || !workflow) return;
      requireDestination();
      const consentId = crypto.randomUUID();
      let completedShareKey: string;
      const targetGrant =
        workflow.kind === "change" ? workflow.grant : selectedDestinationGrant;
      if (targetGrant) {
        const refreshedGrants = await client.listOwnedSharedMemoryGrants({
          logicalMemoryId: candidate.logicalMemoryId
        });
        setOwnerGrants(refreshedGrants);
        const refreshedGrant = refreshedGrants.find(
          (grant) => grant.id === targetGrant.id
        );
        if (
          !refreshedGrant ||
          refreshedGrant.logicalMemoryId !== candidate.logicalMemoryId ||
          refreshedGrant.teamId !== teamId ||
          refreshedGrant.workspaceId !== workspaceId
        ) {
          throw new CollaborationInputError(
            "This Shared Memory changed while consent was being recorded. Reload it and try again."
          );
        }
        const changed = await client.changeSharedMemoryFidelity({
          source: candidate.source,
          sourceCapabilities: candidate.sourceCapabilities,
          activationRepresentation: candidate.activationRepresentation,
          mutationId: crypto.randomUUID(),
          logicalMemoryId: candidate.logicalMemoryId,
          teamId,
          workspaceId,
          shareGrantId: refreshedGrant.id,
          consentId,
          maximumFidelity,
          includeCuratedMemory,
          expectedGrantVersion: refreshedGrant.grantVersion,
          mode,
          previewRevision: preview.previewRevision,
          previewHash: preview.previewHash,
          expiresAt: null
        });
        if (changed.workspaceAccessState !== "active") {
          throw new CollaborationInputError(
            "The current Workspace representation could not be preserved."
          );
        }
        if (focusedDetailChange) {
          onDetailChangeQueued?.(changed);
          onClose();
          return;
        }
        completedShareKey = `pending:${changed.id}`;
      } else {
        const shared = await client.shareMemory({
          source: candidate.source,
          sourceCapabilities: candidate.sourceCapabilities,
          activationRepresentation: candidate.activationRepresentation,
          mutationId: crypto.randomUUID(),
          logicalGrantId: crypto.randomUUID(),
          consentId,
          logicalMemoryId: candidate.logicalMemoryId,
          teamId,
          workspaceId,
          mode,
          maximumFidelity,
          includeCuratedMemory,
          previewRevision: preview.previewRevision,
          previewHash: preview.previewHash,
          expiresAt: null
        });
        if ("ownerUserId" in shared) {
          setOwnerGrants((current) => [shared, ...current]);
          completedShareKey = `grant:${shared.id}`;
        } else {
          setOwnerPendingShares((current) => [
            shared,
            ...current.filter((item) => item.id !== shared.id)
          ]);
          completedShareKey = `pending:${shared.id}`;
        }
      }
      setPreview(null);
      setCandidate(null);
      setCompletedShare({
        key: completedShareKey,
        title: shareTitle,
        workspaceName: selectedWorkspace?.name ?? "the selected Workspace"
      });
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

  const preparationCopy = sharedMemoryPreparationCopy(currentEntry.syncState);

  if (destinationInvalid) return null;

  return (
    <Modal
      className={`collab-share-memory-modal${focusedDetailChange ? " collab-change-detail-modal" : ""}`}
      label={
        focusedDetailChange
          ? `Change shared detail for ${entry.title}`
          : `Share ${entry.title}`
      }
      onClose={onClose}
    >
      <ModalHeader
        title={focusedDetailChange ? "Change shared detail" : shareTitle}
        onClose={onClose}
      />
      <div
        className={`collab-form collab-share-memory-form${focusedDetailChange ? " collab-change-detail-form" : ""}`}
      >
        {completedShare ? (
          <div
            aria-live="polite"
            className="collab-share-complete"
            role="status"
          >
            <span className="collab-share-complete-icon" aria-hidden="true">
              <CircleCheck />
            </span>
            <strong>Share complete</strong>
            <p>
              “{completedShare.title}” is being shared with{" "}
              {completedShare.workspaceName}.
            </p>
          </div>
        ) : preparingPreview && !candidate ? (
          <div
            className="collab-modal-state collab-share-preparing"
            role="status"
            aria-busy="true"
            aria-live="polite"
          >
            <LoaderCircle
              className="collab-spin collab-share-preparing-icon"
              aria-hidden="true"
            />
            <strong>{preparationCopy.title}</strong>
            <p>{preparationCopy.detail}</p>
            <small>Current status: {preparationCopy.label}</small>
          </div>
        ) : loadingGrants ? (
          <div className="collab-modal-state" role="status">
            <LoaderCircle className="collab-spin" aria-hidden="true" />
            {focusedDetailChange
              ? "Loading Share details"
              : "Loading shared destinations"}
          </div>
        ) : workflow === null && focusedDetailChange ? (
          <div className="collab-modal-state collab-change-detail-unavailable">
            This Share cannot be changed right now.
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
            {ownerGrants.length === 0 && ownerPendingShares.length === 0 ? (
              <div className="collab-empty-inline">Not shared yet.</div>
            ) : (
              <ol
                className="collab-owner-grant-list"
                aria-label="Shared destinations"
              >
                {ownerPendingShares.map((share) => {
                  const team = availableTeams.find(
                    (item) => item.id === share.teamId
                  );
                  const workspace = team?.workspaces.find(
                    (item) => item.id === share.workspaceId
                  );
                  return (
                    <li key={share.id} className="collab-owner-grant-row">
                      <LoaderCircle
                        className="collab-spin"
                        aria-hidden="true"
                      />
                      <div>
                        <strong>
                          {workspace?.name ?? "Unavailable Workspace"}
                        </strong>
                        <span>{team?.name ?? "Unavailable Team"}</span>
                        <small>
                          {share.state.replaceAll("_", " ")} ·{" "}
                          {pendingShareStageLabel(share.stage)}
                        </small>
                      </div>
                    </li>
                  );
                })}
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
                          {active
                            ? fidelityLabel(grant.maximumFidelity) +
                              (grant.includeCuratedMemory
                                ? " + Curated Memory"
                                : "")
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
                            onClick={() => beginFidelityChange(grant)}
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
        ) : preview || candidate ? (
          <>
            <p className="collab-share-preview-notice">
              This is your private Personal source preview. Privacy filtering
              completes before any Team member can access the shared
              representation.
            </p>
            {focusedDetailChange ? (
              <div className="collab-change-detail-comparison">
                <span>
                  <small>Current detail</small>
                  <strong>
                    {fidelityLabel(detailChange!.maximumFidelity)}
                  </strong>
                </span>
                <span aria-hidden="true">→</span>
                <span>
                  <small>New detail</small>
                  <strong>{fidelityLabel(maximumFidelity)}</strong>
                </span>
              </div>
            ) : (
              <div className="collab-share-summary">
                <strong>
                  {representationLabel(
                    (preview ?? candidate)!.activationRepresentation
                  )}
                </strong>
                <span>
                  {(preview ?? candidate)!.itemCount}{" "}
                  {(preview ?? candidate)!.itemCount === 1 ? "item" : "items"}
                </span>
              </div>
            )}
            {(preview ?? candidate)!.activationRepresentation ===
            "memory_events" ? (
              <div className="collab-preview-list shared-conversation-preview">
                <ConversationRows
                  events={sharedMemoryConversationEvents(
                    (preview ?? candidate)!.items
                  )}
                  markdownAdapters={markdownAdapters}
                  scope="workspace"
                />
              </div>
            ) : (
              <ol className="collab-source-list collab-preview-list">
                {(preview ?? candidate)!.items.map((item) => (
                  <SourceItemRow
                    key={item.id}
                    item={item}
                    markdownAdapters={markdownAdapters}
                  />
                ))}
              </ol>
            )}
            {preview?.nextCursor ? (
              <button
                type="button"
                className="secondary"
                onClick={() => void loadMore()}
                disabled={busy}
              >
                Load more
              </button>
            ) : null}
            {!focusedDetailChange ? (
              <fieldset>
                <legend>Updates</legend>
                <label className="collab-check">
                  <input
                    type="radio"
                    checked={mode === "continuous"}
                    onChange={() => selectMode("continuous")}
                  />
                  Keep this shared source up to date
                </label>
                <label className="collab-check">
                  <input
                    type="radio"
                    checked={mode === "snapshot"}
                    onChange={() => selectMode("snapshot")}
                  />
                  Share only this revision
                </label>
              </fieldset>
            ) : null}
          </>
        ) : (
          <>
            <p className="collab-form-context">
              {workflow.kind === "change"
                ? `${grantDestination(workflow.grant).team} · ${grantDestination(workflow.grant).workspace}`
                : `${entry.projectName ?? "Personal Memory"} · ${entry.preview}`}
            </p>
            {focusedDetailChange ? (
              <div className="collab-change-detail-current">
                <small>Current detail</small>
                <strong>{fidelityLabel(detailChange!.maximumFidelity)}</strong>
                <span>
                  The existing Share remains available until the replacement is
                  ready.
                </span>
              </div>
            ) : null}
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
                            firstWritableWorkspace(nextTeam)?.id ?? ""
                          );
                          setPreview(null);
                          setCandidate(null);
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
                          setCandidate(null);
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
                    ) : selectedDestinationPendingShare ? (
                      <p className="collab-form-context" role="status">
                        Sharing to this Workspace is already being prepared.
                        Track its progress in Personal Memory → Shares.
                      </p>
                    ) : null}
                  </>
                ) : null}
                <fieldset
                  className={
                    focusedDetailChange
                      ? "collab-change-detail-options"
                      : undefined
                  }
                >
                  <legend>
                    {focusedDetailChange ? "New detail" : "Shared detail"}
                  </legend>
                  {SHARED_MEMORY_FIDELITIES.map((value) => (
                    <label key={value} className="collab-check">
                      <input
                        type="radio"
                        aria-label={fidelityLabel(value)}
                        checked={maximumFidelity === value}
                        disabled={
                          workflow.kind === "change" &&
                          workflow.grant.maximumFidelity === value &&
                          workflow.grant.includeCuratedMemory ===
                            includeCuratedMemory
                        }
                        onChange={() => {
                          setMaximumFidelity(value);
                          setPreview(null);
                          setCandidate(null);
                        }}
                      />
                      <span>
                        <strong>{fidelityLabel(value)}</strong>
                        {focusedDetailChange &&
                        detailChange!.maximumFidelity === value ? (
                          <small>Current</small>
                        ) : null}
                      </span>
                    </label>
                  ))}
                  <label className="collab-check">
                    <input
                      type="checkbox"
                      checked={includeCuratedMemory}
                      onChange={(event) => {
                        setIncludeCuratedMemory(event.currentTarget.checked);
                        setPreview(null);
                      }}
                    />
                    Include Curated Memory
                  </label>
                </fieldset>
              </>
            )}
          </>
        )}
        {!completedShare && error ? (
          <p className="collab-form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="collab-modal-actions">
          {completedShare ? (
            <>
              <button className="secondary" onClick={onClose} type="button">
                Dismiss
              </button>
              <button
                onClick={() => onViewShare(completedShare.key)}
                type="button"
              >
                View share
              </button>
            </>
          ) : workflow === null && focusedDetailChange ? (
            <button type="button" className="secondary" onClick={onClose}>
              Close
            </button>
          ) : workflow === null ? (
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
                className="secondary collab-share-cancel-action"
                onClick={() => {
                  if (focusedDetailChange) {
                    onClose();
                  } else if (ownerGrants.length > 0) {
                    setPreview(null);
                    setCandidate(null);
                    setPreparingPreview(false);
                    setWorkflow(null);
                    setError("");
                  } else {
                    onClose();
                  }
                }}
              >
                {focusedDetailChange
                  ? "Cancel"
                  : ownerGrants.length > 0
                    ? "Back"
                    : "Cancel"}
              </button>
              <button
                className="collab-consent-action"
                type="button"
                disabled={
                  busy ||
                  preparingPreview ||
                  !teamId ||
                  !workspaceId ||
                  availableTeams.length === 0 ||
                  (workflow.kind === "new" &&
                    selectedDestinationGrant?.lifecycle === "active") ||
                  (workflow.kind === "new" &&
                    Boolean(selectedDestinationPendingShare)) ||
                  (workflow.kind === "change" &&
                    workflow.grant.maximumFidelity === maximumFidelity &&
                    workflow.grant.includeCuratedMemory ===
                      includeCuratedMemory)
                }
                onClick={() =>
                  void (preview ? confirmShare() : prepareAndPreview())
                }
                aria-busy={consentActionPending ? "true" : undefined}
              >
                {consentActionPending ? (
                  <LoaderCircle className="collab-spin" aria-hidden="true" />
                ) : preview ? (
                  consentActionLabel
                ) : (
                  "Review"
                )}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  );
}

function PersonalNoteShareModal({
  client,
  markdownAdapters,
  note,
  onClose,
  onViewShare,
  snapshot
}: {
  client: CollaborationRendererClient;
  markdownAdapters: MarkdownPlatformAdapters;
  note: PersonalDesktopNote;
  onClose: () => void;
  onViewShare?: (shareKey: string) => void;
  snapshot: CollaborationSnapshot;
}) {
  const availableTeams = snapshot.navigation.teams
    .filter((team) => team.lifecycle === "active")
    .map((team) => ({
      ...team,
      workspaces: team.workspaces.filter(
        (workspace) =>
          workspace.lifecycle === "active" && workspace.access === "write"
      )
    }))
    .filter((team) => team.workspaces.length > 0);
  const initialTeam = availableTeams[0] ?? null;
  const [teamId, setTeamId] = useState(initialTeam?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(
    initialTeam?.workspaces[0]?.id ?? ""
  );
  const [candidate, setCandidate] =
    useState<BoundSharedMemoryCandidatePreview | null>(null);
  const [preview, setPreview] = useState<SharedMemoryPreview | null>(null);
  const [mode, setMode] = useState<"snapshot" | "continuous">("continuous");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const selectedTeam =
    availableTeams.find((team) => team.id === teamId) ?? null;
  const workspaces = selectedTeam?.workspaces ?? [];
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? null;

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(failureMessage(cause, "This Note could not be shared."));
    } finally {
      setBusy(false);
    }
  };

  const review = () =>
    run(async () => {
      if (!selectedTeam || !selectedWorkspace) {
        throw new CollaborationInputError(
          "Choose an available Team Workspace."
        );
      }
      if (!note.memoryEventId || note.projectionState !== "available") {
        throw new CollaborationInputError(
          "This Note is still being prepared for sharing."
        );
      }
      const source = {
        kind: "personal_note" as const,
        noteId: note.noteId,
        noteRevision: note.revision,
        memoryEventId: note.memoryEventId,
        logicalMemoryId: note.logicalMemoryId
      };
      const nextCandidate = await client.previewSharedMemoryCandidate({
        source,
        activationRepresentation: "memory_events",
        mode
      });
      if (
        nextCandidate.source?.kind !== "personal_note" ||
        nextCandidate.source.noteId !== note.noteId ||
        nextCandidate.source.noteRevision !== note.revision ||
        nextCandidate.source.memoryEventId !== note.memoryEventId ||
        nextCandidate.sourceRevision !== note.revision ||
        nextCandidate.itemCount !== 1 ||
        nextCandidate.items.length !== 1
      ) {
        throw new CollaborationInputError(
          "The reviewed Note snapshot is no longer available."
        );
      }
      const nextPreview = await client.previewSharedMemory({
        source,
        sourceCapabilities: ["memory_events"],
        logicalMemoryId: nextCandidate.logicalMemoryId,
        teamId,
        workspaceId,
        activationRepresentation: "memory_events",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        mode,
        candidate: {
          source: nextCandidate.source,
          sourceCapabilities: nextCandidate.sourceCapabilities,
          activationRepresentation: nextCandidate.activationRepresentation,
          candidateHash: nextCandidate.candidateHash,
          sourceRevision: nextCandidate.sourceRevision,
          itemCount: nextCandidate.itemCount,
          excludedItemCount: nextCandidate.excludedItemCount,
          manifest: nextCandidate.manifest,
          byteCount: nextCandidate.byteCount,
          mode,
          expiresAt: null
        }
      });
      if (
        nextPreview.activationRepresentation !== "memory_events" ||
        nextPreview.itemCount !== 1 ||
        nextPreview.items.length !== 1
      ) {
        throw new CollaborationInputError(
          "The Team policy did not approve this one-Note snapshot."
        );
      }
      setCandidate({ ...nextCandidate, source: nextCandidate.source });
      setPreview(nextPreview);
    });

  const share = () =>
    run(async () => {
      if (!candidate || !preview || !selectedWorkspace) return;
      const existingGrant = (
        await client.listOwnedSharedMemoryGrants({
          logicalMemoryId: candidate.logicalMemoryId
        })
      ).find(
        (grant) =>
          grant.lifecycle === "active" &&
          grant.teamId === teamId &&
          grant.workspaceId === workspaceId
      );
      if (
        existingGrant &&
        existingGrant.sourceRevision >= candidate.sourceRevision
      ) {
        throw new CollaborationInputError(
          "This Note revision is already shared with this Workspace."
        );
      }
      const result = existingGrant
        ? await client.changeSharedMemoryFidelity({
            source: candidate.source,
            sourceCapabilities: ["memory_events"],
            activationRepresentation: "memory_events",
            mutationId: crypto.randomUUID(),
            logicalMemoryId: candidate.logicalMemoryId,
            teamId,
            workspaceId,
            shareGrantId: existingGrant.id,
            consentId: crypto.randomUUID(),
            maximumFidelity: "memory_events",
            includeCuratedMemory: false,
            expectedGrantVersion: existingGrant.grantVersion,
            mode,
            previewRevision: preview.previewRevision,
            previewHash: preview.previewHash,
            expiresAt: null
          })
        : await client.shareMemory({
            source: candidate.source,
            sourceCapabilities: ["memory_events"],
            activationRepresentation: "memory_events",
            mutationId: crypto.randomUUID(),
            logicalGrantId: crypto.randomUUID(),
            consentId: crypto.randomUUID(),
            logicalMemoryId: candidate.logicalMemoryId,
            teamId,
            workspaceId,
            mode,
            maximumFidelity: "memory_events",
            includeCuratedMemory: false,
            previewRevision: preview.previewRevision,
            previewHash: preview.previewHash,
            expiresAt: null
          });
      setPendingKey(
        "ownerUserId" in result ? `grant:${result.id}` : `pending:${result.id}`
      );
    });

  return (
    <Modal label={`Share ${note.title}`} onClose={onClose}>
      <ModalHeader title="Share Note" onClose={onClose} />
      <div className="collab-form collab-share-memory-form">
        {pendingKey ? (
          <div className="collab-share-complete" role="status">
            <CircleCheck aria-hidden="true" />
            <strong>Share accepted</strong>
            <p>Note is being shared {selectedWorkspace?.name}.</p>
          </div>
        ) : (
          <>
            {!preview ? (
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
                      setWorkspaceId(nextTeam?.workspaces[0]?.id ?? "");
                      setCandidate(null);
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
                      setCandidate(null);
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
                <fieldset>
                  <legend>Updates</legend>
                  <label className="collab-check">
                    <input
                      type="radio"
                      checked={mode === "continuous"}
                      onChange={() => {
                        setMode("continuous");
                        setCandidate(null);
                        setPreview(null);
                      }}
                    />
                    Keep this Note up to date
                  </label>
                  <label className="collab-check">
                    <input
                      type="radio"
                      checked={mode === "snapshot"}
                      onChange={() => {
                        setMode("snapshot");
                        setCandidate(null);
                        setPreview(null);
                      }}
                    />
                    Share only this revision
                  </label>
                </fieldset>
              </>
            ) : null}
            {preview ? (
              <>
                <p className="collab-note-share-approval">
                  Approve to share this note with{" "}
                  <strong>{selectedWorkspace?.name}</strong>.
                </p>
                <div className="collab-preview-list shared-conversation-preview">
                  <ConversationRows
                    events={sharedMemoryConversationEvents(preview.items)}
                    markdownAdapters={markdownAdapters}
                    scope="workspace"
                  />
                </div>
              </>
            ) : null}
            <p className="collab-form-context collab-note-share-context">
              {mode === "continuous"
                ? "Later edits will replace the Team copy after privacy checks finish."
                : "Later edits will not change this shared copy."}
            </p>
            {availableTeams.length === 0 ? (
              <p className="collab-form-error" role="alert">
                No writable Team Workspace is available.
              </p>
            ) : null}
          </>
        )}
        {error ? (
          <p className="collab-form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="collab-modal-actions">
          <button className="secondary" onClick={onClose} type="button">
            {pendingKey ? "Close" : "Cancel"}
          </button>
          {pendingKey ? (
            <button onClick={() => onViewShare?.(pendingKey)} type="button">
              View share
            </button>
          ) : (
            <button
              aria-busy={busy ? "true" : undefined}
              disabled={busy || availableTeams.length === 0}
              onClick={() => void (preview ? share() : review())}
              type="button"
            >
              {busy ? "Working…" : preview ? "Approve and share" : "Review"}
            </button>
          )}
        </footer>
      </div>
    </Modal>
  );
}

function ModalLayer({
  client,
  markdownAdapters,
  modal,
  snapshot,
  onClose,
  onOpen,
  onViewShare
}: {
  client: CollaborationRendererClient;
  markdownAdapters: MarkdownPlatformAdapters;
  modal: CollaborationModalState;
  snapshot: CollaborationSnapshot;
  onClose: () => void;
  onOpen: (modal: CollaborationModalState) => void;
  onViewShare?: (shareKey: string) => void;
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
      return "This text is too long.";
    }
    return "";
  };
  const formError = error ? (
    <p className="collab-form-error" role="alert">
      {error}
    </p>
  ) : null;

  if (modal.kind === "share_personal_memory") {
    const entry =
      snapshot.navigation.personal.memory.find(
        (candidate) => candidate.id === modal.sessionId
      ) ?? modal.localEntry;
    return entry ? (
      <SharedMemoryOwnerModal
        client={client}
        entry={entry}
        markdownAdapters={markdownAdapters}
        onViewShare={(shareKey) => {
          if (onViewShare) onViewShare(shareKey);
          else onClose();
        }}
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

  if (modal.kind === "share_personal_note") {
    return (
      <PersonalNoteShareModal
        client={client}
        markdownAdapters={markdownAdapters}
        note={modal.note}
        onClose={onClose}
        onViewShare={onViewShare}
        snapshot={snapshot}
      />
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
  if (modal.kind === "workspace") {
    return form(
      "Create Workspace",
      <>
        <label>
          Name
          <input name="name" autoComplete="off" />
        </label>
        <label>
          Description
          <textarea name="description" />
        </label>
      </>,
      async (target) => {
        const name = value(target, "name");
        const description = value(target, "description");
        const issue = validateName(name) || validateTopic(description);
        if (issue) throw new CollaborationInputError(issue);
        return client.createWorkspace({
          teamId: modal.teamId,
          name,
          description: description || null
        });
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
                      ? { kind: "personal_memory" }
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
  onSelect,
  selectionLoading
}: {
  client: CollaborationRendererClient;
  drafts: CollaborationDrafts;
  markdownAdapters: MarkdownPlatformAdapters;
  snapshot: CollaborationSnapshot;
  onEditChannel: (threadId: string) => void;
  onSharePersonalMemory: (sessionId: string) => void;
  onSelect: (selection: CollaborationSelection) => void;
  selectionLoading: boolean;
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
    (snapshot.connection.state === "disconnected" ||
      snapshot.connection.state === "access_revoked")
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
          client={client}
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
          loading={selectionLoading}
        />
      );
    case "team_people":
      return (
        <PeopleView
          key={snapshot.view.teamId}
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
  selectionLoading?: boolean;
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
      snapshot.navigation.personal.channels.find(
        (thread) => thread.id === authority.threadId
      ) ?? null
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
  selectionLoading = false,
  snapshot
}: CollaborationRoutesProps) {
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
          selectionLoading={selectionLoading}
        />
      )}
    </div>
  );
}

export function CollaborationModalLayer({
  client,
  markdownAdapters,
  modal,
  onModalChange,
  onViewShare,
  snapshot
}: {
  client: CollaborationRendererClient;
  markdownAdapters: MarkdownPlatformAdapters;
  modal: CollaborationModalState | null;
  onModalChange: (modal: CollaborationModalState | null) => void;
  onViewShare?: (shareKey: string) => void;
  snapshot: CollaborationSnapshot;
}) {
  const authorizedModal =
    modal && modalIsAuthorized(modal, snapshot) ? modal : null;
  useEffect(() => {
    if (modal && !authorizedModal) onModalChange(null);
  }, [authorizedModal, modal, onModalChange]);
  if (!authorizedModal) return null;
  return (
    <ModalLayer
      key={
        authorizedModal.kind +
        ("teamId" in authorizedModal ? authorizedModal.teamId : "") +
        ("threadId" in authorizedModal ? authorizedModal.threadId : "") +
        ("sessionId" in authorizedModal ? authorizedModal.sessionId : "")
      }
      client={client}
      markdownAdapters={markdownAdapters}
      modal={authorizedModal}
      snapshot={snapshot}
      onClose={() => onModalChange(null)}
      onOpen={onModalChange}
      onViewShare={onViewShare}
    />
  );
}
