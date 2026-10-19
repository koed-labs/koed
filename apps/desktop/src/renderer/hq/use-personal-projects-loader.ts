import { useEffect } from "react";

import type { DesktopRoute } from "../navigation.js";
import type { PersonalMemoryStore } from "../state/personal-memory.js";

export function usePersonalProjectsLoader({
  hqEnabled,
  personalMemoryReady,
  routeKind,
  store
}: {
  hqEnabled: boolean;
  personalMemoryReady: boolean;
  routeKind: DesktopRoute["kind"];
  store: PersonalMemoryStore | null;
}): void {
  useEffect(() => {
    if (!hqEnabled && routeKind === "personal-memory-ask") {
      void store?.loadProjects({ silent: true });
    }
  }, [store, hqEnabled, routeKind]);

  useEffect(() => {
    if (hqEnabled && personalMemoryReady) {
      void store?.loadProjects({ silent: true });
    }
  }, [store, hqEnabled, personalMemoryReady]);
}
