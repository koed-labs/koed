import { deepFreeze, immutableHash } from "./hash.js";

export const ORACLE_CAMPAIGN_KIND =
  "koed_oracle_seeded_experience_campaign" as const;
export const ORACLE_CAMPAIGN_CONDITION = "relevant_full" as const;
export const ORACLE_CAMPAIGN_CORPUS_POLICY_VERSION =
  "oracle-qualified-private-corpus-v1" as const;
export const ORACLE_CAMPAIGN_REFERENCE_SCORE = 0.208;

export interface OracleCampaignProtocol {
  version: 1;
  kind: typeof ORACLE_CAMPAIGN_KIND;
  campaignId: string;
  campaignSeed: string;
  condition: typeof ORACLE_CAMPAIGN_CONDITION;
  attemptsPerTask: 1;
  taskUniverseDigests: readonly string[];
  semanticConfigHash: string;
  memoryAnswerPromptVersion: string;
  mcpRecallPolicyVersion: string;
  corpusPolicyVersion: typeof ORACLE_CAMPAIGN_CORPUS_POLICY_VERSION;
  concurrency: number;
  referenceScore: number;
  pins: {
    harborCommit: string;
    terminalBenchCommit: string;
    corpusHash: string;
    uvLockHash: string;
  };
  protocolHash: string;
}

export interface OracleCampaignShardManifest {
  version: 1;
  campaignProtocolHash: string;
  shardId: string;
  createdAt: string;
  selectedTaskDigests: readonly string[];
  units: readonly {
    taskDigest: string;
    condition: typeof ORACLE_CAMPAIGN_CONDITION;
    repeat: 0;
  }[];
  shardHash: string;
}

export type OracleCampaignTaskStatus =
  | "pending"
  | "corpus_unqualified"
  | "passed"
  | "failed"
  | "infrastructure_failed";

export interface OracleCampaignTaskResult {
  taskDigest: string;
  status: OracleCampaignTaskStatus;
  corpusAttestationSha256: string | null;
  reward: number | null;
  passed: boolean | null;
  elapsedMs: number | null;
  tokens: number | null;
  apiEquivalentCostUsd: number | null;
  completedAt: string | null;
}

export interface WilsonInterval {
  lower: number;
  upper: number;
}

export interface OracleCampaignProgress {
  version: 1;
  campaignProtocolHash: string;
  shardHashes: readonly string[];
  generatedAt: string;
  selectedTasks: number;
  pendingTasks: number;
  qualifiedTasks: number;
  unqualifiedTasks: number;
  completedEvaluations: number;
  passedTasks: number;
  failedTasks: number;
  infrastructureFailures: number;
  score: number | null;
  scoreWilson95: WilsonInterval | null;
  referenceScore: number;
  percentagePointDeltaFromReference: number | null;
  elapsedMs: number;
  tokens: number;
  apiEquivalentCostUsd: number;
  results: readonly OracleCampaignTaskResult[];
}

const assertHash = (value: string, label: string): void => {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
};

const assertUniqueSorted = (values: readonly string[], label: string): void => {
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must be unique`);
  if (values.some((value, index) => index > 0 && values[index - 1]! > value))
    throw new Error(`${label} must be sorted`);
};

export const createOracleCampaignProtocol = (input: {
  campaignId: string;
  campaignSeed: string;
  taskUniverseDigests: readonly string[];
  semanticConfigHash: string;
  memoryAnswerPromptVersion: string;
  mcpRecallPolicyVersion: string;
  concurrency: number;
  pins: OracleCampaignProtocol["pins"];
  referenceScore?: number;
}): Readonly<OracleCampaignProtocol> => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(input.campaignId))
    throw new Error("Campaign identity is invalid");
  if (!input.campaignSeed.trim()) throw new Error("Campaign seed is required");
  if (!input.memoryAnswerPromptVersion.trim())
    throw new Error("Memory Answer prompt version is required");
  if (!input.mcpRecallPolicyVersion.trim())
    throw new Error("MCP Recall policy version is required");
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1)
    throw new Error("Campaign concurrency must be a positive integer");
  assertHash(input.semanticConfigHash, "Semantic configuration hash");
  const taskUniverseDigests = [...input.taskUniverseDigests].sort();
  assertUniqueSorted(taskUniverseDigests, "Campaign task universe");
  const referenceScore =
    input.referenceScore ?? ORACLE_CAMPAIGN_REFERENCE_SCORE;
  if (
    !Number.isFinite(referenceScore) ||
    referenceScore < 0 ||
    referenceScore > 1
  )
    throw new Error("Campaign reference score must be between zero and one");
  const body = {
    version: 1 as const,
    kind: ORACLE_CAMPAIGN_KIND,
    campaignId: input.campaignId,
    campaignSeed: input.campaignSeed,
    condition: ORACLE_CAMPAIGN_CONDITION,
    attemptsPerTask: 1 as const,
    taskUniverseDigests,
    semanticConfigHash: input.semanticConfigHash,
    memoryAnswerPromptVersion: input.memoryAnswerPromptVersion,
    mcpRecallPolicyVersion: input.mcpRecallPolicyVersion,
    corpusPolicyVersion: ORACLE_CAMPAIGN_CORPUS_POLICY_VERSION,
    concurrency: input.concurrency,
    referenceScore,
    pins: { ...input.pins }
  };
  return deepFreeze({ ...body, protocolHash: immutableHash(body) });
};

export const verifyOracleCampaignProtocol = (
  protocol: OracleCampaignProtocol
): void => {
  const { protocolHash, ...body } = protocol;
  assertHash(protocolHash, "Campaign protocol hash");
  if (immutableHash(body) !== protocolHash)
    throw new Error("Campaign protocol hash mismatch");
  if (
    protocol.kind !== ORACLE_CAMPAIGN_KIND ||
    protocol.condition !== ORACLE_CAMPAIGN_CONDITION ||
    protocol.attemptsPerTask !== 1 ||
    protocol.corpusPolicyVersion !== ORACLE_CAMPAIGN_CORPUS_POLICY_VERSION
  ) {
    throw new Error("Campaign protocol policy is invalid");
  }
  assertUniqueSorted(protocol.taskUniverseDigests, "Campaign task universe");
};

export const createOracleCampaignShard = (
  protocol: OracleCampaignProtocol,
  input: {
    shardId: string;
    selectedTaskDigests: readonly string[];
    createdAt: string;
  }
): Readonly<OracleCampaignShardManifest> => {
  verifyOracleCampaignProtocol(protocol);
  if (!input.shardId.trim()) throw new Error("Shard identity is required");
  if (!Number.isFinite(Date.parse(input.createdAt)))
    throw new Error("Shard creation time is invalid");
  const selectedTaskDigests = [...input.selectedTaskDigests].sort();
  assertUniqueSorted(selectedTaskDigests, "Shard task selection");
  const universe = new Set(protocol.taskUniverseDigests);
  if (selectedTaskDigests.some((digest) => !universe.has(digest)))
    throw new Error("Shard task is outside the campaign universe");
  const units = selectedTaskDigests.map((taskDigest) => ({
    taskDigest,
    condition: ORACLE_CAMPAIGN_CONDITION,
    repeat: 0 as const
  }));
  const body = {
    version: 1 as const,
    campaignProtocolHash: protocol.protocolHash,
    shardId: input.shardId,
    createdAt: input.createdAt,
    selectedTaskDigests,
    units
  };
  return deepFreeze({ ...body, shardHash: immutableHash(body) });
};

export const verifyOracleCampaignShard = (
  protocol: OracleCampaignProtocol,
  shard: OracleCampaignShardManifest
): void => {
  verifyOracleCampaignProtocol(protocol);
  const { shardHash, ...body } = shard;
  if (immutableHash(body) !== shardHash)
    throw new Error("Campaign shard hash mismatch");
  if (shard.campaignProtocolHash !== protocol.protocolHash)
    throw new Error("Campaign shard uses a different protocol");
  const regenerated = createOracleCampaignShard(protocol, {
    shardId: shard.shardId,
    selectedTaskDigests: shard.selectedTaskDigests,
    createdAt: shard.createdAt
  });
  if (regenerated.shardHash !== shard.shardHash)
    throw new Error("Campaign shard units are invalid");
};

export const wilsonInterval95 = (
  successes: number,
  attempts: number
): WilsonInterval | null => {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(attempts))
    throw new Error("Wilson inputs must be integers");
  if (attempts < 0 || successes < 0 || successes > attempts)
    throw new Error("Wilson inputs are outside their valid range");
  if (attempts === 0) return null;
  const z = 1.959963984540054;
  const z2 = z * z;
  const proportion = successes / attempts;
  const denominator = 1 + z2 / attempts;
  const center = (proportion + z2 / (2 * attempts)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion) + z2 / (4 * attempts)) / attempts);
  return { lower: center - margin, upper: center + margin };
};

export const createOracleCampaignProgress = (input: {
  protocol: OracleCampaignProtocol;
  shards: readonly OracleCampaignShardManifest[];
  results: readonly OracleCampaignTaskResult[];
  generatedAt: string;
}): Readonly<OracleCampaignProgress> => {
  verifyOracleCampaignProtocol(input.protocol);
  if (!Number.isFinite(Date.parse(input.generatedAt)))
    throw new Error("Campaign progress time is invalid");
  const selected = new Set<string>();
  const shardIds = new Set<string>();
  for (const shard of input.shards) {
    verifyOracleCampaignShard(input.protocol, shard);
    if (shardIds.has(shard.shardId))
      throw new Error("Campaign shards contain a duplicate identity");
    shardIds.add(shard.shardId);
    for (const digest of shard.selectedTaskDigests) {
      if (selected.has(digest))
        throw new Error("Campaign shards contain overlapping task units");
      selected.add(digest);
    }
  }
  const results = [...input.results].sort((left, right) =>
    left.taskDigest.localeCompare(right.taskDigest)
  );
  if (
    new Set(results.map((result) => result.taskDigest)).size !== results.length
  )
    throw new Error("Campaign results contain duplicate task units");
  if (results.some((result) => !selected.has(result.taskDigest)))
    throw new Error("Campaign result is outside the selected shards");
  const byTask = new Map(results.map((result) => [result.taskDigest, result]));
  for (const taskDigest of selected) {
    if (!byTask.has(taskDigest)) {
      results.push({
        taskDigest,
        status: "pending",
        corpusAttestationSha256: null,
        reward: null,
        passed: null,
        elapsedMs: null,
        tokens: null,
        apiEquivalentCostUsd: null,
        completedAt: null
      });
    }
  }
  results.sort((left, right) =>
    left.taskDigest.localeCompare(right.taskDigest)
  );
  const completed = results.filter(
    (result) => result.status === "passed" || result.status === "failed"
  );
  const passedTasks = completed.filter(
    (result) => result.status === "passed"
  ).length;
  const score = completed.length === 0 ? null : passedTasks / completed.length;
  const sum = (field: "elapsedMs" | "tokens" | "apiEquivalentCostUsd") =>
    results.reduce((total, result) => total + (result[field] ?? 0), 0);
  const progress: OracleCampaignProgress = {
    version: 1,
    campaignProtocolHash: input.protocol.protocolHash,
    shardHashes: input.shards.map((shard) => shard.shardHash).sort(),
    generatedAt: input.generatedAt,
    selectedTasks: selected.size,
    pendingTasks: results.filter((result) => result.status === "pending")
      .length,
    qualifiedTasks: results.filter(
      (result) => result.corpusAttestationSha256 !== null
    ).length,
    unqualifiedTasks: results.filter(
      (result) => result.status === "corpus_unqualified"
    ).length,
    completedEvaluations: completed.length,
    passedTasks,
    failedTasks: completed.length - passedTasks,
    infrastructureFailures: results.filter(
      (result) => result.status === "infrastructure_failed"
    ).length,
    score,
    scoreWilson95: wilsonInterval95(passedTasks, completed.length),
    referenceScore: input.protocol.referenceScore,
    percentagePointDeltaFromReference:
      score === null ? null : (score - input.protocol.referenceScore) * 100,
    elapsedMs: sum("elapsedMs"),
    tokens: sum("tokens"),
    apiEquivalentCostUsd: sum("apiEquivalentCostUsd"),
    results
  };
  return deepFreeze(progress);
};
