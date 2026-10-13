import type { KoedServerPaths } from "./paths.js";
import {
  listUpstreamBackends,
  refreshUpstreamBackendCapabilities
} from "./upstream-registry.js";

/** Server-owned maintenance; independent of Desktop views and broker lifetime. */
export const maintainUpstreamCapabilities = (
  paths: KoedServerPaths,
  options: {
    list?: typeof listUpstreamBackends;
    refresh?: typeof refreshUpstreamBackendCapabilities;
    now?: () => number;
    intervalMs?: number;
    leadMs?: number;
    onError?: () => void;
  } = {}
): (() => void) => {
  const list = options.list ?? listUpstreamBackends;
  const refresh = options.refresh ?? refreshUpstreamBackendCapabilities;
  const controller = new AbortController();
  let running = false;
  const tick = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      const now = (options.now ?? Date.now)();
      for (const backend of list(paths).backends ?? []) {
        if (controller.signal.aborted) break;
        if (backend.credential.status === "revoked") continue;
        if (!Object.values(backend.routePolicy).includes("enabled")) continue;
        const expiry = Date.parse(backend.capabilities.expiresAt ?? "");
        if (
          backend.capabilities.state === "validated" &&
          Number.isFinite(expiry) &&
          expiry > now + (options.leadMs ?? 60_000)
        )
          continue;
        await refresh(paths, backend.id, { signal: controller.signal });
      }
    } catch {
      // Content-free diagnostic. Failed validation remains denied by routing.
      if (!controller.signal.aborted) options.onError?.();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 30_000);
  timer.unref?.();
  void tick();
  return () => {
    clearInterval(timer);
    controller.abort();
  };
};
