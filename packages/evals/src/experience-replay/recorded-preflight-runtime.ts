import path from "node:path";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import type { ExperienceReplayCodexAuthMode } from "./core/index.js";
import { resolveRecordedCodexAuthentication } from "./codex-auth.js";
import type {
  TaskImageAttestation,
  TaskImageBuildInput,
  TaskImageBuildResult
} from "./image-attestation.js";
import {
  createRecordedRunPreflightAdapters,
  EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
  ProductPathPrerequisiteError,
  type RecordedRunAttestation,
  type RecordedRunPreflightAdapters
} from "./preflight.js";
import {
  executeBoundedCommand,
  type BoundedCommandExecutor
} from "./toolchain.js";

const harborProject = path.join(
  EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
  "harbor"
);
const corpusManifest = path.join(
  EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
  "fixtures/tb3-v3.0.0.json"
);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

const required = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string
): string => {
  const value = environment[name]?.trim();
  if (!value || /[\0\r\n]/u.test(value))
    throw new ProductPathPrerequisiteError([`${name} is required`]);
  return value;
};

const absolute = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string
): string => {
  const value = required(environment, name);
  if (!path.isAbsolute(value))
    throw new ProductPathPrerequisiteError([
      `${name} must be an absolute path`
    ]);
  return path.normalize(value);
};

const exactObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Harbor task-image provisioning returned a malformed object"
    );
  return value as Record<string, unknown>;
};

const exactString = (value: unknown, label: string, digest = false): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value) ||
    (digest && !SHA256.test(value))
  )
    throw new Error(`Harbor task-image provisioning returned invalid ${label}`);
  return value;
};

const parseProvisionedImage = (
  task: TaskImageBuildInput,
  stdout: string
): TaskImageBuildResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Harbor task-image provisioning returned malformed JSON");
  }
  const result = exactObject(parsed);
  const allowed = new Set([
    "schema_version",
    "task_name",
    "task_digest",
    "immutable_reference",
    "image_id",
    "content_digest",
    "resolved_base_image_digests",
    "dockerfile_sha256",
    "docker_version",
    "buildkit_version",
    "provenance_sha256"
  ]);
  if (
    result.schema_version !== "koed-harbor-task-image-v1" ||
    Object.keys(result).length !== allowed.size ||
    Object.keys(result).some((key) => !allowed.has(key)) ||
    result.task_name !== task.taskName ||
    result.task_digest !== task.taskDigest
  )
    throw new Error(
      "Harbor task-image provisioning identity or schema mismatch"
    );
  if (!Array.isArray(result.resolved_base_image_digests))
    throw new Error(
      "Harbor task-image provisioning returned invalid base-image digests"
    );
  const resolvedBaseImageDigests = result.resolved_base_image_digests.map(
    (value) => exactString(value, "base-image digest", true)
  );
  return Object.freeze({
    immutableReference: exactString(
      result.immutable_reference,
      "immutable reference"
    ),
    imageId: exactString(result.image_id, "image ID", true),
    contentDigest: exactString(result.content_digest, "content digest", true),
    resolvedBaseImageDigests: Object.freeze(resolvedBaseImageDigests),
    dockerfileSha256: exactString(
      result.dockerfile_sha256,
      "Dockerfile digest",
      true
    ),
    dockerVersion: exactString(result.docker_version, "Docker version"),
    buildkitVersion: exactString(result.buildkit_version, "BuildKit version"),
    provenanceSha256:
      result.provenance_sha256 === null
        ? null
        : exactString(result.provenance_sha256, "provenance digest", true)
  });
};

export interface RecordedPreflightRuntime {
  readonly adapters: RecordedRunPreflightAdapters;
  readonly productPathReady: true;
}

export interface RecordedPreflightRuntimeOperations {
  executor?: BoundedCommandExecutor;
}

/**
 * Concrete recorded preflight. Image evidence comes only from the locked
 * Harbor runner; Codex evidence comes from two explicit credential contexts.
 */
export const createRecordedPreflightRuntime = (
  config: ResolvedExperienceReplayConfig,
  environment: Readonly<NodeJS.ProcessEnv>,
  operations: RecordedPreflightRuntimeOperations = {},
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key",
  persistedTaskImages?: readonly TaskImageAttestation[]
): RecordedPreflightRuntime => {
  if (config.profile === "smoke")
    throw new Error("Recorded preflight runtime cannot be used for smoke");
  const uvExecutable = absolute(
    environment,
    "KOED_EXPERIENCE_REPLAY_HARBOR_UV_BINARY"
  );
  const dockerExecutable = absolute(
    environment,
    "KOED_EXPERIENCE_REPLAY_DOCKER_BINARY"
  );
  if (path.basename(dockerExecutable) !== "docker")
    throw new ProductPathPrerequisiteError([
      "KOED_EXPERIENCE_REPLAY_DOCKER_BINARY must name the docker executable"
    ]);
  const registry = required(environment, "KOED_EXPERIENCE_REPLAY_OCI_REGISTRY");
  const hostBinary = absolute(
    environment,
    "KOED_EXPERIENCE_REPLAY_HOST_CODEX_BINARY"
  );
  const containerBinary = absolute(
    environment,
    "KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_BINARY"
  );
  const authentication = resolveRecordedCodexAuthentication(
    environment,
    codexAuthMode
  );
  const hostCodexHome =
    authentication.mode === "subscription"
      ? authentication.codexHome
      : absolute(environment, "KOED_EXPERIENCE_REPLAY_HOST_CODEX_HOME");
  const containerCodexHome =
    authentication.mode === "subscription"
      ? authentication.codexHome
      : absolute(environment, "KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_HOME");
  if (authentication.mode === "api_key" && hostCodexHome === containerCodexHome)
    throw new ProductPathPrerequisiteError([
      "host and container Codex auth homes must be separate"
    ]);
  const executor = operations.executor ?? executeBoundedCommand;
  const provisionTaskImage = async (
    task: TaskImageBuildInput
  ): Promise<TaskImageBuildResult> => {
    const output = await executor({
      file: uvExecutable,
      args: [
        "run",
        "--locked",
        "--project",
        harborProject,
        "python",
        "runner.py",
        "provision-task-image",
        "--manifest",
        corpusManifest,
        "--task-name",
        task.taskName,
        "--task-digest",
        task.taskDigest,
        "--registry",
        registry
      ],
      cwd: harborProject,
      env: {
        PATH: [path.dirname(dockerExecutable), environment.PATH]
          .filter(Boolean)
          .join(path.delimiter),
        DOCKER_HOST: environment.DOCKER_HOST,
        DOCKER_CONFIG: environment.DOCKER_CONFIG
      },
      timeoutMs: config.timeouts.setup_seconds * 1_000,
      maxOutputBytes: 1024 * 1024
    });
    return parseProvisionedImage(task, output.stdout);
  };
  const adapters = createRecordedRunPreflightAdapters({
    config,
    provisionTaskImage,
    ...(persistedTaskImages ? { persistedTaskImages } : {}),
    dockerExecutable,
    hostCodex: {
      binary: hostBinary,
      cwd: path.dirname(hostBinary),
      environment: {
        CODEX_HOME: hostCodexHome,
        ...(authentication.mode === "api_key"
          ? { OPENAI_API_KEY: authentication.apiKey }
          : {})
      }
    },
    containerCodex: {
      binary: containerBinary,
      cwd: path.dirname(containerBinary),
      environment: {
        CODEX_HOME: containerCodexHome,
        ...(authentication.mode === "api_key"
          ? { OPENAI_API_KEY: authentication.apiKey }
          : {})
      }
    },
    executor
  });
  return Object.freeze({ adapters, productPathReady: true });
};

export const immutableTaskImageMap = (
  attestation: RecordedRunAttestation
): Readonly<Record<string, string>> => {
  const entries = attestation.taskImages.map(
    (image: TaskImageAttestation) =>
      [image.taskName, image.immutableReference] as const
  );
  if (new Set(entries.map(([name]) => name)).size !== entries.length)
    throw new Error("Recorded task-image attestation has duplicate task names");
  return Object.freeze(Object.fromEntries(entries));
};
