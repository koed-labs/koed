import type { PersonalFolderHint } from "@koed-labs/shared";
import {
  PERSONAL_FOLDER_HINT_BATCH_SIZE,
  type PersonalDesktopApi
} from "@koed-labs/shared/personal-desktop";

/** Hints are cheap to keep and costly to recompute (each reads the disk), and
 * the evidence rarely changes, so a short in-memory cache spares Home and the
 * review list from asking again. */
const DEFAULT_TTL_MS = 30 * 60_000;

export type FolderHintCache = {
  get(sessionId: string): PersonalFolderHint[] | undefined;
  set(sessionId: string, hints: PersonalFolderHint[]): void;
  revision(): number;
  subscribe(listener: () => void): () => void;
  clear(): void;
};

export function createFolderHintCache(
  ttlMs = DEFAULT_TTL_MS,
  now: () => number = Date.now
): FolderHintCache {
  const entries = new Map<
    string,
    { at: number; hints: PersonalFolderHint[] }
  >();
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    get(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) {
        entries.delete(sessionId);
        return undefined;
      }
      return entry.hints;
    },
    set(sessionId, hints) {
      entries.set(sessionId, { at: now(), hints });
    },
    revision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      entries.clear();
      revision++;
      for (const listener of listeners) listener();
    }
  };
}

const cachesByApi = new WeakMap<
  PersonalDesktopApi,
  Map<string, FolderHintCache>
>();

export const folderHintCache = {
  forScope(api: PersonalDesktopApi, scopeKey: string): FolderHintCache {
    let scopes = cachesByApi.get(api);
    if (!scopes) cachesByApi.set(api, (scopes = new Map()));
    let cache = scopes.get(scopeKey);
    if (!cache) scopes.set(scopeKey, (cache = createFolderHintCache()));
    return cache;
  },
  clear(api: PersonalDesktopApi | null, scopeKey: string | null) {
    if (api && scopeKey) cachesByApi.get(api)?.get(scopeKey)?.clear();
  }
};

/** Load hints for many Conversations in bounded batches, reporting each batch as
 * it arrives. A failed batch is skipped, not fatal: hints are only advisory. */
export async function loadFolderHints(
  api: PersonalDesktopApi,
  sessionIds: readonly string[],
  options: {
    cache: FolderHintCache;
    expectedScopeKey: string;
    isCancelled?: () => boolean;
    /** Wait this long between batches, so a long load does not hog the main process. */
    pauseMs?: number;
    onBatch?: (hints: ReadonlyMap<string, PersonalFolderHint[]>) => void;
  }
): Promise<Map<string, PersonalFolderHint[]>> {
  const { cache } = options;
  const revision = cache.revision();
  const stopped = () =>
    revision !== cache.revision() || options.isCancelled?.();
  const result = new Map<string, PersonalFolderHint[]>();
  if (stopped()) return result;
  const missing: string[] = [];
  for (const id of new Set(sessionIds)) {
    const cached = cache.get(id);
    if (cached) result.set(id, cached);
    else missing.push(id);
  }
  if (result.size > 0) options.onBatch?.(new Map(result));
  if (!api.folderHints) return result;
  for (
    let index = 0;
    index < missing.length;
    index += PERSONAL_FOLDER_HINT_BATCH_SIZE
  ) {
    if (stopped()) break;
    if (index > 0 && options.pauseMs)
      await new Promise((done) => setTimeout(done, options.pauseMs));
    if (stopped()) break;
    const batch = missing.slice(index, index + PERSONAL_FOLDER_HINT_BATCH_SIZE);
    let hints: PersonalFolderHint[];
    try {
      hints = await api.folderHints({
        sessionIds: batch,
        expectedScopeKey: options.expectedScopeKey
      });
    } catch {
      continue;
    }
    if (stopped()) break;
    const grouped = new Map(
      batch.map((id) => [id, [] as PersonalFolderHint[]])
    );
    for (const hint of hints) {
      grouped.get(hint.sessionId)?.push(hint);
    }
    // An id the API did not return was still checked.
    for (const [id, list] of grouped) {
      cache.set(id, list);
      result.set(id, list);
    }
    options.onBatch?.(grouped);
  }
  return stopped() ? new Map() : result;
}
