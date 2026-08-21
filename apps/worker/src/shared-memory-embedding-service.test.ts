import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSharedMemoryEmbeddingService } from "./shared-memory-embedding-service.js";

describe("Shared Memory embedding reconciliation", () => {
  const wakeClient = () => {
    const emitter = new EventEmitter();
    const queries: string[] = [];
    return Object.assign(emitter, {
      queries,
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
      }),
      release: vi.fn(),
      removeAllListeners(event?: "notification" | "error") {
        EventEmitter.prototype.removeAllListeners.call(emitter, event);
      }
    });
  };

  it("runs through the normal background embedding workflow", async () => {
    const reconcileSharedMemorySemanticItems = vi.fn().mockResolvedValue({
      processed: 2,
      embedded: 2,
      failed: 0
    });
    const getNextSharedMemorySemanticEmbeddingRetryAt = vi
      .fn()
      .mockResolvedValue(null);
    const service = createSharedMemoryEmbeddingService({
      embeddingWorkflow: {
        reconcileSharedMemorySemanticItems,
        getNextSharedMemorySemanticEmbeddingRetryAt
      },
      wakePool: { connect: vi.fn(async () => wakeClient()) },
      logger: { info: vi.fn(), error: vi.fn() }
    });

    await expect(service.processOnce()).resolves.toEqual({
      processed: 2,
      embedded: 2,
      failed: 0
    });
    expect(reconcileSharedMemorySemanticItems).toHaveBeenCalledWith({
      limit: 32
    });
  });

  it("uses notification wakes without an idle polling timer", async () => {
    const client = wakeClient();
    const reconcileSharedMemorySemanticItems = vi.fn().mockResolvedValue({
      processed: 0,
      embedded: 0,
      failed: 0
    });
    const getNextSharedMemorySemanticEmbeddingRetryAt = vi
      .fn()
      .mockResolvedValue(null);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const service = createSharedMemoryEmbeddingService({
      embeddingWorkflow: {
        reconcileSharedMemorySemanticItems,
        getNextSharedMemorySemanticEmbeddingRetryAt
      },
      wakePool: { connect: vi.fn(async () => client) },
      logger: { info: vi.fn(), error: vi.fn() }
    });

    service.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcileSharedMemorySemanticItems).toHaveBeenCalledTimes(1);
    client.emit("notification", {
      channel: "koed_collaboration_realtime"
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcileSharedMemorySemanticItems).toHaveBeenCalledTimes(2);

    expect(client.queries).toContain("listen koed_collaboration_realtime");
    expect(timer).not.toHaveBeenCalled();
    await service.stop();
    expect(client.queries).toContain("unlisten koed_collaboration_realtime");
  });

  it("wakes once at the earliest durable embedding retry time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const client = wakeClient();
    const reconcileSharedMemorySemanticItems = vi.fn().mockResolvedValue({
      processed: 0,
      embedded: 0,
      failed: 0
    });
    const getNextSharedMemorySemanticEmbeddingRetryAt = vi
      .fn()
      .mockResolvedValueOnce("2026-08-13T00:00:05.000Z")
      .mockResolvedValue(null);
    const service = createSharedMemoryEmbeddingService({
      embeddingWorkflow: {
        reconcileSharedMemorySemanticItems,
        getNextSharedMemorySemanticEmbeddingRetryAt
      },
      wakePool: { connect: vi.fn(async () => client) },
      logger: { info: vi.fn(), error: vi.fn() }
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileSharedMemorySemanticItems).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(reconcileSharedMemorySemanticItems).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcileSharedMemorySemanticItems).toHaveBeenCalledTimes(2);

    await service.stop();
    vi.useRealTimers();
  });
});
