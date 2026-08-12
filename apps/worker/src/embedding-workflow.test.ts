import { describe, expect, it, vi } from "vitest";
import type { EmbeddableSourceRecord, MemorySourceRepository } from "@koed/db";
import { createEmbeddingWorkflow } from "./embedding-workflow.js";
import type { WorkerEnvConfig } from "./env-config.js";

const workerEnv: WorkerEnvConfig = {
  teamCollaborationEnabled: false,
  queueBackend: "bullmq",
  redisUrl: "redis://localhost:6379",
  databaseConfigured: true,
  databaseUrl: "postgres://local",
  embeddingServiceUrl: "http://embedding.local",
  embeddingServiceToken: "worker-token",
  embeddingDimensions: 3,
  embeddingVersion: "test-embedding-model",
  embeddingModelArtifactHash: "a".repeat(64),
  embeddingTokenizer: "test-tokenizer",
  embeddingInputTransform: "test-input-transform",
  embeddingPooling: "last",
  embeddingNormalization: "l2",
  embeddingBatchLimit: 16,
  embeddingMaxTextChars: 200_000,
  embeddingMaxRequestChars: 1_000_000,
  embeddingRequestTimeoutMs: 900_000,
  rawProjectionBatchLimit: 1000,
  rawProjectionActorLimit: 10,
  crossIdentitySyncIntervalMs: 1000,
  crossIdentitySyncStaleAfterSeconds: 86400,
  retentionPurgeIntervalMs: 1000,
  collaborationReplayPruneIntervalMs: 60000,
  collaborationReplayPruneBatchLimit: 1000,
  managedConversationAppServerBinary: "codex",
  managedConversationModel: "gpt-test",
  managedConversationReasoningEffort: "low",
  koedHome: "/tmp/koed-test",
  historicalImport: {
    maxRows: 100,
    maxBytes: 1_000_000,
    maxRuntimeMs: 15_000,
    maxConcurrency: 1,
    maxLiveProjectionRows: 0
  },
  historicalImportApiReadyTimeoutMs: 1_000,
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
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          model: "test-embedding-model",
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
      )
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
    expect(getCurrentSourceEmbeddingChunkCount).toHaveBeenCalledWith({
      source,
      model: "test-embedding-model",
      dimensions: 3,
      version: "test-embedding-model"
    });
    expect(replaceSourceEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        model: "test-embedding-model",
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

  it("rejects a valid-dimensional response from the wrong model", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi.fn()
    } as unknown as MemorySourceRepository;
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          model: "unexpected-model",
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
      ),
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", "event-1")
    ).rejects.toThrow("embedding service returned an invalid 3-dim response");
    expect(repository.replaceSourceEmbeddings).not.toHaveBeenCalled();
  });

  it("reuses a complete current embedding without calling the service", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(2),
      replaceSourceEmbeddings: vi.fn()
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
    expect(repository.replaceSourceEmbeddings).not.toHaveBeenCalled();
  });

  it("embeds missing sources in bounded batches while preserving source identity", async () => {
    const secondSource: EmbeddableSourceRecord = {
      ...source,
      sourceId: "event-2",
      text: "Second source text",
      sourceHash: "hash-2"
    };
    const repository = {
      getEmbeddableSource: vi
        .fn()
        .mockImplementation((_sourceType, sourceId) =>
          Promise.resolve(sourceId === source.sourceId ? source : secondSource)
        ),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ ids: ["embedding"], inserted: true })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "test-embedding-model",
        dimensions: 3,
        vectors: [
          [1, 2, 3],
          [4, 5, 6]
        ],
        chunks: [
          {
            inputIndex: 0,
            chunkIndex: 0,
            chunkCount: 1,
            text: "Source text",
            vector: [1, 2, 3]
          },
          {
            inputIndex: 1,
            chunkIndex: 0,
            chunkCount: 1,
            text: "Second source text",
            vector: [4, 5, 6]
          }
        ]
      })
    );
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    });

    await workflow.embedSources([
      { sourceType: "memory_event", sourceId: source.sourceId },
      { sourceType: "memory_event", sourceId: secondSource.sourceId }
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://embedding.local/embed",
      expect.objectContaining({
        body: JSON.stringify({
          texts: ["Source text", "Second source text"]
        })
      })
    );
    expect(repository.replaceSourceEmbeddings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source,
        chunks: [expect.objectContaining({ vector: [1, 2, 3] })]
      })
    );
    expect(repository.replaceSourceEmbeddings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        source: secondSource,
        chunks: [expect.objectContaining({ vector: [4, 5, 6] })]
      })
    );
  });

  it("bounds source-state lookup concurrency before embedding", async () => {
    let activeLookups = 0;
    let maxActiveLookups = 0;
    const getEmbeddableSource = vi
      .fn()
      .mockImplementation(
        async (
          sourceType: EmbeddableSourceRecord["sourceType"],
          sourceId: string
        ) => {
          activeLookups += 1;
          maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
          await new Promise<void>((resolve) => setImmediate(resolve));
          activeLookups -= 1;
          return { ...source, sourceType, sourceId };
        }
      );
    const repository = {
      getEmbeddableSource,
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(1),
      replaceSourceEmbeddings: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn();
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    });

    await workflow.embedSources(
      Array.from({ length: 65 }, (_, index) => ({
        sourceType: "memory_event" as const,
        sourceId: `event-${index}`
      }))
    );

    expect(getEmbeddableSource).toHaveBeenCalledTimes(65);
    expect(maxActiveLookups).toBe(32);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects incomplete or misindexed embedding chunks", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi.fn()
    } as unknown as MemorySourceRepository;
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: [[1, 2, 3]],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 2,
              text: "Source text",
              vector: [1, 2, 3]
            }
          ]
        })
      ),
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", source.sourceId)
    ).rejects.toThrow("embedding service returned an invalid 3-dim response");
    expect(repository.replaceSourceEmbeddings).not.toHaveBeenCalled();
  });

  it("accepts complete multi-chunk output for one oversized source", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi.fn().mockResolvedValue({
        ids: ["embedding-1", "embedding-2"],
        inserted: true
      })
    } as unknown as MemorySourceRepository;
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: [
            [1, 2, 3],
            [4, 5, 6]
          ],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 2,
              text: "Source",
              vector: [1, 2, 3]
            },
            {
              inputIndex: 0,
              chunkIndex: 1,
              chunkCount: 2,
              text: "text",
              vector: [4, 5, 6]
            }
          ]
        })
      ),
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", source.sourceId)
    ).resolves.toEqual({ dimensions: 3, inserted: true, chunks: 2 });
    expect(repository.replaceSourceEmbeddings).toHaveBeenCalledTimes(1);
    expect(repository.replaceSourceEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        chunks: [
          expect.objectContaining({ chunkIndex: 0, chunkCount: 2 }),
          expect.objectContaining({ chunkIndex: 1, chunkCount: 2 })
        ]
      })
    );
  });

  it("renews caller state before every bounded embedding batch", async () => {
    const secondSource = { ...source, sourceId: "event-2" };
    const repository = {
      getEmbeddableSource: vi
        .fn()
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(secondSource),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ ids: ["embedding"], inserted: true })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          model: "test-embedding-model",
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
      )
    );
    const beforeBatch = vi.fn().mockResolvedValue(undefined);
    const workflow = createEmbeddingWorkflow({
      env: { ...workerEnv, embeddingBatchLimit: 1 },
      fetchFn,
      repository: () => repository
    });

    await workflow.embedSources(
      [
        { sourceType: "memory_event", sourceId: "event-1" },
        { sourceType: "memory_event", sourceId: "event-2" }
      ],
      { beforeBatch }
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(beforeBatch).toHaveBeenCalledTimes(2);
  });

  it("bounds embedding batches by aggregate source characters", async () => {
    const sources = ["one", "two", "three"].map((id) => ({
      ...source,
      sourceId: id,
      text: id.repeat(4)
    }));
    const repository = {
      getEmbeddableSource: vi
        .fn()
        .mockResolvedValueOnce(sources[0])
        .mockResolvedValueOnce(sources[1])
        .mockResolvedValueOnce(sources[2]),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ ids: ["embedding"], inserted: true })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const texts = (JSON.parse(String(init.body)) as { texts: string[] })
        .texts;
      return Promise.resolve(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: texts.map(() => [1, 2, 3]),
          chunks: texts.map((text, inputIndex) => ({
            inputIndex,
            chunkIndex: 0,
            chunkCount: 1,
            text,
            vector: [1, 2, 3]
          }))
        })
      );
    });
    const workflow = createEmbeddingWorkflow({
      env: { ...workerEnv, embeddingMaxRequestChars: 24 },
      fetchFn,
      repository: () => repository
    });

    await workflow.embedSources(
      sources.map((item) => ({
        sourceType: item.sourceType,
        sourceId: item.sourceId
      }))
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      (
        JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as {
          texts: string[];
        }
      ).texts
    ).toHaveLength(2);
  });

  it("segments oversized sources without splitting Unicode characters", async () => {
    const oversizedSource = {
      ...source,
      text: "abcd😀efghij"
    };
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(oversizedSource),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi.fn().mockResolvedValue({
        ids: ["embedding-1", "embedding-2", "embedding-3"],
        inserted: true
      })
    } as unknown as MemorySourceRepository;
    const submittedTexts: string[][] = [];
    const fetchFn = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const texts = (JSON.parse(String(init.body)) as { texts: string[] })
        .texts;
      submittedTexts.push(texts);
      return Promise.resolve(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: texts.map(() => [1, 2, 3]),
          chunks: texts.map((text, inputIndex) => ({
            inputIndex,
            chunkIndex: 0,
            chunkCount: 1,
            text,
            vector: [1, 2, 3]
          }))
        })
      );
    });
    const workflow = createEmbeddingWorkflow({
      env: {
        ...workerEnv,
        embeddingMaxTextChars: 5,
        embeddingMaxRequestChars: 8
      },
      fetchFn,
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", "event-1")
    ).resolves.toEqual({
      dimensions: 3,
      inserted: true,
      chunks: 3
    });

    expect(submittedTexts).toEqual([["abcd"], ["😀efg", "hij"]]);
    expect(
      submittedTexts.every(
        (texts) =>
          texts.every((text) => text.length <= 5) &&
          texts.reduce((total, text) => total + text.length, 0) <= 8
      )
    ).toBe(true);
    expect(repository.replaceSourceEmbeddings).toHaveBeenCalledTimes(1);
    expect(
      (
        repository.replaceSourceEmbeddings as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0].chunks.map(
        (input: {
          chunkIndex: number;
          chunkCount: number;
          sourceText: string;
        }) => ({
          chunkIndex: input.chunkIndex,
          chunkCount: input.chunkCount,
          sourceText: input.sourceText
        })
      )
    ).toEqual([
      { chunkIndex: 0, chunkCount: 3, sourceText: "abcd" },
      { chunkIndex: 1, chunkCount: 3, sourceText: "😀efg" },
      { chunkIndex: 2, chunkCount: 3, sourceText: "hij" }
    ]);
  });

  it("submits large LCM nodes as individual embedding requests", async () => {
    const nodes = [
      {
        ...source,
        sourceType: "memory_node" as const,
        sourceId: "node-1",
        text: "First node"
      },
      {
        ...source,
        sourceType: "memory_node" as const,
        sourceId: "node-2",
        text: "Second node"
      }
    ];
    const repository = {
      getEmbeddableSource: vi
        .fn()
        .mockResolvedValueOnce(nodes[0])
        .mockResolvedValueOnce(nodes[1]),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ ids: ["embedding"], inserted: true })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const texts = (JSON.parse(String(init.body)) as { texts: string[] })
        .texts;
      return Promise.resolve(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: [[1, 2, 3]],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 1,
              text: texts[0],
              vector: [1, 2, 3]
            }
          ]
        })
      );
    });
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    });

    await workflow.embedSources(
      nodes.map((node) => ({
        sourceType: node.sourceType,
        sourceId: node.sourceId
      }))
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      fetchFn.mock.calls.map((call) => JSON.parse(call[1].body).texts)
    ).toEqual([["First node"], ["Second node"]]);
  });
});
