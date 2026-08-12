import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assignMatchedPlacebos,
  CONDITIONS,
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
  type HarborFreezeManifest
} from "./atif/index.js";
import { assertEvalDatabaseUrl, assertLoopbackUrl } from "./isolation.js";
import { SafeRunDirectory } from "./output-path.js";
import {
  EXPERIENCE_REPLAY_REPOSITORY_ROOT,
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

const SYNTHETIC_TASKS = [
  { name: "synthetic-alpha", digest: `sha256:${"a".repeat(64)}` },
  { name: "synthetic-beta", digest: `sha256:${"b".repeat(64)}` }
] as const;

const taskByDigest = new Map<string, (typeof SYNTHETIC_TASKS)[number]>(
  SYNTHETIC_TASKS.map((task) => [task.digest, task])
);
const attemptId = (
  taskDigest: string,
  condition: ReplayCondition,
  repeat: number
) => `replay:${taskDigest}:${condition}:${repeat}`;

const syntheticTrajectory = (taskName: string): string =>
  JSON.stringify({
    schema_version: "ATIF-v1.7",
    session_id: `source-${taskName}`,
    agent: { name: "codex", version: "deterministic-fake-1" },
    steps: [
      {
        step_id: 1,
        timestamp: "2026-08-12T00:00:00.000Z",
        source: "user",
        message: `Synthetic instruction for ${taskName}`
      },
      {
        step_id: 2,
        timestamp: "2026-08-12T00:00:01.000Z",
        source: "agent",
        message: `Synthetic prior experience for ${taskName}`,
        reasoning_content: "Deterministic concise summary",
        tool_calls: [
          {
            tool_call_id: "call-1",
            function_name: "shell",
            arguments: { command: "printf synthetic" }
          }
        ],
        observation: {
          results: [{ source_call_id: "call-1", content: "synthetic" }]
        }
      },
      {
        step_id: 3,
        timestamp: "2026-08-12T00:00:02.000Z",
        source: "agent",
        message: "Synthetic source complete"
      }
    ]
  });

const syntheticFreezeManifest = (
  taskName: string,
  frozenTrajectory: string
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
    {
      ordinal: 2,
      event: "agent_ended",
      timestamp: "2026-08-12T00:00:03.000Z"
    },
    {
      ordinal: 3,
      event: "trajectory_materialized",
      timestamp: "2026-08-12T00:00:04.000Z"
    },
    {
      ordinal: 4,
      event: "verification_started",
      timestamp: "2026-08-12T00:00:05.000Z"
    }
  ],
  cutoff: {
    agent_last_native_event_ordinal: 3,
    step_identities: [1, 2, 3].map((ordinal) => ({
      step_id: ordinal,
      identity_sha256: `sha256:${createHash("sha256")
        .update(`${ordinal}:${ordinal}`)
        .digest("hex")}`,
      last_native_event_ordinal: ordinal
    }))
  },
  frozen_artifact: {
    relative_path: `source/${taskName}/frozen-trajectory.synthetic.json`,
    sha256: `sha256:${createHash("sha256")
      .update(frozenTrajectory)
      .digest("hex")}`,
    size_bytes: Buffer.byteLength(frozenTrajectory),
    file_identity: { device: 1, inode: 1 }
  }
});

const deterministicOutcome = (
  taskDigest: string,
  condition: ReplayCondition,
  repeat: number
): ReplayOutcome => {
  const taskIndex = SYNTHETIC_TASKS.findIndex(
    (task) => task.digest === taskDigest
  );
  if (taskIndex < 0) throw new Error(`Unknown synthetic task ${taskDigest}`);
  const reward =
    condition === "relevant"
      ? 1
      : condition === "placebo" && taskIndex === 1
        ? 1
        : 0;
  return {
    taskDigest,
    condition,
    repeat,
    reward,
    passed: reward === 1,
    latencyMs: 10 + taskIndex + CONDITIONS.indexOf(condition),
    tokens: condition === "cold" ? 20 : 24,
    costUsd: 0
  };
};

const resultRelativePath = (
  taskDigest: string,
  condition: ReplayCondition,
  repeat: number
): string => {
  const task = taskByDigest.get(taskDigest);
  if (!task) throw new Error(`Unknown synthetic task ${taskDigest}`);
  return `attempts/${task.name}/${condition}/${repeat}/result.json`;
};

const phase = async (
  journal: RunJournal,
  name: RunPhase,
  status: "started" | "completed" | "skipped",
  detail?: string
) =>
  journal.append({
    type: "phase",
    phase: name,
    status,
    ...(detail ? { detail } : {})
  });

const contracts: TaskRewardContract[] = SYNTHETIC_TASKS.map((task) => ({
  taskDigest: task.digest,
  rewardMin: 0,
  rewardMax: 1
}));

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
    if (existing !== contents) {
      throw new Error(`Published artifact differs: ${relativePath}`, {
        cause: error
      });
    }
  }
};

const reportFromOutcomes = async (
  runRoot: string,
  config: ResolvedExperienceReplayConfig,
  outcomes: readonly ReplayOutcome[]
): Promise<void> => {
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
      tasks: SYNTHETIC_TASKS
    }).slice(0, 16),
    profile: "smoke",
    model: config.coding_agent.id,
    taskCount: SYNTHETIC_TASKS.length,
    attemptedReplayCount: outcomes.length,
    failureCount: outcomes.filter((outcome) => outcome.reward === null).length,
    preparationCostUsd: 0,
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

export interface SmokeRunResult {
  runDirectory: string;
  reportPath: string;
  replayAttemptCount: number;
  productPathExercised: false;
}

export const runSmokeExperienceReplay = async (
  config: ResolvedExperienceReplayConfig,
  preflight?: PreflightResult
): Promise<SmokeRunResult> => {
  if (config.profile !== "smoke") {
    throw new Error(
      "The deterministic coordinator only accepts the smoke profile"
    );
  }
  const admitted = preflight ?? (await preflightExperienceReplay({ config }));
  const created = await SafeRunDirectory.create({
    outputPath: config.output_dir,
    repositoryRoot: admitted.repositoryRoot,
    requiredBytes: admitted.capacity.requiredBytes,
    reserveBytes: admitted.capacity.reserveBytes
  });
  const directory = created.directory;
  const journal = new RunJournal(directory, config.semantic_config_hash);
  const frozenSourceTrajectories = new Map<string, string>();

  // Exercise the root isolation guards without starting or claiming a product service.
  assertLoopbackUrl("http://127.0.0.1:1", "Synthetic smoke endpoint");
  assertEvalDatabaseUrl("postgresql://127.0.0.1/koed_eval_synthetic_smoke");

  await phase(journal, "preflight", "started");
  await directory.writeJson("config.resolved.json", config);
  await directory.writeJson("manifest.json", {
    manifest_version: 1,
    benchmark_kind: "koed_experience_replay",
    standard_leaderboard_comparable: false,
    profile: "smoke",
    configuration_hash: config.semantic_config_hash,
    pins: {
      harbor_commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
      terminal_bench_commit: "2b0442c3c583b710ca8da14c8e601b99f2f1f244",
      corpus_hash: admitted.pins.corpusHash,
      uv_lock_hash: admitted.pins.uvLockHash
    },
    execution_boundary: {
      deterministic_no_paid_or_network_calls: true,
      product_path_exercised: false,
      terminal_bench_estimate: false,
      unexercised_prerequisites: [
        "actual PostgreSQL migrations and template cloning",
        "canonical Conversation Item ingestion and Projection",
        "real MCP bridge and Local AI Runtime worker execution",
        "Harbor container and verifier lifecycle"
      ]
    },
    capacity: admitted.capacity
  });
  await phase(journal, "preflight", "completed");

  await phase(journal, "source_attempts", "started");
  for (const task of SYNTHETIC_TASKS) {
    const id = `source:${task.digest}`;
    const frozenTrajectory = syntheticTrajectory(task.name);
    frozenSourceTrajectories.set(task.digest, frozenTrajectory);
    await journal.append({
      type: "attempt_state",
      attemptId: id,
      executionGeneration: 1,
      state: "admitted"
    });
    await journal.append({
      type: "attempt_state",
      attemptId: id,
      executionGeneration: 1,
      state: "agent_started"
    });
    await directory.writeJson(
      `source/${task.name}/frozen-trajectory.synthetic.json`,
      JSON.parse(frozenTrajectory) as unknown
    );
    const sourceResultPath = `source/${task.name}/result.json`;
    await directory.writeJson(sourceResultPath, {
      attemptId: id,
      reward: task.name === "synthetic-alpha" ? 1 : 0,
      passed: task.name === "synthetic-alpha",
      synthetic: true
    });
    await journal.append({
      type: "attempt_result",
      attemptId: id,
      executionGeneration: 1,
      resultPath: sourceResultPath,
      reward: task.name === "synthetic-alpha" ? 1 : 0,
      failureCategory: null
    });
  }
  await phase(
    journal,
    "source_attempts",
    "completed",
    "Deterministic fake source attempts only"
  );

  await phase(journal, "atif_sanitization", "started");
  for (const task of SYNTHETIC_TASKS) {
    const frozenTrajectory = frozenSourceTrajectories.get(task.digest);
    if (!frozenTrajectory)
      throw new Error(`Missing frozen source trajectory for ${task.name}`);
    const result = sanitizeAtifTrajectory(frozenTrajectory, {
      taskDigest: task.digest,
      sourceAttemptId: `source:${task.digest}`,
      countEmbeddingTokens: (text) =>
        text.trim() ? text.trim().split(/\s+/).length : 0,
      freezeManifest: syntheticFreezeManifest(task.name, frozenTrajectory)
    });
    await directory.writeJson(
      `source/${task.name}/sanitization.json`,
      result.manifest
    );
  }
  await phase(journal, "atif_sanitization", "completed");

  await phase(journal, "placebo_assignment", "started");
  const assignment = assignMatchedPlacebos(
    SYNTHETIC_TASKS.map((task, index) => ({
      taskDigest: task.digest,
      category: "synthetic",
      sourcePassed: index === 0,
      sanitizedTokenQuartile: index as 0 | 1,
      expertTimeSeconds: 1,
      resourceClass: "synthetic-cpu"
    })),
    config.seed
  );
  verifyPlaceboAssignment(assignment);
  await directory.writeJson("placebo-assignment.json", assignment);
  await phase(journal, "placebo_assignment", "completed");

  for (const [name, detail] of [
    [
      "canonical_koed_ingestion",
      "Synthetic smoke does not claim canonical product ingestion"
    ],
    ["semantic_readiness", "Synthetic smoke does not claim semantic readiness"],
    [
      "template_creation",
      "Synthetic smoke does not claim database template isolation"
    ]
  ] as const) {
    await phase(journal, name, "skipped", detail);
  }

  await phase(journal, "replay_schedule", "started");
  const schedule = createReplaySchedule(
    SYNTHETIC_TASKS.map((task) => task.digest),
    config.replay_attempts_per_condition,
    config.seed
  );
  verifyReplaySchedule(schedule);
  await directory.writeJson("schedule.json", schedule);
  await phase(journal, "replay_schedule", "completed");

  await phase(journal, "replay_execution", "started");
  const outcomes: ReplayOutcome[] = [];
  for (const entry of schedule.entries) {
    for (const condition of entry.conditions) {
      const id = attemptId(entry.taskDigest, condition, entry.repeat);
      const result = deterministicOutcome(
        entry.taskDigest,
        condition,
        entry.repeat
      );
      const resultPath = resultRelativePath(
        entry.taskDigest,
        condition,
        entry.repeat
      );
      await journal.append({
        type: "attempt_state",
        attemptId: id,
        executionGeneration: 1,
        state: "admitted"
      });
      await journal.append({
        type: "attempt_state",
        attemptId: id,
        executionGeneration: 1,
        state: "agent_started"
      });
      await directory.writeJson(resultPath, {
        ...result,
        attemptId: id,
        executionGeneration: 1,
        synthetic: true,
        koedConnection:
          condition === "cold" ? "absent" : "synthetic-contract-only",
        memorySource:
          condition === "relevant"
            ? entry.taskDigest
            : condition === "placebo"
              ? assignment.assignments.find(
                  (value) => value.targetDigest === entry.taskDigest
                )?.sourceDigest
              : null
      });
      await journal.append({
        type: "attempt_result",
        attemptId: id,
        executionGeneration: 1,
        resultPath,
        reward: result.reward,
        failureCategory: null
      });
      outcomes.push(result);
    }
  }
  await phase(
    journal,
    "replay_execution",
    "completed",
    "Deterministic protocol fixtures; no Harbor or model calls"
  );
  await phase(journal, "metric_merge", "started");
  await phase(journal, "metric_merge", "completed");
  await phase(journal, "report_generation", "started");
  await reportFromOutcomes(directory.root, config, outcomes);
  await phase(journal, "report_generation", "completed");
  await phase(journal, "teardown", "started");
  await phase(
    journal,
    "teardown",
    "completed",
    "No external processes were started"
  );
  return {
    runDirectory: directory.root,
    reportPath: path.join(directory.root, "report/summary.md"),
    replayAttemptCount: outcomes.length,
    productPathExercised: false
  };
};

const expectedReplayAttempts = (schedule: ReplaySchedule): string[] =>
  schedule.entries.flatMap((entry) =>
    entry.conditions.map((condition) =>
      attemptId(entry.taskDigest, condition, entry.repeat)
    )
  );

const replayOutcomeFromArtifact = (value: ReplayOutcome): ReplayOutcome => {
  const {
    taskDigest,
    condition,
    repeat,
    reward,
    passed,
    latencyMs,
    tokens,
    costUsd,
    durations,
    tokenUsage,
    costs,
    interactions,
    workers,
    recall,
    embedding,
    pipeline,
    rss,
    failureCategory,
    failureKind,
    failurePhase,
    source
  } = value;
  return {
    taskDigest,
    condition,
    repeat,
    reward,
    ...(passed !== undefined ? { passed } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(durations !== undefined ? { durations } : {}),
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    ...(costs !== undefined ? { costs } : {}),
    ...(interactions !== undefined ? { interactions } : {}),
    ...(workers !== undefined ? { workers } : {}),
    ...(recall !== undefined ? { recall } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
    ...(pipeline !== undefined ? { pipeline } : {}),
    ...(rss !== undefined ? { rss } : {}),
    ...(failureCategory !== undefined ? { failureCategory } : {}),
    ...(failureKind !== undefined ? { failureKind } : {}),
    ...(failurePhase !== undefined ? { failurePhase } : {}),
    ...(source !== undefined ? { source } : {})
  };
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
      if (!result) {
        outcomes.push({
          taskDigest: scheduleEntry.taskDigest,
          condition,
          repeat: scheduleEntry.repeat,
          reward: null
        });
        continue;
      }
      outcomes.push(
        replayOutcomeFromArtifact(
          await readJsonArtifact<ReplayOutcome>(runRoot, result.resultPath)
        )
      );
    }
  }
  return outcomes;
};

export const reportExistingSmokeRun = async (
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
  if (config.profile !== "smoke") {
    throw new Error(
      "Report regeneration is not implemented for recorded model-driven profiles"
    );
  }
  const storedHash = config.semantic_config_hash;
  const hashableConfig = Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => key !== "semantic_config_hash" && key !== "output_dir"
    )
  );
  if (immutableHash(hashableConfig) !== storedHash) {
    throw new Error("Resolved configuration hash mismatch");
  }
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
    await outcomesFromRun(runRoot, schedule, entries)
  );
  return path.join(runRoot, "report/summary.md");
};

export const resumeSmokeRun = async (runDirectory: string): Promise<string> => {
  const runRoot = await validateExistingRunDirectory(
    runDirectory,
    EXPERIENCE_REPLAY_REPOSITORY_ROOT
  );
  const config = await readJsonArtifact<ResolvedExperienceReplayConfig>(
    runRoot,
    "config.resolved.json"
  );
  if (config.profile !== "smoke") {
    throw new Error(
      "Resume is gated until the recorded Harbor/Koed product path is implemented"
    );
  }
  const storedHash = config.semantic_config_hash;
  const hashableConfig = Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => key !== "semantic_config_hash" && key !== "output_dir"
    )
  );
  if (immutableHash(hashableConfig) !== storedHash) {
    throw new Error("Material configuration changed; refusing resume");
  }
  const schedule = await readJsonArtifact<ReplaySchedule>(
    runRoot,
    "schedule.json"
  );
  verifyReplaySchedule(schedule, {
    taskDigests: SYNTHETIC_TASKS.map((task) => task.digest),
    repeats: config.replay_attempts_per_condition,
    seed: config.seed
  });
  const entries = await readRunJournal(
    path.join(runRoot, "journal.jsonl"),
    config.semantic_config_hash
  );
  const decisions = planAttemptResume(
    expectedReplayAttempts(schedule),
    entries
  );
  const created = await SafeRunDirectory.create({
    outputPath: runRoot,
    repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT,
    requiredBytes: 0,
    reserveBytes: 0
  });
  const journal = new RunJournal(
    created.directory,
    config.semantic_config_hash,
    entries
  );
  for (const decision of decisions) {
    if (decision.action !== "rerun_before_agent") continue;
    const match =
      /^replay:(sha256:[a-f0-9]{64}):(cold|empty|placebo|relevant):(\d+)$/.exec(
        decision.attemptId
      );
    if (!match)
      throw new Error(`Invalid replay attempt identity ${decision.attemptId}`);
    const taskDigest = match[1] as string;
    const condition = match[2] as ReplayCondition;
    const repeat = Number(match[3]);
    const result = deterministicOutcome(taskDigest, condition, repeat);
    const resultPath = resultRelativePath(taskDigest, condition, repeat);
    await journal.append({
      type: "attempt_state",
      attemptId: decision.attemptId,
      executionGeneration: decision.nextExecutionGeneration,
      state: "agent_started"
    });
    await created.directory.writeJson(resultPath, {
      ...result,
      attemptId: decision.attemptId,
      executionGeneration: decision.nextExecutionGeneration,
      synthetic: true
    });
    await journal.append({
      type: "attempt_result",
      attemptId: decision.attemptId,
      executionGeneration: decision.nextExecutionGeneration,
      resultPath,
      reward: result.reward,
      failureCategory: null
    });
  }
  return reportExistingSmokeRun(runRoot);
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
