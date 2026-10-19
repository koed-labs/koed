import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

export interface PrivateSupervisorSession {
  child: ChildProcess;
  nonce: string;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

// All private RPCs share correlation, deadline, disconnect and listener cleanup.
export function requestSupervisor<T>(
  session: PrivateSupervisorSession,
  channel: "status" | "privacy",
  action: string,
  args: Record<string, unknown> = {},
  timeoutMs = 120_000,
  onProgress?: (value: Record<string, unknown>) => void
): Promise<T> {
  const { child, nonce } = session;
  if (!child.connected)
    return Promise.reject(
      new Error("Private Desktop supervisor is unavailable.")
    );
  const requestId =
    typeof args.requestId === "string" ? args.requestId : randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("disconnect", onExit);
      child.off("error", fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = () =>
      fail(
        new Error("Private Desktop supervisor disconnected during request.")
      );
    const onMessage = (value: unknown) => {
      const item = record(value);
      if (
        !item ||
        item.nonce !== nonce ||
        item.requestId !== requestId ||
        item.action !== action
      )
        return;
      if (item.type === `koed.desktop.${channel}.progress`) {
        onProgress?.(item);
        return;
      }
      if (item.type !== `koed.desktop.${channel}.response`) return;
      if (typeof item.error === "string") {
        fail(new Error(item.error));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(item.result as T);
    };
    const timer = setTimeout(
      () => fail(new Error("Private Desktop supervisor request timed out.")),
      timeoutMs
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("disconnect", onExit);
    child.once("error", fail);
    try {
      child.send(
        {
          ...args,
          type: `koed.desktop.${channel}.request`,
          nonce,
          requestId,
          action
        },
        (error: Error | null) => {
          if (error) fail(error);
        }
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function connectSupervisor(
  child: ChildProcess,
  resourcesPath: string,
  mode: "runtime" | "privacy-management" = "runtime",
  timeoutMs = 120_000
): Promise<PrivateSupervisorSession> {
  const nonce = randomBytes(32).toString("hex");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("disconnect", onExit);
      child.off("error", fail);
    };
    const fail = (error: Error) => {
      cleanup();
      child.kill("SIGTERM");
      reject(error);
    };
    const onExit = () =>
      fail(new Error("Desktop supervisor exited before completing handshake."));
    const onMessage = (value: unknown) => {
      const item = record(value);
      if (
        item?.type !== "koed.desktop.supervisor.ready" ||
        item.nonce !== nonce ||
        item.childPid !== child.pid ||
        typeof item.bundleDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.bundleDigest) ||
        (mode !== "runtime" && item.mode !== mode)
      ) {
        fail(new Error("Desktop supervisor handshake response is invalid."));
        return;
      }
      cleanup();
      resolve();
    };
    const timer = setTimeout(
      () => fail(new Error("Desktop supervisor startup timed out.")),
      timeoutMs
    );
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("disconnect", onExit);
    child.once("error", fail);
    try {
      child.send(
        {
          type: "koed.desktop.supervisor.init",
          nonce,
          managerPid: process.pid,
          resourcesPath,
          ...(mode === "runtime" ? {} : { mode })
        },
        (error: Error | null) => {
          if (error) fail(error);
        }
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return { child, nonce };
}
