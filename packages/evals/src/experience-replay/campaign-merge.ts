import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  createOracleCampaignProgress,
  immutableHash,
  verifyOracleCampaignProtocol,
  verifyOracleCampaignShard,
  type OracleCampaignProgress,
  type OracleCampaignProtocol,
  type OracleCampaignShardManifest
} from "./core/index.js";
import {
  readJsonArtifact,
  validateExistingRunDirectory,
  writeTextArtifactAtomic
} from "./artifacts.js";
import { SafeRunDirectory } from "./output-path.js";

export interface MergedOracleCampaignResult {
  outputDirectory: string;
  progress: Readonly<OracleCampaignProgress>;
}

const latestProgress = async (
  runRoot: string
): Promise<OracleCampaignProgress> => {
  const progressDirectory = path.join(runRoot, "campaign/progress");
  const metadata = await lstat(progressDirectory);
  if (!metadata.isDirectory())
    throw new Error("Campaign progress path is not a directory");
  const files = (await readdir(progressDirectory))
    .filter((file) => /^\d{4}\.json$/u.test(file))
    .sort();
  const latest = files.at(-1);
  if (!latest) throw new Error("Campaign run has no progress snapshot");
  return readJsonArtifact<OracleCampaignProgress>(
    runRoot,
    `campaign/progress/${latest}`
  );
};

const renderMergedSummary = (
  progress: OracleCampaignProgress,
  blocks: readonly { runId: string; shardId: string; createdAt: string }[]
): string => {
  const percent = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  return `${[
    "# Koed Oracle-Seeded Experience Campaign",
    "",
    "This is a treatment-only experience-reuse challenge, not an official Terminal-Bench leaderboard submission or a causal no-Memory comparison.",
    "",
    `- Selected tasks: ${progress.selectedTasks}`,
    `- Completed evaluations: ${progress.completedEvaluations}`,
    `- Passed: ${progress.passedTasks}`,
    `- Score: ${percent(progress.score)}`,
    `- Wilson 95% interval: ${progress.scoreWilson95 ? `${percent(progress.scoreWilson95.lower)} to ${percent(progress.scoreWilson95.upper)}` : "n/a"}`,
    `- Reference: ${percent(progress.referenceScore)}`,
    `- Delta: ${progress.percentagePointDeltaFromReference === null ? "n/a" : `${progress.percentagePointDeltaFromReference.toFixed(1)} percentage points`}`,
    `- Corpus qualified/unqualified/pending: ${progress.qualifiedTasks}/${progress.unqualifiedTasks}/${progress.pendingTasks}`,
    `- Infrastructure failures: ${progress.infrastructureFailures}`,
    `- Tokens: ${progress.tokens}`,
    `- API-equivalent cost: $${progress.apiEquivalentCostUsd.toFixed(4)}`,
    "",
    "## Execution blocks",
    "",
    ...blocks.map(
      (block) =>
        `- ${block.runId}; shard ${block.shardId}; created ${block.createdAt}`
    )
  ].join("\n")}\n`;
};

export const mergeOracleCampaignRuns = async (input: {
  runDirectories: readonly string[];
  outputDirectory: string;
  repositoryRoot: string;
  generatedAt?: string;
}): Promise<MergedOracleCampaignResult> => {
  if (input.runDirectories.length === 0)
    throw new Error("At least one campaign run is required");
  const roots = await Promise.all(
    input.runDirectories.map((directory) =>
      validateExistingRunDirectory(directory, input.repositoryRoot)
    )
  );
  if (new Set(roots).size !== roots.length)
    throw new Error("Campaign merge inputs must be unique");

  let protocol: OracleCampaignProtocol | undefined;
  const shards: OracleCampaignShardManifest[] = [];
  const results: OracleCampaignProgress["results"][number][] = [];
  const blocks: { runId: string; shardId: string; createdAt: string }[] = [];
  for (const root of roots) {
    const candidate = await readJsonArtifact<OracleCampaignProtocol>(
      root,
      "campaign/protocol.json"
    );
    verifyOracleCampaignProtocol(candidate);
    if (protocol && candidate.protocolHash !== protocol.protocolHash)
      throw new Error("Campaign runs use incompatible protocols");
    protocol ??= candidate;
    const shard = await readJsonArtifact<OracleCampaignShardManifest>(
      root,
      "campaign/shard.json"
    );
    verifyOracleCampaignShard(protocol, shard);
    const progress = await latestProgress(root);
    const rebuilt = createOracleCampaignProgress({
      protocol,
      shards: [shard],
      results: progress.results,
      generatedAt: progress.generatedAt
    });
    if (immutableHash(rebuilt) !== immutableHash(progress))
      throw new Error("Campaign progress snapshot is inconsistent");
    const manifest = await readJsonArtifact<{ run_id: string }>(
      root,
      "manifest.json"
    );
    shards.push(shard);
    results.push(...progress.results);
    blocks.push({
      runId: manifest.run_id,
      shardId: shard.shardId,
      createdAt: shard.createdAt
    });
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const progress = createOracleCampaignProgress({
    protocol: protocol!,
    shards,
    results,
    generatedAt
  });
  const created = await SafeRunDirectory.create({
    outputPath: input.outputDirectory,
    repositoryRoot: input.repositoryRoot,
    requiredBytes: 1024 * 1024,
    reserveBytes: 0
  });
  await writeTextArtifactAtomic(
    created.directory.root,
    "protocol.json",
    `${JSON.stringify(protocol, null, 2)}\n`
  );
  await writeTextArtifactAtomic(
    created.directory.root,
    "shards.json",
    `${JSON.stringify(shards, null, 2)}\n`
  );
  await writeTextArtifactAtomic(
    created.directory.root,
    "progress.json",
    `${JSON.stringify(progress, null, 2)}\n`
  );
  await writeTextArtifactAtomic(
    created.directory.root,
    "summary.md",
    renderMergedSummary(progress, blocks)
  );
  return { outputDirectory: created.directory.root, progress };
};
