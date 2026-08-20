import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createProductPathProofRunPlan,
  createOracleSeededProductProofRunPlan,
  createOracleSeededRepeatedStudyRunPlan,
  createOracleSeededCampaignRunPlan,
  createOracleCorpusQualificationRunPlan,
  createOracleCampaignProtocol,
  conditionUsesKoed,
  immutableHash,
  resolveExperienceReplayConfig,
  type ReplayCondition
} from "./core/index.js";
import {
  materializeSanitizedAtifTrajectory,
  type HarborFreezeManifest
} from "./atif/index.js";
import {
  campaignTemplateMaximumCost,
  resumeExperienceReplay,
  runExperienceReplay,
  sanitizeRunReport,
  type ExperienceReplayCoordinatorDependencies,
  type ReplayProductPathAttestation
} from "./coordinator.js";
import type { LocalProductTemplateAttestation } from "./local-product-adapter.js";
import { preflightExperienceReplay } from "./preflight.js";
import type { ReplayTelemetryMergeInput } from "./telemetry.js";
import {
  inspectOracleCorpusArtifact,
  persistOracleCorpusArtifact
} from "./oracle-corpus-artifact.js";
import { buildOracleCorpus } from "./oracle-corpus.js";
import { createOracleCorpusCollectionManifest } from "./oracle-corpus-collection.js";
import { mergeOracleCampaignRuns } from "./campaign-merge.js";
import { qualifyOracleCorpusCollection } from "./oracle-corpus-qualifier.js";
import { parseOracleQualificationManifest } from "./oracle-qualification-manifest.js";
import { HarborClientError } from "./harbor-client.js";
import type { RunLeaseSystem } from "./run-lease.js";

const runLeaseSystem: RunLeaseSystem = {
  currentOwner: async () => ({
    hostname: "fixture-host",
    machineId: "fixture-machine",
    bootId: "fixture-boot",
    pid: 1234,
    processStartTicks: "1001"
  }),
  processStartTicks: async (pid) => (pid === 1234 ? "1001" : null)
};

const productAttestation = {
  schema: "koed-experience-replay-local-product-template-v1",
  condition: "empty",
  taskDigest: `sha256:${"a".repeat(64)}`,
  sourceTaskDigest: null,
  projectId: "eval://project",
  project: {
    id: "eval://project",
    cwd: "/tmp/task",
    anchorSessionId: "anchor",
    ownerUserId: "user",
    visibility: "personal"
  },
  database: {
    databaseName: "koed_eval_template",
    currentDatabase: "koed_eval_template",
    migrationsCurrent: true,
    latestMigrationTimestamp: 1,
    postgresVersionNum: 170_000,
    pgvectorVersion: "0.8.1",
    rows: {
      users: 1,
      apiTokens: 1,
      capturedSessions: 1,
      conversationItems: 0,
      memoryEvents: 0,
      memoryNodes: 0,
      embeddingChunks: 0
    },
    stateHash: "a".repeat(64)
  },
  identity: {
    user: { id: "user", emailHash: "b".repeat(64) },
    apiToken: { id: "token", ownerUserId: "user", tokenPrefix: "cmt_test" },
    authenticatedApiProbe: {
      route: "/v1/sessions",
      authenticated: true,
      ownerUserId: "user"
    }
  },
  embedding: {
    transport: "loopback-http",
    provider: "deterministic-smoke",
    serviceOrigin: "http://127.0.0.1:1",
    model: "qwen3-0.6b",
    dimensions: 1024,
    modelArtifactHash: "sha256:test",
    health: {
      status: "ok",
      model: "qwen3-0.6b",
      dimensions: 1024,
      modelArtifactHash: "sha256:test",
      authRequired: true,
      authValid: true
    },
    preparationCalls: 0,
    preparationTexts: 0
  },
  normalizedImport: null,
  readiness: { ready: true },
  scheduledLcmJobs: null,
  frozenDatabase: {
    name: "koed_eval_template",
    allowConnections: false,
    isTemplate: true
  },
  frozenAt: "2026-08-12T00:00:00.000Z"
} as unknown as LocalProductTemplateAttestation;

const replayAttestation = (
  cloneId: string,
  templateId: string
): ReplayProductPathAttestation => ({
  schema: "koed-experience-replay-product-path-v1",
  cloneId,
  templateId,
  templateAttestationHash: immutableHash(productAttestation),
  databaseName: cloneId,
  taskDigest: "sha256:task",
  projectId: productAttestation.project.id,
  apiOrigin: "http://127.0.0.1:1001",
  redisEndpointHash: "d".repeat(64),
  mcpBridgeOrigin: "http://127.0.0.1:1002",
  localAiRuntimeOrigin: "http://127.0.0.1:1003"
});

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
): HarborFreezeManifest => {
  const stepCount = (
    JSON.parse(frozen) as { steps: Array<Record<string, unknown>> }
  ).steps.length;
  return {
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
      {
        ordinal: 2,
        event: "agent_ended",
        timestamp: "2026-08-12T00:00:02.000Z"
      },
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
      agent_last_native_event_ordinal: stepCount,
      step_identities: Array.from(
        { length: stepCount },
        (_, index) => index + 1
      ).map((ordinal) => ({
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
  };
};

describe("campaign template cost admission", () => {
  it("scales the finite preparation ceiling with the complete corpus", () => {
    const config = {
      ...campaignConfig("/tmp/koed-campaign-cost-test"),
      maximum_top_level_attempt_cost_usd: 0.25
    };

    expect(campaignTemplateMaximumCost(config, 2)).toBeCloseTo(0.5);
    expect(() => campaignTemplateMaximumCost(config, 0)).toThrow(
      "Campaign template task count must be a positive integer"
    );
  });
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
      container_sha256: "a".repeat(64),
      container_code_mode_host_sha256: "b".repeat(64)
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
    trajectory_judge: {
      model: { id: "deterministic-smoke", reasoning_effort: "low" },
      prompt_version: "experience-replay-trajectory-judge-v1",
      output_schema_version: "experience-replay-trajectory-judge-v1"
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
      judge_seconds: 60,
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

const productProofConfig = (output: string) => {
  const smoke = smokeConfig(output);
  return resolveExperienceReplayConfig({
    version: 1,
    profile: "quick",
    seed: "product-proof-test-seed",
    output_dir: output,
    codex_cli: smoke.codex_cli,
    coding_agent: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    memory_answer: {
      ...smoke.memory_answer,
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" }
    },
    trajectory_judge: {
      ...smoke.trajectory_judge,
      model: { id: "gpt-5.6-luna", reasoning_effort: "medium" }
    },
    lcm_summary: {
      ...smoke.lcm_summary,
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" }
    },
    session_title: {
      ...smoke.session_title,
      model: { id: "gpt-5.6-luna", reasoning_effort: "low" }
    },
    embedding: smoke.embedding,
    price_table: {
      version: "deterministic-v1",
      sha256: "c".repeat(64),
      models: {
        "gpt-5.6-luna": {
          uncached_input_usd_per_million: 0,
          cached_input_usd_per_million: 0,
          output_usd_per_million: 0
        }
      }
    },
    timeouts: smoke.timeouts,
    admission: {
      ...smoke.admission,
      provider_spending_limit_usd: 1
    },
    paid_cost_stop_usd: 1,
    concurrency: 1
  });
};

const campaignConfig = (output: string) => {
  const quick = productProofConfig(output);
  const excluded = new Set([
    "task_count",
    "replay_attempts_per_condition",
    "coding_agent_attempt_count",
    "maximum_top_level_attempt_cost_usd",
    "maximum_judge_call_cost_usd",
    "maximum_concurrent_overshoot_usd",
    "semantic_config_hash"
  ]);
  const base = Object.fromEntries(
    Object.entries(quick).filter(([key]) => !excluded.has(key))
  );
  const high = { id: "gpt-5.6-luna", reasoning_effort: "high" as const };
  return resolveExperienceReplayConfig({
    ...base,
    profile: "full",
    output_dir: output,
    coding_agent: high,
    memory_answer: { ...quick.memory_answer, model: high },
    lcm_summary: { ...quick.lcm_summary, model: high },
    session_title: { ...quick.session_title, model: high },
    concurrency: 2
  });
};

const fakeDependencies = (
  events: string[],
  overrides: Partial<ExperienceReplayCoordinatorDependencies> = {}
): ExperienceReplayCoordinatorDependencies => ({
  runLeaseSystem,
  countEmbeddingTokens: (text) =>
    text.trim() ? text.trim().split(/\s+/).length : 0,
  async runSource({ task, lifecycle, developerInstructions }) {
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
    const baseTrajectory = JSON.parse(trajectory(task.name)) as {
      steps: Array<Record<string, unknown>>;
    };
    if (developerInstructions) {
      baseTrajectory.steps.unshift({
        step_id: 0,
        source: "system",
        message: developerInstructions,
        timestamp: new Date(0).toISOString()
      });
      baseTrajectory.steps.forEach((step, index) => {
        step.step_id = index + 1;
      });
    }
    const frozen = JSON.stringify(baseTrajectory);
    const passed = task.name === "terminal-bench/synthetic-alpha";
    return {
      frozenTrajectory: frozen,
      freezeManifest: freezeManifest(task.name, frozen),
      reward: passed ? 1 : 0,
      passed,
      failureCategory: null,
      costUsd: 0,
      sanitizedTokenQuartile: passed ? 0 : 1,
      result: { verifier: "deterministic-fake" }
    };
  },
  async prepareTemplate({
    task,
    condition,
    sourceTask,
    sourceAttemptId,
    sanitizedSource
  }) {
    events.push(
      `template:${task.name}:${condition}:${sourceTask?.name ?? "none"}`
    );
    if (condition === "empty") expect(sanitizedSource).toBeNull();
    else expect(sanitizedSource?.normalizedItems.length).toBeGreaterThan(0);
    if (condition === "irrelevant") {
      expect(sourceAttemptId).toBe(`oracle:distractor:${task.taskDigest}`);
    } else if (condition.startsWith("relevant_")) {
      expect(sourceAttemptId).toBe(`oracle:${condition}:${task.taskDigest}`);
    }
    return {
      templateId: `template:${task.taskDigest}:${condition}`,
      sourceStateHash: `state:${sourceTask?.taskDigest ?? "empty"}`,
      attestation: productAttestation,
      preparationCostUsd: 0
    };
  },
  async prepareCampaignTemplate({ tasks, corpusCollectionManifestSha256 }) {
    events.push(
      `template:campaign:${corpusCollectionManifestSha256}:${tasks.length}`
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(
      tasks.every(
        (entry) =>
          entry.corpusAttestationSha256.length > 0 &&
          entry.sanitizedSource.normalizedItems.length > 0
      )
    ).toBe(true);
    return {
      templateId: `template:campaign:${corpusCollectionManifestSha256}`,
      sourceStateHash: `state:campaign:${corpusCollectionManifestSha256}`,
      attestation: productAttestation,
      preparationCostUsd: 0
    };
  },
  async createReplay({
    task,
    condition,
    repeat,
    executionGeneration,
    template,
    sourceTaskDigest,
    runRoot,
    developerInstructions,
    requireMemoryAnswer
  }) {
    events.push(`replay:${task.name}:${condition}`);
    if (!conditionUsesKoed(condition)) {
      expect(template).toBeNull();
      expect(sourceTaskDigest).toBeNull();
      if (condition === "direct_guidance")
        expect(developerInstructions).toBeTruthy();
    } else expect(template).not.toBeNull();
    let active = false;
    const cloneId = !conditionUsesKoed(condition)
      ? null
      : `clone:${task.taskDigest}:${condition}:${repeat}`;
    return {
      cloneId,
      productPathAttestation: !conditionUsesKoed(condition)
        ? null
        : replayAttestation(cloneId!, template!.templateId),
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
        const telemetry = {
          identity: { taskDigest: task.taskDigest, condition, repeat },
          harbor: {
            identity: { taskDigest: task.taskDigest, condition, repeat },
            status: "available",
            metrics: {
              reward:
                condition === "relevant" || condition.startsWith("relevant_")
                  ? 1
                  : 0,
              passed:
                condition === "relevant" || condition.startsWith("relevant_"),
              setupMs: 1,
              agentMs: 2,
              verifierMs: 1,
              failureCategory: null,
              failureKind: null,
              failurePhase: null
            }
          },
          codex: {
            identity: { taskDigest: task.taskDigest, condition, repeat },
            status: "available",
            metrics: {
              tokens: {
                uncachedInput: 0,
                cachedInput: 0,
                output: 0,
                reasoning: 0
              },
              costs: {
                providerBilledUsd: 0,
                apiEquivalentUsd: 0,
                subscriptionUsd: 0
              },
              turns: 1,
              toolCalls: 0,
              toolFailures: 0,
              mcpCalls: 0,
              mcpFailures: 0,
              memoryAnswerCalls:
                requireMemoryAnswer ||
                condition === "relevant" ||
                condition.startsWith("relevant_")
                  ? 1
                  : 0,
              memoryAnswerFailures: 0
            }
          },
          koedRecall: {
            identity: { taskDigest: task.taskDigest, condition, repeat },
            status: "available",
            metrics: {
              searches: 0,
              expansions: 0,
              stages: 0,
              evidenceCount:
                condition === "relevant" || condition.startsWith("relevant_")
                  ? 1
                  : 0,
              projectionMs: 0,
              lcmMs: 0,
              queueMs: 0,
              memoryAnswerRequests: conditionUsesKoed(condition)
                ? [{ responseDetail: "with_evidence", searchDomain: "global" }]
                : []
            }
          },
          modelWorkflows: {
            identity: { taskDigest: task.taskDigest, condition, repeat },
            status: "available",
            metrics: {
              memoryAnswer: {
                calls:
                  requireMemoryAnswer ||
                  condition === "relevant" ||
                  condition.startsWith("relevant_")
                    ? 1
                    : 0,
                failures: 0,
                durationMs: 0,
                tokens: {
                  uncachedInput: 0,
                  cachedInput: 0,
                  output: 0,
                  reasoning: 0
                },
                costs: {
                  providerBilledUsd: 0,
                  apiEquivalentUsd: 0,
                  subscriptionUsd: 0
                }
              },
              lcmSummary: {
                calls: 0,
                failures: 0,
                durationMs: 0,
                tokens: {
                  uncachedInput: 0,
                  cachedInput: 0,
                  output: 0,
                  reasoning: 0
                },
                costs: {
                  providerBilledUsd: 0,
                  apiEquivalentUsd: 0,
                  subscriptionUsd: 0
                }
              },
              sessionTitle: {
                calls: 0,
                failures: 0,
                durationMs: 0,
                tokens: {
                  uncachedInput: 0,
                  cachedInput: 0,
                  output: 0,
                  reasoning: 0
                },
                costs: {
                  providerBilledUsd: 0,
                  apiEquivalentUsd: 0,
                  subscriptionUsd: 0
                }
              }
            }
          },
          embeddings: {
            identity: { taskDigest: task.taskDigest, condition, repeat },
            status: "available",
            metrics: { calls: 0, tokens: 0, durationMs: 0 }
          },
          processRss: {
            identity: { taskDigest: task.taskDigest, condition, repeat },
            status: "available",
            metrics: { apiBytes: 0, runtimeBytes: 0, workerBytes: 0 }
          }
        } satisfies ReplayTelemetryMergeInput;
        const replayTrajectoryPath = `fake-replay-trajectories/${task.taskDigest}-${condition}-${repeat}-${executionGeneration}.json`;
        const rawTrajectory = trajectory(`${task.name}-${condition}`);
        await mkdir(path.dirname(path.join(runRoot, replayTrajectoryPath)), {
          recursive: true
        });
        await writeFile(
          path.join(runRoot, replayTrajectoryPath),
          rawTrajectory,
          "utf8"
        );
        return {
          telemetry,
          replayTrajectoryArtifact: {
            path: replayTrajectoryPath,
            sha256: `sha256:${createHash("sha256").update(rawTrajectory).digest("hex")}`,
            freezeManifest: freezeManifest(task.name, rawTrajectory)
          }
        };
      },
      async close() {
        events.push(`close:${task.name}:${condition}`);
      }
    };
  },
  async judgeTrajectory(input) {
    return {
      schemaVersion: "experience-replay-trajectory-judge-v1",
      taskDigest: input.taskDigest,
      repeat: input.repeat,
      comparison: `${input.comparison.left} - ${input.comparison.right}`,
      status: "judged",
      preferredCondition: "tie",
      confidence: 1,
      assessments: {},
      rationale: "Deterministic smoke tie.",
      latencyMs: 0,
      model: "deterministic-smoke",
      tokenUsage: {
        uncachedInput: 0,
        cachedInput: 0,
        output: 0,
        reasoning: 0
      },
      costUsd: 0,
      error: null
    };
  },
  async teardown() {
    events.push("teardown");
  },
  cleanupAttestations() {
    return [
      {
        cloneId: "clone:proof",
        runtime: { cleanupCount: 1, complete: true },
        product: { api: { closed: true } },
        complete: true
      }
    ];
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
    const dependencies = fakeDependencies(events);
    const prepareTemplate = dependencies.prepareTemplate;
    let activeTemplatePreparations = 0;
    let maximumActiveTemplatePreparations = 0;
    dependencies.prepareTemplate = async (input) => {
      activeTemplatePreparations += 1;
      maximumActiveTemplatePreparations = Math.max(
        maximumActiveTemplatePreparations,
        activeTemplatePreparations
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await prepareTemplate(input);
      } finally {
        activeTemplatePreparations -= 1;
      }
    };
    const result = await runExperienceReplay(config, {
      preflight: admitted,
      dependencies
    });
    expect(result).toMatchObject({
      replayAttemptCount: 8,
      productPathExercised: true
    });
    expect(maximumActiveTemplatePreparations).toBe(1);
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
        terminal_bench_estimate: false
      })
    );
    const preflightAttestation = JSON.parse(
      await readFile(path.join(output, "attestations/preflight.json"), "utf8")
    ) as { capacity: unknown; pins: unknown };
    expect(preflightAttestation).toMatchObject({
      capacity: admitted.capacity,
      pins: admitted.pins
    });
    const replayAttestations = JSON.parse(
      await readFile(
        path.join(output, "attestations/product-path.json"),
        "utf8"
      )
    ) as unknown[];
    expect(replayAttestations).toHaveLength(6);
    const cleanupAttestations = await readFile(
      path.join(output, "attestations/cleanup.json"),
      "utf8"
    );
    expect(cleanupAttestations).toContain('"cloneId": "clone:proof"');
    expect(cleanupAttestations).not.toContain("Bearer ");
    const preparationTelemetry = JSON.parse(
      await readFile(path.join(output, "preparation-telemetry.json"), "utf8")
    ) as {
      complete: boolean;
      templateCount: number;
      attempts: Array<{ telemetry: { jobs: unknown[] } }>;
    };
    expect(preparationTelemetry).toMatchObject({
      complete: true,
      templateCount: 6
    });
    expect(preparationTelemetry.attempts).toHaveLength(1);
    expect(preparationTelemetry.attempts[0]?.telemetry.jobs).toHaveLength(6);
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
      "replay_schedule",
      "source_attempts",
      "atif_sanitization",
      "placebo_assignment",
      "canonical_koed_ingestion",
      "semantic_readiness",
      "template_creation",
      "replay_execution",
      "metric_merge",
      "trajectory_judging",
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
    const judgments = JSON.parse(
      await readFile(path.join(output, "judge/results.json"), "utf8")
    ) as unknown[];
    expect(judgments).toHaveLength(10);
    const markdown = await readFile(
      path.join(output, "report/summary.md"),
      "utf8"
    );
    expect(
      markdown.startsWith(
        "This is not a standard Terminal-Bench leaderboard evaluation."
      )
    ).toBe(true);
    expect(markdown).toContain("## Blind trajectory judgments");
    const publication = await sanitizeRunReport(output);
    await expect(
      readFile(path.join(publication, "summary.json"), "utf8")
    ).resolves.toContain('"standard_leaderboard_comparable": false');
  }, 30_000);

  it("runs two proof sources but replays only the pinned target across four arms", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-proof-test-"));
    const output = path.join(root, "run");
    const config = productProofConfig(output);
    const base = await preflightExperienceReplay({
      config: smokeConfig(path.join(root, "unused-smoke"))
    });
    const selectedTasks = [
      {
        name: "terminal-bench/synthetic-alpha",
        task_digest: `sha256:${"a".repeat(64)}`,
        harbor_task_checksum: `sha256:${"1".repeat(64)}`,
        source_path: "tasks/synthetic-alpha",
        category: "synthetic",
        expert_time_quartile: 0,
        expert_time_seconds: 1,
        agent_timeout_seconds: 60,
        verifier_timeout_seconds: 30,
        resource_class: "synthetic-cpu",
        primary_reward: {
          field: "reward",
          minimum: 0,
          maximum: 1,
          success: { operator: "equals", value: 1 }
        }
      },
      {
        name: "terminal-bench/synthetic-beta",
        task_digest: `sha256:${"b".repeat(64)}`,
        harbor_task_checksum: `sha256:${"2".repeat(64)}`,
        source_path: "tasks/synthetic-beta",
        category: "synthetic",
        expert_time_quartile: 0,
        expert_time_seconds: 2,
        agent_timeout_seconds: 60,
        verifier_timeout_seconds: 30,
        resource_class: "synthetic-cpu",
        primary_reward: {
          field: "reward",
          minimum: 0,
          maximum: 1,
          success: { operator: "equals", value: 1 }
        }
      }
    ];
    const runPlan = createProductPathProofRunPlan(config, {
      targetTaskDigest: selectedTasks[0]!.task_digest,
      donorTaskDigest: selectedTasks[1]!.task_digest
    });
    const admitted = {
      ...base,
      config,
      runPlan,
      pins: { ...base.pins, selectedTasks }
    };
    const events: string[] = [];
    const result = await runExperienceReplay(config, {
      preflight: admitted,
      dependencies: fakeDependencies(events)
    });
    expect(result.replayAttemptCount).toBe(4);
    expect(events.filter((event) => event.startsWith("source:"))).toHaveLength(
      2
    );
    expect(
      events.filter((event) => event.startsWith("template:"))
    ).toHaveLength(3);
    const replays = events.filter((event) => event.startsWith("replay:"));
    expect(replays).toHaveLength(4);
    expect(replays.every((event) => event.includes("synthetic-alpha"))).toBe(
      true
    );
    expect(events.find((event) => event.includes(":placebo:"))).toContain(
      "synthetic-beta"
    );
    const manifest = JSON.parse(
      await readFile(path.join(output, "manifest.json"), "utf8")
    ) as { execution_kind: string; execution_boundary: unknown };
    expect(manifest).toMatchObject({
      execution_kind: "product_path_proof",
      execution_boundary: { terminal_bench_estimate: false }
    });
    const report = await readFile(
      path.join(output, "report/summary.md"),
      "utf8"
    );
    expect(report).toContain("two-source, one-target");
    expect(report).toContain("Replay attempts: 4");
  }, 30_000);

  it("fails closed instead of claiming an incomplete product path and still tears down", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const original = dependencies.prepareTemplate;
    const prepareTemplate: ExperienceReplayCoordinatorDependencies["prepareTemplate"] =
      async (input) => {
        const prepared = await original(input);
        return input.condition === "relevant"
          ? {
              ...prepared,
              attestation: {
                ...prepared.attestation,
                readiness: {
                  ...prepared.attestation.readiness,
                  ready: false as never
                }
              }
            }
          : prepared;
      };
    dependencies.prepareTemplate = vi.fn(prepareTemplate);
    await expect(
      runExperienceReplay(config, { preflight: admitted, dependencies })
    ).rejects.toThrow("lacks a complete template attestation");
    expect(events.at(-1)).toBe("teardown");
    await expect(
      readFile(path.join(config.output_dir, "manifest.json"), "utf8")
    ).resolves.toContain('"run_id"');
  });

  it("qualifies one oracle source and replays all six isolated artifact arms", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-oracle-test-"));
    const output = path.join(root, "run");
    const config = productProofConfig(output);
    const brief =
      "Use the task parser's existing selector and update the exact filtered nodes.";
    const briefSha256 = createHash("sha256").update(brief).digest("hex");
    const base = await preflightExperienceReplay({
      config: smokeConfig(path.join(root, "unused-smoke"))
    });
    const task = {
      name: "terminal-bench/synthetic-alpha",
      task_digest: `sha256:${"a".repeat(64)}`,
      harbor_task_checksum: `sha256:${"1".repeat(64)}`,
      source_path: "tasks/synthetic-alpha",
      category: "synthetic",
      expert_time_quartile: 0,
      expert_time_seconds: 1,
      agent_timeout_seconds: 60,
      verifier_timeout_seconds: 30,
      resource_class: "synthetic-cpu",
      primary_reward: {
        field: "reward",
        minimum: 0,
        maximum: 1,
        success: { operator: "equals", value: 1 }
      }
    };
    const runPlan = createOracleSeededProductProofRunPlan(
      config,
      task.task_digest,
      briefSha256
    );
    const admitted = {
      ...base,
      config,
      runPlan,
      pins: { ...base.pins, selectedTasks: [task] }
    };
    const events: string[] = [];
    const result = await runExperienceReplay(config, {
      preflight: admitted,
      dependencies: fakeDependencies(events),
      oracleBrief: brief
    });

    expect(result.replayAttemptCount).toBe(6);
    expect(events.filter((event) => event.startsWith("source:"))).toHaveLength(
      1
    );
    expect(
      events.filter((event) => event.startsWith("template:"))
    ).toHaveLength(5);
    expect(events.filter((event) => event.startsWith("replay:"))).toHaveLength(
      6
    );
    const provenance = await readFile(
      path.join(output, "source/synthetic-alpha/oracle-provenance.json"),
      "utf8"
    );
    expect(provenance).not.toContain(brief);
    expect(provenance).toContain(briefSha256);
    const report = JSON.parse(
      await readFile(path.join(output, "report/summary.json"), "utf8")
    ) as { benchmark_kind: string; attemptedReplayCount: number };
    expect(report).toMatchObject({
      benchmark_kind: "koed_oracle_seeded_experience_reuse",
      attemptedReplayCount: 6
    });
    const publication = await sanitizeRunReport(output);
    const publicationJson = await readFile(
      path.join(publication, "summary.json"),
      "utf8"
    );
    expect(publicationJson).not.toContain(brief);
    expect(publicationJson).toContain("relevant_guidance");
    expect(publicationJson).toContain('"codexAuthMode": "api_key"');
    const publicationMarkdown = await readFile(
      path.join(publication, "summary.md"),
      "utf8"
    );
    expect(publicationMarkdown).not.toContain(brief);
    expect(publicationMarkdown).toContain("relevant_guidance");

    await writeFile(
      path.join(output, "oracle-private/brief.txt"),
      `${brief} tampered`,
      "utf8"
    );
    await expect(
      resumeExperienceReplay(output, {
        preflight: admitted,
        dependencies: fakeDependencies([])
      })
    ).rejects.toThrow("brief differs from the run plan");
  }, 30_000);

  it("hydrates a private oracle corpus for the repeated four-arm study", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-oracle-repeat-"));
    const task = {
      name: "terminal-bench/synthetic-alpha",
      task_digest: `sha256:${"a".repeat(64)}`,
      harbor_task_checksum: `sha256:${"1".repeat(64)}`,
      source_path: "tasks/synthetic-alpha",
      category: "synthetic",
      expert_time_quartile: 0,
      expert_time_seconds: 1,
      agent_timeout_seconds: 60,
      verifier_timeout_seconds: 30,
      resource_class: "synthetic-cpu",
      primary_reward: {
        field: "reward",
        minimum: 0,
        maximum: 1,
        success: { operator: "equals", value: 1 }
      }
    };
    const brief =
      "Use the task parser's existing selector and update the exact filtered nodes.";
    const briefSha256 = createHash("sha256").update(brief).digest("hex");
    const repositoryRoot = path.join(root, "repository");
    await mkdir(repositoryRoot, { recursive: true });
    const corpusLocation = {
      corpusDirectory: path.join(root, "private-corpus", "synthetic-alpha"),
      repositoryRoot
    };
    const corpusIdentity = {
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      task: { name: task.name, digest: task.task_digest },
      codex: { version: "0.0.0-test" },
      taskImage: {
        taskName: task.name,
        taskDigest: task.task_digest,
        immutableReference: `registry.invalid/task@sha256:${"2".repeat(64)}`,
        imageId: `sha256:${"2".repeat(64)}`,
        contentDigest: `sha256:${"2".repeat(64)}`,
        resolvedBaseImageDigests: [`sha256:${"4".repeat(64)}`],
        dockerfileSha256: `sha256:${"5".repeat(64)}`,
        dockerVersion: "Docker test",
        buildkitVersion: "BuildKit test",
        provenanceSha256: `sha256:${"6".repeat(64)}`,
        attestationHash: "3".repeat(64)
      },
      sanitizer: { name: "harbor-atif", version: "1.0.0" }
    };
    const proofConfig = productProofConfig(path.join(root, "proof-run"));
    const base = await preflightExperienceReplay({
      config: smokeConfig(path.join(root, "unused-smoke"))
    });
    await runExperienceReplay(proofConfig, {
      preflight: {
        ...base,
        config: proofConfig,
        runPlan: createOracleSeededProductProofRunPlan(
          proofConfig,
          task.task_digest,
          briefSha256
        ),
        pins: { ...base.pins, selectedTasks: [task] }
      },
      dependencies: fakeDependencies([]),
      oracleBrief: brief,
      oracleCorpusArtifactTarget: {
        location: corpusLocation,
        identity: corpusIdentity
      }
    });
    const corpusArtifact = await inspectOracleCorpusArtifact(corpusLocation);

    const repeatedConfig = productProofConfig(path.join(root, "repeat-run"));
    const repeatedPlan = createOracleSeededRepeatedStudyRunPlan(
      repeatedConfig,
      task.task_digest,
      corpusArtifact.attestationSha256
    );
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const createReplay = dependencies.createReplay;
    const replayInputs: Array<{
      condition: ReplayCondition;
      developerInstructions?: string;
      requireMemoryAnswer?: boolean;
    }> = [];
    dependencies.createReplay = async (input) => {
      replayInputs.push({
        condition: input.condition,
        ...(input.developerInstructions
          ? { developerInstructions: input.developerInstructions }
          : {}),
        ...(input.requireMemoryAnswer === undefined
          ? {}
          : { requireMemoryAnswer: input.requireMemoryAnswer })
      });
      return createReplay(input);
    };
    const prepareTemplate = dependencies.prepareTemplate;
    dependencies.prepareTemplate = async (input) => {
      if (input.condition === "relevant_guidance") {
        expect(input.sanitizedSource?.canonicalJson).toBe(
          corpusArtifact.corpus.guidanceOnly.sanitization.canonicalJson
        );
      }
      if (input.condition === "relevant_full") {
        expect(input.sanitizedSource?.canonicalJson).toBe(
          corpusArtifact.corpus.fullExperience.sanitization.canonicalJson
        );
      }
      return prepareTemplate(input);
    };
    const repeatedAdmitted = {
      ...base,
      config: repeatedConfig,
      runPlan: repeatedPlan,
      pins: { ...base.pins, selectedTasks: [task] }
    };
    const result = await runExperienceReplay(repeatedConfig, {
      preflight: repeatedAdmitted,
      dependencies,
      oracleCorpusArtifactEntry: corpusArtifact
    });

    expect(result.replayAttemptCount).toBe(40);
    expect(events.some((event) => event.startsWith("source:"))).toBe(false);
    expect(
      events.filter((event) => event.startsWith("template:"))
    ).toHaveLength(3);
    expect(
      replayInputs.filter((input) => input.condition === "direct_guidance")
    ).toEqual(
      Array.from({ length: 10 }, () => ({
        condition: "direct_guidance",
        developerInstructions: brief
      }))
    );
    expect(
      replayInputs
        .filter((input) => conditionUsesKoed(input.condition))
        .every((input) => input.requireMemoryAnswer === true)
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          path.join(
            repeatedConfig.output_dir,
            "oracle-private/oracle-corpus-artifact.json"
          ),
          "utf8"
        )
      )
    ).toEqual(corpusArtifact);

    const campaign = campaignConfig(path.join(root, "campaign-run"));
    const secondTaskDigest = `sha256:${"b".repeat(64)}`;
    const secondSourceAttemptId = `oracle:qualified:${secondTaskDigest}`;
    const secondSource = {
      ...corpusArtifact.source,
      taskDigest: secondTaskDigest,
      sourceAttemptId: secondSourceAttemptId,
      sanitization: materializeSanitizedAtifTrajectory(
        corpusArtifact.source.sanitization.trajectory,
        {
          taskDigest: secondTaskDigest,
          sourceAttemptId: secondSourceAttemptId,
          sourceManifest: corpusArtifact.source.sanitization.manifest
        }
      )
    };
    const secondCorpus = buildOracleCorpus({
      oracleBrief: brief,
      oracleBriefSha256: briefSha256,
      source: secondSource
    });
    const secondCorpusArtifact = await persistOracleCorpusArtifact(
      {
        corpusDirectory: path.join(root, "private-corpus", "synthetic-beta"),
        repositoryRoot
      },
      {
        identity: {
          ...corpusIdentity,
          task: {
            name: "terminal-bench/synthetic-beta",
            digest: secondTaskDigest
          },
          taskImage: {
            ...corpusIdentity.taskImage,
            taskName: "terminal-bench/synthetic-beta",
            taskDigest: secondTaskDigest
          }
        },
        oracleBrief: brief,
        source: secondSource,
        corpus: secondCorpus
      }
    );
    const collectionManifest = createOracleCorpusCollectionManifest([
      corpusArtifact,
      secondCorpusArtifact
    ]);
    const campaignProtocol = createOracleCampaignProtocol({
      campaignId: "coordinator-smoke",
      campaignSeed: campaign.seed,
      taskUniverseDigests: [task.task_digest, secondTaskDigest],
      semanticConfigHash: campaign.semantic_config_hash,
      memoryAnswerPromptVersion: campaign.memory_answer.prompt_version,
      mcpRecallPolicyVersion:
        "mcp-server-instructions-v4+memory-answer-tool-description-v4",
      concurrency: campaign.concurrency,
      pins: {
        harborCommit: "64afbbcb62165950301e1a6407c729aa26d844ff",
        terminalBenchCommit: "2b0442c3c583b710ca8da14c8e601b99f2f1f244",
        corpusHash: base.pins.corpusHash,
        uvLockHash: base.pins.uvLockHash
      }
    });
    const campaignPlan = createOracleSeededCampaignRunPlan(
      campaign,
      [task.task_digest],
      collectionManifest.manifestSha256,
      "d".repeat(64),
      campaignProtocol.protocolHash,
      "subscription"
    );
    const campaignEvents: string[] = [];
    const campaignReplayInputs: Array<{
      condition: ReplayCondition;
      developerInstructions?: string;
      requireMemoryAnswer?: boolean;
    }> = [];
    const campaignDependencies = fakeDependencies(campaignEvents);
    const prepareCampaignTemplate =
      campaignDependencies.prepareCampaignTemplate!;
    campaignDependencies.prepareCampaignTemplate = async (input) => ({
      ...(await prepareCampaignTemplate(input)),
      // Deliberately exceeds this zero-priced fixture's per-job estimate.
      preparationCostUsd: 1
    });
    const createCampaignReplay = campaignDependencies.createReplay;
    campaignDependencies.createReplay = async (input) => {
      campaignReplayInputs.push({
        condition: input.condition,
        ...(input.developerInstructions
          ? { developerInstructions: input.developerInstructions }
          : {}),
        ...(input.requireMemoryAnswer === undefined
          ? {}
          : { requireMemoryAnswer: input.requireMemoryAnswer })
      });
      return createCampaignReplay(input);
    };
    const campaignResult = await runExperienceReplay(campaign, {
      preflight: {
        ...base,
        config: campaign,
        runPlan: campaignPlan,
        campaignProtocol,
        campaignShardId: "smoke-shard",
        pins: { ...base.pins, selectedTasks: [task] }
      },
      dependencies: campaignDependencies,
      oracleCorpusArtifactEntries: new Map([
        [task.task_digest, corpusArtifact],
        [secondTaskDigest, secondCorpusArtifact]
      ])
    });
    expect(campaignResult.replayAttemptCount).toBe(1);
    expect(
      campaignEvents.filter((event) => event.startsWith("source:"))
    ).toHaveLength(0);
    expect(
      campaignEvents.filter((event) => event.startsWith("template:"))
    ).toHaveLength(1);
    expect(
      campaignEvents.find((event) => event.startsWith("template:campaign:"))
    ).toMatch(/:2$/u);
    expect(
      campaignEvents.filter((event) => event.startsWith("replay:"))
    ).toHaveLength(1);
    expect(campaignReplayInputs).toEqual([{ condition: "relevant_full" }]);
    const progress = JSON.parse(
      await readFile(
        path.join(campaign.output_dir, "campaign/progress/0001.json"),
        "utf8"
      )
    ) as { completedEvaluations: number; passedTasks: number; score: number };
    expect(progress).toMatchObject({
      completedEvaluations: 1,
      passedTasks: 1,
      score: 1
    });
    const merged = await mergeOracleCampaignRuns({
      runDirectories: [campaign.output_dir],
      outputDirectory: path.join(root, "campaign-merged"),
      repositoryRoot,
      generatedAt: "2026-08-14T12:00:00.000Z"
    });
    expect(merged.progress).toMatchObject({
      selectedTasks: 1,
      completedEvaluations: 1,
      passedTasks: 1,
      score: 1
    });

    const qualification = campaignConfig(path.join(root, "qualification-run"));
    const qualificationManifest = parseOracleQualificationManifest({
      schema_version: "koed-oracle-qualification-manifest-v1",
      tasks: [
        {
          task_digest: task.task_digest,
          oracle_brief: brief,
          maximum_attempts: 2
        }
      ]
    });
    const qualificationPlan = createOracleCorpusQualificationRunPlan(
      qualification,
      [task.task_digest],
      qualificationManifest.manifestSha256,
      2
    );
    const qualificationCorpus = path.join(root, "qualified-corpora");
    const qualificationEvents: string[] = [];
    const qualificationDependencies = fakeDependencies(qualificationEvents);
    const runQualificationSource = qualificationDependencies.runSource;
    let qualificationSourceCalls = 0;
    qualificationDependencies.runSource = async (input) => {
      qualificationSourceCalls += 1;
      const source = await runQualificationSource(input);
      return qualificationSourceCalls === 1
        ? { ...source, reward: 0, passed: false }
        : source;
    };
    const qualified = await qualifyOracleCorpusCollection({
      preflight: {
        ...base,
        config: qualification,
        runPlan: qualificationPlan,
        pins: { ...base.pins, selectedTasks: [task] },
        recordedRunAttestation: {
          taskImages: [
            {
              ...corpusIdentity.taskImage,
              provenanceSha256: `sha256:${"7".repeat(64)}`,
              attestationHash: "8".repeat(64)
            }
          ],
          hostCodex: base.recordedRunAttestation?.hostCodex as never,
          containerCodex: base.recordedRunAttestation?.containerCodex as never
        }
      },
      dependencies: qualificationDependencies,
      manifest: qualificationManifest,
      corpusDirectory: qualificationCorpus
    });
    expect(qualified.results).toEqual([
      expect.objectContaining({
        taskDigest: task.task_digest,
        status: "qualified",
        attempts: 2
      })
    ]);
    expect(
      qualificationEvents.filter((event) => event.startsWith("source:"))
    ).toHaveLength(2);
    const qualifiedCollection =
      await import("./oracle-corpus-collection.js").then(
        ({ inspectOracleCorpusCollection }) =>
          inspectOracleCorpusCollection({
            corpusRoot: qualificationCorpus,
            repositoryRoot
          })
      );
    expect(qualifiedCollection.entries.has(task.task_digest)).toBe(true);

    const reuseConfig = campaignConfig(
      path.join(root, "qualification-reuse-run")
    );
    const reuseEvents: string[] = [];
    const reused = await qualifyOracleCorpusCollection({
      preflight: {
        ...base,
        config: reuseConfig,
        runPlan: createOracleCorpusQualificationRunPlan(
          reuseConfig,
          [task.task_digest],
          qualificationManifest.manifestSha256,
          2
        ),
        pins: { ...base.pins, selectedTasks: [task] },
        recordedRunAttestation: {
          taskImages: [
            {
              ...corpusIdentity.taskImage,
              contentDigest: `sha256:${"9".repeat(64)}`,
              imageId: `sha256:${"9".repeat(64)}`,
              immutableReference: `registry.invalid/task@sha256:${"9".repeat(64)}`
            }
          ],
          hostCodex: base.recordedRunAttestation?.hostCodex as never,
          containerCodex: base.recordedRunAttestation?.containerCodex as never
        }
      },
      dependencies: fakeDependencies(reuseEvents),
      manifest: qualificationManifest,
      corpusDirectory: qualificationCorpus
    });
    expect(reused.results).toEqual([
      expect.objectContaining({
        taskDigest: task.task_digest,
        status: "qualified",
        attempts: 0
      })
    ]);
    expect(
      reuseEvents.filter((event) => event.startsWith("source:"))
    ).toHaveLength(0);

    const changedImageConfig = campaignConfig(
      path.join(root, "qualification-changed-image-run")
    );
    await expect(
      qualifyOracleCorpusCollection({
        preflight: {
          ...base,
          config: changedImageConfig,
          runPlan: createOracleCorpusQualificationRunPlan(
            changedImageConfig,
            [task.task_digest],
            qualificationManifest.manifestSha256,
            2
          ),
          pins: { ...base.pins, selectedTasks: [task] },
          recordedRunAttestation: {
            taskImages: [
              {
                ...corpusIdentity.taskImage,
                dockerfileSha256: `sha256:${"9".repeat(64)}`
              }
            ],
            hostCodex: base.recordedRunAttestation?.hostCodex as never,
            containerCodex: base.recordedRunAttestation?.containerCodex as never
          }
        },
        dependencies: fakeDependencies([]),
        manifest: qualificationManifest,
        corpusDirectory: qualificationCorpus
      })
    ).rejects.toThrow(
      "Existing oracle corpus identity differs from qualification policy"
    );

    const failedQualification = campaignConfig(
      path.join(root, "qualification-failure-run")
    );
    const failedDependencies = fakeDependencies([]);
    failedDependencies.runSource = async () => {
      throw new HarborClientError(
        "process-exit",
        "Harbor runner exited unsuccessfully: OUTPUT_ALREADY_EXISTS"
      );
    };
    const failed = await qualifyOracleCorpusCollection({
      preflight: {
        ...base,
        config: failedQualification,
        runPlan: createOracleCorpusQualificationRunPlan(
          failedQualification,
          [task.task_digest],
          qualificationManifest.manifestSha256,
          2
        ),
        pins: { ...base.pins, selectedTasks: [task] },
        recordedRunAttestation: {
          taskImages: [corpusIdentity.taskImage],
          hostCodex: base.recordedRunAttestation?.hostCodex as never,
          containerCodex: base.recordedRunAttestation?.containerCodex as never
        }
      },
      dependencies: failedDependencies,
      manifest: qualificationManifest,
      corpusDirectory: path.join(root, "failed-qualified-corpora")
    });
    expect(failed.results).toEqual([
      expect.objectContaining({
        status: "infrastructure_failed",
        attempts: 1,
        infrastructureCategory: "process-exit",
        infrastructureCode: "OUTPUT_ALREADY_EXISTS"
      })
    ]);
  }, 30_000);

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
        : {
            ...handle,
            cloneId: "clone:reused",
            productPathAttestation: replayAttestation(
              "clone:reused",
              input.template!.templateId
            )
          };
    };
    await expect(
      runExperienceReplay(config, { preflight: admitted, dependencies })
    ).rejects.toThrow("database clone was reused");
    expect(events.some((event) => event.startsWith("activate:"))).toBe(true);
    expect(events.some((event) => event.startsWith("revoke:"))).toBe(true);
  });

  it("preserves acknowledged post-agent failures as missing outcomes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const original = dependencies.createReplay;
    dependencies.createReplay = async (input) => {
      const handle = await original(input);
      return {
        ...handle,
        async run({ lifecycle }) {
          await lifecycle.onAgentStarted?.({
            schema_version: "koed-harbor-lifecycle-v1",
            attempt_kind: "replay",
            event: "agent_started",
            trial_id: `failed-${input.task.name}-${input.condition}`,
            task_name: input.task.name,
            timestamp: new Date(0).toISOString()
          });
          throw Object.assign(new Error("synthetic post-agent timeout"), {
            category: "timeout"
          });
        }
      };
    };
    const result = await runExperienceReplay(config, {
      preflight: admitted,
      dependencies
    });
    expect(result.replayAttemptCount).toBe(8);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Failures and missing outcomes: 8");
    expect(report).toContain("failure agent_timeout");
  });

  it("reports infrastructure failures before agent admission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const events: string[] = [];
    const dependencies = fakeDependencies(events, {
      createReplay: vi.fn(async () => {
        throw new Error("synthetic runtime provisioning failure");
      })
    });
    const result = await runExperienceReplay(config, {
      preflight: admitted,
      dependencies
    });
    expect(result).toMatchObject({
      replayAttemptCount: 8,
      productPathExercised: false
    });
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Failures and missing outcomes: 8");
    expect(report).toContain("failure setup_failed");
    const summary = JSON.parse(
      await readFile(
        path.join(result.runDirectory, "report/summary.json"),
        "utf8"
      )
    ) as { attempts: Array<{ infrastructureCode?: string }> };
    expect(summary.attempts).toHaveLength(8);
    expect(summary.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          infrastructureCode: "REPLAY_SETUP_FAILED"
        })
      ])
    );
  });

  it("reports replay cleanup failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const original = dependencies.createReplay;
    dependencies.createReplay = async (input) => {
      const handle = await original(input);
      return {
        ...handle,
        async close() {
          await handle.close();
          throw new Error("synthetic replay cleanup failure");
        }
      };
    };
    const result = await runExperienceReplay(config, {
      preflight: admitted,
      dependencies
    });
    const report = JSON.parse(
      await readFile(
        path.join(result.runDirectory, "report/summary.json"),
        "utf8"
      )
    ) as { attempts: Array<{ failureCategory: string }> };
    expect(report.attempts).toHaveLength(8);
    expect(report.attempts[0]).toMatchObject({
      failureCategory: "teardown_failed"
    });
  });

  it("requires an explicit integration adapter instead of using the removed fake path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    await expect(runExperienceReplay(config)).rejects.toThrow(
      "an ExperienceReplayCoordinatorDependencies adapter is required"
    );
  });

  it("records failed preparation attempts and publishes a complete resume summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const interrupted = fakeDependencies([]);
    const prepareTemplate = interrupted.prepareTemplate;
    let failed = false;
    interrupted.prepareTemplate = async (input) => {
      if (!failed) {
        failed = true;
        throw new Error("synthetic template preparation interruption");
      }
      return prepareTemplate(input);
    };

    await expect(
      runExperienceReplay(config, {
        preflight: admitted,
        dependencies: interrupted
      })
    ).rejects.toThrow("synthetic template preparation interruption");
    await expect(
      readFile(path.join(config.output_dir, "preparation-telemetry.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readdir(path.join(config.output_dir, "preparation-telemetry"))
    ).toHaveLength(1);

    const journalBeforeWrongCommand = await readFile(
      path.join(config.output_dir, "journal.jsonl"),
      "utf8"
    );
    await expect(
      runExperienceReplay(config, {
        preflight: admitted,
        dependencies: fakeDependencies([])
      })
    ).rejects.toThrow(
      "Benchmark output already contains a run; use the resume command"
    );
    expect(
      await readFile(path.join(config.output_dir, "journal.jsonl"), "utf8")
    ).toBe(journalBeforeWrongCommand);

    const resumed = fakeDependencies([], {
      adoptTemplate: async (template) => template
    });
    await expect(
      resumeExperienceReplay(config.output_dir, {
        preflight: admitted,
        dependencies: resumed
      })
    ).resolves.toContain("summary.md");

    const telemetry = JSON.parse(
      await readFile(
        path.join(config.output_dir, "preparation-telemetry.json"),
        "utf8"
      )
    ) as {
      complete: boolean;
      templateCount: number;
      attempts: Array<{
        path: string;
        telemetry: {
          scheduler: { completedJobs: number; failedJobs: number };
        };
      }>;
    };
    expect(telemetry).toMatchObject({ complete: true, templateCount: 6 });
    expect(telemetry.attempts).toHaveLength(2);
    expect(telemetry.attempts.map((attempt) => attempt.path)).toEqual(
      [...telemetry.attempts]
        .map((attempt) => attempt.path)
        .sort((left, right) => left.localeCompare(right))
    );
    expect(telemetry.attempts[0]?.telemetry.scheduler).toMatchObject({
      completedJobs: 5,
      failedJobs: 1
    });
    expect(telemetry.attempts[1]?.telemetry.scheduler).toMatchObject({
      completedJobs: 1,
      failedJobs: 0
    });
  });

  it("resumes a completed run without duplicating source or replay attempts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const initialEvents: string[] = [];
    await runExperienceReplay(config, {
      preflight: admitted,
      dependencies: fakeDependencies(initialEvents)
    });
    const before = (
      await readFile(path.join(config.output_dir, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string })
      .filter((entry) => entry.type === "attempt_result").length;
    const resumedEvents: string[] = [];
    await expect(
      resumeExperienceReplay(config.output_dir, {
        preflight: admitted,
        dependencies: fakeDependencies(resumedEvents)
      })
    ).resolves.toContain("summary.md");
    expect(
      resumedEvents.filter((event) =>
        /^(?:source|template|replay):/u.test(event)
      )
    ).toEqual([]);
    const after = (
      await readFile(path.join(config.output_dir, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string })
      .filter((entry) => entry.type === "attempt_result").length;
    expect(after).toBe(before);
  });

  it("rejects resume when the product-path source revision changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    await runExperienceReplay(config, {
      preflight: admitted,
      dependencies: fakeDependencies([], {
        repositoryCommit: "a".repeat(40)
      })
    });

    await expect(
      resumeExperienceReplay(config.output_dir, {
        preflight: admitted,
        dependencies: fakeDependencies([], {
          repositoryCommit: "b".repeat(40)
        })
      })
    ).rejects.toThrow("Persisted run manifest differs from resolved execution");
  });

  it("reruns a pre-agent source interruption under the stable ID and a new generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const interrupted = fakeDependencies([], {
      runSource: vi.fn(async () => {
        throw new Error("interrupted before source agent start");
      })
    });
    await expect(
      runExperienceReplay(config, {
        preflight: admitted,
        dependencies: interrupted
      })
    ).rejects.toThrow("interrupted before source agent start");

    await expect(
      resumeExperienceReplay(config.output_dir, {
        preflight: admitted,
        dependencies: fakeDependencies([])
      })
    ).resolves.toContain("summary.md");
    const journal = (
      await readFile(path.join(config.output_dir, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            attemptId?: string;
            executionGeneration?: number;
          }
      );
    for (const digest of ["a", "b"]) {
      const id = `source:sha256:${digest.repeat(64)}`;
      expect(
        journal
          .filter(
            (entry) => entry.type === "attempt_result" && entry.attemptId === id
          )
          .map((entry) => entry.executionGeneration)
      ).toEqual([2]);
    }
  });

  it("stops the source cohort on a Harbor runtime failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const runSource = vi.fn(
      async (
        input: Parameters<
          ExperienceReplayCoordinatorDependencies["runSource"]
        >[0]
      ) => {
        const frozen = trajectory(input.task.name);
        return {
          frozenTrajectory: frozen,
          freezeManifest: freezeManifest(input.task.name, frozen),
          reward: null,
          passed: false,
          failureCategory: "other",
          costUsd: 0,
          sanitizedTokenQuartile: 0 as const,
          result: { runtime: "failed" }
        };
      }
    );

    await expect(
      runExperienceReplay(config, {
        preflight: admitted,
        dependencies: fakeDependencies([], { runSource })
      })
    ).rejects.toThrow("failed in Harbor runtime or environment setup");
  });

  it("preserves a source interruption after agent start and refuses dependent preparation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const runSource: ExperienceReplayCoordinatorDependencies["runSource"] =
      async (input) => {
        await input.lifecycle.onAgentStarted?.({
          schema_version: "koed-harbor-lifecycle-v1",
          attempt_kind: "source",
          event: "agent_started",
          trial_id: input.attemptId,
          task_name: input.task.name,
          timestamp: new Date(0).toISOString()
        });
        throw new Error("interrupted after source agent start");
      };
    const interrupted = fakeDependencies([], {
      runSource: vi.fn(runSource)
    });
    await expect(
      runExperienceReplay(config, {
        preflight: admitted,
        dependencies: interrupted
      })
    ).rejects.toThrow("interrupted after source agent start");
    const resumedEvents: string[] = [];
    await expect(
      resumeExperienceReplay(config.output_dir, {
        preflight: admitted,
        dependencies: fakeDependencies(resumedEvents)
      })
    ).rejects.toThrow("dependent preparation is forbidden");
    expect(resumedEvents.some((event) => event.startsWith("source:"))).toBe(
      false
    );
    const results = (
      await readFile(path.join(config.output_dir, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; failureCategory?: string }
      )
      .filter((entry) => entry.type === "attempt_result");
    expect(
      results.filter((entry) => entry.failureCategory === "missing_outcome")
    ).toHaveLength(1);
  });

  it("reruns a replay interrupted before agent start with a new execution generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const dependencies = fakeDependencies([]);
    const createReplay = dependencies.createReplay;
    let interruptedId: string | undefined;
    dependencies.createReplay = async (input) => {
      const replay = await createReplay(input);
      if (!interruptedId && input.condition !== "cold") {
        interruptedId = `replay:${input.task.taskDigest}:${input.condition}:${input.repeat}`;
        return {
          ...replay,
          productPathAttestation: null
        };
      }
      return replay;
    };
    await expect(
      runExperienceReplay(config, { preflight: admitted, dependencies })
    ).rejects.toThrow("lacks a complete runtime attestation");
    expect(interruptedId).toBeDefined();

    const adoptTemplate: NonNullable<
      ExperienceReplayCoordinatorDependencies["adoptTemplate"]
    > = async (template) => template;
    const resumed = fakeDependencies([], {
      adoptTemplate: vi.fn(adoptTemplate)
    });
    await expect(
      resumeExperienceReplay(config.output_dir, {
        preflight: admitted,
        dependencies: resumed
      })
    ).resolves.toContain("summary.md");
    const results = (
      await readFile(path.join(config.output_dir, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            attemptId?: string;
            executionGeneration?: number;
          }
      )
      .filter(
        (entry) =>
          entry.type === "attempt_result" && entry.attemptId === interruptedId
      );
    expect(results.map((entry) => entry.executionGeneration)).toEqual([2]);
  });

  it("classifies a post-verifier runner exit as infrastructure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const dependencies = fakeDependencies([]);
    const createReplay = dependencies.createReplay;
    let injected = false;
    dependencies.createReplay = async (input) => {
      const replay = await createReplay(input);
      if (injected || input.condition === "cold") return replay;
      injected = true;
      return {
        ...replay,
        async run({ lifecycle }) {
          const event = {
            schema_version: "koed-harbor-lifecycle-v1" as const,
            attempt_kind: "replay" as const,
            event: "agent_started" as const,
            trial_id: `post-verifier-${input.task.name}`,
            task_name: input.task.name,
            timestamp: new Date(0).toISOString()
          };
          await lifecycle.onAgentStarted?.(event);
          await lifecycle.onAgentEnded?.({ ...event, event: "agent_ended" });
          throw new HarborClientError(
            "process-exit",
            "Harbor runner exited unsuccessfully: HARBOR_POST_VERIFIER_FAILURE",
            { contractCode: "HARBOR_POST_VERIFIER_FAILURE" }
          );
        }
      };
    };

    await runExperienceReplay(config, { preflight: admitted, dependencies });
    const results = (
      await readFile(config.output_dir + "/journal.jsonl", "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(results).toContainEqual(
      expect.objectContaining({
        type: "attempt_result",
        failureCategory: "missing_outcome"
      })
    );
    const failedResult = results.find(
      (entry) =>
        entry.type === "attempt_result" &&
        entry.failureCategory === "missing_outcome"
    );
    expect(failedResult).toBeDefined();
    const artifact = JSON.parse(
      await readFile(
        path.join(config.output_dir, failedResult?.resultPath as string),
        "utf8"
      )
    ) as {
      failureKind: string;
      failurePhase: string;
      infrastructureCode: string;
    };
    expect(artifact).toMatchObject({
      failureKind: "infrastructure",
      failurePhase: "verifier",
      infrastructureCode: "HARBOR_POST_VERIFIER_FAILURE"
    });
  });

  it("retains stable infrastructure codes without raw runner output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-smoke-test-"));
    const config = smokeConfig(path.join(root, "run"));
    const admitted = await preflightExperienceReplay({ config });
    const dependencies = fakeDependencies([]);
    const createReplay = dependencies.createReplay;
    let injected = false;
    dependencies.createReplay = async (input) => {
      if (!injected) {
        injected = true;
        throw new HarborClientError(
          "process-exit",
          "Harbor runner exited unsuccessfully: HARBOR_PRE_AGENT_FAILURE",
          { contractCode: "HARBOR_PRE_AGENT_FAILURE" }
        );
      }
      return createReplay(input);
    };

    await runExperienceReplay(config, { preflight: admitted, dependencies });
    const admission = JSON.parse(
      await readFile(
        path.join(config.output_dir, "cost-admission.json"),
        "utf8"
      )
    ) as { jobs: Array<Record<string, unknown>> };
    expect(admission.jobs).toContainEqual(
      expect.objectContaining({
        status: "failed",
        failureCategory: "process-exit",
        infrastructureCode: "HARBOR_PRE_AGENT_FAILURE"
      })
    );
  });
});
