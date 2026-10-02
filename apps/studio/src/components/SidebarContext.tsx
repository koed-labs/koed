"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef
} from "react";

type SidebarContextType = {
  isOpen: boolean;
  toggleSidebar: () => void;
  width: number;
  isResizing: boolean;
  startResizing: () => void;
  isNarrowScreen: boolean;
};

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 288; // 72 * 4 (w-72)

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(true);
  const [isNarrowScreen, setIsNarrowScreen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const desktopOpen = useRef(true);

  const toggleSidebar = useCallback(() => {
    setIsOpen((open) => {
      const next = !open;
      if (!isNarrowScreen) desktopOpen.current = next;
      return next;
    });
  }, [isNarrowScreen]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const syncViewport = () => {
      setIsNarrowScreen(media.matches);
      setIsOpen(media.matches ? false : desktopOpen.current);
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  const startResizing = useCallback(() => {
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing) {
        // Calculate new width: mouse X position minus the GlobalNav width (64px)
        const newWidth = mouseMoveEvent.clientX - 64;
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
    <SidebarContext.Provider
      value={{
        isOpen,
        toggleSidebar,
        width,
        isResizing,
        startResizing,
        isNarrowScreen
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}
