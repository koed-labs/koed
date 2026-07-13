import { describe, expect, it, vi } from "vitest";
import type { EmbeddableSourceRecord, MemorySourceRepository } from "@koed/db";
import { createEmbeddingWorkflow } from "./embedding-workflow.js";
import type { WorkerEnvConfig } from "./env-config.js";

const workerEnv: WorkerEnvConfig = {
  queueBackend: "bullmq",
  redisUrl: "redis://localhost:6379",
  databaseConfigured: true,
  databaseUrl: "postgres://local",
  embeddingServiceUrl: "http://embedding.local",
  embeddingServiceToken: "worker-token",
  embeddingDimensions: 3,
  embeddingVersion: "test-embedding-model",
  rawProjectionIntervalMs: 5000,
  rawProjectionBatchLimit: 1000,
  rawProjectionActorLimit: 10,
  crossIdentitySyncIntervalMs: 1000,
  crossIdentitySyncStaleAfterSeconds: 86400,
  koedHome: "/tmp/koed-test",
  logLevel: "silent",
  logDestination: { destination: "stderr" },
  nodeEnv: "test",
  production: false
};

const source: EmbeddableSourceRecord = {
  sourceType: "memory_event",
  sourceId: "event-1",
  ownerUserId: "user-1",
  visibility: "personal",
  text: " Source text ",
  sourceHash: "hash-1"
};

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

describe("embedding workflow", () => {
  it("stores validated embedding chunks without prefixing source text", async () => {
    const getEmbeddableSource = vi.fn().mockResolvedValue(source);
    const replaceSourceEmbeddings = vi.fn();
    const getCurrentSourceEmbeddingChunkCount = vi.fn().mockResolvedValue(null);
    replaceSourceEmbeddings
      .mockClear()
      .mockResolvedValue({ ids: ["embedding-1"], inserted: true });
    const repository = {
      getEmbeddableSource,
      getCurrentSourceEmbeddingChunkCount,
      replaceSourceEmbeddings
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "embedding-model",
        dimensions: 3,
        vectors: [[1, 2, 3]],
        chunks: [
          {
            inputIndex: 0,
            chunkIndex: 0,
            chunkCount: 1,
            text: "Source text",
            vector: [1, 2, 3]
          }
        ]
      })
    );
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", "event-1")
    ).resolves.toEqual({
      dimensions: 3,
      inserted: true,
      chunks: 1
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://embedding.local/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ texts: ["Source text"] })
      })
    );
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).not.toContain("Instruct:");
    expect(replaceSourceEmbeddings).toHaveBeenCalledWith(
    expect(getCurrentSourceEmbeddingChunkCount).toHaveBeenCalledWith({
      source,
      model: "test-embedding-model",
      dimensions: 3,
      version: "test-embedding-model"
    });
      expect.objectContaining({
        source,
        model: "embedding-model",
        dimensions: 3,
        version: "test-embedding-model",
        chunks: [
          {
            vector: [1, 2, 3],
            chunkIndex: 0,
            chunkCount: 1,
            sourceText: "Source text"
          }
        ]
      })
    );
  });

  it("rejects invalid embedding service payloads", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi.fn()
    } as unknown as MemorySourceRepository;
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          model: "embedding-model",
          dimensions: 2,
          vectors: [[1, 2]]
        })
      ),
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", "event-1")
    ).rejects.toThrow("embedding service returned an invalid 3-dim response");
  });

  it("reuses a complete current embedding without calling the service", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(2),
      upsertSourceEmbedding: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn();
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", "event-1")
    ).resolves.toEqual({
      dimensions: 3,
      inserted: false,
      chunks: 2
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(repository.upsertSourceEmbedding).not.toHaveBeenCalled();
  });
});
