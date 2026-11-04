import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";
import { isRuntimeGenerationState } from "./runtime-state.js";
import { resolveProcessIdentity } from "./supervisor-lock.js";

export interface StoppedRuntimeObservation {
  state: "stopped" | "running" | "uncertain";
  message: string;
  pid?: number;
}

interface ProcessEvidence {
  pid: number;
  command: string;
}

export interface StoppedRuntimeDependencies {
  processState?: (pid: number) => StoppedRuntimeObservation["state"];
  processIdentity?: (pid: number) => string | null;
  processes?: () => ProcessEvidence[];
}

const processState = (pid: number): StoppedRuntimeObservation["state"] => {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "stopped"
      : "uncertain";
  }
};

const processSnapshot = (): ProcessEvidence[] => {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0 || !result.stdout.trim())
    throw new Error("Native process discovery failed.");
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) throw new Error("Native process discovery was incomplete.");
      return { pid: Number(match[1]), command: match[2]! };
    });
};

// The caller checks parent directories under the lifecycle exclusion. Opening
// with O_NOFOLLOW also rejects dangling state-file links instead of ignoring them.
const readState = (path: string): string | null => {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Runtime state is not a bounded regular file.");
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// Unlike the cheap status observer, this is a strict mutation precondition. It
// does not remove stale evidence, signal processes, or contact production services.
export function observeStoppedRuntime(
  paths: KoedServerPaths,
  dependencies: StoppedRuntimeDependencies = {}
): StoppedRuntimeObservation {
  const stateOf = dependencies.processState ?? processState;
  const identify = dependencies.processIdentity ?? resolveProcessIdentity;
  const uncertain = (message: string): StoppedRuntimeObservation => ({
    state: "uncertain",
    message
  });
  try {
    for (const name of ["koed-server.lock", "runtime-generation.json"]) {
      const path =
        name === "runtime-generation.json"
          ? (paths.generationStatePath ?? resolve(paths.runDir, name))
          : resolve(paths.runDir, name);
      const contents = readState(path);
      if (contents === null) continue;
      const value: unknown = JSON.parse(contents);
      if (
        !isRecord(value) ||
        !isPid(value.pid) ||
        typeof value.processIdentity !== "string" ||
        (name === "runtime-generation.json" && !isRuntimeGenerationState(value))
      )
        return uncertain(`${name} is unreadable or lacks process identity.`);
      const identity = identify(value.pid);
      if (identity && identity === value.processIdentity)
        return {
          state: "running",
          pid: value.pid,
          message: "Koed is running or pinned."
        };
      return uncertain(
        `${name} is stale or its process identity is uncertain. Operator recovery is required.`
      );
    }

    const runtime = readState(paths.runtimeStatePath);
    if (runtime !== null) {
      const value: unknown = JSON.parse(runtime);
      if (
        !isRecord(value) ||
        !isPid(value.pid) ||
        (value.processes !== undefined && !isRecord(value.processes))
      )
        return uncertain("Koed runtime process state is unreadable.");
      const pids: unknown[] = [
        value.pid,
        ...Object.values(value.processes ?? {})
      ];
      for (const pid of pids) {
        // Existing startup records use zero until a child has a PID.
        if (pid === 0) continue;
        if (!isPid(pid))
          return uncertain("Koed runtime contains an invalid process ID.");
        if (stateOf(pid) !== "stopped")
          return {
            state: "uncertain",
            pid,
            message:
              "A recorded Koed process is live or its identity is uncertain."
          };
      }
    }

    const postmaster = readState(
      resolve(paths.postgresDataDir, "postmaster.pid")
    );
    if (postmaster !== null) {
      const line = postmaster.split("\n")[0]!;
      if (!/^-?[1-9]\d*$/.test(line) || !isPid(Math.abs(Number(line))))
        return uncertain("Postgres process state is unreadable.");
      const pid = Math.abs(Number(line));
      return {
        state: "uncertain",
        pid,
        message:
          "Postgres retains a process lock. Stop Postgres or complete Operator recovery before changing its runtime."
      };
    }

    // A supervisor can die before recording its children. Inspect paths too,
    // including native payloads reached through selection links. A match without
    // recorded process identity is uncertain, never authority to stop the process.
    const roots = [resolve(paths.koedHome, "runtime"), paths.postgresDataDir];
    const patterns = roots.map(
      (root) =>
        new RegExp(
          `(?:^|[\\s"'])${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[/\\s"']|$)`
        )
    );
    const native = (dependencies.processes ?? processSnapshot)().find(
      ({ pid, command }) =>
        pid !== process.pid && patterns.some((pattern) => pattern.test(command))
    );
    if (native)
      return {
        state: "uncertain",
        pid: native.pid,
        message:
          "A process still references this native runtime or Postgres data directory."
      };
    return {
      state: "stopped",
      message: "Koed and its recorded native processes are stopped."
    };
  } catch {
    return uncertain(
      "Stopped runtime state could not be established. Inspect process state and runtime files before retrying."
    );
  }
}
