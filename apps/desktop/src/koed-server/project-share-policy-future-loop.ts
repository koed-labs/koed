/** Background reconciliation is owner-local and chooses no Project or Session
 * IDs. The local edge owns the bounded, fair source enumeration. */
export const createProjectSharePolicyFutureLoop = (input: {
  /** Cheap local prerequisite; avoids probing Desktop setup without Team custody. */
  eligible?(): boolean;
  authority(): Promise<string | null>;
  reconcile(
    authorityKey: string,
    signal: AbortSignal
  ): Promise<{ hasMore: boolean }>;
  intervalMs?: number;
  retryMs?: number;
}) => {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let generation = 0;
  let failures = 0;
  const intervalMs = input.intervalMs ?? 30_000;
  const retryMs = input.retryMs ?? 15_000;
  const schedule = (delay: number, current: number) => {
    if (!running || generation !== current) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick(current);
    }, delay);
    timer.unref?.();
  };
  const tick = async (current: number) => {
    timer = null;
    if (!running || generation !== current || controller) return;
    const active = new AbortController();
    controller = active;
    let delay = intervalMs;
    try {
      if (input.eligible && !input.eligible()) {
        failures = 0;
        return;
      }
      const key = await input.authority();
      if (!key || active.signal.aborted || generation !== current) return;
      const result = await input.reconcile(key, active.signal);
      if (active.signal.aborted || generation !== current) return;
      if ((await input.authority()) !== key) return;
      failures = 0;
      delay = result.hasMore ? 1_000 : intervalMs;
    } catch {
      failures = Math.min(failures + 1, 5);
      delay = Math.min(retryMs * 2 ** (failures - 1), 5 * 60_000);
    } finally {
      if (controller === active) controller = null;
      // An aborted request may ignore cancellation. Keep it as the sole
      // in-flight request until it settles, then wake a newer generation.
      schedule(generation === current ? delay : 0, generation);
    }
  };
  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      schedule(0, ++generation);
    },
    stop() {
      running = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
    }
  };
};
