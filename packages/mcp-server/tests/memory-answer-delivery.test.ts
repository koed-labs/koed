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
    expect(execution.get).toHaveBeenCalledTimes(3);
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
