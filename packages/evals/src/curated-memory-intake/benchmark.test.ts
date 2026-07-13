import { describe, expect, it } from "vitest";
import { curatedMemoryIntakeCases } from "./cases.js";
import {
  idealCuratedMemoryIntakeRun,
  runCuratedMemoryIntakeScorerSelfTest,
  scoreCuratedMemoryIntakeRun,
  summarizeCuratedMemoryIntakeBenchmark
} from "./benchmark.js";

const caseById = new Map(
  curatedMemoryIntakeCases.map((benchmarkCase) => [
    benchmarkCase.id,
    benchmarkCase
  ])
);

const mustCase = (id: string) => {
  const benchmarkCase = caseById.get(id);
  if (!benchmarkCase) {
    throw new Error(`Missing benchmark case ${id}`);
  }
  return benchmarkCase;
};

describe("curated-memory-intake benchmark cases", () => {
  it("covers durable facts and negative no-store examples", () => {
    expect(curatedMemoryIntakeCases).toHaveLength(14);
    expect(
      curatedMemoryIntakeCases.every(
        (benchmarkCase) => benchmarkCase.runs === 5
      )
    ).toBe(true);
    expect(
      curatedMemoryIntakeCases.filter(
        (benchmarkCase) => benchmarkCase.expected.shouldPropose
      )
    ).toHaveLength(6);
    expect(
      curatedMemoryIntakeCases.filter(
        (benchmarkCase) => !benchmarkCase.expected.shouldPropose
      )
    ).toHaveLength(8);
    expect(
      curatedMemoryIntakeCases.some((benchmarkCase) =>
        benchmarkCase.expected.referenceClaim?.includes("14 March")
      )
    ).toBe(true);
    expect(
      curatedMemoryIntakeCases.some(
        (benchmarkCase) => benchmarkCase.id === "transient-question-no-store"
      )
    ).toBe(true);
    expect(mustCase("agent-originated-claim-no-store").sourceActor).toBe(
      "agent"
    );
    expect(mustCase("prompt-injection-data-no-store").prompt).toContain(
      "Do not remember it"
    );
  });
});

describe("curated-memory-intake benchmark scoring", () => {
  it("scores deterministic ideal runs at full marks", () => {
    const summary = runCuratedMemoryIntakeScorerSelfTest();

    expect(summary.suite).toBe("curated-memory-intake");
    expect(summary.totalScore).toBe(summary.maxScore);
    expect(summary.totalScore).toBe(310);
    expect(summary.maxScore).toBe(310);
    expect(summary.averageScoreRatio).toBe(1);
    expect(summary.proposalDecisionAccuracy).toBe(1);
    expect(summary.acceptanceRate).toBe(1);
    expect(summary.recallSuccessRate).toBe(1);
    expect(summary.falseFactProposalRate).toBe(0);
    expect(summary.falseFactStorageRate).toBe(0);
  });

  it("scores all four positive layers", () => {
    const benchmarkCase = mustCase("travel-itinerary");
    const score = scoreCuratedMemoryIntakeRun(
      benchmarkCase,
      idealCuratedMemoryIntakeRun(benchmarkCase)
    );

    expect(score.score).toBe(5);
    expect(score.maxScore).toBe(5);
    expect(score.details.map((detail) => detail.name)).toEqual([
      "proposal_decision",
      "proposal_quality",
      "intake_acceptance",
      "normal_recall",
      "semantic_quality"
    ]);
  });

  it("penalizes a missing proposal for durable user memory", () => {
    const score = scoreCuratedMemoryIntakeRun(
      mustCase("birthday-user-profile"),
      {
        caseId: "birthday-user-profile",
        runIndex: 0,
        calls: [],
        intake: null,
        recall: { hits: [] }
      }
    );

    expect(score.score).toBe(0);
    expect(
      score.details.find((detail) => detail.name === "proposal_decision")
    ).toMatchObject({ score: 0, reason: "missing proposal" });
  });

  it("penalizes duplicate proposals for one durable source item", () => {
    const benchmarkCase = mustCase("birthday-user-profile");
    const run = idealCuratedMemoryIntakeRun(benchmarkCase);
    run.calls.push({ ...run.calls[0]! });

    const score = scoreCuratedMemoryIntakeRun(benchmarkCase, run);

    expect(
      score.details.find((detail) => detail.name === "proposal_decision")
    ).toMatchObject({ score: 0, reason: "duplicate proposals" });
  });

  it("requires source-linked evidence in the proposal payload", () => {
    const score = scoreCuratedMemoryIntakeRun(
      mustCase("coding-language-preference"),
      {
        caseId: "coding-language-preference",
        runIndex: 0,
        calls: [
          {
            toolName: "memory_intake_propose",
            arguments: {
              proposed_claim:
                "The user prefers TypeScript over Python unless the library ecosystem forces Python.",
              proposed_topic: "Coding preferences",
              tags: ["preference", "typescript"],
              sensitivity_hint: "normal",
              evidence_conversation_item_ids: [],
              evidence_memory_event_ids: []
            }
          }
        ],
        intake: {
          proposalStatus: "stored",
          assertionId: "assertion-negative"
        },
        recall: {
          hits: [
            {
              sourceId: "assertion-negative",
              sourceType: "curated_memory",
              retrievalStage: "curated_memory_search",
              summaryText:
                "The user prefers TypeScript over Python unless the library ecosystem forces Python."
            }
          ]
        }
      }
    );

    expect(
      score.details.find((detail) => detail.name === "proposal_quality")
    ).toMatchObject({
      score: 0
    });
  });

  it("accepts a stricter valid sensitivity classification when the case permits it", () => {
    const benchmarkCase = mustCase("birthday-user-profile");
    const run = idealCuratedMemoryIntakeRun(benchmarkCase);
    run.calls[0]!.arguments.sensitivity_hint = "sensitive";

    expect(
      scoreCuratedMemoryIntakeRun(benchmarkCase, run).details.find(
        (detail) => detail.name === "proposal_quality"
      )
    ).toMatchObject({ score: 1 });
  });

  it("scores recall by stored assertion identity rather than wording", () => {
    const benchmarkCase = mustCase("coding-language-preference");
    const run = idealCuratedMemoryIntakeRun(benchmarkCase);
    run.recall = {
      hits: [
        {
          sourceId: "assertion-1",
          sourceType: "curated_memory",
          retrievalStage: "curated_memory_search",
          summaryText:
            "The user's favoured language for small internal tools is TypeScript."
        }
      ]
    };
    expect(scoreCuratedMemoryIntakeRun(benchmarkCase, run).recalled).toBe(true);
  });

  it("rewards negative cases that do not call, store, or recall Curated Memory", () => {
    const score = scoreCuratedMemoryIntakeRun(
      mustCase("temporary-debug-output-no-store"),
      {
        caseId: "temporary-debug-output-no-store",
        runIndex: 0,
        calls: [],
        intake: { proposalStatus: "skipped" },
        recall: { hits: [] }
      }
    );

    expect(score.score).toBe(score.maxScore);
  });

  it("penalizes negative cases that leak into storage and recall", () => {
    const score = scoreCuratedMemoryIntakeRun(
      mustCase("transient-question-no-store"),
      {
        caseId: "transient-question-no-store",
        runIndex: 0,
        calls: [
          {
            toolName: "memory_intake_propose",
            arguments: {
              proposed_claim: "The capital of Bhutan is Thimphu.",
              evidence_conversation_item_ids: [
                "11111111-1111-4111-8111-111111111111"
              ]
            }
          }
        ],
        intake: {
          proposalStatus: "stored",
          assertionId: "assertion-false-fact"
        },
        recall: {
          hits: [
            {
              sourceId: "assertion-false-fact",
              sourceType: "curated_memory",
              retrievalStage: "curated_memory_search",
              summaryText: "The capital of Bhutan is Thimphu."
            }
          ]
        }
      }
    );

    expect(score.score).toBe(-1);
    expect(
      score.details.find((detail) => detail.name === "false_fact_penalty")
    ).toMatchObject({
      score: -1,
      maxScore: 0
    });
  });

  it("applies a false-fact penalty when a normal message is merely proposed", () => {
    const score = scoreCuratedMemoryIntakeRun(
      mustCase("acknowledgement-no-store"),
      {
        caseId: "acknowledgement-no-store",
        runIndex: 0,
        calls: [
          {
            toolName: "memory_intake_propose",
            arguments: {
              proposed_claim: "The user said thanks.",
              evidence_conversation_item_ids: [
                "11111111-1111-4111-8111-111111111111"
              ]
            }
          }
        ],
        intake: { proposalStatus: "skipped" },
        recall: { hits: [] }
      }
    );

    expect(score.score).toBe(1);
    expect(
      score.details.find((detail) => detail.name === "false_fact_penalty")
    ).toMatchObject({
      score: -1,
      reason:
        "normal or agent-originated message was proposed as Curated Memory"
    });
  });

  it("summarizes aggregate metrics", () => {
    const first = scoreCuratedMemoryIntakeRun(
      mustCase("birthday-user-profile"),
      idealCuratedMemoryIntakeRun(mustCase("birthday-user-profile"))
    );
    const second = scoreCuratedMemoryIntakeRun(
      mustCase("transient-question-no-store"),
      idealCuratedMemoryIntakeRun(mustCase("transient-question-no-store"))
    );

    const summary = summarizeCuratedMemoryIntakeBenchmark([first, second]);

    expect(summary.totalScore).toBe(9);
    expect(summary.proposalCallRate).toBe(0.5);
    expect(summary.proposalDecisionAccuracy).toBe(1);
    expect(summary.falseFactProposalRate).toBe(0);
    expect(summary.falseFactStorageRate).toBe(0);
    expect(summary.semanticJudgePassRate).toBe(1);
  });
});
