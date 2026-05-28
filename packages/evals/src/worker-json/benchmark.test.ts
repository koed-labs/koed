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

  it("scores an LCM summary with required structured arrays", () => {
    const score = scoreWorkerJsonRun(
      mustCase("lcm-leaf-preserves-operational-details"),
      {
        caseId: "lcm-leaf-preserves-operational-details",
        runIndex: 0,
        worker: "lcm_summary",
        output: {
          schema_version: "lcm-structured-summary-v1",
          summary_text:
            "The user requested a Docker rebuild and noted a UI regression.",
          user_requests: ["Rebuild Docker locally."],
          decisions: [],
          facts: [],
          files: [],
          commands: ["docker compose up --build"],
          model_names: [],
          tool_outcomes: [],
          errors: ["UI regression remains."],
          unresolved_questions: [],
          provenance_hints: []
        }
      }
    );

    expect(score.validJson).toBe(true);
    expect(score.score).toBe(score.maxScore);
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
