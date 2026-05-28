import { describe, expect, it } from "vitest";
import {
  scoreToolChoiceRun,
  summarizeToolChoiceBenchmark
} from "./benchmark.js";
import { toolChoiceCases } from "./cases.js";

const caseById = new Map(toolChoiceCases.map((item) => [item.id, item]));

const mustCase = (id: string) => {
  const benchmarkCase = caseById.get(id);
  if (!benchmarkCase) {
    throw new Error(`Missing benchmark case ${id}`);
  }
  return benchmarkCase;
};

describe("tool-choice benchmark scoring", () => {
  it("scores ideal memory call arguments", () => {
    const score = scoreToolChoiceRun(mustCase("project-prior-decision"), {
      caseId: "project-prior-decision",
      runIndex: 0,
      calls: [
        {
          toolName: "memory_answer",
          arguments: {
            query: "API token decision",
            search_domain: "project",
            response_detail: "answer_only",
            include_evidence: false
          }
        }
      ],
      finalResponse: "API tokens are personal-memory only."
    });

    expect(score.score).toBe(score.maxScore);
    expect(score.disclosureCount).toBe(0);
  });

  it("gives acceptable scope partial credit", () => {
    const score = scoreToolChoiceRun(mustCase("global-cross-project-topic"), {
      caseId: "global-cross-project-topic",
      runIndex: 0,
      calls: [
        {
          toolName: "memory_answer",
          arguments: {
            query: "Aston Villa",
            search_domain: "project",
            response_detail: "answer_only",
            include_evidence: false
          }
        }
      ],
      finalResponse: "Yes, Aston Villa came up before."
    });

    expect(
      score.details.find((detail) => detail.name === "search_domain")
    ).toMatchObject({
      score: 1,
      reason: "acceptable"
    });
  });

  it("does not score session scope as valid without a session_id", () => {
    const score = scoreToolChoiceRun(mustCase("session-specific-recap"), {
      caseId: "session-specific-recap",
      runIndex: 0,
      calls: [
        {
          toolName: "memory_answer",
          arguments: {
            query: "recap the saved session",
            search_domain: "session",
            response_detail: "answer_only",
            include_evidence: false
          }
        }
      ],
      finalResponse: "I found the saved-session recap."
    });

    expect(
      score.details.find((detail) => detail.name === "search_domain")
    ).toMatchObject({
      score: 0,
      reason: "session_id missing for session scope"
    });
  });

  it("scores session scope as ideal when a session_id is present", () => {
    const score = scoreToolChoiceRun(mustCase("session-specific-recap"), {
      caseId: "session-specific-recap",
      runIndex: 0,
      calls: [
        {
          toolName: "memory_answer",
          arguments: {
            query: "recap the saved session",
            search_domain: "session",
            session_id: "8a65bfa5-b382-483a-86ff-b06e04cf2ce5",
            response_detail: "answer_only",
            include_evidence: false
          }
        }
      ],
      finalResponse: "I found the saved-session recap."
    });

    expect(
      score.details.find((detail) => detail.name === "search_domain")
    ).toMatchObject({
      score: 3,
      reason: "ideal"
    });
  });

  it("penalizes missing required memory calls", () => {
    const score = scoreToolChoiceRun(mustCase("remembered-user-preference"), {
      caseId: "remembered-user-preference",
      runIndex: 0,
      calls: [],
      finalResponse: "I do not know your usual preference."
    });

    expect(score.score).toBe(-1);
    expect(score.details[0]).toMatchObject({
      name: "memory_call",
      reason: "required memory call missing"
    });
  });

  it("scores no-call cases without invoking memory", () => {
    const score = scoreToolChoiceRun(mustCase("public-fact-no-memory-needed"), {
      caseId: "public-fact-no-memory-needed",
      runIndex: 0,
      calls: [],
      finalResponse: "Bangkok."
    });

    expect(score.score).toBe(3);
    expect(score.maxScore).toBe(3);
  });

  it("flags repeated calls and counts memory-tool disclosures", () => {
    const score = scoreToolChoiceRun(mustCase("not-found-do-not-repeat"), {
      caseId: "not-found-do-not-repeat",
      runIndex: 0,
      calls: [
        {
          toolName: "memory_answer",
          arguments: {
            query: "billing dashboard codename",
            search_domain: "project",
            response_detail: "answer_only",
            include_evidence: false
          }
        },
        {
          toolName: "memory_answer",
          arguments: {
            query: "billing dashboard codename",
            search_domain: "global",
            response_detail: "answer_only",
            include_evidence: false
          }
        }
      ],
      finalResponse: "I used the memory tool and did not find it."
    });

    expect(
      score.details.find((detail) => detail.name === "memory_call_count")
    ).toMatchObject({
      score: 0,
      reason: "repeated memory calls"
    });
    expect(score.disclosureCount).toBe(1);
  });

  it("summarizes aggregate benchmark metrics", () => {
    const first = scoreToolChoiceRun(
      mustCase("current-task-no-memory-needed"),
      {
        caseId: "current-task-no-memory-needed",
        runIndex: 0,
        calls: [],
        finalResponse: "Done."
      }
    );
    const second = scoreToolChoiceRun(mustCase("remembered-user-preference"), {
      caseId: "remembered-user-preference",
      runIndex: 0,
      calls: [],
      finalResponse: "I do not know."
    });

    const summary = summarizeToolChoiceBenchmark([first, second]);

    expect(summary.totalScore).toBe(2);
    expect(summary.memoryCallRate).toBe(0);
    expect(summary.runs).toHaveLength(2);
  });
});

describe("tool-choice benchmark cases", () => {
  it("keeps cases reviewable and ready for five-run statistical sampling", () => {
    expect(toolChoiceCases).toHaveLength(8);
    for (const benchmarkCase of toolChoiceCases) {
      expect(benchmarkCase.runs).toBe(5);
      expect(benchmarkCase.prompt).not.toMatch(/\bmemory tool\b/i);
      expect(benchmarkCase.fakeMemoryAnswer.markdown.length).toBeGreaterThan(0);
    }
  });
});
