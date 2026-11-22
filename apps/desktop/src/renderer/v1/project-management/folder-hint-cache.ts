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
    clear: () => entries.clear()
  };
}

export const folderHintCache = createFolderHintCache();

/** Load hints for many Conversations in bounded batches, reporting each batch as
 * it arrives. A failed batch is skipped, not fatal: hints are only advisory. */
export async function loadFolderHints(
  api: PersonalDesktopApi,
  sessionIds: readonly string[],
  options: {
    cache?: FolderHintCache;
    isCancelled?: () => boolean;
    /** Wait this long between batches, so a long load does not hog the main process. */
    pauseMs?: number;
    onBatch?: (hints: ReadonlyMap<string, PersonalFolderHint[]>) => void;
  } = {}
): Promise<Map<string, PersonalFolderHint[]>> {
  const cache = options.cache ?? folderHintCache;
  const result = new Map<string, PersonalFolderHint[]>();
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
    if (options.isCancelled?.()) break;
    if (index > 0 && options.pauseMs)
      await new Promise((done) => setTimeout(done, options.pauseMs));
    if (options.isCancelled?.()) break;
    const batch = missing.slice(index, index + PERSONAL_FOLDER_HINT_BATCH_SIZE);
    let hints: PersonalFolderHint[];
    try {
      hints = await api.folderHints({ sessionIds: batch });
    } catch {
      continue;
    }
    const grouped = new Map<string, PersonalFolderHint[]>();
    for (const hint of hints) {
      const list = grouped.get(hint.sessionId) ?? [];
      list.push(hint);
      grouped.set(hint.sessionId, list);
    }
    // An id the API did not return has no candidate: remember that too.
    for (const id of batch) {
      const list = grouped.get(id) ?? [];
      cache.set(id, list);
      result.set(id, list);
    }
    options.onBatch?.(new Map(grouped));
  }
  return result;
}
