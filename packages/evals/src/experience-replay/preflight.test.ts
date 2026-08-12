import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveExperienceReplayConfig } from "./core/index.js";
import { freezeTaskImages } from "./image-attestation.js";
import {
  attestPinnedInputs,
  preflightExperienceReplay,
  ProductPathPrerequisiteError
} from "./preflight.js";

const config = (profile: "smoke" | "quick") =>
  resolveExperienceReplayConfig({
    version: 1,
    profile,
    seed: "strict-preflight",
    output_dir: path.join(os.tmpdir(), "koed-preflight-output"),
    codex_cli: {
      version: "pinned-codex",
      host_sha256: "a".repeat(64),
      container_sha256: "a".repeat(64)
    },
    coding_agent: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    memory_answer: {
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
      prompt_version: "memory-answer-v1",
      output_schema_version: "memory-answer-v1"
    },
    lcm_summary: {
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
      prompt_version: "lcm-v1",
      output_schema_version: "lcm-v1"
    },
    session_title: {
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
      prompt_version: "title-v1",
      output_schema_version: "title-v1"
    },
    embedding: {
      model: "qwen3-0.6b",
      artifact_sha256: "b".repeat(64),
      tokenizer: "qwen3-v1",
      transform: "none-v1",
      dimensions: 1024
    },
    price_table: {
      version: "test-prices-v1",
      sha256: "c".repeat(64),
      models: {
        "gpt-5.6-luna": {
          uncached_input_usd_per_million: 0,
          cached_input_usd_per_million: 0,
          output_usd_per_million: 0
        }
      }
    },
    timeouts: {
      agent_seconds: 60,
      setup_seconds: 30,
      verifier_seconds: 30,
      preparation_seconds: 30,
      teardown_seconds: 10
    },
    admission: {
      maximum_trajectory_bytes: 1024,
      estimated_attempt_artifact_bytes: 1024,
      estimated_image_bytes_per_task: 0,
      scratch_multiplier: 1,
      minimum_free_space_reserve_bytes: 0,
      max_input_tokens_per_call: 1,
      max_output_tokens_per_call: 1,
      max_memory_answer_calls_per_attempt: 1,
      max_preparation_calls_per_source: 1,
      ...(profile === "quick" ? { provider_spending_limit_usd: 1 } : {})
    },
    ...(profile === "quick" ? { paid_cost_stop_usd: 1 } : {})
  });

describe("experience replay strict preflight", () => {
  it("attests the committed corpus, subset, Harbor lock, and immutable digests", async () => {
    const pins = await attestPinnedInputs("quick");
    expect(pins.selectedTasks).toHaveLength(12);
    expect(
      pins.selectedTasks.every((task) =>
        /^sha256:[a-f0-9]{64}$/.test(task.task_digest)
      )
    ).toBe(true);
    expect(pins.corpusHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pins.subsetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pins.uvLockHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("admits deterministic smoke but explicitly gates the unwired paid product path", async () => {
    await expect(
      preflightExperienceReplay({ config: config("smoke") })
    ).resolves.toMatchObject({
      recordedModelPathReady: true
    });
    await expect(
      preflightExperienceReplay({
        config: config("quick"),
        confirmPaidRun: true
      })
    ).rejects.toBeInstanceOf(ProductPathPrerequisiteError);
    await expect(
      preflightExperienceReplay({
        config: config("quick"),
        confirmPaidRun: true
      })
    ).rejects.toThrow("Koed worktree must be clean for a recorded run");
  });

  it("requires explicit paid confirmation before invoking recorded-run adapters", async () => {
    const repositoryStatus = vi.fn(async () => "");
    await expect(
      preflightExperienceReplay({
        config: config("quick"),
        recordedRunAdapters: {
          repositoryStatus,
          attestTaskImages: vi.fn(),
          attestHostCodex: vi.fn(),
          attestContainerCodex: vi.fn()
        }
      })
    ).rejects.toThrow("paid run confirmation");
    expect(repositoryStatus).not.toHaveBeenCalled();
  });

  it("keeps smoke local and never invokes paid/network-capable adapters", async () => {
    const repositoryStatus = vi.fn(async () => {
      throw new Error("must not run");
    });
    await expect(
      preflightExperienceReplay({
        config: config("smoke"),
        recordedRunAdapters: {
          repositoryStatus,
          attestTaskImages: vi.fn(),
          attestHostCodex: vi.fn(),
          attestContainerCodex: vi.fn()
        }
      })
    ).resolves.toMatchObject({ recordedRunAttestation: null });
    expect(repositoryStatus).not.toHaveBeenCalled();
  });

  it("rejects dirty worktrees before image or Codex attestation", async () => {
    const attestTaskImages = vi.fn();
    const attestHostCodex = vi.fn();
    const attestContainerCodex = vi.fn();
    await expect(
      preflightExperienceReplay({
        config: config("quick"),
        confirmPaidRun: true,
        requireRunnable: false,
        recordedRunAdapters: {
          repositoryStatus: async () => " M package.json\n",
          attestTaskImages,
          attestHostCodex,
          attestContainerCodex
        }
      })
    ).resolves.toMatchObject({ recordedRunAttestation: null });
    expect(attestTaskImages).not.toHaveBeenCalled();
    expect(attestHostCodex).not.toHaveBeenCalled();
    expect(attestContainerCodex).not.toHaveBeenCalled();
  });

  it("validates exact per-task images and separate auth-context toolchains", async () => {
    const model = {
      id: "gpt-5.6-luna",
      model: "gpt-5.6-luna",
      label: "Luna",
      description: "Pinned",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: []
    };
    const executable = {
      path: "/pinned/codex",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      version: "pinned-codex",
      versionOutput: "pinned-codex"
    };
    const result = await preflightExperienceReplay({
      config: config("quick"),
      confirmPaidRun: true,
      requireRunnable: false,
      recordedRunAdapters: {
        repositoryStatus: async () => "",
        attestTaskImages: async (tasks) =>
          freezeTaskImages(
            tasks.map((task) => ({
              taskName: task.name,
              taskDigest: task.task_digest
            })),
            async (task) => ({
              immutableReference: `registry.example/${task.taskName}@sha256:${"d".repeat(64)}`,
              imageId: `sha256:${"e".repeat(64)}`,
              contentDigest: `sha256:${"d".repeat(64)}`,
              resolvedBaseImageDigests: [`sha256:${"f".repeat(64)}`],
              dockerfileSha256: `sha256:${"1".repeat(64)}`,
              dockerVersion: "Docker 29",
              buildkitVersion: "BuildKit 0.24",
              provenanceSha256: null
            })
          ),
        attestHostCodex: async () => ({ executable, models: [model] }),
        attestContainerCodex: async () => ({ executable, models: [model] })
      }
    });
    expect(result.recordedRunAttestation?.taskImages).toHaveLength(12);
  });
});
