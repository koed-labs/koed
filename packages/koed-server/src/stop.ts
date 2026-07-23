import {
  existsSync as nodeExistsSync,
  readFileSync,
  rmSync,
  type PathLike
} from "node:fs";
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { resolve } from "node:path";
import { stopLocalPostgresRuntime } from "./local-postgres-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import { readSupervisorLock } from "./supervisor-lock.js";
import { requestSupervisorExit } from "./supervisor-exit-request.js";
import type { KoedServerRuntimeState } from "./types.js";

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

export interface KoedServerStopResult {
  ok: boolean;
  state: "healthy" | "not_configured" | "needs_attention";
  koedHome: string;
  message: string;
  stoppedPids: number[];
  missingPids: number[];
  stoppedServices: string[];
  missingServices: string[];
  errors?: Array<{ target: string; error: string }>;
}

export interface KoedServerStopOptions {
  environment?: NodeJS.ProcessEnv;
  existsSync?: typeof nodeExistsSync;
  readFileSync?: typeof readFileSync;
  rmSync?: typeof rmSync;
  spawnSync?: SpawnSyncLike;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  checkPid?: (pid: number) => boolean;
  waitForExitMs?: number;
  pollIntervalMs?: number;
  sleepSync?: (ms: number) => void;
  readSupervisorLock?: typeof readSupervisorLock;
}

const APP_PROCESS_ORDER = [
  {
    processName: "codexTranscriptWatcher",
    serviceName: "codex-transcript-watcher"
  },
  { processName: "explorer", serviceName: "explorer" },
  { processName: "worker", serviceName: "worker" },
  { processName: "api", serviceName: "api" }
] as const;
const readRuntimeState = (
  path: string,
  deps: Pick<Required<KoedServerStopOptions>, "existsSync" | "readFileSync">
): KoedServerRuntimeState | null => {
  if (!deps.existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(
      String(deps.readFileSync(path, "utf8"))
    ) as KoedServerRuntimeState;
  } catch {
    return null;
  }
};

const defaultCheckPid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const defaultSleepSync = (ms: number): void => {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
};

const waitForPidExit = (
  pid: number,
  deps: Pick<
    Required<KoedServerStopOptions>,
    "checkPid" | "waitForExitMs" | "pollIntervalMs" | "sleepSync"
  >
): boolean => {
  const deadline = Date.now() + deps.waitForExitMs;
  while (deps.checkPid(pid) && Date.now() < deadline) {
    deps.sleepSync(
      Math.min(deps.pollIntervalMs, Math.max(0, deadline - Date.now()))
    );
  }
  return !deps.checkPid(pid);
};

const stopPid = (
  label: string,
  pid: number | undefined,
  deps: Pick<
    Required<KoedServerStopOptions>,
    "kill" | "checkPid" | "waitForExitMs" | "pollIntervalMs" | "sleepSync"
  >
): {
  stoppedPids: number[];
  missingPids: number[];
  errors: Array<{ target: string; error: string }>;
} => {
  if (!pid || pid <= 0) {
    return { stoppedPids: [], missingPids: [], errors: [] };
  }
  try {
    deps.kill(pid, "SIGTERM");
    if (waitForPidExit(pid, deps)) {
      return { stoppedPids: [pid], missingPids: [], errors: [] };
    }
    deps.kill(pid, "SIGKILL");
    if (waitForPidExit(pid, deps)) {
      return { stoppedPids: [pid], missingPids: [], errors: [] };
    }
    return {
      stoppedPids: [pid],
      missingPids: [],
      errors: [
        {
          target: `${label} (${pid})`,
          error: "Timed out waiting for process to stop"
        }
      ]
    };
  } catch (error) {
    if (errorCode(error) === "ESRCH" || !deps.checkPid(pid)) {
      return { stoppedPids: [], missingPids: [pid], errors: [] };
    }
    return {
      stoppedPids: [],
      missingPids: [],
      errors: [{ target: `${label} (${pid})`, error: errorMessage(error) }]
    };
  }
};

const shouldStopNativePostgres = (runtime: KoedServerRuntimeState): boolean =>
  runtime.dependencyMode === "bundled-local" &&
  runtime.services.includes("postgres-native");

export const stopKoedServer = ({
  environment = process.env,
  existsSync: pathExists = nodeExistsSync,
  readFileSync: readFile = readFileSync,
  rmSync: remove = rmSync,
  spawnSync = nodeSpawnSync as SpawnSyncLike,
  kill = (pid, signal) => {
    process.kill(pid, signal);
  },
  checkPid = defaultCheckPid,
  waitForExitMs = 5_000,
  pollIntervalMs = 100,
  sleepSync = defaultSleepSync,
  readSupervisorLock: readLock = readSupervisorLock
}: KoedServerStopOptions = {}): KoedServerStopResult => {
  const paths = resolveKoedServerPaths(environment);
  const runtime = readRuntimeState(paths.runtimeStatePath, {
    existsSync: pathExists,
    readFileSync: readFile
  });

  if (!runtime) {
    return {
      ok: true,
      state: "not_configured",
      koedHome: paths.koedHome,
      message: "No koed-server runtime state was found.",
      stoppedPids: [],
      missingPids: [],
      stoppedServices: [],
      missingServices: []
    };
  }

  const stoppedPids: number[] = [];
  const missingPids: number[] = [];
  const stoppedServices: string[] = [];
  const missingServices: string[] = [];
  const errors: Array<{ target: string; error: string }> = [];

  for (const { processName, serviceName } of APP_PROCESS_ORDER) {
    const pid = runtime.processes?.[processName];
    if (!pid || pid <= 0) {
      if (runtime.services.includes(serviceName)) {
        missingServices.push(serviceName);
      }
      continue;
    }
    const stopped = stopPid(serviceName, pid, {
      kill,
      checkPid,
      waitForExitMs,
      pollIntervalMs,
      sleepSync
    });
    stoppedPids.push(...stopped.stoppedPids);
    missingPids.push(...stopped.missingPids);
    if (stopped.missingPids.length > 0) {
      missingServices.push(serviceName);
    } else if (stopped.stoppedPids.length > 0) {
      stoppedServices.push(serviceName);
    }
    errors.push(...stopped.errors);
  }

  if (runtime.dependencyMode === "bundled-local") {
    const embeddingPid = runtime.processes?.embeddingService;
    if (runtime.services.includes("embedding-service-native")) {
      if (!embeddingPid || embeddingPid <= 0) {
        missingServices.push("embedding-service-native");
      } else {
        const stopped = stopPid("embedding-service-native", embeddingPid, {
          kill,
          checkPid,
          waitForExitMs,
          pollIntervalMs,
          sleepSync
        });
        stoppedPids.push(...stopped.stoppedPids);
        missingPids.push(...stopped.missingPids);
        errors.push(...stopped.errors);
        if (stopped.missingPids.length > 0) {
          missingServices.push("embedding-service-native");
        } else if (stopped.stoppedPids.length > 0) {
          stoppedServices.push("embedding-service-native");
        }
      }
    }

    if (shouldStopNativePostgres(runtime)) {
      const stopped = stopLocalPostgresRuntime(paths, environment, {
        existsSync: pathExists,
        spawnSync
      });
      if (stopped.ok) {
        stoppedServices.push("postgres-native");
      } else {
        errors.push({
          target: "postgres-native",
          error: stopped.error ?? stopped.message
        });
      }
    }
  }

  if (runtime.pid > 0 && runtime.pid !== process.pid && checkPid(runtime.pid)) {
    const lock = readLock(resolve(paths.runDir, "koed-server.lock"));
    if (lock?.pid !== runtime.pid) {
      errors.push({
        target: `supervisor (${runtime.pid})`,
        error: "Runtime state does not match the active supervisor lock"
      });
    } else {
      requestSupervisorExit(paths, {
        pid: runtime.pid,
        startedAt: runtime.startedAt
      });
      if (
        waitForPidExit(runtime.pid, {
          checkPid,
          waitForExitMs,
          pollIntervalMs,
          sleepSync
        })
      ) {
        stoppedPids.push(runtime.pid);
        stoppedServices.push("supervisor");
      } else {
        errors.push({
          target: `supervisor (${runtime.pid})`,
          error: "Timed out waiting for the supervisor to exit naturally"
        });
      }
    }
  }

  if (errors.length === 0) {
    const currentRuntime = readRuntimeState(paths.runtimeStatePath, {
      existsSync: pathExists,
      readFileSync: readFile
    });
    if (
      currentRuntime &&
      (currentRuntime.pid !== runtime.pid ||
        currentRuntime.startedAt !== runtime.startedAt)
    ) {
      errors.push({
        target: "runtime-state",
        error: "Runtime state changed while stop was in progress"
      });
    } else {
      remove(paths.runtimeStatePath as PathLike, { force: true });
    }
  }

  return {
    ok: errors.length === 0,
    state: errors.length === 0 ? "healthy" : "needs_attention",
    koedHome: paths.koedHome,
    message:
      errors.length === 0
        ? "Koed server stop completed."
        : "Koed server stop encountered errors.",
    stoppedPids,
    missingPids,
    stoppedServices,
    missingServices,
    ...(errors.length > 0 ? { errors } : {})
  };
};
