import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveExperienceReplayConfig } from "./core/index.js";
import type { HarborFreezeManifest } from "./atif/index.js";
import {
  reportExistingRun,
  runExperienceReplay,
  sanitizeRunReport,
  type ExperienceReplayCoordinatorDependencies,
  type ProductPathAttestation
} from "./coordinator.js";
import { preflightExperienceReplay } from "./preflight.js";

const productAttestation: ProductPathAttestation = {
  canonicalNormalizedImport: true,
  projection: true,
  semanticReadiness: true,
  databaseTemplate: true,
  postgres: true,
  redis: true,
  mcpBridge: true,
  localAiRuntime: true
};

const trajectory = (taskName: string): string =>
  JSON.stringify({
    schema_version: "ATIF-v1.7",
    session_id: `source-${taskName}`,
    agent: { name: "codex", version: "deterministic-fake-1" },
    steps: [
      {
        step_id: 1,
        timestamp: "2026-08-12T00:00:00.000Z",
        source: "user",
        message: `Instruction for ${taskName}`
      },
      {
        step_id: 2,
        timestamp: "2026-08-12T00:00:01.000Z",
        source: "agent",
        message: `Prior experience for ${taskName}`
      }
    ]
  });

const freezeManifest = (
  taskName: string,
  frozen: string
): HarborFreezeManifest => ({
  schema_version: "koed-harbor-freeze-v1",
  adapter: {
    name: "harbor-codex",
    version: "0.21.0",
    commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
    raw_reasoning_capture_disabled: true
  },
  source_attempt: {
    trial_id: `source-${taskName}`,
    task_name: `terminal-bench/${taskName}`
  },
  lifecycle: [
    {
      ordinal: 1,
      event: "agent_started",
      timestamp: "2026-08-12T00:00:00.000Z"
    },
    { ordinal: 2, event: "agent_ended", timestamp: "2026-08-12T00:00:02.000Z" },
    {
      ordinal: 3,
      event: "trajectory_materialized",
      timestamp: "2026-08-12T00:00:03.000Z"
    },
    {
      ordinal: 4,
      event: "verification_started",
      timestamp: "2026-08-12T00:00:04.000Z"
    }
  ],
  cutoff: {
    agent_last_native_event_ordinal: 2,
    step_identities: [1, 2].map((ordinal) => ({
      step_id: ordinal,
      identity_sha256: `sha256:${createHash("sha256")
        .update(`${ordinal}:${ordinal}`)
        .digest("hex")}`,
      last_native_event_ordinal: ordinal
    }))
  },
  frozen_artifact: {
    relative_path: `source/${taskName}/frozen-trajectory.json`,
    sha256: `sha256:${createHash("sha256").update(frozen).digest("hex")}`,
    size_bytes: Buffer.byteLength(frozen),
    file_identity: { device: 1, inode: 1 }
  }
});

const smokeConfig = (output: string) =>
  resolveExperienceReplayConfig({
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
      estimated_attempt_artifact_bytes: 1024,
      estimated_image_bytes_per_task: 0,
      scratch_multiplier: 1,
      minimum_free_space_reserve_bytes: 0,
      max_input_tokens_per_call: 1,
      max_output_tokens_per_call: 1,
      max_memory_answer_calls_per_attempt: 1,
      max_preparation_calls_per_source: 1
    }
  });

const fakeDependencies = (
  events: string[],
  overrides: Partial<ExperienceReplayCoordinatorDependencies> = {}
): ExperienceReplayCoordinatorDependencies => ({
  countEmbeddingTokens: (text) =>
    text.trim() ? text.trim().split(/\s+/).length : 0,
  async runSource({ task, lifecycle }) {
    events.push(`source:${task.name}`);
    const callbackEvent = {
      schema_version: "koed-harbor-lifecycle-v1" as const,
      attempt_kind: "source" as const,
      event: "agent_started" as const,
      trial_id: `source-${task.name}`,
      task_name: task.name,
      timestamp: new Date(0).toISOString()
    };
    await lifecycle.onAgentStarted?.(callbackEvent);
    await lifecycle.onAgentEnded?.({ ...callbackEvent, event: "agent_ended" });
    await lifecycle.onTrialEnded?.({ ...callbackEvent, event: "trial_ended" });
    const frozen = trajectory(task.name);
    const passed = task.name === "synthetic-alpha";
    return {
      frozenTrajectory: frozen,
      freezeManifest: freezeManifest(task.name, frozen),
      reward: passed ? 1 : 0,
      passed,
      sanitizedTokenQuartile: passed ? 0 : 1,
      result: { verifier: "deterministic-fake" }
    };
  },
  async prepareTemplate({ task, condition, sourceTask, sanitizedSource }) {
    events.push(
      `template:${task.name}:${condition}:${sourceTask?.name ?? "none"}`
    );
    if (condition === "empty") expect(sanitizedSource).toBeNull();
    else expect(sanitizedSource?.normalizedItems.length).toBeGreaterThan(0);
    return {
      templateId: `template:${task.taskDigest}:${condition}`,
      sourceStateHash: `state:${sourceTask?.taskDigest ?? "empty"}`,
      attestation: productAttestation
    };
  },
  async createReplay({ task, condition, repeat, template, sourceTaskDigest }) {
    events.push(`replay:${task.name}:${condition}`);
    if (condition === "cold") {
      expect(template).toBeNull();
      expect(sourceTaskDigest).toBeNull();
    } else expect(template).not.toBeNull();
    let active = false;
    return {
      cloneId:
        condition === "cold"
          ? null
          : `clone:${task.taskDigest}:${condition}:${repeat}`,
      productPathAttestation: condition === "cold" ? null : productAttestation,
      activateCredential() {
        active = true;
        events.push(`activate:${task.name}:${condition}`);
      },
      revokeCredential() {
        active = false;
        events.push(`revoke:${task.name}:${condition}`);
      },
      async run({ lifecycle }) {
        const callbackEvent = {
          schema_version: "koed-harbor-lifecycle-v1" as const,
          attempt_kind: "replay" as const,
          event: "agent_started" as const,
          trial_id: `replay-${task.name}-${condition}`,
          task_name: task.name,
          timestamp: new Date(0).toISOString()
        };
        await lifecycle.onAgentStarted?.(callbackEvent);
        expect(active).toBe(true);
        await lifecycle.onAgentEnded?.({
          ...callbackEvent,
          event: "agent_ended"
        });
        expect(active).toBe(false);
        await lifecycle.onTrialEnded?.({
          ...callbackEvent,
          event: "trial_ended"
        });
        return {
          identity: { taskDigest: task.taskDigest, condition, repeat },
          harbor: {
            identity: { taskDigest: task.taskDigest, condition, repeat },
            status: "available",
            metrics: {
              reward: condition === "relevant" ? 1 : 0,
              passed: condition === "relevant",
              setupMs: 1,
              agentMs: 2,
              verifierMs: 1
            }
          }
        };
      },
      async close() {
        events.push(`close:${task.name}:${condition}`);
      }
    };
  },
  async teardown() {
    events.push("teardown");
  },
  ...overrides
});

describe("unified experience replay coordinator", () => {
  it("runs every phase through attested product boundaries without synthetic outcomes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const output = path.join(root, "run");
    const config = smokeConfig(output);
    const admitted = await preflightExperienceReplay({ config });
    const events: string[] = [];
    const result = await runExperienceReplay(config, {
      preflight: admitted,
      dependencies: fakeDependencies(events)
    });
    expect(result).toMatchObject({
      replayAttemptCount: 8,
      productPathExercised: true
    });
    const manifest = JSON.parse(
      await readFile(path.join(output, "manifest.json"), "utf8")
    ) as {
      execution_boundary: {
        product_path_exercised: boolean;
        terminal_bench_estimate: boolean;
      };
    };
    expect(manifest.execution_boundary).toEqual(
      expect.objectContaining({
        product_path_exercised: true,
        terminal_bench_estimate: false
      })
    );
    const journal = await readFile(path.join(output, "journal.jsonl"), "utf8");
    const completedPhases = journal
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { type: string; phase?: string; status?: string }
      )
      .filter((entry) => entry.type === "phase" && entry.status === "completed")
      .map((entry) => entry.phase);
    expect(completedPhases).toEqual([
      "preflight",
      "source_attempts",
      "atif_sanitization",
      "placebo_assignment",
      "canonical_koed_ingestion",
      "semantic_readiness",
      "template_creation",
      "replay_schedule",
      "replay_execution",
      "metric_merge",
      "report_generation",
      "teardown"
    ]);
    expect(events.filter((event) => event.startsWith("source:"))).toHaveLength(
      2
    );
    expect(
      events.filter((event) => event.startsWith("template:"))
    ).toHaveLength(6);
    expect(events.filter((event) => event.startsWith("replay:"))).toHaveLength(
      8
    );
    expect(
      new Set(events.filter((event) => event.startsWith("close:"))).size
    ).toBe(8);
    const markdown = await readFile(
      path.join(output, "report/summary.md"),
      "utf8"
    );
    expect(
      markdown.startsWith(
        "This is not a standard Terminal-Bench leaderboard evaluation."
      )
    ).toBe(true);
    await expect(reportExistingRun(output)).resolves.toContain("summary.md");
    const publication = await sanitizeRunReport(output);
    await expect(
      readFile(path.join(publication, "summary.json"), "utf8")
    ).resolves.toContain('"standard_leaderboard_comparable": false');
  }, 30_000);

  it("fails closed instead of claiming an incomplete product path and still tears down", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const original = dependencies.prepareTemplate;
    dependencies.prepareTemplate = vi.fn(async (input) => {
      const prepared = await original(input);
      return input.condition === "relevant"
        ? {
            ...prepared,
            attestation: { ...prepared.attestation, projection: false as never }
          }
        : prepared;
    });
    await expect(
      runExperienceReplay(config, { preflight: admitted, dependencies })
    ).rejects.toThrow("lacks a complete product-path attestation");
    expect(events.at(-1)).toBe("teardown");
    await expect(
      readFile(path.join(config.output_dir, "manifest.json"), "utf8")
    ).rejects.toThrow();
  });

  it("rejects database clone reuse and revokes through the Harbor lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const original = dependencies.createReplay;
    dependencies.createReplay = async (input) => {
      const handle = await original(input);
      return input.condition === "cold"
        ? handle
        : { ...handle, cloneId: "clone:reused" };
    };
    await expect(
      runExperienceReplay(config, { preflight: admitted, dependencies })
    ).rejects.toThrow("database clone was reused");
    expect(events.some((event) => event.startsWith("activate:"))).toBe(true);
    expect(events.some((event) => event.startsWith("revoke:"))).toBe(true);
  });

  it("requires an explicit integration adapter instead of using the removed fake path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    await expect(runExperienceReplay(config)).rejects.toThrow(
      "an ExperienceReplayCoordinatorDependencies adapter is required"
    );
  });
});
