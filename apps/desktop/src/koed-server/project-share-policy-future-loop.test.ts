import { afterEach, expect, it, vi } from "vitest";
import { createProjectSharePolicyFutureLoop } from "./project-share-policy-future-loop.js";

afterEach(() => {
  vi.useRealTimers();
});

it("runs one bounded owner-local reconciliation at a time and aborts on stop", async () => {
  vi.useFakeTimers();
  let finish!: (value: { hasMore: boolean }) => void;
  let observedSignal: AbortSignal | undefined;
  const reconcile = vi.fn((_key: string, signal: AbortSignal) => {
    observedSignal = signal;
    return new Promise<{ hasMore: boolean }>((resolve) => {
      finish = resolve;
    });
  });
  const loop = createProjectSharePolicyFutureLoop({
    authority: async () => "owner-profile-a",
    reconcile,
    intervalMs: 100
  });
  loop.start();
  loop.start();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reconcile).toHaveBeenCalledTimes(1);
  loop.stop();
  expect(observedSignal?.aborted).toBe(true);
  finish({ hasMore: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(reconcile).toHaveBeenCalledTimes(1);
});

it("backs off failed requests and never presents a stale authority as current", async () => {
  vi.useFakeTimers();
  let key = "owner-profile-a";
  const reconcile = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ hasMore: false });
  const loop = createProjectSharePolicyFutureLoop({
    authority: async () => key,
    reconcile,
    intervalMs: 100,
    retryMs: 500
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(reconcile).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(400);
  expect(reconcile).toHaveBeenCalledTimes(1);
  key = "owner-profile-b";
  await vi.advanceTimersByTimeAsync(100);
  expect(reconcile).toHaveBeenNthCalledWith(
    2,
    "owner-profile-b",
    expect.any(AbortSignal)
  );
  loop.stop();
});

it("does not probe Desktop authority until Team policy custody is configured", async () => {
  vi.useFakeTimers();
  let eligible = false;
  const authority = vi.fn(async () => "owner-profile");
  const reconcile = vi.fn(async () => ({ hasMore: false }));
  const loop = createProjectSharePolicyFutureLoop({
    eligible: () => eligible,
    authority,
    reconcile,
    intervalMs: 100
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(authority).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  eligible = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(authority).toHaveBeenCalled();
  expect(reconcile).toHaveBeenCalledTimes(1);
  loop.stop();
});

it("waits for an aborted old request to drain before a new generation runs", async () => {
  vi.useFakeTimers();
  let finishOld!: (value: { hasMore: boolean }) => void;
  let active = 0;
  let peak = 0;
  let key = "old-profile";
  const reconcile = vi.fn(async (scope: string) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (scope === "old-profile")
        return await new Promise<{ hasMore: boolean }>((resolve) => {
          finishOld = resolve;
        });
      return { hasMore: false };
    } finally {
      active -= 1;
    }
  });
  const loop = createProjectSharePolicyFutureLoop({
    authority: async () => key,
    reconcile,
    intervalMs: 1_000
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(active).toBe(1);
  loop.stop();
  key = "new-profile";
  loop.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(reconcile).toHaveBeenCalledTimes(1);
  finishOld({ hasMore: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(reconcile.mock.calls[1]?.[0]).toBe("new-profile");
  expect(peak).toBe(1);
  loop.stop();
});
