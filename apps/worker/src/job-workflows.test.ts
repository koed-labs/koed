import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import type { KoedJobQueue } from "@koed/shared";
import {
  createWorkerJobWorkflow,
  embeddingJobData,
  enqueueLcmCompaction,
  enqueueSourceEmbedding,
  type CompactionQueueJobData,
  type EmbeddingQueueJobData
} from "./job-workflows.js";

describe("worker job workflows", () => {
  it("parses embedding job data", () => {
    expect(
      embeddingJobData({ sourceType: "memory_event", sourceId: 123 })
    ).toEqual({
      sourceType: "memory_event",
      sourceId: "123",
      workClass: "normal_embedding_lcm"
    });
    expect(
      embeddingJobData({
        sourceType: "curated_memory",
        sourceId: "assertion-1"
      })
    ).toEqual({
      sourceType: "curated_memory",
      sourceId: "assertion-1",
      workClass: "normal_embedding_lcm"
    });
  });

  it("rejects invalid embedding job data", () => {
    expect(() =>
      embeddingJobData({ sourceType: "unknown", sourceId: "event-1" })
    ).toThrow("Embedding job sourceType is invalid");
    expect(() =>
      embeddingJobData({ sourceType: "memory_event", sourceId: "" })
    ).toThrow("Embedding job sourceId is required");
    expect(() => embeddingJobData(null)).toThrow(
      "Worker job data must be an object"
    );
  });

  it("delegates embedding queue jobs to the embedding workflow", async () => {
    const embedSource = vi
      .fn()
      .mockResolvedValue({ dimensions: 1024, inserted: true, chunks: 1 });
    const workflow = createWorkerJobWorkflow({
      embeddingDispatchKey: "test-model-1024",
      embeddingWorkflow: {
        embedSource,
        embedSources: vi.fn(),
        reconcileSharedMemorySemanticItems: vi.fn(),
        getNextSharedMemorySemanticEmbeddingRetryAt: vi.fn()
      },
      lcmEmbedQueue: {} as KoedJobQueue<EmbeddingQueueJobData>,
      repository: () => ({}) as MemorySourceRepository
    });

    await expect(
      workflow("memory-embed", {
        sourceType: "message",
        sourceId: "message-1"
      })
    ).resolves.toEqual({ dimensions: 1024, inserted: true, chunks: 1 });
    expect(embedSource).toHaveBeenCalledWith(
      "message",
      "message-1",
      "normal_embedding_lcm"
    );

    await workflow("memory-embed", {
      sourceType: "memory_event",
      sourceId: "note-1",
      workClass: "live_capture_projection"
    });
    expect(embedSource).toHaveBeenLastCalledWith(
      "memory_event",
      "note-1",
      "live_capture_projection"
    );
  });

  it("enqueues projection jobs with durable retry options", async () => {
    const embeddingAdd = vi.fn().mockResolvedValue({ id: "embedding-job" });
    const compactionAdd = vi.fn().mockResolvedValue({ id: "compaction-job" });
    const embeddingQueue = {
      add: embeddingAdd
    } as unknown as KoedJobQueue<EmbeddingQueueJobData>;
    const compactionQueue = {
      add: compactionAdd
    } as unknown as KoedJobQueue<CompactionQueueJobData>;
    const retryOptions = {
      priority: 10,
      attempts: 5,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 1000,
      removeOnFail: true
    };

    await enqueueSourceEmbedding(
      embeddingQueue,
      "memory_event",
      "event-1",
      "embedding-v1"
    );
    await enqueueSourceEmbedding(
      embeddingQueue,
      "memory_node",
      "node-1",
      "embedding-v1"
    );
    await enqueueLcmCompaction(
      compactionQueue,
      { userId: "user-1" },
      "personal",
      "pending-events-v1"
    );

    expect(embeddingAdd).toHaveBeenCalledWith(
      "embed-source",
      {
        sourceType: "memory_event",
        sourceId: "event-1",
        workClass: "normal_embedding_lcm"
      },
      {
        ...retryOptions,
        jobId: "embed-embedding-v1-memory_event-event-1"
      }
    );
    expect(embeddingAdd).toHaveBeenCalledWith(
      "embed-source",
      {
        sourceType: "memory_node",
        sourceId: "node-1",
        workClass: "normal_embedding_lcm"
      },
      {
        ...retryOptions,
        jobId: "embed-embedding-v1-memory_node-node-1"
      }
    );
    expect(compactionAdd).toHaveBeenCalledWith(
      "compact-scope",
      {
        userId: "user-1",
        visibility: "personal",
        workClass: "normal_embedding_lcm"
      },
      {
        ...retryOptions,
        jobId: "compact-user-1-personal-pending-events-v1"
      }
    );
  });

  it("passes durable work class through compaction and derived node embedding retries", async () => {
    const createLcmNodes = vi.fn().mockResolvedValue({
      leafNodeIds: ["historical-leaf"],
      rollupNodeId: null
    });
    const add = vi.fn().mockResolvedValue({ id: "historical-node-embedding" });
    const workflow = createWorkerJobWorkflow({
      embeddingDispatchKey: "embedding-v1",
      embeddingWorkflow: {
        embedSource: vi.fn(),
        embedSources: vi.fn(),
        reconcileSharedMemorySemanticItems: vi.fn(),
        getNextSharedMemorySemanticEmbeddingRetryAt: vi.fn()
      },
      lcmEmbedQueue: {
        add
      } as unknown as KoedJobQueue<EmbeddingQueueJobData>,
      repository: () =>
        ({ createLcmNodes }) as unknown as MemorySourceRepository
    });

    await workflow("lcm-compact", {
      userId: "user-1",
      visibility: "personal",
      workClass: "historical_import_backfill"
    });

    expect(createLcmNodes).toHaveBeenCalledWith(
      { userId: "user-1" },
      {
        requesterContext: { userId: "user-1" },
        visibility: "personal",
        workClass: "historical_import_backfill"
      }
    );
    expect(add).toHaveBeenCalledWith(
      "embed-lcm-node",
      {
        sourceType: "memory_node",
        sourceId: "historical-leaf",
        workClass: "historical_import_backfill"
      },
      expect.objectContaining({ priority: 20 })
    );
  });
});
