import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSupportedEmbeddingModelConfig } from "@koed/shared";
import {
  RETRIEVAL_ARENA_DATASET_VERSION,
  retrievalArenaCases,
  retrievalArenaCorpusIdentity,
  retrievalArenaDatasetHash
} from "./cases.js";
import { stableHash, type ArenaProviderCase } from "./contracts.js";
import { productControllerConfigurations } from "./arms.js";
import {
  liveCaseStateHash,
  type LiveProductStateReader,
  type LiveStateRow
} from "./live-product-fixture.js";

const mocks = vi.hoisted(() => ({
  answerWithMemoryWorker: vi.fn<
    (
      payload: unknown,
      options: {
        config: Record<string, number | string>;
        evaluationController?: Record<string, unknown>;
        captureProcessMetrics?: boolean;
      }
    ) => Promise<unknown>
  >(),
  resolveMemoryAnswerWorkerConfig: vi.fn(() => ({
    provider: "codex-app-server",
    model: "product-reader",
    reasoningEffort: "low",
    timeoutMs: 60_000,
    maxAttempts: 2,
    maxSearches: 6,
    maxExpansions: 3,
    maxCandidates: 50,
    maxEvidenceItems: 50,
    maxEvidenceTokens: 8_000,
    maxPromptTokens: 16_000,
    appServerBinary: "codex",
    cwd: process.cwd(),
    env: process.env
  }))
}));

vi.mock("@koed/mcp-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@koed/mcp-server")>()),
  answerWithMemoryWorker: mocks.answerWithMemoryWorker,
  resolveMemoryAnswerWorkerConfig: mocks.resolveMemoryAnswerWorkerConfig
}));

import {
  assertNoLexicalAnchorsInRuntimeResult,
  createKoedRuntimeProductProvider,
  noAnchorComposition,
  noAnchorEmbeddingGeneration,
  noAnchorEmbeddingInput,
  runtimeRetrievalMeasurements,
  verifyNoLexicalAnchorsIndexManifest
} from "./product-harness.js";

const createProductStateManifest = async (
  directory: string,
  benchmarkCase: ArenaProviderCase
) => {
  const productStateManifestPath = path.join(directory, "product-state.json");
  const manifest = JSON.stringify({
    schemaVersion: "koed-retrieval-arena-product-state-v1",
    seed: "fixture-seed-42",
    datasetVersion: RETRIEVAL_ARENA_DATASET_VERSION,
    datasetHash: retrievalArenaDatasetHash,
    corpusIdentity: retrievalArenaCorpusIdentity,
    runtimeIdentity: "fixture-runtime-v1",
    cases: [
      {
        caseId: benchmarkCase.id,
        corpusHash: stableHash(benchmarkCase.corpus),
        stateHash: "a".repeat(64),
        itemIds: benchmarkCase.corpus.map((item) => item.id)
      }
    ]
  });
  await writeFile(productStateManifestPath, manifest);
  return {
    productStateManifestPath,
    responseProof: {
      kind: "live_product",
      manifestHash: createHash("sha256").update(manifest).digest("hex"),
      seed: "fixture-seed-42",
      datasetHash: retrievalArenaDatasetHash,
      corpusIdentity: retrievalArenaCorpusIdentity,
      runtimeIdentity: "fixture-runtime-v1",
      caseStateHash: "a".repeat(64),
      caseCorpusHash: stableHash(benchmarkCase.corpus)
    }
  };
};

describe("runtime retrieval measurements", () => {
  it("ignores orchestration markers and requires complete measured retrieval records", () => {
    const complete = {
      evidenceBundle: {
        retrieval: {
          retrievals: [
            { mode: "app_server_dynamic_tools" },
            {
              databaseReads: 2,
              hydrationCount: 3,
              hydrationBytes: 384,
              decryptCount: 1,
              decryptBytes: 128,
              embeddingCalls: 1,
              embeddingTokens: 24,
              stages: [{ ran: true }, { ran: false }]
            }
          ]
        }
      }
    };
    expect(runtimeRetrievalMeasurements(complete)).toEqual({
      databaseReads: 2,
      hydrationCount: 3,
      hydrationBytes: 384,
      decryptCount: 1,
      decryptBytes: 128,
      embeddingCalls: 1,
      embeddingTokens: 24,
      internalVectorStages: 1
    });

    const incomplete = structuredClone(complete);
    delete (
      incomplete.evidenceBundle.retrieval.retrievals[1] as Record<
        string,
        unknown
      >
    ).decryptCount;
    expect(runtimeRetrievalMeasurements(incomplete).decryptCount).toBeNull();
  });
});

describe("Retrieval Arena product harness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rejects stale independently observed database state before a product call", async () => {
    const benchmarkCase = retrievalArenaCases[0]!;
    const directory = await mkdtemp(path.join(os.tmpdir(), "koed-live-state-"));
    const sourceIds = benchmarkCase.corpus.map(
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    const rows = benchmarkCase.corpus.map<LiveStateRow>((item, index) => ({
      itemId: item.id,
      sourceType: item.sourceType,
      sourceId: sourceIds[index]!,
      ownerUserId: "00000000-0000-4000-8000-000000000099",
      visibility: "personal",
      eventType: "user_prompt",
      sessionId: "00000000-0000-4000-8000-000000000098",
      payload: { content: item.text },
      includeInEmbedding: true,
      includeInLcm: true,
      invalidatedAt: null,
      lcmNodes: [],
      curatedSources: []
    }));
    const productStateManifestPath = path.join(directory, "product-state.json");
    await writeFile(
      productStateManifestPath,
      JSON.stringify({
        schemaVersion: "koed-retrieval-arena-product-state-v1",
        seed: "retrieval-arena-live-product-v1",
        datasetVersion: RETRIEVAL_ARENA_DATASET_VERSION,
        datasetHash: retrievalArenaDatasetHash,
        corpusIdentity: retrievalArenaCorpusIdentity,
        runtimeIdentity: "runtime-a",
        cases: [
          {
            caseId: benchmarkCase.id,
            corpusHash: stableHash(benchmarkCase.corpus),
            stateHash: liveCaseStateHash(rows),
            itemIds: benchmarkCase.corpus.map((item) => item.id),
            productContextHash: stableHash(benchmarkCase.productContext),
            liveSources: benchmarkCase.corpus.map((item, index) => ({
              itemId: item.id,
              sourceType: item.sourceType,
              sourceId: sourceIds[index]
            }))
          }
        ]
      })
    );
    const staleRows = rows.map((row, index) =>
      index === 0 ? { ...row, payload: { content: "stale" } } : row
    );
    const liveStateReader: LiveProductStateReader = {
      runtimeIdentity: async () => "runtime-a",
      readCaseState: async () => staleRows
    };
    const provider = createKoedRuntimeProductProvider({
      baseUrl: "http://127.0.0.1:3000",
      authorization: "Bearer fixture",
      productStateManifestPath,
      liveStateReader
    });
    await expect(
      provider(
        {
          benchmarkCase,
          runIndex: 0,
          deadlineAt: Date.now() + 5_000
        },
        {
          callerHints: true,
          scriptedFirstPass: true,
          lexicalAnchors: true,
          exactAnchorChecks: true,
          lcmExpansion: true,
          followUpSearch: true,
          fusion: true
        }
      )
    ).rejects.toThrow(/stale, incomplete/);
    expect(mocks.answerWithMemoryWorker).not.toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects lexical anchors from every isolated-runtime search result", () => {
    expect(() =>
      assertNoLexicalAnchorsInRuntimeResult({
        hits: [
          {
            sourceId: "later-search-result",
            lexicalAnchors: ["must be rejected"]
          }
        ]
      })
    ).toThrow(/later search result containing lexical anchors/);
  });

  it("reproduces that an ordinary product response cannot satisfy the manifest-only proof contract", async () => {
    const benchmarkCase = retrievalArenaCases[0]!;
    const directory = await mkdtemp(path.join(os.tmpdir(), "koed-no-proof-"));
    const state = await createProductStateManifest(directory, benchmarkCase);
    mocks.answerWithMemoryWorker.mockResolvedValue({
      markdown: "Evidence bundle returned.",
      evidence: [],
      evidenceBundle: { retrieval: { mode: "hybrid" } },
      localMemoryWorker: {
        model: "product-reader",
        memoryStatus: "found",
        searchCount: 1,
        expandCount: 0,
        candidateCount: 1,
        tokenUsage: { total: { inputTokens: 1, outputTokens: 1 } }
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ evidenceBundle: { retrieval: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    const provider = createKoedRuntimeProductProvider({
      baseUrl: "http://127.0.0.1:3000",
      authorization: "Bearer fixture",
      productStateManifestPath: state.productStateManifestPath
    });
    await expect(
      provider(
        {
          benchmarkCase,
          runIndex: 0,
          deadlineAt: Date.now() + 5_000
        },
        {
          callerHints: true,
          scriptedFirstPass: true,
          lexicalAnchors: true,
          exactAnchorChecks: true,
          lcmExpansion: true,
          followUpSearch: true,
          fusion: true
        }
      )
    ).rejects.toThrow(/did not prove the seeded state/);
    await rm(directory, { recursive: true, force: true });
  });

  it("applies shared budgets before synthesis and never invents candidate order or scores", async () => {
    const benchmarkCase = retrievalArenaCases[0]!;
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "koed-product-state-")
    );
    const state = await createProductStateManifest(directory, benchmarkCase);
    const configuration = {
      callerHints: true,
      scriptedFirstPass: true,
      lexicalAnchors: true,
      exactAnchorChecks: true,
      lcmExpansion: true,
      followUpSearch: true,
      fusion: true
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ markdown: "initial", evidence: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    mocks.answerWithMemoryWorker.mockResolvedValue({
      markdown: "The guard is REQUEST_BODY_LIMIT_BYTES.",
      evidence: [
        { text: benchmarkCase.corpus[1]!.text },
        { text: benchmarkCase.corpus[0]!.text }
      ],
      evidenceBundle: {
        retrieval: {
          productStateProof: state.responseProof,
          observedConfigurationHash: stableHash(configuration)
        }
      },
      localMemoryWorker: {
        model: "actual-product-reader",
        memoryStatus: "found",
        searchCount: 1,
        expandCount: 1,
        candidateCount: 5,
        tokenUsage: {
          total: { inputTokens: 120, outputTokens: 30 },
          last: { inputTokens: 20, outputTokens: 5 }
        },
        appServerExecutions: [
          {
            attemptIndex: 1,
            status: "failed",
            model: "actual-product-reader",
            processMetrics: {
              pid: 101,
              peakRssBytes: 40_000,
              measurement: "proc_status_tree",
              sampleCount: 4,
              samplingIntervalMs: 10
            },
            tokenUsage: {
              total: { inputTokens: 40, outputTokens: 10 }
            }
          },
          {
            attemptIndex: 2,
            status: "succeeded",
            model: "actual-product-reader",
            processMetrics: {
              pid: 102,
              peakRssBytes: 60_000,
              measurement: "ps_rss",
              sampleCount: 5,
              samplingIntervalMs: 10
            },
            tokenUsage: {
              total: { inputTokens: 120, outputTokens: 30 }
            }
          }
        ]
      }
    });
    const provider = createKoedRuntimeProductProvider({
      baseUrl: "http://127.0.0.1:3000",
      authorization: "Bearer fixture",
      productStateManifestPath: state.productStateManifestPath
    });
    const output = await provider(
      {
        benchmarkCase: {
          id: benchmarkCase.id,
          split: benchmarkCase.split,
          question: benchmarkCase.question,
          retrievalHints: benchmarkCase.retrievalHints,
          corpus: benchmarkCase.corpus,
          budget: benchmarkCase.budget,
          productContext: benchmarkCase.productContext
        },
        runIndex: 0,
        deadlineAt: Date.now() + 5_000
      },
      configuration
    );

    const workerOptions = mocks.answerWithMemoryWorker.mock.calls[0]![1];
    expect(workerOptions.config).toMatchObject({
      maxCandidates: benchmarkCase.budget.maxCandidates,
      maxEvidenceItems: benchmarkCase.budget.maxEvidenceItems,
      maxEvidenceTokens: benchmarkCase.budget.maxEvidenceTokens,
      maxExpansions: benchmarkCase.budget.maxExpansions,
      maxSearches: benchmarkCase.budget.maxSearchCalls
    });
    expect(workerOptions.config.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(workerOptions.captureProcessMetrics).toBe(true);
    expect(workerOptions.evaluationController).toEqual({
      scriptedFirstPass: true,
      exactAnchorChecks: true,
      lcmExpansion: true,
      followUpSearch: true,
      fusion: true,
      retrievalVariant: "production"
    });
    expect(output.evidence.map((item) => item.itemId)).toEqual(["d2", "d1"]);
    expect(output.evidence.map((item) => item.score)).toEqual([null, null]);
    expect(output.candidates).toBeNull();
    expect(output.metrics?.candidateCount).toBe(5);
    expect(output.readerMetrics).toMatchObject({
      model: "actual-product-reader",
      inputTokens: 160,
      outputTokens: 40,
      status: "completed"
    });
    expect(output.metrics).toMatchObject({
      inputTokens: 160,
      outputTokens: 40
    });
    expect(output.productProof).toMatchObject({
      kind: "live_product",
      seed: "fixture-seed-42",
      observedConfigurationHash: stableHash(configuration)
    });
    expect(output.dynamicAiClientProcesses).toEqual([
      expect.objectContaining({
        attemptIndex: 1,
        pid: 101,
        peakRssBytes: 40_000
      }),
      expect.objectContaining({
        attemptIndex: 2,
        pid: 102,
        peakRssBytes: 60_000
      })
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  it("maps every declared product ablation to a truthful direct-call controller", async () => {
    const benchmarkCase = retrievalArenaCases[0]!;
    const directory = await mkdtemp(path.join(os.tmpdir(), "koed-no-anchor-"));
    const state = await createProductStateManifest(directory, benchmarkCase);
    const indexManifestPath = path.join(directory, "index.json");
    const canonical = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
    const generation = noAnchorEmbeddingGeneration();
    const summary = {
      schema_version: "lcm-semantic-summary-v1" as const,
      title: "Empty anchor fixture",
      summary_text: "A valid summary indexed without lexical anchors.",
      lexical_anchors: [] as []
    };
    const embeddingInput = noAnchorEmbeddingInput(summary);
    const runtimeRow = {
      sourceId: "fixture-summary",
      embeddingId: "00000000-0000-4000-8000-000000000001",
      sourceHash: "1".repeat(64),
      embeddingInputSha256: createHash("sha256")
        .update(embeddingInput)
        .digest("hex"),
      vectorSha256: "2".repeat(64)
    };
    const manifest = JSON.stringify({
      schemaVersion: "retrieval-arena-no-anchor-index-v1",
      runtimeBaseUrl: "http://no-anchors.test",
      embedding: {
        model: canonical.key,
        dimensions: canonical.dimensions,
        artifactHash: canonical.defaultArtifactSha256,
        tokenizer: canonical.tokenizer,
        tokenizerRevision: canonical.tokenizerRevision,
        generation,
        composition: noAnchorComposition
      },
      indexIdentity: {
        databaseName: "koed_no_anchor_fixture",
        schemaName: "public",
        documentSetSha256: createHash("sha256")
          .update(JSON.stringify([runtimeRow]))
          .digest("hex")
      },
      documents: [
        {
          ...runtimeRow,
          structuredSummary: summary,
          embeddingInput,
          embeddingGeneration: generation
        }
      ]
    });
    await writeFile(indexManifestPath, manifest);
    const indexProofHash = createHash("sha256").update(manifest).digest("hex");
    const fetchMock = vi
      .fn<
        (url: string | URL | Request, init?: RequestInit) => Promise<Response>
      >()
      .mockImplementation((url, init) => {
        if (String(url).endsWith("/v1/memory/retrieval-capabilities")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                capabilitySchemaVersion: 1,
                retrieval: {
                  composition: noAnchorComposition,
                  lexicalAnchors: false,
                  indexProofHash,
                  embeddingGeneration: generation
                }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          );
        }
        const request = JSON.parse(String(init?.body)) as { query: string };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              markdown: "initial",
              evidence: [{ sourceId: "one-search-evidence" }],
              evidenceBundle: {
                query: request.query,
                evidence: [{ sourceId: "one-search-evidence" }],
                retrieval: {
                  ...(String(url).startsWith("http://no-anchors.test/")
                    ? { indexProofHash }
                    : {})
                }
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      });
    vi.stubGlobal("fetch", fetchMock);
    const rewriteProvider = vi.fn().mockResolvedValue({
      query: "rewritten dense query",
      model: "rewrite-model"
    });
    const embed = vi
      .fn<
        (
          texts: string[],
          options?: { signal?: AbortSignal }
        ) => Promise<number[][]>
      >()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map((_, index) => (index === 0 ? [1, 0] : [1 / (index + 1), 1]))
        )
      );
    const provider = createKoedRuntimeProductProvider({
      baseUrl: "http://production.test",
      authorization: "Bearer fixture",
      productStateManifestPath: state.productStateManifestPath,
      embeddingProvider: {
        id: "koed-embedding-service",
        model: "qwen3-0.6b",
        dimensions: 1024,
        embed
      },
      rewriteProvider,
      noLexicalAnchorsRuntime: {
        baseUrl: "http://no-anchors.test",
        authorization: "Bearer isolated",
        indexManifestPath
      }
    });
    const declaredConfigurations = productControllerConfigurations();
    const production = declaredConfigurations[0]!.configuration;
    const configurations = declaredConfigurations
      .slice(1)
      .map(({ configuration }) => configuration);
    let configurationIndex = 0;
    mocks.answerWithMemoryWorker.mockImplementation(() => {
      const configuration = configurations[configurationIndex++]!;
      return Promise.resolve({
        markdown: "No matching memory.",
        evidence: [],
        evidenceBundle: {
          retrieval: {
            productStateProof: state.responseProof,
            observedConfigurationHash: stableHash(configuration)
          }
        },
        localMemoryWorker: {
          model: "product-reader",
          memoryStatus: "not_found",
          searchCount: 0,
          expandCount: 0,
          candidateCount: 0
        }
      });
    });

    for (const configuration of configurations) {
      await provider(
        {
          benchmarkCase: {
            id: benchmarkCase.id,
            split: benchmarkCase.split,
            question: benchmarkCase.question,
            retrievalHints: benchmarkCase.retrievalHints,
            corpus: benchmarkCase.corpus,
            budget: benchmarkCase.budget,
            productContext: benchmarkCase.productContext
          },
          runIndex: 0,
          deadlineAt: Date.now() + 5_000
        },
        configuration
      );
    }

    expect(mocks.answerWithMemoryWorker).toHaveBeenCalledTimes(
      configurations.length
    );
    const controllers = mocks.answerWithMemoryWorker.mock.calls.map(
      (call) => call[1].evaluationController
    );
    expect(controllers[1]).toMatchObject({ scriptedFirstPass: false });
    expect(controllers[2]).toMatchObject({
      retrievalVariant: "empty_lexical_anchors"
    });
    expect(controllers[3]).toMatchObject({ exactAnchorChecks: false });
    expect(controllers[4]).toMatchObject({ lcmExpansion: false });
    expect(controllers[5]).toMatchObject({ followUpSearch: false });
    expect(controllers[6]).toMatchObject({ fusion: false });
    expect(controllers[7]).toMatchObject({
      scriptedFirstPass: false,
      followUpSearch: false,
      fusion: false
    });
    expect(controllers[8]).toMatchObject({
      scriptedFirstPass: false,
      followUpSearch: false,
      retrievalVariant: "rewrite_one_dense"
    });
    expect(controllers[9]).toMatchObject({
      scriptedFirstPass: false,
      followUpSearch: false,
      retrievalVariant: "qwen_dense_single_shot"
    });
    expect(rewriteProvider).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith("http://no-anchors.test/")
      )
    ).toBe(true);
    expect(embed).toHaveBeenCalledTimes(2);
    const noFirstPassPayload = mocks.answerWithMemoryWorker.mock
      .calls[1]?.[0] as {
      evidenceBundle?: { evidence?: unknown[] };
    };
    expect(noFirstPassPayload.evidenceBundle?.evidence).toEqual([]);
    const oneSearchPayload = mocks.answerWithMemoryWorker.mock
      .calls[7]?.[0] as {
      evidenceBundle?: { evidence?: unknown[] };
    };
    expect(oneSearchPayload.evidenceBundle?.evidence).toEqual([
      { sourceId: "one-search-evidence" }
    ]);
    expect(embed.mock.calls[0]?.[0]?.[0]).toContain(
      "Query: rewritten dense query"
    );
    expect(embed.mock.calls[1]?.[0]?.[0]).toContain(
      `Query: ${benchmarkCase.question}`
    );
    const noAnchorPayload = mocks.answerWithMemoryWorker.mock.calls[2]?.[0] as {
      evidenceBundle?: { retrieval?: Record<string, unknown> };
    };
    expect(noAnchorPayload.evidenceBundle?.retrieval).toMatchObject({
      evaluationComposition: noAnchorComposition,
      indexProofHash
    });
    const rewritePayload = mocks.answerWithMemoryWorker.mock.calls[8]?.[0] as {
      evidenceBundle?: { retrieval?: Record<string, unknown> };
    };
    expect(rewritePayload.evidenceBundle?.retrieval).toMatchObject({
      mode: "retrieval_arena_dense_single_shot",
      model: "qwen3-0.6b",
      dimensions: 1024,
      queryTransform: "one_rewrite"
    });
    const singleShotPayload = mocks.answerWithMemoryWorker.mock
      .calls[9]?.[0] as {
      evidenceBundle?: { retrieval?: Record<string, unknown> };
    };
    expect(singleShotPayload.evidenceBundle?.retrieval).toMatchObject({
      mode: "retrieval_arena_dense_single_shot",
      model: "qwen3-0.6b",
      dimensions: 1024,
      queryTransform: "none"
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          capabilitySchemaVersion: 1,
          retrieval: {
            composition: noAnchorComposition,
            lexicalAnchors: false,
            indexProofHash: "b".repeat(64),
            embeddingGeneration: generation
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    await expect(
      provider(
        {
          benchmarkCase: {
            id: benchmarkCase.id,
            split: benchmarkCase.split,
            question: benchmarkCase.question,
            retrievalHints: benchmarkCase.retrievalHints,
            corpus: benchmarkCase.corpus,
            budget: benchmarkCase.budget,
            productContext: benchmarkCase.productContext
          },
          runIndex: 0,
          deadlineAt: Date.now() + 5_000
        },
        { ...production, lexicalAnchors: false }
      )
    ).rejects.toThrow(/did not attest the required isolated composition/);
    const staleManifest = JSON.parse(manifest) as {
      documents: Array<Record<string, unknown>>;
    };
    staleManifest.documents[0] = {
      ...staleManifest.documents[0],
      embeddingInput: `${embeddingInput}\nLegacy anchors: [REQUEST_BODY_LIMIT_BYTES]`
    };
    await writeFile(indexManifestPath, JSON.stringify(staleManifest));
    await expect(
      verifyNoLexicalAnchorsIndexManifest(
        indexManifestPath,
        "http://no-anchors.test"
      )
    ).rejects.toThrow(/stale or anchor-influenced embedding/);
    await rm(directory, { recursive: true, force: true });
  });
});
