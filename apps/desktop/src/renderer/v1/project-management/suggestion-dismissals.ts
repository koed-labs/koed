import { useCallback, useEffect, useState } from "react";
import { suggestionApprovalKey } from "./folder-hint-suggestion.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

/** Kept per owner scope on this device, like sidebar pins. Hints come from this
 * device's directories, so a dismissal is device-local too. */
const storageKey = (scopeKey: string) =>
  `koed:suggestion-dismissals:${scopeKey}`;
const MAX_DISMISSALS = 2_000;
const NONE: ReadonlySet<string> = new Set();

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
    (projectId: string, rows: readonly SuggestionRow[]) => {
      if (!scopeKey) return;
      const next = [
        ...new Set([
          ...read(scopeKey),
          ...rows.map((row) => suggestionApprovalKey(projectId, row))
        ])
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
    (projectId: string, row: SuggestionRow) =>
      keys.has(suggestionApprovalKey(projectId, row)),
    [keys]
  );
  return { isDismissed, dismiss };
}
