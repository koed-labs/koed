import { useEffect, useState } from "react";
import type { KoedServerStatus } from "../../../types.js";
import {
  selectHomeView,
  type HomeProblem,
  type HomeProjectEntry,
  type HomeView
} from "./home-model.js";

export const HOME_STARTUP_GRACE_MS = 30_000;

// Lives with the app, so returning to Home never restarts the launch grace.
export function useHomeStartup(
  status: KoedServerStatus | null,
  projects: readonly HomeProjectEntry[] | null,
  { enabled, starting = false }: { enabled: boolean; starting?: boolean }
): { view: HomeView; startupPending: boolean } {
  const [expired, setExpired] = useState(false);
  const [hasBeenReady, setHasBeenReady] = useState(false);
  const ready = Boolean(
    status?.api.state === "healthy" &&
    status.database?.state === "healthy" &&
    status.lifecycle?.state !== "stopped" &&
    status.lifecycle?.state !== "unavailable"
  );
  useEffect(() => {
    if (enabled && ready) setHasBeenReady(true);
  }, [enabled, ready]);
  useEffect(() => {
    if (!enabled || ready || hasBeenReady || expired) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      HOME_STARTUP_GRACE_MS
    );
    return () => window.clearTimeout(timer);
  }, [enabled, ready, hasBeenReady, expired]);

  const startupPending = enabled && !ready && !hasBeenReady && !expired;
  if (startupPending || starting)
    return { view: { kind: "loading" }, startupPending };
  const selected = selectHomeView(status, projects);
  if (
    enabled &&
    !ready &&
    (expired || hasBeenReady) &&
    selected.kind !== "attention"
  ) {
    const problem: HomeProblem = {
      id: "services",
      title: "Koed services",
      message:
        "Koed’s local services aren’t responding. Starting Koed again usually fixes this.",
      action: { command: "start", label: "Start Koed", requiresConsent: false }
    };
    return {
      view: { kind: "attention", problems: [problem], primary: problem },
      startupPending
    };
  }
  return { view: selected, startupPending };
}
