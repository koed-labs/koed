import type { ChildProcess } from "node:child_process";
import { controlSnapshotSchema } from "@koed-labs/shared/local-control-protocol";

interface PendingProbe {
  requestId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function parseReply(value: unknown, requestId: number) {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "status-result" ||
    !("requestId" in value) ||
    value.requestId !== requestId ||
    !("ok" in value)
  )
    return undefined;
  if (value.ok === false && Object.keys(value).length === 3)
    return { ok: false };
  if (
    value.ok === true &&
    "snapshot" in value &&
    Object.keys(value).length === 4
  ) {
    const snapshot = controlSnapshotSchema.safeParse(value.snapshot);
    if (snapshot.success) return { ok: true, snapshot: snapshot.data };
  }
  return undefined;
}

function isReady(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "status-ready" &&
    Object.keys(value).length === 1
  );
}

function sendProbe(
  child: ChildProcess,
  requestId: number,
  onError: (error: Error) => void
) {
  if (!child.connected || !child.send) {
    onError(new Error("Desktop status helper disconnected"));
    return;
  }
  try {
    child.send({ type: "status", requestId }, (error) => {
      if (error) onError(error);
    });
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}

function watchHelper(child: ChildProcess, onClosed: () => void) {
  let closed = false;
  let ready = false;
  let pending: PendingProbe | undefined;
  const takePending = () => {
    const probe = pending;
    pending = undefined;
    if (probe) clearTimeout(probe.timer);
    return probe;
  };
  const close = (error: Error, kill = true) => {
    if (closed) return;
    closed = true;
    child.off("disconnect", onDisconnect);
    child.off("exit", onExit);
    child.off("message", onMessage);
    takePending()?.reject(error);
    onClosed();
    if (kill) child.kill();
  };
  const onDisconnect = () =>
    close(new Error("Desktop status helper disconnected"));
  const onExit = () => close(new Error("Desktop status helper exited"), false);
  const onError = (error: Error) => close(error);
  const sendPending = () => {
    const requestId = pending?.requestId;
    if (!ready || requestId === undefined) return;
    sendProbe(child, requestId, (error) => {
      if (pending?.requestId === requestId) close(error);
    });
  };
  const onMessage = (value: unknown) => {
    if (!ready && isReady(value)) {
      ready = true;
      sendPending();
      return;
    }
    const result = ready && pending && parseReply(value, pending.requestId);
    if (!result) close(new Error("Invalid Desktop status reply"));
    else takePending()?.resolve(result);
  };
  child.once("disconnect", onDisconnect);
  child.once("exit", onExit);
  child.on("error", onError);
  child.once("close", () => child.off("error", onError));
  child.on("message", onMessage);

  return {
    close,
    async probe(requestId: number, timeout: number): Promise<unknown> {
      if (pending) throw new Error("Desktop status probe already in progress");
      if (!child.connected || !child.send) {
        const error = new Error("Desktop status helper disconnected");
        close(error);
        throw error;
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => close(new Error("Desktop status probe timed out")),
          timeout
        );
        pending = { requestId, timer, resolve, reject };
        sendPending();
      });
    }
  };
}

/** A reusable, read-only IPC client. The caller supplies the packaged spawn. */
export function createControlStatusClient(spawnStatus: () => ChildProcess): {
  probe(timeout: number): Promise<unknown>;
  close(): void;
} {
  let helper: ReturnType<typeof watchHelper> | undefined;
  let requestId = 0;
  return {
    async probe(timeout) {
      if (
        !Number.isSafeInteger(timeout) ||
        timeout <= 0 ||
        timeout > 2_147_483_647
      )
        throw new Error("Invalid Desktop status probe timeout");
      helper ??= watchHelper(spawnStatus(), () => {
        helper = undefined;
      });
      return helper.probe(++requestId, timeout);
    },
    close: () => helper?.close(new Error("Desktop status client closed"))
  };
}
