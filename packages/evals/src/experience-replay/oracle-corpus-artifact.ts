import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertNoSymlinkComponents,
  isPathInside,
  readTextFileNoFollow,
  writeTextArtifactAtomic
} from "./artifacts.js";
import { materializeSanitizedAtifTrajectory } from "./atif/index.js";
import { canonicalJson, sha256 } from "./core/hash.js";
import {
  buildOracleCorpus,
  type OracleCorpus,
  type SuccessfulOracleSource
} from "./oracle-corpus.js";
import type { TaskImageAttestation } from "./image-attestation.js";

export const ORACLE_CORPUS_ARTIFACT_FILE = "oracle-corpus-artifact.json";
const MAX_FIXTURE_BYTES = 256 * 1024 * 1024;
const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const hexSha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const digestSha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const line = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    return value.trim() === value && !/[\r\n\0]/u.test(value);
  });
const count = z.number().int().nonnegative().safe();
const counts = z.record(z.string(), count);
const jsonObject = z.record(z.string(), z.json());

const toolCallSchema = z
  .object({
    tool_call_id: z.string(),
    function_name: z.string(),
    arguments: jsonObject
  })
  .strict();
const resultSchema = z
  .object({ source_call_id: z.string(), content: z.string() })
  .strict();
const stepSchema = z
  .object({
    step_id: count,
    timestamp: z.string().optional(),
    source: z.enum(["system", "user", "agent"]),
    message: z.string(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    observation: z
      .object({ results: z.array(resultSchema) })
      .strict()
      .optional()
  })
  .strict();
const trajectorySchema = z
  .object({
    schema_version: z.literal("ATIF-v1.7"),
    session_id: z.string().optional(),
    trajectory_id: z.string().optional(),
    agent: z.object({ name: z.literal("codex"), version: z.string() }).strict(),
    steps: z.array(stepSchema)
  })
  .strict();
const normalizedItemSchema = z
  .object({
    adapterName: z.literal("harbor-atif"),
    adapterVersion: z.literal("1.0.0"),
    sourceIdentity: z.string(),
    atifIdentity: z.string(),
    sequence: count,
    stepId: count,
    timestamp: z.string().nullable(),
    type: z.enum([
      "system_message",
      "user_message",
      "agent_message",
      "reasoning_summary",
      "tool_call",
      "tool_result"
    ]),
    content: z.string().optional(),
    toolCall: toolCallSchema.optional(),
    sourceCallId: z.string().optional()
  })
  .strict();
const manifestSchema = z
  .object({
    inputSha256: hexSha256,
    outputSha256: hexSha256.nullable(),
    schemaVersion: z.string().nullable(),
    allowedFieldCounts: counts,
    removedFieldCounts: counts,
    redactionCounts: z
      .object({
        API_KEY: count.optional(),
        BEARER_TOKEN: count.optional(),
        PASSWORD: count.optional(),
        SESSION_COOKIE: count.optional(),
        PRIVATE_KEY: count.optional(),
        DSN: count.optional()
      })
      .strict(),
    limitUsage: z
      .object({
        rawBytes: count,
        nestingDepth: count,
        steps: count,
        nestedValues: count,
        largestStringBytes: count,
        allowedTextBytes: count,
        allowedTextTokens: count
      })
      .strict(),
    cutoffAttested: z.boolean(),
    rejectionReason: z.string().nullable()
  })
  .strict();
const sanitizationSchema = z
  .object({
    trajectory: trajectorySchema,
    normalizedItems: z.array(normalizedItemSchema),
    manifest: manifestSchema,
    canonicalJson: z.string()
  })
  .strict();
const sourceSchema = z
  .object({
    taskDigest: digestSha256,
    sourceAttemptId: line,
    passed: z.literal(true),
    reward: z.number().finite(),
    expectedSuccessValue: z.number().finite(),
    failureCategory: z.null(),
    sanitization: sanitizationSchema
  })
  .strict();
const variantSchema = z.enum([
  "guidance-only",
  "trace-only",
  "full-experience"
]);
const artifactSchema = z
  .object({
    variant: variantSchema,
    sha256: hexSha256,
    sanitization: sanitizationSchema
  })
  .strict();
const provenanceSchema = z
  .object({
    schemaVersion: z.literal("koed-oracle-corpus-v1"),
    taskDigest: digestSha256,
    sourceAttemptId: line,
    oracleBriefSha256: hexSha256,
    matchedSystemStep: z
      .object({
        stepId: count,
        messageSha256: hexSha256,
        memoryProjectionRole: z.literal("user")
      })
      .strict(),
    verifierQualification: z
      .object({
        passed: z.literal(true),
        reward: z.number().finite(),
        expectedSuccessValue: z.number().finite()
      })
      .strict(),
    sanitizedSource: z
      .object({ inputSha256: hexSha256, outputSha256: hexSha256 })
      .strict(),
    artifacts: z
      .object({
        "guidance-only": hexSha256,
        "trace-only": hexSha256,
        "full-experience": hexSha256
      })
      .strict(),
    manifestSha256: hexSha256
  })
  .strict();
const corpusSchema = z
  .object({
    guidanceOnly: artifactSchema,
    traceOnly: artifactSchema,
    fullExperience: artifactSchema,
    provenance: provenanceSchema
  })
  .strict();

export const oracleCorpusArtifactIdentitySchema = z
  .object({
    model: line,
    reasoningEffort: line,
    task: z.object({ name: line, digest: digestSha256 }).strict(),
    codex: z.object({ version: line }).strict(),
    taskImage: z
      .object({
        taskName: line,
        taskDigest: digestSha256,
        immutableReference: line,
        imageId: digestSha256,
        contentDigest: digestSha256,
        resolvedBaseImageDigests: z.array(digestSha256),
        dockerfileSha256: digestSha256,
        dockerVersion: line,
        buildkitVersion: line,
        provenanceSha256: digestSha256.nullable(),
        attestationHash: hexSha256
      })
      .strict(),
    sanitizer: z.object({ name: line, version: line }).strict()
  })
  .strict();

export type OracleCorpusArtifactIdentity = z.infer<
  typeof oracleCorpusArtifactIdentitySchema
> & { taskImage: TaskImageAttestation };

const payloadWithoutAttestationSchema = z
  .object({
    schemaVersion: z.literal("koed-oracle-corpus-artifact-v1"),
    classification: z.literal("private-benchmark-corpus"),
    identity: oracleCorpusArtifactIdentitySchema,
    oracleBrief: z.string(),
    source: sourceSchema,
    corpus: corpusSchema
  })
  .strict();
const payloadSchema = payloadWithoutAttestationSchema
  .extend({ attestationSha256: hexSha256 })
  .strict();

export interface OracleCorpusArtifactEntry {
  schemaVersion: "koed-oracle-corpus-artifact-v1";
  classification: "private-benchmark-corpus";
  identity: OracleCorpusArtifactIdentity;
  oracleBrief: string;
  source: SuccessfulOracleSource;
  corpus: OracleCorpus;
  attestationSha256: string;
}

export interface OracleCorpusArtifactLocation {
  corpusDirectory: string;
  repositoryRoot: string;
}

const sameFile = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean => left.dev === right.dev && left.ino === right.ino;

const existingAncestor = async (candidate: string): Promise<string> => {
  let current = candidate;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
};

export const admitOracleCorpusDirectory = async (
  location: OracleCorpusArtifactLocation,
  create: boolean
): Promise<string> => {
  if (!path.isAbsolute(location.corpusDirectory)) {
    throw new Error("Oracle corpus directory must be absolute");
  }
  const requested = path.normalize(location.corpusDirectory);
  if (requested !== location.corpusDirectory) {
    throw new Error("Oracle corpus directory must be normalized");
  }
  const repository = await realpath(location.repositoryRoot);
  if (requested === repository || isPathInside(requested, repository)) {
    throw new Error("Oracle corpus must be stored outside the repository");
  }
  if (create) {
    await assertNoSymlinkComponents(await existingAncestor(requested));
    await mkdir(requested, { recursive: true, mode: 0o700 });
  }
  await assertNoSymlinkComponents(requested);
  const canonical = await realpath(requested);
  if (canonical !== requested) {
    throw new Error("Oracle corpus directory used a symlink");
  }
  if (canonical === repository || isPathInside(canonical, repository)) {
    throw new Error("Oracle corpus must be stored outside the repository");
  }
  const handle = await open(
    canonical,
    constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
  );
  try {
    const opened = await handle.stat();
    const current = await lstat(canonical);
    if (!opened.isDirectory() || !sameFile(opened, current)) {
      throw new Error("Oracle corpus directory changed during validation");
    }
    if (create) await handle.chmod(0o700);
    const mode = (await handle.stat()).mode & 0o777;
    if (mode !== 0o700) {
      throw new Error("Oracle corpus directory permissions must be 0700");
    }
  } finally {
    await handle.close();
  }
  return canonical;
};

const attest = (
  value: Omit<OracleCorpusArtifactEntry, "attestationSha256">
): string => sha256(canonicalJson(value));

const enforceArtifactFileMode = async (artifactPath: string): Promise<void> => {
  const handle = await open(artifactPath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const current = await lstat(artifactPath);
    if (!opened.isFile() || !sameFile(opened, current)) {
      throw new Error("Oracle corpus artifact changed during publication");
    }
    await handle.chmod(0o600);
    if (((await handle.stat()).mode & 0o777) !== 0o600) {
      throw new Error("Oracle corpus artifact permissions must be 0600");
    }
  } finally {
    await handle.close();
  }
};

const validatePayload = (
  raw: unknown,
  expectedIdentity?: OracleCorpusArtifactIdentity
): OracleCorpusArtifactEntry => {
  const entry = payloadSchema.parse(raw) as OracleCorpusArtifactEntry;
  const { attestationSha256, ...withoutAttestation } = entry;
  if (attest(withoutAttestation) !== attestationSha256) {
    throw new Error("Oracle corpus artifact attestation mismatch");
  }
  if (expectedIdentity) {
    const expected = oracleCorpusArtifactIdentitySchema.parse(expectedIdentity);
    if (canonicalJson(entry.identity) !== canonicalJson(expected)) {
      throw new Error("Oracle corpus artifact identity mismatch");
    }
  }
  if (
    entry.identity.task.digest !== entry.source.taskDigest ||
    entry.identity.task.digest !== entry.corpus.provenance.taskDigest
  ) {
    throw new Error("Oracle corpus artifact task provenance mismatch");
  }
  const rematerialized = materializeSanitizedAtifTrajectory(
    entry.source.sanitization.trajectory,
    {
      taskDigest: entry.source.taskDigest,
      sourceAttemptId: entry.source.sourceAttemptId,
      sourceManifest: entry.source.sanitization.manifest
    }
  );
  if (
    canonicalJson(rematerialized) !== canonicalJson(entry.source.sanitization)
  ) {
    throw new Error("Oracle corpus artifact sanitized source mismatch");
  }
  const rebuilt = buildOracleCorpus({
    oracleBrief: entry.oracleBrief,
    oracleBriefSha256: entry.corpus.provenance.oracleBriefSha256,
    source: entry.source
  });
  if (canonicalJson(rebuilt) !== canonicalJson(entry.corpus)) {
    throw new Error("Oracle corpus artifact provenance mismatch");
  }
  return entry;
};

export const validateOracleCorpusArtifactEntry = (
  entry: OracleCorpusArtifactEntry
): OracleCorpusArtifactEntry => validatePayload(entry, entry.identity);

/**
 * Persists one immutable verifier-qualified sanitized benchmark corpus.
 */
export const persistOracleCorpusArtifact = async (
  location: OracleCorpusArtifactLocation,
  input: {
    identity: OracleCorpusArtifactIdentity;
    oracleBrief: string;
    source: SuccessfulOracleSource;
    corpus: OracleCorpus;
  }
): Promise<OracleCorpusArtifactEntry> => {
  const identity = oracleCorpusArtifactIdentitySchema.parse(input.identity);
  const withoutAttestation = payloadWithoutAttestationSchema.parse({
    schemaVersion: "koed-oracle-corpus-artifact-v1",
    classification: "private-benchmark-corpus",
    identity,
    oracleBrief: input.oracleBrief,
    source: input.source,
    corpus: input.corpus
  }) as Omit<OracleCorpusArtifactEntry, "attestationSha256">;
  const entry: OracleCorpusArtifactEntry = {
    ...withoutAttestation,
    attestationSha256: attest(withoutAttestation)
  };
  validatePayload(entry, identity);
  const root = await admitOracleCorpusDirectory(location, true);
  await writeTextArtifactAtomic(
    root,
    ORACLE_CORPUS_ARTIFACT_FILE,
    `${canonicalJson(entry)}\n`
  );
  await enforceArtifactFileMode(path.join(root, ORACLE_CORPUS_ARTIFACT_FILE));
  return entry;
};

/** Loads a private oracle corpus artifact only when all identity and hashes agree. */
export const loadOracleCorpusArtifact = async (
  location: OracleCorpusArtifactLocation,
  expectedIdentity: OracleCorpusArtifactIdentity
): Promise<OracleCorpusArtifactEntry> => {
  const root = await admitOracleCorpusDirectory(location, false);
  const artifactPath = path.join(root, ORACLE_CORPUS_ARTIFACT_FILE);
  const metadata = await lstat(artifactPath);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Oracle corpus artifact must be a 0600 regular file");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readTextFileNoFollow(artifactPath, MAX_FIXTURE_BYTES)
    );
  } catch (error) {
    throw new Error("Oracle corpus artifact is corrupt", { cause: error });
  }
  return validatePayload(raw, expectedIdentity);
};

/** Reads and fully attests a private corpus before identity matching. */
export const inspectOracleCorpusArtifact = async (
  location: OracleCorpusArtifactLocation
): Promise<OracleCorpusArtifactEntry> => {
  const root = await admitOracleCorpusDirectory(location, false);
  const artifactPath = path.join(root, ORACLE_CORPUS_ARTIFACT_FILE);
  const metadata = await lstat(artifactPath);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Oracle corpus artifact must be a 0600 regular file");
  }
  try {
    return validatePayload(
      JSON.parse(await readTextFileNoFollow(artifactPath, MAX_FIXTURE_BYTES))
    );
  } catch (error) {
    throw new Error("Oracle corpus artifact is corrupt", { cause: error });
  }
};
