import { describe, expect, it } from "vitest";
import { LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION } from "@koed/mcp-server";
import {
  scoreLcmSummaryRun,
  summarizeLcmSummaryBenchmark
} from "./benchmark.js";
import { lcmSummaryBenchmarkCases } from "./cases.js";
import { mustCase, passingOutput } from "./test-helpers.js";

describe("LCM summary generation benchmark cases", () => {
  it("contains the planned initial fixture set", () => {
    expect(lcmSummaryBenchmarkCases).toHaveLength(12);
    expect(
      lcmSummaryBenchmarkCases.map((benchmarkCase) => benchmarkCase.id)
    ).toEqual([
      "accepted-decision-ai-client-synthesis",
      "superseded-decision-typescript-hook",
      "error-then-fix-projection-status",
      "long-tool-output-one-durable-fact",
      "exact-identifiers-files-commands-env",
      "unresolved-team-memory-question",
      "rollup-child-summaries",
      "rollup-conflict-latest-wins",
      "noisy-lifecycle-items",
      "model-name-preservation",
      "provenance-source-anchor",
      "secret-like-value-redaction"
    ]);
  });
});

describe("LCM summary generation scoring", () => {
  it("passes known-good synthetic outputs for all cases", () => {
    for (const benchmarkCase of lcmSummaryBenchmarkCases) {
      const score = scoreLcmSummaryRun(benchmarkCase, {
        caseId: benchmarkCase.id,
        runIndex: 0,
        output: passingOutput(benchmarkCase)
      });
      expect(score.validJson, benchmarkCase.id).toBe(true);
      expect(score.criticalFailure, benchmarkCase.id).toBe(false);
      expect(score.passed, benchmarkCase.id).toBe(true);
    }
  });

  it("rejects invalid JSON", () => {
    const score = scoreLcmSummaryRun(
      mustCase("accepted-decision-ai-client-synthesis"),
      {
        caseId: "accepted-decision-ai-client-synthesis",
        runIndex: 0,
        output: "not json"
      }
    );

    expect(score.validJson).toBe(false);
    expect(score.passed).toBe(false);
  });

  it("rejects markdown-wrapped invalid output", () => {
    const score = scoreLcmSummaryRun(
      mustCase("accepted-decision-ai-client-synthesis"),
      {
        caseId: "accepted-decision-ai-client-synthesis",
        runIndex: 0,
        output: "```json\nnot json\n```"
      }
    );

    expect(score.validJson).toBe(false);
    expect(score.criticalFailure).toBe(true);
  });

  it("rejects missing required schema fields", () => {
    const score = scoreLcmSummaryRun(
      mustCase("accepted-decision-ai-client-synthesis"),
      {
        caseId: "accepted-decision-ai-client-synthesis",
        runIndex: 0,
        output: {
          schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
          summary_text: "backend returns Evidence Bundles only"
        }
      }
    );

    expect(score.validJson).toBe(false);
  });

  it("fails critical forbidden claims", () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const output = passingOutput(benchmarkCase);
    output.facts.push("koed_live_secret_abc123");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
    expect(
      score.details.find((detail) => detail.name === "forbidden:literal-token")
    ).toMatchObject({
      score: 0,
      critical: true
    });
  });

  it("scans passthrough fields for forbidden claims", () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const output = {
      ...passingOutput(benchmarkCase),
      unexpected_model_field: "koed_live_secret_abc123"
    };

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find((detail) => detail.name === "forbidden:literal-token")
    ).toMatchObject({
      score: 0,
      critical: true
    });
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("does not satisfy required claims from passthrough fields", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = {
      ...passingOutput(benchmarkCase),
      decisions: [],
      summary_text: "Koed answer synthesis placement was discussed.",
      extra_decision:
        "Backend returns Evidence Bundles only and Answer Synthesis runs in the connected AI Client."
    };

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "required:backend-evidence-only"
      )
    ).toMatchObject({
      score: 0
    });
    expect(score.criticalFailure).toBe(true);
  });

  it("does not pass negated critical required claims through token overlap", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Backend no longer returns Evidence Bundles only.",
      "It is false that Answer Synthesis remains in the connected AI Client."
    ];
    output.summary_text = output.decisions.join(" ");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
    expect(
      score.details.find(
        (detail) => detail.name === "required:backend-evidence-only"
      )
    ).toMatchObject({
      score: 0
    });
    expect(
      score.details.find(
        (detail) => detail.name === "required:ai-client-synthesis"
      )
    ).toMatchObject({
      score: 0
    });
  });

  it("still fails critically when a required claim is missing", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = passingOutput(benchmarkCase);
    output.summary_text = "The backend returns Evidence Bundles only.";
    output.decisions = ["The backend returns Evidence Bundles only."];
    output.facts = [];
    output.tool_outcomes = [];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "required:ai-client-synthesis"
      )
    ).toMatchObject({
      score: 0,
      critical: true
    });
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("accepts a later affirmative required claim after an earlier negated mention", () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const output = passingOutput(benchmarkCase);
    output.user_requests = [
      "Do not preserve the literal secret value after it was accidentally pasted."
    ];
    output.facts = [
      "The API token was rotated.",
      "The literal secret value must be redacted from retained summaries."
    ];
    output.summary_text =
      "The user asked not to preserve the literal secret value. The token was rotated and the literal secret value must be redacted.";

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "required:literal-redacted"
      )
    ).toMatchObject({
      score: 4
    });
    expect(score.criticalFailure).toBe(false);
  });

  it("accepts TypeScript-only wording for the supported Capture Hook decision", () => {
    const benchmarkCase = mustCase("superseded-decision-typescript-hook");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "The early fallback plan was superseded; the implementation choice became TypeScript-only for the Codex Capture Hook, with the Python hook removed."
    ];
    output.summary_text =
      "The later decision removed the Python hook and made the implementation choice TypeScript-only for the Codex Capture Hook.";

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "field:typescript-supported"
      )
    ).toMatchObject({
      score: 2
    });
    expect(score.criticalFailure).toBe(false);
  });

  it("fails any forbidden exact phrase alternative", () => {
    const benchmarkCase = mustCase("superseded-decision-typescript-hook");
    const output = passingOutput(benchmarkCase);
    output.decisions.push("Python hook is supported.");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:python-still-supported"
      )
    ).toMatchObject({
      score: 0,
      critical: true
    });
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("does not fail forbidden claims when the match is negated", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Backend returns Evidence Bundles only.",
      "Answer Synthesis runs in the connected AI Client.",
      "The backend does not use an LLM for answer generation."
    ];
    output.summary_text = output.decisions.join(" ");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find((detail) => detail.name === "forbidden:backend-llm")
    ).toMatchObject({
      score: 6
    });
    expect(score.criticalFailure).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("does not fail exact forbidden phrases when the match is negated", () => {
    const benchmarkCase = mustCase("rollup-conflict-latest-wins");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Diagnostic low-level memory tools stay hidden unless explicitly enabled.",
      "Diagnostic low-level memory tools are not enabled by default for all users."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:diagnostic-default"
      )
    ).toMatchObject({
      score: 6
    });
    expect(score.criticalFailure).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("fails exact forbidden phrases when a later occurrence is affirmative", () => {
    const benchmarkCase = mustCase("rollup-conflict-latest-wins");
    const output = passingOutput(benchmarkCase);
    output.decisions.push(
      "Diagnostic low-level memory tools are not enabled by default for all users; enabled by default for all users."
    );

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:diagnostic-default"
      )
    ).toMatchObject({
      score: 0,
      critical: true
    });
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("still fails redacted exact forbidden literals in negated context", () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const output = passingOutput(benchmarkCase);
    output.facts.push("Do not preserve koed_live_secret_abc123.");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find((detail) => detail.name === "forbidden:literal-token")
    ).toMatchObject({
      score: 0
    });
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("accepts required claims expressed across compact clauses", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "The backend returns Evidence Bundles only.",
      "Answer Synthesis is not in the backend; it remains in the connected AI Client."
    ];
    output.summary_text = output.decisions.join(" ");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "required:ai-client-synthesis"
      )
    ).toMatchObject({
      score: 4
    });
    expect(
      score.details.find(
        (detail) => detail.name === "field:ai-client-synthesis"
      )
    ).toMatchObject({
      score: 2
    });
    expect(score.criticalFailure).toBe(false);
  });

  it("rejects opposite Answer Synthesis placement despite shared tokens", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Backend returns Evidence Bundles only.",
      "Answer Synthesis moved away from the connected AI Client."
    ];
    output.summary_text = output.decisions.join(" ");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "required:ai-client-synthesis"
      )
    ).toMatchObject({
      score: 0
    });
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("requires run wording to preserve AI Client placement", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const accepted = passingOutput(benchmarkCase);
    accepted.decisions = [
      "Backend returns Evidence Bundles only.",
      "Answer Synthesis runs within the connected AI Client."
    ];

    const acceptedScore = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output: accepted
    });

    expect(
      acceptedScore.details.find(
        (detail) => detail.name === "required:ai-client-synthesis"
      )
    ).toMatchObject({
      score: 4
    });
    expect(acceptedScore.criticalFailure).toBe(false);

    for (const goodPlacement of [
      "Answer Synthesis should run in the connected AI Client.",
      "Answer Synthesis must run within the connected AI Client."
    ]) {
      const modalAccepted = passingOutput(benchmarkCase);
      modalAccepted.decisions = [
        "Backend returns Evidence Bundles only.",
        goodPlacement
      ];
      modalAccepted.summary_text = modalAccepted.decisions.join(" ");

      const modalScore = scoreLcmSummaryRun(benchmarkCase, {
        caseId: benchmarkCase.id,
        runIndex: 0,
        output: modalAccepted
      });

      expect(
        modalScore.details.find(
          (detail) => detail.name === "required:ai-client-synthesis"
        )
      ).toMatchObject({
        score: 4
      });
      expect(modalScore.criticalFailure).toBe(false);
    }

    for (const badPlacement of [
      "Answer Synthesis does not run in the connected AI Client.",
      "Answer Synthesis runs outside the connected AI Client.",
      "Answer Synthesis runs away from the connected AI Client."
    ]) {
      const rejected = passingOutput(benchmarkCase);
      rejected.decisions = [
        "Backend returns Evidence Bundles only.",
        badPlacement
      ];
      rejected.summary_text = rejected.decisions.join(" ");

      const rejectedScore = scoreLcmSummaryRun(benchmarkCase, {
        caseId: benchmarkCase.id,
        runIndex: 0,
        output: rejected
      });

      expect(
        rejectedScore.details.find(
          (detail) => detail.name === "required:ai-client-synthesis"
        )
      ).toMatchObject({
        score: 0
      });
      expect(rejectedScore.criticalFailure).toBe(true);
    }
  });

  it("accepts explicit required-term variants without broad fuzzy matching", () => {
    const benchmarkCase = mustCase("long-tool-output-one-durable-fact");
    const output = passingOutput(benchmarkCase);
    output.facts = [
      "The smoke output explicitly labeled migration 0012_memory_nodes_backfill as the first migration that requires a fresh local reset in the MVP branch."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(false);
    expect(
      score.details.find((detail) => detail.name === "required:migration-reset")
    ).toMatchObject({
      score: 4
    });
  });

  it("accepts supported wording variants for the TypeScript hook decision", () => {
    const benchmarkCase = mustCase("superseded-decision-typescript-hook");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Superseded the fallback plan and removed the Python hook; only the TypeScript Codex Capture Hook would be supported."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(false);
    expect(
      score.details.find(
        (detail) => detail.name === "field:typescript-supported"
      )
    ).toMatchObject({
      score: 2
    });
  });

  it("treats default field placement misses as weighted non-critical scoring", () => {
    const benchmarkCase = mustCase("long-tool-output-one-durable-fact");
    const output = passingOutput(benchmarkCase);
    output.summary_text =
      "Migration smoke tool output recorded the durable finding that migration 0012_memory_nodes_backfill is the first migration in the MVP branch that requires a fresh local reset.";
    output.decisions = [
      "Treat migration 0012_memory_nodes_backfill as the first MVP-branch migration requiring a fresh local reset."
    ];
    output.facts = [
      "A migration smoke check ran against tables 001 through 008 and each was reported ok.",
      "The finding was tied to the MVP branch."
    ];
    output.tool_outcomes = [
      "Smoke output surfaced the durable finding about migration 0012_memory_nodes_backfill requiring a fresh local reset."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find((detail) => detail.name === "field:migration-reset")
    ).toMatchObject({
      score: 0,
      critical: false
    });
    expect(score.scoreRatio).toBeLessThan(1);
    expect(score.criticalFailure).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("fails field placement critically when fieldCritical is set", () => {
    const benchmarkCase = mustCase("unresolved-team-memory-question");
    const output = passingOutput(benchmarkCase);
    output.facts = [
      "Team memory visibility in Memory Answer by default remains unresolved.",
      "Search Domain, Retrieval Scope, and team memory interaction remains unresolved."
    ];
    output.unresolved_questions = [
      "There are unresolved future team memory implementation questions."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "field:team-memory-undecided"
      )
    ).toMatchObject({
      score: 0,
      critical: true
    });
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("summarizes strict aggregate pass state", () => {
    const firstCase = mustCase("accepted-decision-ai-client-synthesis");
    const first = scoreLcmSummaryRun(firstCase, {
      caseId: firstCase.id,
      runIndex: 0,
      output: passingOutput(firstCase)
    });
    const second = scoreLcmSummaryRun(firstCase, {
      caseId: firstCase.id,
      runIndex: 1,
      output: "not json"
    });

    const summary = summarizeLcmSummaryBenchmark([first, second]);
    expect(summary.validJsonRate).toBe(0.5);
    expect(summary.criticalFailureCount).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it("weights non-critical forbidden claims below critical forbidden claims", () => {
    const benchmarkCase = mustCase("long-tool-output-one-durable-fact");
    const output = passingOutput(benchmarkCase);
    output.facts.push("checking table 001 ok");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:all-tables-important"
      )
    ).toMatchObject({
      score: 0,
      maxScore: 2,
      critical: false
    });
  });

  it("allows scoped forbidden claims as superseded context outside active fields", () => {
    const benchmarkCase = mustCase("rollup-conflict-latest-wins");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Diagnostic low-level memory tools stay hidden unless explicitly enabled; the earlier claim that they should be enabled by default for all users is superseded."
    ];
    output.facts.push(
      "An earlier child summary said diagnostic low-level memory tools should be enabled by default for all users."
    );

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:diagnostic-default"
      )
    ).toMatchObject({
      score: 6
    });
    expect(score.criticalFailure).toBe(false);
  });

  it("allows forbidden claims when superseded context is separated by a colon", () => {
    const benchmarkCase = mustCase("rollup-conflict-latest-wins");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Diagnostic low-level memory tools stay hidden unless explicitly enabled.",
      "Superseded earlier: enabled by default for all users."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:diagnostic-default"
      )
    ).toMatchObject({
      score: 6
    });
    expect(score.criticalFailure).toBe(false);
  });

  it("does not let unrelated allowed context suppress active forbidden claims", () => {
    const benchmarkCase = mustCase("rollup-conflict-latest-wins");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Diagnostic low-level memory tools stay hidden unless explicitly enabled.",
      "Diagnostic low-level memory tools are enabled by default for all users.",
      "An earlier unrelated child summary was superseded."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:diagnostic-default"
      )
    ).toMatchObject({
      score: 0,
      critical: true
    });
    expect(score.criticalFailure).toBe(true);
  });

  it("does not let allowed context in one clause suppress a later active forbidden claim", () => {
    const benchmarkCase = mustCase("rollup-conflict-latest-wins");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Earlier child summary was superseded, but diagnostic low-level memory tools are enabled by default for all users."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:diagnostic-default"
      )
    ).toMatchObject({
      score: 0,
      critical: true
    });
    expect(score.criticalFailure).toBe(true);
  });

  it("does not treat unresolved team-memory visibility as a forbidden decision", () => {
    const benchmarkCase = mustCase("unresolved-team-memory-question");
    const output = passingOutput(benchmarkCase);
    output.facts = [
      "The team had not decided whether team memory is visible in Memory Answer by default.",
      "There is a future implementation dependency involving team memory, Search Domain, and Retrieval Scope."
    ];
    output.unresolved_questions = [
      "Should team memory be visible in Memory Answer by default?",
      "How should Search Domain and Retrieval Scope interact with future team memory?"
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:team-memory-decided"
      )
    ).toMatchObject({
      score: 6
    });
    expect(score.criticalFailure).toBe(false);
  });

  it("accepts provenance trace rationale in user requests", () => {
    const benchmarkCase = mustCase("provenance-source-anchor");
    const output = passingOutput(benchmarkCase);
    output.summary_text =
      "The user asked to keep source anchors so that expansion can trace the claim back to source:memory_events:00000000-0000-4000-8000-000000300001.";
    output.user_requests = [
      "Keep source anchors because expand needs source:memory_events:00000000-0000-4000-8000-000000300001 to trace the claim."
    ];
    output.facts = [
      "The referenced source anchor is source:memory_events:00000000-0000-4000-8000-000000300001."
    ];
    output.provenance_hints = [
      "source:memory_events:00000000-0000-4000-8000-000000300001"
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "field:expand-needs-anchor"
      )
    ).toMatchObject({
      score: 2
    });
    expect(score.criticalFailure).toBe(false);
  });
});
