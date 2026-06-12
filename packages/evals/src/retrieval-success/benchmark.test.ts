import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { EmbeddableSourceRecord, MemorySourceRepository } from "@koed/db";
import { retrievalSuccessCases, type RetrievalSuccessCase } from "./cases.js";
import {
  idealRetrievalSuccessRun,
  retrievalStagesUsed,
  runDeterministicRetrievalSuccessBenchmark,
  scoreRetrievalSuccessRun,
  type RetrievalSuccessRunInput
} from "./benchmark.js";
import {
  createServiceEmbeddingProvider,
  databaseUrlWithName,
  deterministicEmbeddingVector,
  embedPendingSources,
  maintenanceDatabaseUrl,
  withTemporaryEmbeddingEnv
} from "./live-runner.js";

const caseById = new Map(retrievalSuccessCases.map((item) => [item.id, item]));

const mustCase = (id: string): RetrievalSuccessCase => {
  const benchmarkCase = caseById.get(id);
  if (!benchmarkCase) {
    throw new Error(`Missing benchmark case ${id}`);
  }
  return benchmarkCase;
};

const readRequestBody = async (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

describe("retrieval-success benchmark cases", () => {
  it("covers the retrieval behaviours KOE-167 is meant to protect", () => {
    expect(retrievalSuccessCases).toHaveLength(7);
    expect(
      retrievalSuccessCases.every(
        (benchmarkCase) =>
          benchmarkCase.runs === 5 &&
          benchmarkCase.boundaryProfile === "post-koe-166-defaults"
      )
    ).toBe(true);

    const requiredStages = new Set(
      retrievalSuccessCases.flatMap(
        (benchmarkCase) => benchmarkCase.expected.requiredStages ?? []
      )
    );
    expect(requiredStages).toEqual(
      new Set([
        "score_scan",
        "rollup_search",
        "scoped_leaf_search",
        "leaf_search",
        "fresh_pending_search",
        "lexical_search"
      ])
    );

    expect(
      retrievalSuccessCases.some(
        (benchmarkCase) => benchmarkCase.expected.temporal?.recentDays === 30
      )
    ).toBe(true);
    expect(
      retrievalSuccessCases.some(
        (benchmarkCase) =>
          benchmarkCase.expected.lexical?.expectation === "forbidden"
      )
    ).toBe(true);
    expect(
      retrievalSuccessCases.some(
        (benchmarkCase) =>
          benchmarkCase.expected.lexical?.expectation === "required"
      )
    ).toBe(true);
  });
});

describe("retrieval-success benchmark scoring", () => {
  it("scores deterministic ideal runs at full marks", () => {
    const summary = runDeterministicRetrievalSuccessBenchmark();

    expect(summary.runs).toHaveLength(
      retrievalSuccessCases.reduce(
        (count, benchmarkCase) => count + benchmarkCase.runs,
        0
      )
    );
    expect(summary.totalScore).toBe(summary.maxScore);
    expect(summary.averageScoreRatio).toBe(1);
    expect(summary.answerCorrectRate).toBe(1);
    expect(summary.evidenceRelevantRate).toBe(1);
    expect(summary.irrelevantEvidenceLeakRate).toBe(0);
  });

  it("penalizes irrelevant evidence leaks from noisy tool output", () => {
    const benchmarkCase = mustCase("fresh-tail-story-detail");
    const score = scoreRetrievalSuccessRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      answer: {
        memoryStatus: "found",
        answerMarkdown: "The keeper was Tamar."
      },
      evidence: [
        {
          sourceId: "fresh-story-lamp-keeper",
          retrievalStage: "fresh_pending_search"
        },
        {
          sourceId: "fresh-story-tool-echo",
          retrievalStage: "raw_fallback_search"
        }
      ],
      searches: [
        { retrievalStage: "score_scan" },
        { retrievalStage: "fresh_pending_search" }
      ]
    });

    expect(score.irrelevantEvidenceLeaked).toBe(true);
    expect(
      score.details.find(
        (detail) => detail.name === "evidence_forbidden:fresh-story-tool-echo"
      )
    ).toMatchObject({ score: 0, reason: "irrelevant evidence leaked" });
  });

  it("flags unjustified lexical fallback on semantic story recall", () => {
    const benchmarkCase = mustCase(
      "semantic-question-avoid-lexical-repeated-terms"
    );
    const score = scoreRetrievalSuccessRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      answer: {
        memoryStatus: "found",
        answerMarkdown: "The apprentice was Celandine."
      },
      evidence: [
        {
          sourceId: "event-recipe-apprentice",
          retrievalStage: "fresh_pending_search"
        },
        {
          sourceId: "event-recipe-echo",
          retrievalStage: "lexical_search"
        }
      ],
      searches: [
        { retrievalStage: "score_scan" },
        { retrievalStage: "lexical_search" }
      ]
    });

    expect(score.lexicalUsed).toBe(true);
    expect(score.lexicalJustified).toBe(false);
    expect(
      score.details.find((detail) => detail.name === "lexical_behavior")
    ).toMatchObject({ score: 0 });
  });

  it("rewards lexical lookup for exact filenames", () => {
    const benchmarkCase = mustCase("lexical-exact-filename");
    const score = scoreRetrievalSuccessRun(
      benchmarkCase,
      idealRetrievalSuccessRun(benchmarkCase)
    );

    expect(score.lexicalUsed).toBe(true);
    expect(score.lexicalJustified).toBe(true);
    expect(score.score).toBe(score.maxScore);
  });

  it("extracts retrieval stages from nested retrieval metadata", () => {
    const run: RetrievalSuccessRunInput = {
      caseId: "nested",
      runIndex: 0,
      answer: {
        memoryStatus: "found",
        answerMarkdown: ""
      },
      evidence: [],
      retrievals: [
        {
          stages: [
            { name: "rollup_search", selectedCount: 1 },
            {
              retrievals: [
                { retrieval_stage: "scoped_leaf_search", used: true },
                { stage: "raw_fallback_search", selected_count: 1 }
              ]
            }
          ]
        }
      ]
    };

    expect(retrievalStagesUsed(run)).toEqual([
      "rollup_search",
      "scoped_leaf_search",
      "raw_fallback_search"
    ]);
  });

  it("does not count retrieval stages that ran but selected no evidence", () => {
    const benchmarkCase = mustCase("rollup-to-scoped-leaf-decision");
    const score = scoreRetrievalSuccessRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      answer: {
        memoryStatus: "found",
        answerMarkdown: "We chose token limits to reduce noisy giant chunks."
      },
      evidence: [
        {
          sourceId: "turn-boundary-project-rollup",
          retrievalStage: "rollup_search"
        }
      ],
      searches: [
        { retrievalStage: "score_scan" },
        { retrievalStage: "scoped_leaf_search" }
      ],
      retrievals: [
        {
          stages: [
            { name: "score_scan", ran: true, used: false, selectedCount: 0 },
            { name: "rollup_search", ran: true, used: true, selectedCount: 1 },
            {
              name: "scoped_leaf_search",
              ran: true,
              used: false,
              selectedCount: 0
            }
          ]
        }
      ]
    });

    expect(score.retrievalStagesUsed).toEqual(["score_scan", "rollup_search"]);
    expect(
      score.details.find(
        (detail) => detail.name === "stage_required:scoped_leaf_search"
      )
    ).toMatchObject({ score: 0, reason: "missing" });
  });
});

describe("retrieval-success live benchmark helpers", () => {
  it("uses deterministic normalized embeddings for temporary DB runs", () => {
    const first = deterministicEmbeddingVector("Aston Villa memory answer");
    const second = deterministicEmbeddingVector("Aston Villa memory answer");
    const norm = Math.sqrt(
      first.reduce((sum, value) => sum + value * value, 0)
    );

    expect(first).toHaveLength(1024);
    expect(first).toEqual(second);
    expect(norm).toBeCloseTo(1, 8);
  });

  it("preserves required Postgres URL query parameters for temporary DB URLs", () => {
    const baseUrl =
      "postgres://koed:secret@example.test:5432/koed?sslmode=require&connect_timeout=10";

    expect(databaseUrlWithName(baseUrl, "koed_eval")).toBe(
      "postgres://koed:secret@example.test:5432/koed_eval?sslmode=require&connect_timeout=10"
    );
    expect(maintenanceDatabaseUrl(baseUrl)).toBe(
      "postgres://koed:secret@example.test:5432/postgres?sslmode=require&connect_timeout=10"
    );
  });

  it("isolates reranker env aliases while running against the deterministic server", async () => {
    const previous = {
      EMBEDDING_SERVICE_URL: process.env.EMBEDDING_SERVICE_URL,
      EMBEDDING_SERVICE_TOKEN: process.env.EMBEDDING_SERVICE_TOKEN,
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
      EMBEDDING_QUERY_INSTRUCTION_ENABLED:
        process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED,
      EMBEDDING_RERANKER_KEY: process.env.EMBEDDING_RERANKER_KEY,
      RERANKER_KEY: process.env.RERANKER_KEY
    };
    process.env.EMBEDDING_SERVICE_URL = "http://original.test";
    process.env.EMBEDDING_SERVICE_TOKEN = "original-token";
    process.env.EMBEDDING_MODEL = "original-model";
    delete process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED;
    process.env.EMBEDDING_RERANKER_KEY = "qwen3-reranker-0.6b";
    process.env.RERANKER_KEY = "qwen3-reranker-0.6b";

    try {
      await withTemporaryEmbeddingEnv(
        "http://deterministic.test",
        "koed-retrieval-success-eval",
        "qwen3-0.6b",
        "disabled",
        async () => {
          expect(process.env.EMBEDDING_SERVICE_URL).toBe(
            "http://deterministic.test"
          );
          expect(process.env.EMBEDDING_SERVICE_TOKEN).toBe(
            "koed-retrieval-success-eval"
          );
          expect(process.env.EMBEDDING_MODEL).toBe("qwen3-0.6b");
          expect(process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED).toBe("false");
          expect(process.env.EMBEDDING_RERANKER_KEY).toBeUndefined();
          expect(process.env.RERANKER_KEY).toBeUndefined();
        }
      );

      expect(process.env.EMBEDDING_SERVICE_URL).toBe("http://original.test");
      expect(process.env.EMBEDDING_SERVICE_TOKEN).toBe("original-token");
      expect(process.env.EMBEDDING_MODEL).toBe("original-model");
      expect(process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED).toBeUndefined();
      expect(process.env.EMBEDDING_RERANKER_KEY).toBe("qwen3-reranker-0.6b");
      expect(process.env.RERANKER_KEY).toBe("qwen3-reranker-0.6b");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("can seed source embeddings through a configured embedding service", async () => {
    const embedRequests: { token: string | undefined; texts: string[] }[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET" && request.url === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              status: "ok",
              modelKey: "qwen3-0.6b",
              dimensions: 1024
            })
          );
          return;
        }
        if (request.method === "POST" && request.url === "/embed") {
          const body = JSON.parse(await readRequestBody(request)) as {
            texts?: string[];
          };
          const texts = body.texts ?? [];
          embedRequests.push({
            token: request.headers["x-koed-embedding-token"]?.toString(),
            texts
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              model: "qwen3-0.6b",
              dimensions: 1024,
              vectors: texts.map((_, index) =>
                Array.from({ length: 1024 }, (__, dimension) =>
                  dimension === index ? 1 : 0
                )
              )
            })
          );
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "not found" }));
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            detail: error instanceof Error ? error.message : "test error"
          })
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local test server address");
    }

    try {
      const provider = await createServiceEmbeddingProvider({
        embeddingServiceUrl: `http://127.0.0.1:${address.port}`,
        embeddingServiceToken: "test-token"
      });
      let listed = false;
      const upserts: Parameters<
        MemorySourceRepository["upsertSourceEmbedding"]
      >[0][] = [];
      const sources: EmbeddableSourceRecord[] = [
        {
          sourceType: "memory_event",
          sourceId: "source-1",
          ownerUserId: "user-1",
          visibility: "personal",
          text: "alpha benchmark source",
          sourceHash: "hash-1"
        },
        {
          sourceType: "memory_node",
          sourceId: "source-2",
          ownerUserId: "user-1",
          visibility: "personal",
          text: "beta benchmark source",
          sourceHash: "hash-2"
        }
      ];
      await embedPendingSources(
        {
          listSourcesNeedingEmbeddings: () => {
            if (listed) {
              return Promise.resolve([]);
            }
            listed = true;
            return Promise.resolve(sources);
          },
          upsertSourceEmbedding: (input) => {
            upserts.push(input);
            return Promise.resolve({
              id: input.source.sourceId,
              inserted: true
            });
          }
        },
        provider
      );

      expect(embedRequests).toEqual([
        {
          token: "test-token",
          texts: ["alpha benchmark source", "beta benchmark source"]
        }
      ]);
      expect(upserts.map((input) => input.model)).toEqual([
        "qwen3-0.6b",
        "qwen3-0.6b"
      ]);
      expect(upserts.map((input) => input.dimensions)).toEqual([1024, 1024]);
      expect(upserts.map((input) => input.vector)).toEqual([
        expect.arrayContaining([1]),
        expect.arrayContaining([1])
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
