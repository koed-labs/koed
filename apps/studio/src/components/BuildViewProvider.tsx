"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { BUILD_VIEW_STORAGE_KEY, type BuildViewMode } from "@/lib/buildView";

type BuildViewContextValue = {
  view: BuildViewMode;
  setView: (view: BuildViewMode) => void;
};

const BuildViewContext = createContext<BuildViewContextValue | undefined>(undefined);

function readStoredView(): BuildViewMode {
  try {
    return window.localStorage.getItem(BUILD_VIEW_STORAGE_KEY) === "advanced" ? "advanced" : "story";
  } catch {
    return "story";
  }
}

// Mirrors ThemeProvider's shape on purpose - same kind of lightweight,
// per-device preference, just a different axis (detail level, not color).
// Read synchronously in the initializer (rather than an effect, the way
// ThemeProvider does it) since there's no paint-order/FOUC concern here to
// justify the extra render pass - this never changes what's on screen
// before hydration, only how much detail a build panel shows once it is.
export function BuildViewProvider({ children }: { children: React.ReactNode }) {
  const [view, setViewState] = useState<BuildViewMode>(() =>
    typeof window === "undefined" ? "story" : readStoredView()
  );

  const setView = useCallback((next: BuildViewMode) => {
    setViewState(next);
    try {
      window.localStorage.setItem(BUILD_VIEW_STORAGE_KEY, next);
    } catch {
      // Best effort - a failed write just means the choice won't survive a reload.
    }
  }, []);

  const value = useMemo(() => ({ view, setView }), [view, setView]);
  return <BuildViewContext.Provider value={value}>{children}</BuildViewContext.Provider>;
}

export function useBuildView() {
  const context = useContext(BuildViewContext);
  if (!context) {
    throw new Error("useBuildView must be used within a BuildViewProvider");
  }
  return context;
}
