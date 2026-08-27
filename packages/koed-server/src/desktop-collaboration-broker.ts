import { randomUUID } from "node:crypto";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationBackendIdentitySchema,
  collaborationCommandResultSchema,
  collaborationConnectionEventSchema,
  collaborationDurableSendEventSchema,
  collaborationDurableSendSchema,
  collaborationRemoteBackendUrlSchema,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  COLLABORATION_SEND_RETRY_MAX_ATTEMPTS,
  clearCollaborationActionGrantCustodyForBackend,
  clearCollaborationPendingTeamSends,
  deleteCollaborationPendingSend,
  listCollaborationPendingSends,
  readDesktopLocalCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization,
  storeCollaborationPendingSend,
  updateCollaborationPendingSendState,
  type CollaborationCommandResult,
  type CollaborationDurableSend,
  type CollaborationMessage,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSafeError,
  type CollaborationSnapshot,
  type CollaborationPendingSendRecord
} from "@koed/shared";
import {
  createSecureUpstreamFetch,
  registeredPrivateNetworkPolicy
} from "@koed/shared/secure-upstream-fetch";
import {
  DESKTOP_COLLABORATION_BROKER_MAX_MESSAGE_BYTES,
  DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
  desktopCollaborationBrokerChildMessageSchema,
  desktopCollaborationBrokerParentMessageSchema,
  measureDesktopCollaborationBrokerMessageBytes,
  type DesktopCollaborationBrokerChildMessage
} from "./desktop-collaboration-broker-contract.js";
import {
  createDesktopCollaborationBrokerLocalTransport,
  type CollaborationTransportContext
} from "./desktop-collaboration-broker-local-transport.js";
import { loadRepoEnv, resolveApiUrl } from "./env-file.js";
import { resolveKoedServerPaths, type KoedServerPaths } from "./paths.js";
import { applyPersistedLocalPorts } from "./ports.js";
import {
  applyActiveRuntimeUrls,
  readActiveRuntimeState
} from "./runtime-state.js";
import {
  removeProjectTeamWorkspaceLinksForBackend,
  removeProjectTeamWorkspaceLinksForMismatchedBinding
} from "./project-team-workspace-links.js";
import {
  beginUpstreamDisconnectCleanup,
  completeUpstreamDisconnectCleanup,
  listUpstreamDisconnectCleanupRecords,
  updateUpstreamDisconnectCleanup,
  upstreamDisconnectCleanupPending
} from "./upstream-disconnect-cleanup.js";
import {
  getActiveUpstreamBackend,
  listUpstreamBackends,
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  setActiveUpstreamBackend,
  updateUpstreamBackendRoutePolicy
} from "./upstream-registry.js";
import {
  disconnectUpstreamBackendEnrollment,
  getUpstreamEnrollmentStatus,
  readUpstreamEnrollmentBinding,
  startUpstreamEnrollment,
  type UpstreamEnrollmentResult
} from "./upstream-enrollment.js";

const requestHistoryMaxPerOwner = 512;
const requestResultCacheMaxBytesPerOwner = 16 * 1024 * 1024;
const capabilityRefreshLeadMs = 60_000;
const capabilityRefreshRetryMs = 30_000;
const disconnectCleanupRetryMs = 5_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BrowserOpenRequest {
  ownerId: string;
  url: string;
}

interface DesktopCollaborationBrokerDependencies {
  environment?: NodeJS.ProcessEnv;
  paths?: KoedServerPaths;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  getUpstreamEnrollmentStatus?: typeof getUpstreamEnrollmentStatus;
  refreshUpstreamBackendCapabilities?: typeof refreshUpstreamBackendCapabilities;
  startUpstreamEnrollment?: typeof startUpstreamEnrollment;
  disconnectUpstreamBackendEnrollment?: typeof disconnectUpstreamBackendEnrollment;
  sendMessage?: (message: DesktopCollaborationBrokerChildMessage) => void;
  onBrowserOpenRequest?: (request: BrowserOpenRequest) => void;
}

interface OwnerContextRecord {
  ownerId: string;
  controller: AbortController;
  requests: Map<
    string,
    {
      command: string;
      inFlight: boolean;
      retryable: boolean;
      result: CollaborationCommandResult | null;
      resultBytes: number;
    }
  >;
  requestOrder: string[];
  resultCacheBytes: number;
  snapshot: CollaborationSnapshot | null;
}

const isOkRecord = (value: unknown): value is { ok: boolean } =>
  Boolean(value && typeof value === "object" && "ok" in value);

const collaborationSafeError = (
  code: CollaborationSafeError["code"],
  retryAfterMs: number | null = null
): CollaborationSafeError => ({
  code,
  userMessage: collaborationSafeErrorMessages[code],
  retryable:
    code === "offline" ||
    code === "temporarily_unavailable" ||
    code === "rate_limited" ||
    code === "conflict",
  retryAfterMs
});

const commandFailure = (
  command: CollaborationRendererCommand,
  error: CollaborationSafeError
): CollaborationCommandResult =>
  collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: false,
    error
  });

const resultState = (value: unknown): string | null =>
  value &&
  typeof value === "object" &&
  typeof (value as { state?: unknown }).state === "string"
    ? (value as { state: string }).state
    : null;

const backendIdentityFromSummary = (
  value: unknown
): { id: string; baseUrl: string } | null => {
  if (!value || typeof value !== "object") return null;
  const parsed = collaborationBackendIdentitySchema.safeParse({
    id: (value as { id?: unknown }).id,
    baseUrl: (value as { baseUrl?: unknown }).baseUrl
  });
  return parsed.success ? parsed.data : null;
};

const findBackendIdentity = (
  paths: KoedServerPaths,
  preferredBackendId?: string
): { id: string; baseUrl: string } | null => {
  const backends = listUpstreamBackends(paths).backends ?? [];
  if (preferredBackendId) {
    const preferred = backends.find((item) => item.id === preferredBackendId);
    const parsedPreferred = backendIdentityFromSummary(preferred);
    if (parsedPreferred) return parsedPreferred;
    return null;
  }
  return backendIdentityFromSummary(getActiveUpstreamBackend(paths));
};

const enrollmentSupportsCollaboration = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const enrollment = (value as { enrollment?: unknown }).enrollment;
  if (!enrollment || typeof enrollment !== "object") return false;
  const families = (enrollment as { requestedOperationFamilies?: unknown })
    .requestedOperationFamilies;
  return (
    Array.isArray(families) &&
    families.includes("personal_collaboration_read") &&
    families.includes("personal_collaboration_write") &&
    families.includes("team_workspace_read") &&
    families.includes("team_chat_read") &&
    families.includes("team_chat_write") &&
    families.includes("share_grant_management") &&
    families.includes("sync") &&
    families.includes("managed_execution") &&
    families.includes("action_grant")
  );
};

const enableCollaborationRoutePolicy = (
  paths: KoedServerPaths,
  backendId: string
) =>
  updateUpstreamBackendRoutePolicy(paths, backendId, {
    personalCollaboration: "enabled",
    teamWorkspaceRead: "enabled",
    shareGrantManagement: "enabled",
    sync: "enabled",
    managedExecution: "enabled",
    admin: "enabled"
  });

const browserActivationUrlFromResult = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const enrollment = (value as { enrollment?: unknown }).enrollment;
  if (!enrollment || typeof enrollment !== "object") return null;
  const activationUrl = (enrollment as { activationUrl?: unknown })
    .activationUrl;
  if (typeof activationUrl !== "string" || !activationUrl.trim()) return null;
  const parsed = collaborationRemoteBackendUrlSchema.safeParse(
    activationUrl.trim()
  );
  if (parsed.success) return parsed.data;
  try {
    const url = new URL(activationUrl.trim());
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const pruneOwnerRequests = (owner: OwnerContextRecord): void => {
  let inspected = 0;
  while (
    (owner.requestOrder.length > requestHistoryMaxPerOwner ||
      owner.resultCacheBytes > requestResultCacheMaxBytesPerOwner) &&
    inspected < owner.requestOrder.length
  ) {
    const requestId = owner.requestOrder.shift();
    if (!requestId) break;
    const record = owner.requests.get(requestId);
    if (record?.inFlight) {
      owner.requestOrder.push(requestId);
      inspected += 1;
      continue;
    }
    if (record) {
      owner.resultCacheBytes -= record.resultBytes;
      owner.requests.delete(requestId);
    }
  }
};

const claimOwnerRequest = (
  owner: OwnerContextRecord,
  command: CollaborationRendererCommand
):
  | { state: "execute" }
  | { state: "cached"; result: CollaborationCommandResult }
  | { state: "conflict" } => {
  const serialized = JSON.stringify(command);
  const existing = owner.requests.get(command.requestId);
  if (existing) {
    if (existing.command !== serialized || existing.inFlight) {
      return { state: "conflict" };
    }
    if (existing.result && !existing.retryable) {
      return { state: "cached", result: existing.result };
    }
    if (!existing.retryable) return { state: "conflict" };
    owner.resultCacheBytes -= existing.resultBytes;
    existing.inFlight = true;
    existing.retryable = false;
    existing.result = null;
    existing.resultBytes = 0;
    return { state: "execute" };
  }
  owner.requests.set(command.requestId, {
    command: serialized,
    inFlight: true,
    retryable: false,
    result: null,
    resultBytes: 0
  });
  owner.requestOrder.push(command.requestId);
  pruneOwnerRequests(owner);
  return { state: "execute" };
};

const finishOwnerRequest = (
  owner: OwnerContextRecord,
  requestId: string,
  result: CollaborationCommandResult
): void => {
  const record = owner.requests.get(requestId);
  if (!record) return;
  const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  record.inFlight = false;
  record.retryable = !result.ok && result.error.retryable;
  record.result = result;
  record.resultBytes = resultBytes;
  owner.resultCacheBytes += resultBytes;
  pruneOwnerRequests(owner);
};

const failOwnerRequest = (
  owner: OwnerContextRecord,
  requestId: string
): void => {
  const record = owner.requests.get(requestId);
  if (!record) return;
  record.inFlight = false;
  record.retryable = true;
};

const createConnectionEvent = (
  state:
    | "connecting"
    | "reconnecting"
    | "live"
    | "unavailable"
    | "disconnected",
  backendId: string | null,
  error: CollaborationSafeError | null = null,
  now = Date.now()
): CollaborationRendererEvent =>
  collaborationConnectionEventSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    type: "connection",
    connection: {
      state,
      backendId,
      connectedAt: state === "live" ? new Date(now).toISOString() : null,
      retryAt: null,
      reconnectAttempt: state === "reconnecting" ? 1 : 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    error
  });

const lifecycleFailure = (
  command: Extract<
    CollaborationRendererCommand,
    | { command: "collaboration.connect_backend" }
    | { command: "collaboration.reconnect_backend" }
    | { command: "collaboration.disconnect_backend" }
  >,
  error: CollaborationSafeError
) => commandFailure(command, error);

export const createDesktopCollaborationBroker = (
  dependencies: DesktopCollaborationBrokerDependencies = {}
) => {
  const environment = dependencies.environment ?? process.env;
  const paths =
    dependencies.paths ??
    resolveKoedServerPaths(environment as NodeJS.ProcessEnv);
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const ownedUpstreamFetcher = dependencies.fetch
    ? null
    : createSecureUpstreamFetch({
        allowPrivateNetworkForUrl: registeredPrivateNetworkPolicy(() =>
          (listUpstreamBackends(paths).backends ?? []).map((backend) => ({
            baseUrl: backend.baseUrl,
            profile: backend.profile
          }))
        )
      });
  const upstreamFetcher = dependencies.fetch ? fetcher : ownedUpstreamFetcher!;
  const enrollmentStatus =
    dependencies.getUpstreamEnrollmentStatus ?? getUpstreamEnrollmentStatus;
  const refreshCapabilities =
    dependencies.refreshUpstreamBackendCapabilities ??
    refreshUpstreamBackendCapabilities;
  const startEnrollment =
    dependencies.startUpstreamEnrollment ?? startUpstreamEnrollment;
  const disconnectEnrollment =
    dependencies.disconnectUpstreamBackendEnrollment ??
    disconnectUpstreamBackendEnrollment;
  const sleep =
    dependencies.sleep ??
    ((delayMs: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
      }));
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const ownerContexts = new Map<string, OwnerContextRecord>();
  const enrollmentMonitors = new Map<string, AbortController>();
  const capabilityRefreshes = new Map<string, Promise<boolean>>();
  const capabilityRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const pendingSendExecutions = new Map<
    string,
    Promise<CollaborationCommandResult>
  >();
  const pendingSendStarts = new Map<
    string,
    {
      command: Extract<
        CollaborationRendererCommand,
        | { command: "collaboration.send_message" }
        | { command: "collaboration.retry_message" }
      >;
      pending: CollaborationPendingSendRecord;
      context: CollaborationTransportContext;
    }
  >();
  let disconnectCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let lifecycleTail: Promise<void> = Promise.resolve();
  const sessionSend = (message: DesktopCollaborationBrokerChildMessage) => {
    const parsed = desktopCollaborationBrokerChildMessageSchema.parse(message);
    if (
      measureDesktopCollaborationBrokerMessageBytes(parsed) >
      DESKTOP_COLLABORATION_BROKER_MAX_MESSAGE_BYTES
    ) {
      throw new Error(
        "Desktop collaboration broker message exceeded its byte limit."
      );
    }
    dependencies.sendMessage?.(parsed);
  };

  const ownerContext = (ownerId: string): OwnerContextRecord => {
    const current = ownerContexts.get(ownerId);
    if (current) return current;
    const created: OwnerContextRecord = {
      ownerId,
      controller: new AbortController(),
      requests: new Map(),
      requestOrder: [],
      resultCacheBytes: 0,
      snapshot: null
    };
    ownerContexts.set(ownerId, created);
    return created;
  };

  const eventInvalidatesProtectedCustody = (
    event: CollaborationRendererEvent
  ): boolean =>
    (event.type === "connection" &&
      (event.connection.state === "disconnected" ||
        event.connection.state === "access_revoked")) ||
    (event.type === "control" && event.reason === "access_revoked") ||
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

  const cachedProtectedThreadIds = (
    owner: OwnerContextRecord,
    event: Extract<CollaborationRendererEvent, { type: "update" }>
  ): Set<string> => {
    const threadIds = new Set<string>();
    if (event.resource.threadId) threadIds.add(event.resource.threadId);
    for (const record of owner.requests.values()) {
      if (!record.result?.ok) continue;
      const data = record.result.data as { snapshot?: unknown };
      const cached = collaborationSnapshotSchema.safeParse(data.snapshot);
      if (!cached.success) continue;
      for (const team of cached.data.navigation.teams) {
        if (event.resource.teamId && team.id !== event.resource.teamId)
          continue;
        if (!event.resource.workspaceId) {
          for (const thread of team.directMessages) threadIds.add(thread.id);
        }
        for (const workspace of team.workspaces) {
          if (
            event.resource.workspaceId &&
            workspace.id !== event.resource.workspaceId
          ) {
            continue;
          }
          for (const thread of workspace.channels) threadIds.add(thread.id);
          for (const session of workspace.sharedMemory) {
            if (
              event.resource.sharedSessionId &&
              session.id !== event.resource.sharedSessionId
            ) {
              continue;
            }
            threadIds.add(session.companionThreadId);
          }
        }
      }
      if (
        cached.data.view.kind === "shared_session" &&
        (!event.resource.sharedSessionId ||
          cached.data.view.session.id === event.resource.sharedSessionId)
      ) {
        threadIds.add(cached.data.view.companion.thread.id);
      }
    }
    return threadIds;
  };

  const clearOwnerProtectedCustody = (
    owner: OwnerContextRecord,
    event: CollaborationRendererEvent
  ): void => {
    if (!eventInvalidatesProtectedCustody(event)) return;
    const backendId = findBackendIdentity(paths)?.id ?? null;
    const fullBackendRevocation =
      event.type !== "update" ||
      ((event.family === "access_revoked" ||
        event.family === "team_membership_access" ||
        event.family === "team_lifecycle") &&
        !event.resource.shareGrantId &&
        !event.resource.workspaceId);
    if (backendId && fullBackendRevocation) {
      clearCollaborationActionGrantCustodyForBackend(paths.koedHome, backendId);
      clearCollaborationPendingTeamSends(paths.koedHome, backendId);
    } else if (event.type === "update") {
      const revokedThreadIds = cachedProtectedThreadIds(owner, event);
      for (const pending of listCollaborationPendingSends(paths.koedHome)) {
        if (
          pending.thread.scope === "team" &&
          revokedThreadIds.has(pending.thread.threadId)
        ) {
          deleteCollaborationPendingSend(paths.koedHome, pending.key);
        }
      }
    }
    owner.requests.clear();
    owner.requestOrder = [];
    owner.resultCacheBytes = 0;
    owner.snapshot = null;
  };

  const sendOwnerEvent = (
    ownerId: string,
    event: CollaborationRendererEvent
  ): void => {
    clearOwnerProtectedCustody(ownerContext(ownerId), event);
    sessionSend({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken:
        environment.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN!,
      type: "renderer_event",
      ownerId,
      event
    });
  };

  const transportContextForOwner = (
    ownerId: string
  ): CollaborationTransportContext => {
    const owner = ownerContext(ownerId);
    return {
      ownerId,
      signal: owner.controller.signal,
      emitCollaborationEvent: (event) => sendOwnerEvent(ownerId, event)
    };
  };

  const durablePendingSendOwnerId = (): string | null =>
    readDesktopLocalCredentialAuthorization(paths.koedHome)?.ownerUserId ??
    null;

  const pendingSendThreadKey = (
    record: CollaborationPendingSendRecord
  ): string =>
    [
      record.backendId ?? "personal",
      record.remotePrincipalId ?? record.ownerId,
      record.thread.scope === "team" ? record.thread.teamId : "personal",
      record.thread.threadId
    ].join(":");

  const durableSendFromRecord = (
    record: CollaborationPendingSendRecord,
    snapshot: CollaborationSnapshot | null,
    overrides: {
      state?: CollaborationDurableSend["state"];
      failure?: CollaborationSafeError | null;
      bodyAuthorized?: boolean;
      allowStaleTeamBinding?: boolean;
    } = {}
  ): CollaborationDurableSend | null => {
    if (record.ownerId !== durablePendingSendOwnerId()) return null;
    let authority: CollaborationDurableSend["authority"];
    let bodyAuthorized = overrides.bodyAuthorized ?? true;
    if (record.thread.scope === "personal") {
      const thread = snapshot?.navigation.personal.channels.find(
        (candidate) => candidate.id === record.thread.threadId
      );
      if (snapshot && (!thread || !thread.canPost)) return null;
      authority = {
        scope: "personal",
        ownerUserId: record.ownerId,
        threadId: record.thread.threadId
      };
    } else {
      const activeBackendId = findBackendIdentity(paths)?.id ?? null;
      const binding = activeBackendId
        ? readUpstreamEnrollmentBinding(paths, activeBackendId)
        : null;
      if (
        !snapshot ||
        snapshot.connection.backendId !== record.backendId ||
        snapshot.navigation.teamPrincipal?.id !== record.remotePrincipalId ||
        (!overrides.allowStaleTeamBinding &&
          (!binding ||
            activeBackendId !== record.backendId ||
            binding.principalUserId !== record.remotePrincipalId ||
            binding.deviceCredentialId !== record.deviceCredentialId))
      ) {
        return null;
      }
      const teamId = record.thread.teamId;
      const team = snapshot.navigation.teams.find(
        (candidate) =>
          candidate.id === teamId && candidate.lifecycle === "active"
      );
      if (!team) return null;
      const directMessage = team.directMessages.find(
        (candidate) => candidate.id === record.thread.threadId
      );
      let workspaceId: string | null = null;
      let canPost = directMessage?.canPost ?? false;
      if (!directMessage) {
        for (const workspace of team.workspaces) {
          if (
            workspace.lifecycle !== "active" ||
            workspace.access !== "write"
          ) {
            continue;
          }
          const channel = workspace.channels.find(
            (candidate) => candidate.id === record.thread.threadId
          );
          const sharedSession = workspace.sharedMemory.find(
            (candidate) =>
              candidate.companionThreadId === record.thread.threadId
          );
          if (channel || sharedSession) {
            workspaceId = workspace.id;
            canPost =
              channel?.canPost ??
              (snapshot.view.kind === "shared_session" &&
                snapshot.view.companion.thread.id === record.thread.threadId &&
                snapshot.view.companion.thread.canPost);
            break;
          }
        }
      }
      if (!canPost) return null;
      authority = {
        scope: "team",
        backendId: record.backendId!,
        principalUserId: record.remotePrincipalId!,
        teamId: record.thread.teamId,
        workspaceId,
        threadId: record.thread.threadId
      };
    }
    const state =
      overrides.state ?? (record.state === "pending" ? "queued" : record.state);
    const failure =
      overrides.failure === undefined ? record.failure : overrides.failure;
    if (overrides.bodyAuthorized === false) bodyAuthorized = false;
    return collaborationDurableSendSchema.parse({
      clientMessageId: record.clientMessageId,
      authority,
      body: bodyAuthorized ? record.body : null,
      localCreationOrder: record.localCreationOrder,
      state,
      retryable: state === "queued" || state === "manual_retry",
      removalSupported: false,
      failure,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  };

  const snapshotWithDurableSends = (
    value: CollaborationSnapshot,
    purgeUnauthorized = true
  ): CollaborationSnapshot => {
    const outbox: CollaborationDurableSend[] = [];
    for (const record of listCollaborationPendingSends(paths.koedHome)) {
      const projected = durableSendFromRecord(record, value);
      if (projected) {
        outbox.push(projected);
      } else if (purgeUnauthorized && record.thread.scope === "team") {
        deleteCollaborationPendingSend(paths.koedHome, record.key);
      }
    }
    return collaborationSnapshotSchema.parse({ ...value, outbox });
  };

  const emitDurableSend = (
    ownerId: string,
    send: CollaborationDurableSend,
    message: CollaborationMessage | null
  ): void => {
    sendOwnerEvent(
      ownerId,
      collaborationDurableSendEventSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        type: "durable_send",
        eventId: randomUUID(),
        send,
        message
      })
    );
  };

  const runLifecycleExclusive = async <T>(operation: () => Promise<T>) => {
    const previous = lifecycleTail;
    let release!: () => void;
    lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const broadcastEvent = (event: CollaborationRendererEvent): void => {
    for (const owner of ownerContexts.values()) {
      sendOwnerEvent(owner.ownerId, event);
    }
  };

  const stopEnrollmentMonitors = (): void => {
    for (const controller of enrollmentMonitors.values()) controller.abort();
    enrollmentMonitors.clear();
  };

  const clearCapabilityRefreshTimers = (): void => {
    for (const timer of capabilityRefreshTimers.values()) clearTimeout(timer);
    capabilityRefreshTimers.clear();
  };

  const scheduleCapabilityRefresh = (
    backendId: string,
    expiresAt: number | null
  ): void => {
    const existing = capabilityRefreshTimers.get(backendId);
    if (existing) clearTimeout(existing);
    capabilityRefreshTimers.delete(backendId);
    if (getActiveUpstreamBackend(paths)?.id !== backendId) return;

    const now = dependencies.now?.() ?? Date.now();
    const delay =
      expiresAt === null
        ? capabilityRefreshRetryMs
        : Math.max(0, expiresAt - now - capabilityRefreshLeadMs);
    const timer = setTimeout(() => {
      capabilityRefreshTimers.delete(backendId);
      void ensureBackendCapabilities(backendId);
    }, delay);
    timer.unref?.();
    capabilityRefreshTimers.set(backendId, timer);
  };

  async function ensureBackendCapabilities(
    preferredBackendId?: string
  ): Promise<boolean> {
    const backend = preferredBackendId
      ? (listUpstreamBackends(paths).backends ?? []).find(
          (candidate) => candidate.id === preferredBackendId
        )
      : getActiveUpstreamBackend(paths);
    if (!backend) return false;
    const now = dependencies.now?.() ?? Date.now();
    const expiresAt = backend.capabilities.expiresAt
      ? Date.parse(backend.capabilities.expiresAt)
      : Number.NaN;
    if (
      backend.capabilities.state === "validated" &&
      Number.isFinite(expiresAt) &&
      expiresAt > now + capabilityRefreshLeadMs
    ) {
      scheduleCapabilityRefresh(backend.id, expiresAt);
      return true;
    }
    const existing = capabilityRefreshes.get(backend.id);
    if (existing) return existing;
    const refresh = refreshCapabilities(paths, backend.id, {
      fetch: upstreamFetcher,
      now: () => new Date(dependencies.now?.() ?? Date.now())
    })
      .then((result) => {
        const refreshed = (listUpstreamBackends(paths).backends ?? []).find(
          (candidate) => candidate.id === backend.id
        );
        const refreshedExpiry = refreshed?.capabilities.expiresAt
          ? Date.parse(refreshed.capabilities.expiresAt)
          : Number.NaN;
        scheduleCapabilityRefresh(
          backend.id,
          result.ok && Number.isFinite(refreshedExpiry) ? refreshedExpiry : null
        );
        return result.ok;
      })
      .catch(() => {
        scheduleCapabilityRefresh(backend.id, null);
        return false;
      })
      .finally(() => capabilityRefreshes.delete(backend.id));
    capabilityRefreshes.set(backend.id, refresh);
    return refresh;
  }

  const createTransport = () =>
    createDesktopCollaborationBrokerLocalTransport({
      fetch: fetcher,
      random: dependencies.random,
      now: dependencies.now,
      sleep: dependencies.sleep,
      resolveConnection: async (requiresTeamBackend, preferredBackendId) => {
        if (
          requiresTeamBackend &&
          !(await ensureBackendCapabilities(preferredBackendId))
        ) {
          return null;
        }
        const credential = readDesktopLocalCredentialAuthorization(
          paths.koedHome
        );
        if (!credential) return Promise.resolve(null);
        const backendId = requiresTeamBackend
          ? (findBackendIdentity(paths, preferredBackendId)?.id ?? null)
          : null;
        if (requiresTeamBackend && !backendId) return Promise.resolve(null);
        const activeRuntime = readActiveRuntimeState(paths.runtimeStatePath);
        return Promise.resolve({
          apiUrl: (
            activeRuntime?.apiUrl ??
            resolveApiUrl(
              applyActiveRuntimeUrls(
                applyPersistedLocalPorts(paths, environment, { force: true }),
                activeRuntime
              ),
              repoEnv
            )
          ).replace(/\/$/, ""),
          backendId,
          authorization: credential.authorization
        });
      }
    });

  let transport = createTransport();

  const resetTransport = () => {
    transport.stop();
    transport = createTransport();
  };

  const clearOwnerTeamRuntimeState = (): void => {
    for (const owner of ownerContexts.values()) {
      owner.controller.abort();
      owner.controller = new AbortController();
      owner.requests.clear();
      owner.requestOrder = [];
      owner.resultCacheBytes = 0;
      owner.snapshot = null;
    }
    pendingSendExecutions.clear();
  };

  const clearBackendDurableState = async (
    backendId: string
  ): Promise<boolean> => {
    let complete = true;
    try {
      if (!(await transport.revokeBackendSubscriptions(backendId))) {
        complete = false;
      }
    } catch {
      complete = false;
    }
    for (const clear of [
      () =>
        clearCollaborationActionGrantCustodyForBackend(
          paths.koedHome,
          backendId
        ),
      () => clearCollaborationPendingTeamSends(paths.koedHome, backendId),
      () => removeProjectTeamWorkspaceLinksForBackend(paths, backendId)
    ]) {
      try {
        clear();
      } catch {
        complete = false;
      }
    }
    if (complete) {
      completeUpstreamDisconnectCleanup(paths, backendId);
    } else if (upstreamDisconnectCleanupPending(paths, backendId)) {
      updateUpstreamDisconnectCleanup(paths, backendId, {
        phase: "local_cleanup_pending",
        lastFailureCategory: "local_cleanup_failed"
      });
    }
    return complete;
  };

  const clearBackendLocalState = async (
    backendId: string
  ): Promise<boolean> => {
    transport.stop();
    const complete = await clearBackendDurableState(backendId);
    clearOwnerTeamRuntimeState();
    transport = createTransport();
    return complete;
  };

  const retryRevokedBackendDurableCleanup = async (): Promise<void> => {
    for (const record of listUpstreamDisconnectCleanupRecords(paths)) {
      if (record.phase === "remote_revocation_pending") {
        const backend = (listUpstreamBackends(paths).backends ?? []).find(
          (candidate) => candidate.id === record.backendId
        );
        if (!backend) continue;
        const disconnected = await disconnectBackend(backend);
        if (!disconnected.revoked) continue;
      } else {
        await clearBackendDurableState(record.backendId);
      }
    }
  };

  const scheduleDisconnectCleanupRetry = (): void => {
    if (disconnectCleanupTimer || !upstreamDisconnectCleanupPending(paths)) {
      return;
    }
    disconnectCleanupTimer = setTimeout(() => {
      disconnectCleanupTimer = null;
      void runLifecycleExclusive(retryRevokedBackendDurableCleanup).finally(
        scheduleDisconnectCleanupRetry
      );
    }, disconnectCleanupRetryMs);
    disconnectCleanupTimer.unref?.();
  };

  const disconnectBackend = async (backend: {
    id: string;
    baseUrl: string;
  }): Promise<{ revoked: boolean; cleanupComplete: boolean }> => {
    const disconnected = await disconnectEnrollment(paths, backend.id, {
      fetch: upstreamFetcher
    });
    if (!isOkRecord(disconnected) || disconnected.ok !== true) {
      return { revoked: false, cleanupComplete: false };
    }
    if (!upstreamDisconnectCleanupPending(paths, backend.id)) {
      beginUpstreamDisconnectCleanup(paths, backend.id);
      updateUpstreamDisconnectCleanup(paths, backend.id, {
        phase: "local_cleanup_pending",
        lastFailureCategory: null
      });
    }
    return {
      revoked: true,
      cleanupComplete: await clearBackendLocalState(backend.id)
    };
  };

  const remapSendResult = (
    command: Extract<
      CollaborationRendererCommand,
      | { command: "collaboration.send_message" }
      | { command: "collaboration.retry_message" }
    >,
    result: CollaborationCommandResult
  ): CollaborationCommandResult =>
    collaborationCommandResultSchema.parse({
      ...result,
      requestId: command.requestId,
      command: command.command
    });

  const executePendingSend = async (
    command: Extract<
      CollaborationRendererCommand,
      | { command: "collaboration.send_message" }
      | { command: "collaboration.retry_message" }
    >,
    pending: CollaborationPendingSendRecord,
    context: CollaborationTransportContext
  ): Promise<CollaborationCommandResult> => {
    if (pending.backendId) {
      const activeBackend = getActiveUpstreamBackend(paths);
      const activeBackendId = activeBackend?.id ?? null;
      const binding = activeBackendId
        ? readUpstreamEnrollmentBinding(paths, activeBackendId)
        : null;
      const credential = activeBackendId
        ? readLocalEdgeClientCredentialAuthorization(
            paths.koedHome,
            activeBackendId
          )
        : null;
      const requiredFamily =
        pending.thread.scope === "personal"
          ? "personal_collaboration_write"
          : "team_chat_write";
      if (
        pending.backendId !== activeBackendId ||
        (pending.thread.scope === "personal" &&
          activeBackend?.routePolicy.personalCollaboration !== "enabled") ||
        !binding ||
        !credential?.operationFamilies.includes(requiredFamily) ||
        pending.remotePrincipalId !== binding.principalUserId ||
        pending.deviceCredentialId !== binding.deviceCredentialId
      ) {
        const error = collaborationSafeError("access_revoked");
        const failed = durableSendFromRecord(
          pending,
          ownerContext(context.ownerId).snapshot,
          {
            state: "failed",
            failure: error,
            bodyAuthorized: false,
            allowStaleTeamBinding: true
          }
        );
        deleteCollaborationPendingSend(paths.koedHome, pending.key);
        if (failed) emitDurableSend(context.ownerId, failed, null);
        return commandFailure(command, error);
      }
    }
    const currentExecution = pendingSendExecutions.get(pending.key);
    if (currentExecution) {
      return remapSendResult(command, await currentExecution);
    }
    const earlierBlockingSend = listCollaborationPendingSends(
      paths.koedHome
    ).find(
      (candidate) =>
        pendingSendThreadKey(candidate) === pendingSendThreadKey(pending) &&
        candidate.localCreationOrder < pending.localCreationOrder &&
        (candidate.state === "pending" || candidate.state === "manual_retry")
    );
    if (earlierBlockingSend) {
      return commandFailure(
        command,
        collaborationSafeError("temporarily_unavailable")
      );
    }
    const execution = (async (): Promise<CollaborationCommandResult> => {
      let record = pending;
      let lastResult: CollaborationCommandResult | null = null;
      while (
        !context.signal.aborted &&
        record.attemptCount < COLLABORATION_SEND_RETRY_MAX_ATTEMPTS
      ) {
        if (record.nextAttemptAt) {
          const delayMs = Math.max(
            0,
            Date.parse(record.nextAttemptAt) -
              (dependencies.now?.() ?? Date.now())
          );
          if (delayMs > 0) await sleep(delayMs, context.signal);
          if (context.signal.aborted) break;
        }
        const attemptCommand = collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId:
            record.attemptCount === 0 ? command.requestId : randomUUID(),
          command:
            record.attemptCount === 0
              ? command.command
              : "collaboration.retry_message",
          input: {
            thread: record.thread,
            clientMessageId: record.clientMessageId,
            body: record.body
          }
        });
        lastResult = await transport.request(attemptCommand, context);
        const attemptCount = record.attemptCount + 1;
        if (lastResult.ok) {
          if (
            (lastResult.command !== "collaboration.send_message" &&
              lastResult.command !== "collaboration.retry_message") ||
            !("message" in lastResult.data)
          ) {
            return commandFailure(
              command,
              collaborationSafeError("internal_error")
            );
          }
          const confirmedMessage: CollaborationMessage = {
            ...lastResult.data.message,
            clientMessageId: record.clientMessageId
          };
          const sent = durableSendFromRecord(
            record,
            ownerContext(context.ownerId).snapshot,
            { state: "sent", failure: null }
          );
          deleteCollaborationPendingSend(paths.koedHome, record.key);
          if (sent) emitDurableSend(context.ownerId, sent, confirmedMessage);
          return collaborationCommandResultSchema.parse({
            ...lastResult,
            data: { message: confirmedMessage }
          });
        }
        if (!lastResult.error.retryable) {
          const protectedAuthorityLost =
            record.thread.scope === "team" &&
            (lastResult.error.code === "access_revoked" ||
              lastResult.error.code === "permission_denied" ||
              lastResult.error.code === "not_available");
          const failedRecord = protectedAuthorityLost
            ? record
            : (updateCollaborationPendingSendState(paths.koedHome, {
                key: record.key,
                attemptCount,
                state: "failed",
                failure: lastResult.error,
                nextAttemptAt: null
              }) ?? record);
          const failed = durableSendFromRecord(
            failedRecord,
            ownerContext(context.ownerId).snapshot,
            {
              state: "failed",
              failure: lastResult.error,
              bodyAuthorized: !protectedAuthorityLost
            }
          );
          if (protectedAuthorityLost) {
            deleteCollaborationPendingSend(paths.koedHome, record.key);
          }
          if (failed) emitDurableSend(context.ownerId, failed, null);
          return lastResult;
        }
        if (attemptCount >= COLLABORATION_SEND_RETRY_MAX_ATTEMPTS) {
          const manualRetry =
            updateCollaborationPendingSendState(paths.koedHome, {
              key: record.key,
              attemptCount,
              state: "manual_retry",
              failure: lastResult.error,
              nextAttemptAt: null
            }) ?? record;
          const projected = durableSendFromRecord(
            manualRetry,
            ownerContext(context.ownerId).snapshot
          );
          if (projected) emitDurableSend(context.ownerId, projected, null);
          return lastResult;
        }
        const delayMs = Math.min(
          Math.max(
            lastResult.error.retryAfterMs ?? 250 * 2 ** (attemptCount - 1),
            250
          ),
          30_000
        );
        record =
          updateCollaborationPendingSendState(paths.koedHome, {
            key: record.key,
            attemptCount,
            state: "pending",
            failure: null,
            nextAttemptAt: new Date(
              (dependencies.now?.() ?? Date.now()) + delayMs
            ).toISOString()
          }) ?? record;
      }
      return (
        lastResult ?? commandFailure(command, collaborationSafeError("offline"))
      );
    })();
    pendingSendExecutions.set(pending.key, execution);
    try {
      return remapSendResult(command, await execution);
    } finally {
      if (pendingSendExecutions.get(pending.key) === execution) {
        pendingSendExecutions.delete(pending.key);
      }
      await startNextPendingSend(pending, context);
    }
  };

  async function startNextPendingSend(
    completed: CollaborationPendingSendRecord,
    context: CollaborationTransportContext
  ): Promise<void> {
    if (context.signal.aborted) return;
    const next = listCollaborationPendingSends(paths.koedHome).find(
      (candidate) =>
        pendingSendThreadKey(candidate) === pendingSendThreadKey(completed) &&
        (candidate.state === "pending" || candidate.state === "manual_retry")
    );
    if (!next || next.state !== "pending") return;
    const retryCommand = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.retry_message",
      input: {
        thread: next.thread,
        clientMessageId: next.clientMessageId,
        body: next.body
      }
    });
    if (retryCommand.command === "collaboration.retry_message") {
      await executePendingSend(retryCommand, next, context);
    }
  }

  const persistAndExecuteSend = (
    command: Extract<
      CollaborationRendererCommand,
      | { command: "collaboration.send_message" }
      | { command: "collaboration.retry_message" }
    >,
    context: CollaborationTransportContext
  ): CollaborationCommandResult => {
    const pendingOwnerId = durablePendingSendOwnerId();
    if (!pendingOwnerId) {
      return commandFailure(command, collaborationSafeError("not_available"));
    }
    const activeBackend = getActiveUpstreamBackend(paths);
    const activeBackendId = activeBackend?.id ?? null;
    const activeCredential = activeBackendId
      ? readLocalEdgeClientCredentialAuthorization(
          paths.koedHome,
          activeBackendId
        )
      : null;
    const backendId =
      command.input.thread.scope === "team" ||
      (activeBackend?.routePolicy.personalCollaboration === "enabled" &&
        activeCredential?.operationFamilies.includes(
          "personal_collaboration_write"
        ))
        ? activeBackendId
        : null;
    if (command.input.thread.scope === "team" && !backendId) {
      return commandFailure(command, collaborationSafeError("not_available"));
    }
    const remoteBinding = backendId
      ? readUpstreamEnrollmentBinding(paths, backendId)
      : null;
    if (command.input.thread.scope === "team" && !remoteBinding) {
      return commandFailure(command, collaborationSafeError("not_available"));
    }
    let existing: CollaborationPendingSendRecord | undefined;
    if (command.command === "collaboration.retry_message") {
      existing = listCollaborationPendingSends(paths.koedHome).find(
        (record) =>
          record.ownerId === pendingOwnerId &&
          record.thread.scope === command.input.thread.scope &&
          record.thread.threadId === command.input.thread.threadId &&
          record.clientMessageId === command.input.clientMessageId
      );
      if (
        existing?.backendId &&
        (existing.backendId !== backendId ||
          existing.remotePrincipalId !== remoteBinding?.principalUserId ||
          existing.deviceCredentialId !== remoteBinding?.deviceCredentialId)
      ) {
        deleteCollaborationPendingSend(paths.koedHome, existing.key);
        return commandFailure(
          command,
          collaborationSafeError("access_revoked")
        );
      }
      if (!existing || existing.state !== "manual_retry") {
        return commandFailure(command, collaborationSafeError("conflict"));
      }
    }
    const pending = storeCollaborationPendingSend(
      paths.koedHome,
      {
        ownerId: pendingOwnerId,
        backendId,
        remotePrincipalId: remoteBinding?.principalUserId ?? null,
        deviceCredentialId: remoteBinding?.deviceCredentialId ?? null,
        thread: command.input.thread,
        clientMessageId: command.input.clientMessageId,
        body: command.input.body
      },
      { resetAttempts: command.command === "collaboration.retry_message" }
    );
    const projected = durableSendFromRecord(
      pending,
      ownerContext(context.ownerId).snapshot
    );
    if (!projected) {
      deleteCollaborationPendingSend(paths.koedHome, pending.key);
      return commandFailure(command, collaborationSafeError("not_available"));
    }
    pendingSendStarts.set(command.requestId, { command, pending, context });
    return collaborationCommandResultSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: command.requestId,
      command: command.command,
      ok: true,
      data: { durableSend: projected }
    });
  };

  const resumeInterruptedSends = async (
    context: CollaborationTransportContext,
    snapshot: CollaborationSnapshot
  ): Promise<void> => {
    const pendingOwnerId = durablePendingSendOwnerId();
    if (!pendingOwnerId) return;
    const activeBackendId = findBackendIdentity(paths)?.id ?? null;
    const binding = activeBackendId
      ? readUpstreamEnrollmentBinding(paths, activeBackendId)
      : null;
    const pending = listCollaborationPendingSends(paths.koedHome).filter(
      (record) =>
        record.ownerId === pendingOwnerId && record.state === "pending"
    );
    if (activeBackendId && binding) {
      removeProjectTeamWorkspaceLinksForMismatchedBinding(paths, {
        backendId: binding.backendId,
        remotePrincipalId: binding.principalUserId,
        deviceCredentialId: binding.deviceCredentialId
      });
    }
    if (
      activeBackendId &&
      (!binding ||
        snapshot.navigation.teamPrincipal?.id !== binding.principalUserId)
    ) {
      clearCollaborationActionGrantCustodyForBackend(
        paths.koedHome,
        activeBackendId
      );
      clearCollaborationPendingTeamSends(paths.koedHome, activeBackendId);
      removeProjectTeamWorkspaceLinksForBackend(paths, activeBackendId);
      return;
    }
    const startedThreads = new Set<string>();
    for (const record of pending) {
      if (context.signal.aborted) return;
      if (
        record.thread.scope === "team" &&
        (!binding ||
          snapshot.navigation.teamPrincipal?.id !== binding.principalUserId ||
          record.backendId !== binding.backendId ||
          record.remotePrincipalId !== binding.principalUserId ||
          record.deviceCredentialId !== binding.deviceCredentialId)
      ) {
        deleteCollaborationPendingSend(paths.koedHome, record.key);
        continue;
      }
      const threadKey = pendingSendThreadKey(record);
      if (startedThreads.has(threadKey)) continue;
      const earliestBlocking = listCollaborationPendingSends(
        paths.koedHome
      ).find(
        (candidate) =>
          pendingSendThreadKey(candidate) === threadKey &&
          (candidate.state === "pending" || candidate.state === "manual_retry")
      );
      if (!earliestBlocking || earliestBlocking.state !== "pending") continue;
      startedThreads.add(threadKey);
      const command = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.retry_message",
        input: {
          thread: earliestBlocking.thread,
          clientMessageId: earliestBlocking.clientMessageId,
          body: earliestBlocking.body
        }
      });
      if (command.command !== "collaboration.retry_message") {
        throw new Error("Collaboration retry command validation failed.");
      }
      await executePendingSend(command, earliestBlocking, context);
    }
  };

  const releaseOwner = (ownerId: string) => {
    const owner = ownerContexts.get(ownerId);
    if (!owner) return;
    owner.controller.abort();
    transport.stopOwner(ownerId);
    ownerContexts.delete(ownerId);
  };

  const loadSnapshot = async (
    requestId: string,
    context: CollaborationTransportContext
  ): Promise<
    | { ok: true; snapshot: CollaborationSnapshot }
    | { ok: false; error: CollaborationSafeError }
  > => {
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command: "collaboration.load",
      input: {}
    });
    const result = await transport.request(command, context);
    if (!result.ok) return { ok: false, error: result.error };
    return result.command === "collaboration.load"
      ? {
          ok: true,
          snapshot: snapshotWithDurableSends(result.data.snapshot)
        }
      : { ok: false, error: collaborationSafeError("internal_error") };
  };

  const connectBackend = async (
    remoteUrl: string,
    sourceOwnerPrincipalId: string
  ): Promise<
    | {
        ok: true;
        backend: { id: string; baseUrl: string };
        enrollment: UpstreamEnrollmentResult;
      }
    | { ok: false }
  > => {
    const parsed = collaborationRemoteBackendUrlSchema.safeParse(remoteUrl);
    if (!parsed.success) {
      return { ok: false };
    }
    const registered = registerUpstreamBackend(paths, {
      url: parsed.data,
      displayName: "Team Backend",
      profile: "team_self_hosted"
    });
    if (!registered.ok || !registered.backend) return { ok: false };
    const refreshed = await refreshCapabilities(paths, registered.backend.id, {
      fetch: upstreamFetcher
    });
    if (!refreshed.ok) return { ok: false };
    const policy = enableCollaborationRoutePolicy(paths, registered.backend.id);
    if (!policy.ok) return { ok: false };
    const enrollment = await startEnrollment(paths, registered.backend.id, {
      fetch: upstreamFetcher,
      sourceOwnerPrincipalId
    });
    const enrollmentState = resultState(enrollment);
    if (
      enrollmentState === "pending" ||
      enrollmentState === "approved" ||
      enrollmentState === "exchanged"
    ) {
      const activated = setActiveUpstreamBackend(paths, registered.backend.id);
      if (!activated.ok) return { ok: false };
    }
    const backend = backendIdentityFromSummary(registered.backend);
    return backend ? { ok: true, backend, enrollment } : { ok: false };
  };

  const reconnectBackend = async (sourceOwnerPrincipalId: string) => {
    const backend = backendIdentityFromSummary(getActiveUpstreamBackend(paths));
    if (!backend) return { ok: false as const };
    if (!(await ensureBackendCapabilities(backend.id))) {
      return { ok: false as const };
    }
    const policy = enableCollaborationRoutePolicy(paths, backend.id);
    if (!policy.ok) return { ok: false as const };
    let enrollment = await enrollmentStatus(paths, backend.id, {
      fetch: upstreamFetcher
    });
    let state = resultState(enrollment);
    if (
      (state === "pending" || state === "approved" || state === "exchanged") &&
      !enrollmentSupportsCollaboration(enrollment)
    ) {
      return { ok: false as const };
    }
    if (state === "pending" || state === "approved" || state === "exchanged") {
      return { ok: true as const, backend, enrollment };
    }
    const restarted = await connectBackend(
      backend.baseUrl,
      sourceOwnerPrincipalId
    );
    if (!restarted.ok) return { ok: false as const };
    enrollment = restarted.enrollment;
    state = resultState(enrollment);
    return state
      ? { ok: true as const, backend, enrollment }
      : { ok: false as const };
  };

  const resolveLocalOwnerPrincipalId = async (
    ownerId: string
  ): Promise<string | null> => {
    const durableOwnerId = readDesktopLocalCredentialAuthorization(
      paths.koedHome
    )?.ownerUserId;
    if (durableOwnerId && uuidPattern.test(durableOwnerId)) {
      return durableOwnerId;
    }
    const owner = ownerContext(ownerId);
    const cachedOwnerId = owner.snapshot?.navigation.personalOwner.id;
    if (cachedOwnerId && uuidPattern.test(cachedOwnerId)) {
      return cachedOwnerId;
    }
    const loaded = await loadSnapshot(
      randomUUID(),
      transportContextForOwner(ownerId)
    );
    if (!loaded.ok) return null;
    owner.snapshot = loaded.snapshot;
    const loadedOwnerId = loaded.snapshot.navigation.personalOwner.id;
    return uuidPattern.test(loadedOwnerId) ? loadedOwnerId : null;
  };

  const handleLifecycleCommand = async (
    command: Extract<
      CollaborationRendererCommand,
      | { command: "collaboration.connect_backend" }
      | { command: "collaboration.reconnect_backend" }
      | { command: "collaboration.disconnect_backend" }
    >,
    ownerId: string
  ): Promise<CollaborationCommandResult> => {
    if (command.command === "collaboration.disconnect_backend") {
      stopEnrollmentMonitors();
      clearCapabilityRefreshTimers();
      const backend = backendIdentityFromSummary(
        getActiveUpstreamBackend(paths)
      );
      if (backend) {
        const disconnected = await disconnectBackend(backend);
        if (!disconnected.revoked) {
          return lifecycleFailure(
            command,
            collaborationSafeError("temporarily_unavailable")
          );
        }
        if (!disconnected.cleanupComplete) {
          scheduleDisconnectCleanupRetry();
          for (const owner of ownerContexts.values()) {
            sendOwnerEvent(
              owner.ownerId,
              createConnectionEvent("disconnected", null)
            );
          }
          return lifecycleFailure(
            command,
            collaborationSafeError("temporarily_unavailable")
          );
        }
      } else {
        resetTransport();
        clearOwnerTeamRuntimeState();
      }
      for (const owner of ownerContexts.values()) {
        sendOwnerEvent(
          owner.ownerId,
          createConnectionEvent("disconnected", null)
        );
      }
      const loaded = await loadSnapshot(
        command.requestId,
        transportContextForOwner(ownerId)
      );
      if (!loaded.ok) return lifecycleFailure(command, loaded.error);
      return collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: {
          snapshot: {
            ...loaded.snapshot,
            connection: {
              state: "disconnected",
              backendId: null,
              connectedAt: null,
              retryAt: null,
              reconnectAttempt: 0,
              protocolVersion: COLLABORATION_CONTRACT_VERSION
            },
            navigation: {
              ...loaded.snapshot.navigation,
              teamPrincipal: null,
              teams: []
            }
          }
        }
      });
    }

    const sourceOwnerPrincipalId = await resolveLocalOwnerPrincipalId(ownerId);
    if (!sourceOwnerPrincipalId) {
      return lifecycleFailure(
        command,
        collaborationSafeError("temporarily_unavailable")
      );
    }
    let connectResult;
    await retryRevokedBackendDurableCleanup();
    if (upstreamDisconnectCleanupPending(paths)) {
      return lifecycleFailure(
        command,
        collaborationSafeError("temporarily_unavailable")
      );
    }
    if (command.command === "collaboration.connect_backend") {
      const parsedTarget = collaborationRemoteBackendUrlSchema.safeParse(
        command.input.remoteUrl
      );
      if (!parsedTarget.success) {
        return lifecycleFailure(
          command,
          collaborationSafeError("invalid_input")
        );
      }
      const activeBackend = backendIdentityFromSummary(
        getActiveUpstreamBackend(paths)
      );
      const normalizedTarget = parsedTarget.data.replace(/\/+$/, "");
      const sameBackend =
        activeBackend?.baseUrl.replace(/\/+$/, "") === normalizedTarget;
      if (activeBackend && !sameBackend) {
        stopEnrollmentMonitors();
        clearCapabilityRefreshTimers();
        const disconnected = await disconnectBackend(activeBackend);
        if (!disconnected.revoked) {
          return lifecycleFailure(
            command,
            collaborationSafeError("temporarily_unavailable")
          );
        }
        if (!disconnected.cleanupComplete) {
          scheduleDisconnectCleanupRetry();
          return lifecycleFailure(
            command,
            collaborationSafeError("temporarily_unavailable")
          );
        }
      }
      connectResult = sameBackend
        ? await reconnectBackend(sourceOwnerPrincipalId)
        : await connectBackend(parsedTarget.data, sourceOwnerPrincipalId);
    } else {
      connectResult = await reconnectBackend(sourceOwnerPrincipalId);
    }
    if (!connectResult.ok) {
      return lifecycleFailure(command, collaborationSafeError("not_available"));
    }
    const enrollment = connectResult.enrollment;
    const state = resultState(enrollment);
    if (!enrollmentSupportsCollaboration(enrollment)) {
      return lifecycleFailure(command, collaborationSafeError("not_available"));
    }
    if (state === "pending" || state === "approved") {
      const activationUrl = browserActivationUrlFromResult(enrollment);
      if (activationUrl) {
        dependencies.onBrowserOpenRequest?.({
          ownerId,
          url: activationUrl
        });
      }
      sendOwnerEvent(
        ownerId,
        createConnectionEvent(
          command.command === "collaboration.connect_backend"
            ? "connecting"
            : "reconnecting",
          connectResult.backend.id
        )
      );
      const enrollmentId = enrollment.enrollment?.requestId;
      if (enrollmentId) {
        const monitorKey = `${connectResult.backend.id}:${enrollmentId}`;
        if (!enrollmentMonitors.has(monitorKey)) {
          const monitorController = new AbortController();
          enrollmentMonitors.set(monitorKey, monitorController);
          void (async () => {
            const expiresAt = enrollment.enrollment?.expiresAt
              ? Date.parse(enrollment.enrollment.expiresAt)
              : Number.NaN;
            try {
              while (!monitorController.signal.aborted) {
                if (
                  Number.isFinite(expiresAt) &&
                  (dependencies.now?.() ?? Date.now()) >= expiresAt
                ) {
                  broadcastEvent(
                    createConnectionEvent(
                      "unavailable",
                      connectResult.backend.id,
                      collaborationSafeError("not_available")
                    )
                  );
                  return;
                }
                await sleep(1_000, monitorController.signal);
                if (monitorController.signal.aborted) return;
                const current = await enrollmentStatus(
                  paths,
                  connectResult.backend.id,
                  { fetch: upstreamFetcher }
                );
                if (current.enrollment?.requestId !== enrollmentId) return;
                if (
                  current.state === "pending" ||
                  current.state === "approved"
                ) {
                  continue;
                }
                if (
                  current.state === "exchanged" &&
                  findBackendIdentity(paths)?.id === connectResult.backend.id
                ) {
                  resetTransport();
                  broadcastEvent(
                    createConnectionEvent(
                      "live",
                      connectResult.backend.id,
                      null,
                      dependencies.now?.() ?? Date.now()
                    )
                  );
                  return;
                }
                broadcastEvent(
                  createConnectionEvent(
                    "unavailable",
                    connectResult.backend.id,
                    collaborationSafeError("not_available")
                  )
                );
                return;
              }
            } catch {
              if (!monitorController.signal.aborted) {
                broadcastEvent(
                  createConnectionEvent(
                    "unavailable",
                    connectResult.backend.id,
                    collaborationSafeError("temporarily_unavailable")
                  )
                );
              }
            } finally {
              enrollmentMonitors.delete(monitorKey);
            }
          })();
        }
      }
      return lifecycleFailure(
        command,
        collaborationSafeError("temporarily_unavailable")
      );
    }
    if (state !== "exchanged") {
      return lifecycleFailure(command, collaborationSafeError("not_available"));
    }
    const loaded = await loadSnapshot(
      command.requestId,
      transportContextForOwner(ownerId)
    );
    if (!loaded.ok) return lifecycleFailure(command, loaded.error);
    return collaborationCommandResultSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: command.requestId,
      command: command.command,
      ok: true,
      data:
        command.command === "collaboration.connect_backend"
          ? {
              backend: connectResult.backend,
              snapshot: loaded.snapshot
            }
          : {
              snapshot: loaded.snapshot
            }
    });
  };

  const sendCommandResult = (
    envelopeId: string,
    ownerId: string,
    result: CollaborationCommandResult
  ) => {
    sessionSend({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken:
        environment.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN!,
      type: "command_result",
      envelopeId,
      ownerId,
      result
    });
  };

  const sendError = (
    error: Omit<
      Extract<DesktopCollaborationBrokerChildMessage, { type: "error" }>,
      "protocolVersion" | "contractVersion" | "sessionToken" | "type"
    >
  ) => {
    sessionSend({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken:
        environment.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN!,
      type: "error",
      ...error
    });
  };

  const rejectInvalidMessage = (
    value: unknown,
    message = "Desktop collaboration broker rejected an invalid message."
  ) => {
    sendError({
      envelopeId:
        value &&
        typeof value === "object" &&
        typeof (value as { envelopeId?: unknown }).envelopeId === "string"
          ? (value as { envelopeId: string }).envelopeId
          : null,
      ownerId:
        value &&
        typeof value === "object" &&
        typeof (value as { ownerId?: unknown }).ownerId === "string"
          ? (value as { ownerId: string }).ownerId
          : null,
      code: "invalid_message",
      message
    });
  };

  const handleMessage = async (value: unknown): Promise<void> => {
    let claimedRequest:
      | { owner: OwnerContextRecord; requestId: string }
      | undefined;
    try {
      if (
        measureDesktopCollaborationBrokerMessageBytes(value) >
        DESKTOP_COLLABORATION_BROKER_MAX_MESSAGE_BYTES
      ) {
        throw new Error(
          "Desktop collaboration broker message exceeded its byte limit."
        );
      }
      const message =
        desktopCollaborationBrokerParentMessageSchema.parse(value);
      if (
        message.sessionToken !==
        environment.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN
      ) {
        rejectInvalidMessage(
          message,
          "Desktop collaboration broker session token is invalid."
        );
        return;
      }
      if (message.type === "release_owner") {
        releaseOwner(message.ownerId);
        sessionSend({
          protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionToken:
            environment.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN!,
          type: "owner_released",
          envelopeId: message.envelopeId,
          ownerId: message.ownerId
        });
        return;
      }
      if (message.type === "shutdown") {
        stopEnrollmentMonitors();
        transport.stop();
        for (const ownerId of [...ownerContexts.keys()]) {
          releaseOwner(ownerId);
        }
        await ownedUpstreamFetcher?.close();
        sessionSend({
          protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionToken:
            environment.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN!,
          type: "shutdown_ack",
          envelopeId: message.envelopeId
        });
        return;
      }
      const owner = ownerContext(message.ownerId);
      const command = collaborationRendererCommandSchema.parse(message.command);
      const claim = claimOwnerRequest(owner, command);
      if (claim.state === "conflict") {
        sendCommandResult(
          message.envelopeId,
          message.ownerId,
          commandFailure(command, collaborationSafeError("conflict"))
        );
        return;
      }
      if (claim.state === "cached") {
        sendCommandResult(message.envelopeId, message.ownerId, claim.result);
        return;
      }
      claimedRequest = { owner, requestId: command.requestId };
      const context: CollaborationTransportContext = {
        ownerId: message.ownerId,
        signal: owner.controller.signal,
        emitCollaborationEvent: (event) =>
          sendOwnerEvent(message.ownerId, event)
      };
      if (command.command === "collaboration.load") {
        await retryRevokedBackendDurableCleanup();
        await ensureBackendCapabilities();
      }
      let result =
        command.command === "collaboration.connect_backend" ||
        command.command === "collaboration.reconnect_backend" ||
        command.command === "collaboration.disconnect_backend"
          ? await runLifecycleExclusive(() =>
              handleLifecycleCommand(command, message.ownerId)
            )
          : command.command === "collaboration.send_message" ||
              command.command === "collaboration.retry_message"
            ? persistAndExecuteSend(command, context)
            : await transport.request(command, context);
      if (result.ok) {
        const resultData = result.data as {
          snapshot?: CollaborationSnapshot;
        };
        if (resultData.snapshot) {
          const projectedSnapshot = snapshotWithDurableSends(
            resultData.snapshot
          );
          result = collaborationCommandResultSchema.parse({
            ...result,
            data: { ...result.data, snapshot: projectedSnapshot }
          });
          owner.snapshot = projectedSnapshot;
        }
      }
      const shouldResumeInterruptedSends =
        result.ok &&
        result.command === "collaboration.load" &&
        !upstreamDisconnectCleanupPending(paths);
      if (
        result.ok &&
        result.command === "collaboration.request_action_grant" &&
        result.data.status.state === "pending" &&
        result.data.status.activationUrl
      ) {
        dependencies.onBrowserOpenRequest?.({
          ownerId: context.ownerId,
          url: result.data.status.activationUrl
        });
      }
      finishOwnerRequest(owner, command.requestId, result);
      claimedRequest = undefined;
      sendCommandResult(message.envelopeId, message.ownerId, result);
      const pendingSendStart = pendingSendStarts.get(command.requestId);
      if (pendingSendStart) {
        pendingSendStarts.delete(command.requestId);
        await executePendingSend(
          pendingSendStart.command,
          pendingSendStart.pending,
          pendingSendStart.context
        );
      }
      if (
        shouldResumeInterruptedSends &&
        result.ok &&
        result.command === "collaboration.load"
      ) {
        await resumeInterruptedSends(context, result.data.snapshot);
      }
    } catch (error) {
      if (claimedRequest) {
        failOwnerRequest(claimedRequest.owner, claimedRequest.requestId);
      }
      console.error(
        JSON.stringify({
          event: "desktop.collaboration.command.failed",
          errorName: error instanceof Error ? error.name : "UnknownError"
        })
      );
      rejectInvalidMessage(value);
    }
  };

  const sendReady = () => {
    sessionSend({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken:
        environment.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN!,
      type: "ready",
      brokerPid: process.pid
    });
  };

  scheduleDisconnectCleanupRetry();

  return {
    handleMessage,
    releaseOwner,
    shutdown: async () => {
      stopEnrollmentMonitors();
      clearCapabilityRefreshTimers();
      if (disconnectCleanupTimer) clearTimeout(disconnectCleanupTimer);
      disconnectCleanupTimer = null;
      transport.stop();
      for (const ownerId of [...ownerContexts.keys()]) {
        releaseOwner(ownerId);
      }
      await ownedUpstreamFetcher?.close();
    },
    sendReady
  };
};

export const runDesktopCollaborationBrokerProcess = (): Promise<void> => {
  const sessionToken =
    process.env.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN?.trim();
  if (!sessionToken) {
    throw new Error(
      "KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN is required."
    );
  }
  if (typeof process.send !== "function") {
    throw new Error(
      "Desktop collaboration broker requires an inherited Node IPC channel."
    );
  }
  const broker = createDesktopCollaborationBroker({
    sendMessage: (message) => {
      process.send?.(message);
    },
    onBrowserOpenRequest: ({ ownerId, url }) => {
      process.send?.(
        desktopCollaborationBrokerChildMessageSchema.parse({
          protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionToken,
          type: "open_external",
          envelopeId: randomUUID(),
          ownerId,
          url
        })
      );
    }
  });
  process.on("message", (value) => {
    void broker.handleMessage(value);
  });
  process.once("disconnect", () => {
    void broker.shutdown().finally(() => process.exit(0));
  });
  broker.sendReady();
  return Promise.resolve();
};
