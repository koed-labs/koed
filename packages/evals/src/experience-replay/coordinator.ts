import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assignMatchedPlacebos,
  createMachineReport,
  createReplaySchedule,
  immutableHash,
  redactPublicationReport,
  renderMarkdownReport,
  REQUIRED_COMPARISONS,
  summarizeComparison,
  verifyPlaceboAssignment,
  verifyReplaySchedule,
  type ReplayCondition,
  type ReplayOutcome,
  type ReplaySchedule,
  type ResolvedExperienceReplayConfig,
  type TaskRewardContract
} from "./core/index.js";
import {
  sanitizeAtifTrajectory,
  type AtifSanitizationResult,
  type HarborFreezeManifest
} from "./atif/index.js";
import { SafeRunDirectory } from "./output-path.js";
import {
  EXPERIENCE_REPLAY_REPOSITORY_ROOT,
  ProductPathPrerequisiteError,
  preflightExperienceReplay,
  type PreflightResult
} from "./preflight.js";
import {
  planAttemptResume,
  readRunJournal,
  RunJournal,
  type RunPhase,
  type RunJournalEntry
} from "./journal.js";
import {
  readJsonArtifact,
  readTextFileNoFollow,
  validateExistingRunDirectory,
  writeTextArtifactAtomic
} from "./artifacts.js";
import { createCoordinatorHarborLifecycle } from "./harbor-lifecycle.js";
import {
  mergeReplayTelemetry,
  type ReplayTelemetryMergeInput
} from "./telemetry.js";

const SMOKE_TASKS: readonly CoordinatorTask[] = [
  {
    name: "synthetic-alpha",
    taskDigest: `sha256:${"a".repeat(64)}`,
    category: "synthetic",
    expertTimeSeconds: 1,
    resourceClass: "synthetic-cpu",
    reward: { minimum: 0, maximum: 1, successValue: 1 }
  },
  {
    name: "synthetic-beta",
    taskDigest: `sha256:${"b".repeat(64)}`,
    category: "synthetic",
    expertTimeSeconds: 2,
    resourceClass: "synthetic-cpu",
    reward: { minimum: 0, maximum: 1, successValue: 1 }
  }
];

export interface CoordinatorTask {
  name: string;
  taskDigest: string;
  category: string;
  expertTimeSeconds: number;
  resourceClass: string;
  reward: { minimum: number; maximum: number; successValue: number };
}

export interface SourceAttemptExecution {
  frozenTrajectory: string;
  freezeManifest: HarborFreezeManifest;
  reward: number | null;
  passed: boolean;
  /** Source metadata only. Replay observations must never influence matching. */
  sanitizedTokenQuartile: 0 | 1 | 2 | 3;
  result: Record<string, unknown>;
}

export interface ProductPathAttestation {
  canonicalNormalizedImport: true;
  projection: true;
  semanticReadiness: true;
  databaseTemplate: true;
  postgres: true;
  redis: true;
  mcpBridge: true;
  localAiRuntime: true;
}

export interface PreparedTemplate {
  templateId: string;
  sourceStateHash: string;
  attestation: ProductPathAttestation;
}

export interface ReplayExecutionHandle {
  /** Unique database clone identity for this execution generation. */
  cloneId: string | null;
  productPathAttestation: ProductPathAttestation | null;
  activateCredential(): void | Promise<void>;
  revokeCredential(): void | Promise<void>;
  run(input: {
    lifecycle: ReturnType<typeof createCoordinatorHarborLifecycle>;
  }): Promise<ReplayTelemetryMergeInput>;
  close(): Promise<void>;
}

export interface ExperienceReplayCoordinatorDependencies {
  countEmbeddingTokens(text: string): number;
  runSource(input: {
    task: CoordinatorTask;
    attemptId: string;
    executionGeneration: number;
    runRoot: string;
    /** Source attempts alone receive freeze destinations. */
    freezeTrajectoryPath: string;
    freezeManifestPath: string;
    lifecycle: ReturnType<typeof createCoordinatorHarborLifecycle>;
    config: ResolvedExperienceReplayConfig;
  }): Promise<SourceAttemptExecution>;
  prepareTemplate(input: {
    task: CoordinatorTask;
    condition: "empty" | "placebo" | "relevant";
    sourceTask: CoordinatorTask | null;
    sanitizedSource: AtifSanitizationResult | null;
    runRoot: string;
    config: ResolvedExperienceReplayConfig;
  }): Promise<PreparedTemplate>;
  createReplay(input: {
    task: CoordinatorTask;
    condition: ReplayCondition;
    repeat: number;
    executionGeneration: number;
    template: PreparedTemplate | null;
    sourceTaskDigest: string | null;
    runRoot: string;
    config: ResolvedExperienceReplayConfig;
  }): Promise<ReplayExecutionHandle>;
  teardown(): Promise<void>;
}

export interface ExperienceReplayRunResult {
  runDirectory: string;
  reportPath: string;
  replayAttemptCount: number;
  productPathExercised: boolean;
}

type SourceRecord = SourceAttemptExecution & {
  task: CoordinatorTask;
  sanitization?: AtifSanitizationResult;
};

interface PersistedTemplate {
  taskDigest: string;
  condition: "empty" | "placebo" | "relevant";
  sourceTaskDigest: string | null;
  template: PreparedTemplate;
}

const missingDependencies = (): never => {
  throw new ProductPathPrerequisiteError([
    "an ExperienceReplayCoordinatorDependencies adapter is required",
    "default CI does not automatically provision PostgreSQL, Redis, Harbor containers, or a Local AI Runtime"
  ]);
};

const defaultDependencies: ExperienceReplayCoordinatorDependencies = {
  countEmbeddingTokens: () => missingDependencies(),
  runSource: async () => missingDependencies(),
  prepareTemplate: async () => missingDependencies(),
  createReplay: async () => missingDependencies(),
  teardown: async () => undefined
};

const attemptId = (
  taskDigest: string,
  condition: ReplayCondition,
  repeat: number
) => `replay:${taskDigest}:${condition}:${repeat}`;

const safeTaskName = (name: string): string =>
  name.replace(/^terminal-bench\//, "").replace(/[^a-zA-Z0-9._-]/g, "-");

const phase = async (
  journal: RunJournal,
  name: RunPhase,
  status: "started" | "completed" | "skipped" | "blocked",
  detail?: string
) =>
  journal.append({
    type: "phase",
    phase: name,
    status,
    ...(detail ? { detail } : {})
  });

const publishOrVerifyArtifact = async (
  runRoot: string,
  relativePath: string,
  contents: string
): Promise<void> => {
  try {
    await writeTextArtifactAtomic(runRoot, relativePath, contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readTextFileNoFollow(
      path.join(runRoot, relativePath),
      Buffer.byteLength(contents)
    );
    if (existing !== contents)
      throw new Error(`Published artifact differs: ${relativePath}`, {
        cause: error
      });
  }
};

const taskContracts = (
  tasks: readonly CoordinatorTask[]
): TaskRewardContract[] =>
  tasks.map((task) => ({
    taskDigest: task.taskDigest,
    rewardMin: task.reward.minimum,
    rewardMax: task.reward.maximum
  }));

const reportFromOutcomes = async (
  runRoot: string,
  config: ResolvedExperienceReplayConfig,
  tasks: readonly CoordinatorTask[],
  outcomes: readonly ReplayOutcome[],
  preparationCostUsd = 0
): Promise<void> => {
  const contracts = taskContracts(tasks);
  const comparisons = REQUIRED_COMPARISONS.map((comparison) =>
    summarizeComparison(
      outcomes,
      contracts,
      comparison,
      config.replay_attempts_per_condition
    )
  );
  const report = createMachineReport({
    runId: immutableHash({
      config: config.semantic_config_hash,
      tasks: tasks.map(({ taskDigest }) => taskDigest)
    }).slice(0, 16),
    profile: config.profile,
    model: config.coding_agent.id,
    taskCount: tasks.length,
    attemptedReplayCount: outcomes.length,
    failureCount: outcomes.filter((outcome) => outcome.reward === null).length,
    preparationCostUsd,
    comparisons,
    attempts: outcomes,
    exclusions: [],
    detailFiles: ["manifest.json", "schedule.json", "journal.jsonl"]
  });
  await publishOrVerifyArtifact(
    runRoot,
    "report/summary.json",
    `${JSON.stringify(report, null, 2)}\n`
  );
  await publishOrVerifyArtifact(
    runRoot,
    "report/summary.md",
    renderMarkdownReport(report)
  );
};

const selectedTasks = (preflight: PreflightResult): CoordinatorTask[] => {
  if (preflight.config.profile === "smoke") return [...SMOKE_TASKS];
  return preflight.pins.selectedTasks.map((task) => ({
    name: task.name,
    taskDigest: task.task_digest,
    category: task.category,
    expertTimeSeconds: task.expert_time_seconds,
    resourceClass: task.resource_class,
    reward: {
      minimum: task.primary_reward.minimum,
      maximum: task.primary_reward.maximum,
      successValue: task.primary_reward.success.value
    }
  }));
};

const assertProductAttestation: (
  value: ProductPathAttestation | null,
  label: string
) => asserts value is ProductPathAttestation = (value, label) => {
  if (
    !value ||
    value.canonicalNormalizedImport !== true ||
    value.projection !== true ||
    value.semanticReadiness !== true ||
    value.databaseTemplate !== true ||
    value.postgres !== true ||
    value.redis !== true ||
    value.mcpBridge !== true ||
    value.localAiRuntime !== true
  ) {
    throw new Error(`${label} lacks a complete product-path attestation`);
  }
};

const resultPathFor = (
  task: CoordinatorTask,
  condition: ReplayCondition,
  repeat: number
) => `attempts/${safeTaskName(task.name)}/${condition}/${repeat}/result.json`;

const sourceResultPathFor = (task: CoordinatorTask) =>
  `source/${safeTaskName(task.name)}/result.json`;

const validateReplayIdentity = (
  telemetry: ReplayTelemetryMergeInput,
  task: CoordinatorTask,
  condition: ReplayCondition,
  repeat: number
): void => {
  const identity = telemetry.identity;
  if (
    identity.taskDigest !== task.taskDigest ||
    identity.condition !== condition ||
    identity.repeat !== repeat
  ) {
    throw new Error(
      "Replay telemetry identity differs from the immutable schedule"
    );
  }
};

export const runExperienceReplay = async (
  config: ResolvedExperienceReplayConfig,
  options: {
    preflight?: PreflightResult;
    dependencies?: ExperienceReplayCoordinatorDependencies;
  } = {}
): Promise<ExperienceReplayRunResult> => {
  const dependencies = options.dependencies ?? defaultDependencies;
  if (!options.dependencies) missingDependencies();
  const admitted =
    options.preflight ?? (await preflightExperienceReplay({ config }));
  if (admitted.config.semantic_config_hash !== config.semantic_config_hash)
    throw new Error("Preflight configuration differs from coordinator config");
  const tasks = selectedTasks(admitted);
  if (tasks.length !== config.task_count)
    throw new Error(`Profile ${config.profile} selected the wrong task count`);

  const created = await SafeRunDirectory.create({
    outputPath: config.output_dir,
    repositoryRoot: admitted.repositoryRoot,
    requiredBytes: admitted.capacity.requiredBytes,
    reserveBytes: admitted.capacity.reserveBytes
  });
  const directory = created.directory;
  const journal = new RunJournal(directory, config.semantic_config_hash);
  const sources = new Map<string, SourceRecord>();
  const templates = new Map<string, PreparedTemplate>();
  const templateRecords: PersistedTemplate[] = [];
  const outcomes: ReplayOutcome[] = [];
  const cloneIds = new Set<string>();
  let productPathExercised = false;
  let primaryFailure: unknown;
  const manifest = {
    manifest_version: 1,
    benchmark_kind: "koed_experience_replay",
    standard_leaderboard_comparable: false,
    profile: config.profile,
    configuration_hash: config.semantic_config_hash,
    task_digests: tasks.map((task) => task.taskDigest),
    pins: {
      harbor_commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
      terminal_bench_commit: "2b0442c3c583b710ca8da14c8e601b99f2f1f244",
      corpus_hash: admitted.pins.corpusHash,
      subset_hash: admitted.pins.subsetHash,
      uv_lock_hash: admitted.pins.uvLockHash
    },
    capacity: admitted.capacity
  };

  try {
    await phase(journal, "preflight", "started");
    await directory.writeJson("config.resolved.json", config);
    await phase(journal, "preflight", "completed");

    await phase(journal, "source_attempts", "started");
    for (const task of tasks) {
      const id = `source:${task.taskDigest}`;
      const taskRoot = `source/${safeTaskName(task.name)}`;
      await journal.append({
        type: "attempt_state",
        attemptId: id,
        executionGeneration: 1,
        state: "admitted"
      });
      const lifecycle = createCoordinatorHarborLifecycle({
        attemptId: id,
        executionGeneration: 1,
        journal,
        activateCredential: () => undefined,
        revokeCredential: () => undefined
      });
      const source = await dependencies.runSource({
        task,
        attemptId: id,
        executionGeneration: 1,
        runRoot: directory.root,
        freezeTrajectoryPath: `${taskRoot}/frozen-trajectory.json`,
        freezeManifestPath: `${taskRoot}/freeze-manifest.json`,
        lifecycle,
        config
      });
      const resultPath = sourceResultPathFor(task);
      await directory.writeJson(resultPath, {
        attemptId: id,
        executionGeneration: 1,
        reward: source.reward,
        passed: source.passed,
        result: source.result
      });
      await journal.append({
        type: "attempt_result",
        attemptId: id,
        executionGeneration: 1,
        resultPath,
        reward: source.reward,
        failureCategory: source.reward === null ? "missing_outcome" : null
      });
      sources.set(task.taskDigest, {
        ...source,
        task
      });
    }
    await phase(journal, "source_attempts", "completed");

    await phase(journal, "atif_sanitization", "started");
    for (const task of tasks) {
      const source = sources.get(task.taskDigest);
      if (!source) throw new Error(`Missing source attempt for ${task.name}`);
      const sanitization = sanitizeAtifTrajectory(source.frozenTrajectory, {
        taskDigest: task.taskDigest,
        sourceAttemptId: `source:${task.taskDigest}`,
        countEmbeddingTokens: dependencies.countEmbeddingTokens,
        freezeManifest: source.freezeManifest
      });
      source.sanitization = sanitization;
      const taskRoot = `source/${safeTaskName(task.name)}`;
      await directory.writeJson(
        `${taskRoot}/sanitization.json`,
        sanitization.manifest
      );
      await publishOrVerifyArtifact(
        directory.root,
        `${taskRoot}/sanitized-trajectory.json`,
        `${sanitization.canonicalJson}\n`
      );
    }
    await phase(journal, "atif_sanitization", "completed");

    await phase(journal, "placebo_assignment", "started");
    const assignment = assignMatchedPlacebos(
      tasks.map((task) => {
        const source = sources.get(task.taskDigest)!;
        return {
          taskDigest: task.taskDigest,
          category: task.category,
          sourcePassed: source.passed,
          sanitizedTokenQuartile: source.sanitizedTokenQuartile,
          expertTimeSeconds: task.expertTimeSeconds,
          resourceClass: task.resourceClass
        };
      }),
      config.seed
    );
    verifyPlaceboAssignment(assignment);
    await directory.writeJson("placebo-assignment.json", assignment);
    await phase(journal, "placebo_assignment", "completed");

    await phase(journal, "canonical_koed_ingestion", "started");
    for (const task of tasks) {
      for (const condition of ["empty", "placebo", "relevant"] as const) {
        const sourceDigest =
          condition === "empty"
            ? null
            : condition === "relevant"
              ? task.taskDigest
              : (assignment.assignments.find(
                  (item) => item.targetDigest === task.taskDigest
                )?.sourceDigest ?? null);
        if (condition !== "empty" && !sourceDigest)
          throw new Error(`Missing ${condition} source for ${task.name}`);
        const source = sourceDigest ? sources.get(sourceDigest) : undefined;
        const prepared = await dependencies.prepareTemplate({
          task,
          condition,
          sourceTask: source?.task ?? null,
          sanitizedSource: source?.sanitization ?? null,
          runRoot: directory.root,
          config
        });
        assertProductAttestation(
          prepared.attestation,
          `${task.name} ${condition} template`
        );
        const key = `${task.taskDigest}:${condition}`;
        if (templates.has(key)) throw new Error(`Duplicate template ${key}`);
        templates.set(key, prepared);
        templateRecords.push({
          taskDigest: task.taskDigest,
          condition,
          sourceTaskDigest: sourceDigest,
          template: prepared
        });
      }
    }
    await phase(journal, "canonical_koed_ingestion", "completed");
    await phase(journal, "semantic_readiness", "started");
    await phase(journal, "semantic_readiness", "completed");
    await phase(journal, "template_creation", "started");
    await directory.writeJson("templates.json", templateRecords);
    await phase(journal, "template_creation", "completed");

    await phase(journal, "replay_schedule", "started");
    const schedule = createReplaySchedule(
      tasks.map((task) => task.taskDigest),
      config.replay_attempts_per_condition,
      config.seed
    );
    verifyReplaySchedule(schedule);
    await directory.writeJson("schedule.json", schedule);
    await phase(journal, "replay_schedule", "completed");

    await phase(journal, "replay_execution", "started");
    const taskByDigest = new Map(tasks.map((task) => [task.taskDigest, task]));
    for (const entry of schedule.entries) {
      const task = taskByDigest.get(entry.taskDigest);
      if (!task) throw new Error(`Scheduled unknown task ${entry.taskDigest}`);
      for (const condition of entry.conditions) {
        const id = attemptId(task.taskDigest, condition, entry.repeat);
        const template =
          condition === "cold"
            ? null
            : (templates.get(`${task.taskDigest}:${condition}`) ?? null);
        if (condition !== "cold" && !template)
          throw new Error(`Missing ${condition} template for ${task.name}`);
        const sourceTaskDigest =
          condition === "relevant"
            ? task.taskDigest
            : condition === "placebo"
              ? (assignment.assignments.find(
                  (item) => item.targetDigest === task.taskDigest
                )?.sourceDigest ?? null)
              : null;
        await journal.append({
          type: "attempt_state",
          attemptId: id,
          executionGeneration: 1,
          state: "admitted"
        });
        const replay = await dependencies.createReplay({
          task,
          condition,
          repeat: entry.repeat,
          executionGeneration: 1,
          template,
          sourceTaskDigest,
          runRoot: directory.root,
          config
        });
        if (condition === "cold") {
          if (replay.cloneId !== null || replay.productPathAttestation !== null)
            throw new Error("Cold replay must have no Koed product resources");
        } else {
          if (!replay.cloneId)
            throw new Error("Koed replay lacks a fresh database clone");
          if (cloneIds.has(replay.cloneId))
            throw new Error(
              `Replay database clone was reused: ${replay.cloneId}`
            );
          cloneIds.add(replay.cloneId);
          assertProductAttestation(
            replay.productPathAttestation,
            `${task.name} ${condition} replay`
          );
          productPathExercised = true;
        }
        const lifecycleState = { activated: false, revoked: false };
        const lifecycle = createCoordinatorHarborLifecycle({
          attemptId: id,
          executionGeneration: 1,
          journal,
          activateCredential: async () => {
            await replay.activateCredential();
            lifecycleState.activated = true;
          },
          revokeCredential: async () => {
            await replay.revokeCredential();
            lifecycleState.revoked = true;
          }
        });
        try {
          const telemetry = await replay.run({ lifecycle });
          if (!lifecycleState.activated)
            throw new Error(
              "Harbor replay returned without an acknowledged agent start"
            );
          if (!lifecycleState.revoked)
            throw new Error(
              "Harbor replay returned without lifecycle credential revocation"
            );
          validateReplayIdentity(telemetry, task, condition, entry.repeat);
          const merged = mergeReplayTelemetry(telemetry);
          const resultPath = resultPathFor(task, condition, entry.repeat);
          await directory.writeJson(resultPath, {
            ...merged.outcome,
            attemptId: id,
            executionGeneration: 1,
            sourceTaskDigest,
            cloneId: replay.cloneId
          });
          await journal.append({
            type: "attempt_result",
            attemptId: id,
            executionGeneration: 1,
            resultPath,
            reward: merged.outcome.reward,
            failureCategory: merged.outcome.failureCategory ?? null
          });
          outcomes.push(merged.outcome);
        } finally {
          await replay.revokeCredential();
          await replay.close();
        }
      }
    }
    await phase(journal, "replay_execution", "completed");
    await phase(journal, "metric_merge", "started");
    await phase(journal, "metric_merge", "completed");
    await directory.writeJson("manifest.json", {
      ...manifest,
      execution_boundary: {
        deterministic_no_paid_or_network_calls: config.profile === "smoke",
        product_path_exercised: productPathExercised,
        product_path_attestation_required: true,
        terminal_bench_estimate: config.profile !== "smoke"
      }
    });
    await phase(journal, "report_generation", "started");
    await reportFromOutcomes(directory.root, config, tasks, outcomes);
    await phase(journal, "report_generation", "completed");
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    await phase(journal, "teardown", "started").catch(() => undefined);
    try {
      await dependencies.teardown();
      await phase(journal, "teardown", "completed");
    } catch (cleanupError) {
      await phase(
        journal,
        "teardown",
        "blocked",
        "Resource teardown failed"
      ).catch(() => undefined);
      if (!primaryFailure) throw cleanupError;
    }
  }

  if (!productPathExercised)
    throw new Error("No replay exercised the attested Koed product path");
  return {
    runDirectory: directory.root,
    reportPath: path.join(directory.root, "report/summary.md"),
    replayAttemptCount: outcomes.length,
    productPathExercised: true
  };
};

/** Compatibility name; unlike the old implementation this runs the unified path. */
export const runSmokeExperienceReplay = (
  config: ResolvedExperienceReplayConfig,
  preflight?: PreflightResult,
  dependencies?: ExperienceReplayCoordinatorDependencies
): Promise<ExperienceReplayRunResult> =>
  runExperienceReplay(config, { preflight, dependencies });

const expectedReplayAttempts = (schedule: ReplaySchedule): string[] =>
  schedule.entries.flatMap((entry) =>
    entry.conditions.map((condition) =>
      attemptId(entry.taskDigest, condition, entry.repeat)
    )
  );

const replayOutcomeFromArtifact = (value: ReplayOutcome): ReplayOutcome => {
  const clone = structuredClone(value);
  delete (clone as ReplayOutcome & { attemptId?: unknown }).attemptId;
  delete (clone as ReplayOutcome & { executionGeneration?: unknown })
    .executionGeneration;
  delete (clone as ReplayOutcome & { sourceTaskDigest?: unknown })
    .sourceTaskDigest;
  delete (clone as ReplayOutcome & { cloneId?: unknown }).cloneId;
  return clone;
};

const outcomesFromRun = async (
  runRoot: string,
  schedule: ReplaySchedule,
  entries: readonly RunJournalEntry[]
): Promise<ReplayOutcome[]> => {
  const completed = new Map(
    entries
      .filter(
        (
          entry
        ): entry is Extract<RunJournalEntry, { type: "attempt_result" }> =>
          entry.type === "attempt_result" &&
          entry.attemptId.startsWith("replay:")
      )
      .map((entry) => [entry.attemptId, entry])
  );
  const outcomes: ReplayOutcome[] = [];
  for (const scheduleEntry of schedule.entries) {
    for (const condition of scheduleEntry.conditions) {
      const id = attemptId(
        scheduleEntry.taskDigest,
        condition,
        scheduleEntry.repeat
      );
      const result = completed.get(id);
      outcomes.push(
        result
          ? replayOutcomeFromArtifact(
              await readJsonArtifact<ReplayOutcome>(runRoot, result.resultPath)
            )
          : {
              taskDigest: scheduleEntry.taskDigest,
              condition,
              repeat: scheduleEntry.repeat,
              reward: null
            }
      );
    }
  }
  return outcomes;
};

const verifyResolvedConfig = (config: ResolvedExperienceReplayConfig): void => {
  const storedHash = config.semantic_config_hash;
  const hashableConfig = Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => key !== "semantic_config_hash" && key !== "output_dir"
    )
  );
  if (immutableHash(hashableConfig) !== storedHash)
    throw new Error("Material configuration changed; refusing run artifact");
};

const tasksFromManifest = async (
  runRoot: string,
  config: ResolvedExperienceReplayConfig
): Promise<CoordinatorTask[]> => {
  const manifest = await readJsonArtifact<{ task_digests: string[] }>(
    runRoot,
    "manifest.json"
  );
  const admitted = await preflightExperienceReplay({
    config,
    requireRunnable: false,
    confirmPaidRun: config.profile !== "smoke"
  });
  const tasks = selectedTasks(admitted);
  if (
    immutableHash(tasks.map((task) => task.taskDigest)) !==
    immutableHash(manifest.task_digests)
  )
    throw new Error("Pinned task digest set changed; refusing run artifact");
  return tasks;
};

export const reportExistingRun = async (
  runDirectory: string
): Promise<string> => {
  const runRoot = await validateExistingRunDirectory(
    runDirectory,
    EXPERIENCE_REPLAY_REPOSITORY_ROOT
  );
  const config = await readJsonArtifact<ResolvedExperienceReplayConfig>(
    runRoot,
    "config.resolved.json"
  );
  verifyResolvedConfig(config);
  const schedule = await readJsonArtifact<ReplaySchedule>(
    runRoot,
    "schedule.json"
  );
  verifyReplaySchedule(schedule);
  const entries = await readRunJournal(
    path.join(runRoot, "journal.jsonl"),
    config.semantic_config_hash
  );
  await reportFromOutcomes(
    runRoot,
    config,
    await tasksFromManifest(runRoot, config),
    await outcomesFromRun(runRoot, schedule, entries)
  );
  return path.join(runRoot, "report/summary.md");
};

export const reportExistingSmokeRun = reportExistingRun;

/**
 * Resume is deliberately read-only until a resource adapter can re-attest the
 * persisted templates. It still enforces the no-rerun-after-agent-start rule.
 */
export const resumeExperienceReplay = async (
  runDirectory: string
): Promise<string> => {
  const runRoot = await validateExistingRunDirectory(
    runDirectory,
    EXPERIENCE_REPLAY_REPOSITORY_ROOT
  );
  const config = await readJsonArtifact<ResolvedExperienceReplayConfig>(
    runRoot,
    "config.resolved.json"
  );
  verifyResolvedConfig(config);
  const schedule = await readJsonArtifact<ReplaySchedule>(
    runRoot,
    "schedule.json"
  );
  verifyReplaySchedule(schedule);
  const entries = await readRunJournal(
    path.join(runRoot, "journal.jsonl"),
    config.semantic_config_hash
  );
  const decisions = planAttemptResume(
    expectedReplayAttempts(schedule),
    entries
  );
  const rerunnable = decisions.filter(
    (decision) => decision.action === "rerun_before_agent"
  );
  if (rerunnable.length) {
    throw new ProductPathPrerequisiteError([
      `resume requires a template re-attestation adapter for ${rerunnable.length} pre-agent attempt(s)`
    ]);
  }
  return reportExistingRun(runRoot);
};

export const resumeSmokeRun = resumeExperienceReplay;

export const sanitizeRunReport = async (
  runDirectory: string
): Promise<string> => {
  const runRoot = await validateExistingRunDirectory(
    runDirectory,
    EXPERIENCE_REPLAY_REPOSITORY_ROOT
  );
  const report = await readJsonArtifact<unknown>(
    runRoot,
    "report/summary.json"
  );
  const publicationRoot = `${runRoot}.publication`;
  const created = await SafeRunDirectory.create({
    outputPath: publicationRoot,
    repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT,
    requiredBytes: 0,
    reserveBytes: 0
  });
  await created.directory.writeJson(
    "summary.json",
    redactPublicationReport(report)
  );
  const markdown = await readFile(
    path.join(runRoot, "report/summary.md"),
    "utf8"
  );
  await writeTextArtifactAtomic(
    created.directory.root,
    "summary.md",
    String(redactPublicationReport(markdown))
  );
  return created.directory.root;
};

export const coordinatorArtifactHash = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
