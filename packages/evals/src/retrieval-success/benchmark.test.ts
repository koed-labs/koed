import { describe, expect, it } from "vitest";
import { retrievalSuccessCases, type RetrievalSuccessCase } from "./cases.js";
import {
  idealRetrievalSuccessRun,
  retrievalStagesUsed,
  runDeterministicRetrievalSuccessBenchmark,
  scoreRetrievalSuccessRun,
  type RetrievalSuccessRunInput
} from "./benchmark.js";
import {
  databaseUrlWithName,
  deterministicEmbeddingVector,
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
      EMBEDDING_RERANKER_KEY: process.env.EMBEDDING_RERANKER_KEY,
      RERANKER_KEY: process.env.RERANKER_KEY
    };
    process.env.EMBEDDING_SERVICE_URL = "http://original.test";
    process.env.EMBEDDING_SERVICE_TOKEN = "original-token";
    process.env.EMBEDDING_MODEL = "original-model";
    process.env.EMBEDDING_RERANKER_KEY = "qwen3-reranker-0.6b";
    process.env.RERANKER_KEY = "qwen3-reranker-0.6b";

    try {
      await withTemporaryEmbeddingEnv("http://deterministic.test", async () => {
        expect(process.env.EMBEDDING_SERVICE_URL).toBe(
          "http://deterministic.test"
        );
        expect(process.env.EMBEDDING_SERVICE_TOKEN).toBe(
          "koed-retrieval-success-eval"
        );
        expect(process.env.EMBEDDING_MODEL).toBe("qwen3-0.6b");
        expect(process.env.EMBEDDING_RERANKER_KEY).toBeUndefined();
        expect(process.env.RERANKER_KEY).toBeUndefined();
      });

      expect(process.env.EMBEDDING_SERVICE_URL).toBe("http://original.test");
      expect(process.env.EMBEDDING_SERVICE_TOKEN).toBe("original-token");
      expect(process.env.EMBEDDING_MODEL).toBe("original-model");
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
});
