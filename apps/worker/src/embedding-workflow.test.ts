import { describe, expect, it, vi } from "vitest";
import type { EmbeddableSourceRecord, MemorySourceRepository } from "@koed/db";
import {
  aggregateEmbeddingChunks,
  createEmbeddingWorkflow
} from "./embedding-workflow.js";
import type { WorkerEnvConfig } from "./env-config.js";

const workerEnv: WorkerEnvConfig = {
  teamCollaborationEnabled: false,
  queueBackend: "bullmq",
  redisUrl: "redis://localhost:6379",
  databaseConfigured: true,
  databaseUrl: "postgres://local",
  embeddingServiceUrl: "http://embedding.local",
  embeddingServiceToken: "worker-token",
  embeddingPoolKey: "default",
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
  embeddingCapacityRefinedDelayMs: 1_800_000,
  rawProjectionBatchLimit: 1000,
  rawProjectionActorLimit: 10,
  crossIdentitySyncIntervalMs: 1000,
  crossIdentitySyncStaleAfterSeconds: 86400,
  retentionPurgeIntervalMs: 1000,
  collaborationReplayPruneIntervalMs: 60000,
  collaborationReplayPruneBatchLimit: 1000,
  managedConversationAppServerBinary: "codex",
  managedConversationModel: "gpt-test",
  managedConversationClaudeModel: "claude-haiku-4-5-20251001",
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

describe("Team semantic chunk aggregation", () => {
  it("uses a deterministic L2-normalized arithmetic mean", () => {
    const forward = aggregateEmbeddingChunks([
      { vector: [1, 0, 0] },
      { vector: [0, 1, 0] }
    ]);
    const repeated = aggregateEmbeddingChunks([
      { vector: [1, 0, 0] },
      { vector: [0, 1, 0] }
    ]);
    expect(forward).toEqual(repeated);
    expect(forward[0]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(forward[1]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(forward[2]).toBe(0);
  });
});

describe("Team semantic embedding reconciliation", () => {
  it("accounts for a failed batch per item and preserves successful isolated work", async () => {
    const repository = {
      listPendingSharedMemorySemanticItems: vi
        .fn()
        .mockImplementation(
          async (
            input: NonNullable<
              Parameters<
                MemorySourceRepository["listPendingSharedMemorySemanticItems"]
              >[0]
            >
          ) => {
            const items = [
              {
                semanticItemId: "00000000-0000-4000-8000-000000000001",
                representationId: "00000000-0000-4000-8000-000000000011",
                shareGrantId: "00000000-0000-4000-8000-000000000021",
                sourceItemIndex: 0,
                text: "first",
                contentHash: "a".repeat(64),
                embeddingJobKey: "c".repeat(64),
                computationReuseKey: "e".repeat(64),
                personalEmbeddingReuse: null
              },
              {
                semanticItemId: "00000000-0000-4000-8000-000000000002",
                representationId: "00000000-0000-4000-8000-000000000011",
                shareGrantId: "00000000-0000-4000-8000-000000000021",
                sourceItemIndex: 1,
                text: "second",
                contentHash: "b".repeat(64),
                embeddingJobKey: "d".repeat(64),
                computationReuseKey: "f".repeat(64),
                personalEmbeddingReuse: null
              }
            ];
            await input.duringAuthorizedLease?.(items);
            return items;
          }
        ),
      storeSharedMemorySemanticEmbedding: vi.fn().mockResolvedValue(true),
      reusePersonalSharedMemorySemanticEmbedding: vi
        .fn()
        .mockResolvedValue(false),
      markSharedMemorySemanticEmbeddingFailed: vi
        .fn()
        .mockResolvedValue(undefined)
    } as unknown as MemorySourceRepository;
    let call = 0;
    const fetchFn = vi.fn().mockImplementation((_url, init: RequestInit) => {
      call += 1;
      if (call === 1 || call === 3)
        return Promise.resolve(
          jsonResponse(
            {
              detail:
                "upstream-model-detail-sentinel second-team-memory-sentinel"
            },
            503
          )
        );
      const text = (JSON.parse(String(init.body)) as { texts: string[] })
        .texts[0]!;
      return Promise.resolve(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: [[1, 0, 0]],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 1,
              text,
              vector: [1, 0, 0]
            }
          ]
        })
      );
    });
    const result = await createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    }).reconcileSharedMemorySemanticItems();

    expect(result).toEqual({ processed: 2, embedded: 1, failed: 1 });
    expect(repository.storeSharedMemorySemanticEmbedding).toHaveBeenCalledTimes(
      1
    );
    expect(
      repository.markSharedMemorySemanticEmbeddingFailed
    ).toHaveBeenCalledWith({
      semanticItemId: "00000000-0000-4000-8000-000000000002",
      errorClass: "EmbeddingTransportError"
    });
    expect(
      JSON.stringify(
        vi.mocked(repository.markSharedMemorySemanticEmbeddingFailed).mock.calls
      )
    ).not.toContain("upstream-model-detail-sentinel");
    expect(
      JSON.stringify(
        vi.mocked(repository.markSharedMemorySemanticEmbeddingFailed).mock.calls
      )
    ).not.toContain("second-team-memory-sentinel");
    expect(
      repository.listPendingSharedMemorySemanticItems
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-embedding-model",
        version: expect.stringContaining("team-semantic-v1")
      })
    );
  });

  it("reuses an exact owner-scoped Personal embedding without inference", async () => {
    const reuse = {
      memoryEmbeddingId: "00000000-0000-4000-8000-000000000031",
      model: "test-embedding-model",
      dimensions: 1024 as const,
      version: "personal-generation"
    };
    const item = {
      semanticItemId: "00000000-0000-4000-8000-000000000001",
      representationId: "00000000-0000-4000-8000-000000000011",
      shareGrantId: "00000000-0000-4000-8000-000000000021",
      sourceItemIndex: 0,
      text: "unchanged sanitized text",
      contentHash: "a".repeat(64),
      personalEmbeddingReuse: reuse
    };
    const repository = {
      listPendingSharedMemorySemanticItems: vi
        .fn()
        .mockImplementation(async (input) => {
          await input.duringAuthorizedLease?.([item]);
          return [item];
        }),
      reusePersonalSharedMemorySemanticEmbedding: vi
        .fn()
        .mockResolvedValue(true),
      storeSharedMemorySemanticEmbedding: vi.fn(),
      markSharedMemorySemanticEmbeddingFailed: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn();

    const result = await createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    }).reconcileSharedMemorySemanticItems();

    expect(result).toEqual({ processed: 1, embedded: 1, failed: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      repository.reusePersonalSharedMemorySemanticEmbedding
    ).toHaveBeenCalledWith({
      semanticItemId: item.semanticItemId,
      contentHash: item.contentHash,
      ...reuse
    });
    expect(
      repository.storeSharedMemorySemanticEmbedding
    ).not.toHaveBeenCalled();
  });

  it("embeds one changed input once for equivalent grant-scoped representations", async () => {
    const items = [
      {
        semanticItemId: "00000000-0000-4000-8000-000000000001",
        representationId: "00000000-0000-4000-8000-000000000011",
        shareGrantId: "00000000-0000-4000-8000-000000000021",
        sourceItemIndex: 0,
        text: "same sanitized bytes",
        contentHash: "a".repeat(64),
        embeddingJobKey: "b".repeat(64),
        computationReuseKey: "c".repeat(64),
        personalEmbeddingReuse: null
      },
      {
        semanticItemId: "00000000-0000-4000-8000-000000000002",
        representationId: "00000000-0000-4000-8000-000000000012",
        shareGrantId: "00000000-0000-4000-8000-000000000022",
        sourceItemIndex: 0,
        text: "same sanitized bytes",
        contentHash: "a".repeat(64),
        embeddingJobKey: "d".repeat(64),
        computationReuseKey: "c".repeat(64),
        personalEmbeddingReuse: null
      }
    ];
    const repository = {
      listPendingSharedMemorySemanticItems: vi
        .fn()
        .mockImplementation(async (input) => {
          await input.duringAuthorizedLease?.(items);
          return items;
        }),
      storeSharedMemorySemanticEmbedding: vi.fn().mockResolvedValue(true),
      reusePersonalSharedMemorySemanticEmbedding: vi.fn(),
      markSharedMemorySemanticEmbeddingFailed: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "test-embedding-model",
        dimensions: 3,
        vectors: [[1, 0, 0]],
        chunks: [
          {
            inputIndex: 0,
            chunkIndex: 0,
            chunkCount: 1,
            text: "same sanitized bytes",
            vector: [1, 0, 0]
          }
        ]
      })
    );

    await expect(
      createEmbeddingWorkflow({
        env: workerEnv,
        fetchFn,
        repository: () => repository
      }).reconcileSharedMemorySemanticItems()
    ).resolves.toEqual({ processed: 2, embedded: 2, failed: 0 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      texts: ["same sanitized bytes"]
    });
    expect(repository.storeSharedMemorySemanticEmbedding).toHaveBeenCalledTimes(
      2
    );
  });
});

const source: EmbeddableSourceRecord = {
  sourceType: "memory_event",
  sourceId: "event-1",
  ownerUserId: "user-1",
  visibility: "personal",
  text: " Source text ",
  sourceHash: "hash-1"
};

const jsonResponse = (body: Record<string, unknown>, status = 200) => {
  const chunks = Array.isArray(body.chunks)
    ? body.chunks.map((chunk) =>
        typeof chunk === "object" && chunk !== null
          ? { tokenCount: 1, ...chunk }
          : chunk
      )
    : body.chunks;
  const measuredTokens = Array.isArray(chunks)
    ? chunks.reduce(
        (total, chunk) =>
          total +
          (typeof chunk === "object" &&
          chunk !== null &&
          typeof chunk.tokenCount === "number"
            ? chunk.tokenCount
            : 0),
        0
      )
    : 0;
  return new Response(JSON.stringify({ measuredTokens, ...body, chunks }), {
    status,
    headers: { "content-type": "application/json" }
  });
};

describe("embedding workflow", () => {
  it("imports the hosted Personal artifact without local model inference", async () => {
    const getCurrentSourceEmbeddingChunkCount = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(1);
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount,
      getPersonalSourceReplicationPolicy: vi.fn().mockResolvedValue({
        enabled: true,
        mode: "hosted_personal",
        targetUpstreamId: "hosted"
      })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ state: "imported", chunks: 1, inserted: true })
      );

    await expect(
      createEmbeddingWorkflow({
        env: {
          ...workerEnv,
          managedConversationApiUrl: "http://memory.local:3300",
          managedConversationApiToken: "local-worker-token"
        },
        fetchFn,
        repository: () => repository
      }).embedSource("memory_event", "event-1")
    ).resolves.toEqual({ dimensions: 3, inserted: true, chunks: 1 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "http://memory.local:3300/v1/personal-semantic-artifacts/import"
    );
    expect(String(fetchFn.mock.calls[0]?.[0])).not.toContain("/embed");
  });

  it("does not fall back to local inference while hosted authority is pending", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      getPersonalSourceReplicationPolicy: vi.fn().mockResolvedValue({
        enabled: true,
        mode: "hosted_personal",
        targetUpstreamId: "hosted"
      }),
      replaceSourceEmbeddings: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ state: "hosted_pending" }));

    await expect(
      createEmbeddingWorkflow({
        env: {
          ...workerEnv,
          managedConversationApiUrl: "http://memory.local:3300",
          managedConversationApiToken: "local-worker-token"
        },
        fetchFn,
        repository: () => repository
      }).embedSource("memory_event", "event-1")
    ).rejects.toMatchObject({
      name: "HostedSemanticAuthorityPendingError",
      transient: true
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(repository.replaceSourceEmbeddings).not.toHaveBeenCalled();
  });

  it("restores local inference only after an explicit authority policy change", async () => {
    const getPersonalSourceReplicationPolicy = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        mode: "hosted_personal",
        targetUpstreamId: "hosted"
      })
      .mockResolvedValueOnce({
        enabled: false,
        mode: "hosted_personal",
        targetUpstreamId: null
      });
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      getPersonalSourceReplicationPolicy,
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ ids: ["embedding-1"], inserted: true })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ state: "hosted_pending" }))
      .mockResolvedValueOnce(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: [[1, 2, 3]],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 1,
              tokenCount: 2,
              text: "Source text",
              vector: [1, 2, 3]
            }
          ]
        })
      );
    const workflow = createEmbeddingWorkflow({
      env: {
        ...workerEnv,
        managedConversationApiUrl: "http://memory.local:3300",
        managedConversationApiToken: "local-worker-token"
      },
      fetchFn,
      repository: () => repository
    });

    await expect(
      workflow.embedSource("memory_event", "event-1")
    ).rejects.toMatchObject({
      name: "HostedSemanticAuthorityPendingError"
    });
    await expect(
      workflow.embedSource("memory_event", "event-1")
    ).resolves.toEqual({
      dimensions: 3,
      inserted: true,
      chunks: 1,
      measuredTokens: 2
    });

    expect(getPersonalSourceReplicationPolicy).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain(
      "/v1/personal-semantic-artifacts/import"
    );
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("/embed");
    expect(repository.replaceSourceEmbeddings).toHaveBeenCalledTimes(1);
  });

  it("fails before inference when hosted authority lacks its local API bridge", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      getPersonalSourceReplicationPolicy: vi.fn().mockResolvedValue({
        enabled: true,
        mode: "hosted_personal",
        targetUpstreamId: "hosted"
      }),
      replaceSourceEmbeddings: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn();

    await expect(
      createEmbeddingWorkflow({
        env: workerEnv,
        fetchFn,
        repository: () => repository
      }).embedSource("memory_event", "event-1")
    ).rejects.toMatchObject({
      name: "HostedSemanticAuthorityConfigurationError",
      transient: false
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(repository.replaceSourceEmbeddings).not.toHaveBeenCalled();
  });

  it("uses validated chunk token counts when usage metadata is absent", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ ids: ["embedding-1"], inserted: true })
    } as unknown as MemorySourceRepository;
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          measuredTokens: null,
          vectors: [[1, 2, 3]],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 1,
              tokenCount: 7,
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
    ).resolves.toMatchObject({ measuredTokens: 7, inserted: true });
  });

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
      workflow.embedSource(
        "memory_event",
        "event-1",
        "interactive_recall_question"
      )
    ).resolves.toEqual({
      dimensions: 3,
      inserted: true,
      chunks: 1,
      measuredTokens: 1
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://embedding.local/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ texts: ["Source text"] }),
        headers: expect.objectContaining({
          "x-koed-embedding-priority": "interactive"
        })
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
            inputTokenCount: 1,
            sourceText: "Source text"
          }
        ]
      })
    );
  });

  it("keeps live capture embedding work in the background lane", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ ids: ["embedding-1"], inserted: true })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockResolvedValue(
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
    );
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn,
      repository: () => repository
    });

    await workflow.embedSource(
      "memory_event",
      "event-1",
      "live_capture_projection"
    );

    expect(fetchFn).toHaveBeenCalledWith(
      "http://embedding.local/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-koed-embedding-priority": "background"
        })
      })
    );
  });

  it("yields between bounded background embedding requests", async () => {
    const longSource = { ...source, text: "x".repeat(9_000) };
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(longSource),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi.fn().mockResolvedValue({
        ids: ["embedding-1", "embedding-2", "embedding-3"],
        inserted: true
      })
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { texts: string[] };
      return Promise.resolve(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          vectors: body.texts.map(() => [1, 2, 3]),
          chunks: body.texts.map((text, inputIndex) => ({
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
      env: workerEnv,
      fetchFn,
      repository: () => repository
    });

    await workflow.embedSource(
      "memory_event",
      "event-1",
      "live_capture_projection"
    );

    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchFn.mock.calls) {
      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      expect(body.texts.join("").length).toBeLessThanOrEqual(4_096);
      expect(new Headers(init?.headers).get("x-koed-embedding-priority")).toBe(
        "background"
      );
    }
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

  it("keeps execution token totals separate from chunk tokenizer counts", async () => {
    const repository = {
      getEmbeddableSource: vi.fn().mockResolvedValue(source),
      getCurrentSourceEmbeddingChunkCount: vi.fn().mockResolvedValue(null),
      replaceSourceEmbeddings: vi
        .fn()
        .mockResolvedValue({ inserted: true, ids: ["embedding-1"] })
    } as unknown as MemorySourceRepository;
    const workflow = createEmbeddingWorkflow({
      env: workerEnv,
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          model: "test-embedding-model",
          dimensions: 3,
          measuredTokens: 99,
          vectors: [[1, 2, 3]],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 1,
              tokenCount: 2,
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
    ).resolves.toMatchObject({ measuredTokens: 99 });
    expect(repository.replaceSourceEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        chunks: [expect.objectContaining({ inputTokenCount: 2 })]
      })
    );
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
    ).resolves.toEqual({
      dimensions: 3,
      inserted: true,
      chunks: 2,
      measuredTokens: 2
    });
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
      chunks: 3,
      measuredTokens: 3
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
