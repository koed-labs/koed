import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PerformanceChoice,
  DesktopPerformanceApi,
  DesktopPerformanceState
} from "@koed-labs/server";

export function usePerformance(
  api: DesktopPerformanceApi | undefined = window.koedDesktop?.performance
) {
  const [state, setState] = useState<DesktopPerformanceState>({
    snapshot: null,
    operation: null
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const actionLock = useRef(false);
  const requestSequence = useRef(0);
  const committedSequence = useRef(0);
  // Inspection queues behind manager lifecycle work; never stack timer polls.
  const pollInFlight = useRef(false);
  const accept = useCallback(
    (next: DesktopPerformanceState, request: number) => {
      if (!mounted.current || request < committedSequence.current) return;
      committedSequence.current = request;
      setState(next);
      setError(null);
    },
    []
  );
  const inspect = useCallback(async () => {
    if (!api) return;
    const request = ++requestSequence.current;
    try {
      const next = await api.inspect();
      accept(next, request);
      return next;
    } catch (cause) {
      if (mounted.current && request >= committedSequence.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Performance status could not be checked."
        );
    }
  }, [api, accept]);
  useEffect(() => {
    mounted.current = true;
    void inspect();
    return () => {
      mounted.current = false;
    };
  }, [inspect]);
  useEffect(() => {
    if (!api) return;
    const interval = window.setInterval(
      () => {
        if (document.hidden || pollInFlight.current) return;
        pollInFlight.current = true;
        void inspect().finally(() => {
          pollInFlight.current = false;
        });
      },
      state.operation?.state === "running" ? 1_000 : 10_000
    );
    return () => window.clearInterval(interval);
  }, [api, inspect, state.operation?.state]);
  const apply = async (choice: PerformanceChoice) => {
    if (!api || actionLock.current) return;
    actionLock.current = true;
    setPending(true);
    const request = ++requestSequence.current;
    try {
      accept(await api.apply(choice), request);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Performance could not be changed."
        );
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return {
    ...state,
    error,
    available: !!api,
    busy: pending || state.operation?.state === "running",
    inspect,
    apply
  };
}
