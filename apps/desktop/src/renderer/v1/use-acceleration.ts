import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AccelerationChoice,
  DesktopAccelerationApi,
  DesktopAccelerationState
} from "@koed-labs/server";

export function useAcceleration(
  api: DesktopAccelerationApi | undefined = window.koedDesktop?.acceleration
) {
  const [state, setState] = useState<DesktopAccelerationState>({
    snapshot: null,
    operation: null
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const actionLock = useRef(false);
  const requestSequence = useRef(0);
  const committedSequence = useRef(0);
  const accept = useCallback(
    (next: DesktopAccelerationState, request: number) => {
      if (!mounted.current || request < committedSequence.current) return;
      committedSequence.current = request;
      setState((previous) => {
        if (
          previous.operation &&
          next.operation?.id === previous.operation.id &&
          next.operation.sequence < previous.operation.sequence
        )
          return previous;
        return next;
      });
      setError(null);
    },
    []
  );
  const inspect = useCallback(
    async (refresh = false) => {
      if (!api) return;
      const request = ++requestSequence.current;
      try {
        const next = await api.inspect(refresh);
        accept(next, request);
        return next;
      } catch (cause) {
        if (mounted.current && request >= committedSequence.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Processing status could not be checked."
          );
      }
    },
    [api, accept]
  );
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
        if (!document.hidden) void inspect();
      },
      state.operation?.state === "running" ? 1_000 : 10_000
    );
    return () => window.clearInterval(interval);
  }, [api, inspect, state.operation?.state]);
  const apply = async (choice: AccelerationChoice) => {
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
            : "Processing could not be changed."
        );
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const cancel = async () => {
    if (!api || !state.operation?.cancellable) return;
    const request = ++requestSequence.current;
    try {
      accept(await api.cancel(state.operation.id), request);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Cancellation could not be requested."
        );
    }
  };
  return {
    ...state,
    error,
    available: !!api,
    busy: pending || state.operation?.state === "running",
    inspect,
    apply,
    cancel
  };
}
