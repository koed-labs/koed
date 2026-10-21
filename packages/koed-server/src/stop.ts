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
import {
  resolveKoedAppRuntimeExecution,
  resolveKoedRuntimeOwner
} from "./app-runtime.js";
import type { RuntimeOwner } from "./component-contract.js";
import {
  resolveDesktopRuntimeOwner,
  type DesktopRuntimeCapability
} from "./desktop-runtime-capability.js";
import { environmentWithRepoEnv } from "./env-file.js";
import { stopLocalPostgresRuntime } from "./local-postgres-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  isRuntimeGenerationState,
  type RuntimeGenerationState
} from "./runtime-state.js";
import {
  readSupervisorLock,
  resolveProcessIdentity as defaultResolveProcessIdentity
} from "./supervisor-lock.js";
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
  resolveProcessIdentity?: (pid: number) => string | null;
  desktopRuntimeCapability?: DesktopRuntimeCapability;
}

const APP_PROCESS_ORDER = [
  {
    processName: "localAiRuntime",
    serviceName: "local-ai-runtime"
  },
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

const readRuntimeGeneration = (
  path: string,
  deps: Pick<Required<KoedServerStopOptions>, "existsSync" | "readFileSync">
): RuntimeGenerationState | null => {
  if (!deps.existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(String(deps.readFileSync(path, "utf8")));
    return isRuntimeGenerationState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const expectedRuntimeOwner = (
  capability: DesktopRuntimeCapability | undefined,
  koedHome: string
): RuntimeOwner =>
  capability
    ? resolveDesktopRuntimeOwner(capability, koedHome)
    : resolveKoedRuntimeOwner();

const ownersMatch = (left: RuntimeOwner, right: RuntimeOwner): boolean =>
  left.kind === right.kind && left.installationId === right.installationId;

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
  > & {
    expectedProcessIdentity?: string;
    resolveProcessIdentity?: (pid: number) => string | null;
  }
): {
  stoppedPids: number[];
  missingPids: number[];
  errors: Array<{ target: string; error: string }>;
} => {
  if (!pid || pid <= 0) {
    return { stoppedPids: [], missingPids: [], errors: [] };
  }
  const identityMatches = (): boolean =>
    !deps.expectedProcessIdentity ||
    deps.resolveProcessIdentity?.(pid) === deps.expectedProcessIdentity;
  const identityError = () => ({
    stoppedPids: [],
    missingPids: [],
    errors: [
      {
        target: `${label} (${pid})`,
        error: "Process identity changed before signaling"
      }
    ]
  });
  if (deps.expectedProcessIdentity && !deps.checkPid(pid))
    return { stoppedPids: [], missingPids: [pid], errors: [] };
  if (!identityMatches()) return identityError();
  try {
    deps.kill(pid, "SIGTERM");
    if (waitForPidExit(pid, deps)) {
      return { stoppedPids: [pid], missingPids: [], errors: [] };
    }
    if (!identityMatches()) return identityError();
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
  readSupervisorLock: readLock = readSupervisorLock,
  resolveProcessIdentity = defaultResolveProcessIdentity,
  desktopRuntimeCapability
}: KoedServerStopOptions = {}): KoedServerStopResult => {
  const paths = resolveKoedServerPaths(environment);
  const runtimeEnvironment = environmentWithRepoEnv(
    paths.repoRoot,
    environment
  );
  const runtime = readRuntimeState(paths.runtimeStatePath, {
    existsSync: pathExists,
    readFileSync: readFile
  });

  if (!runtime) {
    return {
      ok: true,
      state: "not_configured",
      koedHome: paths.koedHome,
      message: "No koed runtime state was found.",
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
  let supervisorStoppedGracefully = false;
  let supervisorLockMatches = true;
  let expectedSupervisorIdentity: string | undefined;
  const supervisorLockPath = resolve(paths.runDir, "koed-server.lock");
  const owner = expectedRuntimeOwner(desktopRuntimeCapability, paths.koedHome);
  const ownerPinRequired =
    desktopRuntimeCapability !== undefined ||
    resolveKoedAppRuntimeExecution() === "packaged";
  const isExpectedSupervisorRunning = (identity: string): boolean => {
    const lock = readLock(supervisorLockPath);
    return (
      lock?.pid === runtime.pid &&
      lock.processIdentity === identity &&
      checkPid(runtime.pid) &&
      resolveProcessIdentity(runtime.pid) === identity
    );
  };
  const markSupervisorIdentityUnverified = (): void => {
    if (!supervisorLockMatches) return;
    supervisorLockMatches = false;
    errors.push({
      target: `supervisor (${runtime.pid})`,
      error:
        "Supervisor identity changed during stop; refusing fallback signals"
    });
  };
  const canSignalFallbackProcesses = (): boolean => {
    if (!supervisorLockMatches) return false;
    if (
      expectedSupervisorIdentity &&
      !isExpectedSupervisorRunning(expectedSupervisorIdentity)
    ) {
      markSupervisorIdentityUnverified();
      return false;
    }
    return true;
  };
  const pinPath =
    paths.generationStatePath ??
    resolve(paths.runDir, "runtime-generation.json");
  const pinExists = pathExists(pinPath);
  const pin = readRuntimeGeneration(pinPath, {
    existsSync: pathExists,
    readFileSync: readFile
  });
  const lock = readLock(supervisorLockPath);
  const supervisorRunning = runtime.pid > 0 && checkPid(runtime.pid);
  const processIdentity = supervisorRunning
    ? resolveProcessIdentity(runtime.pid)
    : null;
  if (
    (ownerPinRequired && !pin) ||
    (pinExists && !pin) ||
    (pin !== null &&
      (pin.pid !== runtime.pid ||
        !ownersMatch(pin.owner, owner) ||
        lock?.pid !== runtime.pid ||
        !lock.processIdentity ||
        pin.processIdentity !== lock.processIdentity ||
        (supervisorRunning && processIdentity !== pin.processIdentity)))
  ) {
    supervisorLockMatches = false;
    errors.push({
      target: `supervisor (${runtime.pid})`,
      error:
        "Runtime owner and process identity could not be verified; refusing to stop"
    });
  } else if (pin) {
    expectedSupervisorIdentity = pin.processIdentity;
  }

  if (runtime.pid > 0 && runtime.pid !== process.pid && checkPid(runtime.pid)) {
    const lock = readLock(supervisorLockPath);
    if (!supervisorLockMatches) {
      // Owner verification already failed; preserve uncertain runtime state.
    } else if (lock?.pid !== runtime.pid) {
      supervisorLockMatches = false;
      errors.push({
        target: `supervisor (${runtime.pid})`,
        error: "Runtime state does not match the active supervisor lock"
      });
    } else if (!lock.processIdentity) {
      supervisorLockMatches = false;
      errors.push({
        target: `supervisor (${runtime.pid})`,
        error: "Supervisor process identity is missing from its lock"
      });
    } else if (resolveProcessIdentity(runtime.pid) !== lock.processIdentity) {
      // A reused PID is not the supervisor that wrote these files.
      supervisorLockMatches = false;
      errors.push({
        target: `supervisor (${runtime.pid})`,
        error: "Supervisor process identity does not match its lock"
      });
    } else {
      expectedSupervisorIdentity = lock.processIdentity;
      requestSupervisorExit(paths, {
        pid: runtime.pid,
        startedAt: runtime.startedAt
      });
      supervisorStoppedGracefully = waitForPidExit(runtime.pid, {
        checkPid,
        waitForExitMs,
        pollIntervalMs,
        sleepSync
      });
      if (supervisorStoppedGracefully) {
        stoppedPids.push(
          ...Object.values(runtime.processes ?? {}).filter(
            (pid): pid is number => typeof pid === "number" && pid > 0
          ),
          runtime.pid
        );
        stoppedServices.push(...runtime.services, "supervisor");
      }
    }
  }

  if (!supervisorStoppedGracefully) canSignalFallbackProcesses();

  if (!supervisorStoppedGracefully && supervisorLockMatches) {
    for (const { processName, serviceName } of APP_PROCESS_ORDER) {
      if (!canSignalFallbackProcesses()) break;
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
      if (
        canSignalFallbackProcesses() &&
        runtime.services.includes("embedding-service-native")
      ) {
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

      if (canSignalFallbackProcesses() && shouldStopNativePostgres(runtime)) {
        const stopped = stopLocalPostgresRuntime(paths, runtimeEnvironment, {
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
  }

  if (
    !supervisorStoppedGracefully &&
    canSignalFallbackProcesses() &&
    runtime.pid > 0 &&
    runtime.pid !== process.pid &&
    checkPid(runtime.pid)
  ) {
    const stopped = stopPid("supervisor", runtime.pid, {
      kill,
      checkPid,
      waitForExitMs,
      pollIntervalMs,
      sleepSync,
      expectedProcessIdentity: expectedSupervisorIdentity,
      resolveProcessIdentity
    });
    stoppedPids.push(...stopped.stoppedPids);
    missingPids.push(...stopped.missingPids);
    errors.push(...stopped.errors);
    if (stopped.missingPids.length > 0) {
      missingServices.push("supervisor");
    } else if (stopped.stoppedPids.length > 0) {
      stoppedServices.push("supervisor");
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
