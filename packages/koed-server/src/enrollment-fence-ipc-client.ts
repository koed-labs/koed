import type { ChildProcess } from "node:child_process";
import { Socket as DatagramSocket } from "node:dgram";
import { Server, Socket } from "node:net";
import {
  decodeEnrollmentFenceMessage,
  encodeEnrollmentFenceMessage,
  type EnrollmentFenceIpcRequest,
  type EnrollmentFenceIpcResponse
} from "@koed-labs/shared/enrollment-fence-ipc";

export type EnrollmentFenceEpoch = Readonly<{
  instanceId: string;
  epochId: string;
}>;
export type EnrollmentFenceOperation = Readonly<
  EnrollmentFenceEpoch & { operationId: string }
>;
/** A drained result covers tracked epochs and acknowledged admission closure.
 * It does not attest the dispatcher's response-send callback or clean termination. */
export type EnrollmentFenceCloseResult =
  | { status: "api_barrier_drained" }
  | { status: "uncertain"; reasons: readonly string[] };

type Pending = {
  request: EnrollmentFenceIpcRequest;
  resolve: (response: EnrollmentFenceIpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
  response?: EnrollmentFenceIpcResponse;
};

const claimedChildren = new WeakSet<ChildProcess>();

/** Requires a dedicated cooperative inherited channel, exclusively owned by this
 * client, and a trusted adapter bound to the authenticated owner with monotonic
 * drain and no bypass registrations. Raw sends and other module copies bypass
 * the claim. Success covers only tracked epochs, not peer protocol cleanliness,
 * runtime quiescence or durability. Integration must fail closed if assumptions
 * cannot be enforced. */
export class EnrollmentFenceIpcClient {
  private state: "starting" | "open" | "closing" | "poisoned" | "closed" =
    "starting";
  private instanceId?: string;
  private binding: "unbound" | "binding" | "bound" = "unbound";
  private sequence = 0;
  private creates = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly epochs = new Map<string, EnrollmentFenceEpoch>();
  private readonly operations = new Map<string, EnrollmentFenceOperation>();
  private readonly admitted = new Set<Promise<unknown>>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyTimer: ReturnType<typeof setTimeout>;
  private closePromise?: Promise<EnrollmentFenceCloseResult>;
  private reason = "protocol_error";
  private finishResponse = false;
  private disconnected = false;
  private resolveDisconnect?: () => void;
  private rejectDisconnect?: (error: Error) => void;

  // The lifecycle owner must install and retain its own child error listener,
  // including after this client closes or poisons, until child lifecycle ends.
  constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs = 5000
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new Error("Invalid IPC timeout");
    if (child.listenerCount("error") === 0)
      throw new Error("Child lifecycle owner must install an error listener");
    if (claimedChildren.has(child))
      throw new Error("IPC child already claimed");
    claimedChildren.add(child);
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => {});
    child.on("message", this.onMessage);
    child.on("disconnect", this.onDisconnect);
    child.on("exit", this.onExit);
    child.on("error", this.onError);
    this.readyTimer = setTimeout(() => this.poison("ready_timeout"), timeoutMs);
    if (!child.connected || !child.send) this.poison("channel_unavailable");
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async bind(): Promise<void> {
    if (this.state !== "open" || this.binding !== "unbound")
      throw new Error("IPC binding unavailable");
    this.binding = "binding";
    try {
      const response = await this.request({
        v: 1,
        type: "request",
        seq: this.next(),
        op: "bind",
        args: {}
      });
      if (response.op !== "bind" || response.result.kind !== "ok")
        this.fail("bind_rejected");
      if (this.state !== "open") throw new Error("IPC outcome uncertain");
      const acknowledgment = await this.request({
        v: 1,
        type: "request",
        seq: this.next(),
        op: "bindAck",
        args: { challenge: response.result.challenge }
      });
      if (
        acknowledgment.op !== "bindAck" ||
        acknowledgment.result.kind !== "ok"
      )
        this.fail("bind_ack_rejected");
      if (this.state !== "open") throw new Error("IPC outcome uncertain");
      this.binding = "bound";
    } catch {
      this.poison("bind_failed");
      throw new Error("IPC outcome uncertain");
    }
  }

  createEpoch(): Promise<EnrollmentFenceEpoch> {
    return this.admit(() => this.create());
  }

  private async create(): Promise<EnrollmentFenceEpoch> {
    this.assertOpen();
    if (this.creates >= 100) throw new Error("Epoch limit reached");
    this.creates++;
    const response = await this.request({
      v: 1,
      type: "request",
      seq: this.next(),
      op: "create",
      args: {}
    });
    if (response.op !== "create" || response.result.kind !== "ok")
      return this.fail("create_rejected");
    const { instanceId, epochId } = response.result;
    if (instanceId !== this.instanceId || this.epochs.has(epochId))
      return this.fail("invalid_identity");
    const epoch = Object.freeze({ instanceId, epochId });
    this.epochs.set(epochId, epoch);
    return epoch;
  }

  register(epoch: EnrollmentFenceEpoch): Promise<EnrollmentFenceOperation> {
    return this.admit(() => this.registerEpoch(epoch));
  }

  private async registerEpoch(
    epoch: EnrollmentFenceEpoch
  ): Promise<EnrollmentFenceOperation> {
    this.assertOpen();
    const ids = this.knownEpoch(epoch);
    const response = await this.request({
      v: 1,
      type: "request",
      seq: this.next(),
      op: "register",
      args: ids
    });
    if (response.op !== "register" || response.result.kind !== "ok")
      return this.fail("register_rejected");
    const result = response.result;
    if (
      result.instanceId !== ids.instanceId ||
      result.epochId !== ids.epochId ||
      this.operations.has(result.operationId)
    )
      return this.fail("invalid_identity");
    const operation = Object.freeze({
      ...ids,
      operationId: result.operationId
    });
    this.operations.set(operation.operationId, operation);
    return operation;
  }

  fenceEpoch(epoch: EnrollmentFenceEpoch): Promise<"pending" | "drained"> {
    return this.admit(() => this.fencePublicEpoch(epoch));
  }

  private async fencePublicEpoch(
    epoch: EnrollmentFenceEpoch
  ): Promise<"pending" | "drained"> {
    this.assertOpen();
    return this.fenceKnownEpoch(this.knownEpoch(epoch));
  }

  fenceOperation(
    operation: EnrollmentFenceOperation
  ): Promise<"pending" | "drained"> {
    return this.admit(() => this.fencePublicOperation(operation));
  }

  private async fencePublicOperation(
    operation: EnrollmentFenceOperation
  ): Promise<"pending" | "drained"> {
    this.assertOpen();
    const known = this.operations.get(operation.operationId);
    if (
      !known ||
      known.instanceId !== operation.instanceId ||
      known.epochId !== operation.epochId
    )
      throw new Error("Unknown operation");
    const response = await this.request({
      v: 1,
      type: "request",
      seq: this.next(),
      op: "fenceOperation",
      args: known
    });
    if (response.op !== "fenceOperation" || response.result.kind !== "ok")
      return this.fail("fence_rejected");
    const result = response.result;
    if (
      result.instanceId !== known.instanceId ||
      result.epochId !== known.epochId ||
      result.operationId !== known.operationId
    )
      return this.fail("invalid_identity");
    return result.status;
  }

  close(deadlineMs: number): Promise<EnrollmentFenceCloseResult> {
    if (this.closePromise) return this.closePromise;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60000)
      throw new Error("Invalid close deadline");
    if (this.state === "poisoned")
      return Promise.resolve({ status: "uncertain", reasons: [this.reason] });
    if (this.state === "starting") {
      this.poison("close_before_ready");
      return Promise.resolve({ status: "uncertain", reasons: [this.reason] });
    }
    if (this.binding !== "bound") {
      this.poison("close_before_bind");
      return Promise.resolve({ status: "uncertain", reasons: [this.reason] });
    }
    this.state = "closing";
    this.closePromise = this.drain(deadlineMs);
    return this.closePromise;
  }

  private async drain(deadlineMs: number): Promise<EnrollmentFenceCloseResult> {
    const deadline = setTimeout(() => this.poison("close_timeout"), deadlineMs);
    try {
      await Promise.allSettled([...this.admitted]);
      if (this.state !== "closing") throw new Error("IPC uncertain");
      for (const epoch of this.epochs.values()) {
        while ((await this.fenceKnownEpoch(epoch)) === "pending") {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      if (this.state !== "closing") throw new Error("IPC uncertain");
      const disconnected = new Promise<void>((resolve, reject) => {
        this.resolveDisconnect = resolve;
        this.rejectDisconnect = reject;
      });
      void disconnected.catch(() => {});
      const response = await this.request({
        v: 1,
        type: "request",
        seq: this.next(true),
        op: "finish",
        args: {}
      });
      if (response.op !== "finish" || response.result.kind !== "ok")
        throw new Error("Finish rejected");
      if (!this.disconnected) await disconnected;
      if (this.state !== "closing") throw new Error("IPC uncertain");
      this.state = "closed";
      this.cleanup();
      return { status: "api_barrier_drained" };
    } catch {
      this.poison("close_failed");
      return { status: "uncertain", reasons: [this.reason] };
    } finally {
      clearTimeout(deadline);
    }
  }

  private async fenceKnownEpoch(
    epoch: EnrollmentFenceEpoch
  ): Promise<"pending" | "drained"> {
    const response = await this.request({
      v: 1,
      type: "request",
      seq: this.next(),
      op: "fenceEpoch",
      args: epoch
    });
    if (response.op !== "fenceEpoch" || response.result.kind !== "ok")
      return this.fail("fence_rejected");
    if (
      response.result.instanceId !== epoch.instanceId ||
      response.result.epochId !== epoch.epochId
    )
      return this.fail("invalid_identity");
    return response.result.status;
  }

  private admit<T>(start: () => Promise<T>): Promise<T> {
    if (
      this.state !== "open" ||
      this.binding !== "bound" ||
      this.admitted.size >= 32
    )
      return Promise.reject(new Error("IPC client is not available"));
    const task = start();
    this.admitted.add(task);
    void task.then(
      () => this.admitted.delete(task),
      () => this.admitted.delete(task)
    );
    return task;
  }

  private knownEpoch(epoch: EnrollmentFenceEpoch): EnrollmentFenceEpoch {
    const known = this.epochs.get(epoch.epochId);
    if (!known || known.instanceId !== epoch.instanceId)
      throw new Error("Unknown epoch");
    return known;
  }

  private assertOpen(): void {
    if (this.state !== "open") throw new Error("IPC client is not open");
  }

  private next(finish = false): number {
    if (this.state !== "open" && this.state !== "closing")
      throw new Error("IPC client is not available");
    if (this.pending.size >= 32 || this.sequence >= (finish ? 100000 : 99999))
      throw new Error("IPC request limit reached");
    return ++this.sequence;
  }

  private request(
    request: EnrollmentFenceIpcRequest
  ): Promise<EnrollmentFenceIpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.poison("request_timeout"),
        this.timeoutMs
      );
      this.pending.set(request.seq, {
        request,
        resolve,
        reject,
        timer,
        sent: false
      });
      try {
        const wire = encodeEnrollmentFenceMessage(request);
        this.child.send!(wire, (error) => {
          if (error) {
            this.poison("send_error");
            return;
          }
          const pending = this.pending.get(request.seq);
          if (pending) {
            pending.sent = true;
            this.completeRequest(pending);
          }
        });
      } catch {
        this.poison("send_error");
      }
    });
  }

  private readonly onMessage = (wire: unknown, handle: unknown): void => {
    if (this.state === "poisoned" || this.state === "closed") return;
    try {
      if (handle != null) {
        this.disposeHandle(handle);
        throw new Error("Unexpected handle");
      }
      const message = decodeEnrollmentFenceMessage(wire);
      if (message.type === "ready" && this.state === "starting") {
        this.instanceId = message.instanceId;
        this.state = "open";
        clearTimeout(this.readyTimer);
        this.resolveReady();
        return;
      }
      if (message.type !== "response") throw new Error("Unexpected message");
      const pending = this.pending.get(message.seq);
      if (!pending || pending.request.op !== message.op || pending.response)
        throw new Error("Unexpected response");
      pending.response = message;
      if (message.op === "finish" && message.result.kind === "ok")
        this.finishResponse = true;
      this.completeRequest(pending);
    } catch {
      this.poison("protocol_error");
    }
  };
  private completeRequest(pending: Pending): void {
    if (!pending.sent || !pending.response) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.request.seq);
    pending.resolve(pending.response);
  }

  private disposeHandle(handle: unknown): void {
    try {
      if (handle instanceof Socket) handle.destroy();
      else if (handle instanceof Server || handle instanceof DatagramSocket)
        handle.close(() => {});
    } catch {
      // Protocol failure poisons the client even if disposal fails.
    }
  }

  private readonly onDisconnect = (): void => {
    if (this.state !== "closing" || !this.finishResponse) {
      this.poison("disconnect");
      return;
    }
    this.disconnected = true;
    this.resolveDisconnect?.();
  };
  private readonly onExit = (): void => {
    this.poison("exit");
    this.child.removeListener("exit", this.onExit);
    if (this.child.listenerCount("error") > 1)
      this.child.removeListener("error", this.onError);
  };
  private readonly onError = (): void => this.poison("channel_error");

  private fail(reason: string): never {
    this.poison(reason);
    throw new Error("IPC outcome uncertain");
  }

  private poison(reason: string): void {
    if (this.state === "poisoned" || this.state === "closed") return;
    this.state = "poisoned";
    this.reason = reason;
    this.rejectReady(new Error("IPC outcome uncertain"));
    this.rejectDisconnect?.(new Error("IPC outcome uncertain"));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC outcome uncertain"));
    }
    this.pending.clear();
    this.cleanup();
    try {
      if (this.child.connected) this.child.disconnect();
    } catch {
      // Channel may already be gone.
    }
  }

  private cleanup(): void {
    clearTimeout(this.readyTimer);
    this.child.removeListener("message", this.onMessage);
    this.child.removeListener("disconnect", this.onDisconnect);
    // Keep the fallback until exit, even if the owner removes its listener early.
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.child.removeListener("exit", this.onExit);
      if (this.child.listenerCount("error") > 1)
        this.child.removeListener("error", this.onError);
    }
  }
}
