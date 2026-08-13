import { describe, expect, it } from "vitest";
import { resolveExperienceReplayConfig } from "./config.js";

const hash = "a".repeat(64);
const worker = {
  model: { id: "gpt-5.6-luna", reasoning_effort: "low" as const },
  prompt_version: "prompt-v1",
  output_schema_version: "schema-v1"
};
const trajectoryJudge = {
  model: { id: "gpt-5.6-luna", reasoning_effort: "medium" as const },
  prompt_version: "experience-replay-trajectory-judge-v1" as const,
  output_schema_version: "experience-replay-trajectory-judge-v1" as const
};
const base = {
  version: 1 as const,
  profile: "quick" as const,
  seed: "experiment",
  output_dir: "/tmp/run-a",
  codex_cli: {
    version: "1.2.3",
    host_sha256: hash,
    container_sha256: hash,
    container_code_mode_host_sha256: hash
  },
  coding_agent: worker.model,
  memory_answer: worker,
  lcm_summary: worker,
  session_title: worker,
  trajectory_judge: trajectoryJudge,
  embedding: {
    model: "qwen3-0.6b",
    artifact_sha256: hash,
    tokenizer: "qwen3-tokenizer-v1",
    transform: "none-v1",
    dimensions: 1024
  },
  price_table: {
    version: "prices-2026-08-12",
    sha256: hash,
    models: {
      "gpt-5.6-luna": {
        uncached_input_usd_per_million: 1,
        cached_input_usd_per_million: 0.1,
        output_usd_per_million: 4
      }
    }
  },
  timeouts: {
    agent_seconds: 600,
    setup_seconds: 300,
    verifier_seconds: 300,
    preparation_seconds: 300,
    judge_seconds: 300,
    teardown_seconds: 60
  },
  admission: {
    maximum_trajectory_bytes: 1024,
    estimated_attempt_artifact_bytes: 1024,
    estimated_image_bytes_per_task: 1024,
    scratch_multiplier: 2,
    minimum_free_space_reserve_bytes: 1024,
    max_input_tokens_per_call: 1000,
    max_output_tokens_per_call: 1000,
    max_memory_answer_calls_per_attempt: 2,
    max_preparation_calls_per_source: 2,
    provider_spending_limit_usd: 10.03
  },
  paid_cost_stop_usd: 10
};

describe("recorded Experience Replay policy", () => {
  it("pins low-cost models, workers, embedding identity, prices and cost overshoot", () => {
    const resolved = resolveExperienceReplayConfig(base);
    expect(resolved.maximum_top_level_attempt_cost_usd).toBeCloseTo(0.025);
    expect(resolved.maximum_judge_call_cost_usd).toBeCloseTo(0.005);
    expect(resolved.maximum_concurrent_overshoot_usd).toBeCloseTo(0.03);
    expect(
      resolveExperienceReplayConfig({
        ...base,
        output_dir: "/tmp/run-b"
      }).semantic_config_hash
    ).toBe(resolved.semantic_config_hash);
  });

  it("rejects mutable identities, model drift, incomplete prices and unsafe provider caps", () => {
    expect(() =>
      resolveExperienceReplayConfig({
        ...base,
        embedding: { ...base.embedding, model: "latest" }
      })
    ).toThrow("latest");
    expect(() =>
      resolveExperienceReplayConfig({
        ...base,
        coding_agent: { id: "gpt-5.6-sol", reasoning_effort: "low" }
      })
    ).toThrow("gpt-5.6-luna");
    expect(() =>
      resolveExperienceReplayConfig({
        ...base,
        trajectory_judge: {
          ...base.trajectory_judge,
          prompt_version: "trajectory-judge-v2"
        }
      })
    ).toThrow("experience-replay-trajectory-judge-v1");
    expect(() =>
      resolveExperienceReplayConfig({
        ...base,
        trajectory_judge: {
          ...base.trajectory_judge,
          model: { id: "gpt-5.6-luna", reasoning_effort: "low" }
        }
      })
    ).toThrow("medium reasoning");
    expect(() =>
      resolveExperienceReplayConfig({
        ...base,
        profile: "full",
        concurrency: 1,
        trajectory_judge: {
          ...base.trajectory_judge,
          model: { id: "gpt-5.6-sol", reasoning_effort: "high" }
        }
      })
    ).toThrow("missing price for gpt-5.6-sol");
    expect(() =>
      resolveExperienceReplayConfig({
        ...base,
        admission: { ...base.admission, provider_spending_limit_usd: 11 }
      })
    ).toThrow("provider_spending_limit_usd");
  });
});
