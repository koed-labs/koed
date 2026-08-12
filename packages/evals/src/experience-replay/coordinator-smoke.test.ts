import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExperienceReplayConfig } from "./core/index.js";
import {
  reportExistingSmokeRun,
  runSmokeExperienceReplay,
  sanitizeRunReport
} from "./coordinator.js";

describe("deterministic no-paid smoke coordinator", () => {
  it("runs sanitizer, matching, scheduling, outcomes and disclosure report without claiming product integration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const output = path.join(root, "run");
    const config = resolveExperienceReplayConfig({
      version: 1,
      profile: "smoke",
      seed: "smoke-test-seed",
      output_dir: output,
      codex_cli: {
        version: "deterministic-fake",
        host_sha256: "a".repeat(64),
        container_sha256: "a".repeat(64)
      },
      coding_agent: { id: "deterministic-fake", reasoning_effort: "low" },
      memory_answer: {
        model: { id: "deterministic-fake", reasoning_effort: "low" },
        prompt_version: "deterministic-v1",
        output_schema_version: "deterministic-v1"
      },
      lcm_summary: {
        model: { id: "deterministic-fake", reasoning_effort: "low" },
        prompt_version: "deterministic-v1",
        output_schema_version: "deterministic-v1"
      },
      session_title: {
        model: { id: "deterministic-fake", reasoning_effort: "low" },
        prompt_version: "deterministic-v1",
        output_schema_version: "deterministic-v1"
      },
      embedding: {
        model: "deterministic-local-v1",
        artifact_sha256: "b".repeat(64),
        tokenizer: "whitespace-v1",
        transform: "none-v1",
        dimensions: 4
      },
      price_table: {
        version: "deterministic-v1",
        sha256: "c".repeat(64),
        models: {}
      },
      timeouts: {
        agent_seconds: 60,
        setup_seconds: 30,
        verifier_seconds: 30,
        preparation_seconds: 30,
        teardown_seconds: 10
      },
      admission: {
        maximum_trajectory_bytes: 1024 * 1024,
        estimated_attempt_artifact_bytes: 1024 * 1024,
        estimated_image_bytes_per_task: 0,
        scratch_multiplier: 1,
        minimum_free_space_reserve_bytes: 0,
        max_input_tokens_per_call: 1,
        max_output_tokens_per_call: 1,
        max_memory_answer_calls_per_attempt: 1,
        max_preparation_calls_per_source: 1
      }
    });
    const result = await runSmokeExperienceReplay(config);
    expect(result).toMatchObject({
      replayAttemptCount: 8,
      productPathExercised: false
    });
    const manifest = JSON.parse(
      await readFile(path.join(output, "manifest.json"), "utf8")
    ) as {
      execution_boundary: {
        product_path_exercised: boolean;
        terminal_bench_estimate: boolean;
      };
    };
    expect(manifest.execution_boundary).toMatchObject({
      product_path_exercised: false,
      terminal_bench_estimate: false
    });
    const schedule = JSON.parse(
      await readFile(path.join(output, "schedule.json"), "utf8")
    ) as {
      entries: { conditions: string[] }[];
    };
    expect(schedule.entries).toHaveLength(2);
    expect(schedule.entries.flatMap((entry) => entry.conditions)).toHaveLength(
      8
    );
    const markdown = await readFile(
      path.join(output, "report/summary.md"),
      "utf8"
    );
    expect(
      markdown.startsWith(
        "This is not a standard Terminal-Bench leaderboard evaluation."
      )
    ).toBe(true);
    expect(markdown).toContain(
      "Synthetic orchestration check; no Terminal-Bench estimate."
    );

    await expect(reportExistingSmokeRun(output)).resolves.toContain(
      "summary.md"
    );
    const publication = await sanitizeRunReport(output);
    expect(publication).not.toBe(output);
    await expect(
      readFile(path.join(publication, "summary.json"), "utf8")
    ).resolves.toContain('"standard_leaderboard_comparable": false');
  }, 30_000);
});
