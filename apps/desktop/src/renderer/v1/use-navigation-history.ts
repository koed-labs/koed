import { useCallback, useState } from "react";
import type { NavigationRoute } from "./project-sidebar-model.js";
const home: NavigationRoute = { kind: "home" };
export function useNavigationHistory(scope: string | null) {
  const [state, setState] = useState<{
    scope: string | null;
    entries: NavigationRoute[];
    index: number;
  }>({ scope, entries: [home], index: 0 });
  const current =
    state.scope === scope ? state : { scope, entries: [home], index: 0 };
  const navigate = useCallback(
    (route: NavigationRoute) => {
      setState((previous) => {
        const current =
          previous.scope === scope
            ? previous
            : { scope, entries: [home], index: 0 };
        const active = current.entries[current.index];
        if (JSON.stringify(active) === JSON.stringify(route)) return current;
        if (
          active?.kind === "conversation" &&
          route.kind === "conversation" &&
          ((route.conversationKey &&
            route.conversationKey === active.conversationKey) ||
            (route.executionId && route.executionId === active.executionId))
        ) {
          return {
            ...current,
            entries: current.entries.map((entry, index) =>
              index === current.index ? route : entry
            )
          };
        }
        const entries = [
          ...current.entries.slice(0, current.index + 1),
          route
        ].slice(-100);
        return { scope, entries, index: entries.length - 1 };
      });
    },
    [scope]
  );
  const move = (offset: number) =>
    setState((previous) =>
      previous.scope !== scope
        ? previous
        : {
            ...previous,
            index: Math.max(
              0,
              Math.min(previous.entries.length - 1, previous.index + offset)
            )
          }
    );
  return {
    route: current.entries[current.index]!,
    navigate,
    back: () => move(-1),
    forward: () => move(1),
    canGoBack: current.index > 0,
    canGoForward: current.index < current.entries.length - 1
  };
}
