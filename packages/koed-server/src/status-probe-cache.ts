import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import type {
  spawnSync as nodeSpawnSync,
  SpawnSyncReturns
} from "node:child_process";

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

/**
 * `koed status` asks each AI Client CLI for its version, its Koed MCP entry
 * and its sign-in state, and runs the MCP doctor. Every one of those is a
 * separate program; together they take 10-20 seconds on a busy Mac, and
 * Desktop asks for status every few seconds. Their answers rarely change, so
 * status reuses an answer for a short while. Any other koed command (setup,
 * repair, start, stop, ...) clears the cache first, so changes Koed makes
 * show at once; changes made outside Koed show within the reuse window.
 */
export const statusProbeReuseMs = 60_000;
/** A probe that timed out is retried sooner. */
const timedOutReuseMs = 15_000;
const maxEntries = 64;

type CachedResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: { code?: string; message: string };
};
type CacheFile = {
  version: 1;
  entries: Record<string, { at: number; result: CachedResult }>;
};

const cachePath = (cacheDir: string): string =>
  resolve(cacheDir, "status-probes.json");

const readCache = (path: string): CacheFile => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed?.version === 1 && parsed.entries) return parsed;
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: 1, entries: {} };
};

const writeCache = (path: string, cache: CacheFile): void => {
  try {
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Caching is only an optimisation.
  }
};

const probeKey = (
  command: string,
  args: string[],
  options: Parameters<typeof nodeSpawnSync>[2]
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        command,
        args,
        options?.cwd ?? null,
        options?.env
          ? Object.entries(options.env)
              .filter(([, value]) => value !== undefined)
              .sort(([left], [right]) => left.localeCompare(right))
          : null
      ])
    )
    .digest("hex");

const timedOut = (result: CachedResult): boolean =>
  result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";

export const clearStatusProbeCache = (cacheDir: string): void => {
  try {
    rmSync(cachePath(cacheDir), { force: true });
  } catch {
    // Nothing to clear.
  }
};

export const cachedStatusProbeSpawnSync = (
  cacheDir: string,
  spawnSync: SpawnSyncLike,
  now: () => number = Date.now
): SpawnSyncLike => {
  const path = cachePath(cacheDir);
  return (command, args, options) => {
    const key = probeKey(command, args, options);
    const cache = readCache(path);
    const hit = cache.entries[key];
    const at = now();
    if (
      hit &&
      at - hit.at <
        (timedOut(hit.result) ? timedOutReuseMs : statusProbeReuseMs) &&
      at >= hit.at
    ) {
      const { error, ...rest } = hit.result;
      return {
        pid: 0,
        output: [null, rest.stdout, rest.stderr],
        ...rest,
        ...(error
          ? { error: Object.assign(new Error(error.message), error) }
          : {})
      } as SpawnSyncReturns<string>;
    }
    const result = spawnSync(command, args, options);
    // Only text answers can be replayed faithfully.
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string")
      return result;
    const fresh = readCache(path);
    fresh.entries[key] = {
      at,
      result: {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.error
          ? {
              error: {
                message: result.error.message,
                ...((result.error as NodeJS.ErrnoException).code
                  ? { code: (result.error as NodeJS.ErrnoException).code }
                  : {})
              }
            }
          : {})
      }
    };
    const keys = Object.keys(fresh.entries).sort(
      (left, right) => fresh.entries[right]!.at - fresh.entries[left]!.at
    );
    for (const stale of keys.slice(maxEntries)) delete fresh.entries[stale];
    writeCache(path, fresh);
    return result;
  };
};
