import type { ResolvedExperienceReplayConfig } from "./config.js";
import { deepFreeze, immutableHash } from "./hash.js";

export type ExperienceReplayExecutionKind =
  | "benchmark_profile"
  | "product_path_proof"
  | "oracle_seeded_product_proof"
  | "oracle_seeded_repeated_study"
  | "oracle_corpus_qualification"
  | "oracle_seeded_campaign";

export type ExperienceReplayCodexAuthMode = "api_key" | "subscription";

export const SMOKE_TASK_DIGESTS = [
  `sha256:${"a".repeat(64)}`,
  `sha256:${"b".repeat(64)}`
] as const;

export interface ExperienceReplayRunPlan {
  version: 1;
  kind: ExperienceReplayExecutionKind;
  codexAuthMode: ExperienceReplayCodexAuthMode;
  profile: ResolvedExperienceReplayConfig["profile"];
  sourceTaskDigests: readonly string[];
  replayTargetTaskDigests: readonly string[];
  replayAttemptsPerCondition: number;
  codingAgentAttemptCount: number;
  terminalBenchEstimate: boolean;
  oracleBriefSha256?: string;
  oracleCorpusManifestSha256?: string;
  oracleCorpusCollectionManifestSha256?: string;
  oracleCampaignDefinitionSha256?: string;
  campaignProtocolHash?: string;
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
  if (
    config.trajectory_judge.model.id !== "gpt-5.6-luna" ||
    config.trajectory_judge.model.reasoning_effort !== "medium"
  ) {
    throw new Error(
      "Product-path proof requires GPT-5.6 Luna with medium reasoning for trajectory judging"
    );
  }
};

const assertLunaHigh = (config: ResolvedExperienceReplayConfig): void => {
  const models = [
    config.coding_agent,
    config.memory_answer.model,
    config.lcm_summary.model,
    config.session_title.model
  ];
  if (
    models.some(
      (model) =>
        model.id !== "gpt-5.6-luna" || model.reasoning_effort !== "high"
    )
  ) {
    throw new Error(
      "Full-profile oracle execution requires GPT-5.6 Luna with high reasoning for every AI Client workflow"
    );
  }
  if (
    config.trajectory_judge.model.id !== "gpt-5.6-luna" ||
    config.trajectory_judge.model.reasoning_effort !== "medium"
  ) {
    throw new Error(
      "Full-profile oracle execution requires GPT-5.6 Luna with medium reasoning for trajectory judging"
    );
  }
};

const assertQualificationModels = (
  config: ResolvedExperienceReplayConfig
): void => {
  const codingAgentIsAllowed =
    (config.coding_agent.id === "gpt-5.6-luna" &&
      config.coding_agent.reasoning_effort === "high") ||
    (config.coding_agent.id === "gpt-5.6-sol" &&
      config.coding_agent.reasoning_effort === "xhigh");
  if (!codingAgentIsAllowed) {
    throw new Error(
      "Oracle corpus qualification requires GPT-5.6 Luna with high reasoning or GPT-5.6 Sol with xhigh reasoning for the coding agent"
    );
  }
  const workers = [
    config.memory_answer.model,
    config.lcm_summary.model,
    config.session_title.model
  ];
  if (
    workers.some(
      (model) =>
        model.id !== "gpt-5.6-luna" || model.reasoning_effort !== "high"
    )
  ) {
    throw new Error(
      "Oracle corpus qualification requires GPT-5.6 Luna with high reasoning for AI Client workers"
    );
  }
  if (
    config.trajectory_judge.model.id !== "gpt-5.6-luna" ||
    config.trajectory_judge.model.reasoning_effort !== "medium"
  ) {
    throw new Error(
      "Oracle corpus qualification requires GPT-5.6 Luna with medium reasoning for trajectory judging"
    );
  }
};

export const createOracleSeededCampaignRunPlan = (
  config: ResolvedExperienceReplayConfig,
  taskDigests: readonly string[],
  oracleCorpusCollectionManifestSha256: string,
  oracleCampaignDefinitionSha256: string,
  campaignProtocolHash: string,
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key"
): Readonly<ExperienceReplayRunPlan> => {
  if (config.profile !== "full")
    throw new Error("Oracle campaign requires the full profile");
  assertLunaHigh(config);
  assertUnique(taskDigests, "Oracle campaign task digests");
  if (taskDigests.length < 1)
    throw new Error("Oracle campaign requires at least one task");
  if (!/^[a-f0-9]{64}$/u.test(oracleCorpusCollectionManifestSha256))
    throw new Error("Oracle campaign corpus collection digest is invalid");
  if (!/^[a-f0-9]{64}$/u.test(oracleCampaignDefinitionSha256))
    throw new Error("Oracle campaign definition digest is invalid");
  if (!/^[a-f0-9]{64}$/u.test(campaignProtocolHash))
    throw new Error("Oracle campaign protocol digest is invalid");
  return buildPlan({
    version: 1,
    kind: "oracle_seeded_campaign",
    codexAuthMode,
    profile: config.profile,
    sourceTaskDigests: [...taskDigests],
    replayTargetTaskDigests: [...taskDigests],
    replayAttemptsPerCondition: 1,
    codingAgentAttemptCount: taskDigests.length,
    terminalBenchEstimate: false,
    oracleCorpusCollectionManifestSha256,
    oracleCampaignDefinitionSha256,
    campaignProtocolHash
  });
};

export const createOracleCorpusQualificationRunPlan = (
  config: ResolvedExperienceReplayConfig,
  taskDigests: readonly string[],
  qualificationManifestSha256: string,
  maximumAttempts: number,
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key"
): Readonly<ExperienceReplayRunPlan> => {
  if (config.profile !== "full")
    throw new Error("Oracle corpus qualification requires the full profile");
  assertQualificationModels(config);
  assertUnique(taskDigests, "Oracle corpus qualification task digests");
  if (taskDigests.length < 1)
    throw new Error("Oracle corpus qualification requires at least one task");
  if (!/^[a-f0-9]{64}$/u.test(qualificationManifestSha256))
    throw new Error("Oracle corpus qualification manifest digest is invalid");
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)
    throw new Error("Oracle corpus qualification attempt count is invalid");
  return buildPlan({
    version: 1,
    kind: "oracle_corpus_qualification",
    codexAuthMode,
    profile: config.profile,
    sourceTaskDigests: [...taskDigests],
    replayTargetTaskDigests: [],
    replayAttemptsPerCondition: 0,
    codingAgentAttemptCount: maximumAttempts,
    terminalBenchEstimate: false,
    oracleCorpusManifestSha256: qualificationManifestSha256
  });
};

export const createBenchmarkRunPlan = (
  config: ResolvedExperienceReplayConfig,
  taskDigests: readonly string[],
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key"
): Readonly<ExperienceReplayRunPlan> => {
  assertUnique(taskDigests, "Benchmark task digests");
  if (taskDigests.length !== config.task_count) {
    throw new Error(`Profile ${config.profile} selected the wrong task count`);
  }
  return buildPlan({
    version: 1,
    kind: "benchmark_profile",
    codexAuthMode,
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
  roles: { targetTaskDigest: string; donorTaskDigest: string },
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key"
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
    codexAuthMode,
    profile: config.profile,
    sourceTaskDigests,
    replayTargetTaskDigests: [roles.targetTaskDigest],
    replayAttemptsPerCondition: 1,
    codingAgentAttemptCount: 6,
    terminalBenchEstimate: false
  });
};

export const createOracleSeededProductProofRunPlan = (
  config: ResolvedExperienceReplayConfig,
  taskDigest: string,
  oracleBriefSha256: string,
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key"
): Readonly<ExperienceReplayRunPlan> => {
  if (config.profile !== "quick") {
    throw new Error(
      "Oracle-seeded product proof requires the quick model policy"
    );
  }
  if (config.concurrency !== 1) {
    throw new Error("Oracle-seeded product proof requires concurrency 1");
  }
  assertLunaLow(config);
  if (!taskDigest) {
    throw new Error(
      "Oracle-seeded product proof task digest must not be empty"
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(oracleBriefSha256)) {
    throw new Error("Oracle-seeded product proof brief digest is invalid");
  }
  return buildPlan({
    version: 1,
    kind: "oracle_seeded_product_proof",
    codexAuthMode,
    profile: config.profile,
    sourceTaskDigests: [taskDigest],
    replayTargetTaskDigests: [taskDigest],
    replayAttemptsPerCondition: 1,
    codingAgentAttemptCount: 7,
    terminalBenchEstimate: false,
    oracleBriefSha256
  });
};

export const createOracleSeededRepeatedStudyRunPlan = (
  config: ResolvedExperienceReplayConfig,
  taskDigest: string,
  oracleCorpusManifestSha256: string,
  repeats = 10,
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key"
): Readonly<ExperienceReplayRunPlan> => {
  if (config.profile !== "quick" && config.profile !== "full") {
    throw new Error(
      "Oracle repeated study requires the quick policy or an explicit full-profile model policy"
    );
  }
  if (config.concurrency !== 1) {
    throw new Error("Oracle repeated study requires concurrency 1");
  }
  if (config.profile === "quick") assertLunaLow(config);
  else assertLunaHigh(config);
  if (!taskDigest) {
    throw new Error("Oracle repeated study task digest must not be empty");
  }
  if (!/^[a-f0-9]{64}$/u.test(oracleCorpusManifestSha256)) {
    throw new Error("Oracle repeated study corpus digest is invalid");
  }
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) {
    throw new Error("Oracle repeated study requires 1 to 100 repeats");
  }
  return buildPlan({
    version: 1,
    kind: "oracle_seeded_repeated_study",
    codexAuthMode,
    profile: config.profile,
    sourceTaskDigests: [taskDigest],
    replayTargetTaskDigests: [taskDigest],
    replayAttemptsPerCondition: repeats,
    codingAgentAttemptCount: repeats * 4,
    terminalBenchEstimate: false,
    oracleCorpusManifestSha256
  });
};

export const verifyExperienceReplayRunPlan = (
  plan: ExperienceReplayRunPlan
): void => {
  const { planHash, ...body } = plan;
  if (immutableHash(body) !== planHash) {
    throw new Error("Immutable Experience Replay run-plan hash mismatch");
  }
  if (plan.codexAuthMode !== "api_key" && plan.codexAuthMode !== "subscription")
    throw new Error("Run-plan Codex authentication mode is invalid");
  if (
    plan.kind !== "benchmark_profile" &&
    plan.kind !== "product_path_proof" &&
    plan.kind !== "oracle_seeded_product_proof" &&
    plan.kind !== "oracle_seeded_repeated_study" &&
    plan.kind !== "oracle_corpus_qualification" &&
    plan.kind !== "oracle_seeded_campaign"
  ) {
    throw new Error("Run-plan execution kind is invalid");
  }
  assertUnique(plan.sourceTaskDigests, "Run-plan source task digests");
  assertUnique(plan.replayTargetTaskDigests, "Run-plan replay task digests");
  const sources = new Set(plan.sourceTaskDigests);
  if (plan.replayTargetTaskDigests.some((digest) => !sources.has(digest))) {
    throw new Error("Run-plan replay target is not a source task");
  }
  const expectedAttempts =
    (plan.kind === "oracle_seeded_repeated_study" ||
    plan.kind === "oracle_seeded_campaign"
      ? 0
      : plan.sourceTaskDigests.length) +
    plan.replayTargetTaskDigests.length *
      (plan.kind === "oracle_seeded_product_proof"
        ? 6
        : plan.kind === "oracle_seeded_repeated_study"
          ? 4
          : plan.kind === "oracle_seeded_campaign"
            ? 1
            : 4) *
      plan.replayAttemptsPerCondition;
  if (
    plan.kind !== "oracle_corpus_qualification" &&
    plan.codingAgentAttemptCount !== expectedAttempts
  ) {
    throw new Error("Run-plan coding-attempt count is inconsistent");
  }
  if (
    plan.kind === "oracle_corpus_qualification" &&
    (plan.sourceTaskDigests.length < 1 ||
      plan.replayTargetTaskDigests.length !== 0 ||
      plan.replayAttemptsPerCondition !== 0 ||
      plan.codingAgentAttemptCount < plan.sourceTaskDigests.length ||
      plan.terminalBenchEstimate ||
      !plan.oracleCorpusManifestSha256 ||
      !/^[a-f0-9]{64}$/u.test(plan.oracleCorpusManifestSha256))
  ) {
    throw new Error("Oracle corpus qualification run plan is invalid");
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
  if (
    plan.kind === "oracle_seeded_product_proof" &&
    (plan.sourceTaskDigests.length !== 1 ||
      plan.replayTargetTaskDigests.length !== 1 ||
      plan.sourceTaskDigests[0] !== plan.replayTargetTaskDigests[0] ||
      plan.replayAttemptsPerCondition !== 1 ||
      plan.terminalBenchEstimate ||
      !plan.oracleBriefSha256 ||
      !/^[a-f0-9]{64}$/u.test(plan.oracleBriefSha256))
  ) {
    throw new Error("Oracle-seeded product proof run plan is invalid");
  }
  if (
    plan.kind === "oracle_seeded_repeated_study" &&
    (plan.sourceTaskDigests.length !== 1 ||
      plan.replayTargetTaskDigests.length !== 1 ||
      plan.sourceTaskDigests[0] !== plan.replayTargetTaskDigests[0] ||
      !Number.isSafeInteger(plan.replayAttemptsPerCondition) ||
      plan.replayAttemptsPerCondition < 1 ||
      plan.replayAttemptsPerCondition > 100 ||
      plan.terminalBenchEstimate ||
      !plan.oracleCorpusManifestSha256 ||
      !/^[a-f0-9]{64}$/u.test(plan.oracleCorpusManifestSha256) ||
      plan.oracleBriefSha256 !== undefined)
  ) {
    throw new Error("Oracle repeated study run plan is invalid");
  }
  if (
    plan.kind === "oracle_seeded_campaign" &&
    (plan.sourceTaskDigests.length < 1 ||
      plan.replayTargetTaskDigests.length !== plan.sourceTaskDigests.length ||
      plan.replayAttemptsPerCondition !== 1 ||
      plan.terminalBenchEstimate ||
      !plan.oracleCorpusCollectionManifestSha256 ||
      !/^[a-f0-9]{64}$/u.test(plan.oracleCorpusCollectionManifestSha256) ||
      !plan.oracleCampaignDefinitionSha256 ||
      !/^[a-f0-9]{64}$/u.test(plan.oracleCampaignDefinitionSha256) ||
      !plan.campaignProtocolHash ||
      !/^[a-f0-9]{64}$/u.test(plan.campaignProtocolHash) ||
      plan.oracleBriefSha256 !== undefined ||
      plan.oracleCorpusManifestSha256 !== undefined)
  ) {
    throw new Error("Oracle campaign run plan is invalid");
  }
};
