import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderUnavailableError,
  bm25Rank,
  createArenaModelDescriptor,
  createBm25Arm,
  createDenseArm,
  createKoedEmbeddingServiceProvider,
  createProductArms,
  createRetrievalArenaArms,
  createRerankedArm,
  externalDatasetManifestSchema,
  observedModelMatchesDescriptor,
  productControllerConfigurations,
  reciprocalRankFusion,
  resolveArenaModelPricing,
  resolveKoedEmbeddingServiceReproducibility
} from "./index.js";
import {
  RETRIEVAL_ARENA_DATASET_VERSION,
  retrievalArenaCases,
  retrievalArenaCorpus,
  retrievalArenaCorpusIdentity,
  retrievalArenaDatasetHash,
  retrievalArenaSplitIdentities
} from "./cases.js";
import { scoreRetrieval } from "./metrics.js";
import { qualityLatencyMs, runRetrievalArena } from "./runner.js";
import type { ArenaArm, RankedEvidence } from "./contracts.js";
import type { ArenaPromptRunner } from "./judge.js";
import { retrievalArenaPromptTemplateContents } from "./judge.js";
import { loadPrompt } from "@koed/mcp-server";

describe("Retrieval Arena dataset", () => {
  it("pins deterministic, disjoint development, validation, and held-out cases", () => {
    expect(RETRIEVAL_ARENA_DATASET_VERSION).toBe("koed-first-party-v6");
    expect(retrievalArenaDatasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(retrievalArenaCases.map((item) => item.id)).size).toBe(
      retrievalArenaCases.length
    );
    expect(new Set(retrievalArenaCorpus.map((item) => item.id)).size).toBe(
      retrievalArenaCorpus.length
    );
    expect(new Set(retrievalArenaCases.map((item) => item.split))).toEqual(
      new Set(["development", "validation", "held_out"])
    );
    expect(retrievalArenaCases.flatMap((item) => item.tags)).toEqual(
      expect.arrayContaining([
        "exact_identifier",
        "semantic_paraphrase",
        "authorization",
        "lcm_routing",
        "fresh_pending",
        "budget_exhaustion"
      ])
    );
    expect(
      new Set(
        retrievalArenaCases.map((item) => item.productContext.searchDomain)
      )
    ).toEqual(new Set(["global", "project", "session"]));
    expect(
      retrievalArenaCases.some(
        (item) => item.productContext.memoryClass === "team_workspace"
      )
    ).toBe(true);
    expect(
      new Set(
        retrievalArenaCases.flatMap((item) =>
          item.corpus.map((entry) => entry.sourceType)
        )
      )
    ).toEqual(new Set(["memory_event", "memory_node", "curated_memory"]));
    const structuralMetadata = retrievalArenaCases.flatMap((item) =>
      item.corpus.map((entry) => entry.metadata)
    );
    expect(structuralMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeKind: "lcm_leaf" }),
        expect.objectContaining({ nodeKind: "lcm_rollup" })
      ])
    );
    expect(
      structuralMetadata.some(({ lexicalAnchors }) =>
        Array.isArray(lexicalAnchors)
      )
    ).toBe(true);
    expect(
      structuralMetadata.some(({ hierarchyPath }) =>
        Array.isArray(hierarchyPath)
      )
    ).toBe(true);
  });

  it("matches the reviewed first-party split gold manifest", () => {
    const fixturePath = path.resolve(
      process.cwd(),
      "fixtures/retrieval-arena-first-party-gold.json"
    );
    const gold: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect({
      schemaVersion: "koed-retrieval-arena-first-party-gold-v1",
      datasetVersion: RETRIEVAL_ARENA_DATASET_VERSION,
      datasetHash: retrievalArenaDatasetHash,
      corpusIdentity: retrievalArenaCorpusIdentity,
      splits: retrievalArenaSplitIdentities
    }).toEqual(gold);

    const splitItemSets = Object.values(retrievalArenaSplitIdentities).map(
      ({ corpusItemIds }) => new Set(corpusItemIds)
    );
    for (let left = 0; left < splitItemSets.length; left += 1) {
      for (let right = left + 1; right < splitItemSets.length; right += 1) {
        expect(
          [...splitItemSets[left]!].filter((id) =>
            splitItemSets[right]!.has(id)
          )
        ).toEqual([]);
      }
    }
  });

  it("uses a concrete item budget to make the exhaustion case insufficient", () => {
    const exhausted = retrievalArenaCases.find(
      (item) => item.id === "heldout-budget-insufficient"
    )!;
    expect(exhausted.budget.maxEvidenceItems).toBe(2);
    expect(
      new Set(
        exhausted.qrels.flatMap((qrel) =>
          qrel.grade > 0 && qrel.evidenceGroup ? [qrel.evidenceGroup] : []
        )
      ).size
    ).toBe(3);
    expect(exhausted.answerChecks).toMatchObject({
      status: "insufficient",
      exactFacts: []
    });
  });

  it("requires complete provenance for external dataset adapters", () => {
    expect(() =>
      externalDatasetManifestSchema.parse({
        id: "external",
        repository: "https://example.test/dataset",
        revision: "abc123",
        license: "Apache-2.0",
        sourceHash: "a".repeat(64),
        transformationVersion: "v1",
        corpusHash: "b".repeat(64)
      })
    ).not.toThrow();
    expect(() =>
      externalDatasetManifestSchema.parse({
        id: "unsafe",
        repository: "https://example.test"
      })
    ).toThrow();
  });

  it("resolves independent role prices with explicit global fallbacks", () => {
    expect(
      resolveArenaModelPricing({
        KOED_EVAL_INPUT_PRICE_PER_MILLION_USD: "1",
        KOED_EVAL_OUTPUT_PRICE_PER_MILLION_USD: "2",
        KOED_EVAL_JUDGE_INPUT_PRICE_PER_MILLION_USD: "3",
        KOED_EVAL_PRODUCT_OUTPUT_PRICE_PER_MILLION_USD: "7"
      })
    ).toEqual({
      reader: { input: 1, output: 2 },
      judge: { input: 3, output: 2 },
      rewrite: { input: 1, output: 2 },
      product: { input: 1, output: 7 }
    });
  });
});

describe("Retrieval Arena embedding reproducibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts complete canonical service health and rejects missing strict fields", async () => {
    const complete = {
      status: "ok",
      modelKey: "qwen3-0.6b",
      dimensions: 1024,
      artifact:
        "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
      artifactRevision: "main",
      artifactHash:
        "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      tokenizer: "qwen3-embedding-0.6b-gguf",
      tokenizerRevision:
        "embedded-in-artifact:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      acceleration: "cpu;runtime=llama.cpp;n-gpu-layers=0",
      batchLimit: 16
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(complete), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      resolveKoedEmbeddingServiceReproducibility({
        baseUrl: "http://127.0.0.1:3800",
        strict: true
      })
    ).resolves.toMatchObject({
      artifactHash: complete.artifactHash,
      tokenizerRevision: complete.tokenizerRevision,
      acceleration: complete.acceleration
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ...complete, artifactHash: null }))
      )
    );
    await expect(
      resolveKoedEmbeddingServiceReproducibility({
        baseUrl: "http://127.0.0.1:3800",
        strict: true
      })
    ).rejects.toThrow(
      /strict embedding reproducibility requires.*artifactHash/
    );
  });

  it("requires loaded reranker provenance proved by its artifact hash", async () => {
    const artifactHash = "b".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ok",
            modelKey: "qwen3-0.6b",
            dimensions: 1024,
            artifact:
              "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
            artifactRevision: "main",
            artifactHash:
              "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
            tokenizer: "qwen3-embedding-0.6b-gguf",
            tokenizerRevision:
              "embedded-in-artifact:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
            acceleration: "cpu;runtime=llama.cpp;n-gpu-layers=0",
            batchLimit: 16,
            reranker: {
              enabled: true,
              loaded: true,
              modelKey: "qwen3-reranker-0.6b",
              artifact: "repo:reranker.gguf",
              artifactRevision: `sha256:${artifactHash}`,
              artifactHash
            }
          })
        )
      )
    );

    await expect(
      resolveKoedEmbeddingServiceReproducibility({
        baseUrl: "http://127.0.0.1:3800",
        strict: true,
        requireReranker: true
      })
    ).resolves.toMatchObject({
      reranker: {
        model: "qwen3-reranker-0.6b",
        artifactRevision: `sha256:${artifactHash}`,
        artifactHash
      }
    });
  });
});

describe("Retrieval Arena model identity", () => {
  it("matches the canonical Codex runtime identity to its configured model", () => {
    const descriptor = {
      provider: "koed-runtime-memory-answer",
      model: "gpt-5.4-mini",
      artifact: "codex-cli",
      artifactRevision: "0.147.0",
      artifactHash: "a".repeat(64),
      dimensions: null,
      tokenizer: "openai-provider-tokenizer",
      tokenizerRevision: "gpt-5.4-mini",
      reasoningEffort: "low",
      inputPricePerMillionTokensUsd: 0.75,
      outputPricePerMillionTokensUsd: 4.5,
      acceleration: "openai-hosted"
    };
    expect(
      observedModelMatchesDescriptor(
        descriptor,
        "codex-app-server:gpt-5.4-mini:low"
      )
    ).toBe(true);
    expect(
      observedModelMatchesDescriptor(
        descriptor,
        "codex-app-server:gpt-5.4-mini:high"
      )
    ).toBe(false);
  });
});

describe("Retrieval Arena Qwen embedding contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses canonical production query and document transforms", async () => {
    const calls: string[][] = [];
    const arm = createDenseArm({
      id: "qwen-test",
      model: "qwen3-0.6b",
      dimensions: 1024,
      async embed(texts) {
        calls.push(texts);
        return texts.map((_, index) =>
          Array.from({ length: 1024 }, (_value, dimension) =>
            dimension === index % 1024 ? 1 : 0
          )
        );
      }
    });
    const benchmarkCase = retrievalArenaCases[0]!;
    await arm.run({
      benchmarkCase,
      runIndex: 0,
      deadlineAt: Date.now() + 1_000
    });
    expect(calls[0]?.[0]).toContain(`Query: ${benchmarkCase.question}`);
    expect(calls[0]?.[1]).toBe(benchmarkCase.corpus[0]?.text);
    expect(arm.configuration).toMatchObject({
      queryTransform: "qwen3-retrieval-query-v1",
      documentTransform: "qwen3-retrieval-document-v1"
    });
  });

  it("rejects a service-reported Qwen model or dimension mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "wrong-model",
            dimensions: 768,
            vectors: [[1, 0]]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const provider = createKoedEmbeddingServiceProvider({
      baseUrl: "http://embedding.test"
    });
    await expect(provider.embed(["query"])).rejects.toThrow(
      "embedding service reported model wrong-model; expected qwen3-0.6b"
    );
  });

  it("records service-measured embedding usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "qwen3-0.6b",
            dimensions: 1024,
            vectors: [Array.from({ length: 1024 }, () => 0)],
            measuredTokens: 17
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const provider = createKoedEmbeddingServiceProvider({
      baseUrl: "http://embedding.test"
    });
    const onUsage = vi.fn();
    await provider.embed(["query"], { onUsage });
    expect(onUsage).toHaveBeenCalledWith({ calls: 1, tokens: 17 });
  });

  it("batches embeddings to the service-advertised limit and preserves order", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      return new Response(
        JSON.stringify({
          model: "qwen3-0.6b",
          dimensions: 1024,
          vectors: body.texts.map((text) => [
            text.length,
            ...Array.from({ length: 1023 }, () => 0)
          ]),
          measuredTokens: body.texts.length
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createKoedEmbeddingServiceProvider({
      baseUrl: "http://embedding.test",
      batchLimit: 16
    });
    const onUsage = vi.fn();
    const texts = Array.from({ length: 17 }, (_, index) => `text-${index}`);

    const vectors = await provider.embed(texts, { onUsage });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(
        ([, init]) =>
          (JSON.parse(String(init?.body)) as { texts: string[] }).texts.length
      )
    ).toEqual([16, 1]);
    expect(vectors.map((vector) => vector[0])).toEqual(
      texts.map((text) => text.length)
    );
    expect(onUsage).toHaveBeenNthCalledWith(1, { calls: 1, tokens: 16 });
    expect(onUsage).toHaveBeenNthCalledWith(2, { calls: 1, tokens: 1 });
  });

  it("pins and validates the service-reported reranker identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ model: "wrong-reranker", scores: [0.5] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
    );
    const provider = createKoedEmbeddingServiceProvider({
      baseUrl: "http://embedding.test",
      reranker: {
        model: "pinned-reranker",
        artifact: "pinned.gguf",
        artifactRevision: "revision-1",
        artifactHash: "a".repeat(64)
      }
    });
    await expect(provider.rerank!("query", ["document"])).rejects.toThrow(
      "reranker service reported model wrong-reranker; expected pinned-reranker"
    );
  });

  it("retains service-measured local reranker call telemetry", async () => {
    const artifactHash = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "pinned-reranker",
            artifact: "pinned.gguf",
            artifactRevision: `sha256:${artifactHash}`,
            artifactHash,
            latencyMs: 14,
            inputTokens: 37,
            costUsd: 0,
            scores: [0.5]
          })
        )
      )
    );
    const provider = createKoedEmbeddingServiceProvider({
      baseUrl: "http://embedding.test",
      reranker: {
        model: "pinned-reranker",
        artifact: "pinned.gguf",
        artifactRevision: `sha256:${artifactHash}`,
        artifactHash
      }
    });

    await expect(provider.rerank!("query", ["document"])).resolves.toEqual({
      model: "pinned-reranker",
      artifact: "pinned.gguf",
      artifactRevision: `sha256:${artifactHash}`,
      artifactHash,
      latencyMs: 14,
      inputTokens: 37,
      costUsd: 0,
      scores: [0.5]
    });
  });
});

describe("Retrieval Arena arms and metrics", () => {
  const benchmarkCase = retrievalArenaCases.find(
    (item) => item.id === "dev-exact-anchor"
  )!;

  it("declares the complete production controller and ablation matrix", () => {
    const declared = productControllerConfigurations();
    expect(declared.map(({ id }) => id)).toEqual([
      "koed-production",
      "no-caller-hints",
      "no-scripted-first-pass",
      "no-lexical-anchors",
      "no-exact-anchor-checks",
      "no-lcm-expansion",
      "no-follow-up-search",
      "no-fusion",
      "one-api-retrieval-call",
      "rewrite-one-dense",
      "qwen-0.6b-single-shot"
    ]);
    expect(new Set(declared.map(({ id }) => id)).size).toBe(declared.length);
    expect(
      declared.find(({ id }) => id === "one-api-retrieval-call")?.configuration
    ).toMatchObject({
      scriptedFirstPass: false,
      followUpSearch: false,
      fusion: false,
      maxSearchCalls: 1
    });
    for (const id of ["rewrite-one-dense", "qwen-0.6b-single-shot"]) {
      expect(
        declared.find((entry) => entry.id === id)?.configuration
      ).toMatchObject({
        scriptedFirstPass: false,
        exactAnchorChecks: false,
        lcmExpansion: false,
        followUpSearch: false,
        fusion: false,
        maxSearchCalls: 1
      });
    }
    expect(
      createProductArms(async () => Promise.reject()).map((arm) => ({
        id: arm.id,
        configuration: arm.configuration
      }))
    ).toEqual(declared);

    const defaultArms = createRetrievalArenaArms();
    expect(
      defaultArms
        .filter((arm) => arm.layer === "retrieval_only")
        .map((arm) => arm.id)
    ).toEqual([
      "bm25",
      "qwen-0.6b-dense",
      "qwen-0.6b-reranked",
      "bm25-qwen-0.6b-hybrid",
      "one-rewrite-one-search"
    ]);
    expect(
      defaultArms.filter((arm) => arm.layer === "product").map((arm) => arm.id)
    ).toEqual(declared.map(({ id }) => id));
  });

  it("uses BM25 term frequency and inverse document frequency with deterministic ties", () => {
    const ranked = bm25Rank(benchmarkCase.question, benchmarkCase.corpus);
    expect(ranked[0]?.item.id).toBe("d1");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(createBm25Arm().configuration).toMatchObject({ k1: 1.2, b: 0.75 });
  });

  it("uses pinned reciprocal-rank fusion independent of source scores", () => {
    const [first, second] = benchmarkCase.corpus;
    const fused = reciprocalRankFusion([
      [
        { item: first!, score: 100 },
        { item: second!, score: 1 }
      ],
      [
        { item: second!, score: 999 },
        { item: first!, score: 0 }
      ]
    ]);
    expect(fused.map(({ item }) => item.id)).toEqual(["d1", "d2"]);
    expect(fused[0]?.score).toBe(fused[1]?.score);
  });

  it("retains reranker identity and call provenance separately from embeddings", async () => {
    const arm = createRerankedArm({
      id: "fixture-provider",
      model: "fixture-embedding",
      reranker: {
        model: "fixture-reranker",
        artifact: "fixture-reranker.gguf",
        artifactRevision: "revision-1",
        artifactHash: "a".repeat(64)
      },
      async embed(texts, options) {
        options?.onUsage?.({ calls: 1, tokens: 11 });
        return texts.map((_text, index) => [index + 1, 1]);
      },
      async rerank(_query, documents) {
        return {
          scores: documents.map((_document, index) => documents.length - index),
          model: "fixture-reranker",
          artifact: "fixture-reranker.gguf",
          artifactRevision: "revision-1",
          artifactHash: "a".repeat(64),
          latencyMs: 7,
          inputTokens: 23,
          costUsd: 0.004
        };
      }
    });
    const output = await arm.run({
      benchmarkCase,
      runIndex: 0,
      deadlineAt: Date.now() + 1_000
    });
    expect(output.rerankerMetrics).toMatchObject({
      model: "fixture-reranker",
      artifact: "fixture-reranker.gguf",
      artifactRevision: "revision-1",
      artifactHash: "a".repeat(64),
      latencyMs: 7,
      calls: 1,
      inputTokens: 23,
      costUsd: 0.004
    });
    expect(output.metrics).toMatchObject({
      embeddingCalls: 1,
      embeddingTokens: 11
    });
  });

  it("scores graded relevance, required groups, and forbidden evidence separately", () => {
    const boundary = retrievalArenaCases.find(
      (item) => item.id === "validation-boundary"
    )!;
    const evidence: RankedEvidence[] = [
      {
        itemId: "v7",
        rank: 1,
        score: 1,
        text: boundary.corpus[0]!.text,
        tokenCount: boundary.corpus[0]!.tokenCount,
        sourceType: "memory_event",
        sourceChunkIndex: 0
      },
      {
        itemId: "v8",
        rank: 2,
        score: 0.5,
        text: boundary.corpus[1]!.text,
        tokenCount: boundary.corpus[1]!.tokenCount,
        sourceType: "memory_event",
        sourceChunkIndex: 0
      }
    ];
    expect(scoreRetrieval(boundary, evidence)).toMatchObject({
      requiredEvidenceGroupRecall: 1,
      mrr: 1,
      forbiddenEvidenceRate: 0.5,
      irrelevantEvidenceRate: 0.5
    });
  });

  it("scores the pre-budget candidate pool separately from selected evidence", () => {
    const candidate = benchmarkCase.corpus[0]!;
    const ranked: RankedEvidence = {
      itemId: candidate.id,
      rank: 1,
      score: 1,
      text: candidate.text,
      tokenCount: candidate.tokenCount,
      sourceType: candidate.sourceType,
      sourceChunkIndex: candidate.sourceChunkIndex
    };
    expect(scoreRetrieval(benchmarkCase, [], [ranked])).toMatchObject({
      candidatePoolRecall: 1,
      selectedEvidenceRecall: 0
    });
    expect(scoreRetrieval(benchmarkCase, [], null)).toMatchObject({
      candidatePoolRecall: null,
      selectedEvidenceRecall: 0
    });
  });

  it("does not expose gold labels, evaluation tags, or reference answers to product providers", async () => {
    let keys: string[] = [];
    const [arm] = createProductArms(async (context) => {
      keys = Object.keys(context.benchmarkCase).sort();
      return {
        answer: "safe",
        status: "insufficient",
        candidates: [],
        evidence: [],
        readerMetrics: {
          model: "test-product-reader",
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: null,
          status: "completed"
        },
        productProof: {
          kind: "live_product",
          manifestHash: "a".repeat(64),
          seed: "provider-safe-fixture",
          datasetHash: retrievalArenaDatasetHash,
          corpusIdentity: retrievalArenaCorpusIdentity,
          runtimeIdentity: "fixture-runtime",
          caseStateHash: "b".repeat(64),
          caseCorpusHash: createHash("sha256")
            .update(JSON.stringify(context.benchmarkCase.corpus))
            .digest("hex"),
          configurationHash: "c".repeat(64),
          observedConfigurationHash: "c".repeat(64)
        },
        metrics: { searchCalls: 0, expansions: 0 }
      };
    });
    await arm!.run({
      benchmarkCase,
      runIndex: 0,
      deadlineAt: Date.now() + 1_000
    });
    expect(keys).toEqual([
      "budget",
      "corpus",
      "id",
      "productContext",
      "question",
      "retrievalHints",
      "split"
    ]);
    expect(keys).not.toEqual(
      expect.arrayContaining([
        "qrels",
        "referenceAnswer",
        "answerChecks",
        "tags"
      ])
    );
  });
});

describe("Retrieval Arena runner", () => {
  it("runs retrieval arms against the canonical shared corpus", async () => {
    let observedCorpusIds: string[] = [];
    const report = await runRetrievalArena({
      arms: [
        {
          id: "shared-corpus-observer",
          label: "shared corpus observer",
          layer: "retrieval_only",
          configuration: {},
          run: async ({ benchmarkCase }) => {
            observedCorpusIds = benchmarkCase.corpus.map((entry) => entry.id);
            return {
              candidates: [],
              evidence: [],
              metrics: { searchCalls: 1 }
            };
          }
        }
      ],
      caseIds: ["dev-exact-anchor"]
    });

    expect(observedCorpusIds).toEqual(
      retrievalArenaCorpus.map((entry) => entry.id)
    );
    expect(report.results[0]?.status).toBe("completed");
  });

  it("does not count product worker latency twice", () => {
    const observation = {
      resources: { wallTimeMs: 100 },
      answerResources: {
        reader: { latencyMs: 60 },
        judge: { latencyMs: 20 }
      }
    } as Parameters<typeof qualityLatencyMs>[1];

    expect(qualityLatencyMs("product", observation)).toBe(120);
    expect(qualityLatencyMs("fixed_reader", observation)).toBe(180);
  });

  const benchmarkCase = retrievalArenaCases.find(
    (item) => item.id === "dev-exact-anchor"
  )!;
  const unavailable: ArenaArm = {
    id: "missing",
    label: "missing",
    layer: "retrieval_only",
    providerRequirement: "local-model",
    configuration: {},
    run: () => Promise.reject(new ProviderUnavailableError("local-model"))
  };

  it("skips unavailable providers normally and fails them in strict mode", async () => {
    const skipped = await runRetrievalArena({
      arms: [unavailable],
      caseIds: ["dev-exact-anchor"]
    });
    expect(skipped.results[0]).toMatchObject({
      status: "skipped",
      armId: "missing"
    });
    const strict = await runRetrievalArena({
      arms: [unavailable],
      caseIds: ["dev-exact-anchor"],
      strictProviders: true
    });
    expect(strict.results[0]).toMatchObject({
      status: "failed",
      armId: "missing"
    });
  });

  it("computes dispersion from paired case means across repeated runs", async () => {
    const arm: ArenaArm = {
      id: "stable-across-runs",
      label: "stable across runs",
      layer: "retrieval_only",
      configuration: {},
      run: async ({ benchmarkCase }) => {
        const relevant = benchmarkCase.qrels.find(
          (qrel) => qrel.grade > 0 && !qrel.forbidden
        )!;
        const item = benchmarkCase.corpus.find(
          (candidate) => candidate.id === relevant.itemId
        )!;
        return {
          candidates: benchmarkCase.id === "dev-exact-anchor" ? [] : null,
          evidence:
            benchmarkCase.id === "dev-exact-anchor"
              ? []
              : [
                  {
                    itemId: item.id,
                    rank: 1,
                    score: 1,
                    text: item.text,
                    tokenCount: item.tokenCount,
                    sourceType: item.sourceType,
                    sourceChunkIndex: item.sourceChunkIndex
                  }
                ],
          metrics: { searchCalls: 1 }
        };
      }
    };
    const report = await runRetrievalArena({
      arms: [arm],
      caseIds: ["dev-exact-anchor", "dev-semantic-paraphrase"],
      runs: 3
    });
    expect(report.leaderboards.retrieval_only[0]).toMatchObject({
      completedRuns: 6,
      repeatedRunCaseCount: 2,
      repeatedRunSampleCount: 3,
      varianceSampleUnit: "paired_case_mean_per_run",
      standardDeviationNdcg: 0
    });
    expect(
      report.metadata.retrievalConfiguration.sampleSemantics
    ).toMatchObject({
      requestedRunsPerCase: 3,
      productMinimumRepeatedRuns: 3
    });
  });

  it("requires at least three repeated runs for product arms", async () => {
    const productArm: ArenaArm = {
      id: "minimum-run-product",
      label: "minimum run product",
      layer: "product",
      configuration: {},
      run: async () => {
        throw new Error("not reached");
      }
    };
    await expect(
      runRetrievalArena({
        arms: [productArm],
        caseIds: ["dev-exact-anchor"],
        layers: ["product"],
        runs: 2
      })
    ).rejects.toThrow("require at least 3 repeated runs");
  });

  it("reports paired production-versus-ablation quality, correctness, cost, and latency confidence intervals", async () => {
    const peakMemory = {
      schemaVersion: "koed-retrieval-arena-peak-memory-v2" as const,
      aggregation: "stable_concurrent_plus_max_dynamic_child" as const,
      aggregatePeakRssBytes: 100,
      stableAggregatePeakRssBytes: 75,
      dynamicAiClientPeakRssBytes: 25,
      components: [
        ["api", "memory-api", 1],
        ["database", "postgres", 2],
        ["embedding_service", "embedding", 3],
        ["ai_client_model", "product-reader", 4]
      ].map(([role, component, pid]) => ({
        role: role as
          | "api"
          | "database"
          | "embedding_service"
          | "ai_client_model",
        component: String(component),
        pid: Number(pid),
        peakRssBytes: 25,
        provenance: `fixture-status:${component}`,
        measurement: "proc_status_tree" as const,
        ...(role === "ai_client_model"
          ? { attemptIndex: 1, sampleCount: 2, samplingIntervalMs: 10 }
          : {})
      }))
    };
    const arm = (id: string, correct: boolean, tokens: number): ArenaArm => {
      const configuration = { variant: id };
      const configurationHash = createHash("sha256")
        .update(JSON.stringify(configuration))
        .digest("hex");
      return {
        id,
        label: id,
        layer: "product",
        configuration,
        run: async () => ({
          answer: correct
            ? "The guard is REQUEST_BODY_LIMIT_BYTES."
            : "The guard is unknown.",
          status: "found",
          candidates: [],
          evidence: [],
          readerMetrics: {
            model: "product-reader",
            latencyMs: correct ? 10 : 20,
            inputTokens: tokens,
            outputTokens: 1,
            costUsd: null,
            status: "completed"
          },
          metrics: {
            searchCalls: 1,
            expansions: 0,
            inputTokens: tokens,
            outputTokens: 1,
            peakMemory
          },
          productProof: {
            kind: "live_product",
            manifestHash: "a".repeat(64),
            seed: "paired-fixture",
            datasetHash: retrievalArenaDatasetHash,
            corpusIdentity: retrievalArenaCorpusIdentity,
            runtimeIdentity: "paired-runtime",
            caseStateHash: "b".repeat(64),
            caseCorpusHash: createHash("sha256")
              .update(JSON.stringify(benchmarkCase.corpus))
              .digest("hex"),
            configurationHash,
            observedConfigurationHash: configurationHash
          }
        })
      };
    };
    const report = await runRetrievalArena({
      arms: [arm("koed-production", true, 10), arm("no-fusion", false, 20)],
      caseIds: [benchmarkCase.id],
      layers: ["product"],
      runs: 3,
      judgeConfig: {
        appServerBinary: "unused",
        model: "judge",
        reasoningEffort: "low",
        timeoutMs: 1_000,
        cwd: process.cwd(),
        env: process.env
      },
      modelPricing: {
        product: { input: 1, output: 1 },
        judge: { input: 1, output: 1 }
      },
      promptRunner: async () => ({
        model: "judge",
        tokenUsage: { total: { inputTokens: 1, outputTokens: 1 } },
        text: JSON.stringify({
          schema_version: "retrieval-arena-semantic-judge-v1",
          verdict: "pass",
          score: 1,
          dimensions: {
            correctness: 1,
            grounding: 1,
            completeness: 1,
            conflict_handling: 1,
            temporal_reasoning: 1,
            abstention: 1,
            hallucination_avoidance: 1
          },
          rationale: "fixture"
        })
      })
    });
    expect(
      report.leaderboards.product.find((entry) => entry.armId === "no-fusion")
    ).toMatchObject({
      failedRuns: 3,
      meanSemanticScore: 0,
      meanCorrectness: 0
    });
    expect(
      report.leaderboards.product.map(({ armId }) => armId).sort()
    ).toEqual(["koed-production", "no-fusion"].sort());
    expect(report.leaderboards.retrieval_only).toEqual([]);
    expect(report.leaderboards.fixed_reader).toEqual([]);
    expect(report.productComparisons).toHaveLength(1);
    expect(report.productComparisons[0]).toMatchObject({
      productionArmId: "koed-production",
      ablationArmId: "no-fusion",
      quality: {
        pairedObservations: 3,
        meanDifference: 1,
        confidence95: [1, 1]
      },
      correctness: {
        pairedObservations: 3,
        meanDifference: 1,
        confidence95: [1, 1]
      }
    });
    expect(report.productComparisons[0]?.costUsd.pairedObservations).toBe(3);
    expect(report.productComparisons[0]?.latencyMs.pairedObservations).toBe(3);
    expect(report.metadata.productState).toMatchObject({
      seed: "paired-fixture",
      corpusIdentity: retrievalArenaCorpusIdentity
    });
  });

  it("requires only applicable strict resources and model metadata", async () => {
    const previousAcceleration = process.env.KOED_EVAL_ACCELERATION;
    process.env.KOED_EVAL_ACCELERATION = "cpu-test";
    const embeddingArm: ArenaArm = {
      id: "strict-embedding",
      label: "strict embedding",
      layer: "retrieval_only",
      modelRoles: ["embedding"],
      configuration: {},
      run: async () => ({
        candidates: [],
        evidence: [],
        metrics: {
          searchCalls: 1,
          candidateCount: 0,
          embeddingCalls: 1,
          embeddingTokens: 17
        }
      })
    };
    try {
      const report = await runRetrievalArena({
        arms: [embeddingArm],
        caseIds: ["dev-exact-anchor"],
        strictProviders: true,
        modelMetadata: {
          embedding: {
            provider: "fixture",
            model: "fixture-embedding",
            artifact: "fixture.gguf",
            artifactRevision: "fixture-revision",
            artifactHash: "a".repeat(64),
            dimensions: 1024,
            tokenizer: "fixture-tokenizer",
            tokenizerRevision: "fixture-tokenizer-revision",
            reasoningEffort: "none",
            inputPricePerMillionTokensUsd: null,
            outputPricePerMillionTokensUsd: null,
            acceleration: "cpu-test"
          },
          reader: {
            provider: "unused",
            model: "unused",
            artifact: null,
            artifactRevision: null,
            artifactHash: null,
            dimensions: null,
            tokenizer: null,
            tokenizerRevision: null,
            reasoningEffort: null,
            inputPricePerMillionTokensUsd: null,
            outputPricePerMillionTokensUsd: null,
            acceleration: null
          }
        }
      });
      expect(report.results[0]).toMatchObject({ status: "completed" });
      expect(report.metadata.models.embedding).toMatchObject({
        model: "fixture-embedding"
      });
      expect(report.results[0]?.resources).toMatchObject({
        embeddingCalls: 1,
        embeddingTokens: 17,
        databaseReads: null,
        costUsd: null
      });
    } finally {
      if (previousAcceleration === undefined) {
        delete process.env.KOED_EVAL_ACCELERATION;
      } else {
        process.env.KOED_EVAL_ACCELERATION = previousAcceleration;
      }
    }
  });

  it("requires strict reranker artifact proof and measured call telemetry", async () => {
    const previousAcceleration = process.env.KOED_EVAL_ACCELERATION;
    process.env.KOED_EVAL_ACCELERATION = "cpu-test";
    const artifactHash = "b".repeat(64);
    const arm = (costUsd: number | null): ArenaArm => ({
      id: "strict-reranker",
      label: "strict reranker",
      layer: "retrieval_only",
      modelRoles: ["embedding", "reranker"],
      configuration: {},
      run: async () => ({
        candidates: [],
        evidence: [],
        metrics: {
          searchCalls: 1,
          candidateCount: 0,
          embeddingCalls: 1,
          embeddingTokens: 17
        },
        rerankerMetrics: {
          model: "fixture-reranker",
          artifact: "fixture-reranker.gguf",
          artifactRevision: `sha256:${artifactHash}`,
          artifactHash,
          latencyMs: 7,
          calls: 1,
          inputTokens: 23,
          costUsd
        }
      })
    });
    const modelMetadata = {
      embedding: {
        provider: "fixture",
        model: "fixture-embedding",
        artifact: "fixture-embedding.gguf",
        artifactRevision: "fixture-revision",
        artifactHash: "a".repeat(64),
        dimensions: 1024,
        tokenizer: "fixture-tokenizer",
        tokenizerRevision: "fixture-tokenizer-revision",
        reasoningEffort: "none",
        inputPricePerMillionTokensUsd: null,
        outputPricePerMillionTokensUsd: null,
        acceleration: "cpu-test"
      },
      reranker: {
        provider: "fixture",
        model: "fixture-reranker",
        artifact: "fixture-reranker.gguf",
        artifactRevision: `sha256:${artifactHash}`,
        artifactHash,
        dimensions: null,
        tokenizer: null,
        tokenizerRevision: null,
        reasoningEffort: "none",
        inputPricePerMillionTokensUsd: null,
        outputPricePerMillionTokensUsd: null,
        acceleration: "cpu-test"
      }
    };
    try {
      const complete = await runRetrievalArena({
        arms: [arm(0)],
        caseIds: ["dev-exact-anchor"],
        strictProviders: true,
        modelMetadata
      });
      expect(complete.results[0]).toMatchObject({
        status: "completed",
        rerankerResources: {
          artifactHash,
          latencyMs: 7,
          inputTokens: 23,
          costUsd: 0
        }
      });

      const missingCost = await runRetrievalArena({
        arms: [arm(null)],
        caseIds: ["dev-exact-anchor"],
        strictProviders: true,
        modelMetadata
      });
      expect(missingCost.results[0]?.status).toBe("failed");
      expect(missingCost.results[0]?.error).toContain("rerankerCostUsd");
    } finally {
      if (previousAcceleration === undefined) {
        delete process.env.KOED_EVAL_ACCELERATION;
      } else {
        process.env.KOED_EVAL_ACCELERATION = previousAcceleration;
      }
    }
  });

  it("fails strict product arms closed when participating-process telemetry is unavailable", async () => {
    const previous = process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY;
    delete process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY;
    const productArm: ArenaArm = {
      id: "product-without-process-telemetry",
      label: "product without process telemetry",
      layer: "product",
      configuration: {},
      run: async () => ({
        answer: "No matching memory.",
        status: "not_found",
        evidence: [],
        candidates: [],
        readerMetrics: {
          model: "fixture-reader",
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
          status: "completed"
        },
        metrics: {
          databaseReads: 1,
          hydrationCount: 0,
          hydrationBytes: 0,
          decryptCount: 0,
          decryptBytes: 0,
          embeddingCalls: 1,
          embeddingTokens: 3,
          internalVectorStages: 1,
          apiRetrievalCalls: 1,
          searchCalls: 1,
          expansions: 0,
          candidateCount: 0,
          evidenceTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01
        }
      })
    };
    try {
      const report = await runRetrievalArena({
        arms: [productArm],
        caseIds: ["dev-exact-anchor"],
        layers: ["product"],
        runs: 3,
        strictProviders: true,
        judgeConfig: {
          appServerBinary: "unused",
          model: "fixture-judge",
          reasoningEffort: "low",
          timeoutMs: 1_000,
          cwd: process.cwd(),
          env: process.env
        },
        promptRunner: async () => ({
          model: "fixture-judge",
          text: JSON.stringify({
            schema_version: "retrieval-arena-semantic-judge-v1",
            verdict: "pass",
            score: 1,
            dimensions: {
              correctness: 1,
              grounding: 1,
              completeness: 1,
              conflict_handling: 1,
              temporal_reasoning: 1,
              abstention: 1,
              hallucination_avoidance: 1
            },
            rationale: "fixture"
          })
        })
      });
      expect(report.results[0]).toMatchObject({
        status: "failed",
        armId: productArm.id
      });
      expect(report.results[0]?.error).toMatch(
        /strict required arm cannot measure.*peakRssBytes.*peakMemory/
      );
    } finally {
      if (previous === undefined)
        delete process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY;
      else process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY = previous;
    }
  });

  it("skips optional product arms rather than completing with eval-runner RSS", async () => {
    const previous = process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY;
    delete process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY;
    const productArm: ArenaArm = {
      id: "optional-product-without-process-telemetry",
      label: "optional product without process telemetry",
      layer: "product",
      configuration: {},
      run: async () => ({
        answer: "No matching memory.",
        status: "not_found",
        evidence: [],
        candidates: [],
        readerMetrics: {
          model: "fixture-reader",
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
          status: "completed"
        },
        metrics: { searchCalls: 1, expansions: 0 }
      })
    };
    try {
      const report = await runRetrievalArena({
        arms: [productArm],
        caseIds: ["dev-exact-anchor"],
        layers: ["product"],
        runs: 3,
        judgeConfig: {
          appServerBinary: "unused",
          model: "fixture-judge",
          reasoningEffort: "low",
          timeoutMs: 1_000,
          cwd: process.cwd(),
          env: process.env
        },
        promptRunner: async () => ({
          model: "fixture-judge",
          text: "not reached"
        })
      });
      expect(report.results[0]).toMatchObject({
        status: "skipped",
        armId: productArm.id
      });
      expect(report.results[0]?.skipReason).toMatch(/process telemetry/);
      expect(report.results[0]?.resources).toBeUndefined();
    } finally {
      if (previous === undefined)
        delete process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY;
      else process.env.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY = previous;
    }
  });

  it("keeps retrieval-only and fixed-reader results separate and mandates semantic judging", async () => {
    const promptRunner: ArenaPromptRunner = async (
      _prompt,
      config,
      _timeout,
      role
    ) => ({
      model: config.model,
      tokenUsage: {
        total: { inputTokens: 100, outputTokens: 25 },
        last: { inputTokens: 10, outputTokens: 5 }
      },
      text:
        role === "reader"
          ? JSON.stringify({
              schema_version: "retrieval-arena-reader-v1",
              status: "found",
              answer: "The guard is REQUEST_BODY_LIMIT_BYTES."
            })
          : JSON.stringify({
              schema_version: "retrieval-arena-semantic-judge-v1",
              verdict: "pass",
              score: 1,
              dimensions: {
                correctness: 1,
                grounding: 1,
                completeness: 1,
                conflict_handling: 1,
                temporal_reasoning: 1,
                abstention: 1,
                hallucination_avoidance: 1
              },
              rationale: "Fully supported."
            })
    });
    const config = {
      appServerBinary: "unused",
      model: "fixed-local-reader",
      reasoningEffort: "low",
      timeoutMs: 1_000,
      cwd: process.cwd(),
      env: process.env
    };
    const report = await runRetrievalArena({
      arms: [createBm25Arm()],
      caseIds: ["dev-exact-anchor"],
      layers: ["retrieval_only", "fixed_reader"],
      readerConfig: config,
      judgeConfig: config,
      promptRunner,
      costPerMillionInputTokensUsd: 1,
      costPerMillionOutputTokensUsd: 2
    });
    expect(report.results.map((result) => result.layer)).toEqual([
      "retrieval_only",
      "fixed_reader"
    ]);
    expect(report.results[1]).toMatchObject({
      status: "completed",
      deterministicChecks: {
        status: true,
        exactFacts: true,
        forbiddenFacts: true
      },
      semanticJudgment: { status: "judged", passed: true, score: 1 }
    });
    expect(report.results[1]?.answerResources?.reader?.model).toBe(
      "fixed-local-reader"
    );
    expect(report.results[1]?.answerResources?.reader?.latencyMs).toBeTypeOf(
      "number"
    );
    expect(report.results[1]?.answerResources?.reader).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.00015,
      status: "completed"
    });
    expect(report.results[1]?.answerResources?.judge?.model).toBe(
      "fixed-local-reader"
    );
    expect(report.results[1]?.answerResources?.judge?.latencyMs).toBeTypeOf(
      "number"
    );
    expect(report.results[1]?.answerResources?.judge).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.00015,
      status: "completed"
    });
    expect(report.leaderboards.retrieval_only).toHaveLength(1);
    expect(report.leaderboards.fixed_reader).toHaveLength(1);
    expect(report.leaderboards.product).toHaveLength(0);
  });

  it("fails answer-quality runs on judge errors or mandatory deterministic checks", async () => {
    const config = {
      appServerBinary: "unused",
      model: "local",
      reasoningEffort: "low",
      timeoutMs: 1_000,
      cwd: process.cwd(),
      env: process.env
    };
    const report = await runRetrievalArena({
      arms: [createBm25Arm()],
      caseIds: ["dev-exact-anchor"],
      layers: ["fixed_reader"],
      readerConfig: config,
      judgeConfig: config,
      promptRunner: async (_prompt, _config, _timeout, role) => ({
        model: "local",
        text:
          role === "reader"
            ? JSON.stringify({
                schema_version: "retrieval-arena-reader-v1",
                status: "found",
                answer: "A wrong answer without the mandatory exact fact."
              })
            : "not-json"
      })
    });
    expect(report.results[0]).toMatchObject({
      status: "failed",
      semanticJudgment: { status: "error", passed: false },
      answerResources: {
        reader: { status: "completed" },
        judge: { status: "failed", inputTokens: null, outputTokens: null }
      },
      qualityObservation: { quality: 0, correctness: 0 }
    });
    expect(report.leaderboards.fixed_reader[0]).toMatchObject({
      meanSemanticScore: 0,
      meanCorrectness: 0
    });
  });

  it("enforces candidate, item, token, search, and expansion budgets on custom outputs", async () => {
    const item = benchmarkCase.corpus[0]!;
    const oversized: ArenaArm = {
      id: "oversized",
      label: "oversized",
      layer: "retrieval_only",
      configuration: {},
      run: async () => ({
        evidence: Array.from({ length: 20 }, (_, index) => ({
          itemId: `${item.id}-${index}`,
          rank: index + 1,
          score: 1,
          text: item.text,
          tokenCount: item.tokenCount,
          sourceType: item.sourceType,
          sourceChunkIndex: index
        })),
        metrics: { searchCalls: benchmarkCase.budget.maxSearchCalls + 1 }
      })
    };
    const report = await runRetrievalArena({
      arms: [oversized],
      caseIds: [benchmarkCase.id]
    });
    expect(report.results[0]).toMatchObject({
      status: "failed",
      error: "arm exceeded search-call budget"
    });
  });

  it("records unknown acceleration as null and requires explicit model metadata", async () => {
    const previous = process.env.KOED_EVAL_ACCELERATION;
    delete process.env.KOED_EVAL_ACCELERATION;
    try {
      const report = await runRetrievalArena({
        arms: [createBm25Arm()],
        caseIds: [benchmarkCase.id]
      });
      expect(report.metadata.acceleration).toBeNull();
      expect(report.metadata.models).toEqual({});
      expect(
        createArenaModelDescriptor({
          provider: "codex-app-server",
          config: { model: "configured-label", reasoningEffort: "low" },
          prefix: "KOED_EVAL_READER",
          env: {}
        })
      ).toMatchObject({
        model: "configured-label",
        artifact: null,
        artifactRevision: null,
        artifactHash: null,
        tokenizer: null,
        acceleration: null
      });
      expect(
        createArenaModelDescriptor({
          provider: "codex-app-server",
          config: { model: "configured-label", reasoningEffort: "low" },
          prefix: "KOED_EVAL_READER",
          env: {
            KOED_EVAL_ACCELERATION: "host-default",
            KOED_EVAL_READER_ACCELERATION: "hosted-reader"
          }
        }).acceleration
      ).toBe("hosted-reader");
      expect(report.metadata.cpu).not.toBe("cpu");
      expect(report.metadata.datasetProvenance).toEqual({
        kind: "hand_authored",
        generator: null
      });
      expect(Object.keys(report.metadata.prompts).sort()).toEqual([
        "fixedReaderSha256",
        "memoryAnswerAppServerBaseSha256",
        "memoryAnswerAppServerDeveloperSha256",
        "memoryAnswerWorkerSha256",
        "queryRewriteSha256",
        "semanticJudgeSha256"
      ]);
      for (const hash of Object.values(report.metadata.prompts)) {
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      }
      const templates = retrievalArenaPromptTemplateContents();
      expect(templates.fixedReader).toContain("retrieval-arena-reader-v1");
      expect(templates.fixedReader).toContain("FIXED_READER_INPUT_JSON");
      expect(templates.fixedReader).toContain("retrieval-arena-prompt-json-v1");
      expect(report.metadata.prompts.fixedReaderSha256).toBe(
        createHash("sha256").update(templates.fixedReader).digest("hex")
      );
      expect(report.metadata.prompts.semanticJudgeSha256).toBe(
        createHash("sha256").update(templates.semanticJudge).digest("hex")
      );
      expect(report.metadata.prompts.queryRewriteSha256).toBe(
        createHash("sha256").update(templates.queryRewrite).digest("hex")
      );
      expect(report.metadata.prompts.fixedReaderSha256).not.toBe(
        createHash("sha256")
          .update("Answer the question using only the supplied evidence.")
          .digest("hex")
      );
      expect(report.metadata.prompts.fixedReaderSha256).not.toBe(
        createHash("sha256")
          .update(
            templates.fixedReader.replace(
              "FIXED_READER_INPUT_JSON",
              "CHANGED_INPUT_FRAME"
            )
          )
          .digest("hex")
      );
      expect(
        (
          report.metadata.retrievalConfiguration.sharedBudgetsByCase as Record<
            string,
            unknown
          >
        )[benchmarkCase.id]
      ).toEqual(benchmarkCase.budget);
    } finally {
      if (previous !== undefined) process.env.KOED_EVAL_ACCELERATION = previous;
    }
  });

  it("hashes the effective Memory Answer worker, base, and developer prompt overrides", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "koed-arena-prompts-")
    );
    const aiClientDirectory = path.join(directory, "ai-client");
    mkdirSync(aiClientDirectory, { recursive: true });
    const baseBody = "Effective test base instructions.";
    const developerBody = "Effective test developer instructions.";
    const workerBody = [
      "Effective worker override.",
      "{{search_domain}} {{required_json_schema}} {{question}}",
      "{{retrieval_scope}} {{default_search_domain}} {{optional_defaults}}",
      "{{limit}} {{max_searches}} {{max_expansions}}",
      "{{initial_evidence_section}}"
    ].join("\n");
    const bundledWorkerHash = createHash("sha256")
      .update(loadPrompt("memory-answer-worker").body)
      .digest("hex");
    writeFileSync(
      path.join(aiClientDirectory, "memory-answer-base.md"),
      `---\nid: ai-client-memory-answer-base\nversion: test-base-v1\n---\n${baseBody}\n`
    );
    writeFileSync(
      path.join(aiClientDirectory, "memory-answer-developer.md"),
      `---\nid: ai-client-memory-answer-developer\nversion: test-developer-v1\n---\n${developerBody}\n`
    );
    writeFileSync(
      path.join(directory, "memory-answer-worker.md"),
      `---\nid: memory-answer-worker\nversion: test-worker-v1\n---\n${workerBody}\n`
    );
    const previous = process.env.KOED_PROMPT_DIR;
    process.env.KOED_PROMPT_DIR = directory;
    try {
      const report = await runRetrievalArena({
        arms: [createBm25Arm()],
        caseIds: [benchmarkCase.id]
      });
      expect(report.metadata.prompts).toMatchObject({
        memoryAnswerAppServerBaseSha256: createHash("sha256")
          .update(baseBody)
          .digest("hex"),
        memoryAnswerAppServerDeveloperSha256: createHash("sha256")
          .update(developerBody)
          .digest("hex"),
        memoryAnswerWorkerSha256: createHash("sha256")
          .update(workerBody)
          .digest("hex")
      });
      expect(report.metadata.prompts.memoryAnswerWorkerSha256).not.toBe(
        bundledWorkerHash
      );
    } finally {
      if (previous === undefined) delete process.env.KOED_PROMPT_DIR;
      else process.env.KOED_PROMPT_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses one case deadline and fails before an out-of-budget judge call", async () => {
    const originalTimeout = benchmarkCase.budget.timeoutMs;
    benchmarkCase.budget.timeoutMs = 40;
    const roles: string[] = [];
    try {
      const report = await runRetrievalArena({
        arms: [createBm25Arm()],
        caseIds: [benchmarkCase.id],
        layers: ["fixed_reader"],
        readerConfig: {
          appServerBinary: "unused",
          model: "reader",
          reasoningEffort: "low",
          timeoutMs: 10_000,
          cwd: process.cwd(),
          env: process.env
        },
        judgeConfig: {
          appServerBinary: "unused",
          model: "judge",
          reasoningEffort: "low",
          timeoutMs: 10_000,
          cwd: process.cwd(),
          env: process.env
        },
        promptRunner: async (_prompt, config, _timeout, role) => {
          roles.push(role);
          if (role === "reader") {
            await new Promise((resolve) =>
              setTimeout(resolve, config.timeoutMs + 5)
            );
            return {
              model: "reader",
              text: JSON.stringify({
                schema_version: "retrieval-arena-reader-v1",
                status: "found",
                answer: "REQUEST_BODY_LIMIT_BYTES"
              })
            };
          }
          throw new Error("judge must not run after the deadline");
        }
      });
      expect(roles).toEqual(["reader"]);
      expect(report.results[0]).toMatchObject({
        status: "failed",
        semanticJudgment: {
          status: "error",
          passed: false,
          error: "Retrieval Arena case deadline exhausted"
        },
        answerResources: {
          reader: { status: "completed" },
          judge: { status: "failed" }
        }
      });
    } finally {
      benchmarkCase.budget.timeoutMs = originalTimeout;
    }
  });

  it("aborts an in-flight embedding request at the shared case deadline", async () => {
    const originalTimeout = benchmarkCase.budget.timeoutMs;
    benchmarkCase.budget.timeoutMs = 20;
    let observedSignal: AbortSignal | undefined;
    try {
      const report = await runRetrievalArena({
        arms: [
          createDenseArm({
            id: "blocking-embedding",
            model: "blocking-embedding",
            embed: async (_texts, requestOptions) => {
              observedSignal = requestOptions?.signal;
              return await new Promise<number[][]>((_resolve, reject) => {
                requestOptions?.signal?.addEventListener(
                  "abort",
                  () => reject(requestOptions.signal?.reason),
                  { once: true }
                );
              });
            }
          })
        ],
        caseIds: [benchmarkCase.id]
      });
      expect(report.results[0]).toMatchObject({ status: "failed" });
      expect(report.results[0]?.error).toMatch(
        /^arm exceeded timeout budget of \d+ms$/
      );
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      benchmarkCase.budget.timeoutMs = originalTimeout;
    }
  });

  it("retains retrieval and failed-reader resource accounting", async () => {
    const config = {
      appServerBinary: "unused",
      model: "failed-reader",
      reasoningEffort: "low",
      timeoutMs: 1_000,
      cwd: process.cwd(),
      env: process.env
    };
    const report = await runRetrievalArena({
      arms: [createBm25Arm()],
      caseIds: [benchmarkCase.id],
      layers: ["fixed_reader"],
      readerConfig: config,
      judgeConfig: config,
      promptRunner: async () => {
        throw new Error("reader provider failed");
      }
    });
    expect(report.results[0]).toMatchObject({
      status: "failed",
      resources: {
        searchCalls: 1,
        candidateCount: retrievalArenaCorpus.length
      },
      answerResources: {
        reader: {
          model: "failed-reader",
          status: "failed",
          error: "reader provider failed",
          inputTokens: null,
          outputTokens: null,
          costUsd: null
        }
      }
    });
  });

  it("accounts product reader and judge calls separately without double counting", async () => {
    const item = benchmarkCase.corpus[0]!;
    const productArm: ArenaArm = {
      id: "product-accounting",
      label: "product accounting",
      layer: "product",
      configuration: {},
      run: async () => ({
        answer: "The guard is REQUEST_BODY_LIMIT_BYTES.",
        status: "found",
        candidates: null,
        evidence: [
          {
            itemId: item.id,
            rank: 1,
            score: null,
            text: item.text,
            tokenCount: item.tokenCount,
            sourceType: item.sourceType,
            sourceChunkIndex: item.sourceChunkIndex
          }
        ],
        readerMetrics: {
          model: "product-reader",
          latencyMs: 12,
          inputTokens: 200,
          outputTokens: 40,
          costUsd: null,
          status: "completed"
        },
        metrics: {
          searchCalls: 1,
          expansions: 0,
          candidateCount: null,
          peakMemory: {
            schemaVersion: "koed-retrieval-arena-peak-memory-v2",
            aggregation: "stable_concurrent_plus_max_dynamic_child",
            aggregatePeakRssBytes: 100,
            stableAggregatePeakRssBytes: 75,
            dynamicAiClientPeakRssBytes: 25,
            components: [
              ["api", "memory-api", 1],
              ["database", "postgres", 2],
              ["embedding_service", "embedding", 3],
              ["ai_client_model", "product-reader", 4]
            ].map(([role, component, pid]) => ({
              role: role as
                | "api"
                | "database"
                | "embedding_service"
                | "ai_client_model",
              component: String(component),
              pid: Number(pid),
              peakRssBytes: 25,
              provenance: `fixture-status:${component}`,
              measurement: "proc_status_tree" as const,
              ...(role === "ai_client_model"
                ? { attemptIndex: 1, sampleCount: 2, samplingIntervalMs: 10 }
                : {})
            }))
          }
        },
        productProof: {
          kind: "live_product",
          manifestHash: "a".repeat(64),
          seed: "fixture-seed",
          datasetHash: retrievalArenaDatasetHash,
          corpusIdentity: retrievalArenaCorpusIdentity,
          runtimeIdentity: "fixture-runtime",
          caseStateHash: "b".repeat(64),
          caseCorpusHash: createHash("sha256")
            .update(JSON.stringify(benchmarkCase.corpus))
            .digest("hex"),
          configurationHash: createHash("sha256")
            .update(JSON.stringify({}))
            .digest("hex"),
          observedConfigurationHash: createHash("sha256")
            .update(JSON.stringify({}))
            .digest("hex")
        }
      })
    };
    const report = await runRetrievalArena({
      arms: [productArm],
      caseIds: [benchmarkCase.id],
      layers: ["product"],
      runs: 3,
      judgeConfig: {
        appServerBinary: "unused",
        model: "judge",
        reasoningEffort: "low",
        timeoutMs: 1_000,
        cwd: process.cwd(),
        env: process.env
      },
      costPerMillionInputTokensUsd: 1,
      costPerMillionOutputTokensUsd: 2,
      modelPricing: {
        product: { input: 5, output: 7 },
        judge: { input: 2, output: 3 }
      },
      promptRunner: async () => ({
        model: "judge",
        tokenUsage: {
          total: { inputTokens: 80, outputTokens: 20 },
          last: { inputTokens: 8, outputTokens: 2 }
        },
        text: JSON.stringify({
          schema_version: "retrieval-arena-semantic-judge-v1",
          verdict: "pass",
          score: 1,
          dimensions: {
            correctness: 1,
            grounding: 1,
            completeness: 1,
            conflict_handling: 1,
            temporal_reasoning: 1,
            abstention: 1,
            hallucination_avoidance: 1
          },
          rationale: "Grounded."
        })
      })
    });
    expect(report.results[0]).toMatchObject({
      status: "completed",
      retrievalMetrics: { candidatePoolRecall: null },
      resources: {
        candidateCount: null,
        databaseReads: null,
        hydrationCount: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null
      },
      answerResources: {
        reader: {
          model: "product-reader",
          inputTokens: 200,
          outputTokens: 40,
          costUsd: 0.00128,
          status: "completed"
        },
        judge: {
          model: "judge",
          inputTokens: 80,
          outputTokens: 20,
          costUsd: 0.00022,
          status: "completed"
        }
      },
      aggregateCost: {
        totalUsd: 0.0015,
        complete: true
      },
      qualityObservation: { quality: 1, correctness: 1 }
    });
  });
});
