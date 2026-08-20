import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  type CollaborationCommandResult,
  type CollaborationConnection,
  type ConversationSourceAccess,
  type CollaborationDurableSend,
  type CollaborationActionGrantIntent,
  type CollaborationActionGrantReference,
  type CollaborationApprovalReview,
  type CollaborationMessage,
  type CollaborationMessagePage,
  type CollaborationInvitation,
  type CollaborationInvitationPage,
  type CollaborationMembership,
  type CollaborationReadState,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSafeError,
  type CollaborationSelection,
  type CollaborationSnapshot,
  type OwnedShareItem,
  type CollaborationSubscription,
  type CollaborationTeamPerson,
  type CollaborationThread,
  type CollaborationThreadReference,
  type CollaborationWorkspace,
  type CollaborationWorkspaceAccess,
  type PersonalMemoryEntry,
  type PendingShare,
  type SharedMemoryGrant,
  type SharedMemoryCandidatePreview,
  type SharedMemoryPreview,
  type SharedMemoryRepresentation,
  type SharedMemorySourcePage
} from "@koed/shared/collaboration";

import { CollaborationActionGrantProjectionStore } from "./action-grant-projection-store.js";
import { RendererEventQueue } from "./renderer-event-queue.js";
import { CollaborationSelectionViewCache } from "./selection-view-cache.js";
import { SharedSourceBackfillCoordinator } from "./shared-source-backfill.js";
import { CollaborationSubscriptionCoordinator } from "./subscription-coordinator.js";

export interface CollaborationRendererBridge {
  command(
    command: CollaborationRendererCommand
  ): Promise<CollaborationCommandResult>;
  subscribe(listener: (event: CollaborationRendererEvent) => void): () => void;
}

export type CollaborationClientUpdate = {
  kind: "command" | "realtime" | "connection" | "purge";
  authoritativeRecovery?: boolean;
  announcement?: string;
  announcementId?: string;
  realtimeUpdate?: Extract<
    CollaborationRendererEvent,
    { type: "update" }
  >["update"];
};

export type CollaborationClientListener = (
  snapshot: CollaborationSnapshot,
  update: CollaborationClientUpdate
) => void | Promise<void>;

export type CollaborationActionGrantProjection = {
  expiresAt: string;
  id: string;
  operation: string;
  retryable: boolean;
  state:
    | "awaiting_approval"
    | "awaiting_review"
    | "approved"
    | "executing"
    | "completed"
    | "denied"
    | "expired"
    | "canceled"
    | "failed";
};

export class CollaborationClientError extends Error {
  readonly safeError: CollaborationSafeError;

  constructor(error: CollaborationSafeError) {
    super(error.userMessage);
    this.name = "CollaborationClientError";
    this.safeError = error;
  }

  get code(): CollaborationSafeError["code"] {
    return this.safeError.code;
  }

  get retryable(): boolean {
    return this.safeError.retryable;
  }

  get retryAfterMs(): number | null {
    return this.safeError.retryAfterMs;
  }

  get userMessage(): string {
    return this.safeError.userMessage;
  }
}

class CollaborationAuthorityChangedError extends CollaborationClientError {}

export interface CollaborationRendererClient {
  load(): Promise<CollaborationSnapshot>;
  current(): CollaborationSnapshot | null;
  currentRemoteUrl(): string | null;
  currentSelection(): CollaborationSelection;
  subscribe(listener: CollaborationClientListener): () => void;
  currentActionGrants?(): readonly CollaborationActionGrantProjection[];
  subscribeActionGrants?(listener: () => void): () => void;
  cancelActionGrant?(id: string): Promise<void>;
  authorizeManagedConversationTransfer(
    input:
      | {
          operation: "handoff";
          executionId: string;
          operationId: string;
          targetDeviceId: string;
        }
      | {
          operation: "fork";
          executionId: string;
          operationId: string;
          targetDeviceId: string;
          reason:
            | "user_requested"
            | "incompatible_provider"
            | "origin_unavailable"
            | "independent_work";
        }
  ): Promise<CollaborationActionGrantReference>;
  select(selection: CollaborationSelection): Promise<CollaborationSnapshot>;
  connectRemote(input: { remoteUrl: string }): Promise<CollaborationSnapshot>;
  reconnect(): Promise<CollaborationSnapshot>;
  disconnect(): Promise<CollaborationSnapshot>;
  createTeam(input: { name: string }): Promise<CollaborationSnapshot>;
  joinTeam(input: { invitation: string }): Promise<CollaborationSnapshot>;
  createWorkspace(input: {
    teamId: string;
    name: string;
    description: string | null;
  }): Promise<CollaborationSnapshot>;
  createInvitation(input: {
    teamId: string;
    email: string;
    role: "owner" | "admin" | "member";
    defaultWorkspaceId: string;
    defaultWorkspaceAccess: "read" | "write";
    ttlHours: number;
  }): Promise<{
    invitation: CollaborationInvitation;
    invitationUrl: string;
  }>;
  listInvitations(input: {
    teamId: string;
    cursor?: string | null;
  }): Promise<CollaborationInvitationPage>;
  revokeInvitation(input: {
    teamId: string;
    invitationId: string;
    expectedVersion: number;
  }): Promise<CollaborationInvitation>;
  updateMemberRole(input: {
    teamId: string;
    userId: string;
    role: "owner" | "admin" | "member";
    expectedVersion: number;
  }): Promise<CollaborationMembership>;
  disableMember(input: {
    teamId: string;
    userId: string;
    expectedVersion: number;
  }): Promise<CollaborationMembership>;
  leaveTeam(input: {
    teamId: string;
    expectedVersion: number;
  }): Promise<CollaborationMembership>;
  archiveWorkspace(input: {
    teamId: string;
    workspaceId: string;
    expectedVersion: number;
  }): Promise<CollaborationWorkspace>;
  restoreWorkspace(input: {
    teamId: string;
    workspaceId: string;
    expectedVersion: number;
  }): Promise<CollaborationWorkspace>;
  setWorkspaceAccess(input: {
    teamId: string;
    workspaceId: string;
    userId: string;
    access: "disabled" | "read" | "write";
    expectedVersion: number | null;
  }): Promise<CollaborationWorkspaceAccess>;
  setTeamPresence(input: {
    teamId: string;
    mode: "auto" | "manual";
    manualStatus: "available" | "do_not_disturb" | "out_of_office";
    expectedVersion: number;
  }): Promise<CollaborationTeamPerson>;
  reportTeamActivity(teamIds: string[]): Promise<string[]>;
  createPersonalChannel(input: {
    name: string;
    topic: string | null;
  }): Promise<CollaborationSnapshot>;
  renameThread(input: {
    thread: CollaborationThread;
    name: string;
  }): Promise<CollaborationSnapshot>;
  updateThreadTopic(input: {
    thread: CollaborationThread;
    topic: string | null;
  }): Promise<CollaborationSnapshot>;
  archiveThread(input: {
    thread: CollaborationThread;
  }): Promise<CollaborationSnapshot>;
  restoreThread(input: {
    thread: CollaborationThread;
  }): Promise<CollaborationSnapshot>;
  createWorkspaceChannel(input: {
    teamId: string;
    workspaceId: string;
    name: string;
    topic: string | null;
  }): Promise<CollaborationSnapshot>;
  startDirectMessage(input: {
    teamId: string;
    participantUserId: string;
  }): Promise<CollaborationSnapshot>;
  startGroupDirectMessage(input: {
    teamId: string;
    participantUserIds: string[];
  }): Promise<CollaborationSnapshot>;
  sendMessage(input: {
    thread: CollaborationThreadReference;
    clientMessageId: string;
    body: string;
  }): Promise<CollaborationSnapshot>;
  retryMessage(input: {
    thread: CollaborationThreadReference;
    clientMessageId: string;
    body: string;
  }): Promise<CollaborationSnapshot>;
  markRead(input: {
    thread: CollaborationThreadReference;
    messageId: string;
  }): Promise<CollaborationSnapshot>;
  markDelivered(input: {
    thread: CollaborationThreadReference;
    messageId: string;
  }): Promise<CollaborationSnapshot>;
  loadMessagePage(input: {
    thread: CollaborationThreadReference;
    direction: "older" | "newer";
    cursor: string | null;
  }): Promise<CollaborationSnapshot>;
  loadSharedSourcePage(input: {
    teamId: string;
    workspaceId: string;
    sharedSessionId: string;
    direction: "older" | "newer";
    cursor: string | null;
  }): Promise<CollaborationSnapshot>;
  listOwnedSharedMemoryGrants(input: {
    logicalMemoryId: string;
  }): Promise<SharedMemoryGrant[]>;
  listOwnedShares(input: {
    cursor: string | null;
    limit?: number;
    history?: boolean;
  }): Promise<{
    shares: OwnedShareItem[];
    nextCursor: string | null;
  }>;
  getOwnedShare(input: {
    kind: "pending" | "grant";
    id: string;
  }): Promise<OwnedShareItem>;
  renameOwnedShare(input: {
    kind: "pending" | "grant";
    id: string;
    title: string;
  }): Promise<OwnedShareItem>;
  controlPendingShare(input: {
    pendingShareId: string;
    expectedOperationVersion: number;
    action: "retry" | "pause" | "resume" | "revoke";
  }): Promise<PendingShare>;
  shareConversationSource(input: {
    teamId: string;
    shareGrantId: string;
    expectedVersion: number;
    mode: "snapshot" | "continuous";
  }): Promise<ConversationSourceAccess>;
  revokeConversationSource(input: {
    teamId: string;
    shareGrantId: string;
    expectedVersion: number;
    reasonCode: string;
  }): Promise<ConversationSourceAccess>;
  previewSharedMemoryCandidate(input: {
    sessionId: string;
    representation: SharedMemoryRepresentation;
  }): Promise<SharedMemoryCandidatePreview>;
  prepareSharedMemorySource(input: {
    sessionId: string;
  }): Promise<PersonalMemoryEntry>;
  pauseSharedMemorySync(input: {
    sessionId: string;
  }): Promise<PersonalMemoryEntry>;
  resumeSharedMemorySync(input: {
    sessionId: string;
  }): Promise<PersonalMemoryEntry>;
  revokeSharedMemorySync(input: {
    sessionId: string;
  }): Promise<PersonalMemoryEntry>;
  previewSharedMemory(input: {
    logicalMemoryId: string;
    teamId: string;
    workspaceId: string;
    representation: SharedMemoryRepresentation;
    allowedRepresentations: SharedMemoryRepresentation[];
    candidate?: {
      sessionId: string;
      candidateHash: string;
      sourceRevision: number;
      itemCount: number;
      excludedItemCount: number;
      manifest: Array<{ sourceId: string; revisionHash: string }>;
      byteCount: number;
      mode: "snapshot" | "continuous";
      expiresAt: string | null;
    };
  }): Promise<SharedMemoryPreview>;
  loadSharedMemoryPreviewPage(input: {
    previewHash: string;
    cursor: string;
  }): Promise<SharedMemoryPreview>;
  shareMemory(input: {
    mutationId: string;
    logicalGrantId: string;
    consentId: string;
    logicalMemoryId: string;
    teamId: string;
    workspaceId: string;
    mode: "snapshot" | "continuous";
    allowedRepresentations: SharedMemoryRepresentation[];
    selectedRepresentation: SharedMemoryRepresentation;
    previewRevision: number;
    previewHash: string;
    expiresAt: string | null;
    title?: string;
    candidateSessionId?: string;
  }): Promise<SharedMemoryGrant | PendingShare>;
  revokeSharedMemory(input: {
    mutationId: string;
    teamId: string;
    workspaceId: string;
    shareGrantId: string;
    expectedGrantVersion: number;
    reasonCode: string;
  }): Promise<SharedMemoryGrant>;
  changeSharedMemoryRepresentation(input: {
    mutationId: string;
    logicalMemoryId: string;
    teamId: string;
    workspaceId: string;
    shareGrantId: string;
    consentId: string;
    representation: SharedMemoryRepresentation;
    expectedGrantVersion: number;
    mode: "snapshot" | "continuous";
    allowedRepresentations: SharedMemoryRepresentation[];
    previewRevision: number;
    previewHash: string;
    expiresAt: string | null;
    candidateSessionId: string;
  }): Promise<PendingShare>;
  dispose(): void;
}

const AUTHORITATIVE_SNAPSHOT_RECOVERY_MAX_ATTEMPTS = 5;
const AUTHORITATIVE_SNAPSHOT_RECOVERY_BASE_DELAY_MS = 250;
const DELIVERY_RECEIPT_RETRY_BASE_DELAY_MS = 250;
const DELIVERY_RECEIPT_RETRY_MAX_DELAY_MS = 30_000;
const SHARED_SESSION_RECOVERY_TTL_MS = 5 * 60 * 1_000;
const SELECTION_VIEW_CACHE_LIMIT = 32;
const SELECTION_VIEW_CACHE_RETENTION_MS = 15 * 60 * 1_000;
const SHARED_SESSION_PREWARM_LIMIT = 5;
const SHARED_SESSION_PREWARM_CONCURRENCY = 2;

const offlineError = (): CollaborationSafeError => ({
  code: "offline",
  userMessage: collaborationSafeErrorMessages.offline,
  retryable: true,
  retryAfterMs: null
});

const accessRevokedError = (): CollaborationSafeError => ({
  code: "access_revoked",
  userMessage: collaborationSafeErrorMessages.access_revoked,
  retryable: false,
  retryAfterMs: null
});

const temporarilyUnavailableError = (): CollaborationSafeError => ({
  code: "temporarily_unavailable",
  userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
  retryable: true,
  retryAfterMs: null
});

const unavailableConnection = (
  previous: CollaborationConnection
): CollaborationConnection => ({
  state: "unavailable",
  backendId: previous.backendId,
  connectedAt: null,
  retryAt: null,
  reconnectAttempt: previous.reconnectAttempt,
  protocolVersion: COLLABORATION_CONTRACT_VERSION
});

const teamIdForSelection = (
  selection: CollaborationSelection
): string | null => ("teamId" in selection ? selection.teamId : null);

const selectionIdentity = (selection: CollaborationSelection): string => {
  switch (selection.kind) {
    case "personal_memory":
    case "notes_to_self":
      return selection.kind;
    case "personal_channel":
      return `${selection.kind}:${selection.threadId}`;
    case "team_people":
      return `${selection.kind}:${selection.teamId}`;
    case "team_direct_message":
      return `${selection.kind}:${selection.teamId}:${selection.threadId}`;
    case "workspace_shared_memory":
      return `${selection.kind}:${selection.teamId}:${selection.workspaceId}`;
    case "workspace_channel":
      return `${selection.kind}:${selection.teamId}:${selection.workspaceId}:${selection.threadId}`;
    case "shared_session":
      return `${selection.kind}:${selection.teamId}:${selection.workspaceId}:${selection.sharedSessionId}`;
  }
};

const personalFallback = (
  snapshot: CollaborationSnapshot
): Pick<CollaborationSnapshot, "selection" | "view"> => ({
  selection: { kind: "notes_to_self" },
  view: {
    kind: "thread",
    thread: snapshot.navigation.personal.notesToSelf,
    messages: {
      snapshotRevision: snapshot.snapshotRevision,
      threadId: snapshot.navigation.personal.notesToSelf.id,
      items: [],
      olderCursor: null,
      newerCursor: null,
      hasOlder: false,
      hasNewer: false
    }
  }
});

const teamPeopleFallback = (
  snapshot: CollaborationSnapshot,
  teamId: string
): Pick<CollaborationSnapshot, "selection" | "view"> | null => {
  const team = snapshot.navigation.teams.find(
    (candidate) => candidate.id === teamId
  );
  return team
    ? {
        selection: { kind: "team_people", teamId },
        view: { kind: "team_people", teamId, people: team.people }
      }
    : null;
};

const emptyMessagePage = (
  snapshot: CollaborationSnapshot,
  thread: CollaborationThread
): CollaborationMessagePage => ({
  snapshotRevision: snapshot.snapshotRevision,
  threadId: thread.id,
  items: [],
  olderCursor: null,
  newerCursor: null,
  hasOlder: false,
  hasNewer: false
});

const optimisticSelection = (
  snapshot: CollaborationSnapshot,
  selection: CollaborationSelection
): Pick<CollaborationSnapshot, "selection" | "view"> | null => {
  if (selection.kind === "personal_memory") {
    return {
      selection,
      view: {
        kind: "personal_memory",
        entries: snapshot.navigation.personal.memory
      }
    };
  }
  if (selection.kind === "notes_to_self") {
    const thread = snapshot.navigation.personal.notesToSelf;
    return {
      selection,
      view: {
        kind: "thread",
        thread,
        messages: emptyMessagePage(snapshot, thread)
      }
    };
  }
  if (selection.kind === "personal_channel") {
    const thread = snapshot.navigation.personal.channels.find(
      (candidate) => candidate.id === selection.threadId
    );
    return thread
      ? {
          selection,
          view: {
            kind: "thread",
            thread,
            messages: emptyMessagePage(snapshot, thread)
          }
        }
      : null;
  }
  const team = snapshot.navigation.teams.find(
    (candidate) => candidate.id === selection.teamId
  );
  if (!team || team.lifecycle !== "active") return null;
  if (selection.kind === "team_people") {
    return {
      selection,
      view: { kind: "team_people", teamId: team.id, people: team.people }
    };
  }
  if (selection.kind === "team_direct_message") {
    const thread = team.directMessages.find(
      (candidate) => candidate.id === selection.threadId
    );
    return thread
      ? {
          selection,
          view: {
            kind: "thread",
            thread,
            messages: emptyMessagePage(snapshot, thread)
          }
        }
      : null;
  }
  const workspace = team.workspaces.find(
    (candidate) => candidate.id === selection.workspaceId
  );
  if (!workspace || workspace.lifecycle !== "active") return null;
  if (selection.kind === "workspace_shared_memory") {
    return {
      selection,
      view: {
        kind: "shared_memory_index",
        teamId: team.id,
        workspaceId: workspace.id,
        sessions: workspace.sharedMemory
      }
    };
  }
  if (selection.kind === "workspace_channel") {
    const thread = workspace.channels.find(
      (candidate) => candidate.id === selection.threadId
    );
    return thread
      ? {
          selection,
          view: {
            kind: "thread",
            thread,
            messages: emptyMessagePage(snapshot, thread)
          }
        }
      : null;
  }
  return null;
};

const threadReference = (
  thread: CollaborationThread
): CollaborationThreadReference =>
  thread.scope === "personal"
    ? { scope: "personal", threadId: thread.id }
    : { scope: "team", teamId: thread.teamId, threadId: thread.id };

const selectionForThread = (
  thread: CollaborationThread
): CollaborationSelection => {
  switch (thread.kind) {
    case "notes_to_self":
      return { kind: "notes_to_self" };
    case "personal_channel":
      return { kind: "personal_channel", threadId: thread.id };
    case "workspace_channel":
      return {
        kind: "workspace_channel",
        teamId: thread.teamId,
        workspaceId: thread.workspaceId,
        threadId: thread.id
      };
    case "dm":
    case "group_dm":
      return {
        kind: "team_direct_message",
        teamId: thread.teamId,
        threadId: thread.id
      };
    case "shared_session_discussion":
      return {
        kind: "shared_session",
        teamId: thread.teamId,
        workspaceId: thread.workspaceId,
        sharedSessionId: thread.sharedLogicalMemoryId
      };
  }
};

const mapThread = (
  snapshot: CollaborationSnapshot,
  threadId: string,
  update: (thread: CollaborationThread) => CollaborationThread
): CollaborationSnapshot => {
  const personal = snapshot.navigation.personal;
  const notesToSelf =
    personal.notesToSelf.id === threadId
      ? (update(personal.notesToSelf) as typeof personal.notesToSelf)
      : personal.notesToSelf;
  const channels = personal.channels.map((thread) =>
    thread.id === threadId ? (update(thread) as typeof thread) : thread
  );
  const teams = snapshot.navigation.teams.map((team) => ({
    ...team,
    directMessages: team.directMessages.map((thread) =>
      thread.id === threadId ? (update(thread) as typeof thread) : thread
    ),
    workspaces: team.workspaces.map((workspace) => ({
      ...workspace,
      channels: workspace.channels.map((thread) =>
        thread.id === threadId ? (update(thread) as typeof thread) : thread
      )
    }))
  }));
  let view = snapshot.view;
  if (view.kind === "thread" && view.thread.id === threadId) {
    view = { ...view, thread: update(view.thread) };
  } else if (
    view.kind === "shared_session" &&
    view.companion.thread.id === threadId
  ) {
    view = {
      ...view,
      companion: {
        ...view.companion,
        thread: update(view.companion.thread) as typeof view.companion.thread
      }
    };
  }
  return {
    ...snapshot,
    navigation: {
      ...snapshot.navigation,
      personal: { ...personal, notesToSelf, channels },
      teams
    },
    view
  };
};

const withRecomputedTeamUnreadCounts = (
  snapshot: CollaborationSnapshot
): CollaborationSnapshot => ({
  ...snapshot,
  navigation: {
    ...snapshot.navigation,
    teams: snapshot.navigation.teams.map((team) => ({
      ...team,
      unreadCount:
        team.directMessages.reduce(
          (total, thread) => total + thread.unreadCount,
          0
        ) +
        team.workspaces.reduce(
          (total, workspace) =>
            total +
            workspace.channels.reduce(
              (channelTotal, thread) => channelTotal + thread.unreadCount,
              0
            ) +
            workspace.sharedMemory.reduce(
              (memoryTotal, session) =>
                memoryTotal + session.unreadCompanionCount,
              0
            ),
          0
        )
    }))
  }
});

const applyCompanionUnreadCount = (
  snapshot: CollaborationSnapshot,
  threadId: string,
  unreadCount: number
): CollaborationSnapshot =>
  withRecomputedTeamUnreadCounts({
    ...snapshot,
    navigation: {
      ...snapshot.navigation,
      teams: snapshot.navigation.teams.map((team) => ({
        ...team,
        workspaces: team.workspaces.map((workspace) => ({
          ...workspace,
          sharedMemory: workspace.sharedMemory.map((session) =>
            session.companionThreadId === threadId
              ? { ...session, unreadCompanionCount: unreadCount }
              : session
          )
        }))
      }))
    },
    view:
      snapshot.view.kind === "shared_session" &&
      snapshot.view.companion.thread.id === threadId
        ? {
            ...snapshot.view,
            session: {
              ...snapshot.view.session,
              unreadCompanionCount: unreadCount
            }
          }
        : snapshot.view
  });

const upsertThread = (
  snapshot: CollaborationSnapshot,
  thread: CollaborationThread
): CollaborationSnapshot => {
  if (thread.kind === "notes_to_self") {
    return {
      ...snapshot,
      navigation: {
        ...snapshot.navigation,
        personal: {
          ...snapshot.navigation.personal,
          notesToSelf: thread
        }
      }
    };
  }
  if (thread.kind === "personal_channel") {
    const channels = snapshot.navigation.personal.channels.filter(
      (candidate) => candidate.id !== thread.id
    );
    return {
      ...snapshot,
      navigation: {
        ...snapshot.navigation,
        personal: {
          ...snapshot.navigation.personal,
          channels: [...channels, thread]
        }
      }
    };
  }
  return {
    ...snapshot,
    navigation: {
      ...snapshot.navigation,
      teams: snapshot.navigation.teams.map((team) => {
        if (team.id !== thread.teamId) return team;
        if (thread.kind === "dm" || thread.kind === "group_dm") {
          return {
            ...team,
            directMessages: [
              ...team.directMessages.filter(
                (candidate) => candidate.id !== thread.id
              ),
              thread
            ]
          };
        }
        if (
          thread.kind === "workspace_channel" ||
          thread.kind === "shared_session_discussion"
        ) {
          return {
            ...team,
            workspaces: team.workspaces.map((workspace) =>
              workspace.id === thread.workspaceId &&
              thread.kind === "workspace_channel"
                ? {
                    ...workspace,
                    channels: [
                      ...workspace.channels.filter(
                        (candidate) => candidate.id !== thread.id
                      ),
                      thread
                    ]
                  }
                : workspace
            )
          };
        }
        return team;
      })
    }
  };
};

const applyThreadUpsert = (
  snapshot: CollaborationSnapshot,
  thread: CollaborationThread
): CollaborationSnapshot => {
  const next = mapThread(
    upsertThread(snapshot, thread),
    thread.id,
    () => thread
  );
  return thread.kind === "shared_session_discussion"
    ? applyCompanionUnreadCount(next, thread.id, thread.unreadCount)
    : withRecomputedTeamUnreadCounts(next);
};

const removeThread = (
  snapshot: CollaborationSnapshot,
  threadId: string
): CollaborationSnapshot => {
  const selectedThreadId =
    "threadId" in snapshot.selection ? snapshot.selection.threadId : null;
  const fallback =
    selectedThreadId === threadId ? personalFallback(snapshot) : null;
  return {
    ...snapshot,
    navigation: {
      ...snapshot.navigation,
      personal: {
        ...snapshot.navigation.personal,
        channels: snapshot.navigation.personal.channels.filter(
          (thread) => thread.id !== threadId
        )
      },
      teams: snapshot.navigation.teams.map((team) => ({
        ...team,
        directMessages: team.directMessages.filter(
          (thread) => thread.id !== threadId
        ),
        workspaces: team.workspaces.map((workspace) => ({
          ...workspace,
          channels: workspace.channels.filter(
            (thread) => thread.id !== threadId
          )
        }))
      }))
    },
    ...(fallback ?? {})
  };
};

const mergeMessages = (
  current: CollaborationMessagePage,
  incoming: CollaborationMessagePage,
  direction: "older" | "newer",
  maximum: number
): CollaborationMessagePage => {
  const byId = new Map<string, CollaborationMessage>();
  for (const message of [...current.items, ...incoming.items]) {
    byId.set(message.clientMessageId ?? message.id, message);
  }
  const sorted = [...byId.values()].sort(
    (left, right) => left.sequence - right.sequence
  );
  const items =
    sorted.length <= maximum
      ? sorted
      : direction === "older"
        ? sorted.slice(0, maximum)
        : sorted.slice(-maximum);
  return {
    ...incoming,
    items,
    olderCursor: incoming.olderCursor ?? current.olderCursor,
    newerCursor: incoming.newerCursor ?? current.newerCursor,
    hasOlder: incoming.hasOlder,
    hasNewer: incoming.hasNewer
  };
};

const applyMessagePage = (
  snapshot: CollaborationSnapshot,
  page: CollaborationMessagePage,
  direction: "older" | "newer"
): CollaborationSnapshot => {
  const maximum = snapshot.limits.renderedRowMaxCount;
  if (
    snapshot.view.kind === "thread" &&
    snapshot.view.thread.id === page.threadId
  ) {
    return {
      ...snapshot,
      view: {
        ...snapshot.view,
        messages: mergeMessages(
          snapshot.view.messages,
          page,
          direction,
          maximum
        )
      }
    };
  }
  if (
    snapshot.view.kind === "shared_session" &&
    snapshot.view.companion.thread.id === page.threadId
  ) {
    return {
      ...snapshot,
      view: {
        ...snapshot.view,
        companion: {
          ...snapshot.view.companion,
          messages: mergeMessages(
            snapshot.view.companion.messages,
            page,
            direction,
            maximum
          )
        }
      }
    };
  }
  return snapshot;
};

const applyMessage = (
  snapshot: CollaborationSnapshot,
  message: CollaborationMessage
): CollaborationSnapshot => {
  const apply = (page: CollaborationMessagePage): CollaborationMessagePage => {
    if (page.threadId !== message.threadId) return page;
    const items = [
      ...page.items.filter(
        (candidate) =>
          candidate.id !== message.id &&
          (!message.clientMessageId ||
            candidate.clientMessageId !== message.clientMessageId)
      ),
      message
    ]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-snapshot.limits.renderedRowMaxCount);
    return { ...page, items };
  };
  let next: CollaborationSnapshot = {
    ...snapshot,
    outbox: message.clientMessageId
      ? (snapshot.outbox ?? []).filter(
          (send) => send.clientMessageId !== message.clientMessageId
        )
      : (snapshot.outbox ?? [])
  };
  if (snapshot.view.kind === "thread") {
    next = {
      ...next,
      view: { ...snapshot.view, messages: apply(snapshot.view.messages) }
    };
  } else if (snapshot.view.kind === "shared_session") {
    next = {
      ...next,
      view: {
        ...snapshot.view,
        companion: {
          ...snapshot.view.companion,
          messages: apply(snapshot.view.companion.messages)
        }
      }
    };
  }
  const currentUserIds = new Set([
    snapshot.navigation.personalOwner.id,
    ...(snapshot.navigation.teamPrincipal
      ? [snapshot.navigation.teamPrincipal.id]
      : [])
  ]);
  if (currentUserIds.has(message.sender.id)) return next;
  const updated = mapThread(next, message.threadId, (thread) => ({
    ...thread,
    latestSequence: Math.max(thread.latestSequence, message.sequence),
    unreadCount: thread.unreadCount + 1,
    updatedAt: message.updatedAt,
    lastActivityAt: message.createdAt
  }));
  const companionSession = snapshot.navigation.teams
    .flatMap((team) => team.workspaces)
    .flatMap((workspace) => workspace.sharedMemory)
    .find((session) => session.companionThreadId === message.threadId);
  return companionSession
    ? applyCompanionUnreadCount(
        updated,
        message.threadId,
        companionSession.unreadCompanionCount + 1
      )
    : withRecomputedTeamUnreadCounts(updated);
};

const upsertDurableSend = (
  snapshot: CollaborationSnapshot,
  send: CollaborationDurableSend
): CollaborationSnapshot => ({
  ...snapshot,
  outbox: [
    ...(snapshot.outbox ?? []).filter(
      (candidate) => candidate.clientMessageId !== send.clientMessageId
    ),
    send
  ].sort(
    (left, right) =>
      left.localCreationOrder - right.localCreationOrder ||
      left.createdAt.localeCompare(right.createdAt)
  )
});

const threadAuthorityIsCurrent = (
  snapshot: CollaborationSnapshot,
  send: CollaborationDurableSend
): boolean => {
  const authority = send.authority;
  if (authority.scope === "personal") {
    return (
      authority.ownerUserId === snapshot.navigation.personalOwner.id &&
      ((snapshot.navigation.personal.notesToSelf.id === authority.threadId &&
        snapshot.navigation.personal.notesToSelf.canPost) ||
        snapshot.navigation.personal.channels.some(
          (thread) => thread.id === authority.threadId && thread.canPost
        ))
    );
  }
  if (
    snapshot.connection.backendId !== authority.backendId ||
    snapshot.navigation.teamPrincipal?.id !== authority.principalUserId
  ) {
    return false;
  }
  const team = snapshot.navigation.teams.find(
    (candidate) =>
      candidate.id === authority.teamId && candidate.lifecycle === "active"
  );
  if (!team) return false;
  if (authority.workspaceId === null) {
    return team.directMessages.some(
      (thread) => thread.id === authority.threadId && thread.canPost
    );
  }
  const workspace = team.workspaces.find(
    (candidate) =>
      candidate.id === authority.workspaceId &&
      candidate.lifecycle === "active" &&
      candidate.access === "write"
  );
  if (!workspace) return false;
  return (
    workspace.channels.some(
      (thread) => thread.id === authority.threadId && thread.canPost
    ) ||
    workspace.sharedMemory.some(
      (session) => session.companionThreadId === authority.threadId
    )
  );
};

const sanitizeOutbox = (
  snapshot: CollaborationSnapshot
): CollaborationSnapshot => ({
  ...snapshot,
  outbox: (snapshot.outbox ?? []).filter((send) =>
    threadAuthorityIsCurrent(snapshot, send)
  )
});

const messageDeliveryError = (
  message: CollaborationMessage
): CollaborationClientError | Error | null => {
  if (message.delivery !== "failed") return null;
  return message.failure
    ? new CollaborationClientError(message.failure)
    : new Error("Collaboration message delivery failed.");
};

const applyReadState = (
  snapshot: CollaborationSnapshot,
  readState: CollaborationReadState
): CollaborationSnapshot => {
  const next = mapThread(snapshot, readState.threadId, (thread) => ({
    ...thread,
    unreadCount: readState.unreadCount,
    lastReadMessageId: readState.messageId,
    lastReadSequence: readState.sequence
  }));
  return applyCompanionUnreadCount(
    next,
    readState.threadId,
    readState.unreadCount
  );
};

const applyMessageReceipts = (
  snapshot: CollaborationSnapshot,
  threadId: string,
  receipts: Array<{
    messageId: string;
    recipientStatus: "sent" | "delivered" | "read";
  }>
): CollaborationSnapshot => {
  const byId = new Map(
    receipts.map((receipt) => [receipt.messageId, receipt.recipientStatus])
  );
  const apply = (page: CollaborationMessagePage): CollaborationMessagePage => ({
    ...page,
    items: page.items.map((message) => {
      const recipientStatus = byId.get(message.id);
      return recipientStatus ? { ...message, recipientStatus } : message;
    })
  });
  if (snapshot.view.kind === "thread" && snapshot.view.thread.id === threadId) {
    return {
      ...snapshot,
      view: { ...snapshot.view, messages: apply(snapshot.view.messages) }
    };
  }
  if (
    snapshot.view.kind === "shared_session" &&
    snapshot.view.companion.thread.id === threadId
  ) {
    return {
      ...snapshot,
      view: {
        ...snapshot.view,
        companion: {
          ...snapshot.view.companion,
          messages: apply(snapshot.view.companion.messages)
        }
      }
    };
  }
  return snapshot;
};

const applyPersonalMemoryEntry = (
  snapshot: CollaborationSnapshot,
  entry: PersonalMemoryEntry
): CollaborationSnapshot => {
  const entries = [
    ...snapshot.navigation.personal.memory.filter(
      (candidate) => candidate.id !== entry.id
    ),
    entry
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    ...snapshot,
    navigation: {
      ...snapshot.navigation,
      personal: { ...snapshot.navigation.personal, memory: entries }
    },
    view:
      snapshot.view.kind === "personal_memory"
        ? { ...snapshot.view, entries }
        : snapshot.view
  };
};

const applyMembership = (
  snapshot: CollaborationSnapshot,
  membership: CollaborationMembership
): CollaborationSnapshot => {
  const updatePeople = (
    people: CollaborationSnapshot["navigation"]["teams"][number]["people"]
  ) =>
    people.map((person) =>
      person.id !== membership.userId
        ? person
        : {
            ...person,
            displayName: membership.displayName ?? person.displayName,
            membershipState:
              membership.status === "disabled"
                ? ("disabled" as const)
                : ("enabled" as const),
            management: person.management
              ? {
                  ...person.management,
                  membershipId: membership.id,
                  email: membership.email ?? person.management.email,
                  role: membership.role,
                  status: membership.status,
                  version: membership.version
                }
              : undefined
          }
    );
  const teams = snapshot.navigation.teams.map((team) =>
    team.id !== membership.teamId
      ? team
      : {
          ...team,
          role:
            snapshot.navigation.teamPrincipal?.id === membership.userId
              ? membership.role
              : team.role,
          membershipVersion:
            snapshot.navigation.teamPrincipal?.id === membership.userId
              ? membership.version
              : team.membershipVersion,
          people: updatePeople(team.people)
        }
  );
  const next: CollaborationSnapshot = {
    ...snapshot,
    navigation: { ...snapshot.navigation, teams },
    view:
      snapshot.view.kind === "team_people" &&
      snapshot.view.teamId === membership.teamId
        ? { ...snapshot.view, people: updatePeople(snapshot.view.people) }
        : snapshot.view
  };
  if (
    membership.status === "disabled" &&
    snapshot.navigation.teamPrincipal?.id === membership.userId
  ) {
    return {
      ...next,
      navigation: {
        ...next.navigation,
        teams: next.navigation.teams.filter(
          (team) => team.id !== membership.teamId
        )
      },
      ...(teamIdForSelection(next.selection) === membership.teamId
        ? personalFallback(next)
        : {})
    };
  }
  return next;
};

const applyWorkspaceAccess = (
  snapshot: CollaborationSnapshot,
  teamId: string,
  access: CollaborationWorkspaceAccess
): CollaborationSnapshot => {
  const updatePeople = (
    people: CollaborationSnapshot["navigation"]["teams"][number]["people"]
  ) =>
    people.map((person) => {
      if (person.id !== access.userId || !person.management) return person;
      return {
        ...person,
        management: {
          ...person.management,
          workspaceAccess: [
            ...person.management.workspaceAccess.filter(
              (candidate) => candidate.workspaceId !== access.workspaceId
            ),
            access
          ]
        }
      };
    });
  const teams = snapshot.navigation.teams.map((team) =>
    team.id === teamId ? { ...team, people: updatePeople(team.people) } : team
  );
  return {
    ...snapshot,
    navigation: { ...snapshot.navigation, teams },
    view:
      snapshot.view.kind === "team_people" && snapshot.view.teamId === teamId
        ? { ...snapshot.view, people: updatePeople(snapshot.view.people) }
        : snapshot.view
  };
};

const applyWorkspace = (
  snapshot: CollaborationSnapshot,
  workspace: CollaborationWorkspace
): CollaborationSnapshot => {
  const lifecycle: "active" | "archived" | "purged" =
    workspace.lifecycle === "active" || workspace.lifecycle === "archived"
      ? workspace.lifecycle
      : "purged";
  const teams = snapshot.navigation.teams.map((team) =>
    team.id !== workspace.teamId
      ? team
      : {
          ...team,
          workspaces: team.workspaces.map((candidate) =>
            candidate.id === workspace.id
              ? {
                  ...candidate,
                  name: workspace.name,
                  description: workspace.description,
                  lifecycle,
                  version: workspace.version
                }
              : candidate
          )
        }
  );
  const selectedWorkspace =
    "workspaceId" in snapshot.selection &&
    snapshot.selection.workspaceId === workspace.id;
  const team = teams.find((candidate) => candidate.id === workspace.teamId);
  return {
    ...snapshot,
    navigation: { ...snapshot.navigation, teams },
    ...(selectedWorkspace && lifecycle !== "active" && team
      ? {
          selection: { kind: "team_people" as const, teamId: team.id },
          view: {
            kind: "team_people" as const,
            teamId: team.id,
            people: team.people
          }
        }
      : {})
  };
};

const mergeSourcePage = (
  snapshot: CollaborationSnapshot,
  page: SharedMemorySourcePage,
  direction: "older" | "newer"
): CollaborationSnapshot => {
  if (
    snapshot.view.kind !== "shared_session" ||
    snapshot.view.session.id !== page.sharedSessionId ||
    snapshot.view.source.representation !== page.representation
  ) {
    return snapshot;
  }
  const byId = new Map(
    snapshot.view.source.items.map((item) => [item.id, item])
  );
  for (const item of page.items) byId.set(item.id, item);
  const sorted = [...byId.values()].sort(
    (left, right) => left.sequence - right.sequence
  );
  const maximum = snapshot.limits.renderedRowMaxCount;
  const items =
    sorted.length <= maximum
      ? sorted
      : direction === "older"
        ? sorted.slice(0, maximum)
        : sorted.slice(-maximum);
  return {
    ...snapshot,
    view: {
      ...snapshot.view,
      source: {
        ...page,
        items,
        olderCursor: page.olderCursor ?? snapshot.view.source.olderCursor,
        newerCursor: page.newerCursor ?? snapshot.view.source.newerCursor
      }
    }
  };
};

export const createCollaborationRendererClient = (
  bridge: CollaborationRendererBridge,
  options: {
    confirmNativeReview?: (
      review: CollaborationApprovalReview
    ) => boolean | Promise<boolean>;
  } = {}
): CollaborationRendererClient => {
  let snapshot: CollaborationSnapshot | null = null;
  let disposed = false;
  let connectedRemoteUrl: string | null = null;
  const appliedReceiptVersions = new Map<string, number>();
  const pendingDeliveryReceipts = new Map<
    string,
    {
      attempt: number;
      messageId: string;
      sequence: number;
      thread: CollaborationThreadReference;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  const listeners = new Set<CollaborationClientListener>();
  const actionGrantProjections = new CollaborationActionGrantProjectionStore();
  const selectionViews = new CollaborationSelectionViewCache(
    selectionIdentity,
    teamIdForSelection,
    SELECTION_VIEW_CACHE_LIMIT,
    SELECTION_VIEW_CACHE_RETENTION_MS
  );
  const sourceBackfills = new SharedSourceBackfillCoordinator();
  let authorityGeneration = 0;
  let authorityChangeWasRevocation = false;
  let selectionRequestGeneration = 0;
  let selectionIntentGeneration = 0;
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];
  const seenDeliveries = new Set<string>();
  const seenDeliveryOrder: string[] = [];
  const encoder = new TextEncoder();
  const confirmNativeReview =
    options.confirmNativeReview ??
    ((review: CollaborationApprovalReview) => {
      const details = review.details
        .map((entry) => `${entry.label}: ${entry.value}`)
        .join("\n");
      return globalThis.confirm(
        [review.title, review.description, details, review.consequence]
          .filter(Boolean)
          .join("\n\n")
      );
    });
  let pendingSharedSessionRecovery: {
    selection: Extract<CollaborationSelection, { kind: "shared_session" }>;
    expiresAt: number;
  } | null = null;
  let reloadAuthoritativeSnapshot:
    | ((preferredSelection?: CollaborationSelection) => Promise<void>)
    | null = null;
  let hydratePersonalFallback:
    | ((
        scope: { kind: "team"; teamId: string } | { kind: "all" }
      ) => Promise<void>)
    | null = null;

  const limits = () => snapshot?.limits ?? COLLABORATION_DEFAULT_LIMITS;

  const actionGrantOperation = (
    intent: CollaborationActionGrantIntent["intent"]
  ): string => {
    const labels: Record<CollaborationActionGrantIntent["intent"], string> = {
      "collaboration.create_team": "Create Team",
      "collaboration.join_team": "Join Team",
      "collaboration.create_workspace": "Create Workspace",
      "collaboration.create_invitation": "Create invitation",
      "collaboration.revoke_invitation": "Revoke invitation",
      "collaboration.update_member_role": "Change member role",
      "collaboration.disable_member": "Disable member",
      "collaboration.leave_team": "Leave Team",
      "collaboration.archive_workspace": "Archive Workspace",
      "collaboration.restore_workspace": "Restore Workspace",
      "collaboration.set_workspace_access": "Change Workspace access",
      "collaboration.preview_shared_memory": "Preview Shared Memory",
      "collaboration.share_memory": "Share Memory",
      "collaboration.revoke_shared_memory": "Revoke Shared Memory",
      "collaboration.change_shared_memory_representation":
        "Change Shared Memory representation",
      "collaboration.share_conversation_source": "Share Conversation source",
      "collaboration.revoke_conversation_source":
        "Revoke Conversation source access",
      "collaboration.managed_conversation_handoff":
        "Move Conversation to another device",
      "collaboration.managed_conversation_fork":
        "Fork Conversation on another device"
    };
    return labels[intent];
  };

  const terminalProjectionState = (
    state: "consumed" | "denied" | "revoked" | "expired" | "canceled"
  ): CollaborationActionGrantProjection["state"] =>
    state === "consumed" ? "completed" : state === "revoked" ? "denied" : state;

  const publishActionGrant = (projection: CollaborationActionGrantProjection) =>
    actionGrantProjections.publish(projection);

  const rememberSelectionView = (next: CollaborationSnapshot) =>
    selectionViews.remember(next);
  const cachedSelectionView = (selection: CollaborationSelection) =>
    selectionViews.get(selection);
  const clearTeamSelectionViews = (teamId?: string) =>
    selectionViews.clearTeam(teamId);
  const clearThreadSelectionViews = (threadId: string) =>
    selectionViews.clearThread(threadId);
  const clearSharedSessionSelectionView = (sharedSessionId: string) =>
    selectionViews.clearSharedSession(sharedSessionId);

  const recoverableSharedSessionSelection = () => {
    if (
      pendingSharedSessionRecovery &&
      pendingSharedSessionRecovery.expiresAt <= Date.now()
    ) {
      pendingSharedSessionRecovery = null;
    }
    return pendingSharedSessionRecovery?.selection ?? null;
  };

  const rememberSharedSessionSelection = (
    selection: Extract<CollaborationSelection, { kind: "shared_session" }>
  ) => {
    pendingSharedSessionRecovery = {
      selection,
      expiresAt: Date.now() + SHARED_SESSION_RECOVERY_TTL_MS
    };
  };

  const remember = (set: Set<string>, order: string[], id: string) => {
    if (set.has(id)) return false;
    set.add(id);
    order.push(id);
    while (order.length > limits().rendererMaxPendingEvents) {
      const removed = order.shift();
      if (removed) set.delete(removed);
    }
    return true;
  };

  const clearTeamDeliveryHistory = () => {
    seenEventIds.clear();
    seenEventOrder.length = 0;
    seenDeliveries.clear();
    seenDeliveryOrder.length = 0;
  };

  const applyAuthoritativeReadState = (
    current: CollaborationSnapshot,
    readState: CollaborationReadState
  ): CollaborationSnapshot => {
    const appliedVersion = appliedReceiptVersions.get(readState.threadId) ?? 0;
    if (readState.version < appliedVersion) return current;
    appliedReceiptVersions.set(readState.threadId, readState.version);
    return applyReadState(current, readState);
  };

  const clearPendingTeamDeliveryReceipts = (teamId?: string) => {
    for (const [threadId, pending] of pendingDeliveryReceipts) {
      if (
        pending.thread.scope !== "team" ||
        (teamId && pending.thread.teamId !== teamId)
      ) {
        continue;
      }
      if (pending.timer) clearTimeout(pending.timer);
      pendingDeliveryReceipts.delete(threadId);
    }
  };

  const clearPendingDeliveryReceipts = () => {
    for (const pending of pendingDeliveryReceipts.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    pendingDeliveryReceipts.clear();
  };

  const publishTrusted = async (
    next: CollaborationSnapshot,
    update: CollaborationClientUpdate,
    options: { rememberView?: boolean } = {}
  ) => {
    snapshot = sanitizeOutbox(next);
    if (options.rememberView !== false) rememberSelectionView(snapshot);
    await Promise.all(
      [...listeners].map(async (listener) => {
        await listener(snapshot!, update);
      })
    );
  };

  const publish = async (
    next: CollaborationSnapshot,
    update: CollaborationClientUpdate,
    options: { rememberView?: boolean } = {}
  ) => {
    await publishTrusted(next, update, options);
  };

  const publishValidated = async (
    next: CollaborationSnapshot,
    update: CollaborationClientUpdate,
    options: { rememberView?: boolean } = {}
  ) => {
    await publishTrusted(
      collaborationSnapshotSchema.parse(next),
      update,
      options
    );
  };

  const purgeTeam = async (
    teamId: string,
    announcement: string = collaborationSafeErrorMessages.access_revoked,
    hydratePersonal = true
  ) => {
    if (!snapshot) return;
    clearTeamSelectionViews(teamId);
    clearTeamDeliveryHistory();
    clearPendingTeamDeliveryReceipts(teamId);
    const selectedTeamId = teamIdForSelection(snapshot.selection);
    const shouldHydratePersonal = selectedTeamId === teamId;
    const next = {
      ...snapshot,
      navigation: {
        ...snapshot.navigation,
        teams: snapshot.navigation.teams.filter((team) => team.id !== teamId)
      },
      ...(shouldHydratePersonal ? personalFallback(snapshot) : {})
    };
    await publish(next, { kind: "purge", announcement });
    if (shouldHydratePersonal && hydratePersonal) {
      await hydratePersonalFallback?.({ kind: "team", teamId });
    }
  };

  const purgeAllTeams = async (
    connection: CollaborationConnection,
    announcement?: string,
    hydratePersonal = true
  ) => {
    if (!snapshot) return;
    clearTeamSelectionViews();
    clearTeamDeliveryHistory();
    clearPendingTeamDeliveryReceipts();
    const selectedTeamId = teamIdForSelection(snapshot.selection);
    const shouldHydratePersonal = selectedTeamId !== null;
    const next = {
      ...snapshot,
      connection,
      navigation: { ...snapshot.navigation, teams: [] },
      ...(shouldHydratePersonal ? personalFallback(snapshot) : {})
    };
    await publish(next, { kind: "purge", announcement });
    if (shouldHydratePersonal && hydratePersonal) {
      await hydratePersonalFallback?.({ kind: "all" });
    }
  };

  const run = async (
    value: CollaborationRendererCommand
  ): Promise<CollaborationCommandResult> => {
    try {
      if (disposed) throw new CollaborationClientError(offlineError());
      const command = collaborationRendererCommandSchema.parse(value);
      const commandAuthorityGeneration = authorityGeneration;
      const result = await bridge.command(command);
      if (
        result.requestId !== command.requestId ||
        result.command !== command.command
      ) {
        throw new Error("Invalid collaboration command correlation.");
      }
      if (
        command.command !== "collaboration.disconnect_backend" &&
        commandAuthorityGeneration !== authorityGeneration
      ) {
        throw new CollaborationAuthorityChangedError(
          authorityChangeWasRevocation
            ? accessRevokedError()
            : {
                code: "conflict",
                userMessage: collaborationSafeErrorMessages.conflict,
                retryable: true,
                retryAfterMs: null
              }
        );
      }
      if (!result.ok) throw new CollaborationClientError(result.error);
      return result;
    } catch (cause) {
      if (cause instanceof CollaborationClientError) throw cause;
      throw new CollaborationClientError(temporarilyUnavailableError());
    }
  };

  const command = async <TName extends CollaborationRendererCommand["command"]>(
    name: TName,
    input: Extract<CollaborationRendererCommand, { command: TName }>["input"]
  ) =>
    run(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: crypto.randomUUID(),
        command: name,
        input
      })
    );

  const deliverPendingReceipt = async (threadId: string): Promise<void> => {
    const pending = pendingDeliveryReceipts.get(threadId);
    if (!pending || disposed) return;
    pending.timer = null;
    try {
      const result = await command("collaboration.mark_delivered", {
        thread: pending.thread,
        messageId: pending.messageId
      });
      if (
        !result.ok ||
        result.command !== "collaboration.mark_delivered" ||
        pendingDeliveryReceipts.get(threadId) !== pending
      ) {
        return;
      }
      pendingDeliveryReceipts.delete(threadId);
      await publish(
        applyAuthoritativeReadState(requireSnapshot(), result.data.readState),
        { kind: "command" }
      );
    } catch (error) {
      if (
        disposed ||
        pendingDeliveryReceipts.get(threadId) !== pending ||
        (error instanceof CollaborationClientError && !error.retryable)
      ) {
        pendingDeliveryReceipts.delete(threadId);
        return;
      }
      pending.attempt += 1;
      const retryAfterMs =
        error instanceof CollaborationClientError ? error.retryAfterMs : null;
      const delay = Math.min(
        Math.max(
          retryAfterMs ??
            DELIVERY_RECEIPT_RETRY_BASE_DELAY_MS *
              2 ** Math.min(pending.attempt - 1, 7),
          DELIVERY_RECEIPT_RETRY_BASE_DELAY_MS
        ),
        DELIVERY_RECEIPT_RETRY_MAX_DELAY_MS
      );
      pending.timer = setTimeout(() => {
        void deliverPendingReceipt(threadId);
      }, delay);
    }
  };

  const scheduleDeliveryReceipt = (message: CollaborationMessage) => {
    const current = pendingDeliveryReceipts.get(message.threadId);
    if (current && current.sequence >= message.sequence) return;
    if (current?.timer) clearTimeout(current.timer);
    pendingDeliveryReceipts.set(message.threadId, {
      attempt: 0,
      messageId: message.id,
      sequence: message.sequence,
      thread:
        message.scope === "personal"
          ? { scope: "personal", threadId: message.threadId }
          : {
              scope: "team",
              teamId: message.teamId!,
              threadId: message.threadId
            },
      timer: null
    });
    void deliverPendingReceipt(message.threadId);
  };

  const unsubscribeSubscriptionId = async (subscriptionId: string) => {
    const request = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: crypto.randomUUID(),
      command: "collaboration.unsubscribe",
      input: { subscriptionId }
    });
    try {
      const result = await bridge.command(request);
      if (
        result.requestId !== request.requestId ||
        result.command !== request.command ||
        !result.ok
      ) {
        throw new Error("Invalid collaboration unsubscribe result.");
      }
    } catch {
      // Cleanup is best effort; the local broker also closes streams on exit.
    }
  };

  const subscriptions = new CollaborationSubscriptionCoordinator(
    async (scope) => {
      const result = await command("collaboration.subscribe", { scope });
      return result.ok && result.command === "collaboration.subscribe"
        ? result.data.subscription
        : null;
    },
    unsubscribeSubscriptionId,
    (scope) => ({
      selection:
        scope.scope === "team" &&
        snapshot &&
        teamIdForSelection(snapshot.selection) === scope.teamId
          ? snapshot.selection
          : null,
      intentGeneration: selectionIntentGeneration
    })
  );

  const prewarmSharedSessionViews = async (
    navigation: CollaborationSnapshot["navigation"]
  ): Promise<void> => {
    const candidates = navigation.teams
      .flatMap((team) =>
        team.workspaces.flatMap((workspace) =>
          workspace.sharedMemory.map((session) => ({
            session,
            selection: {
              kind: "shared_session" as const,
              teamId: team.id,
              workspaceId: workspace.id,
              sharedSessionId: session.id
            }
          }))
        )
      )
      .filter(
        ({ session, selection }) =>
          session.sourceState === "ready" &&
          session.representationState === "current" &&
          !cachedSelectionView(selection)
      )
      .sort(
        (left, right) =>
          Date.parse(right.session.latestActivityAt) -
          Date.parse(left.session.latestActivityAt)
      )
      .slice(0, SHARED_SESSION_PREWARM_LIMIT);
    let index = 0;
    const worker = async () => {
      while (index < candidates.length) {
        const candidate = candidates[index++];
        if (!candidate) return;
        const existing = selectionViews.inFlight(candidate.selection);
        if (existing) {
          await existing;
          continue;
        }
        const pending = selectionViews.coordinate(candidate.selection, () =>
          command("collaboration.select", {
            selection: candidate.selection,
            navigationIntent: "prewarm"
          })
            .then((result) => {
              if (
                result.ok &&
                result.command === "collaboration.select" &&
                result.data.snapshot.selection.kind === "shared_session" &&
                result.data.snapshot.selection.sharedSessionId ===
                  candidate.session.id &&
                result.data.snapshot.view.kind === "shared_session" &&
                result.data.snapshot.view.session.sourceRevision ===
                  candidate.session.sourceRevision
              ) {
                rememberSelectionView(result.data.snapshot);
                return result.data.snapshot;
              }
              return null;
            })
            .catch(() => null)
        );
        await pending;
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            SHARED_SESSION_PREWARM_CONCURRENCY,
            candidates.length
          )
        },
        worker
      )
    );
  };

  const startSharedSourceBackfill = (next: CollaborationSnapshot): void => {
    if (
      next.selection.kind !== "shared_session" ||
      next.view.kind !== "shared_session" ||
      !next.view.source.hasOlder
    ) {
      return;
    }
    sourceBackfills.start(next.selection, next.view.source.snapshotRevision, {
      current: () => {
        const current = snapshot;
        if (
          !current ||
          current.selection.kind !== "shared_session" ||
          current.view.kind !== "shared_session"
        ) {
          return null;
        }
        return {
          selection: current.selection,
          source: current.view.source,
          maximumItems: current.limits.renderedRowMaxCount,
          pageLimit: current.limits.historyPageMaxItems
        };
      },
      loadOlder: async ({ selection, cursor, limit }) => {
        const result = await command("collaboration.load_shared_source_page", {
          sharedSession: {
            teamId: selection.teamId,
            workspaceId: selection.workspaceId,
            sharedSessionId: selection.sharedSessionId
          },
          direction: "older",
          cursor,
          limit
        });
        if (
          !result.ok ||
          result.command !== "collaboration.load_shared_source_page"
        ) {
          throw new Error("Unexpected collaboration result.");
        }
        return result.data.page;
      },
      apply: async (page) => {
        if (!snapshot) return;
        await publish(mergeSourcePage(snapshot, page, "older"), {
          kind: "command"
        });
      }
    });
  };

  const waitForActionGrant = async (
    intent: CollaborationActionGrantIntent
  ): Promise<CollaborationActionGrantReference> => {
    const grantAuthorityGeneration =
      actionGrantProjections.authorityGeneration();
    let result = await command("collaboration.request_action_grant", {
      intent
    });
    if (!result.ok || result.command !== "collaboration.request_action_grant") {
      throw new Error("Unexpected Action Grant result.");
    }
    let status = result.data.status;
    const operation = actionGrantOperation(intent.intent);
    if (status.state === "review_required") {
      publishActionGrant({
        expiresAt: status.expiresAt,
        id: status.actionGrant.id,
        operation,
        retryable: false,
        state: "awaiting_review"
      });
      const approved = await confirmNativeReview(status.review!);
      const decision = approved ? "approve" : "cancel";
      const decisionResult = await command(
        "collaboration.confirm_action_grant",
        {
          actionGrant: status.actionGrant,
          decision
        }
      );
      if (
        !decisionResult.ok ||
        decisionResult.command !== "collaboration.confirm_action_grant"
      ) {
        throw new Error("Unexpected Native review result.");
      }
      status = decisionResult.data.status;
      if (!approved) {
        publishActionGrant({
          expiresAt: status.expiresAt,
          id: status.actionGrant.id,
          operation,
          retryable: false,
          state: "canceled"
        });
        throw new CollaborationClientError({
          code: "permission_denied",
          userMessage: collaborationSafeErrorMessages.permission_denied,
          retryable: false,
          retryAfterMs: null
        });
      }
    }
    publishActionGrant({
      expiresAt: status.expiresAt,
      id: status.actionGrant.id,
      operation,
      retryable: false,
      state:
        status.state === "pending"
          ? "awaiting_approval"
          : status.state === "review_required"
            ? "awaiting_review"
            : status.state === "approved"
              ? "approved"
              : terminalProjectionState(status.state)
    });
    while (status.state === "pending") {
      if (
        !actionGrantProjections.authorityIsCurrent(grantAuthorityGeneration)
      ) {
        publishActionGrant({
          expiresAt: status.expiresAt,
          id: status.actionGrant.id,
          operation,
          retryable: false,
          state: "canceled"
        });
        throw new CollaborationClientError(accessRevokedError());
      }
      const remainingMs = Date.parse(status.expiresAt) - Date.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        publishActionGrant({
          expiresAt: status.expiresAt,
          id: status.actionGrant.id,
          operation,
          retryable: false,
          state: "expired"
        });
        throw new CollaborationClientError({
          code: "access_revoked",
          userMessage: collaborationSafeErrorMessages.access_revoked,
          retryable: false,
          retryAfterMs: null
        });
      }
      if (disposed) throw new CollaborationClientError(offlineError());
      if (
        !actionGrantProjections.authorityIsCurrent(grantAuthorityGeneration)
      ) {
        throw new CollaborationClientError(accessRevokedError());
      }
      try {
        result = await command("collaboration.await_action_grant", {
          actionGrant: status.actionGrant
        });
      } catch (caught) {
        if (
          !(caught instanceof CollaborationClientError) ||
          !caught.retryable
        ) {
          throw caught;
        }
        const retryRemainingMs = Date.parse(status.expiresAt) - Date.now();
        if (!Number.isFinite(retryRemainingMs) || retryRemainingMs <= 0) {
          throw caught;
        }
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              Math.max(caught.retryAfterMs ?? 1_500, 250),
              retryRemainingMs
            )
          )
        );
        continue;
      }
      if (!result.ok || result.command !== "collaboration.await_action_grant") {
        throw new Error("Unexpected Action Grant wait result.");
      }
      status = result.data.status;
      if (status.state === "pending") {
        throw new CollaborationClientError(temporarilyUnavailableError());
      }
      publishActionGrant({
        expiresAt: status.expiresAt,
        id: status.actionGrant.id,
        operation,
        retryable: false,
        state:
          status.state === "approved"
            ? "approved"
            : status.state === "review_required"
              ? "awaiting_review"
              : terminalProjectionState(status.state)
      });
    }
    if (status.state !== "approved") {
      throw new CollaborationClientError({
        code: "permission_denied",
        userMessage: collaborationSafeErrorMessages.permission_denied,
        retryable: false,
        retryAfterMs: null
      });
    }
    return status.actionGrant;
  };

  const runApprovedAction = async (
    command: CollaborationRendererCommand
  ): Promise<CollaborationCommandResult> => {
    const actionGrant = (
      command.input as { actionGrant?: CollaborationActionGrantReference }
    ).actionGrant;
    const existing = actionGrant
      ? actionGrantProjections.get(actionGrant.id)
      : undefined;
    if (existing) {
      publishActionGrant({
        ...existing,
        retryable: false,
        state: "executing"
      });
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await run(command);
        if (existing) {
          publishActionGrant({
            ...existing,
            retryable: false,
            state: "completed"
          });
        }
        return result;
      } catch (error) {
        if (
          !(error instanceof CollaborationClientError) ||
          !error.retryable ||
          attempt >= 3
        ) {
          if (existing) {
            publishActionGrant({
              ...existing,
              retryable:
                error instanceof CollaborationClientError && error.retryable,
              state: "failed"
            });
          }
          throw error;
        }
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(Math.max(error.retryAfterMs ?? 250, 0), 1_000)
          )
        );
      }
    }
  };

  const resetSubscriptions = () => subscriptions.reset();
  const recordSubscription = (
    subscription: CollaborationSubscription,
    preferredSelection?: CollaborationSelection | null,
    preferredSelectionIntentGeneration?: number
  ) =>
    subscriptions.record(
      subscription,
      preferredSelection,
      preferredSelectionIntentGeneration
    );

  const dropPendingDeliveries = (subscriptionId?: string) => {
    eventQueue.drop((event) => {
      if (event.type !== "snapshot" && event.type !== "update") return false;
      const eventSubscriptionId =
        event.type === "snapshot"
          ? event.subscription.id
          : event.subscriptionId;
      if (subscriptionId && eventSubscriptionId !== subscriptionId) {
        return false;
      }
      return true;
    });
  };

  const subscribeScope = (scope: CollaborationSubscription["scope"]) =>
    subscriptions.subscribe(scope);

  const syncTeamSubscription = async (selection: CollaborationSelection) => {
    const teamId = teamIdForSelection(selection);
    if (teamId) await subscribeScope({ scope: "team", teamId });
  };

  const acknowledge = async (
    event: Extract<CollaborationRendererEvent, { type: "snapshot" | "update" }>
  ) => {
    const subscriptionId =
      event.type === "snapshot" ? event.subscription.id : event.subscriptionId;
    const current = subscriptions.get(subscriptionId)?.subscription;
    const expectedSubscriptionVersion =
      event.type === "snapshot" ? event.subscription.version : current?.version;
    if (!expectedSubscriptionVersion) return;
    const result = await command("collaboration.acknowledge_delivery", {
      subscriptionId,
      deliveryId: event.deliveryId,
      eventId: event.eventId,
      expectedSubscriptionVersion
    });
    if (result.ok && result.command === "collaboration.acknowledge_delivery") {
      const record = subscriptions.get(subscriptionId);
      if (record) {
        subscriptions.updateVersion(
          subscriptionId,
          result.data.subscriptionVersion
        );
      }
    }
  };

  const applyRealtimeSnapshot = async (
    event: Extract<CollaborationRendererEvent, { type: "snapshot" }>
  ) => {
    recordSubscription(event.subscription);
    if (!snapshot) return;
    const realtime = event.snapshot;
    if (realtime.scope === "personal") {
      const personalSelected = teamIdForSelection(snapshot.selection) === null;
      await publish(
        {
          ...snapshot,
          snapshotRevision: realtime.snapshotRevision,
          navigation: {
            ...snapshot.navigation,
            personal: realtime.personal
          },
          ...(personalSelected
            ? { selection: realtime.selection, view: realtime.view }
            : {})
        },
        { kind: "realtime" }
      );
      return;
    }
    const teams = [
      ...snapshot.navigation.teams.filter(
        (team) => team.id !== realtime.teamId
      ),
      realtime.team
    ];
    const selected = teamIdForSelection(snapshot.selection) === realtime.teamId;
    await publish(
      {
        ...snapshot,
        snapshotRevision: realtime.snapshotRevision,
        navigation: { ...snapshot.navigation, teams },
        ...(selected
          ? { selection: realtime.selection, view: realtime.view }
          : {})
      },
      { kind: "realtime" }
    );
  };

  const applyTeamPersonUpdate = (
    current: CollaborationSnapshot,
    teamId: string,
    person: CollaborationTeamPerson
  ): CollaborationSnapshot => {
    const upsertPerson = (people: CollaborationTeamPerson[]) => {
      const existingIndex = people.findIndex(
        (candidate) => candidate.id === person.id
      );
      if (existingIndex === -1) return [...people, person];
      const existing = people[existingIndex]!;
      if (
        existing.teamPresence.preferenceVersion >
        person.teamPresence.preferenceVersion
      ) {
        return people;
      }
      return people.map((candidate, index) =>
        index === existingIndex
          ? {
              ...candidate,
              ...person,
              management: person.management ?? candidate.management
            }
          : candidate
      );
    };
    return {
      ...current,
      navigation: {
        ...current.navigation,
        teams: current.navigation.teams.map((team) =>
          team.id !== teamId
            ? team
            : { ...team, people: upsertPerson(team.people) }
        )
      },
      view:
        current.view.kind === "team_people" && current.view.teamId === teamId
          ? {
              ...current.view,
              people: upsertPerson(current.view.people)
            }
          : current.view
    };
  };

  const applyUpdate = async (
    event: Extract<CollaborationRendererEvent, { type: "update" }>
  ) => {
    if (!snapshot) return;
    const update = event.update;
    let next = snapshot;
    let refreshSelection: Extract<
      CollaborationSelection,
      { kind: "shared_session" }
    > | null = null;
    let announcement: string | undefined;
    switch (update.type) {
      case "personal_memory_upserted":
        next = applyPersonalMemoryEntry(next, update.entry);
        break;
      case "owned_share_status_changed":
        announcement = `${update.sourceTitle}: ${update.state.replaceAll("_", " ")}`;
        break;
      case "managed_conversation_upserted":
        break;
      case "navigation_snapshot":
        clearTeamSelectionViews();
        next = {
          ...next,
          navigation: update.navigation,
          selection: update.selection,
          view: update.view
        };
        break;
      case "thread_upserted":
        clearThreadSelectionViews(update.thread.id);
        next = applyThreadUpsert(next, update.thread);
        break;
      case "thread_removed":
        clearThreadSelectionViews(update.threadId);
        next = removeThread(next, update.threadId);
        break;
      case "message_created": {
        clearThreadSelectionViews(update.message.threadId);
        const currentPrincipalIds = new Set([
          next.navigation.personalOwner.id,
          ...(next.navigation.teamPrincipal
            ? [next.navigation.teamPrincipal.id]
            : [])
        ]);
        next = applyMessage(next, update.message);
        if (!currentPrincipalIds.has(update.message.sender.id)) {
          const body = update.message.body
            .replaceAll(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          announcement = `New message from ${update.message.sender.displayName}${body ? `: ${body}` : ""}`;
        }
        break;
      }
      case "receipt_state_updated":
        next = applyAuthoritativeReadState(next, update.readState);
        break;
      case "message_receipts_updated":
        next = applyMessageReceipts(next, update.threadId, update.receipts);
        break;
      case "team_person_upserted":
        next = applyTeamPersonUpdate(next, update.teamId, update.person);
        break;
      case "shared_session_upserted": {
        clearSharedSessionSelectionView(update.session.id);
        const recoverableSelection = recoverableSharedSessionSelection();
        const selectedSharedSession =
          next.view.kind === "shared_session" &&
          next.view.session.id === update.session.id
            ? next.view
            : null;
        const sourceMustBePurged =
          selectedSharedSession !== null &&
          (selectedSharedSession.session.representation !==
            update.session.representation ||
            selectedSharedSession.session.sourceRevision !==
              update.session.sourceRevision ||
            selectedSharedSession.source.items.length === 0 ||
            update.session.sourceState !== "ready" ||
            update.session.representationState === "pending" ||
            update.session.representationState === "unavailable");
        if (sourceMustBePurged) {
          if (next.selection.kind === "shared_session") {
            refreshSelection = next.selection;
          }
        }
        if (
          recoverableSelection?.sharedSessionId === update.session.id &&
          update.session.sourceState === "ready" &&
          update.session.representationState === "current"
        ) {
          refreshSelection = recoverableSelection;
        }
        next = {
          ...next,
          navigation: {
            ...next.navigation,
            teams: next.navigation.teams.map((team) =>
              team.id !== update.session.teamId
                ? team
                : {
                    ...team,
                    workspaces: team.workspaces.map((workspace) =>
                      workspace.id !== update.session.workspaceId
                        ? workspace
                        : {
                            ...workspace,
                            sharedMemory: [
                              ...workspace.sharedMemory.filter(
                                (session) => session.id !== update.session.id
                              ),
                              update.session
                            ]
                          }
                    )
                  }
            )
          },
          view:
            selectedSharedSession !== null
              ? {
                  ...selectedSharedSession,
                  session: update.session,
                  ...(sourceMustBePurged
                    ? {
                        source: {
                          snapshotRevision:
                            update.session.sourceRevision ??
                            next.snapshotRevision,
                          olderCursor: null,
                          newerCursor: null,
                          hasOlder: false,
                          hasNewer: false,
                          sharedSessionId: update.session.id,
                          representation: update.session.representation,
                          items: []
                        }
                      }
                    : {})
                }
              : next.view.kind === "shared_memory_index" &&
                  next.view.teamId === update.session.teamId &&
                  next.view.workspaceId === update.session.workspaceId
                ? {
                    ...next.view,
                    sessions: [
                      ...next.view.sessions.filter(
                        (session) => session.id !== update.session.id
                      ),
                      update.session
                    ]
                  }
                : next.view
        };
        break;
      }
      case "shared_session_removed": {
        clearSharedSessionSelectionView(update.sharedSessionId);
        const selected =
          next.selection.kind === "shared_session" &&
          next.selection.sharedSessionId === update.sharedSessionId;
        const transientRepresentationRemoval =
          selected &&
          (event.family === "representation_changed" ||
            event.family === "memory_event_available" ||
            event.family === "lcm_leaf_available" ||
            event.family === "lcm_rollup_available");
        if (
          transientRepresentationRemoval &&
          next.selection.kind === "shared_session"
        ) {
          rememberSharedSessionSelection(next.selection);
        } else if (
          recoverableSharedSessionSelection()?.sharedSessionId ===
          update.sharedSessionId
        ) {
          pendingSharedSessionRecovery = null;
        }
        const fallback =
          selected && next.selection.kind === "shared_session"
            ? teamPeopleFallback(next, next.selection.teamId)
            : null;
        next = {
          ...next,
          navigation: {
            ...next.navigation,
            teams: next.navigation.teams.map((team) => ({
              ...team,
              workspaces: team.workspaces.map((workspace) => ({
                ...workspace,
                sharedMemory: workspace.sharedMemory.filter(
                  (session) => session.id !== update.sharedSessionId
                )
              }))
            }))
          },
          view:
            next.view.kind === "shared_memory_index"
              ? {
                  ...next.view,
                  sessions: next.view.sessions.filter(
                    (session) => session.id !== update.sharedSessionId
                  )
                }
              : next.view,
          ...(transientRepresentationRemoval &&
          next.view.kind === "shared_session"
            ? {
                view: {
                  ...next.view,
                  session: {
                    ...next.view.session,
                    representationState: "unavailable" as const,
                    sourceState: "unavailable" as const
                  },
                  source: {
                    ...next.view.source,
                    olderCursor: null,
                    newerCursor: null,
                    hasOlder: false,
                    hasNewer: false,
                    items: []
                  }
                }
              }
            : (fallback ?? {}))
        };
        break;
      }
    }
    await publish(next, {
      kind: "realtime",
      announcement,
      announcementId: announcement ? event.eventId : undefined,
      realtimeUpdate: update
    });
    if (update.type === "message_created") {
      const currentPrincipalIds = new Set([
        next.navigation.personalOwner.id,
        ...(next.navigation.teamPrincipal
          ? [next.navigation.teamPrincipal.id]
          : [])
      ]);
      if (!currentPrincipalIds.has(update.message.sender.id)) {
        scheduleDeliveryReceipt(update.message);
      }
    }
    if (
      update.type === "navigation_snapshot" ||
      update.type === "shared_session_upserted"
    ) {
      void prewarmSharedSessionViews(next.navigation);
    }
    if (refreshSelection) {
      try {
        await select(refreshSelection, true);
        if (refreshSelection.kind === "shared_session") {
          pendingSharedSessionRecovery = null;
        }
      } catch {
        if (refreshSelection.kind === "shared_session") {
          rememberSharedSessionSelection(refreshSelection);
        }
        const current = snapshot;
        if (
          current?.view.kind === "shared_session" &&
          current.selection.kind === "shared_session" &&
          current.selection.sharedSessionId === refreshSelection.sharedSessionId
        ) {
          const unavailableSession = {
            ...current.view.session,
            representationState: "unavailable" as const,
            sourceState: "unavailable" as const
          };
          await publish(
            {
              ...current,
              navigation: {
                ...current.navigation,
                teams: current.navigation.teams.map((team) => ({
                  ...team,
                  workspaces: team.workspaces.map((workspace) => ({
                    ...workspace,
                    sharedMemory: workspace.sharedMemory.map((session) =>
                      session.id === unavailableSession.id
                        ? unavailableSession
                        : session
                    )
                  }))
                }))
              },
              view: { ...current.view, session: unavailableSession }
            },
            { kind: "realtime" }
          );
        }
      }
    }
  };

  const applyEvent = async (event: CollaborationRendererEvent) => {
    if (event.type === "connection") {
      if (!snapshot) return;
      const becameLive =
        event.connection.state === "live" &&
        (snapshot.connection.state !== "live" ||
          snapshot.connection.backendId !== event.connection.backendId);
      const backendChanged =
        snapshot.connection.backendId !== null &&
        event.connection.backendId !== snapshot.connection.backendId;
      const recoveredSelectedTeamStream =
        becameLive &&
        (snapshot.connection.state === "reconnecting" ||
          snapshot.connection.state === "unavailable") &&
        teamIdForSelection(snapshot.selection) !== null;
      const requiresLiveRecovery =
        becameLive &&
        !backendChanged &&
        (snapshot.navigation.teams.length === 0 || recoveredSelectedTeamStream);
      if (
        backendChanged ||
        event.connection.state === "disconnected" ||
        event.connection.state === "access_revoked"
      ) {
        pendingSharedSessionRecovery = null;
        dropPendingDeliveries();
        await resetSubscriptions();
        await purgeAllTeams(event.connection, event.error?.userMessage);
      } else {
        await publish(
          { ...snapshot, connection: event.connection },
          { kind: "connection", announcement: event.error?.userMessage }
        );
      }
      if (requiresLiveRecovery) await reloadAuthoritativeSnapshot?.();
      return;
    }
    if (event.type === "control") {
      const current = snapshot;
      if (!current) return;
      const record = subscriptions.get(event.subscriptionId)?.subscription;
      const subscriptionRecord = subscriptions.get(event.subscriptionId);
      const currentPreferredSelection =
        record?.scope.scope === "team" &&
        teamIdForSelection(current.selection) === record.scope.teamId
          ? current.selection
          : undefined;
      const subscribedPreferredSelection =
        subscriptionRecord?.subscription.scope.scope === "team" &&
        subscriptionRecord.selectionIntentGeneration ===
          selectionIntentGeneration
          ? (subscriptionRecord.preferredSelection ?? undefined)
          : undefined;
      if (currentPreferredSelection?.kind === "shared_session") {
        rememberSharedSessionSelection(currentPreferredSelection);
      }
      const retainedSelection = recoverableSharedSessionSelection();
      const preferredSelection =
        retainedSelection &&
        (!record ||
          (record.scope.scope === "team" &&
            record.scope.teamId === retainedSelection.teamId))
          ? retainedSelection
          : (currentPreferredSelection ?? subscribedPreferredSelection);
      dropPendingDeliveries(event.subscriptionId);
      subscriptions.drop(event.subscriptionId);
      if (record?.scope.scope === "team") {
        await purgeTeam(
          record.scope.teamId,
          event.reason === "access_revoked"
            ? collaborationSafeErrorMessages.access_revoked
            : collaborationSafeErrorMessages.temporarily_unavailable,
          event.reason === "access_revoked"
        );
      } else if (event.reason === "access_revoked") {
        dropPendingDeliveries();
        await resetSubscriptions();
        await purgeAllTeams(
          {
            ...current.connection,
            state: "access_revoked",
            connectedAt: null,
            retryAt: null
          },
          collaborationSafeErrorMessages.access_revoked
        );
      }
      if (
        event.reason === "requires_snapshot" ||
        event.reason === "backpressure"
      ) {
        await reloadAuthoritativeSnapshot?.(preferredSelection);
      } else if (
        retainedSelection &&
        (!record ||
          (record.scope.scope === "team" &&
            record.scope.teamId === retainedSelection.teamId))
      ) {
        pendingSharedSessionRecovery = null;
      }
      return;
    }
    if (event.type === "durable_send") {
      if (
        !snapshot ||
        !threadAuthorityIsCurrent(snapshot, event.send) ||
        !remember(seenEventIds, seenEventOrder, event.eventId)
      ) {
        return;
      }
      const next =
        event.send.state === "sent" && event.message
          ? applyMessage(snapshot, event.message)
          : upsertDurableSend(snapshot, event.send);
      await publish(next, { kind: "realtime" });
      return;
    }
    if (event.type === "update" && !subscriptions.has(event.subscriptionId)) {
      if (event.family === "access_revoked" && snapshot) {
        await purgeAllTeams(
          {
            ...snapshot.connection,
            state: "access_revoked",
            connectedAt: null,
            retryAt: null
          },
          collaborationSafeErrorMessages.access_revoked
        );
      }
      return;
    }

    const duplicateDelivery = !remember(
      seenDeliveries,
      seenDeliveryOrder,
      event.deliveryId
    );
    const duplicateEvent =
      event.eventId !== null &&
      !remember(seenEventIds, seenEventOrder, event.eventId);
    if (!duplicateDelivery && !duplicateEvent) {
      if (event.type === "snapshot") await applyRealtimeSnapshot(event);
      else await applyUpdate(event);
    }
    await acknowledge(event);
  };

  const eventChangesAuthority = (event: CollaborationRendererEvent): boolean =>
    (event.type === "connection" &&
      (event.connection.state === "disconnected" ||
        event.connection.state === "access_revoked")) ||
    event.type === "control" ||
    (event.type === "update" &&
      ([
        "team_lifecycle",
        "team_membership_access",
        "workspace_lifecycle_access",
        "share_grant_lifecycle",
        "access_revoked"
      ].includes(event.family) ||
        (event.family === "thread_lifecycle" &&
          (event.update.type === "thread_removed" ||
            (event.update.type === "thread_upserted" &&
              (!event.update.thread.canPost ||
                event.update.thread.lifecycle !== "active"))))));

  const eventRevokesAuthority = (event: CollaborationRendererEvent): boolean =>
    (event.type === "connection" &&
      (event.connection.state === "disconnected" ||
        event.connection.state === "access_revoked")) ||
    (event.type === "control" && event.reason === "access_revoked") ||
    (event.type === "update" && event.family === "access_revoked");

  const advanceAuthority = (event: CollaborationRendererEvent): void => {
    authorityGeneration += 1;
    authorityChangeWasRevocation = eventRevokesAuthority(event);
    if (authorityChangeWasRevocation) {
      actionGrantProjections.revokeAuthority();
    }
    selectionRequestGeneration += 1;
  };

  const eventQueue = new RendererEventQueue<CollaborationRendererEvent>(
    () => ({
      maxCount: limits().rendererMaxPendingEvents,
      maxBytes: limits().rendererMaxPendingBytes
    }),
    async (event, retryAttempt) => {
      try {
        await applyEvent(event);
      } catch (cause) {
        if (cause instanceof CollaborationAuthorityChangedError) {
          // A newer queued authority/control event owns cleanup and recovery.
        } else if (
          cause instanceof CollaborationClientError &&
          cause.code === "access_revoked" &&
          snapshot
        ) {
          const subscriptionId =
            event.type === "snapshot"
              ? event.subscription.id
              : event.type === "update"
                ? event.subscriptionId
                : null;
          const record = subscriptionId
            ? subscriptions.get(subscriptionId)?.subscription
            : null;
          if (record?.scope.scope === "team") {
            await purgeTeam(record.scope.teamId, cause.userMessage);
          } else if (!record) {
            await purgeAllTeams(
              { ...snapshot.connection, state: "access_revoked" },
              cause.userMessage
            );
          }
        } else if (
          cause instanceof CollaborationClientError &&
          cause.retryable &&
          (event.type === "snapshot" || event.type === "update")
        ) {
          return Math.min(
            Math.max(cause.retryAfterMs ?? 250 * 2 ** retryAttempt, 250),
            1_000
          );
        }
      }
      return null;
    },
    () => {
      authorityGeneration += 1;
      authorityChangeWasRevocation = false;
      selectionRequestGeneration += 1;
      if (snapshot) {
        void purgeAllTeams(
          unavailableConnection(snapshot.connection),
          collaborationSafeErrorMessages.temporarily_unavailable
        ).finally(() => {
          authorityGeneration += 1;
          authorityChangeWasRevocation = false;
          selectionRequestGeneration += 1;
        });
      }
    },
    (event) => {
      if (eventChangesAuthority(event)) advanceAuthority(event);
    }
  );

  const enqueue = (raw: CollaborationRendererEvent) => {
    if (disposed) return;
    const event = collaborationRendererEventSchema.parse(raw);
    const authorityBoundary = eventChangesAuthority(event);
    if (authorityBoundary) advanceAuthority(event);
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    const scopedAccessRevocation =
      event.type === "update" && event.family === "access_revoked";
    const terminalConnection =
      event.type === "connection" &&
      (event.connection.state === "disconnected" ||
        event.connection.state === "access_revoked");
    const preemptsRetry =
      event.type === "control" || terminalConnection || scopedAccessRevocation;
    if (terminalConnection) {
      dropPendingDeliveries();
    } else if (scopedAccessRevocation) {
      dropPendingDeliveries(event.subscriptionId);
    }
    eventQueue.enqueue(event, bytes, {
      prepend: preemptsRetry,
      preemptRetry: preemptsRetry
    });
  };

  const removeBridgeListener = bridge.subscribe(enqueue);

  const requireSnapshot = () => {
    if (!snapshot) throw new CollaborationClientError(offlineError());
    return snapshot;
  };

  const applyCommandSnapshot = async (
    next: CollaborationSnapshot,
    isCurrent: () => boolean = () => true
  ) => {
    if (!isCurrent()) return requireSnapshot();
    const backendChanged =
      snapshot?.connection.backendId !== null &&
      snapshot?.connection.backendId !== undefined &&
      next.connection.backendId !== snapshot.connection.backendId;
    const previousTeamPrincipalId = snapshot?.navigation.teamPrincipal?.id;
    const teamPrincipalChanged =
      previousTeamPrincipalId !== undefined &&
      next.navigation.teamPrincipal?.id !== previousTeamPrincipalId;
    if ((backendChanged || teamPrincipalChanged) && snapshot) {
      actionGrantProjections.revokeAuthority();
      pendingSharedSessionRecovery = null;
      dropPendingDeliveries();
      await resetSubscriptions();
      if (!isCurrent()) return requireSnapshot();
      await purgeAllTeams(next.connection, undefined, false);
      if (!isCurrent()) return requireSnapshot();
    }
    if (!isCurrent()) return requireSnapshot();
    await publishValidated(next, { kind: "command" });
    if (!isCurrent()) return requireSnapshot();
    await syncTeamSubscription(next.selection);
    if (!isCurrent()) return requireSnapshot();
    void prewarmSharedSessionViews(next.navigation);
    startSharedSourceBackfill(next);
    return requireSnapshot();
  };

  reloadAuthoritativeSnapshot = async (preferredSelection) => {
    const recoverySelectionRequestGeneration = ++selectionRequestGeneration;
    const recoverySelectionIntentGeneration = selectionIntentGeneration;
    const recoveryIsCurrent = () =>
      recoverySelectionRequestGeneration === selectionRequestGeneration &&
      recoverySelectionIntentGeneration === selectionIntentGeneration;
    const selectedSharedSession =
      snapshot?.selection.kind === "shared_session" ? snapshot.selection : null;
    if (selectedSharedSession) {
      rememberSharedSessionSelection(selectedSharedSession);
    }
    const recoverySelection =
      recoverableSharedSessionSelection() ?? preferredSelection;
    dropPendingDeliveries();
    await resetSubscriptions();
    let loaded: CollaborationSnapshot | null = null;
    for (
      let attempt = 1;
      attempt <= AUTHORITATIVE_SNAPSHOT_RECOVERY_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const result = await command("collaboration.load", {
          forceRemoteNavigation: true
        });
        if (!result.ok || result.command !== "collaboration.load") {
          throw new Error("Unexpected collaboration result.");
        }
        loaded = result.data.snapshot;
        break;
      } catch (error) {
        if (
          !(error instanceof CollaborationClientError) ||
          !error.retryable ||
          attempt === AUTHORITATIVE_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
        ) {
          throw error;
        }
        const delay = Math.min(
          Math.max(
            error.retryAfterMs ??
              AUTHORITATIVE_SNAPSHOT_RECOVERY_BASE_DELAY_MS *
                2 ** (attempt - 1),
            AUTHORITATIVE_SNAPSHOT_RECOVERY_BASE_DELAY_MS
          ),
          1_000
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    if (!loaded) throw new Error("Authoritative snapshot recovery failed.");
    if (!recoveryIsCurrent()) {
      await subscribeScope({ scope: "personal" });
      return;
    }
    let resolved = loaded;
    const preferredTeamId = recoverySelection
      ? teamIdForSelection(recoverySelection)
      : null;
    if (
      recoverySelection &&
      preferredTeamId &&
      loaded.navigation.teams.some((team) => team.id === preferredTeamId)
    ) {
      try {
        const selected = await command("collaboration.select", {
          selection: recoverySelection
        });
        if (!selected.ok || selected.command !== "collaboration.select") {
          throw new Error("Unexpected collaboration result.");
        }
        if (!recoveryIsCurrent()) {
          await subscribeScope({ scope: "personal" });
          return;
        }
        resolved = selected.data.snapshot;
        if (recoverySelection.kind === "shared_session") {
          pendingSharedSessionRecovery = null;
        }
      } catch {
        if (!recoveryIsCurrent()) {
          await subscribeScope({ scope: "personal" });
          return;
        }
        if (recoverySelection.kind === "shared_session") {
          rememberSharedSessionSelection(recoverySelection);
        }
        const fallbackSelection = {
          kind: "team_people" as const,
          teamId: preferredTeamId
        };
        const fallback = await command("collaboration.select", {
          selection: fallbackSelection
        });
        if (!fallback.ok || fallback.command !== "collaboration.select") {
          throw new Error("Unexpected collaboration result.");
        }
        if (!recoveryIsCurrent()) {
          await subscribeScope({ scope: "personal" });
          return;
        }
        resolved = fallback.data.snapshot;
      }
    }
    await applyCommandSnapshot(resolved, recoveryIsCurrent);
    if (!recoveryIsCurrent()) return;
    await subscribeScope({ scope: "personal" });
    if (snapshot) {
      await publish(snapshot, {
        kind: "command",
        announcement: "",
        authoritativeRecovery: true
      });
    }
  };

  const select = async (
    selection: CollaborationSelection,
    preserveSharedSessionRecovery = false
  ) => {
    if (!preserveSharedSessionRecovery) {
      pendingSharedSessionRecovery = null;
      selectionIntentGeneration += 1;
    }
    const generation = ++selectionRequestGeneration;
    const previous = snapshot;
    const warming = selectionViews.inFlight(selection);
    if (warming) {
      const warmed = await warming;
      if (generation !== selectionRequestGeneration) return requireSnapshot();
      if (
        warmed &&
        selectionIdentity(warmed.selection) === selectionIdentity(selection)
      ) {
        return applyCommandSnapshot(
          warmed,
          () => generation === selectionRequestGeneration
        );
      }
    }
    const shell = snapshot ? optimisticSelection(snapshot, selection) : null;
    const cachedView = snapshot ? cachedSelectionView(selection) : null;
    const optimistic = cachedView ? { selection, view: cachedView } : shell;
    const selectionCommand = command("collaboration.select", { selection });
    if (snapshot && optimistic) {
      await publishTrusted(
        { ...snapshot, ...optimistic },
        { kind: "command" },
        { rememberView: false }
      );
    }
    try {
      const result = await selectionCommand;
      if (!result.ok || result.command !== "collaboration.select") {
        throw new Error("Unexpected collaboration result.");
      }
      if (generation !== selectionRequestGeneration) return requireSnapshot();
      return applyCommandSnapshot(
        result.data.snapshot,
        () => generation === selectionRequestGeneration
      );
    } catch (cause) {
      if (
        generation === selectionRequestGeneration &&
        cause instanceof CollaborationClientError &&
        cause.code === "access_revoked" &&
        teamIdForSelection(selection)
      ) {
        await purgeTeam(teamIdForSelection(selection)!);
      } else if (
        generation === selectionRequestGeneration &&
        previous &&
        snapshot &&
        selectionIdentity(snapshot.selection) === selectionIdentity(selection)
      ) {
        await publishValidated(previous, { kind: "command" });
      }
      throw cause;
    }
  };

  hydratePersonalFallback = async (scope) => {
    try {
      selectionIntentGeneration += 1;
      const fallbackConnection = snapshot?.connection;
      const generation = ++selectionRequestGeneration;
      const result = await command("collaboration.select", {
        selection: { kind: "notes_to_self" }
      });
      if (!result.ok || result.command !== "collaboration.select") {
        throw new Error("Unexpected collaboration result.");
      }
      const hydrated = result.data.snapshot;
      if (
        generation !== selectionRequestGeneration ||
        hydrated.selection.kind !== "notes_to_self" ||
        hydrated.view.kind !== "thread" ||
        hydrated.view.thread.scope !== "personal"
      ) {
        return;
      }
      await applyCommandSnapshot({
        ...hydrated,
        connection:
          snapshot?.connection ?? fallbackConnection ?? hydrated.connection,
        navigation: {
          ...hydrated.navigation,
          teams:
            scope.kind === "all"
              ? []
              : hydrated.navigation.teams.filter(
                  (team) => team.id !== scope.teamId
                )
        }
      });
    } catch {
      // The already-published empty Personal view is the fail-closed fallback.
    }
  };

  const selectCreatedThread = async (thread: CollaborationThread) => {
    if (snapshot)
      await publish(applyThreadUpsert(snapshot, thread), { kind: "command" });
    return select(selectionForThread(thread));
  };

  const loadSnapshot = async (
    forceRemoteNavigation = false
  ): Promise<CollaborationSnapshot> => {
    pendingSharedSessionRecovery = null;
    const result = await command("collaboration.load", {
      forceRemoteNavigation
    });
    if (!result.ok || result.command !== "collaboration.load") {
      throw new Error("Unexpected collaboration result.");
    }
    await applyCommandSnapshot(result.data.snapshot);
    await subscribeScope({ scope: "personal" });
    return requireSnapshot();
  };

  return {
    load: loadSnapshot,
    current: () => snapshot,
    currentRemoteUrl: () => connectedRemoteUrl,
    currentSelection: () =>
      snapshot?.selection ?? ({ kind: "personal_memory" } as const),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentActionGrants: () => actionGrantProjections.current(),
    subscribeActionGrants(listener) {
      return actionGrantProjections.subscribe(listener);
    },
    async cancelActionGrant(id) {
      const existing = actionGrantProjections.get(id);
      if (!existing || existing.state !== "awaiting_approval") return;
      const result = await command("collaboration.cancel_action_grant", {
        actionGrant: { id }
      });
      if (
        !result.ok ||
        result.command !== "collaboration.cancel_action_grant"
      ) {
        throw new Error("Unexpected Action Grant cancellation result.");
      }
      publishActionGrant({
        ...existing,
        retryable: false,
        state: "canceled"
      });
    },
    async authorizeManagedConversationTransfer(input) {
      return waitForActionGrant(
        input.operation === "handoff"
          ? {
              intent: "collaboration.managed_conversation_handoff",
              commandRequestId: input.operationId,
              executionId: input.executionId,
              operationId: input.operationId,
              targetDeviceId: input.targetDeviceId
            }
          : {
              intent: "collaboration.managed_conversation_fork",
              commandRequestId: input.operationId,
              executionId: input.executionId,
              operationId: input.operationId,
              targetDeviceId: input.targetDeviceId,
              reason: input.reason
            }
      );
    },
    select,
    async connectRemote({ remoteUrl }) {
      pendingSharedSessionRecovery = null;
      const result = await command("collaboration.connect_backend", {
        remoteUrl
      });
      if (!result.ok || result.command !== "collaboration.connect_backend") {
        throw new Error("Unexpected collaboration result.");
      }
      await resetSubscriptions();
      connectedRemoteUrl = result.data.backend.baseUrl;
      const next = await applyCommandSnapshot(result.data.snapshot);
      await subscribeScope({ scope: "personal" });
      return next;
    },
    async reconnect() {
      pendingSharedSessionRecovery = null;
      const result = await command("collaboration.reconnect_backend", {});
      if (!result.ok || result.command !== "collaboration.reconnect_backend") {
        throw new Error("Unexpected collaboration result.");
      }
      const next = await applyCommandSnapshot(result.data.snapshot);
      await subscribeScope({ scope: "personal" });
      return next;
    },
    async disconnect() {
      pendingSharedSessionRecovery = null;
      const result = await command("collaboration.disconnect_backend", {});
      if (!result.ok || result.command !== "collaboration.disconnect_backend") {
        throw new Error("Unexpected collaboration result.");
      }
      authorityGeneration += 1;
      actionGrantProjections.revokeAuthority();
      authorityChangeWasRevocation = true;
      selectionRequestGeneration += 1;
      dropPendingDeliveries();
      await resetSubscriptions();
      connectedRemoteUrl = null;
      return applyCommandSnapshot({
        ...result.data.snapshot,
        navigation: { ...result.data.snapshot.navigation, teams: [] },
        ...(teamIdForSelection(result.data.snapshot.selection)
          ? personalFallback(result.data.snapshot)
          : {})
      });
    },
    async createTeam({ name }) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.create_team",
        commandRequestId,
        name
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.create_team",
          input: { name, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.create_team") {
        throw new Error("Unexpected collaboration result.");
      }
      return applyCommandSnapshot(result.data.snapshot);
    },
    async joinTeam({ invitation }) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.join_team",
        commandRequestId,
        invitation
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.join_team",
          input: { invitation, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.join_team") {
        throw new Error("Unexpected collaboration result.");
      }
      return applyCommandSnapshot(result.data.snapshot);
    },
    async createWorkspace(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.create_workspace",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.create_workspace",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.create_workspace") {
        throw new Error("Unexpected collaboration result.");
      }
      return applyCommandSnapshot(result.data.snapshot);
    },
    async createInvitation(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.create_invitation",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.create_invitation",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.create_invitation") {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data;
    },
    async listInvitations({ teamId, cursor = null }) {
      const result = await command("collaboration.list_invitations", {
        teamId,
        includeRevoked: false,
        cursor,
        limit: requireSnapshot().limits.historyPageMaxItems
      });
      if (!result.ok || result.command !== "collaboration.list_invitations") {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.page;
    },
    async revokeInvitation(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.revoke_invitation",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.revoke_invitation",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.revoke_invitation") {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.invitation;
    },
    async updateMemberRole(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.update_member_role",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.update_member_role",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.update_member_role") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyMembership(requireSnapshot(), result.data.membership),
        {
          kind: "command"
        }
      );
      return result.data.membership;
    },
    async disableMember(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.disable_member",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.disable_member",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.disable_member") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyMembership(requireSnapshot(), result.data.membership),
        {
          kind: "command"
        }
      );
      return result.data.membership;
    },
    async leaveTeam(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.leave_team",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.leave_team",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.leave_team") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyMembership(requireSnapshot(), result.data.membership),
        {
          kind: "command"
        }
      );
      return result.data.membership;
    },
    async archiveWorkspace(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.archive_workspace",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.archive_workspace",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.archive_workspace") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(applyWorkspace(requireSnapshot(), result.data.workspace), {
        kind: "command"
      });
      return result.data.workspace;
    },
    async restoreWorkspace(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.restore_workspace",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.restore_workspace",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.restore_workspace") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(applyWorkspace(requireSnapshot(), result.data.workspace), {
        kind: "command"
      });
      return result.data.workspace;
    },
    async setWorkspaceAccess(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.set_workspace_access",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.set_workspace_access",
          input: { ...input, actionGrant }
        })
      );
      if (
        !result.ok ||
        result.command !== "collaboration.set_workspace_access"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyWorkspaceAccess(
          requireSnapshot(),
          input.teamId,
          result.data.access
        ),
        { kind: "command" }
      );
      return result.data.access;
    },
    async setTeamPresence(input) {
      try {
        const result = await command("collaboration.set_team_presence", input);
        if (
          !result.ok ||
          result.command !== "collaboration.set_team_presence"
        ) {
          throw new Error("Unexpected collaboration result.");
        }
        if (snapshot) {
          await publish(
            applyTeamPersonUpdate(snapshot, input.teamId, result.data.person),
            { kind: "command" }
          );
        }
        return result.data.person;
      } catch (error) {
        if (
          error instanceof CollaborationClientError &&
          error.code === "conflict"
        ) {
          try {
            const currentSelection = snapshot?.selection;
            if (currentSelection && reloadAuthoritativeSnapshot) {
              await reloadAuthoritativeSnapshot(currentSelection);
            } else {
              await loadSnapshot(true);
            }
          } catch {
            // Preserve the original optimistic-write conflict for the caller.
          }
        }
        throw error;
      }
    },
    async reportTeamActivity(teamIds) {
      const result = await command("collaboration.report_team_activity", {
        teamIds
      });
      if (
        !result.ok ||
        result.command !== "collaboration.report_team_activity"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.acceptedTeamIds;
    },
    async createPersonalChannel(input) {
      const result = await command(
        "collaboration.create_personal_channel",
        input
      );
      if (
        !result.ok ||
        result.command !== "collaboration.create_personal_channel"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return selectCreatedThread(result.data.thread);
    },
    async renameThread({ thread, name }) {
      const result = await command("collaboration.rename_thread", {
        thread: threadReference(thread),
        name,
        expectedVersion: thread.version
      });
      if (!result.ok || result.command !== "collaboration.rename_thread") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(applyThreadUpsert(requireSnapshot(), result.data.thread), {
        kind: "command"
      });
      return requireSnapshot();
    },
    async updateThreadTopic({ thread, topic }) {
      const result = await command("collaboration.update_thread_topic", {
        thread: threadReference(thread),
        topic,
        expectedVersion: thread.version
      });
      if (
        !result.ok ||
        result.command !== "collaboration.update_thread_topic"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(applyThreadUpsert(requireSnapshot(), result.data.thread), {
        kind: "command"
      });
      return requireSnapshot();
    },
    async archiveThread({ thread }) {
      const result = await command("collaboration.archive_thread", {
        thread: threadReference(thread),
        expectedVersion: thread.version
      });
      if (!result.ok || result.command !== "collaboration.archive_thread") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(applyThreadUpsert(requireSnapshot(), result.data.thread), {
        kind: "command"
      });
      return requireSnapshot();
    },
    async restoreThread({ thread }) {
      const result = await command("collaboration.restore_thread", {
        thread: threadReference(thread),
        expectedVersion: thread.version
      });
      if (!result.ok || result.command !== "collaboration.restore_thread") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(applyThreadUpsert(requireSnapshot(), result.data.thread), {
        kind: "command"
      });
      return requireSnapshot();
    },
    async createWorkspaceChannel(input) {
      const result = await command(
        "collaboration.create_workspace_channel",
        input
      );
      if (
        !result.ok ||
        result.command !== "collaboration.create_workspace_channel"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return selectCreatedThread(result.data.thread);
    },
    async startDirectMessage(input) {
      const result = await command("collaboration.start_direct_message", input);
      if (
        !result.ok ||
        result.command !== "collaboration.start_direct_message"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return selectCreatedThread(result.data.thread);
    },
    async startGroupDirectMessage(input) {
      const result = await command(
        "collaboration.start_group_direct_message",
        input
      );
      if (
        !result.ok ||
        result.command !== "collaboration.start_group_direct_message"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return selectCreatedThread(result.data.thread);
    },
    async sendMessage(input) {
      const result = await command("collaboration.send_message", input);
      if (!result.ok || result.command !== "collaboration.send_message") {
        throw new Error("Unexpected collaboration result.");
      }
      if ("durableSend" in result.data) {
        await publish(
          upsertDurableSend(requireSnapshot(), result.data.durableSend),
          { kind: "command" }
        );
      } else {
        await publish(applyMessage(requireSnapshot(), result.data.message), {
          kind: "command"
        });
        const deliveryError = messageDeliveryError(result.data.message);
        if (deliveryError) throw deliveryError;
      }
      return requireSnapshot();
    },
    async retryMessage(input) {
      const result = await command("collaboration.retry_message", input);
      if (!result.ok || result.command !== "collaboration.retry_message") {
        throw new Error("Unexpected collaboration result.");
      }
      if ("durableSend" in result.data) {
        await publish(
          upsertDurableSend(requireSnapshot(), result.data.durableSend),
          { kind: "command" }
        );
      } else {
        await publish(applyMessage(requireSnapshot(), result.data.message), {
          kind: "command"
        });
        const deliveryError = messageDeliveryError(result.data.message);
        if (deliveryError) throw deliveryError;
      }
      return requireSnapshot();
    },
    async markRead(input) {
      const result = await command("collaboration.mark_read", input);
      if (!result.ok || result.command !== "collaboration.mark_read") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyAuthoritativeReadState(requireSnapshot(), result.data.readState),
        { kind: "command" }
      );
      return requireSnapshot();
    },
    async markDelivered(input) {
      const result = await command("collaboration.mark_delivered", input);
      if (!result.ok || result.command !== "collaboration.mark_delivered") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyAuthoritativeReadState(requireSnapshot(), result.data.readState),
        { kind: "command" }
      );
      return requireSnapshot();
    },
    async loadMessagePage(input) {
      const current = requireSnapshot();
      const result = await command("collaboration.load_message_page", {
        ...input,
        limit: current.limits.historyPageMaxItems
      });
      if (!result.ok || result.command !== "collaboration.load_message_page") {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyMessagePage(current, result.data.page, input.direction),
        { kind: "command" }
      );
      return requireSnapshot();
    },
    async loadSharedSourcePage(input) {
      const current = requireSnapshot();
      const result = await command("collaboration.load_shared_source_page", {
        sharedSession: {
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          sharedSessionId: input.sharedSessionId
        },
        direction: input.direction,
        cursor: input.cursor,
        limit: current.limits.historyPageMaxItems
      });
      if (
        !result.ok ||
        result.command !== "collaboration.load_shared_source_page"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        mergeSourcePage(current, result.data.page, input.direction),
        { kind: "command" }
      );
      return requireSnapshot();
    },
    async listOwnedSharedMemoryGrants(input) {
      const result = await command(
        "collaboration.list_owned_shared_memory_grants",
        input
      );
      if (
        !result.ok ||
        result.command !== "collaboration.list_owned_shared_memory_grants"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.grants;
    },
    async listOwnedShares(input) {
      const result = await command("collaboration.list_owned_shares", {
        cursor: input.cursor,
        limit: input.limit ?? 50,
        history: input.history ?? false
      });
      if (!result.ok || result.command !== "collaboration.list_owned_shares") {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data;
    },
    async getOwnedShare(input) {
      const result = await command("collaboration.get_owned_share", input);
      if (!result.ok || result.command !== "collaboration.get_owned_share") {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.share;
    },
    async renameOwnedShare(input) {
      const result = await command("collaboration.rename_owned_share", input);
      if (!result.ok || result.command !== "collaboration.rename_owned_share") {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.share;
    },
    async controlPendingShare(input) {
      const result = await command("collaboration.control_pending_share", {
        ...input,
        mutationId: crypto.randomUUID()
      });
      if (
        !result.ok ||
        result.command !== "collaboration.control_pending_share"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.pendingShare;
    },
    async shareConversationSource(input) {
      const commandRequestId = crypto.randomUUID();
      const mutationId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.share_conversation_source",
        commandRequestId,
        mutationId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.share_conversation_source",
          input: { mutationId, ...input, actionGrant }
        })
      );
      if (
        !result.ok ||
        result.command !== "collaboration.share_conversation_source"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.sourceAccess;
    },
    async revokeConversationSource(input) {
      const commandRequestId = crypto.randomUUID();
      const mutationId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.revoke_conversation_source",
        commandRequestId,
        mutationId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.revoke_conversation_source",
          input: { mutationId, ...input, actionGrant }
        })
      );
      if (
        !result.ok ||
        result.command !== "collaboration.revoke_conversation_source"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.sourceAccess;
    },
    async previewSharedMemoryCandidate(input) {
      const result = await command(
        "collaboration.preview_shared_memory_candidate",
        input
      );
      if (
        !result.ok ||
        result.command !== "collaboration.preview_shared_memory_candidate"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.candidate;
    },
    async prepareSharedMemorySource({ sessionId }) {
      const result = await command(
        "collaboration.prepare_shared_memory_source",
        {
          sessionId,
          consentedAt: new Date().toISOString()
        }
      );
      if (
        !result.ok ||
        result.command !== "collaboration.prepare_shared_memory_source"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyPersonalMemoryEntry(requireSnapshot(), result.data.entry),
        { kind: "command" }
      );
      return result.data.entry;
    },
    async pauseSharedMemorySync({ sessionId }) {
      const result = await command("collaboration.pause_shared_memory_sync", {
        sessionId
      });
      if (
        !result.ok ||
        result.command !== "collaboration.pause_shared_memory_sync"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyPersonalMemoryEntry(requireSnapshot(), result.data.entry),
        {
          kind: "command"
        }
      );
      return result.data.entry;
    },
    async resumeSharedMemorySync({ sessionId }) {
      const result = await command("collaboration.resume_shared_memory_sync", {
        sessionId
      });
      if (
        !result.ok ||
        result.command !== "collaboration.resume_shared_memory_sync"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyPersonalMemoryEntry(requireSnapshot(), result.data.entry),
        {
          kind: "command"
        }
      );
      return result.data.entry;
    },
    async revokeSharedMemorySync({ sessionId }) {
      const result = await command("collaboration.revoke_shared_memory_sync", {
        sessionId
      });
      if (
        !result.ok ||
        result.command !== "collaboration.revoke_shared_memory_sync"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      await publish(
        applyPersonalMemoryEntry(requireSnapshot(), result.data.entry),
        { kind: "command" }
      );
      return result.data.entry;
    },
    async previewSharedMemory(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.preview_shared_memory",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.preview_shared_memory",
          input: { ...input, actionGrant }
        })
      );
      if (
        !result.ok ||
        result.command !== "collaboration.preview_shared_memory"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.preview;
    },
    async loadSharedMemoryPreviewPage(input) {
      const result = await command(
        "collaboration.load_shared_memory_preview_page",
        {
          ...input,
          limit: requireSnapshot().limits.historyPageMaxItems
        }
      );
      if (
        !result.ok ||
        result.command !== "collaboration.load_shared_memory_preview_page"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.preview;
    },
    async shareMemory(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.share_memory",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.share_memory",
          input: { ...input, actionGrant }
        })
      );
      if (!result.ok || result.command !== "collaboration.share_memory") {
        throw new Error("Unexpected collaboration result.");
      }
      return "grant" in result.data
        ? result.data.grant
        : result.data.pendingShare;
    },
    async revokeSharedMemory(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.revoke_shared_memory",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.revoke_shared_memory",
          input: { ...input, actionGrant }
        })
      );
      if (
        !result.ok ||
        result.command !== "collaboration.revoke_shared_memory"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.grant;
    },
    async changeSharedMemoryRepresentation(input) {
      const commandRequestId = crypto.randomUUID();
      const actionGrant = await waitForActionGrant({
        intent: "collaboration.change_shared_memory_representation",
        commandRequestId,
        ...input
      });
      const result = await runApprovedAction(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: commandRequestId,
          command: "collaboration.change_shared_memory_representation",
          input: { ...input, actionGrant }
        })
      );
      if (
        !result.ok ||
        result.command !== "collaboration.change_shared_memory_representation"
      ) {
        throw new Error("Unexpected collaboration result.");
      }
      return result.data.pendingShare;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPendingDeliveryReceipts();
      appliedReceiptVersions.clear();
      eventQueue.dispose();
      removeBridgeListener();
      listeners.clear();
      actionGrantProjections.dispose();
      const ids = subscriptions.dispose();
      for (const subscriptionId of ids) {
        void unsubscribeSubscriptionId(subscriptionId);
      }
    }
  };
};

export const collaborationThreadReference = threadReference;
