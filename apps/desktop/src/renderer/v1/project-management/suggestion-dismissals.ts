import { useCallback, useEffect, useState } from "react";
import type { SuggestionRow } from "./use-folder-suggestions.js";

/** Kept per owner scope on this device, like sidebar pins. Hints come from this
 * device's directories, so a dismissal is device-local too. */
const storageKey = (scopeKey: string) =>
  `koed:suggestion-dismissals:${scopeKey}`;
const MAX_DISMISSALS = 2_000;
const NONE: ReadonlySet<string> = new Set();

/** One suggestion for one Conversation. A different suggestion for the same
 * Conversation, such as a new Folder or Project, is not dismissed by this. */
export const dismissalKey = ({ sessionId, proposal }: SuggestionRow) =>
  [
    sessionId,
    proposal.kind,
    proposal.kind === "repository"
      ? proposal.repositoryKey
      : (proposal.directory ?? ""),
    [...proposal.projects].sort().join(",")
  ].join("|");

function read(scopeKey: string): string[] {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(scopeKey)) ?? "[]"
    );
    return Array.isArray(saved)
      ? saved.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

/** Suggestions the User turned down. They stay hidden and out of the coin
 * counts until the suggestion itself changes. */
export function useSuggestionDismissals(scopeKey: string | null) {
  const [state, setState] = useState<{
    scope: string | null;
    keys: ReadonlySet<string>;
  }>({ scope: null, keys: NONE });
  useEffect(() => {
    setState({
      scope: scopeKey,
      keys: new Set(scopeKey ? read(scopeKey) : [])
    });
  }, [scopeKey]);
  const keys = state.scope === scopeKey ? state.keys : NONE;
  const dismiss = useCallback(
    (rows: readonly SuggestionRow[]) => {
      if (!scopeKey) return;
      const next = [
        ...new Set([...read(scopeKey), ...rows.map(dismissalKey)])
      ].slice(-MAX_DISMISSALS);
      try {
        window.localStorage.setItem(storageKey(scopeKey), JSON.stringify(next));
      } catch {
        // Still hide it for this session if storage is unavailable.
      }
      setState({ scope: scopeKey, keys: new Set(next) });
    },
    [scopeKey]
  );
  const isDismissed = useCallback(
    (row: SuggestionRow) => keys.has(dismissalKey(row)),
    [keys]
  );
  return { isDismissed, dismiss };
}
