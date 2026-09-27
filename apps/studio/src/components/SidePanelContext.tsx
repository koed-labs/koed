"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { SuggestedAction } from "@/lib/workspace";

// One right-hand panel, not two competing ones. "section" is which content
// it's showing (Build always has something to show; Reasons is transient -
// only set while a suggestion's provenance is being looked at). "mode" is
// how much of it is showing: hidden entirely, a small floating peek (the
// default - Codex/Claude Code's own small "Environment" popover), or the
// full resizable sidebar with tabs, opened on request.
export type SidePanelMode = "hidden" | "peek" | "full";
export type SidePanelSection = "build" | "reasons";

// The peek card's full on-screen footprint (card width + its right inset +
// a little breathing room), so a chat view can reserve that much space on
// its own right edge instead of letting the fixed, out-of-flow peek popover
// sit on top of whatever is rendered underneath it.
export const PEEK_RESERVED_WIDTH = 332;

type SidePanelContextType = {
  mode: SidePanelMode;
  setMode: (mode: SidePanelMode) => void;
  section: SidePanelSection;
  setSection: (section: SidePanelSection) => void;
  reasons: SuggestedAction | null;
  showReasons: (suggestion: SuggestedAction) => void;
  clearReasons: () => void;
  width: number;
  isResizing: boolean;
  startResizing: () => void;
};

const SidePanelContext = createContext<SidePanelContextType | undefined>(undefined);

const MIN_WIDTH = 300;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 360;

export function SidePanelProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<SidePanelMode>("peek");
  const [section, setSection] = useState<SidePanelSection>("build");
  const [reasons, setReasons] = useState<SuggestedAction | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);

  // Triggered wherever a suggestion's "why" is requested. Surfaces the
  // panel (from hidden) without forcing it open to full - peek is always
  // the first thing shown, per the same rule as everything else here.
  const showReasons = useCallback((suggestion: SuggestedAction) => {
    setReasons(suggestion);
    setSection("reasons");
    setMode((current) => (current === "hidden" ? "peek" : current));
  }, []);

  const clearReasons = useCallback(() => {
    setReasons(null);
    setSection((current) => (current === "reasons" ? "build" : current));
  }, []);

  const startResizing = useCallback(() => setIsResizing(true), []);
  const stopResizing = useCallback(() => setIsResizing(false), []);

  const resize = useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing) {
        const newWidth = window.innerWidth - mouseMoveEvent.clientX;
        if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
          setWidth(newWidth);
        }
      }
    },
    [isResizing]
  );

  useEffect(() => {
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [resize, stopResizing]);

  return (
    <SidePanelContext.Provider
      value={{ mode, setMode, section, setSection, reasons, showReasons, clearReasons, width, isResizing, startResizing }}
    >
      {children}
    </SidePanelContext.Provider>
  );
}

export function useSidePanel() {
  const context = useContext(SidePanelContext);
  if (!context) {
    throw new Error("useSidePanel must be used within a SidePanelProvider");
  }
  return context;
}
