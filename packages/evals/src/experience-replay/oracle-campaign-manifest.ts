import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkComponents,
  isPathInside,
  readTextFileNoFollow
} from "./artifacts.js";
import { canonicalJson, sha256 } from "./core/hash.js";

export interface OracleCampaignDefinition {
  schemaVersion: "koed-oracle-campaign-definition-v1";
  campaignId: string;
  taskUniverseDigests: readonly string[];
  shardId: string;
  shardTaskDigests: readonly string[];
  referenceScore: number;
  manifestSha256: string;
}

interface SerializedOracleCampaignDefinition {
  schema_version: "koed-oracle-campaign-definition-v1";
  campaign_id: string;
  task_universe_digests: string[];
  shard_id: string;
  shard_task_digests: string[];
  reference_score: number;
}

const assertIdentity = (value: string, label: string): void => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value))
    throw new Error(`${label} is invalid`);
};

const normalizedDigests = (
  values: readonly string[],
  label: string
): readonly string[] => {
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  if (values.some((value) => !/^sha256:[a-f0-9]{64}$/u.test(value)))
    throw new Error(`${label} contains an invalid task digest`);
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must be unique`);
  return [...values].sort();
};

export const parseOracleCampaignDefinition = (
  value: unknown
): Readonly<OracleCampaignDefinition> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Oracle campaign definition must be an object");
  const raw = value as Partial<SerializedOracleCampaignDefinition>;
  if (raw.schema_version !== "koed-oracle-campaign-definition-v1")
    throw new Error("Oracle campaign definition schema is invalid");
  if (typeof raw.campaign_id !== "string")
    throw new Error("Oracle campaign identity is required");
  if (typeof raw.shard_id !== "string")
    throw new Error("Oracle campaign shard identity is required");
  assertIdentity(raw.campaign_id, "Oracle campaign identity");
  assertIdentity(raw.shard_id, "Oracle campaign shard identity");
  if (!Array.isArray(raw.task_universe_digests))
    throw new Error("Oracle campaign task universe is required");
  if (!Array.isArray(raw.shard_task_digests))
    throw new Error("Oracle campaign shard tasks are required");
  const taskUniverseDigests = normalizedDigests(
    raw.task_universe_digests,
    "Oracle campaign task universe"
  );
  const shardTaskDigests = normalizedDigests(
    raw.shard_task_digests,
    "Oracle campaign shard"
  );
  const universe = new Set(taskUniverseDigests);
  if (shardTaskDigests.some((digest) => !universe.has(digest)))
    throw new Error(
      "Oracle campaign shard contains a task outside the universe"
    );
  if (
    typeof raw.reference_score !== "number" ||
    !Number.isFinite(raw.reference_score) ||
    raw.reference_score < 0 ||
    raw.reference_score > 1
  ) {
    throw new Error(
      "Oracle campaign reference score must be between zero and one"
    );
  }
  const serialized: SerializedOracleCampaignDefinition = {
    schema_version: raw.schema_version,
    campaign_id: raw.campaign_id,
    task_universe_digests: [...taskUniverseDigests],
    shard_id: raw.shard_id,
    shard_task_digests: [...shardTaskDigests],
    reference_score: raw.reference_score
  };
  return Object.freeze({
    schemaVersion: raw.schema_version,
    campaignId: raw.campaign_id,
    taskUniverseDigests,
    shardId: raw.shard_id,
    shardTaskDigests,
    referenceScore: raw.reference_score,
    manifestSha256: sha256(canonicalJson(serialized))
  });
};

export const inspectOracleCampaignDefinition = async (input: {
  manifestPath: string;
  repositoryRoot: string;
}): Promise<Readonly<OracleCampaignDefinition>> => {
  if (!path.isAbsolute(input.manifestPath))
    throw new Error("Oracle campaign definition path must be absolute");
  const requested = path.normalize(input.manifestPath);
  if (requested !== input.manifestPath)
    throw new Error("Oracle campaign definition path must be normalized");
  const repository = await realpath(input.repositoryRoot);
  await assertNoSymlinkComponents(requested);
  const resolved = await realpath(requested);
  if (
    resolved !== requested ||
    resolved === repository ||
    isPathInside(resolved, repository)
  )
    throw new Error(
      "Oracle campaign definition must be outside the repository"
    );
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
    throw new Error("Oracle campaign definition must be a 0600 file");
  return parseOracleCampaignDefinition(
    JSON.parse(await readTextFileNoFollow(resolved, 4 * 1024 * 1024)) as unknown
  );
};
