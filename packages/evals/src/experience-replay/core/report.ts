import type { BootstrapInterval } from "./bootstrap.js";
import type { ExperienceReplayProfile } from "./config.js";
import type { ExperienceReplayExecutionKind } from "./execution-plan.js";
import type { ExperienceReplayCodexAuthMode } from "./execution-plan.js";
import type {
  ComparisonSummary,
  ReplayOutcome,
  SourceSplitIdentifiers
} from "./metrics.js";
import type { TrajectoryJudgeResult } from "../trajectory-judge.js";

export const SCIENTIFIC_DISCLOSURE =
  "This is not a standard Terminal-Bench leaderboard evaluation. Relevant Koed conditions intentionally received the AI Client-visible trajectory of an earlier attempt on the same task. Every replay used a clean task environment and a fresh AI Client session. Verifier output, hidden tests and reference solutions were excluded from Memory. This experiment measures episodic experience reuse, not first-encounter generalisation.";
export const ORACLE_SCIENTIFIC_DISCLOSURE =
  "This is not a standard Terminal-Bench leaderboard evaluation. A successful source attempt was deliberately given benchmark-only solution guidance, qualified by the unchanged verifier, and separated into guidance, trace and combined Memory treatments. Replays used clean task environments and fresh AI Client sessions. This diagnostic measures oracle-seeded experience reuse, not natural prior experience or first-encounter generalisation.";

export type ExclusionCategory =
  | "task_not_in_profile"
  | "resource_incompatible"
  | "source_unavailable"
  | "source_invalid"
  | "policy_excluded"
  | "preflight_rejected"
  | "other";

export interface ReplayExclusion {
  taskDigest: string;
  category: ExclusionCategory;
  phase: "selection" | "preparation" | "admission";
  source: SourceSplitIdentifiers;
}

export interface ExperienceReplayReportInput {
  runId: string;
  executionKind: ExperienceReplayExecutionKind;
  codexAuthMode: ExperienceReplayCodexAuthMode;
  profile: ExperienceReplayProfile;
  model: string;
  taskCount: number;
  attemptedReplayCount: number;
  failureCount: number;
  preparationCostUsd: number | null;
  /** Secondary evaluation overhead, excluded from replay treatment costs. */
  judgeOverheadCostUsd: number | null;
  comparisons: readonly ComparisonSummary[];
  trajectoryJudgments: readonly TrajectoryJudgeResult[];
  attempts: readonly ReplayOutcome[];
  exclusions: readonly ReplayExclusion[];
  intervals?: Readonly<
    Record<
      string,
      {
        repeat: BootstrapInterval;
        task: BootstrapInterval;
      }
    >
  >;
  detailFiles?: readonly string[];
}

export interface ExperienceReplayMachineReport extends ExperienceReplayReportInput {
  report_version: 1;
  benchmark_kind:
    | "koed_experience_replay"
    | "koed_oracle_seeded_experience_reuse";
  standard_leaderboard_comparable: false;
  disclosure: string;
  scope: string;
  attempts: readonly ReplayOutcome[];
  exclusions: readonly ReplayExclusion[];
}

const scopeFor = (
  executionKind: ExperienceReplayExecutionKind,
  profile: ExperienceReplayProfile,
  attemptedReplayCount: number,
  taskCount: number
): string => {
  if (executionKind === "product_path_proof") {
    return "Manual two-source, one-target Terminal-Bench 3.0 product-path integration proof; not a benchmark estimate.";
  }
  if (executionKind === "oracle_seeded_product_proof") {
    return "Manual one-task, six-arm oracle-seeded product-path smoke proof; not a benchmark estimate or efficacy claim.";
  }
  if (executionKind === "oracle_seeded_repeated_study") {
    const repeats = attemptedReplayCount / (taskCount * 4);
    return `One-task, four-arm, ${repeats}-repeat oracle-seeded calibration study; estimates stochastic behavior for this task only, not leaderboard or task-population performance.`;
  }
  if (executionKind === "oracle_seeded_campaign") {
    return `Treatment-only, one-attempt-per-task Luna-high experience-reuse challenge over ${taskCount} privately qualified Terminal-Bench 3.0 task corpora; not an official leaderboard submission or a causal no-Memory comparison.`;
  }
  switch (profile) {
    case "smoke":
      return "Synthetic orchestration check; no Terminal-Bench estimate.";
    case "quick":
      return "Directional estimate for the fixed 12-task CPU subset; no confidence interval or significance claim.";
    case "standard":
      return "Fixed 24-task CPU-subset estimate; intervals describe CPU-subset uncertainty, not full-corpus uncertainty.";
    case "full":
      return "Paired estimate for the pinned 74-task corpus under the recorded configuration.";
  }
};

export const createMachineReport = (
  input: ExperienceReplayReportInput
): ExperienceReplayMachineReport => {
  if (input.attempts.length !== input.attemptedReplayCount) {
    throw new Error("Attempt ledger must represent every replay attempt");
  }
  const attemptIdentities = new Set<string>();
  for (const attempt of input.attempts) {
    const identity = `${attempt.taskDigest}\0${attempt.condition}\0${attempt.repeat}`;
    if (attemptIdentities.has(identity)) {
      throw new Error("Attempt ledger contains a duplicate replay attempt");
    }
    attemptIdentities.add(identity);
    if (
      (attempt.reward === null || attempt.failureCategory != null) &&
      (attempt.failureCategory == null ||
        attempt.failureKind == null ||
        attempt.failurePhase == null)
    ) {
      throw new Error(
        "Every failed attempt requires category, kind and phase telemetry"
      );
    }
  }
  const representedFailures = input.attempts.filter(
    (attempt) => attempt.reward === null || attempt.failureCategory != null
  ).length;
  if (representedFailures !== input.failureCount) {
    throw new Error("Attempt ledger must represent every failure");
  }
  const judgmentIdentities = new Set<string>();
  for (const judgment of input.trajectoryJudgments) {
    const identity = `${judgment.taskDigest}\0${judgment.comparison}\0${judgment.repeat}`;
    if (judgmentIdentities.has(identity)) {
      throw new Error("Trajectory judgment ledger contains a duplicate result");
    }
    judgmentIdentities.add(identity);
  }
  const knownJudgeCost = input.trajectoryJudgments.every(
    (judgment) => judgment.costUsd !== null
  )
    ? input.trajectoryJudgments.reduce(
        (total, judgment) => total + judgment.costUsd!,
        0
      )
    : null;
  if (
    (knownJudgeCost === null && input.judgeOverheadCostUsd !== null) ||
    (knownJudgeCost !== null &&
      (input.judgeOverheadCostUsd === null ||
        Math.abs(knownJudgeCost - input.judgeOverheadCostUsd) > 1e-9))
  ) {
    throw new Error(
      "Trajectory judge overhead must match the judgment cost ledger"
    );
  }
  if (
    input.executionKind === "benchmark_profile" &&
    (input.profile === "smoke" || input.profile === "quick") &&
    input.intervals !== undefined
  ) {
    throw new Error(`${input.profile} reports must omit confidence intervals`);
  }
  if (
    input.executionKind === "benchmark_profile" &&
    (input.profile === "standard" || input.profile === "full") &&
    input.intervals === undefined
  ) {
    throw new Error(
      `${input.profile} reports require repeat and task bootstrap intervals`
    );
  }
  return {
    ...input,
    report_version: 1,
    benchmark_kind:
      input.executionKind === "oracle_seeded_product_proof" ||
      input.executionKind === "oracle_seeded_repeated_study" ||
      input.executionKind === "oracle_seeded_campaign"
        ? "koed_oracle_seeded_experience_reuse"
        : "koed_experience_replay",
    standard_leaderboard_comparable: false,
    disclosure:
      input.executionKind === "oracle_seeded_product_proof" ||
      input.executionKind === "oracle_seeded_repeated_study" ||
      input.executionKind === "oracle_seeded_campaign"
        ? ORACLE_SCIENTIFIC_DISCLOSURE
        : SCIENTIFIC_DISCLOSURE,
    scope: scopeFor(
      input.executionKind,
      input.profile,
      input.attemptedReplayCount,
      input.taskCount
    )
  };
};

const display = (value: number | null): string =>
  value === null ? "missing" : Number(value.toFixed(6)).toString();

export const renderMarkdownReport = (
  report: ExperienceReplayMachineReport
): string => {
  const lines = [
    report.disclosure,
    "",
    "# Koed Experience Replay Benchmark",
    "",
    report.scope,
    "",
    `- Run: ${report.runId}`,
    `- Execution: ${report.executionKind}`,
    `- Codex authentication: ${report.codexAuthMode}`,
    `- Profile policy: ${report.profile}`,
    `- Model: ${report.model}`,
    `- Tasks: ${report.taskCount}`,
    `- Replay attempts: ${report.attemptedReplayCount}`,
    `- Failures and missing outcomes: ${report.failureCount}`,
    `- One-time Memory preparation cost (USD): ${display(report.preparationCostUsd)}`,
    `- Trajectory judge overhead (USD, excluded from treatment costs): ${display(report.judgeOverheadCostUsd)}`,
    "",
    "## Paired task-first comparisons",
    ""
  ];
  for (const comparison of report.comparisons) {
    lines.push(
      `### ${comparison.comparison}`,
      "",
      `Mean delta: ${display(comparison.meanDelta)}; median delta: ${display(comparison.medianDelta)}; wins/losses/ties: ${comparison.wins}/${comparison.losses}/${comparison.ties}.`,
      "",
      `Task-first resource deltas (left minus right): latency ${display(comparison.latencyMsDelta)} ms; tokens ${display(comparison.tokensDelta)}; cost USD ${display(comparison.costUsdDelta)}.`,
      "",
      `Complete-case tasks: ${comparison.completeTaskCount}/${comparison.totalTaskCount}. Missing outcomes: ${comparison.missingOutcomeCount}. Worst/best missing-outcome bounds: ${display(comparison.worstCaseEstimate)} to ${display(comparison.bestCaseEstimate)}.`,
      ""
    );
    const confidence = report.intervals?.[comparison.comparison];
    if (confidence) {
      lines.push(
        `Matched repeat-block 95% interval: ${display(confidence.repeat.lower)} to ${display(confidence.repeat.upper)}.`,
        "",
        `Complete-task empirical 95% interval: ${display(confidence.task.lower)} to ${display(confidence.task.upper)}.`,
        ""
      );
    }
  }
  if (report.trajectoryJudgments.length) {
    lines.push("## Blind trajectory judgments", "");
    for (const comparison of comparisonNames) {
      const judgments = report.trajectoryJudgments.filter(
        (judgment) => judgment.comparison === comparison
      );
      if (!judgments.length) continue;
      const errors = judgments.filter(
        (judgment) => judgment.status === "error"
      ).length;
      const left = comparison.split(" - ")[0];
      const right = comparison.split(" - ")[1];
      lines.push(
        `- ${comparison}: ${judgments.filter((judgment) => judgment.preferredCondition === left).length} preferred ${left}, ${judgments.filter((judgment) => judgment.preferredCondition === right).length} preferred ${right}, ${judgments.filter((judgment) => judgment.preferredCondition === "tie").length} ties, ${errors} missing/error.`
      );
    }
    lines.push("");
  }
  if (report.attempts.length) {
    lines.push("## Attempt ledger", "");
    for (const attempt of report.attempts) {
      lines.push(
        `- ${attempt.taskDigest}; ${attempt.condition}; repeat ${attempt.repeat}; reward ${display(attempt.reward)}; passed ${String(attempt.passed ?? "missing")}; failure ${attempt.failureCategory ?? "none"}${attempt.infrastructureCode ? ` (${attempt.infrastructureCode})` : ""}.`
      );
    }
    lines.push("");
  }
  if (report.exclusions.length) {
    lines.push("## Exclusion ledger", "");
    for (const exclusion of report.exclusions) {
      lines.push(
        `- ${exclusion.taskDigest}; ${exclusion.category}; ${exclusion.phase}.`
      );
    }
    lines.push("");
  }
  if (report.detailFiles?.length) {
    lines.push(
      "## Local details",
      "",
      ...report.detailFiles.map((file) => `- ${file}`),
      ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const select = (source: JsonRecord, keys: readonly string[]): JsonRecord =>
  Object.fromEntries(
    keys.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]]
    )
  );

const selectNumbers = (
  source: JsonRecord,
  keys: readonly string[]
): JsonRecord =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === null ||
        (typeof value === "number" && Number.isFinite(value))
        ? [[key, value]]
        : [];
    })
  );

const selectEnum = (
  source: JsonRecord,
  key: string,
  allowed: readonly string[]
): JsonRecord => {
  const value = source[key];
  return typeof value === "string" && allowed.includes(value)
    ? { [key]: value }
    : {};
};

const comparisonKeys = [
  "comparison",
  "meanDelta",
  "medianDelta",
  "latencyMsDelta",
  "tokensDelta",
  "costUsdDelta",
  "wins",
  "losses",
  "ties",
  "completeCaseEstimate",
  "bestCaseEstimate",
  "worstCaseEstimate",
  "completeTaskCount",
  "totalTaskCount",
  "missingOutcomeCount"
] as const;

const comparisonNames = [
  "relevant - placebo",
  "relevant - cold",
  "relevant - empty",
  "empty - cold",
  "placebo - empty",
  "relevant_guidance - irrelevant",
  "relevant_trace - irrelevant",
  "relevant_full - irrelevant",
  "relevant_guidance - empty",
  "relevant_trace - empty",
  "relevant_full - empty",
  "relevant_full - cold",
  "relevant_full - relevant_guidance",
  "relevant_full - relevant_trace",
  "irrelevant - empty",
  "direct_guidance - relevant_full",
  "direct_guidance - relevant_guidance",
  "direct_guidance - empty"
] as const;

const projectComparison = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  const projected: JsonRecord = {
    ...selectEnum(value, "comparison", comparisonNames),
    ...selectNumbers(
      value,
      comparisonKeys.filter((key) => key !== "comparison")
    )
  };
  if (Array.isArray(value.taskDeltas)) {
    projected.taskDeltas = value.taskDeltas.map((delta) =>
      isRecord(delta)
        ? {
            ...select(delta, ["taskDigest"]),
            ...selectNumbers(delta, [
              "repeat",
              "leftMean",
              "rightMean",
              "delta"
            ])
          }
        : {}
    );
  }
  if (isRecord(value.resourceDeltas)) {
    const resources = value.resourceDeltas;
    projected.resourceDeltas = {
      ...(projectNested(resources.durations, [
        "replayElapsedMs",
        "trialElapsedMs",
        "agentMs",
        "setupMs",
        "verifierMs"
      ])
        ? {
            durations: projectNested(resources.durations, [
              "replayElapsedMs",
              "trialElapsedMs",
              "agentMs",
              "setupMs",
              "verifierMs"
            ])
          }
        : {}),
      ...(projectNested(resources.tokenUsage, scalarTelemetryKeys.tokenUsage)
        ? {
            tokenUsage: projectNested(
              resources.tokenUsage,
              scalarTelemetryKeys.tokenUsage
            )
          }
        : {}),
      ...(projectNested(resources.costs, scalarTelemetryKeys.costs)
        ? { costs: projectNested(resources.costs, scalarTelemetryKeys.costs) }
        : {}),
      ...(projectNested(
        resources.interactions,
        scalarTelemetryKeys.interactions
      )
        ? {
            interactions: projectNested(
              resources.interactions,
              scalarTelemetryKeys.interactions
            )
          }
        : {}),
      ...(isRecord(resources.memoryAnswerWorker)
        ? {
            memoryAnswerWorker: projectWorkerUsage(resources.memoryAnswerWorker)
          }
        : {}),
      ...(projectNested(resources.recall, scalarTelemetryKeys.recall)
        ? {
            recall: projectNested(resources.recall, scalarTelemetryKeys.recall)
          }
        : {})
    };
  }
  return projected;
};

const projectIntervals = (value: unknown): JsonRecord | undefined => {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([comparison, methods]) => {
      if (
        !comparisonNames.includes(
          comparison as (typeof comparisonNames)[number]
        )
      ) {
        return [];
      }
      if (!isRecord(methods)) return [[comparison, {}]];
      return [
        [
          comparison,
          Object.fromEntries(
            ["repeat", "task"].flatMap((method) => {
              const candidate = methods[method];
              return isRecord(candidate)
                ? [
                    [
                      method,
                      {
                        ...selectNumbers(candidate, [
                          "lower",
                          "upper",
                          "resamples"
                        ]),
                        ...selectEnum(candidate, "method", [
                          "matched-repeat-block",
                          "complete-task"
                        ])
                      }
                    ]
                  ]
                : [];
            })
          )
        ]
      ];
    })
  );
};

const scalarTelemetryKeys = {
  durations: ["agentMs", "setupMs", "verifierMs"],
  tokenUsage: ["uncachedInput", "cachedInput", "output", "reasoning"],
  costs: ["providerBilledUsd", "apiEquivalentUsd", "subscriptionUsd"],
  interactions: [
    "turns",
    "toolCalls",
    "toolFailures",
    "mcpCalls",
    "mcpFailures",
    "memoryAnswerCalls",
    "memoryAnswerFailures"
  ],
  recall: ["searches", "expansions", "stages", "evidenceCount"],
  embedding: ["calls", "tokens", "durationMs"],
  pipeline: ["projectionMs", "lcmMs", "queueMs"],
  rss: ["apiBytes", "runtimeBytes", "workerBytes"],
  source: [
    "sourceTaskDigest",
    "sourcePassed",
    "sourceCategory",
    "sourcePassFailSplit",
    "sourceCategorySplit"
  ]
} as const;

const projectNested = (
  value: unknown,
  keys: readonly string[]
): JsonRecord | undefined =>
  isRecord(value) ? selectNumbers(value, keys) : undefined;

const projectSource = (value: unknown): JsonRecord | undefined => {
  if (!isRecord(value)) return undefined;
  return {
    ...Object.fromEntries(
      [
        "sourceTaskDigest",
        "sourceCategory",
        "sourcePassFailSplit",
        "sourceCategorySplit"
      ].flatMap((key) =>
        value[key] === null || typeof value[key] === "string"
          ? [[key, value[key]]]
          : []
      )
    ),
    ...(value.sourcePassed === null || typeof value.sourcePassed === "boolean"
      ? { sourcePassed: value.sourcePassed }
      : {})
  };
};

const projectWorkerUsage = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  return {
    ...selectNumbers(value, ["calls", "failures", "durationMs"]),
    ...(projectNested(value.tokens, scalarTelemetryKeys.tokenUsage)
      ? { tokens: projectNested(value.tokens, scalarTelemetryKeys.tokenUsage) }
      : {}),
    ...(projectNested(value.costs, scalarTelemetryKeys.costs)
      ? { costs: projectNested(value.costs, scalarTelemetryKeys.costs) }
      : {})
  };
};

const projectAttempt = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  const projected: JsonRecord = {
    ...(typeof value.taskDigest === "string"
      ? { taskDigest: value.taskDigest }
      : {}),
    ...selectEnum(value, "condition", [
      "cold",
      "empty",
      "placebo",
      "relevant",
      "irrelevant",
      "relevant_guidance",
      "relevant_trace",
      "relevant_full",
      "direct_guidance"
    ]),
    ...selectNumbers(value, [
      "repeat",
      "reward",
      "latencyMs",
      "tokens",
      "costUsd"
    ]),
    ...(value.passed === null || typeof value.passed === "boolean"
      ? { passed: value.passed }
      : {}),
    ...selectEnum(value, "failureCategory", [
      "admission_rejected",
      "setup_failed",
      "setup_timeout",
      "agent_failed",
      "agent_timeout",
      "memory_failed",
      "verifier_failed",
      "verifier_timeout",
      "teardown_failed",
      "missing_outcome",
      "other"
    ]),
    ...selectEnum(value, "failureKind", ["agent", "infrastructure"]),
    ...selectEnum(value, "failurePhase", [
      "admission",
      "setup",
      "agent",
      "memory",
      "verifier",
      "teardown"
    ]),
    ...(typeof value.infrastructureCode === "string"
      ? { infrastructureCode: value.infrastructureCode }
      : {})
  };
  for (const [field, keys] of Object.entries(scalarTelemetryKeys)) {
    const nested =
      field === "source"
        ? projectSource(value[field])
        : projectNested(value[field], keys);
    if (nested !== undefined) projected[field] = nested;
  }
  if (isRecord(value.workers)) {
    const workers = value.workers;
    projected.workers = Object.fromEntries(
      ["memoryAnswer", "lcmSummary", "sessionTitle"].flatMap((worker) =>
        isRecord(workers[worker])
          ? [[worker, projectWorkerUsage(workers[worker])]]
          : []
      )
    );
  }
  if (isRecord(value.telemetryStatus)) {
    const telemetryStatus = value.telemetryStatus;
    projected.telemetryStatus = Object.fromEntries(
      [
        "harbor",
        "codex",
        "koedRecall",
        "modelWorkflows",
        "embeddings",
        "processRss"
      ].flatMap((source) => {
        const state = telemetryStatus[source];
        return state === "available" ||
          state === "missing" ||
          state === "failed"
          ? [[source, state]]
          : [];
      })
    );
  }
  return projected;
};

const projectExclusion = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  const projected: JsonRecord = {
    ...(typeof value.taskDigest === "string"
      ? { taskDigest: value.taskDigest }
      : {}),
    ...selectEnum(value, "category", [
      "task_not_in_profile",
      "resource_incompatible",
      "source_unavailable",
      "source_invalid",
      "policy_excluded",
      "preflight_rejected",
      "other"
    ]),
    ...selectEnum(value, "phase", ["selection", "preparation", "admission"])
  };
  const source = projectSource(value.source);
  if (source !== undefined) projected.source = source;
  return projected;
};

const projectJudgeAssessment = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  return {
    ...selectNumbers(value, [
      "progress_quality",
      "efficiency",
      "error_recognition",
      "failed_approach_avoidance",
      "informed_failure",
      "retrieval_quality",
      "correct_prior_experience_reuse",
      "distraction_resistance"
    ]),
    evidence_refs: Array.isArray(value.evidence_refs)
      ? value.evidence_refs.filter(
          (reference): reference is string =>
            typeof reference === "string" &&
            /^(?:source|A|B):step:[0-9]+(?::(?:message|reasoning|tool-call:[0-9]+|tool-result:[0-9]+))?$/u.test(
              reference
            )
        )
      : []
  };
};

const projectTrajectoryJudgment = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return {};
  const projected: JsonRecord = {
    ...(typeof value.taskDigest === "string"
      ? { taskDigest: value.taskDigest }
      : {}),
    ...selectEnum(value, "comparison", comparisonNames),
    ...selectEnum(value, "status", ["judged", "error"]),
    ...selectEnum(value, "preferredCondition", [
      "cold",
      "empty",
      "placebo",
      "relevant",
      "irrelevant",
      "relevant_guidance",
      "relevant_trace",
      "relevant_full",
      "direct_guidance",
      "tie"
    ]),
    ...selectNumbers(value, ["repeat", "confidence", "latencyMs", "costUsd"]),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.rationale === "string"
      ? { rationale: value.rationale }
      : {})
  };
  if (isRecord(value.assessments)) {
    const assessments = value.assessments;
    projected.assessments = Object.fromEntries(
      [
        "cold",
        "empty",
        "placebo",
        "relevant",
        "irrelevant",
        "relevant_guidance",
        "relevant_trace",
        "relevant_full",
        "direct_guidance"
      ].flatMap((condition) =>
        isRecord(assessments[condition])
          ? [[condition, projectJudgeAssessment(assessments[condition])]]
          : []
      )
    );
  }
  const tokenUsage = projectNested(
    value.tokenUsage,
    scalarTelemetryKeys.tokenUsage
  );
  if (tokenUsage) projected.tokenUsage = tokenUsage;
  return projected;
};

const projectPublicationReport = (value: unknown): unknown => {
  if (typeof value === "string") return value;
  if (!isRecord(value)) {
    throw new Error("Publication report must be an object or Markdown string");
  }
  const projected: JsonRecord = {
    ...Object.fromEntries(
      ["benchmark_kind", "disclosure", "scope", "runId", "model"].flatMap(
        (key) => (typeof value[key] === "string" ? [[key, value[key]]] : [])
      )
    ),
    ...selectEnum(value, "executionKind", [
      "benchmark_profile",
      "product_path_proof",
      "oracle_seeded_product_proof",
      "oracle_seeded_repeated_study"
    ]),
    ...selectEnum(value, "profile", ["smoke", "quick", "standard", "full"]),
    ...selectEnum(value, "codexAuthMode", ["api_key", "subscription"]),
    ...selectNumbers(value, [
      "report_version",
      "taskCount",
      "attemptedReplayCount",
      "failureCount",
      "preparationCostUsd",
      "judgeOverheadCostUsd"
    ]),
    ...(typeof value.standard_leaderboard_comparable === "boolean"
      ? {
          standard_leaderboard_comparable: value.standard_leaderboard_comparable
        }
      : {})
  };
  projected.comparisons = Array.isArray(value.comparisons)
    ? value.comparisons.map(projectComparison)
    : [];
  projected.attempts = Array.isArray(value.attempts)
    ? value.attempts.map(projectAttempt)
    : [];
  projected.exclusions = Array.isArray(value.exclusions)
    ? value.exclusions.map(projectExclusion)
    : [];
  projected.trajectoryJudgments = Array.isArray(value.trajectoryJudgments)
    ? value.trajectoryJudgments.map(projectTrajectoryJudgment)
    : [];
  const intervals = projectIntervals(value.intervals);
  if (intervals !== undefined) projected.intervals = intervals;
  if (Array.isArray(value.detailFiles)) {
    projected.detailFiles = value.detailFiles.filter(
      (file): file is string =>
        typeof file === "string" &&
        /^(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9._/-]+$/i.test(file)
    );
  }
  return projected;
};

const secretSignatures: readonly [string, RegExp][] = [
  ["bearer credential", /\bbearer\s+[a-z0-9._~+/=-]{8,}/i],
  ["JWT", /\beyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i],
  [
    "GitHub credential",
    /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/i
  ],
  ["Slack credential", /\bxox[baprs]-[a-z0-9-]{10,}\b/i],
  ["npm credential", /\bnpm_[a-z0-9]{20,}\b/i],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  [
    "Google Cloud credential",
    /\b(?:AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,})\b/
  ],
  ["Azure credential", /\b(?:AccountKey|SharedAccessKey)=[a-z0-9+/=]{16,}/i],
  ["cloud credential", /\b(?:dop_v1_|linode_|scw_secret_)[a-z0-9_-]{20,}\b/i],
  ["Koed API token", /\bcmt_[a-z0-9_-]{32,}\b/i],
  ["provider credential", /\bsk-(?:proj-|ant-)?[a-z0-9_-]{20,}\b/i],
  [
    "credential-bearing URL",
    /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s:/?#]+:[^@\s/?#]+@|[^\s?#]+[?&](?:access[_-]?token|api[_-]?key|password|secret|sig)=[^\s&#]+)/i
  ],
  [
    "assigned credential",
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|credential)\s*[:=]\s*["']?[a-z0-9._~+/=-]{8,}/i
  ]
];

export const assertPublicationHasNoSecrets = (value: unknown): void => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const [name, signature] of secretSignatures) {
    if (signature.test(serialized)) {
      throw new Error(`Publication blocked by unresolved ${name}`);
    }
  }
};

export const redactPublicationReport = (value: unknown): unknown => {
  const publication = projectPublicationReport(value);
  assertPublicationHasNoSecrets(publication);
  return publication;
};
