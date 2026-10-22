import type { RuntimeLifecycleObservation } from "@koed-labs/server";

export type LifecycleListener = (
  next: RuntimeLifecycleObservation,
  previous: RuntimeLifecycleObservation | null
) => void;

export interface LifecycleObserver {
  current: () => RuntimeLifecycleObservation | null;
  refresh: () => RuntimeLifecycleObservation;
  subscribe: (listener: LifecycleListener) => () => void;
  start: () => void;
  stop: () => void;
}

const unavailable = (message: string): RuntimeLifecycleObservation => ({
  state: "unavailable",
  epoch: "unavailable",
  message
});

// One cheap local observer feeds the renderer and tray. It reads lifecycle
// files and process identity only: no bundle verification, service probes,
// model hashing, or access checks.
export const createLifecycleObserver = ({
  observe,
  intervalMs = 2_000,
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval
}: {
  observe: () => RuntimeLifecycleObservation;
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}): LifecycleObserver => {
  let latest: RuntimeLifecycleObservation | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<LifecycleListener>();
  const refresh = (): RuntimeLifecycleObservation => {
    let next: RuntimeLifecycleObservation;
    try {
      next = observe();
    } catch (error) {
      next = unavailable(
        error instanceof Error ? error.message : "Koed state is unreadable."
      );
    }
    const previous = latest;
    latest = next;
    if (previous?.epoch !== next.epoch || previous.state !== next.state)
      for (const listener of listeners) {
        try {
          listener(next, previous);
        } catch {
          // A failing consumer must not stop lifecycle delivery to the others.
        }
      }
    return next;
  };
  return {
    current: () => latest,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (timer) return;
      refresh();
      timer = schedule(refresh, intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop: () => {
      if (timer) cancel(timer);
      timer = null;
    }
  };
};

// Avoids a `ps` call on every poll while the same verified PID stays alive.
// Management and destructive paths re-verify identity independently.
export const cachedProcessIdentity = ({
  resolve,
  isAlive,
  now = Date.now,
  maxAgeMs = 30_000
}: {
  resolve: (pid: number) => string | null;
  isAlive: (pid: number) => boolean;
  now?: () => number;
  maxAgeMs?: number;
}): ((pid: number) => string | null) => {
  let cached: { pid: number; identity: string; at: number } | null = null;
  return (pid) => {
    if (cached?.pid === pid && now() - cached.at <= maxAgeMs && isAlive(pid))
      return cached.identity;
    const identity = resolve(pid);
    cached = identity ? { pid, identity, at: now() } : null;
    return identity;
  };
};
