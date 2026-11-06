import { useCallback, useEffect, useState } from "react";

/** Store identifiers only, isolated by the authenticated backend/owner scope. */
export function useSidebarPins(scopeKey: string | null) {
  const [state, setState] = useState<{ scope: string | null; pins: string[] }>({
    scope: null,
    pins: []
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!scopeKey) {
      setState({ scope: null, pins: [] });
      return;
    }
    try {
      const saved: unknown = JSON.parse(
        window.localStorage.getItem(`koed:sidebar-pins:${scopeKey}`) ?? "[]"
      );
      const pins =
        Array.isArray(saved) && saved.every((id) => typeof id === "string")
          ? [...new Set<string>(saved)]
          : [];
      setState({ scope: scopeKey, pins });
    } catch {
      setState({ scope: scopeKey, pins: [] });
      setError("Saved pins could not be loaded.");
    }
  }, [scopeKey]);
  const pins = state.scope === scopeKey ? state.pins : [];
  const toggle = useCallback(
    (key: string, aliases: readonly string[]) => {
      if (!scopeKey || state.scope !== scopeKey) return;
      const next = state.pins.some((id) => aliases.includes(id))
        ? state.pins.filter((id) => !aliases.includes(id))
        : [...state.pins, key];
      try {
        window.localStorage.setItem(
          `koed:sidebar-pins:${scopeKey}`,
          JSON.stringify(next)
        );
        setState({ scope: scopeKey, pins: next });
        setError(null);
      } catch {
        setError("Your pin could not be saved. Please try again.");
      }
    },
    [scopeKey, state]
  );
  return {
    pins,
    toggle,
    error,
    ready: Boolean(scopeKey && state.scope === scopeKey)
  };
}
