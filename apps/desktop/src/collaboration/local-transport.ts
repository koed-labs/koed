import { randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationConnectionEventSchema,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSafeError
} from "@koed/shared";
import {
  DESKTOP_COLLABORATION_BROKER_COMMAND_TIMEOUT_MS,
  DESKTOP_COLLABORATION_BROKER_HANDSHAKE_TIMEOUT_MS,
  DESKTOP_COLLABORATION_BROKER_MAX_MESSAGE_BYTES,
  DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
  DESKTOP_COLLABORATION_BROKER_SHUTDOWN_TIMEOUT_MS,
  desktopCollaborationBrokerChildMessageSchema,
  desktopCollaborationBrokerParentMessageSchema,
  measureDesktopCollaborationBrokerMessageBytes
} from "@koed/koed-server";

export interface CollaborationTransportContext {
  ownerId: string;
  signal: AbortSignal;
  emitCollaborationEvent: (event: CollaborationRendererEvent) => void;
}

type ChildProcessWithIpc = ChildProcess & {
  connected?: boolean;
  send: (message: unknown) => boolean;
};

interface CollaborationBrokerChild {
  child: ChildProcessWithIpc;
  sessionToken: string;
  ready: Promise<void>;
}

export interface CollaborationLocalTransportOptions {
  spawnBroker: (sessionToken: string) => ChildProcessWithIpc;
  openExternal: (url: string) => Promise<unknown>;
  commandTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  randomUuid?: () => string;
}

interface PendingCommand {
  ownerId: string;
  command: CollaborationRendererCommand;
  resolve: (result: CollaborationCommandResult) => void;
  timer: NodeJS.Timeout;
}

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
): CollaborationCommandResult => ({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  requestId: command.requestId,
  command: command.command,
  ok: false,
  error
});

export const createCollaborationLocalTransport = (
  options: CollaborationLocalTransportOptions
) => {
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DESKTOP_COLLABORATION_BROKER_COMMAND_TIMEOUT_MS;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ??
    DESKTOP_COLLABORATION_BROKER_HANDSHAKE_TIMEOUT_MS;
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ??
    DESKTOP_COLLABORATION_BROKER_SHUTDOWN_TIMEOUT_MS;
  const createEnvelopeId = options.randomUuid ?? randomUUID;
  const ownerEmitters = new Map<
    string,
    CollaborationTransportContext["emitCollaborationEvent"]
  >();
  const ownerReleaseSignals = new Map<
    string,
    { signal: AbortSignal; release: () => void }
  >();
  const pending = new Map<string, PendingCommand>();
  let broker: CollaborationBrokerChild | null = null;

  const emitDisconnectedToOwners = () => {
    const event = collaborationConnectionEventSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        state: "disconnected",
        backendId: null,
        connectedAt: null,
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion: COLLABORATION_CONTRACT_VERSION
      },
      error: null
    });
    for (const emit of ownerEmitters.values()) {
      emit(event);
    }
  };

  const failPending = (error: CollaborationSafeError) => {
    for (const [envelopeId, item] of pending) {
      clearTimeout(item.timer);
      item.resolve(failureResult(item.command, error));
      pending.delete(envelopeId);
    }
  };

  const releaseOwnerSignal = (ownerId: string) => {
    const current = ownerReleaseSignals.get(ownerId);
    if (!current) return;
    current.signal.removeEventListener("abort", current.release);
    ownerReleaseSignals.delete(ownerId);
  };

  const handleBrokerFailure = (error: CollaborationSafeError) => {
    failPending(error);
    emitDisconnectedToOwners();
    broker = null;
  };

  const sendToBroker = (value: unknown) => {
    if (!broker) {
      throw new Error("Desktop collaboration broker is not running.");
    }
    const parsed = desktopCollaborationBrokerParentMessageSchema.parse(value);
    if (
      measureDesktopCollaborationBrokerMessageBytes(parsed) >
      DESKTOP_COLLABORATION_BROKER_MAX_MESSAGE_BYTES
    ) {
      throw new Error(
        "Desktop collaboration broker message exceeded its byte limit."
      );
    }
    broker.child.send(parsed);
  };

  const restartBroker = (error: CollaborationSafeError) => {
    const current = broker;
    broker = null;
    if (current && !current.child.killed) {
      current.child.kill("SIGTERM");
    }
    handleBrokerFailure(error);
  };

  const handleBrokerMessage = async (sessionToken: string, value: unknown) => {
    if (
      measureDesktopCollaborationBrokerMessageBytes(value) >
      DESKTOP_COLLABORATION_BROKER_MAX_MESSAGE_BYTES
    ) {
      restartBroker(safeError("internal_error"));
      return;
    }
    const parsed =
      desktopCollaborationBrokerChildMessageSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.protocolVersion !==
        DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION ||
      parsed.data.sessionToken !== sessionToken
    ) {
      restartBroker(safeError("internal_error"));
      return;
    }
    const message = parsed.data;
    if (!broker || broker.sessionToken !== sessionToken) {
      return;
    }
    if (message.type === "ready") return;
    if (message.type === "renderer_event") {
      const emit = ownerEmitters.get(message.ownerId);
      if (!emit) {
        restartBroker(safeError("internal_error"));
        return;
      }
      emit(message.event);
      return;
    }
    if (message.type === "open_external") {
      await options.openExternal(message.url).catch(() => undefined);
      return;
    }
    if (message.type === "owner_released" || message.type === "shutdown_ack") {
      return;
    }
    if (message.type === "error") {
      if (message.envelopeId && pending.has(message.envelopeId)) {
        const item = pending.get(message.envelopeId)!;
        clearTimeout(item.timer);
        pending.delete(message.envelopeId);
        item.resolve(
          failureResult(
            item.command,
            message.code === "duplicate_request"
              ? safeError("conflict")
              : safeError("internal_error")
          )
        );
        return;
      }
      restartBroker(safeError("internal_error"));
      return;
    }
    const item = pending.get(message.envelopeId);
    if (!item || item.ownerId !== message.ownerId) {
      restartBroker(safeError("internal_error"));
      return;
    }
    clearTimeout(item.timer);
    pending.delete(message.envelopeId);
    if (
      message.result.requestId !== item.command.requestId ||
      message.result.command !== item.command.command
    ) {
      item.resolve(failureResult(item.command, safeError("internal_error")));
      restartBroker(safeError("internal_error"));
      return;
    }
    item.resolve(message.result);
  };

  const ensureBroker = async (): Promise<CollaborationBrokerChild> => {
    if (broker) {
      await broker.ready;
      return broker;
    }
    const sessionToken = randomBytes(32).toString("base64url");
    const child = options.spawnBroker(sessionToken);
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const handshakeTimer = setTimeout(() => {
      rejectReady(
        new Error("Desktop collaboration broker handshake timed out.")
      );
    }, handshakeTimeoutMs);
    handshakeTimer.unref?.();
    const created: CollaborationBrokerChild = { child, sessionToken, ready };
    broker = created;
    child.on("message", (value) => {
      const parsed =
        desktopCollaborationBrokerChildMessageSchema.safeParse(value);
      if (
        parsed.success &&
        parsed.data.type === "ready" &&
        parsed.data.sessionToken === sessionToken
      ) {
        clearTimeout(handshakeTimer);
        resolveReady();
        return;
      }
      void handleBrokerMessage(sessionToken, value);
    });
    child.once("exit", () => {
      clearTimeout(handshakeTimer);
      if (broker?.sessionToken === sessionToken) {
        restartBroker(safeError("temporarily_unavailable"));
      }
    });
    child.once("error", () => {
      clearTimeout(handshakeTimer);
      if (broker?.sessionToken === sessionToken) {
        restartBroker(safeError("temporarily_unavailable"));
      }
    });
    try {
      await ready;
      return created;
    } catch (error) {
      clearTimeout(handshakeTimer);
      broker = null;
      child.kill("SIGTERM");
      throw error;
    }
  };

  const stopOwner = (ownerId: string) => {
    ownerEmitters.delete(ownerId);
    releaseOwnerSignal(ownerId);
    if (!broker) return;
    sendToBroker({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: broker.sessionToken,
      type: "release_owner",
      envelopeId: createEnvelopeId(),
      ownerId
    });
  };

  const request = async (
    command: CollaborationRendererCommand,
    context: CollaborationTransportContext
  ): Promise<CollaborationCommandResult> => {
    const parsed = collaborationRendererCommandSchema.parse(command);
    ownerEmitters.set(context.ownerId, context.emitCollaborationEvent);
    if (!ownerReleaseSignals.has(context.ownerId)) {
      const release = () => stopOwner(context.ownerId);
      context.signal.addEventListener("abort", release, { once: true });
      ownerReleaseSignals.set(context.ownerId, {
        signal: context.signal,
        release
      });
    }
    let current: CollaborationBrokerChild;
    try {
      current = await ensureBroker();
    } catch {
      return failureResult(parsed, safeError("temporarily_unavailable"));
    }
    const envelopeId = createEnvelopeId();
    return await new Promise<CollaborationCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(envelopeId);
        resolve(failureResult(parsed, safeError("temporarily_unavailable")));
        restartBroker(safeError("temporarily_unavailable"));
      }, commandTimeoutMs);
      timer.unref?.();
      pending.set(envelopeId, {
        ownerId: context.ownerId,
        command: parsed,
        resolve,
        timer
      });
      try {
        sendToBroker({
          protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionToken: current.sessionToken,
          type: "command",
          envelopeId,
          ownerId: context.ownerId,
          command: parsed
        });
      } catch {
        clearTimeout(timer);
        pending.delete(envelopeId);
        resolve(failureResult(parsed, safeError("temporarily_unavailable")));
        restartBroker(safeError("temporarily_unavailable"));
      }
    });
  };

  const stop = async () => {
    const current = broker;
    if (!current) return;
    for (const ownerId of [...ownerEmitters.keys()]) {
      stopOwner(ownerId);
    }
    const envelopeId = createEnvelopeId();
    try {
      const message = desktopCollaborationBrokerParentMessageSchema.parse({
        protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        sessionToken: current.sessionToken,
        type: "shutdown",
        envelopeId
      });
      current.child.send(message);
    } catch {
      broker = null;
      current.child.kill("SIGTERM");
      return;
    }
    broker = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        current.child.kill("SIGTERM");
        resolve();
      }, shutdownTimeoutMs);
      timer.unref?.();
      current.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return { request, stop, stopOwner };
};

export type CollaborationLocalTransport = ReturnType<
  typeof createCollaborationLocalTransport
>;
