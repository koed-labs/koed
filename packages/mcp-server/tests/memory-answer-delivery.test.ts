import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryAnswerDelivery,
  type MemoryAnswerDeliveryTask,
  type MemoryAnswerExecutionPort
} from "../integrations/pi/memory-answer-delivery.mjs";

interface Task extends MemoryAnswerDeliveryTask {
  result: { answer: string } | null;
}
const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  invocationKey: "invocation-1",
  status: "running",
  version: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  result: null,
  ...overrides
});
const port = (get = vi.fn(async () => task())) =>
  ({
    start: vi.fn(async () => task()),
    get,
    cancel: vi.fn(async () => task({ status: "cancel_requested", version: 2 }))
  }) satisfies MemoryAnswerExecutionPort<Task>;

afterEach(() => vi.useRealTimers());

describe("MemoryAnswerDelivery", () => {
  it("keeps five overlapping default observers below the token quota with margin", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const execution = port(
      vi.fn(async () =>
        task({ expiresAt: new Date(Date.now() + 120_000).toISOString() })
      )
    );
    const delivery = new MemoryAnswerDelivery(execution);
    const observations = Array.from({ length: 5 }, () =>
      delivery.observe("task-1", { signal: controller.signal })
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execution.get.mock.calls.length).toBeLessThan(900);
    expect(execution.get.mock.calls.length).toBeGreaterThan(5);
    controller.abort();
    await Promise.all(observations);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.cancel).not.toHaveBeenCalled();
  });

  it("keeps five frequently changing tasks within quota even when polling resets", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let version = 0;
    const execution = port(
      vi.fn(async () =>
        task({
          version: ++version,
          expiresAt: new Date(Date.now() + 120_000).toISOString()
        })
      )
    );
    const observations = Array.from({ length: 5 }, () =>
      new MemoryAnswerDelivery(execution).observe("task-1", {
        signal: controller.signal
      })
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execution.get.mock.calls.length).toBeLessThan(900);
    expect(execution.get.mock.calls.length).toBeGreaterThan(250);
    controller.abort();
    await Promise.all(observations);
    expect(execution.cancel).not.toHaveBeenCalled();
  });

  it("keeps repeated quota failures pending until the original deadline without submitting again", async () => {
    vi.useFakeTimers();
    const execution = port(
      vi.fn(async () => {
        throw Object.assign(new Error("quota"), { statusCode: 429 });
      })
    );
    const present = vi.fn();
    let settled = false;
    const observation = new MemoryAnswerDelivery(execution, {
      maxObservationMs: 12_000
    })
      .observe("task-1", { present })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(settled).toBe(false);
    expect(present).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await observation).toMatchObject({
      kind: "detached",
      reason: "observation-timeout"
    });
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.cancel).not.toHaveBeenCalled();
    expect(execution.get.mock.calls.length).toBeLessThan(4);
  });

  it("retries an ordinary 429 with validated advice without reaccepting execution", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("quota"), {
          statusCode: 429,
          retryAfterMs: 2000
        })
      )
      .mockResolvedValue(task({ status: "completed" }));
    const execution = port(get);
    const present = vi.fn();
    const observation = new MemoryAnswerDelivery(execution).observe("task-1", {
      present
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(get).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await observation).kind).toBe("terminal");
    expect(get).toHaveBeenCalledTimes(3);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.cancel).not.toHaveBeenCalled();
  });

  it("retries a throttled final read and presents only its fresh result", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockResolvedValueOnce(
        task({ status: "completed", result: { answer: "cached" } })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("quota"), { status: 429, retryAfterMs: 1000 })
      )
      .mockResolvedValueOnce(
        task({ status: "completed", version: 2, result: { answer: "fresh" } })
      );
    const present = vi.fn();
    const observation = new MemoryAnswerDelivery(port(get)).observe("task-1", {
      present
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(present).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await observation;
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ result: { answer: "fresh" } })
    );
  });

  it.each([undefined, -1, 0, NaN, Infinity, "1", 300_001])(
    "uses bounded fallback for invalid quota advice %s",
    async (retryAfterMs) => {
      vi.useFakeTimers();
      const get = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("quota"), { statusCode: 429, retryAfterMs })
        )
        .mockResolvedValue(task({ status: "completed" }));
      const observation = new MemoryAnswerDelivery(port(get)).observe("task-1");
      await vi.advanceTimersByTimeAsync(4999);
      expect(get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await observation).kind).toBe("terminal");
    }
  );

  it.each([
    "observation-timeout",
    "expired",
    "observer-aborted",
    "stale-origin"
  ] as const)(
    "retains %s while waiting to retry the final authorized read",
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let current = true;
      const expiresAt = new Date(
        Date.now() + (reason === "expired" ? 100 : 60_000)
      ).toISOString();
      const get = vi
        .fn()
        .mockResolvedValueOnce(task({ status: "completed", expiresAt }))
        .mockRejectedValue(
          Object.assign(new Error("quota"), {
            statusCode: 429,
            retryAfterMs: 5000
          })
        );
      const execution = port(get);
      const present = vi.fn();
      const observation = new MemoryAnswerDelivery(execution, {
        maxObservationMs: reason === "observation-timeout" ? 100 : 60_000
      }).observe("task-1", {
        signal: controller.signal,
        isCurrent: () => current,
        present
      });
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "observer-aborted") controller.abort();
      if (reason === "stale-origin") current = false;
      await vi.advanceTimersByTimeAsync(reason === "stale-origin" ? 5000 : 100);
      expect(await observation).toMatchObject({ kind: "detached", reason });
      expect(get).toHaveBeenCalledTimes(2);
      expect(present).not.toHaveBeenCalled();
      expect(execution.cancel).not.toHaveBeenCalled();
    }
  );

  it.each([401, 403])(
    "preserves fatal authorization %s after a final-read quota retry",
    async (statusCode) => {
      vi.useFakeTimers();
      const denied = Object.assign(new Error("denied"), { statusCode });
      const get = vi
        .fn()
        .mockResolvedValueOnce(task({ status: "completed" }))
        .mockRejectedValueOnce(
          Object.assign(new Error("quota"), {
            statusCode: 429,
            retryAfterMs: 1000
          })
        )
        .mockRejectedValueOnce(denied);
      const present = vi.fn();
      const observation = new MemoryAnswerDelivery(port(get)).observe(
        "task-1",
        { present }
      );
      const assertion = expect(observation).rejects.toBe(denied);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(present).not.toHaveBeenCalled();
    }
  );

  it("delegates acceptance and explicit cancellation to the one execution port", async () => {
    const execution = port();
    const delivery = new MemoryAnswerDelivery(execution);
    const signal = new AbortController().signal;
    const input = { query: "What decision was recorded?" };
    const caller = { cwd: "/fixture" };
    await delivery.accept(input, caller, "invocation-1", signal);
    expect(execution.start).toHaveBeenCalledWith(
      input,
      caller,
      "invocation-1",
      signal
    );
    await delivery.cancel("task-1", signal);
    expect(execution.cancel).toHaveBeenCalledWith("task-1", signal);
  });

  it("presents only the freshly authorized terminal result", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(
        task({ status: "completed", version: 2, result: { answer: "cached" } })
      )
      .mockResolvedValueOnce(
        task({ status: "completed", version: 3, result: { answer: "fresh" } })
      );
    const present = vi.fn();
    const result = await new MemoryAnswerDelivery(port(get)).observe("task-1", {
      present
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3, result: { answer: "fresh" } })
    );
    expect(result.kind).toBe("terminal");
  });

  it("does not deliver a cached completion when authority is revoked on the fresh read", async () => {
    const denied = Object.assign(new Error("Access denied"), { status: 403 });
    const get = vi
      .fn()
      .mockResolvedValueOnce(task({ status: "completed" }))
      .mockRejectedValueOnce(denied);
    const present = vi.fn();
    await expect(
      new MemoryAnswerDelivery(port(get)).observe("task-1", { present })
    ).rejects.toBe(denied);
    expect(present).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)(
    "freshly presents terminal %s status",
    async (status) => {
      const execution = port(vi.fn(async () => task({ status })));
      const present = vi.fn();
      const outcome = await new MemoryAnswerDelivery(execution).observe(
        "task-1",
        { present }
      );
      expect(execution.get).toHaveBeenCalledTimes(2);
      expect(outcome).toMatchObject({ kind: "terminal", task: { status } });
      expect(present).toHaveBeenCalledTimes(1);
      expect(execution.cancel).not.toHaveBeenCalled();
    }
  );

  it.each([{ id: "foreign-task" }, { expiresAt: "invalid" }, { version: 0 }])(
    "rejects invalid authoritative snapshots: %j",
    async (invalid) => {
      const present = vi.fn();
      await expect(
        new MemoryAnswerDelivery(
          port(vi.fn(async () => task(invalid)))
        ).observe("task-1", { present })
      ).rejects.toThrow();
      expect(present).not.toHaveBeenCalled();
    }
  );

  it.each([
    { invocationKey: "foreign-invocation" },
    { version: 1 },
    { status: "running" as const }
  ])("rejects changed terminal identity/state: %j", async (changed) => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(task({ status: "completed", version: 2 }))
      .mockResolvedValueOnce(
        task({ status: "completed", version: 2, ...changed })
      );
    await expect(
      new MemoryAnswerDelivery(port(get)).observe("task-1")
    ).rejects.toThrow();
  });

  it("checks adapter freshness again after the final read", async () => {
    let current = true;
    const get = vi
      .fn()
      .mockResolvedValueOnce(task({ status: "completed" }))
      .mockImplementationOnce(async () => {
        current = false;
        return task({ status: "completed" });
      });
    const present = vi.fn();
    expect(
      await new MemoryAnswerDelivery(port(get)).observe("task-1", {
        isCurrent: () => current,
        present
      })
    ).toEqual({ kind: "detached", taskId: "task-1", reason: "stale-origin" });
    expect(present).not.toHaveBeenCalled();
  });

  it("checks expiry on the fresh terminal read", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(task({ status: "completed" }))
      .mockResolvedValueOnce(
        task({
          status: "completed",
          expiresAt: new Date(Date.now() - 1).toISOString()
        })
      );
    const present = vi.fn();
    expect(
      await new MemoryAnswerDelivery(port(get)).observe("task-1", { present })
    ).toEqual({ kind: "detached", taskId: "task-1", reason: "expired" });
    expect(present).not.toHaveBeenCalled();
  });

  it("stops polling at task expiry before its observation deadline", async () => {
    vi.useFakeTimers();
    const execution = port(
      vi.fn(async () =>
        task({ expiresAt: new Date(Date.now() + 100).toISOString() })
      )
    );
    const observation = new MemoryAnswerDelivery(execution).observe("task-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(await observation).toEqual({
      kind: "detached",
      taskId: "task-1",
      reason: "expired"
    });
    expect(execution.get).toHaveBeenCalledTimes(1);
    expect(execution.cancel).not.toHaveBeenCalled();
  });

  it("polls at a bounded interval, detaching at deadline without cancelling work", async () => {
    vi.useFakeTimers();
    const execution = port();
    const delivery = new MemoryAnswerDelivery(execution, {
      pollMs: 250,
      maxObservationMs: 600
    });
    const observation = delivery.observe("task-1");
    await vi.advanceTimersByTimeAsync(600);
    expect(await observation).toEqual({
      kind: "detached",
      taskId: "task-1",
      reason: "observation-timeout"
    });
    expect(execution.get).toHaveBeenCalledTimes(2);
    expect(execution.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a poll wait on a port notification and reads fresh state", async () => {
    vi.useFakeTimers();
    let wake: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const get = vi
      .fn()
      .mockResolvedValueOnce(task())
      .mockResolvedValue(
        task({ status: "completed", version: 2, result: { answer: "fresh" } })
      );
    const execution = {
      ...port(get),
      subscribe: vi.fn((_taskId: string, listener: () => void) => {
        wake = listener;
        return unsubscribe;
      })
    };
    const present = vi.fn();
    const observation = new MemoryAnswerDelivery(execution, {
      pollMs: 60_000
    }).observe("task-1", { present });
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    wake!();
    await vi.advanceTimersByTimeAsync(0);
    expect(await observation).toMatchObject({
      kind: "terminal",
      task: { version: 2 }
    });
    expect(execution.subscribe).toHaveBeenCalledWith(
      "task-1",
      expect.any(Function)
    );
    expect(get).toHaveBeenCalledTimes(3);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ result: { answer: "fresh" } })
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a notification that arrives during a read", async () => {
    vi.useFakeTimers();
    let wake: (() => void) | undefined;
    let reads = 0;
    const execution = {
      ...port(
        vi.fn(async () => {
          reads += 1;
          if (reads === 1) {
            wake!();
            return task();
          }
          return task({ status: "completed", version: 2 });
        })
      ),
      subscribe: (_taskId: string, listener: () => void) => {
        wake = listener;
        return () => undefined;
      }
    };
    const observation = new MemoryAnswerDelivery(execution, {
      pollMs: 60_000
    }).observe("task-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(await observation).toMatchObject({ kind: "terminal" });
    expect(reads).toBe(3);
  });

  it("unsubscribes a detached observer without cancelling work", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const execution = { ...port(), subscribe: vi.fn(() => unsubscribe) };
    const controller = new AbortController();
    const observation = new MemoryAnswerDelivery(execution).observe("task-1", {
      signal: controller.signal
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await observation).toMatchObject({ reason: "observer-aborted" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(execution.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detaches an aborted observer while leaving the execution untouched", async () => {
    vi.useFakeTimers();
    const execution = port();
    const controller = new AbortController();
    const observation = new MemoryAnswerDelivery(execution).observe("task-1", {
      signal: controller.signal
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await observation).toEqual({
      kind: "detached",
      taskId: "task-1",
      reason: "observer-aborted"
    });
    expect(execution.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stuck port read and discards its late terminal result", async () => {
    vi.useFakeTimers();
    let resolveRead!: (value: Task) => void;
    const execution = port(
      vi.fn(
        () =>
          new Promise<Task>((resolve) => {
            resolveRead = resolve;
          })
      )
    );
    const present = vi.fn();
    const observation = new MemoryAnswerDelivery(execution, {
      maxObservationMs: 100
    }).observe("task-1", { present });
    await vi.advanceTimersByTimeAsync(100);
    expect(await observation).toEqual({
      kind: "detached",
      taskId: "task-1",
      reason: "observation-timeout"
    });
    resolveRead(task({ status: "completed" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(present).not.toHaveBeenCalled();
    expect(execution.cancel).not.toHaveBeenCalled();
  });

  it("detaches at known task expiry while the fresh terminal read is stuck", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockResolvedValueOnce(
        task({
          status: "completed",
          expiresAt: new Date(Date.now() + 100).toISOString()
        })
      )
      .mockImplementationOnce(() => new Promise<Task>(() => {}));
    const present = vi.fn();
    const observation = new MemoryAnswerDelivery(port(get)).observe("task-1", {
      present
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await observation).toEqual({
      kind: "detached",
      taskId: "task-1",
      reason: "expired"
    });
    expect(present).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never reads stale or aborted observations", async () => {
    const execution = port();
    const delivery = new MemoryAnswerDelivery(execution);
    await delivery.observe("task-1", { isCurrent: () => false });
    await delivery.observe("task-1", { signal: AbortSignal.abort() });
    expect(execution.get).not.toHaveBeenCalled();
  });

  it("validates the accepted invocation identity", async () => {
    await expect(
      new MemoryAnswerDelivery(port()).accept({}, {}, "wrong-invocation")
    ).rejects.toThrow("invocation identity mismatch");
  });
});
