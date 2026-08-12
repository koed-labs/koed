import type { ReplayCondition } from "./core/schedule.js";
import type {
  CostTelemetry,
  EmbeddingTelemetry,
  FailureCategory,
  FailureKind,
  FailurePhase,
  InteractionTelemetry,
  PipelineTelemetry,
  RecallTelemetry,
  ReplayOutcome,
  RssTelemetry,
  TelemetryCollectionState,
  TokenTelemetry,
  WorkerTelemetry,
  WorkerUsageTelemetry
} from "./core/metrics.js";

type JsonRecord = Record<string, unknown>;

export interface AttemptTelemetryIdentity {
  taskDigest: string;
  condition: ReplayCondition;
  repeat: number;
}

export interface TelemetryEnvelope {
  identity: AttemptTelemetryIdentity;
  status: TelemetryCollectionState;
  metrics?: unknown;
}

export interface ReplayTelemetryMergeInput {
  identity: AttemptTelemetryIdentity;
  harbor?: TelemetryEnvelope;
  codex?: TelemetryEnvelope;
  koedRecall?: TelemetryEnvelope;
  modelWorkflows?: TelemetryEnvelope;
  embeddings?: TelemetryEnvelope;
  processRss?: TelemetryEnvelope;
}

export interface PreparationTelemetry {
  costUsd: number | null;
  workers: Pick<WorkerTelemetry, "lcmSummary" | "sessionTitle">;
  embedding: EmbeddingTelemetry;
  pipeline: PipelineTelemetry;
}

export interface ReplayTelemetryMergeResult {
  outcome: ReplayOutcome;
  preparation: PreparationTelemetry;
}

const conditions = new Set<ReplayCondition>([
  "cold",
  "empty",
  "placebo",
  "relevant"
]);
const collectionStates = new Set<TelemetryCollectionState>([
  "available",
  "missing",
  "failed"
]);
const failureCategories = new Set<FailureCategory>([
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
]);
const failureKinds = new Set<FailureKind>(["agent", "infrastructure"]);
const failurePhases = new Set<FailurePhase>([
  "admission",
  "setup",
  "agent",
  "memory",
  "verifier",
  "teardown"
]);

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const exactKeys = (
  value: JsonRecord,
  allowed: readonly string[],
  label: string
): void => {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length)
    throw new Error(`${label} contains unexpected field ${unexpected[0]}`);
};

const record = (
  value: unknown,
  allowed: readonly string[],
  label: string
): JsonRecord => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, allowed, label);
  return value;
};

const finite = (value: unknown, label: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a nonnegative finite number or null`);
  return value;
};

const count = (value: unknown, label: string): number | null => {
  const parsed = finite(value, label);
  if (parsed !== null && !Number.isSafeInteger(parsed))
    throw new Error(`${label} must be a nonnegative safe integer or null`);
  return parsed;
};

const nullableBoolean = (value: unknown, label: string): boolean | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean")
    throw new Error(`${label} must be boolean or null`);
  return value;
};

const enumValue = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string
): T | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.has(value as T))
    throw new Error(`${label} is invalid`);
  return value as T;
};

const validateIdentity = (
  value: unknown,
  label = "attempt identity"
): AttemptTelemetryIdentity => {
  const item = record(value, ["taskDigest", "condition", "repeat"], label);
  if (
    typeof item.taskDigest !== "string" ||
    item.taskDigest.length < 1 ||
    item.taskDigest.length > 256 ||
    /[\0\r\n]/u.test(item.taskDigest)
  )
    throw new Error(`${label} has an invalid task digest`);
  if (
    typeof item.condition !== "string" ||
    !conditions.has(item.condition as ReplayCondition)
  )
    throw new Error(`${label} has an invalid condition`);
  if (!Number.isSafeInteger(item.repeat) || (item.repeat as number) < 0)
    throw new Error(`${label} has an invalid repeat`);
  return {
    taskDigest: item.taskDigest,
    condition: item.condition as ReplayCondition,
    repeat: item.repeat as number
  };
};

const sameIdentity = (
  expected: AttemptTelemetryIdentity,
  actual: AttemptTelemetryIdentity
): boolean =>
  expected.taskDigest === actual.taskDigest &&
  expected.condition === actual.condition &&
  expected.repeat === actual.repeat;

const envelope = (
  value: TelemetryEnvelope | undefined,
  expected: AttemptTelemetryIdentity,
  label: string
): { status: TelemetryCollectionState; metrics: JsonRecord | null } => {
  if (value === undefined) return { status: "missing", metrics: null };
  const item = record(value, ["identity", "status", "metrics"], label);
  const identity = validateIdentity(item.identity, `${label} identity`);
  if (!sameIdentity(expected, identity))
    throw new Error(`${label} identity does not match the replay attempt`);
  if (
    typeof item.status !== "string" ||
    !collectionStates.has(item.status as TelemetryCollectionState)
  )
    throw new Error(`${label} has an invalid collection status`);
  const status = item.status as TelemetryCollectionState;
  if (status !== "available") {
    if (item.metrics !== undefined && item.metrics !== null)
      throw new Error(`${label} ${status} collection must not carry metrics`);
    return { status, metrics: null };
  }
  if (!isRecord(item.metrics))
    throw new Error(`${label} available collection requires metrics`);
  return { status, metrics: item.metrics };
};

const tokens = (value: unknown, label: string): TokenTelemetry => {
  const item =
    value === undefined || value === null
      ? {}
      : record(
          value,
          ["uncachedInput", "cachedInput", "output", "reasoning"],
          label
        );
  return {
    uncachedInput: count(item.uncachedInput, `${label}.uncachedInput`),
    cachedInput: count(item.cachedInput, `${label}.cachedInput`),
    output: count(item.output, `${label}.output`),
    reasoning: count(item.reasoning, `${label}.reasoning`)
  };
};

const costs = (value: unknown, label: string): CostTelemetry => {
  const item =
    value === undefined || value === null
      ? {}
      : record(
          value,
          ["providerBilledUsd", "apiEquivalentUsd", "subscriptionUsd"],
          label
        );
  return {
    providerBilledUsd: finite(
      item.providerBilledUsd,
      `${label}.providerBilledUsd`
    ),
    apiEquivalentUsd: finite(
      item.apiEquivalentUsd,
      `${label}.apiEquivalentUsd`
    ),
    subscriptionUsd: finite(item.subscriptionUsd, `${label}.subscriptionUsd`)
  };
};

const worker = (value: unknown, label: string): WorkerUsageTelemetry => {
  const item =
    value === undefined || value === null
      ? {}
      : record(
          value,
          ["calls", "failures", "durationMs", "tokens", "costs"],
          label
        );
  const calls = count(item.calls, `${label}.calls`);
  const failures = count(item.failures, `${label}.failures`);
  if (calls !== null && failures !== null && failures > calls)
    throw new Error(`${label}.failures cannot exceed calls`);
  return {
    calls,
    failures,
    durationMs: finite(item.durationMs, `${label}.durationMs`),
    tokens: tokens(item.tokens, `${label}.tokens`),
    costs: costs(item.costs, `${label}.costs`)
  };
};

const sumComplete = (values: readonly (number | null)[]): number | null =>
  values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value as number), 0);

const sumTokens = (
  left: TokenTelemetry,
  right: TokenTelemetry
): number | null =>
  sumComplete([
    left.uncachedInput,
    left.cachedInput,
    left.output,
    left.reasoning,
    right.uncachedInput,
    right.cachedInput,
    right.output,
    right.reasoning
  ]);

export const mergeReplayTelemetry = (
  input: ReplayTelemetryMergeInput
): ReplayTelemetryMergeResult => {
  const mergeInput = record(
    input,
    [
      "identity",
      "harbor",
      "codex",
      "koedRecall",
      "modelWorkflows",
      "embeddings",
      "processRss"
    ],
    "telemetry merge input"
  );
  const identity = validateIdentity(mergeInput.identity);
  const harbor = envelope(input.harbor, identity, "Harbor telemetry");
  const codex = envelope(input.codex, identity, "Codex telemetry");
  const recallSource = envelope(
    input.koedRecall,
    identity,
    "Koed Recall telemetry"
  );
  const workflows = envelope(
    input.modelWorkflows,
    identity,
    "model workflow telemetry"
  );
  const embeddingSource = envelope(
    input.embeddings,
    identity,
    "embedding telemetry"
  );
  const rssSource = envelope(
    input.processRss,
    identity,
    "process RSS telemetry"
  );

  const harborMetrics =
    harbor.metrics === null
      ? {}
      : record(
          harbor.metrics,
          [
            "reward",
            "passed",
            "setupMs",
            "agentMs",
            "verifierMs",
            "failureCategory",
            "failureKind",
            "failurePhase"
          ],
          "Harbor metrics"
        );
  const reward = finite(harborMetrics.reward, "Harbor metrics.reward");
  const passed = nullableBoolean(harborMetrics.passed, "Harbor metrics.passed");
  const failureCategory = enumValue(
    harborMetrics.failureCategory,
    failureCategories,
    "Harbor metrics.failureCategory"
  );
  const failureKind = enumValue(
    harborMetrics.failureKind,
    failureKinds,
    "Harbor metrics.failureKind"
  );
  const failurePhase = enumValue(
    harborMetrics.failurePhase,
    failurePhases,
    "Harbor metrics.failurePhase"
  );
  const failureParts = [failureCategory, failureKind, failurePhase].filter(
    (value) => value !== null
  ).length;
  if (failureParts !== 0 && failureParts !== 3)
    throw new Error(
      "Harbor failure category, kind and phase must be supplied together"
    );

  const codexMetrics =
    codex.metrics === null
      ? {}
      : record(
          codex.metrics,
          [
            "tokens",
            "costs",
            "turns",
            "toolCalls",
            "toolFailures",
            "mcpCalls",
            "mcpFailures",
            "memoryAnswerCalls",
            "memoryAnswerFailures"
          ],
          "Codex metrics"
        );
  const agentTokens = tokens(codexMetrics.tokens, "Codex metrics.tokens");
  const agentCosts = costs(codexMetrics.costs, "Codex metrics.costs");
  const interactions: InteractionTelemetry = {
    turns: count(codexMetrics.turns, "Codex metrics.turns"),
    toolCalls: count(codexMetrics.toolCalls, "Codex metrics.toolCalls"),
    toolFailures: count(
      codexMetrics.toolFailures,
      "Codex metrics.toolFailures"
    ),
    mcpCalls: count(codexMetrics.mcpCalls, "Codex metrics.mcpCalls"),
    mcpFailures: count(codexMetrics.mcpFailures, "Codex metrics.mcpFailures"),
    memoryAnswerCalls: count(
      codexMetrics.memoryAnswerCalls,
      "Codex metrics.memoryAnswerCalls"
    ),
    memoryAnswerFailures: count(
      codexMetrics.memoryAnswerFailures,
      "Codex metrics.memoryAnswerFailures"
    )
  };
  for (const [failuresKey, callsKey] of [
    ["toolFailures", "toolCalls"],
    ["mcpFailures", "mcpCalls"],
    ["memoryAnswerFailures", "memoryAnswerCalls"]
  ] as const) {
    const failures = interactions[failuresKey];
    const calls = interactions[callsKey];
    if (failures !== null && calls !== null && failures > calls)
      throw new Error(`Codex metrics.${failuresKey} cannot exceed ${callsKey}`);
  }

  const recallMetrics =
    recallSource.metrics === null
      ? {}
      : record(
          recallSource.metrics,
          [
            "searches",
            "expansions",
            "stages",
            "evidenceCount",
            "projectionMs",
            "lcmMs",
            "queueMs"
          ],
          "Koed Recall metrics"
        );
  const recall: RecallTelemetry = {
    searches: count(recallMetrics.searches, "Koed Recall metrics.searches"),
    expansions: count(
      recallMetrics.expansions,
      "Koed Recall metrics.expansions"
    ),
    stages: count(recallMetrics.stages, "Koed Recall metrics.stages"),
    evidenceCount: count(
      recallMetrics.evidenceCount,
      "Koed Recall metrics.evidenceCount"
    )
  };
  const pipeline: PipelineTelemetry = {
    projectionMs: finite(
      recallMetrics.projectionMs,
      "Koed Recall metrics.projectionMs"
    ),
    lcmMs: finite(recallMetrics.lcmMs, "Koed Recall metrics.lcmMs"),
    queueMs: finite(recallMetrics.queueMs, "Koed Recall metrics.queueMs")
  };

  const workflowMetrics =
    workflows.metrics === null
      ? {}
      : record(
          workflows.metrics,
          ["memoryAnswer", "lcmSummary", "sessionTitle"],
          "model workflow metrics"
        );
  const workers: WorkerTelemetry = {
    memoryAnswer: worker(
      workflowMetrics.memoryAnswer,
      "model workflow metrics.memoryAnswer"
    ),
    lcmSummary: worker(
      workflowMetrics.lcmSummary,
      "model workflow metrics.lcmSummary"
    ),
    sessionTitle: worker(
      workflowMetrics.sessionTitle,
      "model workflow metrics.sessionTitle"
    )
  };

  const embeddingMetrics =
    embeddingSource.metrics === null
      ? {}
      : record(
          embeddingSource.metrics,
          ["calls", "tokens", "durationMs"],
          "embedding metrics"
        );
  const embedding: EmbeddingTelemetry = {
    calls: count(embeddingMetrics.calls, "embedding metrics.calls"),
    tokens: count(embeddingMetrics.tokens, "embedding metrics.tokens"),
    durationMs: finite(
      embeddingMetrics.durationMs,
      "embedding metrics.durationMs"
    )
  };
  const rssMetrics =
    rssSource.metrics === null
      ? {}
      : record(
          rssSource.metrics,
          ["apiBytes", "runtimeBytes", "workerBytes"],
          "process RSS metrics"
        );
  const rss: RssTelemetry = {
    apiBytes: count(rssMetrics.apiBytes, "process RSS metrics.apiBytes"),
    runtimeBytes: count(
      rssMetrics.runtimeBytes,
      "process RSS metrics.runtimeBytes"
    ),
    workerBytes: count(
      rssMetrics.workerBytes,
      "process RSS metrics.workerBytes"
    )
  };

  const replayCosts: CostTelemetry = {
    providerBilledUsd: sumComplete([
      agentCosts.providerBilledUsd,
      workers.memoryAnswer.costs.providerBilledUsd
    ]),
    apiEquivalentUsd: sumComplete([
      agentCosts.apiEquivalentUsd,
      workers.memoryAnswer.costs.apiEquivalentUsd
    ]),
    subscriptionUsd: sumComplete([
      agentCosts.subscriptionUsd,
      workers.memoryAnswer.costs.subscriptionUsd
    ])
  };
  const preparationCostUsd = sumComplete([
    workers.lcmSummary.costs.apiEquivalentUsd,
    workers.sessionTitle.costs.apiEquivalentUsd
  ]);
  const outcome: ReplayOutcome = {
    ...identity,
    reward,
    passed,
    latencyMs: finite(harborMetrics.agentMs, "Harbor metrics.agentMs"),
    tokens: sumTokens(agentTokens, workers.memoryAnswer.tokens),
    costUsd: replayCosts.apiEquivalentUsd,
    durations: {
      setupMs: finite(harborMetrics.setupMs, "Harbor metrics.setupMs"),
      agentMs: finite(harborMetrics.agentMs, "Harbor metrics.agentMs"),
      verifierMs: finite(harborMetrics.verifierMs, "Harbor metrics.verifierMs")
    },
    tokenUsage: agentTokens,
    costs: replayCosts,
    interactions,
    workers,
    recall,
    embedding,
    pipeline,
    rss,
    failureCategory,
    failureKind,
    failurePhase,
    telemetryStatus: {
      harbor: harbor.status,
      codex: codex.status,
      koedRecall: recallSource.status,
      modelWorkflows: workflows.status,
      embeddings: embeddingSource.status,
      processRss: rssSource.status
    }
  };
  return {
    outcome,
    preparation: {
      costUsd: preparationCostUsd,
      workers: {
        lcmSummary: workers.lcmSummary,
        sessionTitle: workers.sessionTitle
      },
      embedding,
      pipeline
    }
  };
};
