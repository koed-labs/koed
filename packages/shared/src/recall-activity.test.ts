import { describe, expect, it } from "vitest";
import {
  RECALL_CALLER_LABEL_CHARACTERS,
  recallCallerLabel,
  recallCallerSchema,
  recallActivityOverviewSchema,
  recallQuestionMetadataSchema,
  recallQuestionReportedMetadataSchema
} from "./recall-activity.js";

it("decodes old and new overview responses without retaining the retired timeline", () => {
  const overview = {
    asOf: "2026-11-16T12:00:00Z",
    timezone: "UTC",
    bucket: "day",
    tokens: {
      coverage: "recorded",
      inputTokens: 20,
      cachedInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 30,
      recordedAttempts: 1,
      includesEstimates: false
    },
    linkedQuestions: 1,
    recordedQuestions: 1,
    recordedErrors: 0,
    memoryResults: {
      found: 1,
      not_found: 0,
      insufficient: 0,
      pending_summary: 0,
      unknown: 0,
      foundPercentage: 100
    },
    knownDurations: 0,
    medianDurationMs: null,
    questions: []
  };
  expect(
    recallActivityOverviewSchema.parse({
      ...overview,
      tokenTimeline: [
        {
          start: overview.asOf,
          totalTokens: 30,
          recordedAttempts: 1,
          partial: false
        }
      ]
    })
  ).toEqual(overview);
  for (const projectScopeStatus of ["complete", "updating", "unavailable"])
    expect(
      recallActivityOverviewSchema.parse({ ...overview, projectScopeStatus })
    ).toEqual({ ...overview, projectScopeStatus });
  expect(
    recallActivityOverviewSchema.safeParse({
      ...overview,
      projectScopeStatus: "ready"
    }).success
  ).toBe(false);
  expect(
    recallActivityOverviewSchema.safeParse({ ...overview, unexpected: true })
      .success
  ).toBe(false);
});

describe("Recall caller labels", () => {
  it("keeps ordinary AI Client names and versions", () => {
    for (const label of [
      "claude-code",
      "Visual Studio Code",
      "@modelcontextprotocol/inspector (dev)",
      "1.2.3-beta+build.5"
    ]) {
      expect(recallCallerLabel(label, 128)).toBe(label);
      expect(
        recallCallerSchema.safeParse({ name: label, version: null }).success
      ).toBe(true);
    }
  });

  it("reduces other reported text to a storable label", () => {
    const label = recallCallerLabel(
      "  evil\n<script>name</script>\u0000: \u202Edrow  ",
      128
    );
    expect(label).toBe("evil script name /script drow");
    expect(
      recallCallerSchema.safeParse({ name: label, version: label }).success
    ).toBe(true);
    expect(recallCallerLabel("x".repeat(200), 64)).toHaveLength(64);
    // Labels are ASCII so the database can apply the identical test.
    expect(recallCallerLabel("Zed \u7de8\u96c6 2", 128)).toBe("Zed 2");
    expect(
      recallCallerSchema.safeParse({ name: "caf\u00e9", version: null }).success
    ).toBe(false);
  });

  it("builds its pattern from the shared character list", () => {
    for (const character of RECALL_CALLER_LABEL_CHARACTERS.replace(" ", ""))
      expect(
        recallCallerSchema.safeParse({ name: character, version: character })
          .success,
        character
      ).toBe(true);
    for (const character of "\\]^[\"'`,:;<>&%$#!?*=~|{}\t\n")
      expect(
        recallCallerSchema.safeParse({ name: `a${character}b`, version: null })
          .success,
        character
      ).toBe(false);
  });

  it("reports no label when nothing storable remains", () => {
    for (const value of ["", "   ", "<>:;\n", undefined, 7, { name: "x" }])
      expect(recallCallerLabel(value, 128)).toBeNull();
  });

  it("rejects unsanitized caller text at the storage boundary", () => {
    for (const name of ["line\nbreak", "key: value", "<b>", "tab\there"])
      expect(
        recallCallerSchema.safeParse({ name, version: null }).success
      ).toBe(false);
    expect(
      recallCallerSchema.safeParse({ name: "codex", version: "1;drop" }).success
    ).toBe(false);
  });
});

it("accepts bounded usage expectations and reserves task run counts for the server", () => {
  const value = {
    version: 1,
    memoryStatus: null,
    usage: { jobId: "33333333-3333-4333-8333-333333333333", attempts: 2 }
  };
  expect(recallQuestionReportedMetadataSchema.safeParse(value).success).toBe(
    true
  );
  const server = { ...value, usage: { ...value.usage, taskAttempts: 2 } };
  expect(recallQuestionMetadataSchema.safeParse(server).success).toBe(true);
  expect(recallQuestionReportedMetadataSchema.safeParse(server).success).toBe(
    false
  );
  expect(
    recallQuestionReportedMetadataSchema.safeParse({
      ...value,
      usage: { ...value.usage, jobId: "arbitrary question text" }
    }).success
  ).toBe(false);
});

it("bounds runtime diagnostics and keeps missing measurements distinct from zero", async () => {
  const { recallExecutionSchema } = await import("./recall-execution.js");
  const operation = {
    kind: "expand",
    attempt: 1,
    delivered: 0,
    omitted: null,
    reasons: [],
    recovered: false,
    failed: false
  };
  const valid = {
    version: 1,
    budgets: null,
    delivery: { operations: [operation], truncated: false, finalSelected: null }
  };
  expect(
    recallExecutionSchema.parse(valid).delivery?.operations[0]
  ).toMatchObject({ delivered: 0, omitted: null });
  expect(
    recallExecutionSchema.safeParse({
      ...valid,
      delivery: { ...valid.delivery, operations: Array(101).fill(operation) }
    }).success
  ).toBe(false);
  for (const change of [
    { delivered: -1 },
    { omitted: Infinity },
    { reasons: ["guessed"] },
    { sourceBody: "private" }
  ]) {
    expect(
      recallExecutionSchema.safeParse({
        ...valid,
        delivery: {
          ...valid.delivery,
          operations: [{ ...operation, ...change }]
        }
      }).success
    ).toBe(false);
  }
});
