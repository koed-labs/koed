import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { KoedServerPaths } from "../paths.js";
import {
  assertControlPlaneAdmission,
  type ControlPlaneAdmission
} from "./admission.js";

export interface ControlIntent {
  schemaVersion: 1;
  revision: number;
  stopIntent: boolean;
  backgroundEnabled: boolean;
  persistentCli: boolean;
  runtimeClean: boolean;
  protectedGenerationId: string | null;
}

export type IntentChange =
  | { action: "start"; explicit: boolean }
  | { action: "stop"; explicit: boolean }
  | {
      action: "availability";
      backgroundEnabled?: boolean;
      persistentCli?: boolean;
    }
  | { action: "runtime-clean"; clean: boolean; generationId: string | null };

const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  stopIntent: z.boolean(),
  backgroundEnabled: z.boolean(),
  persistentCli: z.boolean(),
  runtimeClean: z.boolean(),
  protectedGenerationId: z.string().min(1).max(256).nullable()
});

export type LegacyStopEvidence =
  | { kind: "absent" }
  | { kind: "valid"; stopIntent: boolean }
  | { kind: "invalid" };

export interface ControlStateStore {
  read(): ControlIntent;
  initialize(
    legacy: LegacyStopEvidence,
    options?: { assumeStopped?: boolean }
  ): void;
  write(next: ControlIntent, expectedRevision: number): void;
}

function assertPrivateDirectory(directory: string): void {
  const stats = lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
    realpathSync(directory) !== directory
  )
    throw new Error("Control state directory is not private");
}

function readState(path: string): ControlIntent {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > 65_536 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    )
      throw new Error("Control state file is not private");
    return stateSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function assertControlStateCleanForPruning(
  paths: KoedServerPaths
): void {
  const directory = resolve(realpathSync(paths.koedHome), "config");
  try {
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("Control state directory is not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const path = resolve(directory, "control-plane-state.json");
  assertNoPendingWrite(path);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertPrivateDirectory(directory);
  const state = readState(path);
  if (!state.runtimeClean)
    throw new Error(
      "Control-plane runtime is unclean; generation pruning is blocked"
    );
}

function assertNoPendingWrite(path: string): void {
  if (poisonedPaths.has(path))
    throw new Error(
      "Control state write is uncertain; Operator attention required"
    );
  try {
    lstatSync(`${path}.pending`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "Control state write is uncertain; Operator attention required"
  );
}

const poisonedPaths = new Set<string>();

function persistState(
  directory: string,
  path: string,
  value: ControlIntent,
  initialize: boolean
): void {
  const marker = `${path}.pending`;
  const temporary = resolve(directory, `.control-state-${randomUUID()}.tmp`);
  let created = false;
  try {
    const markerFd = openSync(marker, "wx", 0o600);
    try {
      fsyncSync(markerFd);
    } finally {
      closeSync(markerFd);
    }
    syncDirectory(directory);
    const fd = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(
        fd,
        `${JSON.stringify(stateSchema.parse(value))}\n`,
        "utf8"
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (initialize) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    created = false;
    syncDirectory(directory);
    unlinkSync(marker);
    syncDirectory(directory);
  } catch (error) {
    poisonedPaths.add(path);
    throw error;
  } finally {
    if (created) unlinkSync(temporary);
  }
}

export function createControlStateStore(
  paths: KoedServerPaths,
  admission: ControlPlaneAdmission
): ControlStateStore {
  const directory = resolve(realpathSync(paths.koedHome), "config");
  const path = resolve(directory, "control-plane-state.json");
  return {
    read() {
      assertControlPlaneAdmission(admission, paths);
      assertPrivateDirectory(directory);
      assertNoPendingWrite(path);
      return readState(path);
    },
    initialize(legacy, options = {}) {
      assertControlPlaneAdmission(admission, paths);
      assertPrivateDirectory(directory);
      assertNoPendingWrite(path);
      try {
        lstatSync(path);
        throw new Error("Control state is already initialized");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (legacy.kind === "invalid")
        throw new Error("Legacy Agent state is invalid");
      persistState(
        directory,
        path,
        {
          schemaVersion: 1,
          revision: 0,
          stopIntent: legacy.kind === "valid" && legacy.stopIntent,
          backgroundEnabled: false,
          persistentCli: false,
          runtimeClean: options.assumeStopped ?? false,
          protectedGenerationId: null
        },
        true
      );
    },
    write(next, expectedRevision) {
      assertControlPlaneAdmission(admission, paths);
      assertPrivateDirectory(directory);
      assertNoPendingWrite(path);
      stateSchema.parse(next);
      const current = readState(path);
      if (
        current.revision !== expectedRevision ||
        next.revision !== expectedRevision + 1
      )
        throw new Error("Stale or invalid control state revision");
      persistState(directory, path, next, false);
    }
  };
}

export function applyControlIntent(
  current: ControlIntent,
  change: IntentChange
): ControlIntent {
  let next: ControlIntent;
  switch (change.action) {
    case "start":
      next = change.explicit ? { ...current, stopIntent: false } : current;
      break;
    case "stop":
      next = change.explicit
        ? { ...current, stopIntent: true, persistentCli: false }
        : current;
      break;
    case "availability":
      next = {
        ...current,
        backgroundEnabled:
          change.backgroundEnabled ?? current.backgroundEnabled,
        persistentCli: change.persistentCli ?? current.persistentCli
      };
      break;
    case "runtime-clean":
      next = {
        ...current,
        runtimeClean: change.clean,
        protectedGenerationId: change.generationId
      };
      break;
  }
  if (
    !(change.action === "stop" && change.explicit) &&
    next.stopIntent === current.stopIntent &&
    next.backgroundEnabled === current.backgroundEnabled &&
    next.persistentCli === current.persistentCli &&
    next.runtimeClean === current.runtimeClean &&
    next.protectedGenerationId === current.protectedGenerationId
  )
    return current;
  if (!Number.isSafeInteger(current.revision + 1))
    throw new Error("control revision overflow");
  return { ...next, revision: current.revision + 1 };
}
