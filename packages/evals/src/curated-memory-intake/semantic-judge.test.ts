import { describe, expect, it } from "vitest";
import { curatedMemoryIntakeCases } from "./cases.js";
import {
  buildCuratedMemorySemanticJudgePrompt,
  CURATED_MEMORY_SEMANTIC_JUDGE_SCHEMA_VERSION,
  judgeAcceptedCuratedMemory,
  parseCuratedMemorySemanticJudgeOutput,
  type CuratedMemorySemanticJudgeConfig
} from "./semantic-judge.js";

const benchmarkCase = curatedMemoryIntakeCases.find(
  (item) => item.id === "coding-language-preference"
)!;
const proposal = {
  toolName: "memory_intake_propose",
  arguments: {
    proposed_claim:
      "The user favours TypeScript for quick tools, except when Python libraries are required."
  }
};
const intake = {
  proposalStatus: "stored" as const,
  assertionId: "11111111-1111-4111-8111-111111111111",
  assertionText:
    "For small internal tools, the user favours TypeScript unless the available libraries require Python."
};
const config: CuratedMemorySemanticJudgeConfig = {
  appServerBinary: "codex",
  model: "judge-model",
  reasoningEffort: "medium",
  timeoutMs: 1_000,
  maxAttempts: 1,
  cwd: process.cwd(),
  env: {}
};

const passingOutput = JSON.stringify({
  schema_version: CURATED_MEMORY_SEMANTIC_JUDGE_SCHEMA_VERSION,
  verdict: "pass",
  dimensions: {
    faithfulness: true,
    qualification_preservation: true,
    durability: true,
    specificity: true,
    rewrite_quality: true
  },
  issues: [],
  rationale:
    "The paraphrase preserves the preference and its Python-library exception."
});

describe("Curated Memory semantic judge", () => {
  it("parses strict semantic judge JSON", () => {
    expect(parseCuratedMemorySemanticJudgeOutput(passingOutput)).toMatchObject({
      verdict: "pass"
    });
  });

  it("rejects malformed semantic judge output", () => {
    expect(() => parseCuratedMemorySemanticJudgeOutput("not json")).toThrow(
      "Invalid Curated Memory semantic judge JSON"
    );
  });

  it("tells the judge to compare meaning instead of spelling", () => {
    const prompt = buildCuratedMemorySemanticJudgePrompt({
      benchmarkCase,
      proposal,
      intake
    });
    expect(prompt).toContain("Judge meaning, not exact wording, spelling");
    expect(prompt).toContain("unless the available libraries require Python");
  });

  it("passes a semantically faithful rewrite with different spelling", async () => {
    const assessment = await judgeAcceptedCuratedMemory(
      { benchmarkCase, proposal, intake },
      {
        config,
        runner: async () => ({
          text: passingOutput,
          model: "judge-model",
          tokenUsage: {
            total: {
              inputTokens: 100,
              cachedInputTokens: 0,
              outputTokens: 20,
              reasoningOutputTokens: 5,
              totalTokens: 120
            },
            last: {
              inputTokens: 100,
              cachedInputTokens: 0,
              outputTokens: 20,
              reasoningOutputTokens: 5,
              totalTokens: 120
            },
            modelContextWindow: 100_000
          }
        })
      }
    );

    expect(assessment).toMatchObject({
      status: "judged",
      passed: true,
      inputTokens: 100,
      outputTokens: 20
    });
  });

  it("fails a negation-clipped assertion even with a high overall score", async () => {
    const passingDecision =
      parseCuratedMemorySemanticJudgeOutput(passingOutput);
    const assessment = await judgeAcceptedCuratedMemory(
      { benchmarkCase, proposal, intake },
      {
        config,
        runner: async () => ({
          text: JSON.stringify({
            ...passingDecision,
            verdict: "fail",
            dimensions: {
              ...passingDecision.dimensions,
              qualification_preservation: false
            },
            issues: [
              {
                severity: "high",
                category: "qualification_preservation",
                note: "The exception was removed."
              }
            ]
          }),
          model: "judge-model"
        })
      }
    );

    expect(assessment).toMatchObject({
      status: "judged",
      passed: false,
      verdict: "fail"
    });
  });
});
