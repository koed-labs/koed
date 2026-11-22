import { useEffect, useMemo, useState } from "react";
import type { PersonalFolderHint } from "@koed-labs/shared";
import type { SupportedAiClientDriverId } from "@koed-labs/shared/ai-client-contract";
import type {
  PersonalDesktopApi,
  PersonalDesktopProjectThread
} from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { loadFolderHints } from "./folder-hint-cache.js";
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
  source === "claude-code"
    ? "claude"
    : source === "pi"
      ? "pi"
      : source === "codex" || source === "codex-cli"
        ? "codex"
        : undefined;

const MAX_CONVERSATIONS = 300;

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
  return [...seen.values()].slice(0, MAX_CONVERSATIONS);
}

/** Suggestions for the Conversations that have one, filled in as batches of
 * hints arrive. Advisory only: it reads, and assigns nothing. */
export function useFolderSuggestions(
  api: PersonalDesktopApi | undefined,
  projects: readonly DesktopProject[],
  enabled: boolean,
  options: {
    /** Bump to forget what was loaded and ask again, e.g. after an edit. */
    version?: number;
    /** Wait before the first batch, so start-up is not slowed. */
    startDelayMs?: number;
    pauseMs?: number;
  } = {}
): { rows: SuggestionRow[]; loading: boolean; total: number; checked: number } {
  const { version = 0, startDelayMs = 0, pauseMs = 0 } = options;
  const candidates = useMemo(() => suggestionCandidates(projects), [projects]);
  const key = candidates.map((item) => item.sessionId).join(",");
  const [hints, setHints] = useState<ReadonlyMap<string, PersonalFolderHint[]>>(
    new Map()
  );
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !api?.folderHints) return;
    let cancelled = false;
    setHints(new Map());
    setLoading(true);
    const timer = setTimeout(() => {
      void loadFolderHints(
        api,
        candidates.map((item) => item.sessionId),
        {
          isCancelled: () => cancelled,
          pauseMs,
          onBatch: (batch) => {
            if (!cancelled)
              setHints((previous) => new Map([...previous, ...batch]));
          }
        }
      ).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, startDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` stands in for the candidate list.
  }, [api, key, enabled, version]);
  const rows = useMemo(
    () =>
      candidates.flatMap((candidate): SuggestionRow[] => {
        const proposal = folderProposal(
          hints.get(candidate.sessionId) ?? [],
          proposalResolvers(projects)
        );
        return proposal ? [{ ...candidate, proposal }] : [];
      }),
    [candidates, hints, projects]
  );
  return { rows, loading, total: candidates.length, checked: hints.size };
}
