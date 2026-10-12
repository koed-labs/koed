import { setTimeout as delay } from "node:timers/promises";

// One runtime-owned scheduler is shared by capture, import and background
// synthesis services. It never holds the interactive Memory Answer client.
export class BackgroundApiRequestScheduler {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly controller = new AbortController();

  async run<T>(
    request: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.controller.signal])
      : this.controller.signal;
    const pending = this.tail.then(async () => {
      signal.throwIfAborted();
      const waitMs = this.nextRequestAt - Date.now();
      if (waitMs > 0) await delay(waitMs, undefined, { signal });
      signal.throwIfAborted();
      // At most ten starts per second, without a burst after a cooldown.
      this.nextRequestAt = Date.now() + 100;
      try {
        return await request(signal);
      } catch (error) {
        const failure = error as { status?: number; retryAfterMs?: number };
        if (failure?.status === 429) {
          const retryAfterMs = failure.retryAfterMs;
          const cooldown =
            typeof retryAfterMs === "number" &&
            Number.isSafeInteger(retryAfterMs) &&
            retryAfterMs > 0
              ? Math.min(300_000, retryAfterMs)
              : 60_000;
          this.nextRequestAt = Math.max(
            this.nextRequestAt,
            Date.now() + cooldown
          );
        }
        throw error;
      }
    });
    this.tail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  close(): void {
    this.controller.abort(new Error("Background memory requests stopped"));
  }
}
