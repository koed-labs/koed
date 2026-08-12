import { describe, expect, it } from "vitest";
import {
  PROFILE_POLICY,
  parseExperienceReplayConfig,
  resolveExperienceReplayConfig
} from "./config.js";
import { canonicalJson, immutableHash } from "./hash.js";
import {
  CONDITIONS,
  WILLIAMS_ROWS,
  createReplaySchedule,
  verifyReplaySchedule
} from "./schedule.js";

const hash = "a".repeat(64);
const worker = {
  model: { id: "gpt-5.6-luna", reasoning_effort: "low" as const },
  prompt_version: "prompt-v1",
  output_schema_version: "schema-v1"
};
const config = {
  version: 1,
  profile: "quick",
  seed: "run-7",
  output_dir: "/tmp/experience-replay",
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
  embedding: {
    model: "qwen3-0.6b",
    artifact_sha256: hash,
    tokenizer: "qwen3-tokenizer-v1",
    transform: "none-v1",
    dimensions: 1024
  },
  price_table: {
    version: "prices-v1",
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
    provider_spending_limit_usd: 25.025
  },
  paid_cost_stop_usd: 25
} as const;

describe("versioned experience replay config", () => {
  it("parses only the current strict schema", () => {
    expect(parseExperienceReplayConfig(config).profile).toBe("quick");
    expect(() =>
      parseExperienceReplayConfig({ ...config, version: 2 })
    ).toThrow();
    expect(() =>
      parseExperienceReplayConfig({ ...config, surprise: true })
    ).toThrow();
    expect(() =>
      parseExperienceReplayConfig({
        ...config,
        coding_agent: { ...config.coding_agent, fallback: "other" }
      })
    ).toThrow();
  });

  it("enforces paid-run and profile concurrency policy", () => {
    expect(() =>
      parseExperienceReplayConfig({ ...config, paid_cost_stop_usd: undefined })
    ).toThrow("paid_cost_stop_usd");
    expect(() =>
      parseExperienceReplayConfig({ ...config, concurrency: 2 })
    ).toThrow("quick requires concurrency 1");
    expect(() =>
      parseExperienceReplayConfig({ ...config, profile: "full" })
    ).toThrow("full requires explicit concurrency");
  });

  it("resolves immutable profile attempt counts and a stable semantic hash", () => {
    expect(PROFILE_POLICY).toEqual({
      smoke: {
        taskCount: 2,
        replayAttemptsPerCondition: 1,
        codingAgentAttempts: 10
      },
      quick: {
        taskCount: 12,
        replayAttemptsPerCondition: 1,
        codingAgentAttempts: 60
      },
      standard: {
        taskCount: 24,
        replayAttemptsPerCondition: 2,
        codingAgentAttempts: 216
      },
      full: {
        taskCount: 74,
        replayAttemptsPerCondition: 3,
        codingAgentAttempts: 962
      }
    });
    const first = resolveExperienceReplayConfig(config);
    const second = resolveExperienceReplayConfig(
      JSON.parse(JSON.stringify(config))
    );
    expect(first.coding_agent_attempt_count).toBe(60);
    expect(first.replay_attempts_per_condition).toBe(1);
    expect(first.semantic_config_hash).toBe(second.semantic_config_hash);
    expect(
      resolveExperienceReplayConfig({
        ...config,
        output_dir: "/another/ephemeral/run/path"
      }).semantic_config_hash
    ).toBe(first.semantic_config_hash);
    expect(
      resolveExperienceReplayConfig({
        ...config,
        seed: "different-experiment"
      }).semantic_config_hash
    ).not.toBe(first.semantic_config_hash);
  });
});

describe("canonical hashing and Williams schedule", () => {
  it("hashes object keys canonically and rejects non-JSON values", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"d":2},"z":1}'
    );
    expect(immutableHash({ a: 1, b: 2 })).toBe(immutableHash({ b: 2, a: 1 }));
    expect(() => immutableHash({ value: Number.NaN })).toThrow("non-finite");
    expect(() => immutableHash({ value: undefined })).toThrow("undefined");
  });

  it("uses the required rows and balances rows over complete task-repeat units", () => {
    expect(WILLIAMS_ROWS).toEqual(["ABDC", "BCAD", "CDBA", "DACB"]);
    const schedule = createReplaySchedule(["t1", "t2", "t3", "t4"], 2, "seed");
    verifyReplaySchedule(schedule);
    expect(schedule.entries).toHaveLength(8);
    const counts = Object.fromEntries(
      WILLIAMS_ROWS.map((row) => [
        row,
        schedule.entries.filter((entry) => entry.sequenceRow === row).length
      ])
    );
    expect(Object.values(counts)).toEqual([2, 2, 2, 2]);
    for (const entry of schedule.entries)
      expect(new Set(entry.conditions)).toEqual(new Set(CONDITIONS));
    expect(createReplaySchedule(["t1", "t2", "t3", "t4"], 2, "seed")).toEqual(
      schedule
    );
    expect(Object.isFrozen(schedule.entries)).toBe(true);
  });

  it("detects schedule changes on resume", () => {
    const schedule = createReplaySchedule(["t1", "t2"], 1, "seed");
    const changed = structuredClone(schedule);
    (changed.entries[0] as { repeat: number }).repeat = 9;
    expect(() => verifyReplaySchedule(changed)).toThrow("hash mismatch");
  });

  it("rejects schedule tampering even when its sibling hash is recomputed", () => {
    const frozenInputs = {
      taskDigests: ["t1", "t2"],
      repeats: 1,
      seed: "seed"
    } as const;
    const changed = structuredClone(
      createReplaySchedule(
        frozenInputs.taskDigests,
        frozenInputs.repeats,
        frozenInputs.seed
      )
    );
    (changed.entries[0] as { repeat: number }).repeat = 9;
    (changed as { scheduleHash: string }).scheduleHash = immutableHash({
      version: changed.version,
      seed: changed.seed,
      letterAssignment: changed.letterAssignment,
      entries: changed.entries
    });

    expect(() => verifyReplaySchedule(changed)).not.toThrow();
    expect(() => verifyReplaySchedule(changed, frozenInputs)).toThrow(
      "does not match frozen run inputs"
    );
  });
});
