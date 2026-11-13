import { useEffect, useRef } from "react";

/** Recompute calendar presets after midnight, clock changes, and sleep. */
export function useRecallDateRollover(onRollover: () => void) {
  const callback = useRef(onRollover);
  callback.current = onRollover;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      callback.current();
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(
        update,
        Math.max(1, midnight.getTime() - now.getTime())
      );
    };
    const visible = () => {
      if (document.visibilityState !== "hidden") update();
    };
    update();
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
}
