import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assignMatchedPlacebos,
  assignProductPathProofPlacebo,
  createMachineReport,
  createReplaySchedule,
  immutableHash,
  redactPublicationReport,
  renderMarkdownReport,
  REQUIRED_COMPARISONS,
  SMOKE_TASK_DIGESTS,
  summarizeComparison,
  TRAJECTORY_JUDGE_SCHEMA_VERSION,
  verifyPlaceboAssignment,
  verifyExperienceReplayRunPlan,
  verifyReplaySchedule,
  type ReplayCondition,
  type ReplayOutcome,
  type ReplaySchedule,
  type ExperienceReplayRunPlan,
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
  type PreflightResult,
  type RecordedRunAttestation
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
  validateArtifactRelativePath,
  validateExistingRunDirectory,
  writeTextArtifactAtomic
} from "./artifacts.js";
import { createCoordinatorHarborLifecycle } from "./harbor-lifecycle.js";
import { CostAdmissionController } from "./cost-admission.js";
import type { LocalProductTemplateAttestation } from "./local-product-adapter.js";
import {
  scheduleReplayJobs,
  type ReplaySchedulerJob
} from "./replay-scheduler.js";
import {
  assertCompleteReplayTelemetry,
  mergeReplayTelemetry,
  type ReplayTelemetryMergeInput
} from "./telemetry.js";
import { acquireRunLease } from "./run-lease.js";
import type {
  TrajectoryJudgeInput,
  TrajectoryJudgeResult
} from "./trajectory-judge.js";

const SMOKE_TASKS: readonly CoordinatorTask[] = [
  {
    name: "terminal-bench/synthetic-alpha",
    taskDigest: SMOKE_TASK_DIGESTS[0],
    category: "synthetic",
    expertTimeSeconds: 1,
    resourceClass: "synthetic-cpu",
    reward: { minimum: 0, maximum: 1, successValue: 1 }
  },
  {
    name: "terminal-bench/synthetic-beta",
    taskDigest: SMOKE_TASK_DIGESTS[1],
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
  failureCategory: string | null;
  costUsd: number;
  /** Source metadata only. Replay observations must never influence matching. */
  sanitizedTokenQuartile: 0 | 1 | 2 | 3;
  result: Record<string, unknown>;
}

export interface ReplayProductPathAttestation {
  schema: "koed-experience-replay-product-path-v1";
  cloneId: string;
  templateId: string;
  templateAttestationHash: string;
  databaseName: string;
  apiOrigin: string;
  redisEndpointHash: string;
  mcpBridgeOrigin: string;
  localAiRuntimeOrigin: string;
}

export interface PreparedTemplate {
  templateId: string;
  sourceStateHash: string;
  attestation: LocalProductTemplateAttestation;
  preparationCostUsd: number;
}

export interface ReplayExecutionHandle {
  /** Unique database clone identity for this execution generation. */
  cloneId: string | null;
  productPathAttestation: ReplayProductPathAttestation | null;
  activateCredential(): void | Promise<void>;
  revokeCredential(): void | Promise<void>;
  run(input: {
    lifecycle: ReturnType<typeof createCoordinatorHarborLifecycle>;
    signal?: AbortSignal;
  }): Promise<{
    telemetry: ReplayTelemetryMergeInput;
    replayTrajectoryArtifact: {
      path: string;
      sha256: string;
      freezeManifest: HarborFreezeManifest;
    };
  }>;
  close(): Promise<void>;
}

export interface ExperienceReplayCoordinatorDependencies {
  /** Random persisted identity for one physical run, separate from semantics. */
  readonly runId?: string;
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
    signal?: AbortSignal;
  }): Promise<SourceAttemptExecution>;
  prepareTemplate(input: {
    task: CoordinatorTask;
    condition: "empty" | "placebo" | "relevant";
    sourceTask: CoordinatorTask | null;
    sanitizedSource: AtifSanitizationResult | null;
    runRoot: string;
    config: ResolvedExperienceReplayConfig;
    signal?: AbortSignal;
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
    signal?: AbortSignal;
  }): Promise<ReplayExecutionHandle>;
  judgeTrajectory(input: TrajectoryJudgeInput): Promise<TrajectoryJudgeResult>;
  adoptTemplate?(template: PreparedTemplate): Promise<PreparedTemplate>;
  teardown(options?: { preserveTemplates?: boolean }): Promise<void>;
  /** Redacted cleanup proofs exposed by concrete product adapters. */
  cleanupAttestations?(): readonly unknown[];
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
  runSource: () => Promise.resolve().then(() => missingDependencies()),
  prepareTemplate: () => Promise.resolve().then(() => missingDependencies()),
  createReplay: () => Promise.resolve().then(() => missingDependencies()),
  judgeTrajectory: () => Promise.resolve().then(() => missingDependencies()),
  teardown: () => Promise.resolve()
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

const publishOrVerifyJson = async (
  runRoot: string,
  relativePath: string,
  value: unknown
): Promise<void> =>
  publishOrVerifyArtifact(
    runRoot,
    relativePath,
    `${JSON.stringify(value, null, 2)}\n`
  );

const publishAttemptResult = async (
  directory: SafeRunDirectory,
  journal: RunJournal,
  input: {
    attemptId: string;
    executionGeneration: number;
    resultPath: string;
    artifact: Record<string, unknown>;
    reward: number | null;
    failureCategory: string | null;
  }
): Promise<void> => {
  const artifact = {
    ...input.artifact,
    attemptId: input.attemptId,
    executionGeneration: input.executionGeneration
  };
  const contents = `${JSON.stringify(artifact, null, 2)}\n`;
  await publishOrVerifyArtifact(directory.root, input.resultPath, contents);
  await journal.append({
    type: "attempt_result",
    attemptId: input.attemptId,
    executionGeneration: input.executionGeneration,
    resultPath: input.resultPath,
    resultSha256: coordinatorArtifactHash(contents),
    resultIdentity: {
      attemptId: input.attemptId,
      executionGeneration: input.executionGeneration
    },
    reward: input.reward,
    failureCategory: input.failureCategory
  });
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
  runPlan: ExperienceReplayRunPlan,
  tasks: readonly CoordinatorTask[],
  outcomes: readonly ReplayOutcome[],
  trajectoryJudgments: readonly TrajectoryJudgeResult[],
  preparationCostUsd = 0,
  runId = immutableHash({
    config: config.semantic_config_hash,
    tasks: tasks.map(({ taskDigest }) => taskDigest)
  }).slice(0, 16)
): Promise<void> => {
  const contracts = taskContracts(tasks);
  const comparisons = REQUIRED_COMPARISONS.map((comparison) =>
    summarizeComparison(
      outcomes,
      contracts,
      comparison,
      runPlan.replayAttemptsPerCondition
    )
  );
  const report = createMachineReport({
    runId,
    executionKind: runPlan.kind,
    codexAuthMode: runPlan.codexAuthMode,
    profile: config.profile,
    model: config.coding_agent.id,
    taskCount: tasks.length,
    attemptedReplayCount: outcomes.length,
    failureCount: outcomes.filter((outcome) => outcome.reward === null).length,
    preparationCostUsd,
    judgeOverheadCostUsd: trajectoryJudgments.every(
      (judgment) => judgment.costUsd !== null
    )
      ? trajectoryJudgments.reduce(
          (total, judgment) => total + judgment.costUsd!,
          0
        )
      : null,
    comparisons,
    trajectoryJudgments,
    attempts: outcomes,
    exclusions: [],
    detailFiles: [
      "manifest.json",
      "schedule.json",
      "journal.jsonl",
      "preparation-telemetry.json",
      "cost-admission.json",
      "judge/results.json",
      "attestations/preflight.json",
      "attestations/product-path.json",
      "attestations/cleanup.json"
    ]
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

const replayTargetTasks = (
  runPlan: ExperienceReplayRunPlan,
  tasks: readonly CoordinatorTask[]
): CoordinatorTask[] => {
  const byDigest = new Map(tasks.map((task) => [task.taskDigest, task]));
  return runPlan.replayTargetTaskDigests.map((taskDigest) => {
    const task = byDigest.get(taskDigest);
    if (!task)
      throw new Error(`Pinned replay target is missing: ${taskDigest}`);
    return task;
  });
};

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/u;

const assertTemplateAttestation: (
  value: LocalProductTemplateAttestation | null,
  label: string
) => asserts value is LocalProductTemplateAttestation = (value, label) => {
  if (
    !value ||
    value.schema !== "koed-experience-replay-local-product-template-v1" ||
    value.database.migrationsCurrent !== true ||
    value.readiness.ready !== true ||
    value.frozenDatabase.allowConnections !== false ||
    value.frozenDatabase.isTemplate !== true ||
    value.identity.apiToken.ownerUserId !== value.identity.user.id ||
    value.project.ownerUserId !== value.identity.user.id ||
    !SHA256.test(value.database.stateHash)
  ) {
    throw new Error(`${label} lacks a complete template attestation`);
  }
};

const assertReplayAttestation = (
  value: ReplayProductPathAttestation | null,
  cloneId: string,
  template: PreparedTemplate,
  label: string
): void => {
  if (
    !value ||
    value.schema !== "koed-experience-replay-product-path-v1" ||
    value.cloneId !== cloneId ||
    value.databaseName !== cloneId ||
    value.templateId !== template.templateId ||
    value.templateAttestationHash !== immutableHash(template.attestation) ||
    !SHA256.test(value.redisEndpointHash)
  ) {
    throw new Error(`${label} lacks a complete runtime attestation`);
  }
  for (const [origin, name] of [
    [value.apiOrigin, "API"],
    [value.mcpBridgeOrigin, "MCP bridge"],
    [value.localAiRuntimeOrigin, "Local AI Runtime"]
  ] as const) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
      throw new Error(`${label} ${name} is not isolated to loopback`);
    }
  }
};

const resultPathFor = (
  task: CoordinatorTask,
  condition: ReplayCondition,
  repeat: number,
  generation: number
) =>
  `attempts/${safeTaskName(task.name)}/${condition}/${repeat}/generation-${generation}/result.json`;

const failureResultPathFor = (
  task: CoordinatorTask,
  condition: ReplayCondition,
  repeat: number,
  generation: number
) =>
  `attempts/${safeTaskName(task.name)}/${condition}/${repeat}/generation-${generation}/failure-result.json`;

const sourceResultPathFor = (task: CoordinatorTask, generation: number) =>
  `source/${safeTaskName(task.name)}/generation-${generation}/result.json`;

const replaySanitizedTrajectoryPathFor = (
  task: CoordinatorTask,
  condition: ReplayCondition,
  repeat: number,
  generation: number
) =>
  `attempts/${safeTaskName(task.name)}/${condition}/${repeat}/generation-${generation}/sanitized-trajectory.json`;

const judgeResultPathFor = (
  task: CoordinatorTask,
  comparison: { left: ReplayCondition; right: ReplayCondition },
  repeat: number
) =>
  `judge/${safeTaskName(task.name)}/${comparison.left}-versus-${comparison.right}/repeat-${repeat}.json`;

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

const failedReplayOutcome = (
  task: CoordinatorTask,
  condition: ReplayCondition,
  repeat: number,
  input: {
    category:
      | "admission_rejected"
      | "setup_failed"
      | "setup_timeout"
      | "agent_failed"
      | "agent_timeout"
      | "teardown_failed"
      | "missing_outcome";
    phase: "admission" | "setup" | "agent" | "teardown";
    costUsd: number;
    kind?: "agent" | "infrastructure";
  }
): ReplayOutcome => ({
  taskDigest: task.taskDigest,
  condition,
  repeat,
  reward: null,
  passed: null,
  costUsd: input.costUsd,
  failureCategory: input.category,
  failureKind: input.kind ?? "infrastructure",
  failurePhase: input.phase
});

const schedulerTelemetry = <T>(
  results: readonly import("./replay-scheduler.js").ReplaySchedulerJobResult<T>[]
) =>
  results.map((result) => ({
    id: result.id,
    status: result.status,
    admitted: result.admitted,
    observedCostUsd: result.observedCostUsd,
    ...(result.status === "not_started" ? { reason: result.reason } : {})
  }));

const readAttestedResult = async <T>(
  runRoot: string,
  entry: Extract<RunJournalEntry, { type: "attempt_result" }>
): Promise<T> => {
  const contents = await readTextFileNoFollow(
    path.join(runRoot, entry.resultPath),
    64 * 1024 * 1024
  );
  if (coordinatorArtifactHash(contents) !== entry.resultSha256)
    throw new Error(`Attempt ${entry.attemptId} result digest changed`);
  const value = JSON.parse(contents) as T & {
    attemptId?: unknown;
    executionGeneration?: unknown;
  };
  if (
    value.attemptId !== entry.attemptId ||
    value.executionGeneration !== entry.executionGeneration
  )
    throw new Error(`Attempt ${entry.attemptId} result identity changed`);
  return value;
};

const completedEntry = (
  entries: readonly RunJournalEntry[],
  id: string
): Extract<RunJournalEntry, { type: "attempt_result" }> | undefined =>
  entries.find(
    (entry): entry is Extract<RunJournalEntry, { type: "attempt_result" }> =>
      entry.type === "attempt_result" && entry.attemptId === id
  );

const artifactExists = async (
  runRoot: string,
  relativePath: string
): Promise<boolean> => {
  try {
    await readTextFileNoFollow(path.join(runRoot, relativePath), 1);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // A size-limit error still proves a regular, non-symlink artifact exists.
    if ((error as Error).message.includes("exceeds")) return true;
    throw error;
  }
};

export const runExperienceReplay = async (
  config: ResolvedExperienceReplayConfig,
  options: {
    preflight?: PreflightResult;
    dependencies?: ExperienceReplayCoordinatorDependencies;
    resumeRunDirectory?: string;
  } = {}
): Promise<ExperienceReplayRunResult> => {
  const dependencies = options.dependencies ?? defaultDependencies;
  if (!options.dependencies) missingDependencies();
  const admitted =
    options.preflight ?? (await preflightExperienceReplay({ config }));
  if (admitted.config.semantic_config_hash !== config.semantic_config_hash)
    throw new Error("Preflight configuration differs from coordinator config");
  verifyExperienceReplayRunPlan(admitted.runPlan);
  const tasks = selectedTasks(admitted);
  if (
    immutableHash(tasks.map((task) => task.taskDigest)) !==
    immutableHash(admitted.runPlan.sourceTaskDigests)
  ) {
    throw new Error(
      "Preflight source tasks differ from the immutable run plan"
    );
  }
  const replayTasks = replayTargetTasks(admitted.runPlan, tasks);

  const outputPath = options.resumeRunDirectory ?? config.output_dir;
  if (
    options.resumeRunDirectory &&
    path.resolve(options.resumeRunDirectory) !== path.resolve(config.output_dir)
  )
    throw new Error("Resolved configuration output directory differs from run");
  const created = await SafeRunDirectory.create({
    outputPath,
    repositoryRoot: admitted.repositoryRoot,
    requiredBytes: admitted.capacity.requiredBytes,
    reserveBytes: admitted.capacity.reserveBytes
  });
  const directory = created.directory;
  const priorEntries = options.resumeRunDirectory
    ? await readRunJournal(
        path.join(directory.root, "journal.jsonl"),
        config.semantic_config_hash
      )
    : [];
  const journal = new RunJournal(
    directory,
    config.semantic_config_hash,
    priorEntries
  );
  const sources = new Map<string, SourceRecord>();
  const templates = new Map<string, PreparedTemplate>();
  const templateRecords: PersistedTemplate[] = [];
  const outcomes: ReplayOutcome[] = [];
  const trajectoryJudgments: TrajectoryJudgeResult[] = [];
  const replayTrajectories = new Map<
    string,
    AtifSanitizationResult["trajectory"]
  >();
  const cloneIds = new Set<string>();
  const productPathAttestations: Array<{
    attemptId: string;
    attestation: ReplayProductPathAttestation;
  }> = [];
  const costAdmission =
    config.profile === "smoke"
      ? undefined
      : new CostAdmissionController(
          config.paid_cost_stop_usd!,
          config.admission.provider_spending_limit_usd!,
          config.concurrency
        );
  let preparationCostUsd: number;
  let productPathExercised = false;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  const priorManifest = options.resumeRunDirectory
    ? await readJsonArtifact<
        {
          run_id: string;
          configuration_hash: string;
          profile: string;
          task_digests: string[];
          replay_task_digests: string[];
          run_plan: ExperienceReplayRunPlan;
        } & Record<string, unknown>
      >(directory.root, "manifest.json")
    : undefined;
  if (options.resumeRunDirectory && config.profile !== "smoke") {
    const priorPreflight = await readJsonArtifact<{
      recordedRunAttestation: PreflightResult["recordedRunAttestation"];
    }>(directory.root, "attestations/preflight.json");
    if (
      !priorPreflight.recordedRunAttestation ||
      !admitted.recordedRunAttestation ||
      immutableHash(priorPreflight.recordedRunAttestation) !==
        immutableHash(admitted.recordedRunAttestation)
    ) {
      throw new Error(
        "Recorded runtime attestation differs from the persisted run"
      );
    }
  }
  const runId = priorManifest?.run_id ?? dependencies.runId ?? randomUUID();
  if (dependencies.runId && dependencies.runId !== runId) {
    throw new Error("Runtime adapter run identity differs from persisted run");
  }
  const proposedManifest = {
    manifest_version: 1,
    benchmark_kind: "koed_experience_replay",
    execution_kind: admitted.runPlan.kind,
    run_id: runId,
    standard_leaderboard_comparable: false,
    profile: config.profile,
    configuration_hash: config.semantic_config_hash,
    task_digests: tasks.map((task) => task.taskDigest),
    replay_task_digests: replayTasks.map((task) => task.taskDigest),
    run_plan: admitted.runPlan,
    pins: {
      harbor_commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
      terminal_bench_commit: "2b0442c3c583b710ca8da14c8e601b99f2f1f244",
      corpus_hash: admitted.pins.corpusHash,
      subset_hash: admitted.pins.subsetHash,
      uv_lock_hash: admitted.pins.uvLockHash
    },
    capacity: admitted.capacity,
    execution_boundary: {
      deterministic_no_paid_or_network_calls: config.profile === "smoke",
      product_path_attestation_required: true,
      terminal_bench_estimate: admitted.runPlan.terminalBenchEstimate
    }
  };
  if (
    priorManifest &&
    (priorManifest.configuration_hash !== config.semantic_config_hash ||
      priorManifest.profile !== config.profile ||
      immutableHash(priorManifest.task_digests) !==
        immutableHash(tasks.map((task) => task.taskDigest)) ||
      immutableHash(priorManifest.replay_task_digests) !==
        immutableHash(replayTasks.map((task) => task.taskDigest)) ||
      immutableHash(priorManifest.run_plan) !== immutableHash(admitted.runPlan))
  ) {
    throw new Error("Persisted run manifest differs from resolved execution");
  }
  const manifest = priorManifest ?? proposedManifest;
  const lease = await acquireRunLease(directory.root);

  try {
    await phase(journal, "preflight", "started");
    await publishOrVerifyJson(directory.root, "config.resolved.json", config);
    await publishOrVerifyJson(directory.root, "manifest.json", manifest);
    if (!options.resumeRunDirectory)
      await publishOrVerifyJson(directory.root, "attestations/preflight.json", {
        schema: "koed-experience-replay-preflight-v1",
        repositoryRoot: admitted.repositoryRoot,
        runPlan: admitted.runPlan,
        pins: admitted.pins,
        capacity: admitted.capacity,
        recordedModelPathReady: admitted.recordedModelPathReady,
        recordedRunAttestation: admitted.recordedRunAttestation
      });
    await phase(journal, "preflight", "completed");

    const schedule = createReplaySchedule(
      replayTasks.map((task) => task.taskDigest),
      admitted.runPlan.replayAttemptsPerCondition,
      config.seed
    );
    verifyReplaySchedule(schedule);
    await phase(journal, "replay_schedule", "started");
    await publishOrVerifyJson(directory.root, "schedule.json", schedule);
    await phase(journal, "replay_schedule", "completed");

    await phase(journal, "source_attempts", "started");
    const sourceJobs: ReplaySchedulerJob<SourceRecord>[] = [];
    const sourceDecisions = new Map(
      planAttemptResume(
        tasks.map((task) => `source:${task.taskDigest}`),
        priorEntries
      ).map((decision) => [decision.attemptId, decision])
    );
    for (const task of tasks) {
      const id = `source:${task.taskDigest}`;
      const decision = sourceDecisions.get(id)!;
      if (decision.action === "skip_completed") {
        const entry = completedEntry(priorEntries, id)!;
        const source = await readAttestedResult<SourceAttemptExecution>(
          directory.root,
          entry
        );
        if (source.failureCategory === "other")
          throw new Error(
            `Source ${task.name} failed in Harbor runtime or environment setup`
          );
        sources.set(task.taskDigest, { ...source, task });
        continue;
      }
      if (decision.action === "preserve_missing") {
        const generation = decision.nextExecutionGeneration;
        const resultPath = sourceResultPathFor(task, generation);
        await publishAttemptResult(directory, journal, {
          attemptId: id,
          executionGeneration: generation,
          resultPath,
          artifact: {
            reward: null,
            passed: false,
            costUsd:
              config.profile === "smoke"
                ? 0
                : config.maximum_top_level_attempt_cost_usd,
            failureCategory: "missing_outcome"
          },
          reward: null,
          failureCategory: "missing_outcome"
        });
        throw new Error(
          `Source ${task.name} crossed the irreversible agent boundary without a result; dependent preparation is forbidden`
        );
      }
      const generation = decision.nextExecutionGeneration;
      const taskRoot = `source/${safeTaskName(task.name)}/generation-${generation}`;
      sourceJobs.push({
        id,
        maximumCostUsd: Math.max(
          Number.EPSILON,
          config.maximum_top_level_attempt_cost_usd
        ),
        async run({ signal }) {
          await journal.append({
            type: "attempt_state",
            attemptId: id,
            executionGeneration: generation,
            state: "admitted"
          });
          const lifecycle = createCoordinatorHarborLifecycle({
            attemptId: id,
            executionGeneration: generation,
            journal,
            activateCredential: () => undefined,
            revokeCredential: () => undefined
          });
          if (signal.aborted)
            throw new Error("Source attempt was cancelled before Harbor start");
          const source = await dependencies.runSource({
            task,
            attemptId: id,
            executionGeneration: generation,
            runRoot: directory.root,
            freezeTrajectoryPath: `${taskRoot}/frozen-trajectory.json`,
            freezeManifestPath: `${taskRoot}/freeze-manifest.json`,
            lifecycle,
            config,
            signal
          });
          if (source.failureCategory === "other")
            throw new Error(
              `Source ${task.name} failed in Harbor runtime or environment setup`
            );
          const resultPath = sourceResultPathFor(task, generation);
          await publishAttemptResult(directory, journal, {
            attemptId: id,
            executionGeneration: generation,
            resultPath,
            artifact: { ...source },
            reward: source.reward,
            failureCategory: source.failureCategory
          });
          return {
            value: { ...source, task },
            observedCostUsd: source.costUsd
          };
        }
      });
    }
    const sourceSchedule = await scheduleReplayJobs({
      jobs: sourceJobs,
      concurrency: config.concurrency,
      ...(config.profile === "smoke"
        ? { mode: "smoke" as const }
        : {
            mode: "paid" as const,
            paidCostStopUsd: config.paid_cost_stop_usd!,
            providerSpendingLimitUsd:
              config.admission.provider_spending_limit_usd!,
            costAdmission
          })
    });
    for (const result of sourceSchedule.results) {
      if (result.status === "completed")
        sources.set(result.value.task.taskDigest, result.value);
      else if (result.status === "failed" || result.status === "cancelled")
        throw result.error;
      else throw new Error("Paid stop prevented the complete source cohort");
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
      await publishOrVerifyJson(
        directory.root,
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
    const placeboCandidates = tasks.map((task) => {
      const source = sources.get(task.taskDigest)!;
      return {
        taskDigest: task.taskDigest,
        category: task.category,
        sourcePassed: source.passed,
        sanitizedTokenQuartile: source.sanitizedTokenQuartile,
        expertTimeSeconds: task.expertTimeSeconds,
        resourceClass: task.resourceClass
      };
    });
    let assignment;
    if (admitted.runPlan.kind === "product_path_proof") {
      const targetDigest = admitted.runPlan.replayTargetTaskDigests[0];
      const target = placeboCandidates.find(
        (candidate) => candidate.taskDigest === targetDigest
      );
      const donor = placeboCandidates.find(
        (candidate) => candidate.taskDigest !== targetDigest
      );
      if (!target || !donor) {
        throw new Error("Product-path proof target or donor source is missing");
      }
      assignment = assignProductPathProofPlacebo(target, donor, config.seed);
    } else {
      assignment = assignMatchedPlacebos(placeboCandidates, config.seed);
    }
    verifyPlaceboAssignment(assignment);
    await publishOrVerifyJson(
      directory.root,
      "placebo-assignment.json",
      assignment
    );
    await phase(journal, "placebo_assignment", "completed");

    await phase(journal, "canonical_koed_ingestion", "started");
    await phase(journal, "semantic_readiness", "started");
    await phase(journal, "template_creation", "started");
    const replayDecisions = new Map(
      planAttemptResume(expectedReplayAttempts(schedule), priorEntries).map(
        (decision) => [decision.attemptId, decision]
      )
    );
    const neededTemplateKeys = new Set<string>();
    for (const scheduleEntry of schedule.entries) {
      for (const condition of scheduleEntry.conditions) {
        if (
          condition !== "cold" &&
          replayDecisions.get(
            attemptId(scheduleEntry.taskDigest, condition, scheduleEntry.repeat)
          )?.action === "rerun_before_agent"
        )
          neededTemplateKeys.add(`${scheduleEntry.taskDigest}:${condition}`);
      }
    }
    const templateJobs: ReplaySchedulerJob<PersistedTemplate>[] = [];
    for (const task of replayTasks) {
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
        const templatePath = `templates/${task.taskDigest.slice(-64)}/${condition}.json`;
        try {
          const persisted = await readJsonArtifact<PersistedTemplate>(
            directory.root,
            templatePath
          );
          if (
            persisted.taskDigest !== task.taskDigest ||
            persisted.condition !== condition ||
            persisted.sourceTaskDigest !== sourceDigest
          )
            throw new Error(
              `Persisted template identity changed: ${templatePath}`
            );
          assertTemplateAttestation(
            persisted.template.attestation,
            `${task.name} ${condition} persisted template`
          );
          let adopted = persisted.template;
          if (neededTemplateKeys.has(`${task.taskDigest}:${condition}`)) {
            if (!dependencies.adoptTemplate)
              throw new Error(
                "Runtime adapter cannot re-attest persisted templates"
              );
            adopted = await dependencies.adoptTemplate(persisted.template);
            assertTemplateAttestation(
              adopted.attestation,
              `${task.name} ${condition} adopted template`
            );
            if (immutableHash(adopted) !== immutableHash(persisted.template))
              throw new Error(
                `Adopted template identity changed: ${templatePath}`
              );
          }
          const record = { ...persisted, template: adopted };
          templates.set(`${task.taskDigest}:${condition}`, adopted);
          templateRecords.push(record);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        templateJobs.push({
          id: `template:${task.taskDigest}:${condition}`,
          maximumCostUsd: Math.max(
            Number.EPSILON,
            config.maximum_top_level_attempt_cost_usd
          ),
          async run({ signal }) {
            if (signal.aborted)
              throw new Error("Template preparation was cancelled");
            const prepared = await dependencies.prepareTemplate({
              task,
              condition,
              sourceTask: source?.task ?? null,
              sanitizedSource: source?.sanitization ?? null,
              runRoot: directory.root,
              config,
              signal
            });
            assertTemplateAttestation(
              prepared.attestation,
              `${task.name} ${condition} template`
            );
            if (
              !Number.isFinite(prepared.preparationCostUsd) ||
              prepared.preparationCostUsd < 0
            ) {
              throw new Error("Template preparation cost is invalid");
            }
            const record = {
              taskDigest: task.taskDigest,
              condition,
              sourceTaskDigest: sourceDigest,
              template: prepared
            };
            await publishOrVerifyJson(directory.root, templatePath, record);
            return {
              value: record,
              observedCostUsd: prepared.preparationCostUsd
            };
          }
        });
      }
    }
    const templateSchedule = await scheduleReplayJobs({
      jobs: templateJobs,
      concurrency: config.concurrency,
      ...(config.profile === "smoke"
        ? { mode: "smoke" as const }
        : {
            mode: "paid" as const,
            paidCostStopUsd: config.paid_cost_stop_usd!,
            providerSpendingLimitUsd:
              config.admission.provider_spending_limit_usd!,
            costAdmission
          })
    });
    if (
      !options.resumeRunDirectory ||
      !(await artifactExists(directory.root, "preparation-telemetry.json"))
    )
      await publishOrVerifyJson(directory.root, "preparation-telemetry.json", {
        schema: "koed-experience-replay-preparation-telemetry-v1",
        scheduler: templateSchedule.snapshot,
        jobs: schedulerTelemetry(templateSchedule.results)
      });
    preparationCostUsd =
      templateRecords.reduce(
        (sum, record) => sum + record.template.preparationCostUsd,
        0
      ) +
      templateSchedule.results.reduce(
        (sum, result) => sum + result.observedCostUsd,
        0
      );
    for (const result of templateSchedule.results) {
      if (result.status === "failed" || result.status === "cancelled")
        throw result.error;
      if (result.status !== "completed")
        throw new Error("Paid stop prevented the complete template cohort");
      const record = result.value;
      const key = `${record.taskDigest}:${record.condition}`;
      if (templates.has(key)) throw new Error(`Duplicate template ${key}`);
      templates.set(key, record.template);
      templateRecords.push(record);
    }
    await phase(journal, "canonical_koed_ingestion", "completed");
    await phase(journal, "semantic_readiness", "completed");
    templateRecords.sort((left, right) =>
      `${left.taskDigest}:${left.condition}`.localeCompare(
        `${right.taskDigest}:${right.condition}`
      )
    );
    await publishOrVerifyJson(
      directory.root,
      "templates.json",
      templateRecords
    );
    await phase(journal, "template_creation", "completed");

    await phase(journal, "replay_execution", "started");
    const taskByDigest = new Map(tasks.map((task) => [task.taskDigest, task]));
    const replayJobs: ReplaySchedulerJob<ReplayOutcome>[] = [];
    const replayJobMetadata: Array<{
      task: CoordinatorTask;
      condition: ReplayCondition;
      repeat: number;
    }> = [];
    const completedReplayTelemetry = new Map<
      string,
      { value: ReplayOutcome; observedCostUsd: number }
    >();
    for (const entry of schedule.entries) {
      for (const condition of entry.conditions) {
        const task = taskByDigest.get(entry.taskDigest);
        if (!task)
          throw new Error(`Scheduled unknown task ${entry.taskDigest}`);
        const id = attemptId(task.taskDigest, condition, entry.repeat);
        const decision = replayDecisions.get(id)!;
        if (decision.action === "skip_completed") {
          const prior = completedEntry(priorEntries, id)!;
          outcomes.push(
            replayOutcomeFromArtifact(
              await readAttestedResult<ReplayOutcome>(directory.root, prior)
            )
          );
          const sanitizedPath = replaySanitizedTrajectoryPathFor(
            task,
            condition,
            entry.repeat,
            prior.executionGeneration
          );
          if (await artifactExists(directory.root, sanitizedPath)) {
            const sanitized = await readJsonArtifact<
              AtifSanitizationResult["trajectory"]
            >(directory.root, sanitizedPath);
            replayTrajectories.set(id, sanitized);
          }
          continue;
        }
        if (decision.action === "preserve_missing") {
          const missing = failedReplayOutcome(task, condition, entry.repeat, {
            category: "missing_outcome",
            phase: "agent",
            costUsd:
              config.profile === "smoke"
                ? 0
                : config.maximum_top_level_attempt_cost_usd
          });
          const generation = decision.nextExecutionGeneration;
          await publishAttemptResult(directory, journal, {
            attemptId: id,
            executionGeneration: generation,
            resultPath: failureResultPathFor(
              task,
              condition,
              entry.repeat,
              generation
            ),
            artifact: {
              ...missing,
              sourceTaskDigest: null,
              cloneId: null
            },
            reward: null,
            failureCategory: "missing_outcome"
          });
          outcomes.push(missing);
          continue;
        }
        const generation = decision.nextExecutionGeneration;
        replayJobMetadata.push({ task, condition, repeat: entry.repeat });
        replayJobs.push({
          id,
          maximumCostUsd: Math.max(
            Number.EPSILON,
            config.maximum_top_level_attempt_cost_usd
          ),
          async run({ signal }) {
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
              executionGeneration: generation,
              state: "admitted"
            });
            const replay = await dependencies.createReplay({
              task,
              condition,
              repeat: entry.repeat,
              executionGeneration: generation,
              template,
              sourceTaskDigest,
              runRoot: directory.root,
              config,
              signal
            });
            if (condition === "cold") {
              if (
                replay.cloneId !== null ||
                replay.productPathAttestation !== null
              )
                throw new Error(
                  "Cold replay must have no Koed product resources"
                );
            } else {
              if (!replay.cloneId)
                throw new Error("Koed replay lacks a fresh database clone");
              if (cloneIds.has(replay.cloneId))
                throw new Error(
                  `Replay database clone was reused: ${replay.cloneId}`
                );
              cloneIds.add(replay.cloneId);
              assertReplayAttestation(
                replay.productPathAttestation,
                replay.cloneId,
                template!,
                `${task.name} ${condition} replay`
              );
              productPathAttestations.push({
                attemptId: id,
                attestation: structuredClone(replay.productPathAttestation!)
              });
              productPathExercised = true;
            }
            const lifecycleState = { activated: false, revoked: false };
            const lifecycle = createCoordinatorHarborLifecycle({
              attemptId: id,
              executionGeneration: generation,
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
            let completedExecution:
              | { value: ReplayOutcome; observedCostUsd: number }
              | undefined;
            let replayFailure: unknown;
            let replayFailed = false;
            try {
              if (signal.aborted)
                throw new Error("Replay was cancelled before Harbor start");
              try {
                const execution = await replay.run({ lifecycle, signal });
                const telemetry = execution.telemetry;
                if (!lifecycleState.activated)
                  throw new Error(
                    "Harbor replay returned without an acknowledged agent start"
                  );
                if (!lifecycleState.revoked)
                  throw new Error(
                    "Harbor replay returned without lifecycle credential revocation"
                  );
                validateReplayIdentity(
                  telemetry,
                  task,
                  condition,
                  entry.repeat
                );
                assertCompleteReplayTelemetry(telemetry);
                const merged = mergeReplayTelemetry(telemetry);
                const frozenTrajectory = await readTextFileNoFollow(
                  path.join(
                    directory.root,
                    validateArtifactRelativePath(
                      execution.replayTrajectoryArtifact.path
                    )
                  ),
                  config.admission.maximum_trajectory_bytes
                );
                const sanitizedReplay = sanitizeAtifTrajectory(
                  frozenTrajectory,
                  {
                    taskDigest: task.taskDigest,
                    sourceAttemptId: id,
                    freezeManifest:
                      execution.replayTrajectoryArtifact.freezeManifest,
                    countEmbeddingTokens: dependencies.countEmbeddingTokens
                  }
                );
                const sanitizedPath = replaySanitizedTrajectoryPathFor(
                  task,
                  condition,
                  entry.repeat,
                  generation
                );
                await publishOrVerifyArtifact(
                  directory.root,
                  sanitizedPath,
                  `${sanitizedReplay.canonicalJson}\n`
                );
                replayTrajectories.set(id, sanitizedReplay.trajectory);
                if (
                  admitted.runPlan.kind === "product_path_proof" &&
                  condition === "relevant" &&
                  ((merged.outcome.interactions?.memoryAnswerCalls ?? 0) < 1 ||
                    (merged.outcome.interactions?.memoryAnswerFailures ?? 0) >=
                      (merged.outcome.interactions?.memoryAnswerCalls ?? 0))
                ) {
                  throw new Error(
                    "Product-path proof relevant replay did not complete memory_answer successfully"
                  );
                }
                const observedCostUsd = merged.outcome.costUsd;
                if (observedCostUsd === null || observedCostUsd === undefined)
                  throw new Error("Replay cost telemetry is incomplete");
                completedExecution = {
                  value: merged.outcome,
                  observedCostUsd
                };
                completedReplayTelemetry.set(id, completedExecution);
              } catch (error) {
                if (!lifecycleState.activated) throw error;
                const category =
                  (error as { category?: string }).category === "timeout"
                    ? "agent_timeout"
                    : (error as { category?: string }).category ===
                        "process-exit"
                      ? "agent_failed"
                      : "missing_outcome";
                const conservativeCostUsd =
                  config.profile === "smoke"
                    ? 0
                    : config.maximum_top_level_attempt_cost_usd;
                const missing: ReplayOutcome = {
                  taskDigest: task.taskDigest,
                  condition,
                  repeat: entry.repeat,
                  reward: null,
                  passed: null,
                  costUsd: conservativeCostUsd,
                  failureCategory: category,
                  failureKind:
                    category === "agent_timeout" || category === "agent_failed"
                      ? "agent"
                      : "infrastructure",
                  failurePhase: "agent"
                };
                completedExecution = {
                  value: missing,
                  observedCostUsd: conservativeCostUsd
                };
                completedReplayTelemetry.set(id, completedExecution);
              }
            } catch (error) {
              replayFailure = error;
              replayFailed = true;
            }
            const cleanup = await Promise.allSettled([
              Promise.resolve().then(() => replay.revokeCredential()),
              Promise.resolve().then(() => replay.close())
            ]);
            const failures = cleanup
              .filter(
                (result): result is PromiseRejectedResult =>
                  result.status === "rejected"
              )
              .map((result) => result.reason as unknown);
            if (failures.length) {
              throw Object.assign(
                new AggregateError(failures, "Replay cleanup failed"),
                {
                  category: "teardown",
                  completedExecution
                }
              );
            }
            if (replayFailed) throw replayFailure;
            if (!completedExecution)
              throw new Error("Replay completed without an outcome");
            const resultPath = resultPathFor(
              task,
              condition,
              entry.repeat,
              generation
            );
            await publishAttemptResult(directory, journal, {
              attemptId: id,
              executionGeneration: generation,
              resultPath,
              artifact: {
                ...completedExecution.value,
                sourceTaskDigest,
                cloneId: replay.cloneId
              },
              reward: completedExecution.value.reward,
              failureCategory: completedExecution.value.failureCategory ?? null
            });
            return completedExecution;
          }
        });
      }
    }
    const scheduled = await scheduleReplayJobs({
      jobs: replayJobs,
      concurrency: config.concurrency,
      ...(config.profile === "smoke"
        ? { mode: "smoke" as const }
        : {
            mode: "paid" as const,
            paidCostStopUsd: config.paid_cost_stop_usd!,
            providerSpendingLimitUsd:
              config.admission.provider_spending_limit_usd!,
            costAdmission
          })
    });
    for (const result of scheduled.results) {
      if (result.status === "completed") {
        outcomes.push(result.value);
        continue;
      }
      const metadata = replayJobMetadata[result.index]!;
      if (result.status !== "not_started") {
        const message =
          result.error instanceof Error
            ? result.error.message
            : String(result.error);
        if (
          /attestation|clone was reused|Cold replay must|telemetry identity|immutable schedule/u.test(
            message
          )
        ) {
          throw result.error;
        }
      }
      const failedExecution =
        result.status === "not_started"
          ? undefined
          : (completedReplayTelemetry.get(result.id) ??
            (
              result.error as {
                completedExecution?: {
                  value: ReplayOutcome;
                  observedCostUsd: number;
                };
              }
            ).completedExecution);
      const errorCategory =
        result.status === "not_started"
          ? undefined
          : (result.error as { category?: string }).category;
      const timeout =
        result.status !== "not_started" && errorCategory === "timeout";
      const failure = {
        ...failedExecution?.value,
        ...failedReplayOutcome(
          metadata.task,
          metadata.condition,
          metadata.repeat,
          result.status === "not_started"
            ? {
                category: "admission_rejected",
                phase: "admission",
                costUsd: 0
              }
            : errorCategory === "teardown"
              ? {
                  category: "teardown_failed",
                  phase: "teardown",
                  costUsd:
                    failedExecution?.observedCostUsd ?? result.observedCostUsd
                }
              : {
                  category: timeout ? "setup_timeout" : "setup_failed",
                  phase: "setup",
                  costUsd: result.observedCostUsd
                }
        )
      } satisfies ReplayOutcome;
      const resultPath = failureResultPathFor(
        metadata.task,
        metadata.condition,
        metadata.repeat,
        replayDecisions.get(result.id)!.nextExecutionGeneration
      );
      const generation = replayDecisions.get(
        result.id
      )!.nextExecutionGeneration;
      await publishAttemptResult(directory, journal, {
        attemptId: result.id,
        executionGeneration: generation,
        resultPath,
        artifact: {
          ...failure,
          sourceTaskDigest: null,
          cloneId: null
        },
        reward: null,
        failureCategory: failure.failureCategory!
      });
      outcomes.push(failure);
    }
    if (
      !options.resumeRunDirectory ||
      !(await artifactExists(directory.root, "cost-admission.json"))
    )
      await publishOrVerifyJson(directory.root, "cost-admission.json", {
        ...scheduled.snapshot,
        jobs: schedulerTelemetry(scheduled.results)
      });
    if (
      !options.resumeRunDirectory ||
      !(await artifactExists(directory.root, "attestations/product-path.json"))
    )
      await publishOrVerifyJson(
        directory.root,
        "attestations/product-path.json",
        productPathAttestations.sort((left, right) =>
          left.attemptId.localeCompare(right.attemptId)
        )
      );
    await phase(journal, "replay_execution", "completed");
    if (admitted.runPlan.kind === "product_path_proof") {
      const relevant = outcomes.find(
        (outcome) => outcome.condition === "relevant"
      );
      if (
        !relevant ||
        relevant.reward === null ||
        (relevant.interactions?.memoryAnswerCalls ?? 0) < 1 ||
        (relevant.interactions?.memoryAnswerFailures ?? 0) >=
          (relevant.interactions?.memoryAnswerCalls ?? 0)
      ) {
        throw new Error(
          "Product-path proof requires one successful relevant memory_answer replay"
        );
      }
    }
    await phase(journal, "metric_merge", "started");
    await phase(journal, "metric_merge", "completed");
    await phase(journal, "trajectory_judging", "started");
    for (const task of replayTasks) {
      const sourceTrajectory = sources.get(task.taskDigest)?.sanitization
        ?.trajectory;
      for (
        let repeat = 0;
        repeat < admitted.runPlan.replayAttemptsPerCondition;
        repeat += 1
      ) {
        for (const comparison of REQUIRED_COMPARISONS) {
          const resultPath = judgeResultPathFor(task, comparison, repeat);
          if (
            options.resumeRunDirectory &&
            (await artifactExists(directory.root, resultPath))
          ) {
            trajectoryJudgments.push(
              await readJsonArtifact<TrajectoryJudgeResult>(
                directory.root,
                resultPath
              )
            );
            continue;
          }
          const leftOutcome = outcomes.find(
            (outcome) =>
              outcome.taskDigest === task.taskDigest &&
              outcome.condition === comparison.left &&
              outcome.repeat === repeat
          );
          const rightOutcome = outcomes.find(
            (outcome) =>
              outcome.taskDigest === task.taskDigest &&
              outcome.condition === comparison.right &&
              outcome.repeat === repeat
          );
          const leftTrajectory = replayTrajectories.get(
            attemptId(task.taskDigest, comparison.left, repeat)
          );
          const rightTrajectory = replayTrajectories.get(
            attemptId(task.taskDigest, comparison.right, repeat)
          );
          const judgeId = `judge:${task.taskDigest}:${comparison.left}:${comparison.right}:${repeat}`;
          let judgment: TrajectoryJudgeResult;
          if (
            !sourceTrajectory ||
            !leftOutcome ||
            !rightOutcome ||
            !leftTrajectory ||
            !rightTrajectory
          ) {
            judgment = {
              schemaVersion: TRAJECTORY_JUDGE_SCHEMA_VERSION,
              taskDigest: task.taskDigest,
              repeat,
              comparison: `${comparison.left} - ${comparison.right}`,
              status: "error",
              preferredCondition: null,
              confidence: null,
              assessments: {},
              rationale: null,
              latencyMs: 0,
              model: config.trajectory_judge.model.id,
              tokenUsage: {
                uncachedInput: null,
                cachedInput: null,
                output: null,
                reasoning: null
              },
              costUsd: null,
              error: "A sanitized pre-verifier trajectory is unavailable"
            };
          } else {
            let admittedJudge = false;
            try {
              if (costAdmission) {
                costAdmission.admit(
                  judgeId,
                  Math.max(Number.EPSILON, config.maximum_judge_call_cost_usd)
                );
                admittedJudge = true;
              }
              judgment = await dependencies.judgeTrajectory({
                runSeed: config.seed,
                taskDigest: task.taskDigest,
                repeat,
                comparison,
                sourceTrajectory,
                left: {
                  condition: comparison.left,
                  reward: leftOutcome.reward,
                  passed: leftOutcome.passed ?? null,
                  trajectory: leftTrajectory
                },
                right: {
                  condition: comparison.right,
                  reward: rightOutcome.reward,
                  passed: rightOutcome.passed ?? null,
                  trajectory: rightTrajectory
                }
              });
              if (costAdmission && admittedJudge) {
                admittedJudge = false;
                costAdmission.settle(
                  judgeId,
                  judgment.costUsd ?? config.maximum_judge_call_cost_usd
                );
              }
            } catch (error) {
              if (costAdmission && admittedJudge) {
                admittedJudge = false;
                costAdmission.settle(
                  judgeId,
                  config.maximum_judge_call_cost_usd
                );
              }
              judgment = {
                schemaVersion: TRAJECTORY_JUDGE_SCHEMA_VERSION,
                taskDigest: task.taskDigest,
                repeat,
                comparison: `${comparison.left} - ${comparison.right}`,
                status: "error",
                preferredCondition: null,
                confidence: null,
                assessments: {},
                rationale: null,
                latencyMs: 0,
                model: config.trajectory_judge.model.id,
                tokenUsage: {
                  uncachedInput: null,
                  cachedInput: null,
                  output: null,
                  reasoning: null
                },
                costUsd: null,
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
          trajectoryJudgments.push(judgment);
          await publishOrVerifyJson(directory.root, resultPath, judgment);
        }
      }
    }
    await publishOrVerifyJson(
      directory.root,
      "judge/results.json",
      trajectoryJudgments
    );
    await publishOrVerifyJson(
      directory.root,
      "judge/cost-admission.json",
      costAdmission?.snapshot() ?? {
        observedCostUsd: 0,
        reservedMaximumCostUsd: 0,
        activeAttempts: 0,
        stopped: false,
        crossing: null
      }
    );
    await phase(journal, "trajectory_judging", "completed");
    await phase(journal, "report_generation", "started");
    await reportFromOutcomes(
      directory.root,
      config,
      admitted.runPlan,
      replayTasks,
      outcomes,
      trajectoryJudgments,
      preparationCostUsd,
      runId
    );
    await phase(journal, "report_generation", "completed");
  } catch (error) {
    primaryFailure = error;
  } finally {
    await phase(journal, "teardown", "started").catch(() => undefined);
    try {
      await dependencies.teardown({
        preserveTemplates: primaryFailure !== undefined
      });
      await phase(journal, "teardown", "completed");
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
      await phase(
        journal,
        "teardown",
        "blocked",
        "Resource teardown failed"
      ).catch(() => undefined);
    }
    await directory
      .writeJson("attestations/cleanup.json", {
        schema: "koed-experience-replay-cleanup-v1",
        complete: cleanupFailure === undefined,
        replays: dependencies.cleanupAttestations?.() ?? []
      })
      .catch(() => undefined);
    try {
      await lease.release();
    } catch (releaseError) {
      cleanupFailure = cleanupFailure
        ? new AggregateError(
            [cleanupFailure, releaseError],
            "Resource teardown and run-lease release failed"
          )
        : releaseError;
    }
  }

  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "Experience Replay execution and cleanup failed",
      { cause: primaryFailure }
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;

  return {
    runDirectory: directory.root,
    reportPath: path.join(directory.root, "report/summary.md"),
    replayAttemptCount: outcomes.length,
    productPathExercised
  };
};

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
              await readAttestedResult<ReplayOutcome>(runRoot, result)
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
): Promise<{
  sourceTasks: CoordinatorTask[];
  replayTasks: CoordinatorTask[];
  runPlan: ExperienceReplayRunPlan;
}> => {
  const manifest = await readJsonArtifact<{
    task_digests: string[];
    replay_task_digests: string[];
    run_plan: ExperienceReplayRunPlan;
  }>(runRoot, "manifest.json");
  verifyExperienceReplayRunPlan(manifest.run_plan);
  const admitted = await preflightExperienceReplay({
    config,
    requireRunnable: false,
    confirmPaidRun: config.profile !== "smoke",
    executionKind: manifest.run_plan.kind,
    codexAuthMode: manifest.run_plan.codexAuthMode
  });
  const tasks = selectedTasks(admitted);
  if (immutableHash(admitted.runPlan) !== immutableHash(manifest.run_plan)) {
    throw new Error("Pinned run plan changed; refusing run artifact");
  }
  const replayTasks = replayTargetTasks(admitted.runPlan, tasks);
  if (
    immutableHash(tasks.map((task) => task.taskDigest)) !==
      immutableHash(manifest.task_digests) ||
    immutableHash(replayTasks.map((task) => task.taskDigest)) !==
      immutableHash(manifest.replay_task_digests)
  )
    throw new Error("Pinned task digest set changed; refusing run artifact");
  return { sourceTasks: tasks, replayTasks, runPlan: admitted.runPlan };
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
  const templates = await readJsonArtifact<PersistedTemplate[]>(
    runRoot,
    "templates.json"
  );
  const preparationCostUsd = templates.reduce((sum, record) => {
    const cost = record.template.preparationCostUsd;
    if (!Number.isFinite(cost) || cost < 0)
      throw new Error("Persisted template preparation cost is invalid");
    return sum + cost;
  }, 0);
  const manifest = await readJsonArtifact<{ run_id: string }>(
    runRoot,
    "manifest.json"
  );
  const trajectoryJudgments = await readJsonArtifact<TrajectoryJudgeResult[]>(
    runRoot,
    "judge/results.json"
  );
  const tasks = await tasksFromManifest(runRoot, config);
  await reportFromOutcomes(
    runRoot,
    config,
    tasks.runPlan,
    tasks.replayTasks,
    await outcomesFromRun(runRoot, schedule, entries),
    trajectoryJudgments,
    preparationCostUsd,
    manifest.run_id
  );
  return path.join(runRoot, "report/summary.md");
};

export const resumeExperienceReplay = async (
  runDirectory: string,
  options: {
    dependencies?: ExperienceReplayCoordinatorDependencies;
    preflight?: PreflightResult;
  } = {}
): Promise<string> => {
  if (!options.dependencies) missingDependencies();
  const runRoot = await validateExistingRunDirectory(
    runDirectory,
    EXPERIENCE_REPLAY_REPOSITORY_ROOT
  );
  const config = await readJsonArtifact<ResolvedExperienceReplayConfig>(
    runRoot,
    "config.resolved.json"
  );
  verifyResolvedConfig(config);
  const result = await runExperienceReplay(config, {
    dependencies: options.dependencies,
    ...(options.preflight ? { preflight: options.preflight } : {}),
    resumeRunDirectory: runRoot
  });
  return result.reportPath;
};

export const readExperienceReplayResumeIdentity = async (
  runDirectory: string
): Promise<{
  runRoot: string;
  config: ResolvedExperienceReplayConfig;
  runId: string;
  runPlan: ExperienceReplayRunPlan;
  recordedRunAttestation: RecordedRunAttestation | null;
}> => {
  const runRoot = await validateExistingRunDirectory(
    runDirectory,
    EXPERIENCE_REPLAY_REPOSITORY_ROOT
  );
  const config = await readJsonArtifact<ResolvedExperienceReplayConfig>(
    runRoot,
    "config.resolved.json"
  );
  verifyResolvedConfig(config);
  const manifest = await readJsonArtifact<{
    run_id: string;
    run_plan: ExperienceReplayRunPlan;
  }>(runRoot, "manifest.json");
  if (typeof manifest.run_id !== "string" || !manifest.run_id.trim())
    throw new Error("Persisted run identity is invalid");
  verifyExperienceReplayRunPlan(manifest.run_plan);
  const recordedRunAttestation =
    config.profile === "smoke"
      ? null
      : (
          await readJsonArtifact<{
            recordedRunAttestation: RecordedRunAttestation | null;
          }>(runRoot, "attestations/preflight.json")
        ).recordedRunAttestation;
  if (config.profile !== "smoke" && !recordedRunAttestation) {
    throw new Error("Persisted recorded-run attestation is missing");
  }
  return {
    runRoot,
    config,
    runId: manifest.run_id,
    runPlan: manifest.run_plan,
    recordedRunAttestation
  };
};

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
