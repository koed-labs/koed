import type { ResolvedExperienceReplayConfig } from "./config.js";
import { deepFreeze, immutableHash } from "./hash.js";

export type ExperienceReplayExecutionKind =
  | "benchmark_profile"
  | "product_path_proof";

export const SMOKE_TASK_DIGESTS = [
  `sha256:${"a".repeat(64)}`,
  `sha256:${"b".repeat(64)}`
] as const;

export interface ExperienceReplayRunPlan {
  version: 1;
  kind: ExperienceReplayExecutionKind;
  profile: ResolvedExperienceReplayConfig["profile"];
  sourceTaskDigests: readonly string[];
  replayTargetTaskDigests: readonly string[];
  replayAttemptsPerCondition: number;
  codingAgentAttemptCount: number;
  terminalBenchEstimate: boolean;
  planHash: string;
}

const buildPlan = (
  body: Omit<ExperienceReplayRunPlan, "planHash">
): Readonly<ExperienceReplayRunPlan> =>
  deepFreeze({ ...body, planHash: immutableHash(body) });

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique`);
  }
};

const assertLunaLow = (config: ResolvedExperienceReplayConfig): void => {
  const models = [
    config.coding_agent,
    config.memory_answer.model,
    config.lcm_summary.model,
    config.session_title.model
  ];
  if (
    models.some(
      (model) => model.id !== "gpt-5.6-luna" || model.reasoning_effort !== "low"
    )
  ) {
    throw new Error(
      "Product-path proof requires GPT-5.6 Luna with low reasoning for every AI Client workflow"
    );
  }
};

export const createBenchmarkRunPlan = (
  config: ResolvedExperienceReplayConfig,
  taskDigests: readonly string[]
): Readonly<ExperienceReplayRunPlan> => {
  assertUnique(taskDigests, "Benchmark task digests");
  if (taskDigests.length !== config.task_count) {
    throw new Error(`Profile ${config.profile} selected the wrong task count`);
  }
  return buildPlan({
    version: 1,
    kind: "benchmark_profile",
    profile: config.profile,
    sourceTaskDigests: [...taskDigests],
    replayTargetTaskDigests: [...taskDigests],
    replayAttemptsPerCondition: config.replay_attempts_per_condition,
    codingAgentAttemptCount: config.coding_agent_attempt_count,
    terminalBenchEstimate: config.profile !== "smoke"
  });
};

export const createProductPathProofRunPlan = (
  config: ResolvedExperienceReplayConfig,
  roles: { targetTaskDigest: string; donorTaskDigest: string }
): Readonly<ExperienceReplayRunPlan> => {
  if (config.profile !== "quick") {
    throw new Error("Product-path proof requires the quick model policy");
  }
  if (config.concurrency !== 1) {
    throw new Error("Product-path proof requires concurrency 1");
  }
  assertLunaLow(config);
  const sourceTaskDigests = [roles.targetTaskDigest, roles.donorTaskDigest];
  assertUnique(sourceTaskDigests, "Product-path proof source task digests");
  if (sourceTaskDigests.some((digest) => !digest)) {
    throw new Error("Product-path proof task digests must not be empty");
  }
  return buildPlan({
    version: 1,
    kind: "product_path_proof",
    profile: config.profile,
    sourceTaskDigests,
    replayTargetTaskDigests: [roles.targetTaskDigest],
    replayAttemptsPerCondition: 1,
    codingAgentAttemptCount: 6,
    terminalBenchEstimate: false
  });
};

export const verifyExperienceReplayRunPlan = (
  plan: ExperienceReplayRunPlan
): void => {
  const { planHash, ...body } = plan;
  if (immutableHash(body) !== planHash) {
    throw new Error("Immutable Experience Replay run-plan hash mismatch");
  }
  assertUnique(plan.sourceTaskDigests, "Run-plan source task digests");
  assertUnique(plan.replayTargetTaskDigests, "Run-plan replay task digests");
  const sources = new Set(plan.sourceTaskDigests);
  if (plan.replayTargetTaskDigests.some((digest) => !sources.has(digest))) {
    throw new Error("Run-plan replay target is not a source task");
  }
  const expectedAttempts =
    plan.sourceTaskDigests.length +
    plan.replayTargetTaskDigests.length * 4 * plan.replayAttemptsPerCondition;
  if (plan.codingAgentAttemptCount !== expectedAttempts) {
    throw new Error("Run-plan coding-attempt count is inconsistent");
  }
  if (
    plan.kind === "product_path_proof" &&
    (plan.sourceTaskDigests.length !== 2 ||
      plan.replayTargetTaskDigests.length !== 1 ||
      plan.replayAttemptsPerCondition !== 1 ||
      plan.terminalBenchEstimate)
  ) {
    throw new Error("Product-path proof run plan is invalid");
  }
};
