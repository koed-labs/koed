import { threadSelectionKey } from "./graph";
import type { GraphEvent, ThreadGroup } from "./types";

export const threadDetailCacheLimit = 32;
export const threadDetailRetentionMs = 15 * 60 * 1000;
export const prewarmThreadLimit = 10;
export const prewarmNearbyRadius = 2;
export const prewarmConcurrency = 2;
export const prewarmQueueLimit = 16;
export const prewarmThreadEventLimit = 80;
export const selectedThreadHeadEventLimit = 50;
export const selectedThreadEventPageSize = 500;

export type ThreadDetailCompleteness = "partial" | "complete";
export type ThreadDetailStatus = "idle" | "loading" | "ready" | "error";

export interface ThreadDetailCacheEntry {
  completeness: ThreadDetailCompleteness;
  error?: string | undefined;
  events: GraphEvent[];
  inFlightCompleteness?: ThreadDetailCompleteness | undefined;
  inFlight?: Promise<GraphEvent[]> | undefined;
  lastAccessedAt: number;
  loadedAt: number;
  status: ThreadDetailStatus;
  thread: ThreadGroup;
}

export type ThreadDetailCache = Map<string, ThreadDetailCacheEntry>;

export const threadKey = (thread: Pick<ThreadGroup, "projectId" | "id">) =>
  threadSelectionKey(thread);

export function getCachedThreadEvents(
  cache: ThreadDetailCache,
  thread: Pick<ThreadGroup, "projectId" | "id"> | undefined
) {
  if (!thread) {
    return [];
  }
  return cache.get(threadKey(thread))?.events ?? [];
}

export function markThreadAccessed(
  cache: ThreadDetailCache,
  thread: ThreadGroup,
  now = Date.now()
) {
  const key = threadKey(thread);
  const entry = cache.get(key);
  if (entry) {
    entry.thread = thread;
    entry.lastAccessedAt = now;
    return entry;
  }
  const created: ThreadDetailCacheEntry = {
    completeness: "partial",
    events: [],
    lastAccessedAt: now,
    loadedAt: 0,
    status: "idle",
    thread
  };
  cache.set(key, created);
  return created;
}

export const isWarmThreadDetail = (
  entry: ThreadDetailCacheEntry | undefined,
  now = Date.now(),
  options: { requireComplete?: boolean } = {}
) =>
  Boolean(
    entry &&
    entry.status === "ready" &&
    (!options.requireComplete || isCompleteThreadDetail(entry)) &&
    now - entry.loadedAt < threadDetailRetentionMs
  );

export const isCompleteThreadDetail = (
  entry: ThreadDetailCacheEntry | undefined
) =>
  Boolean(
    entry &&
    (entry.completeness === "complete" ||
      entry.events.length >= entry.thread.eventCount)
  );

export function writeThreadEvents(
  cache: ThreadDetailCache,
  thread: ThreadGroup,
  events: GraphEvent[],
  now = Date.now(),
  completeness: ThreadDetailCompleteness = "complete",
  options: { inferComplete?: boolean } = {}
) {
  const entry = markThreadAccessed(cache, thread, now);
  const inferComplete = options.inferComplete ?? true;
  entry.completeness =
    completeness === "complete" ||
    (inferComplete && events.length >= thread.eventCount)
      ? "complete"
      : "partial";
  entry.error = undefined;
  entry.events = events;
  entry.inFlightCompleteness = undefined;
  entry.inFlight = undefined;
  entry.loadedAt = now;
  entry.status = "ready";
  return entry;
}

export function writeThreadError(
  cache: ThreadDetailCache,
  thread: ThreadGroup,
  error: unknown,
  now = Date.now()
) {
  const entry = markThreadAccessed(cache, thread, now);
  entry.error = error instanceof Error ? error.message : String(error);
  entry.inFlightCompleteness = undefined;
  entry.inFlight = undefined;
  entry.status = "error";
  return entry;
}

export function pruneThreadDetailCache(
  cache: ThreadDetailCache,
  options: {
    now?: number;
    protectedKeys?: ReadonlySet<string>;
  } = {}
) {
  const now = options.now ?? Date.now();
  const protectedKeys = options.protectedKeys ?? new Set<string>();

  for (const [key, entry] of cache) {
    if (
      protectedKeys.has(key) ||
      entry.inFlight ||
      now - entry.lastAccessedAt <= threadDetailRetentionMs
    ) {
      continue;
    }
    cache.delete(key);
  }

  if (cache.size <= threadDetailCacheLimit) {
    return;
  }

  const removable = [...cache.entries()]
    .filter(([key, entry]) => !protectedKeys.has(key) && !entry.inFlight)
    .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
  for (const [key] of removable) {
    if (cache.size <= threadDetailCacheLimit) {
      break;
    }
    cache.delete(key);
  }
}
