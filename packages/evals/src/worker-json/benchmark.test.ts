import { LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION } from "@koed/core";
import { describe, expect, it } from "vitest";
import { workerJsonCases } from "./cases.js";
import {
  scoreWorkerJsonRun,
  summarizeWorkerJsonBenchmark
} from "./benchmark.js";

const caseById = new Map(workerJsonCases.map((item) => [item.id, item]));

const mustCase = (id: string) => {
  const benchmarkCase = caseById.get(id);
  if (!benchmarkCase) {
    throw new Error(`Missing benchmark case ${id}`);
  }
  return benchmarkCase;
};

describe("worker JSON benchmark scoring", () => {
  it("scores a valid memory answer result", () => {
    const score = scoreWorkerJsonRun(
      mustCase("memory-found-project-decision"),
      {
        caseId: "memory-found-project-decision",
        runIndex: 0,
        worker: "memory_answer",
        output: {
          schema_version: "memory-answer-v1",
          memory_status: "found",
          relevant_memory_found: true,
          answer_markdown:
            "Answer synthesis should run through the local Codex subscription.",
          relevance_explanation: "The evidence directly supports the answer.",
          evidence: [{ source_id: "node-1", relevance: "direct support" }],
          missing: [],
          missing_evidence: []
        }
      }
    );

    expect(score.validJson).toBe(true);
    expect(score.score).toBe(score.maxScore);
  });

  it("scores an LCM summary with a canonical semantic body", () => {
    const score = scoreWorkerJsonRun(
      mustCase("lcm-leaf-preserves-semantic-outcomes"),
      {
        caseId: "lcm-leaf-preserves-semantic-outcomes",
        runIndex: 0,
        worker: "lcm_summary",
        output: {
          schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
          title: "Docker UI regression",
          summary_text:
            "The user requested a local Docker rebuild while a UI regression remained unresolved.",
          lexical_anchors: []
        }
      }
    );

    expect(score.validJson).toBe(true);
    expect(score.score).toBe(score.maxScore);
  });

  it("uses the production title length constraint", () => {
    const score = scoreWorkerJsonRun(
      mustCase("lcm-leaf-preserves-semantic-outcomes"),
      {
        caseId: "lcm-leaf-preserves-semantic-outcomes",
        runIndex: 0,
        worker: "lcm_summary",
        output: {
          schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
          title: "x".repeat(121),
          summary_text:
            "The user requested a local Docker rebuild while a UI regression remained unresolved.",
          lexical_anchors: []
        }
      }
    );

    expect(score.validJson).toBe(false);
    expect(score.score).toBe(0);
  });

  it("rejects prose-only output", () => {
    const score = scoreWorkerJsonRun(
      mustCase("memory-found-project-decision"),
      {
        caseId: "memory-found-project-decision",
        runIndex: 0,
        worker: "memory_answer",
        output: "Answer synthesis should run locally."
      }
    );

    expect(score.validJson).toBe(false);
    expect(score.score).toBe(0);
  });

  it("summarizes benchmark runs", () => {
    const summary = summarizeWorkerJsonBenchmark([
      {
        caseId: "a",
        runIndex: 0,
        worker: "memory_answer",
        score: 5,
        maxScore: 10,
        validJson: true,
        details: []
      },
      {
        caseId: "b",
        runIndex: 0,
        worker: "lcm_summary",
        score: 0,
        maxScore: 10,
        validJson: false,
        details: []
      }
    ]);

    expect(summary.averageScoreRatio).toBe(0.25);
    expect(summary.validJsonRate).toBe(0.5);
  });
});
