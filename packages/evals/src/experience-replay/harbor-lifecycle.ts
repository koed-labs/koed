import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { RunJournal } from "./journal.js";

export const HARBOR_LIFECYCLE_SOCKET_ENV = "KOED_HARBOR_LIFECYCLE_SOCKET";
export const HARBOR_LIFECYCLE_TOKEN_ENV = "KOED_HARBOR_LIFECYCLE_TOKEN";
export const HARBOR_LIFECYCLE_TIMEOUT_ENV = "KOED_HARBOR_LIFECYCLE_TIMEOUT_MS";

const PROTOCOL_VERSION = "koed-harbor-lifecycle-v1";
const ACK_VERSION = "koed-harbor-lifecycle-ack-v1";
const DEFAULT_EVENT_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 16 * 1024;

export type HarborAttemptKind = "source" | "replay";
export type HarborLifecycleEventName =
  | "agent_started"
  | "agent_ended"
  | "trial_ended"
  | "trial_cancelled";

export interface HarborLifecycleEvent {
  schema_version: typeof PROTOCOL_VERSION;
  token: string;
  attempt_kind: HarborAttemptKind;
  event: HarborLifecycleEventName;
  trial_id: string;
  task_name: string;
  timestamp: string;
}

export type HarborLifecycleCallbackEvent = Omit<HarborLifecycleEvent, "token">;

export interface HarborLifecycleCallbacks {
  onAgentStarted?(event: HarborLifecycleCallbackEvent): void | Promise<void>;
  onAgentEnded?(event: HarborLifecycleCallbackEvent): void | Promise<void>;
  onTrialEnded?(event: HarborLifecycleCallbackEvent): void | Promise<void>;
  onTrialCancelled?(event: HarborLifecycleCallbackEvent): void | Promise<void>;
}

export interface HarborLifecycleServer {
  readonly socketPath: string;
  /** These values are for the Harbor child process environment only. */
  readonly processEnvironment: Readonly<NodeJS.ProcessEnv>;
  assertComplete(): void;
  close(): Promise<void>;
}

export interface StartHarborLifecycleServerOptions {
  attemptKind: HarborAttemptKind;
  callbacks?: HarborLifecycleCallbacks;
  eventTimeoutMs?: number;
  temporaryRoot?: string;
}

const safeEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const parseEvent = (line: string): HarborLifecycleEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("invalid lifecycle JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid lifecycle event");
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).length !== 7 ||
    value.schema_version !== PROTOCOL_VERSION ||
    typeof value.token !== "string" ||
    !["source", "replay"].includes(value.attempt_kind as string) ||
    ![
      "agent_started",
      "agent_ended",
      "trial_ended",
      "trial_cancelled"
    ].includes(value.event as string) ||
    typeof value.trial_id !== "string" ||
    value.trial_id.length < 1 ||
    value.trial_id.length > 128 ||
    typeof value.task_name !== "string" ||
    value.task_name.length < 1 ||
    value.task_name.length > 256 ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp))
  ) {
    throw new Error("invalid lifecycle event");
  }
  return value as unknown as HarborLifecycleEvent;
};

const acknowledgement = (accepted: boolean): string =>
  `${JSON.stringify({ schema_version: ACK_VERSION, accepted })}\n`;

const listen = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

export const startHarborLifecycleServer = async (
  options: StartHarborLifecycleServerOptions
): Promise<HarborLifecycleServer> => {
  const eventTimeoutMs = options.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(eventTimeoutMs) || eventTimeoutMs < 1) {
    throw new Error("Harbor lifecycle event timeout must be positive");
  }
  const temporaryDirectory = await mkdtemp(
    path.join(options.temporaryRoot ?? os.tmpdir(), "koed-harbor-lifecycle-")
  );
  await chmod(temporaryDirectory, 0o700);
  const socketPath = path.join(temporaryDirectory, "events.sock");
  const token = randomBytes(32).toString("base64url");
  const callbacks = options.callbacks ?? {};
  let state:
    | "waiting"
    | "agent-started"
    | "agent-ended"
    | "cancelled"
    | "ended" = "waiting";
  let trialIdentity: { trialId: string; taskName: string } | undefined;
  let callbackTail: Promise<void> = Promise.resolve();
  let callbackFailure: unknown;
  const sockets = new Set<Socket>();

  const dispatch = async (event: HarborLifecycleEvent): Promise<void> => {
    if (!safeEqual(event.token, token))
      throw new Error("unauthorized lifecycle event");
    if (event.attempt_kind !== options.attemptKind) {
      throw new Error("cross-attempt lifecycle event");
    }
    if (trialIdentity) {
      if (
        event.trial_id !== trialIdentity.trialId ||
        event.task_name !== trialIdentity.taskName
      ) {
        throw new Error("cross-trial lifecycle event");
      }
    } else if (event.event === "agent_started") {
      trialIdentity = { trialId: event.trial_id, taskName: event.task_name };
    }
    const callbackEvent: HarborLifecycleCallbackEvent = {
      schema_version: event.schema_version,
      attempt_kind: event.attempt_kind,
      event: event.event,
      trial_id: event.trial_id,
      task_name: event.task_name,
      timestamp: event.timestamp
    };
    if (event.event === "agent_started") {
      if (state !== "waiting") throw new Error("out-of-order lifecycle event");
      await callbacks.onAgentStarted?.(callbackEvent);
      state = "agent-started";
    } else if (event.event === "agent_ended") {
      if (state !== "agent-started")
        throw new Error("out-of-order lifecycle event");
      await callbacks.onAgentEnded?.(callbackEvent);
      state = "agent-ended";
    } else if (event.event === "trial_cancelled") {
      if (state === "cancelled" || state === "ended") {
        throw new Error("late lifecycle event");
      }
      await callbacks.onTrialCancelled?.(callbackEvent);
      state = "cancelled";
    } else {
      if (state !== "agent-ended" && state !== "cancelled") {
        throw new Error("out-of-order lifecycle event");
      }
      await callbacks.onTrialEnded?.(callbackEvent);
      state = "ended";
    }
  };

  // Harbor half-closes after writing one event. Keep the response side open
  // until asynchronous credential/journal callbacks have been acknowledged.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setTimeout(eventTimeoutMs, () => socket.destroy());
    let bytes = 0;
    let received = Buffer.alloc(0);
    let handled = false;
    const reject = (): void => {
      if (handled) return;
      handled = true;
      socket.end(acknowledgement(false));
    };
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_LINE_BYTES) {
        reject();
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      if (
        newline !== received.byteLength - 1 ||
        received.indexOf(0x0a, newline + 1) >= 0
      ) {
        reject();
        return;
      }
      handled = true;
      let event: HarborLifecycleEvent;
      try {
        event = parseEvent(received.subarray(0, newline).toString("utf8"));
      } catch {
        socket.end(acknowledgement(false));
        return;
      }
      const operation = callbackTail.then(() => dispatch(event));
      callbackTail = operation.catch((error: unknown) => {
        callbackFailure ??= error;
      });
      void operation.then(
        () => socket.end(acknowledgement(true)),
        () => socket.end(acknowledgement(false))
      );
    });
    socket.on("end", () => {
      if (!handled) reject();
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });

  try {
    await listen(server, socketPath);
    await chmod(socketPath, 0o600);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  return {
    socketPath,
    processEnvironment: Object.freeze({
      [HARBOR_LIFECYCLE_SOCKET_ENV]: socketPath,
      [HARBOR_LIFECYCLE_TOKEN_ENV]: token,
      [HARBOR_LIFECYCLE_TIMEOUT_ENV]: String(eventTimeoutMs)
    }),
    assertComplete() {
      if (callbackFailure) {
        throw new Error("Harbor lifecycle callback failed", {
          cause: callbackFailure
        });
      }
      if (state !== "ended" && state !== "cancelled") {
        throw new Error(
          "Harbor lifecycle ended without a synchronous trial acknowledgement"
        );
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await callbackTail;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  };
};

export interface CoordinatorHarborLifecycleOptions {
  attemptId: string;
  executionGeneration: number;
  journal: Pick<RunJournal, "append">;
  activateCredential(): void | Promise<void>;
  revokeCredential(): void | Promise<void>;
}

/** Binds the acknowledged agent boundary to credential and journal state. */
export const createCoordinatorHarborLifecycle = (
  options: CoordinatorHarborLifecycleOptions
): HarborLifecycleCallbacks => {
  let revoked = false;
  const revoke = async (): Promise<void> => {
    if (revoked) return;
    revoked = true;
    await options.revokeCredential();
  };
  return {
    async onAgentStarted() {
      // Commit the irreversible boundary before allowing the external agent to
      // authenticate. A crash may conservatively preserve a missing outcome,
      // but it can never rerun work that may already have started.
      await options.journal.append({
        type: "attempt_state",
        attemptId: options.attemptId,
        executionGeneration: options.executionGeneration,
        state: "agent_started"
      });
      try {
        await options.activateCredential();
      } catch (error) {
        await revoke();
        throw error;
      }
    },
    onAgentEnded: revoke,
    onTrialCancelled: revoke,
    onTrialEnded: revoke
  };
};
