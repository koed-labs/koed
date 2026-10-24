import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RemovalCoordinator,
  type RemovalTarget
} from "./removal-coordinator.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const target = (
  name: string,
  prepare: RemovalTarget["prepare"],
  reconcile: RemovalTarget["reconcile"] = vi.fn(async () => undefined)
): RemovalTarget => ({ name, place: "Plan", prepare, reconcile });

describe("HQ-724 pending removals", () => {
  afterEach(() => vi.useRealTimers());

  it("holds a reviewed removal for five seconds and Undo sends nothing", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      execute
    }));
    const coordinator = new RemovalCoordinator();
    const run = coordinator.start([target("Sam", prepare)]);
    await flush();
    expect(coordinator.current().phase).toBe("pending");
    expect(execute).not.toHaveBeenCalled();
    coordinator.undo();
    await run;
    await vi.advanceTimersByTimeAsync(5_001);
    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.current().results).toEqual([
      { name: "Sam", state: "not attempted", reason: "Undone" }
    ]);
  });

  it("reviews the next target only after the previous dispatch and reconciliation", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const coordinator = new RemovalCoordinator();
    const make = (name: string): RemovalTarget =>
      target(
        name,
        async () => {
          order.push(`review:${name}`);
          return {
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            execute: async () => {
              order.push(`send:${name}`);
            }
          };
        },
        async () => {
          order.push(`refresh:${name}`);
        }
      );
    const run = coordinator.start([make("Bob"), make("Carol")]);
    await flush();
    expect(order).toEqual(["review:Bob"]);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(order).toEqual([
      "review:Bob",
      "send:Bob",
      "refresh:Bob",
      "review:Carol"
    ]);
    coordinator.undo();
    await run;
    expect(order).not.toContain("send:Carol");
  });

  it("cancels a pending removal on authority change and never dispatches an expired grant", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => undefined);
    const coordinator = new RemovalCoordinator();
    const pending = coordinator.start([
      target("Sam", async () => ({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        execute
      }))
    ]);
    await flush();
    coordinator.cancel();
    await pending;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execute).not.toHaveBeenCalled();
    const expired = coordinator.start([
      target("Pat", async () => ({
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        execute
      }))
    ]);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await expired;
    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.current().results[0]).toMatchObject({
      state: "failed",
      reason: "Approval expired. Pat still has access."
    });
    const malformed = coordinator.start([
      target("Lee", async () => ({ expiresAt: "not-an-instant", execute }))
    ]);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await malformed;
    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.current().results[0]?.state).toBe("failed");
  });
  it("requests fresh review only when the user retries an expired approval", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      execute
    }));
    prepare.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      execute
    });
    const coordinator = new RemovalCoordinator();
    const run = coordinator.start([target("Sam", prepare)]);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.current().results[0]?.reason).toBe(
      "Approval expired. Sam still has access."
    );
    coordinator.retryExpired();
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(coordinator.current().phase).toBe("pending");
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(execute).toHaveBeenCalledOnce();
    expect(coordinator.current().results[0]?.state).toBe("done");
  });
});
