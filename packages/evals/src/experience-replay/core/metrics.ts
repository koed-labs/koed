import type { ReplayCondition } from "./schedule.js";

export type FailureKind = "agent" | "infrastructure";
export type FailurePhase =
  | "admission"
  | "setup"
  | "agent"
  | "memory"
  | "verifier"
  | "teardown";

export type FailureCategory =
  | "admission_rejected"
  | "setup_failed"
  | "setup_timeout"
  | "agent_failed"
  | "agent_timeout"
  | "memory_failed"
  | "verifier_failed"
  | "verifier_timeout"
  | "teardown_failed"
  | "missing_outcome"
  | "other";

export interface DurationTelemetry {
  agentMs: number | null;
  setupMs: number | null;
  verifierMs: number | null;
}

export interface TokenTelemetry {
  uncachedInput: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoning: number | null;
}

export interface CostTelemetry {
  providerBilledUsd: number | null;
  apiEquivalentUsd: number | null;
  subscriptionUsd: number | null;
}

export interface InteractionTelemetry {
  turns: number | null;
  toolCalls: number | null;
  toolFailures: number | null;
  mcpCalls: number | null;
  mcpFailures: number | null;
  memoryAnswerCalls: number | null;
  memoryAnswerFailures: number | null;
}

export interface WorkerUsageTelemetry {
  calls: number | null;
  failures: number | null;
  durationMs: number | null;
  tokens: TokenTelemetry;
  costs: CostTelemetry;
}

export interface WorkerTelemetry {
  memoryAnswer: WorkerUsageTelemetry;
  lcmSummary: WorkerUsageTelemetry;
  sessionTitle: WorkerUsageTelemetry;
}

export interface RecallTelemetry {
  searches: number | null;
  expansions: number | null;
  stages: number | null;
  evidenceCount: number | null;
}

export interface EmbeddingTelemetry {
  calls: number | null;
  tokens: number | null;
  durationMs: number | null;
}

export interface PipelineTelemetry {
  projectionMs: number | null;
  lcmMs: number | null;
  queueMs: number | null;
}

export interface RssTelemetry {
  apiBytes: number | null;
  runtimeBytes: number | null;
  workerBytes: number | null;
}

export type TelemetryCollectionState = "available" | "missing" | "failed";

export interface TelemetryCollectionStatus {
  harbor: TelemetryCollectionState;
  codex: TelemetryCollectionState;
  koedRecall: TelemetryCollectionState;
  modelWorkflows: TelemetryCollectionState;
  embeddings: TelemetryCollectionState;
  processRss: TelemetryCollectionState;
}

export interface SourceSplitIdentifiers {
  sourceTaskDigest: string | null;
  sourcePassed: boolean | null;
  sourceCategory: string | null;
  sourcePassFailSplit: string | null;
  sourceCategorySplit: string | null;
}

export interface ReplayOutcome {
  taskDigest: string;
  condition: ReplayCondition;
  repeat: number;
  reward: number | null;
  passed?: boolean | null;
  latencyMs?: number | null;
  tokens?: number | null;
  costUsd?: number | null;
  durations?: DurationTelemetry;
  tokenUsage?: TokenTelemetry;
  costs?: CostTelemetry;
  interactions?: InteractionTelemetry;
  workers?: WorkerTelemetry;
  recall?: RecallTelemetry;
  embedding?: EmbeddingTelemetry;
  pipeline?: PipelineTelemetry;
  rss?: RssTelemetry;
  telemetryStatus?: TelemetryCollectionStatus;
  failureCategory?: FailureCategory | null;
  failureKind?: FailureKind | null;
  failurePhase?: FailurePhase | null;
  infrastructureCode?: string | null;
  source?: SourceSplitIdentifiers;
}

export interface TaskRewardContract {
  taskDigest: string;
  rewardMin: number;
  rewardMax: number;
}

export interface Comparison {
  left: ReplayCondition;
  right: ReplayCondition;
}

export const PRIMARY_COMPARISON: Comparison = {
  left: "relevant",
  right: "placebo"
};
export const REQUIRED_COMPARISONS: readonly Comparison[] = [
  PRIMARY_COMPARISON,
  { left: "relevant", right: "cold" },
  { left: "relevant", right: "empty" },
  { left: "empty", right: "cold" },
  { left: "placebo", right: "empty" }
];
export const ORACLE_REQUIRED_COMPARISONS: readonly Comparison[] = [
  { left: "relevant_guidance", right: "irrelevant" },
  { left: "relevant_trace", right: "irrelevant" },
  { left: "relevant_full", right: "irrelevant" },
  { left: "relevant_guidance", right: "empty" },
  { left: "relevant_trace", right: "empty" },
  { left: "relevant_full", right: "empty" },
  { left: "relevant_full", right: "cold" },
  { left: "relevant_full", right: "relevant_guidance" },
  { left: "relevant_full", right: "relevant_trace" },
  { left: "irrelevant", right: "empty" },
  { left: "empty", right: "cold" }
];
/** Prespecified one-task calibration contrasts; intervals are descriptive. */
export const ORACLE_REPEATED_REQUIRED_COMPARISONS: readonly Comparison[] = [
  { left: "direct_guidance", right: "relevant_full" },
  { left: "direct_guidance", right: "relevant_guidance" },
  { left: "relevant_full", right: "relevant_guidance" },
  { left: "relevant_full", right: "empty" },
  { left: "relevant_guidance", right: "empty" },
  { left: "direct_guidance", right: "empty" }
];

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[midpoint - 1] as number) + (sorted[midpoint] as number)) / 2
    : (sorted[midpoint] as number);
};

const validateOutcomes = (
  outcomes: readonly ReplayOutcome[],
  contracts: ReadonlyMap<string, TaskRewardContract>,
  repeats: number
): void => {
  const identities = new Set<string>();
  for (const outcome of outcomes) {
    const identity = `${outcome.taskDigest}\0${outcome.condition}\0${outcome.repeat}`;
    if (identities.has(identity))
      throw new Error(
        `Duplicate replay outcome ${identity.replaceAll("\0", "/")}`
      );
    identities.add(identity);
    if (
      !Number.isInteger(outcome.repeat) ||
      outcome.repeat < 0 ||
      outcome.repeat >= repeats
    ) {
      throw new Error(
        `Unexpected repeat ${outcome.repeat} for ${outcome.taskDigest}`
      );
    }
    const contract = contracts.get(outcome.taskDigest);
    if (!contract)
      throw new Error(`Missing reward contract for ${outcome.taskDigest}`);
    if (
      outcome.reward !== null &&
      (!Number.isFinite(outcome.reward) ||
        outcome.reward < contract.rewardMin ||
        outcome.reward > contract.rewardMax)
    ) {
      throw new Error(
        `Reward outside committed range for ${outcome.taskDigest}`
      );
    }
  }
};

const contractMap = (
  contracts: readonly TaskRewardContract[]
): ReadonlyMap<string, TaskRewardContract> => {
  if (contracts.length === 0)
    throw new Error("At least one task reward contract is required");
  const result = new Map<string, TaskRewardContract>();
  for (const contract of contracts) {
    if (result.has(contract.taskDigest))
      throw new Error(`Duplicate reward contract ${contract.taskDigest}`);
    if (
      !Number.isFinite(contract.rewardMin) ||
      !Number.isFinite(contract.rewardMax) ||
      contract.rewardMin > contract.rewardMax
    ) {
      throw new Error(
        `Invalid committed reward range for ${contract.taskDigest}`
      );
    }
    result.set(contract.taskDigest, contract);
  }
  return result;
};

const taskConditionValues = (
  outcomes: readonly ReplayOutcome[],
  taskDigest: string,
  condition: ReplayCondition
): ReplayOutcome[] =>
  outcomes
    .filter(
      (outcome) =>
        outcome.taskDigest === taskDigest && outcome.condition === condition
    )
    .sort((a, b) => a.repeat - b.repeat);

export interface TaskDelta {
  taskDigest: string;
  repeat?: number;
  leftMean: number;
  rightMean: number;
  delta: number;
}

export const taskFirstDeltas = (
  outcomes: readonly ReplayOutcome[],
  contracts: readonly TaskRewardContract[],
  comparison: Comparison,
  repeats: number
): TaskDelta[] => {
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("Repeats must be a positive integer");
  const contractsByTask = contractMap(contracts);
  validateOutcomes(outcomes, contractsByTask, repeats);
  const deltas: TaskDelta[] = [];
  for (const contract of [...contracts].sort((a, b) =>
    a.taskDigest.localeCompare(b.taskDigest)
  )) {
    const left = taskConditionValues(
      outcomes,
      contract.taskDigest,
      comparison.left
    );
    const right = taskConditionValues(
      outcomes,
      contract.taskDigest,
      comparison.right
    );
    if (
      left.length !== repeats ||
      right.length !== repeats ||
      left.some((item) => item.reward === null) ||
      right.some((item) => item.reward === null)
    )
      continue;
    const leftMean = mean(left.map((item) => item.reward as number));
    const rightMean = mean(right.map((item) => item.reward as number));
    deltas.push({
      taskDigest: contract.taskDigest,
      leftMean,
      rightMean,
      delta: leftMean - rightMean
    });
  }
  return deltas;
};

export interface MissingOutcomeBounds {
  completeCaseEstimate: number | null;
  bestCaseEstimate: number;
  worstCaseEstimate: number;
  completeTaskCount: number;
  totalTaskCount: number;
  missingOutcomeCount: number;
}

export const missingOutcomeBounds = (
  outcomes: readonly ReplayOutcome[],
  contracts: readonly TaskRewardContract[],
  comparison: Comparison,
  repeats: number
): MissingOutcomeBounds => {
  const contractsByTask = contractMap(contracts);
  validateOutcomes(outcomes, contractsByTask, repeats);
  const complete = taskFirstDeltas(outcomes, contracts, comparison, repeats);
  const worst: number[] = [];
  const best: number[] = [];
  let missingOutcomeCount = 0;
  for (const contract of contracts) {
    const values = (
      condition: ReplayCondition,
      missingValue: number
    ): number[] => {
      const indexed = new Map(
        taskConditionValues(outcomes, contract.taskDigest, condition).map(
          (item) => [item.repeat, item.reward]
        )
      );
      return Array.from({ length: repeats }, (_, repeat) => {
        const value = indexed.get(repeat);
        if (value === undefined || value === null) {
          missingOutcomeCount += 0.5;
          return missingValue;
        }
        return value;
      });
    };
    const worstLeft = values(comparison.left, contract.rewardMin);
    const worstRight = values(comparison.right, contract.rewardMax);
    const bestLeft = values(comparison.left, contract.rewardMax);
    const bestRight = values(comparison.right, contract.rewardMin);
    worst.push(mean(worstLeft) - mean(worstRight));
    best.push(mean(bestLeft) - mean(bestRight));
  }
  return {
    completeCaseEstimate:
      complete.length === 0 ? null : mean(complete.map((item) => item.delta)),
    bestCaseEstimate: mean(best),
    worstCaseEstimate: mean(worst),
    completeTaskCount: complete.length,
    totalTaskCount: contracts.length,
    missingOutcomeCount
  };
};

export interface ComparisonSummary extends MissingOutcomeBounds {
  comparison: string;
  meanDelta: number | null;
  medianDelta: number | null;
  resourceDeltas: TaskFirstResourceDeltas;
  latencyMsDelta: number | null;
  tokensDelta: number | null;
  costUsdDelta: number | null;
  wins: number;
  losses: number;
  ties: number;
  taskDeltas: readonly TaskDelta[];
}

export interface DurationResourceDeltas {
  /** Observed replay elapsed time from latencyMs; never a sum of phase durations. */
  replayElapsedMs: number | null;
  /** Sequential Harbor setup + agent + verifier phases for the complete trial. */
  trialElapsedMs: number | null;
  agentMs: number | null;
  setupMs: number | null;
  verifierMs: number | null;
}

export interface WorkerUsageResourceDeltas {
  calls: number | null;
  failures: number | null;
  durationMs: number | null;
  tokens: TokenTelemetry;
  costs: CostTelemetry;
}

export interface TaskFirstResourceDeltas {
  durations: DurationResourceDeltas;
  /** Coding agent plus Memory Answer worker, with each token class counted once. */
  tokenUsage: TokenTelemetry;
  costs: CostTelemetry;
  interactions: InteractionTelemetry;
  memoryAnswerWorker: WorkerUsageResourceDeltas;
  recall: RecallTelemetry;
}

type ResourceValue = (outcome: ReplayOutcome) => number | null | undefined;

export const taskFirstPairedResourceDelta = (
  outcomes: readonly ReplayOutcome[],
  comparison: Comparison,
  value: ResourceValue,
  repeats: number
): number | null => {
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("Repeats must be a positive integer");
  const tasks = [...new Set(outcomes.map((outcome) => outcome.taskDigest))];
  const deltas: number[] = [];
  for (const task of tasks) {
    const getValues = (condition: ReplayCondition) => {
      const records = taskConditionValues(outcomes, task, condition);
      if (records.length !== repeats) return null;
      const values = records.map(value);
      if (
        values.some(
          (metric): metric is null | undefined =>
            metric === null || metric === undefined || !Number.isFinite(metric)
        )
      )
        return null;
      return values as number[];
    };
    const left = getValues(comparison.left);
    const right = getValues(comparison.right);
    if (left && right) deltas.push(mean(left) - mean(right));
  }
  return deltas.length ? mean(deltas) : null;
};

export const taskFirstResourceDelta = (
  outcomes: readonly ReplayOutcome[],
  comparison: Comparison,
  field: "latencyMs" | "tokens" | "costUsd",
  repeats: number
): number | null => {
  return taskFirstPairedResourceDelta(
    outcomes,
    comparison,
    (outcome) => outcome[field],
    repeats
  );
};

export const taskFirstResourceDeltas = (
  outcomes: readonly ReplayOutcome[],
  comparison: Comparison,
  repeats: number
): TaskFirstResourceDeltas => {
  const delta = (value: ResourceValue): number | null =>
    taskFirstPairedResourceDelta(outcomes, comparison, value, repeats);
  const tokenDeltas = (
    value: (outcome: ReplayOutcome) => TokenTelemetry | undefined
  ): TokenTelemetry => ({
    uncachedInput: delta((outcome) => value(outcome)?.uncachedInput),
    cachedInput: delta((outcome) => value(outcome)?.cachedInput),
    output: delta((outcome) => value(outcome)?.output),
    reasoning: delta((outcome) => value(outcome)?.reasoning)
  });
  const costDeltas = (
    value: (outcome: ReplayOutcome) => CostTelemetry | undefined
  ): CostTelemetry => ({
    providerBilledUsd: delta((outcome) => value(outcome)?.providerBilledUsd),
    apiEquivalentUsd: delta((outcome) => value(outcome)?.apiEquivalentUsd),
    subscriptionUsd: delta((outcome) => value(outcome)?.subscriptionUsd)
  });
  const trialElapsed = (outcome: ReplayOutcome): number | null => {
    const values = [
      outcome.durations?.setupMs,
      outcome.durations?.agentMs,
      outcome.durations?.verifierMs
    ];
    return values.some(
      (value) =>
        value === null || value === undefined || !Number.isFinite(value)
    )
      ? null
      : values.reduce<number>((total, value) => total + value!, 0);
  };

  return {
    durations: {
      replayElapsedMs: delta((outcome) => outcome.latencyMs),
      trialElapsedMs: delta(trialElapsed),
      agentMs: delta((outcome) => outcome.durations?.agentMs),
      setupMs: delta((outcome) => outcome.durations?.setupMs),
      verifierMs: delta((outcome) => outcome.durations?.verifierMs)
    },
    tokenUsage: tokenDeltas((outcome) => outcome.tokenUsage),
    costs: costDeltas((outcome) => outcome.costs),
    interactions: {
      turns: delta((outcome) => outcome.interactions?.turns),
      toolCalls: delta((outcome) => outcome.interactions?.toolCalls),
      toolFailures: delta((outcome) => outcome.interactions?.toolFailures),
      mcpCalls: delta((outcome) => outcome.interactions?.mcpCalls),
      mcpFailures: delta((outcome) => outcome.interactions?.mcpFailures),
      memoryAnswerCalls: delta(
        (outcome) => outcome.interactions?.memoryAnswerCalls
      ),
      memoryAnswerFailures: delta(
        (outcome) => outcome.interactions?.memoryAnswerFailures
      )
    },
    memoryAnswerWorker: {
      calls: delta((outcome) => outcome.workers?.memoryAnswer.calls),
      failures: delta((outcome) => outcome.workers?.memoryAnswer.failures),
      durationMs: delta((outcome) => outcome.workers?.memoryAnswer.durationMs),
      tokens: tokenDeltas((outcome) => outcome.workers?.memoryAnswer.tokens),
      costs: costDeltas((outcome) => outcome.workers?.memoryAnswer.costs)
    },
    recall: {
      searches: delta((outcome) => outcome.recall?.searches),
      expansions: delta((outcome) => outcome.recall?.expansions),
      stages: delta((outcome) => outcome.recall?.stages),
      evidenceCount: delta((outcome) => outcome.recall?.evidenceCount)
    }
  };
};

export const summarizeComparison = (
  outcomes: readonly ReplayOutcome[],
  contracts: readonly TaskRewardContract[],
  comparison: Comparison,
  repeats: number
): ComparisonSummary => {
  const deltas = taskFirstDeltas(outcomes, contracts, comparison, repeats);
  const values = deltas.map((item) => item.delta);
  const resourceDeltas = taskFirstResourceDeltas(outcomes, comparison, repeats);
  return {
    comparison: `${comparison.left} - ${comparison.right}`,
    meanDelta: values.length ? mean(values) : null,
    medianDelta: values.length ? median(values) : null,
    resourceDeltas,
    latencyMsDelta: resourceDeltas.durations.replayElapsedMs,
    tokensDelta: taskFirstResourceDelta(
      outcomes,
      comparison,
      "tokens",
      repeats
    ),
    costUsdDelta: taskFirstResourceDelta(
      outcomes,
      comparison,
      "costUsd",
      repeats
    ),
    wins: values.filter((value) => value > 0).length,
    losses: values.filter((value) => value < 0).length,
    ties: values.filter((value) => value === 0).length,
    taskDeltas: deltas,
    ...missingOutcomeBounds(outcomes, contracts, comparison, repeats)
  };
};

export const summarizeRepeatedComparison = (
  outcomes: readonly ReplayOutcome[],
  contracts: readonly TaskRewardContract[],
  comparison: Comparison,
  repeats: number
): ComparisonSummary => {
  if (contracts.length !== 1)
    throw new Error("Repeated calibration requires exactly one task contract");
  // Reuse the strict cohort/range validation and missing-outcome bounds.
  taskFirstDeltas(outcomes, contracts, comparison, repeats);
  const contract = contracts[0]!;
  const paired: TaskDelta[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const left = outcomes.find(
      (item) =>
        item.taskDigest === contract.taskDigest &&
        item.condition === comparison.left &&
        item.repeat === repeat
    );
    const right = outcomes.find(
      (item) =>
        item.taskDigest === contract.taskDigest &&
        item.condition === comparison.right &&
        item.repeat === repeat
    );
    if (left?.reward === null || right?.reward === null) continue;
    if (left?.reward === undefined || right?.reward === undefined) continue;
    paired.push({
      taskDigest: contract.taskDigest,
      repeat,
      leftMean: left.reward,
      rightMean: right.reward,
      delta: left.reward - right.reward
    });
  }
  const values = paired.map((item) => item.delta);
  const resourceDeltas = taskFirstResourceDeltas(outcomes, comparison, repeats);
  return {
    comparison: `${comparison.left} - ${comparison.right}`,
    meanDelta: values.length ? mean(values) : null,
    medianDelta: values.length ? median(values) : null,
    resourceDeltas,
    latencyMsDelta: resourceDeltas.durations.replayElapsedMs,
    tokensDelta: taskFirstResourceDelta(
      outcomes,
      comparison,
      "tokens",
      repeats
    ),
    costUsdDelta: taskFirstResourceDelta(
      outcomes,
      comparison,
      "costUsd",
      repeats
    ),
    wins: values.filter((value) => value > 0).length,
    losses: values.filter((value) => value < 0).length,
    ties: values.filter((value) => value === 0).length,
    taskDeltas: paired,
    ...missingOutcomeBounds(outcomes, contracts, comparison, repeats)
  };
};
