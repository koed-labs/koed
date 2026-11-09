import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeOwner } from "./component-contract.js";
import type { KoedServerPaths } from "./paths.js";
import { isProcessRunning as defaultIsProcessRunning } from "./process-liveness.js";
import { isRuntimeGenerationState } from "./runtime-state.js";
import {
  readSupervisorLock,
  resolveProcessIdentity as defaultResolveProcessIdentity
} from "./supervisor-lock.js";

export interface RuntimeLifecycleObservation {
  state: "stopped" | "starting" | "running" | "unavailable";
  // Changes whenever a different supervisor process owns KOED_HOME.
  epoch: string;
  message: string;
  pid?: number;
  processIdentity?: string;
  // Packaged generation pin or source owner bound to the live supervisor lock.
  owner?: RuntimeOwner | null;
  generationId?: string;
}

export interface RuntimeLifecycleDependencies {
  resolveProcessIdentity?: (pid: number) => string | null;
  isProcessRunning?: (pid: number) => boolean;
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

// Cheap read-only inspection for frequent polling. It never verifies bundles,
// contacts services, or removes stale files; destructive and management paths
// must still verify ownership through their own authority.
export function observeRuntimeLifecycle(
  paths: KoedServerPaths,
  {
    resolveProcessIdentity = defaultResolveProcessIdentity,
    isProcessRunning = defaultIsProcessRunning
  }: RuntimeLifecycleDependencies = {}
): RuntimeLifecycleObservation {
  const lockPath = resolve(paths.runDir, "koed-server.lock");
  if (!existsSync(lockPath))
    return {
      state: "stopped",
      epoch: "stopped",
      message: "Koed is not running."
    };
  const lock = readSupervisorLock(lockPath);
  if (!lock)
    return {
      state: "unavailable",
      epoch: "unavailable",
      message: "Koed supervisor lock is unreadable."
    };
  const identity = resolveProcessIdentity(lock.pid);
  if (!identity) {
    return isProcessRunning(lock.pid)
      ? {
          state: "unavailable",
          epoch: "unavailable",
          message: "Koed supervisor identity could not be verified.",
          pid: lock.pid
        }
      : { state: "stopped", epoch: "stopped", message: "Koed is not running." };
  }
  if (lock.processIdentity !== identity)
    return {
      state: "stopped",
      epoch: "stopped",
      message: "Koed is not running."
    };
  const epoch = `${lock.pid}:${identity}`;
  const pinPath =
    paths.generationStatePath ??
    resolve(paths.runDir, "runtime-generation.json");
  const pin = readJson(pinPath);
  const pinned =
    isRuntimeGenerationState(pin) &&
    pin.pid === lock.pid &&
    pin.processIdentity === identity
      ? pin
      : null;
  const runtime = readJson(paths.runtimeStatePath) as
    | { pid?: unknown }
    | undefined;
  // A malformed or foreign generation record must not fall back to source
  // authority. Source ownership is valid only for the identified live process.
  const owner =
    pinned?.owner ??
    (!lstatSync(pinPath, { throwIfNoEntry: false }) ? lock.sourceOwner : null);
  const running = !!owner && runtime?.pid === lock.pid;
  return {
    state: running ? "running" : "starting",
    epoch,
    message: running ? "Koed is running." : "Koed is starting.",
    pid: lock.pid,
    processIdentity: identity,
    owner: owner ? { ...owner } : null,
    ...(pinned ? { generationId: pinned.generationId } : {})
  };
}

export const runtimeOwnedBy = (
  observation: RuntimeLifecycleObservation,
  owner: RuntimeOwner
): boolean =>
  Boolean(
    observation.owner &&
    observation.owner.kind === owner.kind &&
    observation.owner.installationId === owner.installationId
  );
