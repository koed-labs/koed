import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopSetupSnapshot } from "../../../types.js";
import { errorText } from "./model.js";

export function useSetup() {
  const api = window.koedDesktop?.setup;
  const [snapshot, setSnapshot] = useState<DesktopSetupSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const mounted = useRef(false);
  const operation = useRef(0);
  const locked = useRef(false);
  const eventVersion = useRef(0);
  const current = useRef<DesktopSetupSnapshot | null>(null);
  const retired = useRef(new Set<string>());
  const accept = useCallback((next: DesktopSetupSnapshot) => {
    const previous = current.current;
    if (retired.current.has(next.runId)) return false;
    if (previous?.runId === next.runId && next.sequence <= previous.sequence)
      return;
    if (previous && previous.runId !== next.runId)
      retired.current.add(previous.runId);
    current.current = next;
    setSnapshot(next);
    return true;
  }, []);
  const inspect = useCallback(async () => {
    if (locked.current) return current.current;
    const request = ++operation.current;
    const version = eventVersion.current;
    setBusy(true);
    setError(null);
    try {
      if (!api)
        throw new Error(
          "Desktop setup is unavailable. Reopen Koed and try again."
        );
      const next = await api.inspect();
      if (
        mounted.current &&
        request === operation.current &&
        version === eventVersion.current
      )
        accept(next);
      return version === eventVersion.current ? next : current.current;
    } catch (cause) {
      if (mounted.current && request === operation.current)
        setError(errorText(cause));
      return null;
    } finally {
      if (mounted.current && request === operation.current) setBusy(false);
    }
  }, [api, accept]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api?.subscribe((next) => {
      if (!mounted.current) return;
      if (accept(next)) eventVersion.current++;
    });
    void inspect();
    return () => {
      mounted.current = false;
      operation.current++;
      unsubscribe?.();
    };
  }, [api, inspect, accept]);
  // Reopened windows can inspect an existing run without owning its IPC
  // response or progress subscription. Keep observing until that run ends.
  useEffect(() => {
    if (snapshot?.state !== "running" || busy || error || locked.current)
      return;
    let disposed = false;
    let timer: number;
    const poll = async () => {
      await inspect();
      if (!disposed) timer = window.setTimeout(() => void poll(), 1000);
    };
    timer = window.setTimeout(() => void poll(), 1000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [snapshot, busy, error, inspect]);
  const run = async () => {
    if (!api || locked.current) return;
    locked.current = true;
    const request = ++operation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.run();
      if (mounted.current && request === operation.current) accept(next);
    } catch (cause) {
      if (mounted.current && request === operation.current)
        setError(errorText(cause));
    } finally {
      locked.current = false;
      if (mounted.current && request === operation.current) setBusy(false);
    }
  };
  return { snapshot, error, busy, inspect, run };
}
