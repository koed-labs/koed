import { describe, expect, it } from "vitest";
import { resolveExperienceReplayConfig } from "./core/index.js";
import { createCliExperienceReplayDependencies } from "./runtime-options.js";

const config = resolveExperienceReplayConfig({
  version: 1,
  profile: "smoke",
  seed: "runtime-options",
  output_dir: "/tmp/runtime-options",
  codex_cli: {
    version: "deterministic",
    host_sha256: "a".repeat(64),
    container_sha256: "a".repeat(64)
  },
  coding_agent: { id: "deterministic", reasoning_effort: "low" },
  memory_answer: {
    model: { id: "deterministic", reasoning_effort: "low" },
    prompt_version: "v1",
    output_schema_version: "v1"
  },
  lcm_summary: {
    model: { id: "deterministic", reasoning_effort: "low" },
    prompt_version: "v1",
    output_schema_version: "v1"
  },
  session_title: {
    model: { id: "deterministic", reasoning_effort: "low" },
    prompt_version: "v1",
    output_schema_version: "v1"
  },
  embedding: {
    model: "qwen3-0.6b",
    artifact_sha256: "b".repeat(64),
    tokenizer: "qwen3",
    transform: "query-document-v1",
    dimensions: 1024
  },
  price_table: { version: "v1", sha256: "c".repeat(64), models: {} },
  timeouts: {
    agent_seconds: 1,
    setup_seconds: 1,
    verifier_seconds: 1,
    preparation_seconds: 1,
    teardown_seconds: 1
  },
  admission: {
    maximum_trajectory_bytes: 1,
    estimated_attempt_artifact_bytes: 1,
    estimated_image_bytes_per_task: 0,
    scratch_multiplier: 1,
    minimum_free_space_reserve_bytes: 0,
    max_input_tokens_per_call: 1,
    max_output_tokens_per_call: 1,
    max_memory_answer_calls_per_attempt: 1,
    max_preparation_calls_per_source: 1
  }
});

describe("Experience Replay CLI runtime options", () => {
  it("fails closed when PostgreSQL credentials are absent", () => {
    expect(() => createCliExperienceReplayDependencies(config, {})).toThrow(
      "KOED_EXPERIENCE_REPLAY_POSTGRES_ADMIN_URL is required"
    );
  });

  it("keeps credentials out of the PostgreSQL admin URL", () => {
    expect(() =>
      createCliExperienceReplayDependencies(config, {
        KOED_EXPERIENCE_REPLAY_POSTGRES_ADMIN_URL:
          "postgresql://user:secret@127.0.0.1:5432/postgres",
        KOED_EXPERIENCE_REPLAY_POSTGRES_USER: "user",
        KOED_EXPERIENCE_REPLAY_POSTGRES_PASSWORD: "secret"
      })
    ).toThrow("must not contain credentials");
  });
});
