import { describe, expect, it } from "vitest";
import {
  documentDefault,
  environmentDefaultFor
} from "./local-ai-client-defaults.js";

const base = documentDefault({
  provider: "codex",
  ai_client_instance_id: "codex.default",
  model: "gpt-5.6-luna",
  reasoning_effort: "low",
  timeout_ms: 120_000,
  max_attempts: 2
});

const defaults = (
  environment: NodeJS.ProcessEnv,
  flowKey: Parameters<typeof environmentDefaultFor>[0]
) => environmentDefaultFor(flowKey, base, environment);

describe("Local AI Client runtime defaults", () => {
  it("uses answer parseInt and clamps both limits", () => {
    expect(
      defaults(
        {
          MEMORY_ANSWER_TIMEOUT_MS: "999999tail",
          MEMORY_ANSWER_MAX_ATTEMPTS: "0tail"
        },
        "mcp_memory_answer"
      ).assignment
    ).toMatchObject({ timeout_ms: 600_000, max_attempts: 1 });
  });

  it("uses LCM parseInt fallback and minimum without upper clamp", () => {
    expect(
      defaults(
        {
          MEMORY_LCM_SUMMARY_TIMEOUT_MS: "700000tail",
          MEMORY_LCM_SUMMARY_MAX_ATTEMPTS: "30tail"
        },
        "lcm_summary"
      )
    ).toMatchObject({
      assignment: { timeout_ms: 700_000, max_attempts: 30 },
      persistable: false,
      reason: expect.stringContaining("persisted assignment limits")
    });
  });

  it("uses Curated Memory minimums and exposes effective partial values", () => {
    expect(
      defaults(
        {
          MEMORY_CURATED_REVIEW_TIMEOUT_MS: "500tail",
          MEMORY_CURATED_REVIEW_MAX_ATTEMPTS: "NaN"
        },
        "curated_memory_review"
      ).assignment
    ).toMatchObject({ timeout_ms: 1_000, max_attempts: 2 });
  });

  it("defaults Claude Curated Memory review to haiku with no reasoning effort", () => {
    expect(
      defaults(
        { MEMORY_CURATED_REVIEW_PROVIDER: "claude" },
        "curated_memory_review"
      ).assignment
    ).toMatchObject({
      provider: "claude",
      model: "haiku",
      reasoning_effort: "none"
    });
  });

  it("keeps an explicit Claude reasoning-effort override instead of forcing none", () => {
    expect(
      defaults(
        {
          MEMORY_CURATED_REVIEW_PROVIDER: "claude",
          MEMORY_CURATED_REVIEW_REASONING_EFFORT: "low"
        },
        "curated_memory_review"
      ).assignment
    ).toMatchObject({
      provider: "claude",
      model: "haiku",
      reasoning_effort: "low"
    });
  });
});
