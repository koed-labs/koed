import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { PersonalFolderHint } from "@koed-labs/shared";
import type { SupportedAiClientDriverId } from "@koed-labs/shared/ai-client-contract";
import {
  PERSONAL_FOLDER_HINT_BATCH_SIZE,
  type PersonalDesktopApi,
  type PersonalDesktopProjectThread
} from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { conversationClient } from "../conversation/presentation.js";
import {
  folderHintCache,
  loadFolderHints,
  type FolderHintCache
} from "./folder-hint-cache.js";
import {
  folderProposal,
  type FolderProposal
} from "./folder-hint-suggestion.js";
import { proposalResolvers } from "./proposal-resolvers.js";

type Candidate = {
  sessionId: string;
  title: string;
  /** The AI Client that recorded the Conversation, for its logo. */
  client?: SupportedAiClientDriverId;
  /** Latest activity, for the age shown beside the title. */
  latestAt?: string;
};

export type SuggestionRow = Candidate & { proposal: FolderProposal };

export const clientOf = (
  source: PersonalDesktopProjectThread["sourceAiClient"] | undefined
): SupportedAiClientDriverId | undefined =>
  conversationClient(source).id ?? undefined;

const emptyHints: ReadonlyMap<string, PersonalFolderHint[]> = new Map();
const noSubscription = () => () => {};
const initialRevision = () => 0;

type HintScan = {
  api: PersonalDesktopApi;
  cache: FolderHintCache;
  revision: number;
  scopeKey: string;
  startDelayMs: number;
  pauseMs: number;
};

function startHintQueue(
  scan: HintScan,
  report: (
    ids: string[],
    batch: ReadonlyMap<string, PersonalFolderHint[]>
  ) => void
) {
  const pending = new Set<string>();
  const attempted = new Set<string>();
  let cancelled = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAt = Date.now() + scan.startDelayMs;
  const isCancelled = () =>
    cancelled || scan.revision !== scan.cache.revision();
  const schedule = () => {
    if (timer !== undefined || running || !pending.size || isCancelled())
      return;
    timer = setTimeout(() => void run(), Math.max(0, nextAt - Date.now()));
  };
  const run = async () => {
    timer = undefined;
    if (isCancelled() || !pending.size) return;
    running = true;
    const ids: string[] = [];
    for (const id of pending) {
      ids.push(id);
      pending.delete(id);
      attempted.add(id);
      if (ids.length === PERSONAL_FOLDER_HINT_BATCH_SIZE) break;
    }
    const batch = await loadFolderHints(scan.api, ids, {
      cache: scan.cache,
      expectedScopeKey: scan.scopeKey,
      isCancelled
    });
    if (isCancelled()) return;
    report(ids, batch);
    running = false;
    nextAt = Date.now() + scan.pauseMs;
    schedule();
  };
  return {
    reconcile(ids: ReadonlySet<string>) {
      for (const id of pending) if (!ids.has(id)) pending.delete(id);
      for (const id of ids) if (!attempted.has(id)) pending.add(id);
      schedule();
    },
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    }
  };
}

function useHintScan(scan: HintScan | null, ids: ReadonlySet<string>) {
  const queue = useRef<ReturnType<typeof startHintQueue>>(null);
  const [progress, setProgress] = useState<{
    scan: HintScan;
    settled: ReadonlyMap<string, PersonalFolderHint[] | undefined>;
  }>();
  // Retire the previous scan at commit, before a late response can cache hints.
  useLayoutEffect(() => {
    if (!scan) return;
    const current = startHintQueue(scan, (batchIds, batch) => {
      setProgress((previous) => {
        const settled = new Map(
          previous?.scan === scan ? previous.settled : undefined
        );
        for (const id of batchIds) settled.set(id, batch.get(id));
        return { scan, settled };
      });
    });
    queue.current = current;
    return () => {
      current.cancel();
      queue.current = null;
    };
  }, [scan]);
  useLayoutEffect(() => {
    queue.current?.reconcile(ids);
  }, [scan, ids]);
  return useMemo(() => {
    const settled = progress?.scan === scan ? progress.settled : undefined;
    const hints = new Map<string, PersonalFolderHint[]>();
    let checked = 0;
    let loading = false;
    if (scan)
      for (const id of ids) {
        if (!settled?.has(id)) loading = true;
        const batch = settled?.get(id);
        if (!batch) continue;
        checked++;
        if (batch.length) hints.set(id, batch);
      }
    return { hints: hints.size ? hints : emptyHints, checked, loading };
  }, [scan, ids, progress]);
}

/** Conversations that could have a suggestion: every personal Conversation
 * the sidebar lists. Whether it needs one is the scorer's call, not ours. */
export function suggestionCandidates(
  projects: readonly DesktopProject[]
): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const project of projects)
    for (const thread of project.threads)
      if (thread.sessionId && !seen.has(thread.sessionId)) {
        const client = clientOf(thread.sourceAiClient);
        seen.set(thread.sessionId, {
          sessionId: thread.sessionId,
          title: thread.name,
          ...(client ? { client } : {}),
          ...(thread.latestAt ? { latestAt: thread.latestAt } : {})
        });
      }
  return [...seen.values()];
}

/** Suggestions for the Conversations that have one, filled in as batches of
 * hints arrive. Advisory only: it reads, and assigns nothing. */
export function useFolderSuggestions(
  api: PersonalDesktopApi | undefined,
  projects: readonly DesktopProject[],
  enabled: boolean,
  options: {
    scopeKey: string | null;
    /** Wait before the first batch, so start-up is not slowed. */
    startDelayMs?: number;
    pauseMs?: number;
  }
): {
  rows: SuggestionRow[];
  /** Every hint loaded so far, by Conversation. */
  hints: ReadonlyMap<string, PersonalFolderHint[]>;
  loading: boolean;
  total: number;
  checked: number;
} {
  const { scopeKey, startDelayMs = 0, pauseMs = 0 } = options;
  const candidates = useMemo(() => suggestionCandidates(projects), [projects]);
  const ids = useMemo(
    () => new Set(candidates.map((item) => item.sessionId)),
    [candidates]
  );
  const cache =
    enabled && api?.folderHints && scopeKey
      ? folderHintCache.forScope(api, scopeKey)
      : undefined;
  const revision = useSyncExternalStore(
    cache?.subscribe ?? noSubscription,
    cache?.revision ?? initialRevision
  );
  const scan = useMemo<HintScan | null>(
    () =>
      api && cache && scopeKey
        ? { api, cache, revision, scopeKey, startDelayMs, pauseMs }
        : null,
    [api, cache, revision, scopeKey, startDelayMs, pauseMs]
  );
  const { hints, checked, loading } = useHintScan(scan, ids);
  const resolvers = useMemo(() => proposalResolvers(projects), [projects]);
  const rows = useMemo(() => {
    if (hints.size === 0) return [];
    return candidates.flatMap((candidate): SuggestionRow[] => {
      const evidence = hints.get(candidate.sessionId);
      if (!evidence) return [];
      const proposal = folderProposal(
        evidence.filter(
          (hint) => hint.kind === "repository" || api?.confirmFolderHint
        ),
        { ...resolvers, reviewBatch: true }
      );
      return proposal ? [{ ...candidate, proposal }] : [];
    });
  }, [api, candidates, hints, resolvers]);
  return {
    rows,
    hints,
    loading,
    total: candidates.length,
    checked
  };
}
