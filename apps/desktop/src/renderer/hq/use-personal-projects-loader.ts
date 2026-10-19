import { useEffect } from "react";
import type { PersonalMemoryStore } from "../state/personal-memory.js";

export function usePersonalProjectsLoader({
  personalMemoryReady,
  store
}: {
  personalMemoryReady: boolean;
  store: PersonalMemoryStore | null;
}): void {
  useEffect(() => {
    if (personalMemoryReady) void store?.loadProjects();
  }, [store, personalMemoryReady]);
}
