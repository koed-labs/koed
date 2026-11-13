import type { Stats } from "node:fs";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const stateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    installationId: z.uuid(),
    bundlePath: z.string().min(1),
    koedHome: z.string().min(1),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["stopped", "starting", "ready", "needs_attention"]),
    stopIntent: z.boolean(),
    updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)))
  })
  .refine(
    (state) =>
      !state.stopIntent ||
      state.state === "stopped" ||
      state.state === "needs_attention"
  );

export type BackgroundAgentState = z.infer<typeof stateSchema>;
export type BackgroundAgentInstallation = {
  installationId?: string;
  bundlePath: string;
  koedHome: string;
};
export type BackgroundAgentStateRead =
  | { kind: "missing" }
  | { kind: "valid"; state: BackgroundAgentState }
  | { kind: "invalid"; reason: string };

export interface BackgroundAgentStateStore {
  readonly statePath: string;
  read(): BackgroundAgentStateRead;
  initialize(): BackgroundAgentState;
  recover(): BackgroundAgentState;
  start(input: {
    expectedGeneration: number;
    explicit: boolean;
  }): BackgroundAgentState;
  markReady(expectedGeneration: number): BackgroundAgentState;
  markNeedsAttention(expectedGeneration: number): BackgroundAgentState;
  markStopNeedsAttention(expectedGeneration: number): BackgroundAgentState;
  stop(expectedGeneration: number, explicit?: boolean): BackgroundAgentState;
}

export const createBackgroundAgentStateStore = (input: {
  installation: BackgroundAgentInstallation;
  now?: () => Date;
}): BackgroundAgentStateStore => new BackgroundAgentStateStoreImpl(input);

class BackgroundAgentStateStoreImpl implements BackgroundAgentStateStore {
  readonly statePath: string;
  private readonly runDirectory: string;
  private readonly installation: BackgroundAgentInstallation;
  private readonly now: () => Date;

  constructor(input: {
    installation: BackgroundAgentInstallation;
    now?: () => Date;
  }) {
    this.installation = canonicalInstallation(input.installation);
    this.runDirectory = join(this.installation.koedHome, "run");
    this.statePath = join(this.runDirectory, "background-agent-state.json");
    this.now = input.now ?? (() => new Date());
  }

  read(): BackgroundAgentStateRead {
    try {
      this.ensurePrivateRunDirectory(false);
      const stats = lstatSync(this.statePath);
      if (!isSafeStateFile(stats))
        return { kind: "invalid", reason: "unsafe_state_file" };
      const parsed = stateSchema.safeParse(
        JSON.parse(readFileSync(this.statePath, "utf8"))
      );
      if (!parsed.success) return { kind: "invalid", reason: "invalid_schema" };
      if (!sameInstallation(parsed.data, this.installation))
        return { kind: "invalid", reason: "installation_mismatch" };
      return { kind: "valid", state: parsed.data };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { kind: "missing" };
      return { kind: "invalid", reason: "unreadable_state" };
    }
  }

  initialize(): BackgroundAgentState {
    const current = this.read();
    if (current.kind === "valid")
      throw new Error("Background Agent state is already initialized.");
    if (current.kind === "invalid") throw invalidStateError();
    const initial: BackgroundAgentState = {
      schemaVersion: 1,
      installationId: this.installation.installationId ?? randomUUID(),
      bundlePath: this.installation.bundlePath,
      koedHome: this.installation.koedHome,
      generation: 0,
      state: "stopped",
      stopIntent: false,
      updatedAt: this.now().toISOString()
    };
    this.writeState(initial);
    return initial;
  }

  recover(): BackgroundAgentState {
    const current = requireValidState(this.read());
    if (current.stopIntent)
      throw new Error(
        "Explicit Start is required to clear the Background Agent stop intent."
      );
    if (current.state === "needs_attention")
      throw new Error(
        "Explicit Start is required to retry a Background Agent needing attention."
      );
    return this.beginGeneration(current);
  }

  start(input: {
    expectedGeneration: number;
    explicit: boolean;
  }): BackgroundAgentState {
    const current = requireValidState(this.read());
    assertGeneration(current, input.expectedGeneration);
    if (current.stopIntent && !input.explicit)
      throw new Error(
        "Explicit Start is required to clear the Background Agent stop intent."
      );
    if (current.state === "ready" || current.state === "starting")
      return current;
    return this.beginGeneration(current);
  }

  markReady(expectedGeneration: number): BackgroundAgentState {
    const current = requireValidState(this.read());
    assertGeneration(current, expectedGeneration);
    if (current.stopIntent || current.state !== "starting")
      throw new Error("Background Agent start is no longer current.");
    return this.persist({
      ...current,
      state: "ready",
      updatedAt: this.now().toISOString()
    });
  }

  markNeedsAttention(expectedGeneration: number): BackgroundAgentState {
    const current = requireValidState(this.read());
    assertGeneration(current, expectedGeneration);
    if (current.stopIntent)
      throw new Error("Stopped Background Agent cannot change runtime state.");
    return this.persist({
      ...current,
      state: "needs_attention",
      updatedAt: this.now().toISOString()
    });
  }

  markStopNeedsAttention(expectedGeneration: number): BackgroundAgentState {
    const current = requireValidState(this.read());
    assertGeneration(current, expectedGeneration);
    if (!current.stopIntent)
      throw new Error("Background Agent stop intent is not set.");
    return this.persist({
      ...current,
      state: "needs_attention",
      updatedAt: this.now().toISOString()
    });
  }

  stop(expectedGeneration: number, explicit = true): BackgroundAgentState {
    const current = requireValidState(this.read());
    assertGeneration(current, expectedGeneration);
    if (current.stopIntent && current.state === "stopped") return current;
    return this.persist({
      ...current,
      generation: nextGeneration(current.generation),
      state: "stopped",
      stopIntent: current.stopIntent || explicit,
      updatedAt: this.now().toISOString()
    });
  }

  private beginGeneration(current: BackgroundAgentState) {
    return this.persist({
      ...current,
      generation: nextGeneration(current.generation),
      state: "starting",
      stopIntent: false,
      updatedAt: this.now().toISOString()
    });
  }

  private persist(state: BackgroundAgentState) {
    this.writeState(state);
    return state;
  }

  private writeState(state: BackgroundAgentState): void {
    this.ensurePrivateRunDirectory(true);
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaryPath, this.statePath);
      chmodSync(this.statePath, 0o600);
      this.syncDirectory();
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT")
          throw new AggregateError(
            [error, cleanupError],
            "Background Agent state write and cleanup failed.",
            { cause: cleanupError }
          );
      }
      throw error;
    }
  }

  private syncDirectory() {
    const directoryFd = openSync(this.runDirectory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }

  private ensurePrivateRunDirectory(create: boolean) {
    if (create) mkdirSync(this.runDirectory, { recursive: true, mode: 0o700 });
    const stats = lstatSync(this.runDirectory);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (stats.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        stats.uid !== process.getuid()) ||
      realpathSync(this.runDirectory) !== this.runDirectory
    ) {
      throw new Error("Background Agent state directory is not private.");
    }
  }
}

const canonicalInstallation = (
  installation: BackgroundAgentInstallation
): BackgroundAgentInstallation => {
  if (
    installation.installationId !== undefined &&
    !z.uuid().safeParse(installation.installationId).success
  ) {
    throw new Error("Background Agent installation ID is invalid.");
  }
  if (
    !isAbsolute(installation.bundlePath) ||
    !isAbsolute(installation.koedHome)
  )
    throw new Error("Background Agent installation paths must be absolute.");
  const bundlePath = resolve(installation.bundlePath);
  const koedHome = resolve(installation.koedHome);
  if (
    bundlePath !== installation.bundlePath ||
    koedHome !== installation.koedHome ||
    realpathSync(koedHome) !== koedHome
  ) {
    throw new Error("Background Agent installation paths must be canonical.");
  }
  return {
    ...(installation.installationId
      ? { installationId: installation.installationId }
      : {}),
    bundlePath,
    koedHome
  };
};

const isSafeStateFile = (stats: Stats) =>
  stats.isFile() &&
  !stats.isSymbolicLink() &&
  (stats.mode & 0o077) === 0 &&
  stats.size <= 8 * 1024 &&
  (typeof process.getuid !== "function" || stats.uid === process.getuid());

const sameInstallation = (
  state: BackgroundAgentState,
  installation: BackgroundAgentInstallation
) =>
  (installation.installationId === undefined ||
    state.installationId === installation.installationId) &&
  state.bundlePath === installation.bundlePath &&
  state.koedHome === installation.koedHome;

const requireValidState = (result: BackgroundAgentStateRead) => {
  if (result.kind === "missing")
    throw new Error("Background Agent state is not initialized.");
  if (result.kind === "invalid") throw invalidStateError();
  return result.state;
};

const invalidStateError = () => new Error("Background Agent state is invalid.");

const assertGeneration = (
  state: BackgroundAgentState,
  expectedGeneration: number
) => {
  if (state.generation !== expectedGeneration)
    throw new Error("Background Agent generation is stale.");
};

const nextGeneration = (generation: number) => {
  if (generation >= Number.MAX_SAFE_INTEGER)
    throw new Error("Background Agent generation is exhausted.");
  return generation + 1;
};

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
