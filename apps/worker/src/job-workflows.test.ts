import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { MemorySourceRepository } from "@koed/db";
import {
  createWorkerJobWorkflow,
  embeddingJobData,
  type EmbeddingQueueJobData
} from "./job-workflows.js";

describe("worker job workflows", () => {
  it("parses embedding job data", () => {
    expect(
      embeddingJobData({ sourceType: "memory_event", sourceId: 123 })
    ).toEqual({
      sourceType: "memory_event",
      sourceId: "123"
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
      embeddingWorkflow: { embedSource },
      lcmEmbedQueue: {} as Queue<EmbeddingQueueJobData>,
      repository: () => ({}) as MemorySourceRepository
    });

    await expect(
      workflow("memory-embed", {
        sourceType: "message",
        sourceId: "message-1"
      })
    ).resolves.toEqual({ dimensions: 1024, inserted: true, chunks: 1 });
    expect(embedSource).toHaveBeenCalledWith("message", "message-1");
  });
});
