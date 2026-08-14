import { randomUUID } from "node:crypto";
import {
  calculateCollaborationReconnectDelay as calculateSharedReconnectDelay,
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
  COLLABORATION_RECONNECT_MAX_ATTEMPTS,
  COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS,
  COLLABORATION_RECONNECT_WINDOW_MS,
  COLLABORATION_RENDERER_MAX_PENDING_BYTES,
  collaborationCommandReturnsSnapshot,
  collaborationCommandResultSchema,
  collaborationDeliveryIdSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  collaborationSubscriptionSchema,
  isTeamCollaborationSelection,
  readBoundedJsonObject,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSafeError,
  type CollaborationSelection,
  type CollaborationSnapshot,
  type CollaborationSubscription
} from "@koed/shared";

export const collaborationCommandPath = "/v1/local-edge/collaboration/command";
export const collaborationRealtimeSubscriptionsPath =
  "/v1/local-edge/collaboration/realtime/subscriptions";
export const collaborationRealtimeBackendSubscriptionsPath = (
  backendId: string
) =>
  `/v1/local-edge/collaboration/realtime/backends/${encodeURIComponent(backendId)}/subscriptions`;

const commandRequestMaxBytes = 128 * 1024;
const commandResponseMaxBytes = 32 * 1024 * 1024;
const commandTimeoutMs = 30_000;
const reconnectBaseMs = 250;
const reconnectJitterRatio = 0.2;

export interface CollaborationLocalConnection {
  apiUrl: string;
  backendId: string | null;
  authorization: string;
}

export interface CollaborationTransportContext {
  ownerId: string;
  signal: AbortSignal;
  emitCollaborationEvent: (event: CollaborationRendererEvent) => void;
}

export interface DesktopCollaborationBrokerLocalTransportOptions {
  fetch: typeof fetch;
  resolveConnection: (
    requiresTeamBackend: boolean,
    preferredBackendId?: string
  ) => Promise<CollaborationLocalConnection | null>;
  random?: () => number;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface ActiveSubscription {
  id: string;
  ownerId: string;
  scope: "personal" | "team";
  teamId: string | null;
  version: number;
  brokerVersion: number;
  initialDeliveryId: string | null;
  streamStarted: boolean;
  connection: CollaborationLocalConnection;
  controller: AbortController;
  emit: (event: CollaborationRendererEvent) => void;
  operationTail: Promise<void>;
}

interface BrokerSnapshotResponse {
  subscription: CollaborationSubscription;
  brokerVersion: number;
  deliveryId: string;
}

const commandRequiresTeamBackend = (
  command: CollaborationRendererCommand,
  existing: ActiveSubscription | undefined
): boolean => {
  if (existing) return existing.scope === "team";
  switch (command.command) {
    case "collaboration.load":
    case "collaboration.connect_backend":
    case "collaboration.reconnect_backend":
    case "collaboration.disconnect_backend":
    case "collaboration.create_notes_to_self":
    case "collaboration.create_personal_channel":
    case "collaboration.preview_shared_memory_candidate":
      return false;
    case "collaboration.select":
      return isTeamCollaborationSelection(command.input.selection);
    case "collaboration.rename_thread":
    case "collaboration.update_thread_topic":
    case "collaboration.archive_thread":
    case "collaboration.restore_thread":
    case "collaboration.send_message":
    case "collaboration.retry_message":
    case "collaboration.mark_read":
    case "collaboration.load_message_page":
      return command.input.thread.scope === "team";
    case "collaboration.subscribe":
      return command.input.scope.scope === "team";
    case "collaboration.unsubscribe":
    case "collaboration.acknowledge_delivery":
      return false;
    default:
      return true;
  }
};

const safeError = (
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

const failureResult = (
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

const retryAfterFrom = (response: Response): number | null => {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(300_000, Math.round(seconds * 1_000))
    : null;
};

const errorForStatus = (response: Response): CollaborationSafeError => {
  if (response.status === 400 || response.status === 422) {
    return safeError("invalid_input");
  }
  if (response.status === 401 || response.status === 403) {
    return safeError("permission_denied");
  }
  if (response.status === 404) return safeError("not_available");
  if (response.status === 409) return safeError("conflict");
  if (response.status === 410) return safeError("access_revoked");
  if (response.status === 429) {
    return safeError("rate_limited", retryAfterFrom(response));
  }
  if ([502, 503, 504].includes(response.status)) {
    return safeError("temporarily_unavailable", retryAfterFrom(response));
  }
  return safeError("internal_error");
};

const linkedAbortController = (
  signal: AbortSignal,
  timeoutMs?: number
): { controller: AbortController; dispose: () => void } => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer =
    timeoutMs === undefined
      ? null
      : setTimeout(() => controller.abort(), timeoutMs);
  timer?.unref?.();
  return {
    controller,
    dispose: () => {
      signal.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    }
  };
};

const defaultSleep = (delayMs: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });

export const calculateCollaborationReconnectDelay = (
  attempt: number,
  random: number
): number =>
  calculateSharedReconnectDelay({
    attempt: Math.max(0, attempt - 1),
    baseMs: reconnectBaseMs,
    maxMs: COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
    jitter: reconnectJitterRatio,
    random
  });

const parseCorrelatedResult = (
  payload: unknown,
  command: CollaborationRendererCommand
): CollaborationCommandResult | null => {
  const parsed = collaborationCommandResultSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.requestId !== command.requestId ||
    parsed.data.command !== command.command
  ) {
    return null;
  }
  return parsed.data;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const parseBrokerSubscription = (
  raw: unknown,
  expectedScope: ActiveSubscription["scope"],
  expectedTeamId: string | null
): { subscription: CollaborationSubscription; brokerVersion: number } => {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "id",
      "protocolVersion",
      "scope",
      "state",
      "version",
      "expiresAt"
    ]) ||
    raw.protocolVersion !== COLLABORATION_CONTRACT_VERSION ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 0 ||
    !isRecord(raw.scope)
  ) {
    throw new Error("Collaboration broker subscription is invalid");
  }
  const scope =
    expectedScope === "team"
      ? { scope: "team" as const, teamId: expectedTeamId }
      : { scope: "personal" as const };
  if (
    (expectedScope === "personal" &&
      (!hasExactKeys(raw.scope, ["scope"]) ||
        raw.scope.scope !== "personal")) ||
    (expectedScope === "team" &&
      (!hasExactKeys(raw.scope, ["scope", "teamId"]) ||
        raw.scope.scope !== "team" ||
        raw.scope.teamId !== expectedTeamId))
  ) {
    throw new Error("Collaboration broker subscription binding is invalid");
  }
  const brokerVersion = Number(raw.version);
  return {
    brokerVersion,
    subscription: collaborationSubscriptionSchema.parse({
      id: raw.id,
      scope,
      state: raw.state,
      version: Math.max(1, brokerVersion),
      expiresAt: raw.expiresAt
    })
  };
};

const parseBrokerSnapshotResponse = (
  raw: unknown,
  scope: ActiveSubscription["scope"],
  teamId: string | null
): BrokerSnapshotResponse => {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["protocolVersion", "subscription", "delivery"]) ||
    raw.protocolVersion !== COLLABORATION_CONTRACT_VERSION ||
    !isRecord(raw.delivery) ||
    !hasExactKeys(raw.delivery, [
      "deliveryId",
      "eventId",
      "type",
      "snapshot"
    ]) ||
    raw.delivery.type !== "snapshot" ||
    raw.delivery.eventId !== null ||
    !isRecord(raw.delivery.snapshot) ||
    !Array.isArray(raw.delivery.snapshot.threads) ||
    raw.delivery.snapshot.threads.length > 5_000
  ) {
    throw new Error("Collaboration broker snapshot response is invalid");
  }
  const snapshot = raw.delivery.snapshot;
  const threads = snapshot.threads as unknown[];
  const snapshotMatches =
    scope === "team"
      ? hasExactKeys(snapshot, ["scope", "teamId", "threads"]) &&
        snapshot.scope === "team" &&
        snapshot.teamId === teamId &&
        threads.every(
          (thread) =>
            isRecord(thread) &&
            thread.scope === "team" &&
            thread.teamId === teamId
        )
      : hasExactKeys(snapshot, [
          "scope",
          "personalOwnerUserId",
          "highWaterCursor",
          "threads"
        ]) &&
        snapshot.scope === "personal" &&
        typeof snapshot.personalOwnerUserId === "string" &&
        Number.isSafeInteger(snapshot.highWaterCursor) &&
        Number(snapshot.highWaterCursor) >= 0 &&
        threads.every(
          (thread) => isRecord(thread) && thread.scope === "personal"
        );
  if (!snapshotMatches) {
    throw new Error("Collaboration broker snapshot binding is invalid");
  }
  const parsed = parseBrokerSubscription(raw.subscription, scope, teamId);
  if (parsed.subscription.state !== "awaiting_snapshot_ack") {
    throw new Error("Collaboration broker snapshot is not awaiting ack");
  }
  return {
    ...parsed,
    deliveryId: collaborationDeliveryIdSchema.parse(raw.delivery.deliveryId)
  };
};

const parseBrokerAckResponse = (
  raw: unknown,
  subscription: ActiveSubscription
): { subscription: CollaborationSubscription; brokerVersion: number } => {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["protocolVersion", "subscription"]) ||
    raw.protocolVersion !== COLLABORATION_CONTRACT_VERSION
  ) {
    throw new Error("Collaboration broker acknowledgement is invalid");
  }
  const parsed = parseBrokerSubscription(
    raw.subscription,
    subscription.scope,
    subscription.teamId
  );
  if (
    parsed.subscription.id !== subscription.id ||
    parsed.subscription.state !== "active"
  ) {
    throw new Error("Collaboration broker acknowledgement binding is invalid");
  }
  return parsed;
};

const readSse = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (
    eventName: string,
    payload: unknown
  ) => Promise<"continue" | "terminal">
): Promise<"ended" | "terminal"> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeFrame = async (
    frame: string
  ): Promise<"continue" | "terminal"> => {
    if (
      Buffer.byteLength(frame, "utf8") >
      COLLABORATION_RENDERER_MAX_PENDING_BYTES
    ) {
      throw new Error("Collaboration stream frame exceeded its byte limit");
    }
    const lines = frame.split("\n");
    if (lines.every((line) => line === "" || line.startsWith(":"))) {
      return "continue";
    }
    const eventName =
      lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim() ?? "message";
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) throw new Error("Collaboration stream frame has no payload");
    const parsedJson: unknown = JSON.parse(data);
    return onFrame(eventName, parsedJson);
  };

  try {
    for (;;) {
      if (signal.aborted) return "terminal";
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder
        .decode(chunk.value, { stream: true })
        .replace(/\r\n/g, "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if ((await consumeFrame(frame)) === "terminal") return "terminal";
      }
      if (
        Buffer.byteLength(buffer, "utf8") >
        COLLABORATION_RENDERER_MAX_PENDING_BYTES
      ) {
        throw new Error("Collaboration stream frame exceeded its byte limit");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && (await consumeFrame(buffer)) === "terminal") {
      return "terminal";
    }
    return "ended";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const createDesktopCollaborationBrokerLocalTransport = (
  options: DesktopCollaborationBrokerLocalTransportOptions
) => {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const subscriptions = new Map<string, ActiveSubscription>();
  const latestTeamSelections = new Map<
    string,
    Map<string, CollaborationSelection>
  >();
  const activeTeamIds = new Map<string, string | null>();
  const snapshotRequestGenerations = new Map<string, number>();
  const authorityGenerations = new Map<string, number>();
  let preferredBackendId: string | undefined;

  const authorityGeneration = (ownerId: string): number =>
    authorityGenerations.get(ownerId) ?? 0;

  const commandAffectsActiveSelection = (
    command: CollaborationRendererCommand
  ): boolean =>
    collaborationCommandReturnsSnapshot(command.command) &&
    !(
      command.command === "collaboration.select" &&
      command.input.navigationIntent === "prewarm"
    );

  const invalidateAuthority = (
    ownerId: string,
    teamId?: string | null
  ): void => {
    authorityGenerations.set(ownerId, authorityGeneration(ownerId) + 1);
    if (teamId) {
      const selections = latestTeamSelections.get(ownerId);
      selections?.delete(teamId);
      if (selections?.size === 0) latestTeamSelections.delete(ownerId);
    } else {
      latestTeamSelections.delete(ownerId);
    }
  };

  const rememberTeamSelection = (
    ownerId: string,
    selection: CollaborationSelection
  ): void => {
    if (!("teamId" in selection)) return;
    const selections =
      latestTeamSelections.get(ownerId) ??
      new Map<string, CollaborationSelection>();
    selections.set(selection.teamId, selection);
    latestTeamSelections.set(ownerId, selections);
  };

  const eventInvalidatesSelection = (
    event: CollaborationRendererEvent
  ): boolean =>
    (event.type === "connection" &&
      (event.connection.state === "disconnected" ||
        event.connection.state === "access_revoked")) ||
    (event.type === "control" && event.reason === "access_revoked") ||
    (event.type === "update" && event.family === "access_revoked");

  const emit = (
    subscription: ActiveSubscription,
    event: CollaborationRendererEvent
  ) => {
    const parsed = collaborationRendererEventSchema.parse(event);
    const matchesSubscription =
      (parsed.type === "snapshot" &&
        parsed.subscription.id === subscription.id &&
        parsed.subscription.scope.scope === subscription.scope &&
        (subscription.scope !== "team" ||
          (parsed.subscription.scope.scope === "team" &&
            parsed.subscription.scope.teamId === subscription.teamId))) ||
      (parsed.type === "update" &&
        parsed.subscriptionId === subscription.id &&
        (subscription.scope !== "team" ||
          parsed.resource.teamId === subscription.teamId)) ||
      (parsed.type === "control" &&
        parsed.subscriptionId === subscription.id) ||
      (parsed.type === "connection" &&
        subscription.scope === "team" &&
        parsed.connection.backendId === subscription.connection.backendId);
    if (!matchesSubscription) {
      throw new Error("Collaboration stream event binding is invalid");
    }
    if (eventInvalidatesSelection(parsed)) {
      invalidateAuthority(subscription.ownerId, subscription.teamId);
    }
    if (
      parsed.type === "connection" &&
      parsed.connection.state !== "access_revoked" &&
      activeTeamIds.get(subscription.ownerId) !== subscription.teamId
    ) {
      return;
    }
    subscription.emit(parsed);
  };

  const emitConnection = (
    subscription: ActiveSubscription,
    state:
      | "connecting"
      | "live"
      | "reconnecting"
      | "unavailable"
      | "access_revoked",
    reconnectAttempt: number,
    retryAt: string | null,
    error: CollaborationSafeError | null
  ) => {
    if (subscription.scope === "personal") return;
    emit(subscription, {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        state,
        backendId: subscription.connection.backendId,
        connectedAt: state === "live" ? new Date(now()).toISOString() : null,
        retryAt,
        reconnectAttempt,
        protocolVersion: COLLABORATION_CONTRACT_VERSION
      },
      error
    });
  };

  const emitTerminalControl = (
    subscription: ActiveSubscription,
    reason: "access_revoked" | "requires_snapshot" | "backpressure"
  ) => {
    emit(subscription, {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: subscription.id,
      occurredAt: new Date(now()).toISOString(),
      reason
    });
  };

  const parseBrokerStreamFrame = (
    subscription: ActiveSubscription,
    eventName: string,
    payload: unknown
  ): "continue" | "terminal" => {
    const sharedEvent = collaborationRendererEventSchema.safeParse(payload);
    if (sharedEvent.success) {
      if (
        sharedEvent.data.type === "connection" &&
        subscription.scope === "personal"
      ) {
        return "continue";
      }
      emit(subscription, sharedEvent.data);
      return sharedEvent.data.type === "control" ? "terminal" : "continue";
    }
    if (
      !isRecord(payload) ||
      payload.protocolVersion !== COLLABORATION_CONTRACT_VERSION
    ) {
      throw new Error("Collaboration broker frame is invalid");
    }
    if (eventName === "ready") {
      if (
        !hasExactKeys(payload, ["protocolVersion", "subscription"]) ||
        !isRecord(payload.subscription) ||
        !hasExactKeys(payload.subscription, ["id", "state", "version"]) ||
        payload.subscription.id !== subscription.id ||
        payload.subscription.state !== "active" ||
        !Number.isSafeInteger(payload.subscription.version) ||
        Number(payload.subscription.version) !== subscription.brokerVersion
      ) {
        throw new Error("Collaboration broker ready frame is invalid");
      }
      return "continue";
    }
    if (eventName === "heartbeat") {
      if (
        !hasExactKeys(payload, ["protocolVersion", "subscription"]) ||
        !isRecord(payload.subscription) ||
        !hasExactKeys(payload.subscription, ["id"]) ||
        payload.subscription.id !== subscription.id
      ) {
        throw new Error("Collaboration broker heartbeat frame is invalid");
      }
      return "continue";
    }
    if (eventName === "control" || eventName === "access_revoked") {
      if (
        !hasExactKeys(payload, ["protocolVersion", "subscription", "reason"]) ||
        !isRecord(payload.subscription) ||
        !hasExactKeys(payload.subscription, ["id"]) ||
        payload.subscription.id !== subscription.id ||
        ![
          "access_revoked",
          "requires_snapshot",
          "backpressure",
          "server_shutdown"
        ].includes(String(payload.reason))
      ) {
        throw new Error("Collaboration broker control frame is invalid");
      }
      const reason =
        eventName === "access_revoked"
          ? "access_revoked"
          : (payload.reason as
              | "access_revoked"
              | "requires_snapshot"
              | "backpressure"
              | "server_shutdown");
      emit(subscription, {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        type: "control",
        subscriptionId: subscription.id,
        occurredAt: new Date(now()).toISOString(),
        reason
      });
      return "terminal";
    }
    if (eventName === "collaboration_event") {
      if (
        !hasExactKeys(payload, [
          "protocolVersion",
          "deliveryId",
          "eventId",
          "type",
          "occurredAt",
          "subscription",
          "resource",
          "actor"
        ]) ||
        !isRecord(payload.subscription) ||
        !hasExactKeys(payload.subscription, ["id"]) ||
        payload.subscription.id !== subscription.id ||
        !isRecord(payload.resource) ||
        payload.resource.scope !== subscription.scope ||
        (subscription.scope === "team" &&
          payload.resource.teamId !== subscription.teamId) ||
        !isRecord(payload.actor)
      ) {
        throw new Error("Collaboration broker event frame is invalid");
      }
      collaborationDeliveryIdSchema.parse(payload.deliveryId);
      // The broker envelope intentionally carries identifiers only. Applying it
      // as a renderer update would invent protected DTO data, so stop closed.
      emitTerminalControl(subscription, "requires_snapshot");
      return "terminal";
    }
    throw new Error("Collaboration broker event type is unsupported");
  };

  const runStream = async (subscription: ActiveSubscription) => {
    const attempts: number[] = [];
    let reconnecting = false;
    emitConnection(subscription, "connecting", 0, null, null);
    while (!subscription.controller.signal.aborted) {
      try {
        if (reconnecting) {
          const backendId = subscription.connection.backendId;
          const refreshedConnection = await options
            .resolveConnection(
              subscription.scope === "team",
              backendId ?? undefined
            )
            .catch(() => null);
          if (
            !refreshedConnection ||
            refreshedConnection.backendId !== backendId
          ) {
            throw new Error("Collaboration stream connection is unavailable");
          }
          subscription.connection = refreshedConnection;
        }
        const url = new URL(
          `${collaborationRealtimeSubscriptionsPath}/${encodeURIComponent(subscription.id)}/stream`,
          subscription.connection.apiUrl
        );
        if (subscription.connection.backendId) {
          url.searchParams.set("scope", "team");
          url.searchParams.set(
            "upstream_backend_id",
            subscription.connection.backendId
          );
        }
        if (subscription.teamId)
          url.searchParams.set("team_id", subscription.teamId);
        else url.searchParams.set("scope", "personal");
        const response = await options.fetch(url, {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            authorization: subscription.connection.authorization
          },
          redirect: "error",
          signal: subscription.controller.signal
        });
        if (
          !response.ok ||
          !response.body ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream")
        ) {
          await response.body?.cancel().catch(() => undefined);
          if ([401, 403, 410].includes(response.status)) {
            emitConnection(
              subscription,
              "access_revoked",
              0,
              null,
              safeError("access_revoked")
            );
            return;
          }
          if (response.status === 409) {
            emitTerminalControl(subscription, "requires_snapshot");
            return;
          }
          throw new Error("Collaboration stream is unavailable");
        }
        emitConnection(subscription, "live", 0, null, null);
        const outcome = await readSse(
          response.body,
          subscription.controller.signal,
          (eventName, payload) =>
            Promise.resolve(
              parseBrokerStreamFrame(subscription, eventName, payload)
            )
        );
        if (outcome === "terminal") return;
      } catch {
        if (subscription.controller.signal.aborted) return;
      }
      reconnecting = true;

      const attemptNow = now();
      while (
        attempts.length > 0 &&
        attemptNow - attempts[0]! >= COLLABORATION_RECONNECT_WINDOW_MS
      ) {
        attempts.shift();
      }
      if (attempts.length >= COLLABORATION_RECONNECT_MAX_ATTEMPTS) {
        const retryAtMs =
          attemptNow + COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS;
        emitConnection(
          subscription,
          "unavailable",
          COLLABORATION_RECONNECT_MAX_ATTEMPTS,
          new Date(retryAtMs).toISOString(),
          safeError(
            "temporarily_unavailable",
            COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS
          )
        );
        await sleep(
          COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS,
          subscription.controller.signal
        );
        attempts.length = 0;
        continue;
      }
      attempts.push(attemptNow);
      const attempt = attempts.length;
      const delay = calculateCollaborationReconnectDelay(attempt, random());
      emitConnection(
        subscription,
        "reconnecting",
        attempt,
        new Date(attemptNow + delay).toISOString(),
        safeError("temporarily_unavailable", delay)
      );
      await sleep(delay, subscription.controller.signal);
    }
  };

  const stopSubscription = (subscriptionId: string) => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return;
    subscription.controller.abort();
    subscriptions.delete(subscriptionId);
  };

  const serializeSubscriptionOperation = <Result>(
    subscription: ActiveSubscription,
    operation: () => Promise<Result>
  ): Promise<Result> => {
    const result = subscription.operationTail.then(operation, operation);
    subscription.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const realtimeBinding = (subscription: ActiveSubscription) =>
    subscription.scope === "team"
      ? {
          scope: "team" as const,
          upstream_backend_id: subscription.connection.backendId,
          team_id: subscription.teamId
        }
      : { scope: "personal" as const };

  const acknowledgeDelivery = async (
    command: Extract<
      CollaborationRendererCommand,
      { command: "collaboration.acknowledge_delivery" }
    >,
    subscription: ActiveSubscription,
    context: CollaborationTransportContext
  ): Promise<CollaborationCommandResult> => {
    if (
      subscription.scope === "team" &&
      (!subscription.connection.backendId || !subscription.teamId)
    ) {
      return failureResult(command, safeError("not_available"));
    }
    if (command.input.expectedSubscriptionVersion !== subscription.version) {
      emitTerminalControl(subscription, "requires_snapshot");
      stopSubscription(subscription.id);
      return failureResult(command, safeError("conflict"));
    }
    const linked = linkedAbortController(context.signal, commandTimeoutMs);
    try {
      const response = await options.fetch(
        new URL(
          `${collaborationRealtimeSubscriptionsPath}/${encodeURIComponent(subscription.id)}/ack`,
          subscription.connection.apiUrl
        ),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: subscription.connection.authorization,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            ...realtimeBinding(subscription),
            delivery_id: command.input.deliveryId,
            event_id: command.input.eventId,
            expected_version: subscription.brokerVersion
          }),
          redirect: "error",
          signal: linked.controller.signal
        }
      );
      const payload = await readBoundedJsonObject(response, 1024 * 1024).catch(
        () => null
      );
      if (!response.ok) {
        if ([401, 403, 410].includes(response.status)) {
          emitTerminalControl(subscription, "access_revoked");
          stopSubscription(subscription.id);
          return failureResult(command, safeError("access_revoked"));
        }
        if (response.status === 409) {
          emitTerminalControl(subscription, "requires_snapshot");
          stopSubscription(subscription.id);
          return failureResult(command, safeError("conflict"));
        }
        return failureResult(command, errorForStatus(response));
      }
      const acknowledged = parseBrokerAckResponse(payload, subscription);
      subscription.brokerVersion = acknowledged.brokerVersion;
      subscription.version = acknowledged.subscription.version;
      const startsStream =
        subscription.initialDeliveryId === command.input.deliveryId;
      if (startsStream) subscription.initialDeliveryId = null;
      if (startsStream && !subscription.streamStarted) {
        subscription.streamStarted = true;
        void runStream(subscription).finally(() => {
          if (subscriptions.get(subscription.id) === subscription) {
            subscriptions.delete(subscription.id);
          }
        });
      }
      return collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: {
          subscriptionId: subscription.id,
          acknowledgedEventId: command.input.eventId,
          subscriptionVersion: subscription.version
        }
      });
    } catch {
      return failureResult(command, safeError("offline"));
    } finally {
      linked.dispose();
    }
  };

  const unsubscribe = async (
    command: Extract<
      CollaborationRendererCommand,
      { command: "collaboration.unsubscribe" }
    >,
    subscription: ActiveSubscription,
    context: CollaborationTransportContext
  ): Promise<CollaborationCommandResult> => {
    if (
      subscription.scope === "team" &&
      (!subscription.connection.backendId || !subscription.teamId)
    ) {
      return failureResult(command, safeError("not_available"));
    }
    // This is an intentional stream shutdown. Abort locally before the
    // server-side delete can close the SSE response, otherwise runStream may
    // briefly classify that closure as a transport failure and emit a false
    // reconnecting state.
    subscription.controller.abort();
    const linked = linkedAbortController(context.signal, commandTimeoutMs);
    try {
      const response = await options.fetch(
        new URL(
          `${collaborationRealtimeSubscriptionsPath}/${encodeURIComponent(subscription.id)}`,
          subscription.connection.apiUrl
        ),
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            authorization: subscription.connection.authorization,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            ...realtimeBinding(subscription),
            expected_version: subscription.version
          }),
          redirect: "error",
          signal: linked.controller.signal
        }
      );
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        if ([401, 403, 409, 410].includes(response.status)) {
          emitTerminalControl(subscription, "access_revoked");
          stopSubscription(subscription.id);
          return failureResult(command, safeError("access_revoked"));
        }
        return failureResult(command, errorForStatus(response));
      }
      stopSubscription(subscription.id);
      return collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: {}
      });
    } catch {
      return failureResult(command, safeError("offline"));
    } finally {
      linked.dispose();
      stopSubscription(subscription.id);
    }
  };

  const fetchAuthorizedResnapshot = async (
    scope: ActiveSubscription["scope"],
    teamId: string | null,
    connection: CollaborationLocalConnection,
    context: CollaborationTransportContext
  ): Promise<CollaborationSnapshot | null> => {
    const latestSelection = teamId
      ? latestTeamSelections.get(context.ownerId)?.get(teamId)
      : undefined;
    let selection: CollaborationSelection | null = null;
    if (scope === "team") {
      if (
        !latestSelection ||
        teamId === null ||
        !("teamId" in latestSelection) ||
        latestSelection.teamId !== teamId
      ) {
        return null;
      }
      selection = latestSelection;
    }
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: scope === "team" ? "collaboration.select" : "collaboration.load",
      input: scope === "team" ? { selection } : {}
    });
    const body = JSON.stringify({
      ...(scope === "team"
        ? { upstream_backend_id: connection.backendId }
        : {}),
      command
    });
    const linked = linkedAbortController(context.signal, commandTimeoutMs);
    try {
      const response = await options.fetch(
        new URL(collaborationCommandPath, connection.apiUrl),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: connection.authorization,
            "content-type": "application/json"
          },
          body,
          redirect: "error",
          signal: linked.controller.signal
        }
      );
      const payload = await readBoundedJsonObject(
        response,
        commandResponseMaxBytes
      ).catch(() => null);
      const result = parseCorrelatedResult(payload, command);
      if (!response.ok || !result?.ok || !("snapshot" in result.data)) {
        return null;
      }
      return collaborationSnapshotSchema.parse(result.data.snapshot);
    } catch {
      return null;
    } finally {
      linked.dispose();
    }
  };

  const realtimeSnapshotFrom = (
    scope: ActiveSubscription["scope"],
    teamId: string | null,
    full: CollaborationSnapshot
  ): Extract<CollaborationRendererEvent, { type: "snapshot" }>["snapshot"] => {
    if (scope === "personal") {
      const personalSelection = !("teamId" in full.selection);
      const notes = full.navigation.personal.notesToSelf;
      return {
        scope: "personal",
        snapshotRevision: full.snapshotRevision,
        personalOwner: full.navigation.personalOwner,
        personal: full.navigation.personal,
        selection: personalSelection
          ? full.selection
          : { kind: "notes_to_self" },
        view: personalSelection
          ? full.view
          : {
              kind: "thread",
              thread: notes,
              messages: {
                snapshotRevision: full.snapshotRevision,
                threadId: notes.id,
                items: [],
                olderCursor: null,
                newerCursor: null,
                hasOlder: false,
                hasNewer: false
              }
            }
      };
    }
    const team = full.navigation.teams.find((item) => item.id === teamId);
    if (
      !team ||
      !full.navigation.teamPrincipal ||
      !("teamId" in full.selection) ||
      full.selection.teamId !== teamId
    ) {
      throw new Error("Authorized Team resnapshot binding is invalid");
    }
    return {
      scope: "team",
      teamId: team.id,
      snapshotRevision: full.snapshotRevision,
      teamPrincipal: full.navigation.teamPrincipal,
      team,
      selection: full.selection,
      view: full.view
    };
  };

  const subscribeRealtime = async (
    command: Extract<
      CollaborationRendererCommand,
      { command: "collaboration.subscribe" }
    >,
    connection: CollaborationLocalConnection,
    context: CollaborationTransportContext,
    expectedAuthorityGeneration: number
  ): Promise<CollaborationCommandResult> => {
    const scope = command.input.scope.scope;
    const teamId =
      command.input.scope.scope === "team" ? command.input.scope.teamId : null;
    if (scope === "team" && !connection.backendId) {
      return failureResult(command, safeError("not_available"));
    }
    const binding =
      scope === "team"
        ? {
            scope: "team" as const,
            upstream_backend_id: connection.backendId,
            team_id: teamId
          }
        : { scope: "personal" as const };
    const linked = linkedAbortController(context.signal, commandTimeoutMs);
    try {
      const response = await options.fetch(
        new URL(collaborationRealtimeSubscriptionsPath, connection.apiUrl),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: connection.authorization,
            "content-type": "application/json"
          },
          body: JSON.stringify(binding),
          redirect: "error",
          signal: linked.controller.signal
        }
      );
      const payload = await readBoundedJsonObject(
        response,
        commandResponseMaxBytes
      ).catch(() => null);
      if (
        authorityGeneration(context.ownerId) !== expectedAuthorityGeneration
      ) {
        return failureResult(command, safeError("access_revoked"));
      }
      if (!response.ok) {
        return failureResult(
          command,
          [401, 403, 409, 410].includes(response.status)
            ? safeError("access_revoked")
            : errorForStatus(response)
        );
      }
      const broker = parseBrokerSnapshotResponse(payload, scope, teamId);
      const full = await fetchAuthorizedResnapshot(
        scope,
        teamId,
        connection,
        context
      );
      if (
        authorityGeneration(context.ownerId) !== expectedAuthorityGeneration
      ) {
        return failureResult(command, safeError("access_revoked"));
      }
      if (!full) return failureResult(command, safeError("internal_error"));
      const event = collaborationRendererEventSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        type: "snapshot",
        subscription: broker.subscription,
        deliveryId: broker.deliveryId,
        eventId: null,
        snapshot: realtimeSnapshotFrom(scope, teamId, full)
      });
      stopSubscription(broker.subscription.id);
      const active: ActiveSubscription = {
        id: broker.subscription.id,
        ownerId: context.ownerId,
        scope,
        teamId,
        version: broker.subscription.version,
        brokerVersion: broker.brokerVersion,
        initialDeliveryId: broker.deliveryId,
        streamStarted: false,
        connection,
        controller: new AbortController(),
        emit: context.emitCollaborationEvent,
        operationTail: Promise.resolve()
      };
      subscriptions.set(active.id, active);
      const abortForOwner = () => stopSubscription(active.id);
      context.signal.addEventListener("abort", abortForOwner, { once: true });
      setTimeout(() => {
        if (
          subscriptions.get(active.id) !== active ||
          active.controller.signal.aborted
        ) {
          return;
        }
        try {
          emit(active, event);
        } catch {
          stopSubscription(active.id);
        }
      }, 0);
      return collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: { subscription: broker.subscription }
      });
    } catch {
      return failureResult(command, safeError("internal_error"));
    } finally {
      linked.dispose();
    }
  };

  const request = async (
    command: CollaborationRendererCommand,
    context: CollaborationTransportContext
  ): Promise<CollaborationCommandResult> => {
    const snapshotRequestGeneration = commandAffectsActiveSelection(command)
      ? (snapshotRequestGenerations.get(context.ownerId) ?? 0) + 1
      : null;
    if (snapshotRequestGeneration !== null) {
      snapshotRequestGenerations.set(
        context.ownerId,
        snapshotRequestGeneration
      );
    }
    const requestAuthorityGeneration = authorityGeneration(context.ownerId);
    const existing =
      "subscriptionId" in command.input
        ? subscriptions.get(command.input.subscriptionId)
        : undefined;
    if (existing && existing.ownerId !== context.ownerId) {
      return failureResult(command, safeError("not_available"));
    }
    const connection =
      existing?.connection ??
      (await options
        .resolveConnection(
          commandRequiresTeamBackend(command, existing),
          preferredBackendId
        )
        .catch(() => null));
    if (!connection) return failureResult(command, safeError("offline"));
    const requiresTeamBackend = commandRequiresTeamBackend(command, existing);
    if (requiresTeamBackend && !connection.backendId) {
      return failureResult(command, safeError("offline"));
    }
    if (command.command === "collaboration.acknowledge_delivery") {
      return existing
        ? serializeSubscriptionOperation(existing, () =>
            acknowledgeDelivery(command, existing, context)
          )
        : failureResult(command, safeError("not_available"));
    }
    if (command.command === "collaboration.unsubscribe") {
      existing?.controller.abort();
      return existing
        ? serializeSubscriptionOperation(existing, () =>
            unsubscribe(command, existing, context)
          )
        : failureResult(command, safeError("not_available"));
    }
    if (command.command === "collaboration.subscribe") {
      return subscribeRealtime(
        command,
        connection,
        context,
        requestAuthorityGeneration
      );
    }

    const body = JSON.stringify({
      ...(requiresTeamBackend
        ? { upstream_backend_id: connection.backendId }
        : {}),
      command
    });
    if (Buffer.byteLength(body, "utf8") > commandRequestMaxBytes) {
      return failureResult(command, safeError("invalid_input"));
    }

    const linked = linkedAbortController(context.signal, commandTimeoutMs);
    try {
      const response = await options.fetch(
        new URL(collaborationCommandPath, connection.apiUrl),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: connection.authorization,
            "content-type": "application/json"
          },
          body,
          redirect: "error",
          signal: linked.controller.signal
        }
      );
      const payload = await readBoundedJsonObject(
        response,
        commandResponseMaxBytes
      ).catch(() => null);
      const result = parseCorrelatedResult(payload, command);
      if (!result) {
        return failureResult(
          command,
          response.ok ? safeError("internal_error") : errorForStatus(response)
        );
      }

      if (authorityGeneration(context.ownerId) !== requestAuthorityGeneration) {
        return failureResult(command, safeError("access_revoked"));
      }

      if (result.ok && result.command === "collaboration.connect_backend") {
        preferredBackendId = result.data.backend.id;
      }
      if (result.ok && result.command === "collaboration.disconnect_backend") {
        invalidateAuthority(context.ownerId);
      }
      if (
        result.ok &&
        "snapshot" in result.data &&
        snapshotRequestGeneration !== null &&
        snapshotRequestGenerations.get(context.ownerId) ===
          snapshotRequestGeneration
      ) {
        const parsedSnapshot = collaborationSnapshotSchema.parse(
          result.data.snapshot
        );
        rememberTeamSelection(context.ownerId, parsedSnapshot.selection);
        activeTeamIds.set(
          context.ownerId,
          "teamId" in parsedSnapshot.selection
            ? parsedSnapshot.selection.teamId
            : null
        );
      }
      return result;
    } catch {
      return failureResult(command, safeError("offline"));
    } finally {
      linked.dispose();
    }
  };

  const stopOwner = (ownerId: string) => {
    for (const subscription of [...subscriptions.values()]) {
      if (subscription.ownerId === ownerId) stopSubscription(subscription.id);
    }
    latestTeamSelections.delete(ownerId);
    activeTeamIds.delete(ownerId);
    snapshotRequestGenerations.delete(ownerId);
    authorityGenerations.delete(ownerId);
  };

  const stop = () => {
    for (const subscription of [...subscriptions.values()]) {
      stopSubscription(subscription.id);
    }
    latestTeamSelections.clear();
    activeTeamIds.clear();
    snapshotRequestGenerations.clear();
    authorityGenerations.clear();
  };

  const revokeBackendSubscriptions = async (
    backendId: string
  ): Promise<boolean> => {
    const connection = await options.resolveConnection(false).catch(() => null);
    if (!connection) return false;
    const linked = linkedAbortController(
      new AbortController().signal,
      commandTimeoutMs
    );
    try {
      const response = await options.fetch(
        new URL(
          collaborationRealtimeBackendSubscriptionsPath(backendId),
          connection.apiUrl
        ),
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            authorization: connection.authorization
          },
          redirect: "error",
          signal: linked.controller.signal
        }
      );
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    } finally {
      linked.dispose();
    }
  };

  return { request, revokeBackendSubscriptions, stop, stopOwner };
};

export const createCollaborationLocalTransport =
  createDesktopCollaborationBrokerLocalTransport;

export type DesktopCollaborationBrokerLocalTransport = ReturnType<
  typeof createDesktopCollaborationBrokerLocalTransport
>;
