"use client";

import { useCallback, useEffect, useState } from "react";

const MIN_WIDTH = 280;
const MAX_WIDTH = 640;

export function useResizableAside(defaultWidth: number) {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);

  const startResizing = useCallback(() => setIsResizing(true), []);
  const stopResizing = useCallback(() => setIsResizing(false), []);
  const resizeBy = useCallback((delta: number) => {
    setWidth((current) =>
      Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, current + delta))
    );
  }, []);

  const resize = useCallback(
    (event: MouseEvent) => {
      if (!isResizing) return;
      const next = window.innerWidth - event.clientX;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
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

  return { width, isResizing, startResizing, resizeBy };
}
