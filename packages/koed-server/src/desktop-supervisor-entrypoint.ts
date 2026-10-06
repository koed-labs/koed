import { realpathSync } from "node:fs";
import { startKoedServer } from "./start.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";

interface InitMessage {
  type: "koed.desktop.supervisor.init";
  nonce: string;
  managerPid: number;
  resourcesPath: string;
}

const isInitMessage = (value: unknown): value is InitMessage => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === 4 &&
    item.type === "koed.desktop.supervisor.init" &&
    typeof item.nonce === "string" &&
    /^[a-f0-9]{64}$/.test(item.nonce) &&
    Number.isSafeInteger(item.managerPid) &&
    item.managerPid === process.ppid &&
    typeof item.resourcesPath === "string"
  );
};

const waitForManagerAuthority = (): Promise<InitMessage> =>
  new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || process.connected !== true) {
      reject(
        new Error("private Desktop supervisor IPC channel is unavailable")
      );
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Desktop supervisor handshake timed out")),
      10_000
    );
    const onMessage = (message: unknown): void => {
      clearTimeout(timer);
      process.off("message", onMessage);
      if (!isInitMessage(message)) {
        reject(new Error("private Desktop supervisor handshake is invalid"));
        return;
      }
      resolve(message);
    };
    process.on("message", onMessage);
  });

export const createDesktopSupervisorEnvironment = (
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...source,
    KOED_PACKAGED_DESKTOP: "1"
  };
  delete environment.KOED_PACKAGED_RESOURCES_PATH;
  return environment;
};

const assertParentExecutable = (managerPid: number): void => {
  if (process.platform === "linux") {
    const parentExecutable = realpathSync.native(`/proc/${managerPid}/exe`);
    if (parentExecutable !== realpathSync.native(process.execPath)) {
      throw new Error("Desktop supervisor parent executable identity mismatch");
    }
  }
};

export async function runDesktopSupervisorEntrypoint(): Promise<void> {
  const handshake = await waitForManagerAuthority();
  assertParentExecutable(handshake.managerPid);
  const capability = verifyDesktopRuntimeBundle(handshake.resourcesPath);
  if (typeof process.send !== "function")
    throw new Error("Desktop supervisor IPC channel is unavailable");
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).type ===
        "koed.desktop.supervisor.stop"
    )
      process.kill(process.pid, "SIGTERM");
  });
  process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
  try {
    await startKoedServer({
      environment: createDesktopSupervisorEnvironment(process.env),
      desktopRuntimeCapability: capability,
      onReady: () => {
        process.send?.({
          type: "koed.desktop.supervisor.ready",
          nonce: handshake.nonce,
          childPid: process.pid,
          bundleDigest: capability.bundleDigest
        });
      }
    });
  } finally {
    process.disconnect?.();
  }
}

if (process.argv[1]?.endsWith("desktop-supervisor-entrypoint.js")) {
  void runDesktopSupervisorEntrypoint().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
