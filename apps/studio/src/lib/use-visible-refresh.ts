"use client";

import { useEffect } from "react";

// Schedule after completion so slow requests never pile up. Stop background
// work entirely while hidden or offline; wake events share the same lock.
export function useVisibleRefresh(
  refresh: () => Promise<boolean | void>,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let running = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => !document.hidden && navigator.onLine;
    const clear = () => window.clearTimeout(timer);
    const run = async () => {
      clear();
      if (stopped || running || !visible()) return;
      running = true;
      try {
        failures = (await refresh()) === false ? failures + 1 : 0;
      } catch {
        failures += 1;
      } finally {
        running = false;
        if (!stopped && visible()) {
          timer = setTimeout(
            () => void run(),
            Math.min(120_000, 30_000 * 2 ** Math.min(failures, 2))
          );
        }
      }
    };
    const wake = () => {
      if (visible()) void run();
      else clear();
    };
    timer = setTimeout(() => void run(), 0);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clear();
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [enabled, refresh]);
}
