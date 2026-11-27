import { randomBytes } from "node:crypto";
import { Server, Socket } from "node:net";
import {
  decodeEnrollmentFenceMessage,
  encodeEnrollmentFenceMessage,
  type EnrollmentFenceIpcRequest,
  type EnrollmentFenceIpcResponse
} from "./enrollment-fence-ipc-codec.js";

type Ids = { instanceId: string; epochId: string };
type OperationIds = Ids & { operationId: string };
type MaybePromise<T> = T | Promise<T>;
type Status = "pending" | "drained";

/** Integration must bind this adapter to the validated owner and the route's fence.
 * The dispatcher does not authenticate peers or verify that binding. */
export interface EnrollmentFenceIpcAdapter {
  readonly instanceId: string;
  closeAdmission(): Promise<void>;
  createEpoch(): MaybePromise<string>;
  register(ids: Ids): MaybePromise<string>;
  fenceEpoch(ids: Ids): MaybePromise<Status>;
  fenceOperation(ids: OperationIds): MaybePromise<Status>;
}

/** Inherited Node IPC endpoint; lifecycle owner remains responsible for error handling. */
export interface EnrollmentFenceIpcEndpoint {
  readonly connected: boolean;
  on(
    event: "message",
    listener: (message: unknown, handle?: unknown) => void
  ): this;
  on(event: "disconnect" | "error", listener: () => void): this;
  off(
    event: "message",
    listener: (message: unknown, handle?: unknown) => void
  ): this;
  off(event: "disconnect" | "error", listener: () => void): this;
  send(message: string, callback: (error: Error | null) => void): boolean;
  disconnect(): void;
}

async function execute(
  request: EnrollmentFenceIpcRequest,
  adapter: EnrollmentFenceIpcAdapter
): Promise<EnrollmentFenceIpcResponse> {
  const envelope = {
    v: 1 as const,
    type: "response" as const,
    seq: request.seq
  };
  switch (request.op) {
    case "bind":
    case "bindAck":
    case "finish":
      throw new Error("Control request must be handled by dispatcher");
    case "create":
      return {
        ...envelope,
        op: request.op,
        result: {
          kind: "ok",
          instanceId: adapter.instanceId,
          epochId: await adapter.createEpoch()
        }
      };
    case "register":
      return {
        ...envelope,
        op: request.op,
        result: {
          kind: "ok",
          ...request.args,
          operationId: await adapter.register(request.args)
        }
      };
    case "fenceEpoch":
      return {
        ...envelope,
        op: request.op,
        result: {
          kind: "ok",
          ...request.args,
          status: await adapter.fenceEpoch(request.args)
        }
      };
    case "fenceOperation":
      return {
        ...envelope,
        op: request.op,
        result: {
          kind: "ok",
          ...request.args,
          status: await adapter.fenceOperation(request.args)
        }
      };
  }
}

const claimedEndpoints = new WeakSet<EnrollmentFenceIpcEndpoint>();

/** Requires a dedicated cooperative endpoint and a trusted adapter bound to the
 * authenticated owner. Claims cannot prevent raw sends or other module copies.
 * Poison and close stop adapter admission but cannot undo prior effects.
 * settled() waits for terminal state, adapter work, and admission cleanup, but
 * not pending send callbacks; use quiescent() to check transport quiescence.
 * Quiescence is not evidence that an uncertain effect did not happen. */
export function startEnrollmentFenceIpcDispatcher(
  endpoint: EnrollmentFenceIpcEndpoint,
  options: {
    instanceId: string;
    bind(signal: AbortSignal): Promise<EnrollmentFenceIpcAdapter>;
    timeoutMs?: number;
  }
): {
  state(): "initializing" | "ready" | "disconnecting" | "poisoned" | "closed";
  quiescent(): boolean;
  uncertain(): boolean;
  settled(): Promise<void>;
  close(): void;
} {
  if (claimedEndpoints.has(endpoint))
    throw new Error("IPC endpoint already claimed");
  claimedEndpoints.add(endpoint);
  let state:
    | "initializing"
    | "ready"
    | "disconnecting"
    | "poisoned"
    | "closed" = "initializing";
  let inFlight: Promise<EnrollmentFenceIpcResponse> | undefined;
  let adapter: EnrollmentFenceIpcAdapter | undefined;
  let binding: "unbound" | "binding" | "awaitingAck" | "bound" = "unbound";
  let challenge: string | undefined;
  const abort = new AbortController();
  let closeTask: Promise<void> | undefined;
  let closePending = false;
  let resolveTerminal!: () => void;
  const terminalReached = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  let bindTimer: ReturnType<typeof setTimeout> | undefined;
  let uncertain = false;
  let lastSequence = 0;
  let active = false;
  let pendingSends = 0;
  let terminal = false;
  const queue: EnrollmentFenceIpcRequest[] = [];

  function detach() {
    endpoint.off("message", onMessage);
    endpoint.off("disconnect", onDisconnect);
    endpoint.off("error", onError);
  }
  function stop(next: "poisoned" | "closed") {
    if (state === "poisoned" || state === "closed") return;
    state = next;
    uncertain = true;
    queue.length = 0;
    if (adapter)
      void closeAdapter(adapter).catch(() => {
        uncertain = true;
      });
    abort.abort();
    clearTimeout(bindTimer);
    detach();
    resolveTerminal();
    try {
      if (endpoint.connected) endpoint.disconnect();
    } catch {
      /* already lost */
    }
  }
  function closeAdapter(value: EnrollmentFenceIpcAdapter): Promise<void> {
    if (!closeTask) {
      try {
        closeTask = Promise.resolve(value.closeAdmission());
      } catch (error) {
        closeTask = Promise.reject(error);
      }
      closePending = true;
      void closeTask.then(
        () => {
          closePending = false;
        },
        () => {
          closePending = false;
          uncertain = true;
        }
      );
    }
    return closeTask;
  }
  async function executeBind(
    item: EnrollmentFenceIpcRequest
  ): Promise<EnrollmentFenceIpcResponse> {
    const value = await options.bind(abort.signal);
    if (abort.signal.aborted || state !== "ready") {
      await value.closeAdmission();
      throw new Error("Binding cancelled");
    }
    adapter = value;
    if (value.instanceId !== options.instanceId)
      throw new Error("Invalid adapter");
    challenge = randomBytes(16).toString("hex");
    return {
      v: 1,
      type: "response",
      seq: item.seq,
      op: "bind",
      result: { kind: "ok", challenge }
    };
  }
  function send(wire: string, done: () => void) {
    pendingSends++;
    let pending = true;
    const settleSend = () => {
      if (!pending) return false;
      pending = false;
      pendingSends--;
      return true;
    };
    try {
      endpoint.send(wire, (error) => {
        if (!settleSend() || state === "poisoned" || state === "closed") return;
        if (error) stop("poisoned");
        else done();
      });
    } catch {
      settleSend();
      stop("poisoned");
    }
  }
  function pump() {
    if (state !== "ready" || active || queue.length === 0) return;
    active = true;
    const item = queue.shift()!;
    if (item.op === "bind") {
      bindTimer = setTimeout(() => stop("poisoned"), options.timeoutMs ?? 5000);
      inFlight = executeBind(item);
    } else if (item.op === "bindAck") {
      inFlight = Promise.resolve({
        v: 1,
        type: "response",
        seq: item.seq,
        op: "bindAck",
        result: { kind: "ok" }
      });
    } else if (item.op === "finish") {
      inFlight = closeAdapter(adapter!).then(() => ({
        v: 1,
        type: "response",
        seq: item.seq,
        op: "finish",
        result: { kind: "ok" }
      }));
    } else {
      inFlight = execute(item, adapter!);
    }
    void inFlight.then(
      (response) => {
        inFlight = undefined;
        if (state !== "ready") return;
        try {
          const wire = encodeEnrollmentFenceMessage(response);
          if (item.op === "bind") binding = "awaitingAck";
          send(wire, () => {
            if (item.op === "bindAck") clearTimeout(bindTimer);
            if (item.op === "finish") {
              state = "disconnecting";
              try {
                if (!endpoint.connected) throw new Error();
                endpoint.disconnect();
              } catch {
                stop("poisoned");
              }
              return;
            }
            active = false;
            pump();
          });
        } catch {
          stop("poisoned");
        }
      },
      () => {
        inFlight = undefined;
        stop("poisoned");
      }
    );
  }
  function onMessage(message: unknown, handle?: unknown) {
    if (handle != null) {
      // Transferred handles belong to the receiver even when the message is rejected.
      try {
        if (handle instanceof Socket) handle.destroy();
        else if (handle instanceof Server) handle.close();
      } catch {
        /* channel is poisoned regardless */
      }
      stop("poisoned");
      return;
    }
    if (state === "poisoned" || state === "closed") return;
    try {
      const parsed = decodeEnrollmentFenceMessage(message);
      if (
        parsed.type !== "request" ||
        terminal ||
        parsed.seq <= lastSequence ||
        queue.length + Number(active) >= 32
      )
        throw new Error();
      if (parsed.op === "bind") {
        if (binding !== "unbound") throw new Error();
        binding = "binding";
      } else if (parsed.op === "bindAck") {
        if (binding !== "awaitingAck" || parsed.args.challenge !== challenge)
          throw new Error();
        challenge = undefined;
        binding = "bound";
      } else if (binding !== "bound") {
        throw new Error();
      }
      if (
        parsed.op !== "bind" &&
        parsed.op !== "bindAck" &&
        parsed.op !== "create" &&
        parsed.op !== "finish" &&
        parsed.args.instanceId !== options.instanceId
      )
        throw new Error();
      lastSequence = parsed.seq;
      if (parsed.op === "finish") terminal = true;
      queue.push(parsed);
      pump();
    } catch {
      stop("poisoned");
    }
  }
  function onDisconnect() {
    if (state === "disconnecting") {
      state = "closed";
      detach();
      resolveTerminal();
    } else stop("poisoned");
  }
  function onError() {
    stop("poisoned");
  }

  endpoint.on("message", onMessage);
  endpoint.on("disconnect", onDisconnect);
  endpoint.on("error", onError);
  try {
    if (!endpoint.connected) throw new Error();
    send(
      encodeEnrollmentFenceMessage({
        v: 1,
        type: "ready",
        instanceId: options.instanceId
      }),
      () => {
        state = "ready";
        pump();
      }
    );
  } catch {
    stop("poisoned");
  }
  return {
    state: () => state,
    quiescent: () =>
      inFlight === undefined &&
      !closePending &&
      pendingSends === 0 &&
      queue.length === 0 &&
      (state === "closed" || state === "poisoned"),
    uncertain: () => uncertain,
    settled: async () => {
      await terminalReached;
      if (inFlight) await inFlight.catch(() => {});
      if (closeTask) await closeTask.catch(() => {});
    },
    close: () => stop("closed")
  };
}
