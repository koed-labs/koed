import { describe, expect, it } from "vitest";
import { resolveExperienceReplayConfig } from "./config.js";
import {
  createBenchmarkRunPlan,
  createProductPathProofRunPlan,
  verifyExperienceReplayRunPlan
} from "./execution-plan.js";

const config = (profile: "smoke" | "quick" = "quick") =>
  resolveExperienceReplayConfig({
    version: 1,
    profile,
    seed: "plan-test",
    output_dir: "/tmp/experience-replay-plan-test",
    codex_cli: {
      version: "test-v1",
      host_sha256: "a".repeat(64),
      container_sha256: "b".repeat(64),
      container_code_mode_host_sha256: "c".repeat(64)
    },
    coding_agent: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    memory_answer: {
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
      prompt_version: "test-v1",
      output_schema_version: "test-v1"
    },
    lcm_summary: {
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
      prompt_version: "test-v1",
      output_schema_version: "test-v1"
    },
    session_title: {
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
      prompt_version: "test-v1",
      output_schema_version: "test-v1"
    },
    trajectory_judge: {
      model: {
        id: profile === "smoke" ? "deterministic-smoke" : "gpt-5.6-luna",
        reasoning_effort: profile === "smoke" ? "low" : "medium"
      },
      prompt_version: "experience-replay-trajectory-judge-v1",
      output_schema_version: "experience-replay-trajectory-judge-v1"
    },
    embedding: {
      model: "qwen3-0.6b",
      artifact_sha256: "c".repeat(64),
      tokenizer: "qwen3",
      transform: "query-document-v1",
      dimensions: 1024
    },
    price_table: {
      version: "test-v1",
      sha256: "d".repeat(64),
      models: {
        "gpt-5.6-luna": {
          uncached_input_usd_per_million: 0,
          cached_input_usd_per_million: 0,
          output_usd_per_million: 0
        }
      }
    },
    timeouts: {
      agent_seconds: 1,
      setup_seconds: 1,
      verifier_seconds: 1,
      preparation_seconds: 1,
      judge_seconds: 1,
      teardown_seconds: 1
    },
    admission: {
      maximum_trajectory_bytes: 1,
      estimated_attempt_artifact_bytes: 1,
      estimated_image_bytes_per_task: 1,
      scratch_multiplier: 1,
      minimum_free_space_reserve_bytes: 0,
      max_input_tokens_per_call: 1,
      max_output_tokens_per_call: 1,
      max_memory_answer_calls_per_attempt: 1,
      max_preparation_calls_per_source: 1,
      ...(profile === "quick" ? { provider_spending_limit_usd: 1 } : {})
    },
    ...(profile === "quick" ? { paid_cost_stop_usd: 1 } : {}),
    concurrency: 1
  });

describe("Experience Replay immutable run plans", () => {
  it("preserves the normal profile task and attempt contract", () => {
    const resolved = config();
    const tasks = Array.from(
      { length: resolved.task_count },
      (_, index) => `sha256:${String(index).padStart(64, "0")}`
    );
    const plan = createBenchmarkRunPlan(resolved, tasks);
    expect(plan).toMatchObject({
      kind: "benchmark_profile",
      sourceTaskDigests: tasks,
      replayTargetTaskDigests: tasks,
      replayAttemptsPerCondition: 1,
      codingAgentAttemptCount: 60,
      terminalBenchEstimate: true
    });
    expect(() => verifyExperienceReplayRunPlan(plan)).not.toThrow();
  });

  it("locks the paid proof to two sources, one target, four arms and six attempts", () => {
    const plan = createProductPathProofRunPlan(
      config(),
      {
        targetTaskDigest: `sha256:${"a".repeat(64)}`,
        donorTaskDigest: `sha256:${"b".repeat(64)}`
      },
      "subscription"
    );
    expect(plan).toMatchObject({
      kind: "product_path_proof",
      codexAuthMode: "subscription",
      replayTargetTaskDigests: [`sha256:${"a".repeat(64)}`],
      replayAttemptsPerCondition: 1,
      codingAgentAttemptCount: 6,
      terminalBenchEstimate: false
    });
    expect(() => verifyExperienceReplayRunPlan(plan)).not.toThrow();
  });

  it("rejects self-placebo, the wrong profile, non-Luna policy and mutation", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(() =>
      createProductPathProofRunPlan(config(), {
        targetTaskDigest: digest,
        donorTaskDigest: digest
      })
    ).toThrow("unique");
    expect(() =>
      createProductPathProofRunPlan(config("smoke"), {
        targetTaskDigest: digest,
        donorTaskDigest: `sha256:${"b".repeat(64)}`
      })
    ).toThrow("quick model policy");
    expect(() =>
      createProductPathProofRunPlan(
        {
          ...config(),
          coding_agent: { id: "gpt-5.6-sol", reasoning_effort: "low" }
        },
        {
          targetTaskDigest: digest,
          donorTaskDigest: `sha256:${"b".repeat(64)}`
        }
      )
    ).toThrow("GPT-5.6 Luna");
    const valid = createProductPathProofRunPlan(config(), {
      targetTaskDigest: digest,
      donorTaskDigest: `sha256:${"b".repeat(64)}`
    });
    expect(() =>
      verifyExperienceReplayRunPlan({
        ...valid,
        codingAgentAttemptCount: 10
      })
    ).toThrow("hash mismatch");
    expect(() =>
      verifyExperienceReplayRunPlan({
        ...valid,
        codexAuthMode: "invalid" as "api_key"
      })
    ).toThrow("hash mismatch");
  });
});
