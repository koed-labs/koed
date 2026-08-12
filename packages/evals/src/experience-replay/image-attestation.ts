import { immutableHash } from "./core/index.js";
import {
  executeBoundedCommand,
  type BoundedCommandExecutor
} from "./toolchain.js";

const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_REFERENCE = /^([^@\s]+)@(sha256:[a-f0-9]{64})$/;

export interface TaskImageBuildInput {
  taskName: string;
  taskDigest: string;
}

export interface TaskImageAttestation {
  taskName: string;
  taskDigest: string;
  immutableReference: string;
  imageId: string;
  contentDigest: string;
  resolvedBaseImageDigests: readonly string[];
  dockerfileSha256: string;
  dockerVersion: string;
  buildkitVersion: string;
  provenanceSha256: string | null;
  attestationHash: string;
}

export type TaskImageBuildResult = Omit<
  TaskImageAttestation,
  "taskName" | "taskDigest" | "attestationHash"
>;

export type TaskImageBuilder = (
  task: TaskImageBuildInput
) => Promise<TaskImageBuildResult>;

export interface OciImageInspection {
  immutableReference: string;
  imageId: string;
  contentDigest: string;
}

const assertDigest = (value: string, label: string): void => {
  if (!OCI_DIGEST.test(value))
    throw new Error(`${label} must be an immutable sha256 digest`);
};

const assertNonemptyLine = (value: string, label: string): void => {
  if (!value || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be one non-empty attested line`);
  }
};

export const assertImmutableImageReference = (reference: string): string => {
  const match = IMMUTABLE_REFERENCE.exec(reference);
  if (!match)
    throw new Error(
      `Mutable or malformed OCI image reference is forbidden: ${reference}`
    );
  return match[2]!;
};

/** Pull and inspect an image by exact registry digest, never by a mutable tag. */
export const inspectImmutableOciImage = async ({
  immutableReference,
  dockerExecutable = "docker",
  executor = executeBoundedCommand
}: {
  immutableReference: string;
  dockerExecutable?: string;
  executor?: BoundedCommandExecutor;
}): Promise<OciImageInspection> => {
  const contentDigest = assertImmutableImageReference(immutableReference);
  await executor({
    file: dockerExecutable,
    args: ["pull", immutableReference],
    timeoutMs: 30 * 60_000,
    maxOutputBytes: 1024 * 1024
  });
  const result = await executor({
    file: dockerExecutable,
    args: ["image", "inspect", immutableReference, "--format", "{{json .}}"],
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Docker image inspection returned malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Docker image inspection returned a malformed object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.Id !== "string" || !OCI_DIGEST.test(record.Id)) {
    throw new Error("Docker image inspection returned a malformed image ID");
  }
  if (
    !Array.isArray(record.RepoDigests) ||
    !record.RepoDigests.every((value) => typeof value === "string") ||
    !record.RepoDigests.includes(immutableReference)
  ) {
    throw new Error(
      "Docker image inspection did not attest the exact immutable reference"
    );
  }
  return Object.freeze({
    immutableReference,
    imageId: record.Id,
    contentDigest
  });
};

const validateBuildResult = (
  task: TaskImageBuildInput,
  built: TaskImageBuildResult
): TaskImageAttestation => {
  assertDigest(task.taskDigest, `Task digest for ${task.taskName}`);
  const referenceDigest = assertImmutableImageReference(
    built.immutableReference
  );
  assertDigest(built.imageId, `OCI image ID for ${task.taskName}`);
  assertDigest(built.contentDigest, `OCI content digest for ${task.taskName}`);
  if (referenceDigest !== built.contentDigest) {
    throw new Error(
      `OCI reference/content digest mismatch for ${task.taskName}`
    );
  }
  assertDigest(built.dockerfileSha256, `Dockerfile hash for ${task.taskName}`);
  if (!Array.isArray(built.resolvedBaseImageDigests)) {
    throw new Error(
      `Resolved base-image digests are missing for ${task.taskName}`
    );
  }
  const bases = built.resolvedBaseImageDigests.map((digest: unknown) => {
    if (typeof digest !== "string")
      throw new Error(`Invalid base-image digest for ${task.taskName}`);
    assertDigest(digest, `Base-image digest for ${task.taskName}`);
    return digest;
  });
  if (new Set(bases).size !== bases.length)
    throw new Error(`Duplicate base-image digest for ${task.taskName}`);
  assertNonemptyLine(built.dockerVersion, "Docker version");
  assertNonemptyLine(built.buildkitVersion, "BuildKit version");
  if (built.provenanceSha256 !== null) {
    assertDigest(
      built.provenanceSha256,
      `Build provenance hash for ${task.taskName}`
    );
  }
  const material = {
    taskName: task.taskName,
    taskDigest: task.taskDigest,
    immutableReference: built.immutableReference,
    imageId: built.imageId,
    contentDigest: built.contentDigest,
    resolvedBaseImageDigests: bases,
    dockerfileSha256: built.dockerfileSha256,
    dockerVersion: built.dockerVersion,
    buildkitVersion: built.buildkitVersion,
    provenanceSha256: built.provenanceSha256
  };
  return Object.freeze({
    ...material,
    resolvedBaseImageDigests: Object.freeze(bases),
    attestationHash: immutableHash(material)
  });
};

/** Resolve/build each selected task once and freeze its complete immutable identity. */
export const freezeTaskImages = async (
  tasks: readonly TaskImageBuildInput[],
  build: TaskImageBuilder
): Promise<readonly TaskImageAttestation[]> => {
  const names = new Set<string>();
  const digests = new Set<string>();
  const attestations: TaskImageAttestation[] = [];
  for (const task of tasks) {
    if (
      !task.taskName ||
      names.has(task.taskName) ||
      digests.has(task.taskDigest)
    ) {
      throw new Error(`Task image identity must be unique: ${task.taskName}`);
    }
    names.add(task.taskName);
    digests.add(task.taskDigest);
    attestations.push(
      validateBuildResult(task, await build(Object.freeze({ ...task })))
    );
  }
  return Object.freeze(attestations);
};

/** Reinspect immediately before an attempt and abort if the frozen image changed. */
export const verifyFrozenTaskImage = (
  frozen: TaskImageAttestation,
  inspected: TaskImageBuildResult
): void => {
  const current = validateBuildResult(
    { taskName: frozen.taskName, taskDigest: frozen.taskDigest },
    inspected
  );
  if (current.attestationHash !== frozen.attestationHash) {
    throw new Error(
      `Frozen OCI image attestation changed for ${frozen.taskName}`
    );
  }
};
