import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkComponents,
  isPathInside,
  readTextFileNoFollow
} from "./artifacts.js";
import { canonicalJson, sha256 } from "./core/hash.js";
import {
  inspectOracleCorpusArtifact,
  validateOracleCorpusArtifactEntry,
  type OracleCorpusArtifactEntry
} from "./oracle-corpus-artifact.js";

export interface OracleCorpusCollection {
  schemaVersion: "koed-oracle-corpus-collection-v1";
  classification: "private-benchmark-corpus";
  root: string;
  entries: ReadonlyMap<string, OracleCorpusArtifactEntry>;
  directories: ReadonlyMap<string, string>;
  manifest: {
    tasks: readonly {
      taskDigest: string;
      taskName: string;
      attestationSha256: string;
    }[];
    manifestSha256: string;
  };
}

export const createOracleCorpusCollectionManifest = (
  entries: Iterable<OracleCorpusArtifactEntry>
): OracleCorpusCollection["manifest"] => {
  const tasks = [...entries]
    .map((entry) => ({
      taskDigest: entry.identity.task.digest,
      taskName: entry.identity.task.name,
      attestationSha256: entry.attestationSha256
    }))
    .sort((left, right) => left.taskDigest.localeCompare(right.taskDigest));
  const manifestBody = {
    schemaVersion: "koed-oracle-corpus-collection-v1" as const,
    tasks
  };
  return {
    tasks,
    manifestSha256: sha256(canonicalJson(manifestBody))
  };
};

export const loadPersistedOracleCorpusCollection = async (
  runRoot: string
): Promise<ReadonlyMap<string, OracleCorpusArtifactEntry>> => {
  const parsed = JSON.parse(
    await readTextFileNoFollow(
      path.join(runRoot, "oracle-private/oracle-corpus-collection.json"),
      512 * 1024 * 1024
    )
  ) as {
    manifest?: OracleCorpusCollection["manifest"];
    entries?: OracleCorpusArtifactEntry[];
  };
  if (!Array.isArray(parsed.entries) || !parsed.manifest)
    throw new Error("Persisted oracle corpus collection is invalid");
  const entries = new Map<string, OracleCorpusArtifactEntry>();
  for (const raw of parsed.entries) {
    const entry = validateOracleCorpusArtifactEntry(raw);
    const digest = entry.identity.task.digest;
    if (entries.has(digest))
      throw new Error(`Duplicate persisted oracle corpus task ${digest}`);
    entries.set(digest, entry);
  }
  const manifest = createOracleCorpusCollectionManifest(entries.values());
  if (canonicalJson(manifest) !== canonicalJson(parsed.manifest)) {
    throw new Error("Persisted oracle corpus collection manifest mismatch");
  }
  return entries;
};

export const inspectOracleCorpusCollection = async (input: {
  corpusRoot: string;
  repositoryRoot: string;
}): Promise<OracleCorpusCollection> => {
  if (!path.isAbsolute(input.corpusRoot))
    throw new Error("Oracle corpus collection root must be absolute");
  const requested = path.normalize(input.corpusRoot);
  if (requested !== input.corpusRoot)
    throw new Error("Oracle corpus collection root must be normalized");
  const repository = await realpath(input.repositoryRoot);
  await assertNoSymlinkComponents(requested);
  const root = await realpath(requested);
  if (
    root !== requested ||
    root === repository ||
    isPathInside(root, repository)
  )
    throw new Error("Oracle corpus collection must be outside the repository");
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700)
    throw new Error("Oracle corpus collection must be a 0700 directory");

  const entries = new Map<string, OracleCorpusArtifactEntry>();
  const directories = new Map<string, string>();
  for (const child of (await readdir(root)).sort()) {
    const childPath = path.join(root, child);
    const childMetadata = await lstat(childPath);
    if (!childMetadata.isDirectory() || childMetadata.isSymbolicLink())
      throw new Error("Oracle corpus collection may contain only directories");
    const entry = await inspectOracleCorpusArtifact({
      corpusDirectory: childPath,
      repositoryRoot: repository
    });
    const taskDigest = entry.identity.task.digest;
    if (entries.has(taskDigest))
      throw new Error(`Duplicate oracle corpus task ${taskDigest}`);
    entries.set(taskDigest, entry);
    directories.set(taskDigest, childPath);
  }
  if (entries.size === 0)
    throw new Error("Oracle corpus collection must contain at least one task");
  const manifest = createOracleCorpusCollectionManifest(entries.values());
  return {
    schemaVersion: "koed-oracle-corpus-collection-v1",
    classification: "private-benchmark-corpus",
    root,
    entries,
    directories,
    manifest
  };
};
