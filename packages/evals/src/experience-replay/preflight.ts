import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpRecallPolicyVersion } from "@koed/mcp-server";
import {
  createBenchmarkRunPlan,
  createOracleCampaignProtocol,
  createOracleCorpusQualificationRunPlan,
  createOracleSeededCampaignRunPlan,
  createOracleSeededRepeatedStudyRunPlan,
  createOracleSeededProductProofRunPlan,
  createProductPathProofRunPlan,
  immutableHash,
  SMOKE_TASK_DIGESTS,
  sha256,
  verifyExperienceReplayRunPlan,
  resolveExperienceReplayConfig,
  type ExperienceReplayExecutionKind,
  type ExperienceReplayCodexAuthMode,
  type ExperienceReplayRunPlan,
  type OracleCampaignProtocol,
  type ResolvedExperienceReplayConfig
} from "./core/index.js";
import {
  estimateRunCapacity,
  SafeRunDirectory,
  type RunCapacityEstimate
} from "./output-path.js";
import {
  freezeTaskImages,
  inspectImmutableOciImage,
  verifyFrozenTaskImage,
  type TaskImageAttestation,
  type TaskImageBuilder
} from "./image-attestation.js";
import {
  attestCodexToolchain,
  executeBoundedCommand,
  type BoundedCommandExecutor,
  type CodexToolchainAttestation
} from "./toolchain.js";

export const HARBOR_COMMIT = "64afbbcb62165950301e1a6407c729aa26d844ff";
export const HARBOR_VERSION = "0.21.0";
export const TERMINAL_BENCH_COMMIT = "2b0442c3c583b710ca8da14c8e601b99f2f1f244";
export const TERMINAL_BENCH_VERSION = "v3.0.0";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
export const EXPERIENCE_REPLAY_REPOSITORY_ROOT = path.resolve(
  sourceRoot,
  "../../../.."
);
export const EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT = path.join(
  EXPERIENCE_REPLAY_REPOSITORY_ROOT,
  "packages/evals/src/experience-replay"
);

interface CorpusTask {
  name: string;
  task_digest: string;
  harbor_task_checksum: string;
  source_path: string;
  category: string;
  expert_time_quartile: number;
  expert_time_seconds: number;
  agent_timeout_seconds: number;
  verifier_timeout_seconds: number;
  resource_class: string;
  primary_reward: {
    field: string;
    minimum: number;
    maximum: number;
    success: { operator: string; value: number };
  };
}

interface CorpusManifest {
  schema_version: string;
  task_count: number;
  harbor: { version: string; commit: string };
  terminal_bench: {
    version: string;
    commit: string;
    dataset: { kind: string; path: string; repo: string };
  };
  tasks: CorpusTask[];
}

interface SubsetManifest {
  schema_version: string;
  corpus_schema_version: string;
  profile: "quick" | "standard";
  task_count: number;
  tasks: CorpusTask[];
}

interface ProductProofManifest {
  schema_version: "koed-terminal-bench-product-proof-v2";
  corpus_schema_version: string;
  target_task: string;
  donor_task: string;
  task_count: 2;
  tasks: [CorpusTask, CorpusTask];
}

const readJson = async <T>(filename: string): Promise<T> =>
  JSON.parse(await readFile(filename, "utf8")) as T;

const assertTaskManifest = (
  tasks: readonly CorpusTask[],
  expectedCount: number
): void => {
  if (tasks.length !== expectedCount)
    throw new Error(`Expected ${expectedCount} pinned tasks`);
  const names = new Set<string>();
  const digests = new Set<string>();
  for (const task of tasks) {
    if (names.has(task.name) || digests.has(task.task_digest)) {
      throw new Error(`Duplicate pinned task identity: ${task.name}`);
    }
    names.add(task.name);
    digests.add(task.task_digest);
    if (!/^sha256:[a-f0-9]{64}$/.test(task.task_digest)) {
      throw new Error(`Invalid immutable task digest for ${task.name}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(task.harbor_task_checksum)) {
      throw new Error(`Invalid Harbor checksum for ${task.name}`);
    }
    if (
      !task.source_path.startsWith("tasks/") ||
      !Number.isSafeInteger(task.agent_timeout_seconds) ||
      task.agent_timeout_seconds <= 0 ||
      !Number.isSafeInteger(task.verifier_timeout_seconds) ||
      task.verifier_timeout_seconds <= 0 ||
      !Number.isFinite(task.primary_reward.minimum) ||
      !Number.isFinite(task.primary_reward.maximum) ||
      task.primary_reward.minimum > task.primary_reward.maximum
    ) {
      throw new Error(`Invalid committed task contract for ${task.name}`);
    }
  }
};

export interface PinnedInputsAttestation {
  corpusHash: string;
  subsetHash: string | null;
  uvLockHash: string;
  selectedTasks: readonly CorpusTask[];
}

export const attestPinnedInputs = async (
  profile: ResolvedExperienceReplayConfig["profile"],
  executionKind: ExperienceReplayExecutionKind = "benchmark_profile",
  campaignTaskDigests?: readonly string[],
  campaignTaskUniverseDigests?: readonly string[]
): Promise<PinnedInputsAttestation> => {
  const corpusPath = path.join(
    EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
    "fixtures/tb3-v3.0.0.json"
  );
  const corpusText = await readFile(corpusPath, "utf8");
  const corpus = JSON.parse(corpusText) as CorpusManifest;
  if (
    corpus.schema_version !== "koed-terminal-bench-corpus-v2" ||
    corpus.task_count !== 74 ||
    corpus.harbor.version !== HARBOR_VERSION ||
    corpus.harbor.commit !== HARBOR_COMMIT ||
    corpus.terminal_bench.version !== TERMINAL_BENCH_VERSION ||
    corpus.terminal_bench.commit !== TERMINAL_BENCH_COMMIT ||
    corpus.terminal_bench.dataset.kind !== "implicit_git" ||
    corpus.terminal_bench.dataset.path !== "tasks" ||
    corpus.terminal_bench.dataset.repo !==
      `harbor-framework/terminal-bench@${TERMINAL_BENCH_COMMIT}`
  ) {
    throw new Error("Pinned Terminal-Bench/Harbor corpus identity mismatch");
  }
  assertTaskManifest(corpus.tasks, 74);

  const uvLock = await readFile(
    path.join(EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT, "harbor/uv.lock"),
    "utf8"
  );
  const pyproject = await readFile(
    path.join(EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT, "harbor/pyproject.toml"),
    "utf8"
  );
  if (
    !uvLock.includes(`rev=${HARBOR_COMMIT}#${HARBOR_COMMIT}`) ||
    !uvLock.includes(`version = "${HARBOR_VERSION}"`) ||
    !pyproject.includes(`harbor.git@${HARBOR_COMMIT}`)
  ) {
    throw new Error(
      "Harbor Python project is not locked to the committed release"
    );
  }

  if (profile === "smoke") {
    return {
      corpusHash: sha256(corpusText),
      subsetHash: null,
      uvLockHash: sha256(uvLock),
      selectedTasks: []
    };
  }
  if (
    executionKind === "oracle_seeded_campaign" ||
    executionKind === "oracle_corpus_qualification"
  ) {
    if (profile !== "full")
      throw new Error("Oracle campaign requires the full profile");
    if (!campaignTaskDigests?.length)
      throw new Error("Oracle campaign requires an explicit task shard");
    if (
      executionKind === "oracle_seeded_campaign" &&
      !campaignTaskUniverseDigests?.length
    )
      throw new Error("Oracle campaign requires an explicit task universe");
    const requested = new Set(campaignTaskDigests);
    if (requested.size !== campaignTaskDigests.length)
      throw new Error("Oracle campaign task shard must be unique");
    const selectedTasks = corpus.tasks.filter((task) =>
      requested.has(task.task_digest)
    );
    if (selectedTasks.length !== requested.size)
      throw new Error("Oracle campaign task shard contains an unknown task");
    if (executionKind === "oracle_seeded_campaign") {
      const corpusDigests = new Set(
        corpus.tasks.map((task) => task.task_digest)
      );
      const universe = new Set(campaignTaskUniverseDigests!);
      if (universe.size !== campaignTaskUniverseDigests!.length)
        throw new Error("Oracle campaign task universe must be unique");
      if ([...universe].some((digest) => !corpusDigests.has(digest)))
        throw new Error(
          "Oracle campaign task universe contains an unknown task"
        );
      if ([...requested].some((digest) => !universe.has(digest)))
        throw new Error(
          "Oracle campaign shard contains a task outside the universe"
        );
    }
    return {
      corpusHash: sha256(corpusText),
      subsetHash: immutableHash([...campaignTaskDigests].sort()),
      uvLockHash: sha256(uvLock),
      selectedTasks
    };
  }
  if (
    executionKind === "product_path_proof" ||
    executionKind === "oracle_seeded_product_proof" ||
    executionKind === "oracle_seeded_repeated_study"
  ) {
    const proof = await readJson<ProductProofManifest>(
      path.join(
        EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
        "fixtures/product-proof-2.json"
      )
    );
    if (
      proof.schema_version !== "koed-terminal-bench-product-proof-v2" ||
      proof.corpus_schema_version !== corpus.schema_version ||
      proof.task_count !== 2 ||
      proof.target_task === proof.donor_task ||
      proof.tasks[0]?.name !== proof.target_task ||
      proof.tasks[1]?.name !== proof.donor_task
    ) {
      throw new Error("Pinned product-path proof identity mismatch");
    }
    assertTaskManifest(proof.tasks, 2);
    const corpusByName = new Map(corpus.tasks.map((task) => [task.name, task]));
    for (const task of proof.tasks) {
      const corpusTask = corpusByName.get(task.name);
      if (!corpusTask || immutableHash(corpusTask) !== immutableHash(task)) {
        throw new Error(
          `Pinned product proof task differs from corpus: ${task.name}`
        );
      }
    }
    if (proof.tasks.some((task) => task.resource_class !== "cpu")) {
      throw new Error("Product-path proof tasks must be CPU-compatible");
    }
    return {
      corpusHash: sha256(corpusText),
      subsetHash: immutableHash(proof),
      uvLockHash: sha256(uvLock),
      selectedTasks:
        executionKind === "oracle_seeded_product_proof" ||
        executionKind === "oracle_seeded_repeated_study"
          ? [proof.tasks[0]!]
          : proof.tasks
    };
  }
  let selectedTasks = corpus.tasks;
  let subsetHash: string | null = null;
  if (profile === "quick" || profile === "standard") {
    const subset = await readJson<SubsetManifest>(
      path.join(
        EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
        `fixtures/${profile === "quick" ? "quick-12" : "standard-24"}.json`
      )
    );
    const expectedCount = profile === "quick" ? 12 : 24;
    if (
      subset.schema_version !== "koed-terminal-bench-subset-v2" ||
      subset.corpus_schema_version !== corpus.schema_version ||
      subset.profile !== profile ||
      subset.task_count !== expectedCount
    ) {
      throw new Error(`Pinned ${profile} subset identity mismatch`);
    }
    assertTaskManifest(subset.tasks, expectedCount);
    const corpusByName = new Map(corpus.tasks.map((task) => [task.name, task]));
    for (const task of subset.tasks) {
      const corpusTask = corpusByName.get(task.name);
      if (!corpusTask || immutableHash(corpusTask) !== immutableHash(task)) {
        throw new Error(`Pinned subset task differs from corpus: ${task.name}`);
      }
    }
    selectedTasks = subset.tasks;
    subsetHash = immutableHash(subset);
  }
  return {
    corpusHash: sha256(corpusText),
    subsetHash,
    uvLockHash: sha256(uvLock),
    selectedTasks
  };
};

export class ProductPathPrerequisiteError extends Error {
  override readonly name = "ProductPathPrerequisiteError";
  constructor(readonly missingPrerequisites: readonly string[]) {
    super(
      `Recorded model-driven execution is unavailable: ${missingPrerequisites.join("; ")}`
    );
  }
}

export interface PreflightResult {
  config: ResolvedExperienceReplayConfig;
  runPlan: Readonly<ExperienceReplayRunPlan>;
  pins: PinnedInputsAttestation;
  repositoryRoot: string;
  capacity: RunCapacityEstimate;
  recordedModelPathReady: boolean;
  recordedRunAttestation: RecordedRunAttestation | null;
  /** Immutable references execution must bind for every selected task. */
  frozenTaskImages: Readonly<Record<string, string>>;
  campaignProtocol?: Readonly<OracleCampaignProtocol>;
  campaignShardId?: string;
}

export interface RecordedRunAttestation {
  taskImages: readonly TaskImageAttestation[];
  hostCodex: CodexToolchainAttestation;
  containerCodex: CodexToolchainAttestation;
}

export interface RecordedRunPreflightAdapters {
  repositoryStatus?: (repositoryRoot: string) => Promise<string>;
  attestTaskImages: (
    tasks: readonly CorpusTask[]
  ) => Promise<readonly TaskImageAttestation[]>;
  attestHostCodex: () => Promise<CodexToolchainAttestation>;
  attestContainerCodex: () => Promise<CodexToolchainAttestation>;
}

export interface RecordedCodexAuthContext {
  /** Exact executable visible inside this authentication context. */
  binary: string;
  /** Real credential environment for this context (for example CODEX_HOME). */
  environment: Readonly<NodeJS.ProcessEnv>;
  cwd: string;
}

export interface RecordedRunPreflightFactoryOptions {
  config: ResolvedExperienceReplayConfig;
  /**
   * Provision one selected task image and return evidence measured from that
   * build. The factory freezes and independently reinspects its OCI identity.
   */
  provisionTaskImage: TaskImageBuilder;
  /**
   * Immutable image evidence from the original admission. Resume must verify
   * these exact images instead of rebuilding nominally equivalent ones.
   */
  persistedTaskImages?: readonly TaskImageAttestation[];
  hostCodex: RecordedCodexAuthContext;
  containerCodex: RecordedCodexAuthContext;
  dockerExecutable?: string;
  executor?: BoundedCommandExecutor;
  operations?: {
    attestCodex?: typeof attestCodexToolchain;
    inspectImage?: typeof inspectImmutableOciImage;
  };
}

const exactRepositoryStatus = async (
  repositoryRoot: string,
  executor: BoundedCommandExecutor
): Promise<string> =>
  (
    await executor({
      file: "git",
      args: ["status", "--porcelain", "--untracked-files=normal"],
      cwd: repositoryRoot,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024
    })
  ).stdout;

const assertRecordedCodexContext = (
  label: "host" | "container",
  context: RecordedCodexAuthContext
): void => {
  if (!context.binary || context.binary.trim() !== context.binary) {
    throw new Error(`${label} Codex binary must be an exact non-empty path`);
  }
  if (!path.isAbsolute(context.cwd)) {
    throw new Error(`${label} Codex attestation cwd must be absolute`);
  }
  if (!context.environment || typeof context.environment !== "object") {
    throw new Error(`${label} Codex auth environment is required`);
  }
};

/**
 * Bind the real recorded-run preflight operations. Callers only provide the
 * task-image provisioner and the two credential contexts; git, Docker
 * reinspection, executable hashing/versioning and model/list are all measured.
 */
export const createRecordedRunPreflightAdapters = (
  options: RecordedRunPreflightFactoryOptions
): RecordedRunPreflightAdapters => {
  assertRecordedCodexContext("host", options.hostCodex);
  assertRecordedCodexContext("container", options.containerCodex);
  if (options.hostCodex.environment === options.containerCodex.environment) {
    throw new Error(
      "Host and container Codex attestations require separate auth-context environments"
    );
  }
  const executor = options.executor ?? executeBoundedCommand;
  const attestCodex = options.operations?.attestCodex ?? attestCodexToolchain;
  const inspectImage =
    options.operations?.inspectImage ?? inspectImmutableOciImage;
  const expectedRepositoryRoot = path.resolve(
    EXPERIENCE_REPLAY_REPOSITORY_ROOT
  );
  const status = async (repositoryRoot = expectedRepositoryRoot) => {
    const canonicalRoot = await realpath(repositoryRoot);
    const canonicalExpected = await realpath(expectedRepositoryRoot);
    if (canonicalRoot !== canonicalExpected) {
      throw new Error("Recorded preflight repository root changed");
    }
    return exactRepositoryStatus(canonicalRoot, executor);
  };
  const assertClean = async (): Promise<void> => {
    if ((await status()).trim()) {
      throw new Error("Koed worktree changed during recorded preflight");
    }
  };
  const contextAttestation = async (
    context: RecordedCodexAuthContext,
    expectedSha256: string,
    requiredModelIds: readonly string[]
  ): Promise<CodexToolchainAttestation> => {
    await assertClean();
    const attestation = await attestCodex({
      binary: context.binary,
      expectedSha256,
      expectedVersion: options.config.codex_cli.version,
      requiredModelIds: [...new Set(requiredModelIds)],
      environment: { ...context.environment },
      cwd: context.cwd,
      executor
    });
    await assertClean();
    return attestation;
  };
  const adapters: RecordedRunPreflightAdapters = {
    repositoryStatus: status,
    attestTaskImages: async (tasks) => {
      await assertClean();
      const requested = tasks.map((task) => ({
        taskName: task.name,
        taskDigest: task.task_digest
      }));
      const frozen = options.persistedTaskImages
        ? (() => {
            const persistedByName = new Map(
              options.persistedTaskImages.map((image) => [
                image.taskName,
                image
              ])
            );
            if (
              persistedByName.size !== options.persistedTaskImages.length ||
              persistedByName.size !== requested.length
            ) {
              throw new Error(
                "Persisted task-image set differs from selected tasks"
              );
            }
            return Object.freeze(
              requested.map((task) => {
                const image = persistedByName.get(task.taskName);
                if (!image || image.taskDigest !== task.taskDigest) {
                  throw new Error(
                    `Persisted task-image identity differs for ${task.taskName}`
                  );
                }
                return image;
              })
            );
          })()
        : await freezeTaskImages(requested, options.provisionTaskImage);
      for (const image of frozen) {
        const inspected = await inspectImage({
          immutableReference: image.immutableReference,
          ...(options.dockerExecutable
            ? { dockerExecutable: options.dockerExecutable }
            : {}),
          executor
        });
        verifyFrozenTaskImage(image, {
          immutableReference: inspected.immutableReference,
          imageId: inspected.imageId,
          contentDigest: inspected.contentDigest,
          resolvedBaseImageDigests: image.resolvedBaseImageDigests,
          dockerfileSha256: image.dockerfileSha256,
          dockerVersion: image.dockerVersion,
          buildkitVersion: image.buildkitVersion,
          provenanceSha256: image.provenanceSha256
        });
      }
      await assertClean();
      return frozen;
    },
    attestHostCodex: () =>
      contextAttestation(
        options.hostCodex,
        options.config.codex_cli.host_sha256,
        [
          options.config.memory_answer.model.id,
          options.config.lcm_summary.model.id,
          options.config.session_title.model.id,
          options.config.trajectory_judge.model.id
        ]
      ),
    attestContainerCodex: () =>
      contextAttestation(
        options.containerCodex,
        options.config.codex_cli.container_sha256,
        [options.config.coding_agent.id]
      )
  };
  return Object.freeze(adapters);
};

const assertRecordedAttestation = (
  config: ResolvedExperienceReplayConfig,
  tasks: readonly CorpusTask[],
  attestation: RecordedRunAttestation
): void => {
  if (attestation.taskImages.length !== tasks.length) {
    throw new Error(
      "Recorded preflight did not freeze exactly one image per selected task"
    );
  }
  const images = new Map(
    attestation.taskImages.map((image) => [image.taskName, image])
  );
  for (const image of attestation.taskImages) {
    verifyFrozenTaskImage(image, image);
  }
  for (const task of tasks) {
    const image = images.get(task.name);
    if (!image || image.taskDigest !== task.task_digest) {
      throw new Error(`Recorded task image attestation mismatch: ${task.name}`);
    }
  }
  const assertToolchain = (
    context: "host" | "container",
    value: CodexToolchainAttestation,
    expectedSha256: string,
    requiredModels: readonly string[]
  ): void => {
    if (value.executable.sha256 !== expectedSha256) {
      throw new Error(`${context} Codex executable digest differs from config`);
    }
    if (value.executable.version !== config.codex_cli.version) {
      throw new Error(`${context} Codex CLI version differs from config`);
    }
    const ids = new Set(value.models.map((model) => model.id));
    for (const id of requiredModels) {
      if (!ids.has(id))
        throw new Error(`${context} Codex model/list lacks exact model ${id}`);
    }
  };
  assertToolchain(
    "container",
    attestation.containerCodex,
    config.codex_cli.container_sha256,
    [config.coding_agent.id]
  );
  assertToolchain("host", attestation.hostCodex, config.codex_cli.host_sha256, [
    config.memory_answer.model.id,
    config.lcm_summary.model.id,
    config.session_title.model.id,
    config.trajectory_judge.model.id
  ]);
};

export const loadExperienceReplayConfig = async (
  configPath: string
): Promise<ResolvedExperienceReplayConfig> => {
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  return resolveExperienceReplayConfig(parsed);
};

export const preflightExperienceReplay = async ({
  config,
  confirmPaidRun = false,
  requireRunnable = true,
  recordedRunAdapters,
  productPathReady = false,
  executionKind = "benchmark_profile",
  codexAuthMode = "api_key",
  oracleBriefSha256,
  oracleCorpusManifestSha256,
  oracleCorpusCollectionManifestSha256,
  oracleCampaignDefinitionSha256,
  oracleQualificationMaximumAttempts,
  oracleRepeats,
  campaignTaskDigests,
  campaignTaskUniverseDigests,
  campaignId,
  campaignShardId,
  campaignReferenceScore,
  persistedCampaignProtocol
}: {
  config: ResolvedExperienceReplayConfig;
  confirmPaidRun?: boolean;
  requireRunnable?: boolean;
  recordedRunAdapters?: RecordedRunPreflightAdapters;
  productPathReady?: boolean;
  executionKind?: ExperienceReplayExecutionKind;
  codexAuthMode?: ExperienceReplayCodexAuthMode;
  oracleBriefSha256?: string;
  oracleCorpusManifestSha256?: string;
  oracleCorpusCollectionManifestSha256?: string;
  oracleCampaignDefinitionSha256?: string;
  oracleQualificationMaximumAttempts?: number;
  oracleRepeats?: number;
  campaignTaskDigests?: readonly string[];
  campaignTaskUniverseDigests?: readonly string[];
  campaignId?: string;
  campaignShardId?: string;
  campaignReferenceScore?: number;
  persistedCampaignProtocol?: Readonly<OracleCampaignProtocol>;
}): Promise<PreflightResult> => {
  const repositoryRoot = await realpath(EXPERIENCE_REPLAY_REPOSITORY_ROOT);
  if (executionKind !== "benchmark_profile" && config.profile === "smoke") {
    throw new Error(
      "Product-path proof cannot use the deterministic smoke profile"
    );
  }
  const pins = await attestPinnedInputs(
    config.profile,
    executionKind,
    campaignTaskDigests,
    campaignTaskUniverseDigests ??
      persistedCampaignProtocol?.taskUniverseDigests
  );
  const selectedTaskDigests =
    config.profile === "smoke"
      ? [...SMOKE_TASK_DIGESTS]
      : pins.selectedTasks.map((task) => task.task_digest);
  const campaignProtocol =
    executionKind === "oracle_seeded_campaign"
      ? (persistedCampaignProtocol ??
        createOracleCampaignProtocol({
          campaignId: campaignId ?? "",
          campaignSeed: config.seed,
          taskUniverseDigests: campaignTaskUniverseDigests ?? [],
          semanticConfigHash: config.semantic_config_hash,
          memoryAnswerPromptVersion: config.memory_answer.prompt_version,
          mcpRecallPolicyVersion,
          concurrency: config.concurrency,
          pins: {
            harborCommit: HARBOR_COMMIT,
            terminalBenchCommit: TERMINAL_BENCH_COMMIT,
            corpusHash: pins.corpusHash,
            uvLockHash: pins.uvLockHash
          },
          referenceScore: campaignReferenceScore
        }))
      : undefined;
  if (executionKind === "oracle_seeded_campaign") {
    const expectedProtocol = createOracleCampaignProtocol({
      campaignId: campaignProtocol!.campaignId,
      campaignSeed: config.seed,
      taskUniverseDigests: campaignProtocol!.taskUniverseDigests,
      semanticConfigHash: config.semantic_config_hash,
      memoryAnswerPromptVersion: config.memory_answer.prompt_version,
      mcpRecallPolicyVersion,
      concurrency: config.concurrency,
      pins: {
        harborCommit: HARBOR_COMMIT,
        terminalBenchCommit: TERMINAL_BENCH_COMMIT,
        corpusHash: pins.corpusHash,
        uvLockHash: pins.uvLockHash
      },
      referenceScore: campaignProtocol!.referenceScore
    });
    if (expectedProtocol.protocolHash !== campaignProtocol!.protocolHash)
      throw new Error(
        "Persisted campaign protocol differs from current execution"
      );
    if (!campaignShardId)
      throw new Error("Oracle campaign shard identity is required");
  }
  const runPlan =
    executionKind === "product_path_proof"
      ? createProductPathProofRunPlan(
          config,
          {
            targetTaskDigest: selectedTaskDigests[0] ?? "",
            donorTaskDigest: selectedTaskDigests[1] ?? ""
          },
          codexAuthMode
        )
      : executionKind === "oracle_seeded_product_proof"
        ? createOracleSeededProductProofRunPlan(
            config,
            selectedTaskDigests[0] ?? "",
            oracleBriefSha256 ?? "",
            codexAuthMode
          )
        : executionKind === "oracle_seeded_repeated_study"
          ? createOracleSeededRepeatedStudyRunPlan(
              config,
              selectedTaskDigests[0] ?? "",
              oracleCorpusManifestSha256 ?? "",
              oracleRepeats ?? 10,
              codexAuthMode
            )
          : executionKind === "oracle_seeded_campaign"
            ? createOracleSeededCampaignRunPlan(
                config,
                selectedTaskDigests,
                oracleCorpusCollectionManifestSha256 ?? "",
                oracleCampaignDefinitionSha256 ?? "",
                campaignProtocol?.protocolHash ?? "",
                codexAuthMode
              )
            : executionKind === "oracle_corpus_qualification"
              ? createOracleCorpusQualificationRunPlan(
                  config,
                  selectedTaskDigests,
                  oracleCorpusManifestSha256 ?? "",
                  oracleQualificationMaximumAttempts ?? 0,
                  codexAuthMode
                )
              : createBenchmarkRunPlan(
                  config,
                  selectedTaskDigests,
                  codexAuthMode
                );
  verifyExperienceReplayRunPlan(runPlan);
  if (config.profile !== "smoke" && !confirmPaidRun) {
    throw new ProductPathPrerequisiteError([
      "paid run confirmation is required (--confirm-paid-run)"
    ]);
  }
  const estimatedCapacity = estimateRunCapacity({
    sourceAttempts:
      executionKind === "oracle_corpus_qualification"
        ? runPlan.codingAgentAttemptCount
        : executionKind === "oracle_seeded_repeated_study" ||
            executionKind === "oracle_seeded_campaign"
          ? 0
          : runPlan.sourceTaskDigests.length,
    replayAttempts:
      runPlan.replayTargetTaskDigests.length *
      (executionKind === "oracle_seeded_product_proof"
        ? 6
        : executionKind === "oracle_seeded_repeated_study"
          ? 4
          : executionKind === "oracle_seeded_campaign"
            ? 1
            : 4) *
      runPlan.replayAttemptsPerCondition,
    maximumTrajectoryBytes: config.admission.maximum_trajectory_bytes,
    estimatedAttemptArtifactBytes:
      config.admission.estimated_attempt_artifact_bytes,
    estimatedImageBytes:
      config.profile === "smoke"
        ? 0
        : runPlan.sourceTaskDigests.length *
          config.admission.estimated_image_bytes_per_task,
    scratchMultiplier: config.admission.scratch_multiplier,
    reserveBytes: config.admission.minimum_free_space_reserve_bytes,
    attemptDurationSeconds: {
      minimum: 1,
      maximum:
        config.timeouts.setup_seconds +
        (config.profile === "smoke"
          ? config.timeouts.agent_seconds + config.timeouts.verifier_seconds
          : Math.max(
              ...pins.selectedTasks.map(
                (task) =>
                  task.agent_timeout_seconds + task.verifier_timeout_seconds
              )
            )) +
        config.timeouts.preparation_seconds +
        config.timeouts.judge_seconds +
        config.timeouts.teardown_seconds
    },
    concurrency: config.concurrency
  });
  const outputAdmission = await SafeRunDirectory.create({
    outputPath: config.output_dir,
    repositoryRoot,
    requiredBytes: estimatedCapacity.requiredBytes,
    reserveBytes: estimatedCapacity.reserveBytes
  });
  const capacity: RunCapacityEstimate = {
    ...estimatedCapacity,
    availableBytes: outputAdmission.availableBytes
  };
  if (config.profile !== "smoke") {
    const status = recordedRunAdapters?.repositoryStatus
      ? await recordedRunAdapters.repositoryStatus(repositoryRoot)
      : (
          await executeBoundedCommand({
            file: "git",
            args: ["status", "--porcelain", "--untracked-files=normal"],
            cwd: repositoryRoot,
            timeoutMs: 30_000,
            maxOutputBytes: 1024 * 1024
          })
        ).stdout;
    const missing = [
      ...(status.trim()
        ? ["Koed worktree must be clean for a recorded run"]
        : []),
      ...(!recordedRunAdapters
        ? [
            "recorded-run image and host/container Codex attestation adapters are required"
          ]
        : []),
      ...(!productPathReady
        ? [
            "canonical Koed ingestion, semantic readiness, database templates, and isolated Harbor replay execution require a concrete runtime adapter"
          ]
        : [])
    ];
    if (missing.length && requireRunnable)
      throw new ProductPathPrerequisiteError(missing);
    let recordedRunAttestation: RecordedRunAttestation | null = null;
    if (!status.trim() && recordedRunAdapters) {
      recordedRunAttestation = {
        taskImages: await recordedRunAdapters.attestTaskImages(
          pins.selectedTasks
        ),
        hostCodex: await recordedRunAdapters.attestHostCodex(),
        containerCodex: await recordedRunAdapters.attestContainerCodex()
      };
      assertRecordedAttestation(
        config,
        pins.selectedTasks,
        recordedRunAttestation
      );
    }
    return {
      config,
      runPlan,
      pins,
      repositoryRoot,
      capacity,
      recordedModelPathReady: missing.length === 0,
      recordedRunAttestation,
      ...(campaignProtocol ? { campaignProtocol } : {}),
      ...(campaignShardId ? { campaignShardId } : {}),
      frozenTaskImages: Object.freeze(
        Object.fromEntries(
          (recordedRunAttestation?.taskImages ?? []).map((image) => [
            image.taskName,
            image.immutableReference
          ])
        )
      )
    };
  }
  return {
    config,
    runPlan,
    pins,
    repositoryRoot,
    capacity,
    recordedModelPathReady: true,
    recordedRunAttestation: null,
    ...(campaignProtocol ? { campaignProtocol } : {}),
    ...(campaignShardId ? { campaignShardId } : {}),
    frozenTaskImages: Object.freeze({})
  };
};
