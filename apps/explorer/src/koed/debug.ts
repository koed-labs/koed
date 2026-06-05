const debugStorageKey = "koed.debug";

declare global {
  interface Window {
    __KOED_DEBUG_LOGS__?: Array<{
      details: Record<string, unknown>;
      elapsedMs: number;
      label: string;
    }>;
  }
}

export function koedDebugEnabled() {
  if (typeof window === "undefined") {
    return false;
  }
  if (new URLSearchParams(window.location.search).get("koed_debug") === "1") {
    window.localStorage.setItem(debugStorageKey, "1");
    return true;
  }
  return window.localStorage.getItem(debugStorageKey) === "1";
}

export function koedDebug(label: string, details?: Record<string, unknown>) {
  if (!koedDebugEnabled()) {
    return;
  }
  const elapsedMs = performance.now();
  const entry = { details: details ?? {}, elapsedMs, label };
  window.__KOED_DEBUG_LOGS__ = [...(window.__KOED_DEBUG_LOGS__ ?? []), entry];
  const elapsed = elapsedMs.toFixed(1);
  console.debug(`[koed-debug +${elapsed}ms] ${label}`, entry.details);
}

export async function koedDebugTimed<T>(
  label: string,
  details: Record<string, unknown>,
  task: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  koedDebug(`${label}:start`, details);
  try {
    return await task();
  } finally {
    koedDebug(`${label}:end`, {
      ...details,
      durationMs: Math.round(performance.now() - startedAt)
    });
  }
}
