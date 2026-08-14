import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkComponents,
  isPathInside,
  readTextFileNoFollow
} from "./artifacts.js";
import { canonicalJson, sha256 } from "./core/hash.js";

export interface OracleQualificationTask {
  taskDigest: string;
  oracleBrief: string;
  maximumAttempts: number;
}

export interface OracleQualificationManifest {
  schemaVersion: "koed-oracle-qualification-manifest-v1";
  tasks: readonly OracleQualificationTask[];
  manifestSha256: string;
}

interface SerializedManifest {
  schema_version: "koed-oracle-qualification-manifest-v1";
  tasks: {
    task_digest: string;
    oracle_brief: string;
    maximum_attempts: number;
  }[];
}

export const parseOracleQualificationManifest = (
  value: unknown
): Readonly<OracleQualificationManifest> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Oracle qualification manifest must be an object");
  const raw = value as Partial<SerializedManifest>;
  if (raw.schema_version !== "koed-oracle-qualification-manifest-v1")
    throw new Error("Oracle qualification manifest schema is invalid");
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0)
    throw new Error("Oracle qualification manifest requires tasks");
  const tasks = raw.tasks.map((task) => {
    if (!task || typeof task !== "object")
      throw new Error("Oracle qualification task is invalid");
    if (!/^sha256:[a-f0-9]{64}$/u.test(task.task_digest))
      throw new Error("Oracle qualification task digest is invalid");
    if (
      typeof task.oracle_brief !== "string" ||
      !task.oracle_brief.trim() ||
      Buffer.byteLength(task.oracle_brief, "utf8") > 1024 * 1024
    ) {
      throw new Error("Oracle qualification brief is invalid");
    }
    if (
      !Number.isSafeInteger(task.maximum_attempts) ||
      task.maximum_attempts < 1 ||
      task.maximum_attempts > 10
    ) {
      throw new Error("Oracle qualification maximum attempts must be 1 to 10");
    }
    return {
      taskDigest: task.task_digest,
      oracleBrief: task.oracle_brief,
      maximumAttempts: task.maximum_attempts
    };
  });
  if (new Set(tasks.map((task) => task.taskDigest)).size !== tasks.length)
    throw new Error("Oracle qualification tasks must be unique");
  const serialized: SerializedManifest = {
    schema_version: raw.schema_version,
    tasks: tasks.map((task) => ({
      task_digest: task.taskDigest,
      oracle_brief: task.oracleBrief,
      maximum_attempts: task.maximumAttempts
    }))
  };
  return Object.freeze({
    schemaVersion: raw.schema_version,
    tasks: Object.freeze(tasks),
    manifestSha256: sha256(canonicalJson(serialized))
  });
};

export const inspectOracleQualificationManifest = async (input: {
  manifestPath: string;
  repositoryRoot: string;
}): Promise<Readonly<OracleQualificationManifest>> => {
  if (!path.isAbsolute(input.manifestPath))
    throw new Error("Oracle qualification manifest path must be absolute");
  const requested = path.normalize(input.manifestPath);
  if (requested !== input.manifestPath)
    throw new Error("Oracle qualification manifest path must be normalized");
  const repository = await realpath(input.repositoryRoot);
  await assertNoSymlinkComponents(requested);
  const resolved = await realpath(requested);
  if (
    resolved !== requested ||
    resolved === repository ||
    isPathInside(resolved, repository)
  )
    throw new Error(
      "Oracle qualification manifest must be outside the repository"
    );
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
    throw new Error("Oracle qualification manifest must be a 0600 file");
  return parseOracleQualificationManifest(
    JSON.parse(
      await readTextFileNoFollow(resolved, 128 * 1024 * 1024)
    ) as unknown
  );
};
