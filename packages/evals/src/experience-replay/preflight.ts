import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  immutableHash,
  sha256,
  resolveExperienceReplayConfig,
  type ResolvedExperienceReplayConfig
} from "./core/index.js";
import {
  estimateRunCapacity,
  SafeRunDirectory,
  type RunCapacityEstimate
} from "./output-path.js";

const execFileAsync = promisify(execFile);
export const HARBOR_COMMIT = "64afbbcb62165950301e1a6407c729aa26d844ff";
export const HARBOR_VERSION = "0.21.0";
export const TERMINAL_BENCH_COMMIT = "2b0442c3c583b710ca8da14c8e601b99f2f1f244";
export const TERMINAL_BENCH_VERSION = "v3.0.0";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
export const EXPERIENCE_REPLAY_REPOSITORY_ROOT = path.resolve(
  sourceRoot,
  "../../../.."
);
const benchmarkSourceRoot = path.join(
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
  profile: ResolvedExperienceReplayConfig["profile"]
): Promise<PinnedInputsAttestation> => {
  const corpusPath = path.join(benchmarkSourceRoot, "fixtures/tb3-v3.0.0.json");
  const corpusText = await readFile(corpusPath, "utf8");
  const corpus = JSON.parse(corpusText) as CorpusManifest;
  if (
    corpus.schema_version !== "koed-terminal-bench-corpus-v1" ||
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
    path.join(benchmarkSourceRoot, "harbor/uv.lock"),
    "utf8"
  );
  const pyproject = await readFile(
    path.join(benchmarkSourceRoot, "harbor/pyproject.toml"),
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
  let selectedTasks = corpus.tasks;
  let subsetHash: string | null = null;
  if (profile === "quick" || profile === "standard") {
    const subset = await readJson<SubsetManifest>(
      path.join(
        benchmarkSourceRoot,
        `fixtures/${profile === "quick" ? "quick-12" : "standard-24"}.json`
      )
    );
    const expectedCount = profile === "quick" ? 12 : 24;
    if (
      subset.schema_version !== "koed-terminal-bench-subset-v1" ||
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
  pins: PinnedInputsAttestation;
  repositoryRoot: string;
  capacity: RunCapacityEstimate;
  recordedModelPathReady: boolean;
}

export const loadExperienceReplayConfig = async (
  configPath: string
): Promise<ResolvedExperienceReplayConfig> => {
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  return resolveExperienceReplayConfig(parsed);
};

export const preflightExperienceReplay = async ({
  config,
  confirmPaidRun = false,
  requireRunnable = true
}: {
  config: ResolvedExperienceReplayConfig;
  confirmPaidRun?: boolean;
  requireRunnable?: boolean;
}): Promise<PreflightResult> => {
  const repositoryRoot = await realpath(EXPERIENCE_REPLAY_REPOSITORY_ROOT);
  const pins = await attestPinnedInputs(config.profile);
  const estimatedCapacity = estimateRunCapacity({
    sourceAttempts: config.task_count,
    replayAttempts:
      config.task_count * 4 * config.replay_attempts_per_condition,
    maximumTrajectoryBytes: config.admission.maximum_trajectory_bytes,
    estimatedAttemptArtifactBytes:
      config.admission.estimated_attempt_artifact_bytes,
    estimatedImageBytes:
      config.profile === "smoke"
        ? 0
        : config.task_count * config.admission.estimated_image_bytes_per_task,
    scratchMultiplier: config.admission.scratch_multiplier,
    reserveBytes: config.admission.minimum_free_space_reserve_bytes,
    attemptDurationSeconds: {
      minimum: 1,
      maximum:
        config.timeouts.setup_seconds +
        config.timeouts.agent_seconds +
        config.timeouts.verifier_seconds +
        config.timeouts.preparation_seconds +
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
    if (!confirmPaidRun) {
      throw new ProductPathPrerequisiteError([
        "paid run confirmation is required (--confirm-paid-run)"
      ]);
    }
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repositoryRoot
    });
    const missing = [
      ...(stdout.trim() ? ["Koed worktree must be clean"] : []),
      "immutable Harbor image build/attestation adapter is not wired into the coordinator",
      "host/container Codex model-list and executable attestations are not wired",
      "canonical Koed ingestion, semantic readiness, and database template lifecycle are not wired",
      "real isolated Harbor replay execution is not wired"
    ];
    if (requireRunnable) throw new ProductPathPrerequisiteError(missing);
    return {
      config,
      pins,
      repositoryRoot,
      capacity,
      recordedModelPathReady: false
    };
  }
  return {
    config,
    pins,
    repositoryRoot,
    capacity,
    recordedModelPathReady: true
  };
};
