import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { createRecurringAgentTaskRunner } from "./recurring-agent-task-runner.js";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("Recurring Agent task runner", () => {
  it("bounds polling to one in-flight authority claim and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const response = deferred<null>();
      const claimNext = vi.fn(() => response.promise);
      const runner = createRecurringAgentTaskRunner({
        authority: { claimNext },
        logger: pino({ enabled: false }),
        runnerId: "recurring-agent-task:test",
        pollIntervalMs: 25_000,
        leaseMs: 90_000
      });

      runner.start();
      expect(claimNext).toHaveBeenCalledTimes(1);
      expect(claimNext).toHaveBeenCalledWith({
        runnerId: "recurring-agent-task:test",
        leaseMs: 90_000
      });

      await vi.advanceTimersByTimeAsync(50_000);
      expect(claimNext).toHaveBeenCalledTimes(1);

      response.resolve(null);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25_000);
      expect(claimNext).toHaveBeenCalledTimes(2);

      await runner.stop();
      await vi.advanceTimersByTimeAsync(100_000);
      expect(claimNext).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces manual and timer-triggered calls while a claim is pending", async () => {
    const response = deferred<null>();
    const claimNext = vi.fn(() => response.promise);
    const runner = createRecurringAgentTaskRunner({
      authority: { claimNext },
      logger: pino({ enabled: false }),
      runnerId: "recurring-agent-task:test"
    });

    const first = runner.processOnce();
    const second = runner.processOnce();
    expect(claimNext).toHaveBeenCalledTimes(1);
    response.resolve(null);
    await Promise.all([first, second]);
    await runner.stop();
  });
});
