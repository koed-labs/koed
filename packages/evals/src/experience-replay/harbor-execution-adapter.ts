import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarborFreezeManifest } from "./atif/index.js";
import { createTrialCodexConfiguration } from "./codex-config.js";
import type { CoordinatorTask, SourceAttemptExecution } from "./coordinator.js";
import type {
  ReplayCondition,
  ResolvedExperienceReplayConfig
} from "./core/index.js";
import { conditionUsesKoed } from "./core/index.js";
import {
  HarborClient,
  HarborClientError,
  type HarborClientOptions,
  type HarborRunRequest,
  type HarborRunResult,
  type JsonValue,
  type SubprocessExecutor
} from "./harbor-client.js";
import type { HarborLifecycleCallbacks } from "./harbor-lifecycle.js";
import type {
  AttemptTelemetryIdentity,
  ReplayTelemetryMergeInput,
  TelemetryEnvelope
} from "./telemetry.js";
import { assertCompleteReplayTelemetry } from "./telemetry.js";

const sha256 = (value: string | Buffer): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TASK_INSTRUCTION_POLICY = "koed-memory-eval-task-instruction-v2";

type NonHarborTelemetry = Omit<
  ReplayTelemetryMergeInput,
  "identity" | "harbor"
>;

export interface CapturedHarborExecutionResult {
  schemaVersion: "koed-harbor-execution-capture-v1";
  attemptKind: "source" | "replay";
  jobLockSha256: string;
  freezeManifestSha256?: string;
  runtime: {
    harborVersion: string | null;
    harborCommit: string | null;
    uvLockSha256: string | null;
    taskInstructionAdaptation: {
      policy: string;
      originalSha256: string;
      adaptedSha256: string;
      agentGuidanceSha256: string;
    };
  };
  trial: {
    jobId: string;
    trialId: string;
    taskName: string;
    rewardField: "reward";
    reward: number | null;
    passed: boolean;
    failureCategory: string | null;
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      costUsd: number;
    };
    phaseTimings: {
      setupMs: number;
      agentMs: number;
      verifierMs: number;
    };
    interactions: { turns: number; toolCalls: number };
  };
  codexConfigSha256: string;
}

export interface HarborReplayExecution {
  telemetry: ReplayTelemetryMergeInput;
  result: CapturedHarborExecutionResult;
  replayTrajectoryArtifact?: {
    path: string;
    sha256: string;
    freezeManifest: HarborFreezeManifest;
  };
}

export interface HarborExecutionAdapterOptions {
  /** Smoke requires an executor; recorded mode always launches the locked runner. */
  mode: "smoke" | "recorded";
  corpusManifest: string;
  providerApiKey?: string;
  /** Host subscription credential uploaded by Harbor into each ephemeral trial. */
  codexAuthJsonPath?: string;
  /** Preflight-approved Linux Codex binary uploaded into each Harbor trial. */
  containerCodexBinary?: string;
  /** Preflight-approved immutable task image by canonical task name. */
  frozenTaskImages?: Readonly<Record<string, string>>;
  /** Requires one real relevant-arm recall only for the non-estimate proof. */
  productPathProof?: boolean;
  executor?: SubprocessExecutor;
  harborProject?: string;
  uvExecutable?: string;
  requestId?: () => string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  lifecycleEventTimeoutMs?: number;
  collectReplayTelemetry?: (input: {
    identity: AttemptTelemetryIdentity;
    captured: CapturedHarborExecutionResult;
  }) => Promise<NonHarborTelemetry> | NonHarborTelemetry;
}

interface CommonExecutionInput {
  task: CoordinatorTask;
  runRoot: string;
  lifecycle: HarborLifecycleCallbacks;
  config: ResolvedExperienceReplayConfig;
  signal?: AbortSignal;
}

export interface HarborSourceExecutionInput extends CommonExecutionInput {
  attemptId: string;
  executionGeneration: number;
  freezeTrajectoryPath: string;
  freezeManifestPath: string;
  sanitizedTokenQuartile: 0 | 1 | 2 | 3;
  developerInstructions?: string;
}

export interface HarborReplayExecutionInput extends CommonExecutionInput {
  condition: ReplayCondition;
  repeat: number;
  executionGeneration: number;
  resultPath?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  developerInstructions?: string;
  requireMemoryAnswer?: boolean;
}

const exactRecord = (
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    throw new Error(`${label} has an invalid shape`);
  return result;
};

const safeString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SAFE_ID.test(value))
    throw new Error(`${label} is invalid`);
  return value;
};

const extractCapturedResult = (
  output: HarborRunResult,
  task: CoordinatorTask,
  attemptKind: "source" | "replay",
  codexConfigSha256: string
): CapturedHarborExecutionResult => {
  if (!SHA256.test(output.job_lock_sha256))
    throw new Error("Harbor result has an invalid job lock digest");
  if (
    attemptKind === "source" &&
    (!("freeze_manifest_sha256" in output) ||
      typeof output.freeze_manifest_sha256 !== "string" ||
      !SHA256.test(output.freeze_manifest_sha256))
  )
    throw new Error(
      "Harbor source result has an invalid freeze manifest digest"
    );
  if (
    attemptKind === "replay" &&
    (!("replay_trajectory_sha256" in output) ||
      typeof output.replay_trajectory_sha256 !== "string" ||
      !SHA256.test(output.replay_trajectory_sha256))
  )
    throw new Error("Harbor replay result has an invalid trajectory digest");

  const result = exactRecord(
    output.result,
    [
      "job_id",
      "n_total_trials",
      "n_completed_trials",
      "n_errored_trials",
      "phase_timings",
      "interactions",
      "usage",
      "trials"
    ],
    "Harbor result"
  );
  if (
    result.n_total_trials !== 1 ||
    result.n_completed_trials !== 1 ||
    ![0, 1].includes(result.n_errored_trials as number) ||
    !Array.isArray(result.trials) ||
    result.trials.length !== 1
  )
    throw new Error("Harbor execution was not one completed isolated trial");
  const trial = exactRecord(
    result.trials[0],
    ["trial_id", "task_name", "primary_reward", "errored", "failure_category"],
    "Harbor trial result"
  );
  if (
    trial.task_name !== task.name ||
    typeof trial.errored !== "boolean" ||
    result.n_errored_trials !== (trial.errored ? 1 : 0)
  )
    throw new Error("Harbor trial identity or error count is invalid");
  const primary = exactRecord(
    trial.primary_reward,
    ["field", "value", "passed"],
    "Harbor primary reward"
  );
  const reward = primary.value;
  const failureCategory = trial.failure_category;
  const validFailureCategory = [
    "agent_failed",
    "agent_timeout",
    "verifier_failed",
    "verifier_timeout",
    "other"
  ].includes(failureCategory as string);
  if (
    primary.field !== "reward" ||
    typeof primary.passed !== "boolean" ||
    (trial.errored &&
      (reward !== null || primary.passed || !validFailureCategory))
  )
    throw new Error(
      "Harbor primary reward violates the CoordinatorTask contract"
    );
  const usage = exactRecord(
    result.usage,
    ["input_tokens", "cached_input_tokens", "output_tokens", "cost_usd"],
    "Harbor usage"
  );
  if (
    trial.errored &&
    Object.values(usage).some((value) => typeof value !== "number")
  ) {
    const contractCode = String(failureCategory).toUpperCase();
    throw new HarborClientError(
      "process-exit",
      `Harbor trial failed before complete telemetry: ${contractCode}`,
      { contractCode }
    );
  }
  const phaseTimings = exactRecord(
    result.phase_timings,
    ["setup_ms", "agent_ms", "verifier_ms"],
    "Harbor phase timings"
  );
  const interactions = exactRecord(
    result.interactions,
    ["turns", "tool_calls"],
    "Harbor ATIF interactions"
  );
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error(`Harbor usage ${key} is invalid`);
  }
  for (const [key, value] of Object.entries(phaseTimings)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error(`Harbor phase timing ${key} is invalid`);
  }
  for (const [key, value] of Object.entries(interactions)) {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new Error(`Harbor ATIF interaction ${key} is invalid`);
  }
  if (
    !trial.errored &&
    (typeof reward !== "number" ||
      !Number.isFinite(reward) ||
      reward < task.reward.minimum ||
      reward > task.reward.maximum ||
      primary.passed !== (reward === task.reward.successValue) ||
      failureCategory !== null)
  )
    throw new Error(
      "Harbor primary reward violates the CoordinatorTask contract"
    );

  const runtime = exactRecord(
    output.runtime,
    [
      "harbor_version",
      "harbor_commit",
      "uv_lock_sha256",
      "task_instruction_adaptation"
    ],
    "Harbor runtime attestation"
  );
  const nullableRuntimeString = (key: string): string | null => {
    const value = runtime[key];
    if (value === undefined || value === null) return null;
    if (
      typeof value !== "string" ||
      value.length > 256 ||
      /[\0\r\n]/u.test(value)
    )
      throw new Error(`Harbor runtime ${key} is invalid`);
    return value;
  };
  const uvLockSha256 = nullableRuntimeString("uv_lock_sha256");
  if (uvLockSha256 !== null && !SHA256.test(uvLockSha256))
    throw new Error("Harbor runtime uv lock digest is invalid");
  const taskInstructionAdaptation = exactRecord(
    runtime.task_instruction_adaptation,
    ["policy", "original_sha256", "adapted_sha256", "agent_guidance_sha256"],
    "Harbor task instruction adaptation"
  );
  const instructionPolicy = safeString(
    taskInstructionAdaptation.policy,
    "Harbor task instruction adaptation policy"
  );
  if (instructionPolicy !== TASK_INSTRUCTION_POLICY)
    throw new Error("Harbor task instruction adaptation policy is unsupported");
  const instructionDigest = (key: string): string => {
    const value = taskInstructionAdaptation[key];
    if (typeof value !== "string" || !SHA256.test(value))
      throw new Error(`Harbor task instruction adaptation ${key} is invalid`);
    return value;
  };

  return {
    schemaVersion: "koed-harbor-execution-capture-v1",
    attemptKind,
    jobLockSha256: output.job_lock_sha256,
    ...("freeze_manifest_sha256" in output
      ? { freezeManifestSha256: output.freeze_manifest_sha256 }
      : {}),
    runtime: {
      harborVersion: nullableRuntimeString("harbor_version"),
      harborCommit: nullableRuntimeString("harbor_commit"),
      uvLockSha256,
      taskInstructionAdaptation: {
        policy: instructionPolicy,
        originalSha256: instructionDigest("original_sha256"),
        adaptedSha256: instructionDigest("adapted_sha256"),
        agentGuidanceSha256: instructionDigest("agent_guidance_sha256")
      }
    },
    trial: {
      jobId: safeString(result.job_id, "Harbor job id"),
      trialId: safeString(trial.trial_id, "Harbor trial id"),
      taskName: task.name,
      rewardField: "reward",
      reward: reward as number | null,
      passed: primary.passed,
      failureCategory: failureCategory as string | null,
      usage: {
        inputTokens: usage.input_tokens as number,
        cachedInputTokens: usage.cached_input_tokens as number,
        outputTokens: usage.output_tokens as number,
        costUsd: usage.cost_usd as number
      },
      phaseTimings: {
        setupMs: phaseTimings.setup_ms as number,
        agentMs: phaseTimings.agent_ms as number,
        verifierMs: phaseTimings.verifier_ms as number
      },
      interactions: {
        turns: interactions.turns as number,
        toolCalls: interactions.tool_calls as number
      }
    },
    codexConfigSha256
  };
};

const safeJobPart = (value: string): string =>
  value.replace(/^terminal-bench\//u, "").replace(/[^A-Za-z0-9._-]/gu, "-");

export const recordedCodexAllowedHosts = (
  authentication: "api_key" | "subscription"
): readonly string[] =>
  authentication === "api_key"
    ? ["api.openai.com"]
    : ["chatgpt.com", "auth.openai.com"];

export const createHarborJobConfig = (
  input: CommonExecutionInput,
  jobName: string,
  condition: ReplayCondition,
  codex: ReturnType<typeof createTrialCodexConfiguration>,
  authentication: "api_key" | "subscription",
  mode: "smoke" | "recorded"
): Record<string, JsonValue> => ({
  job_name: jobName,
  quiet: true,
  retry: { max_retries: 0 },
  environment: { delete: true },
  verifier: {
    disable: false,
    ...(mode === "smoke"
      ? { override_timeout_sec: input.config.timeouts.verifier_seconds }
      : {})
  },
  agents: [
    {
      name: "codex",
      model_name: input.config.coding_agent.id,
      n_concurrent: 1,
      ...(mode === "smoke"
        ? { override_timeout_sec: input.config.timeouts.agent_seconds }
        : {}),
      extra_allowed_hosts: [
        ...(!conditionUsesKoed(condition)
          ? []
          : [
              new URL(
                (codex.inline.mcp_servers as { koed: { url: string } }).koed.url
              ).hostname
            ]),
        ...(input.config.profile === "smoke"
          ? []
          : recordedCodexAllowedHosts(authentication))
      ],
      env: {
        ...(input.config.profile === "smoke" || authentication !== "api_key"
          ? {}
          : { OPENAI_API_KEY: "${OPENAI_API_KEY}" }),
        ...(codex.agentEnvironment
          ? { KOED_BENCHMARK_MCP_TOKEN: "${KOED_BENCHMARK_MCP_TOKEN}" }
          : {})
      },
      kwargs: {
        config: codex.inline as JsonValue,
        version: input.config.codex_cli.version
      }
    }
  ]
});

const available = (
  identity: AttemptTelemetryIdentity,
  metrics: Record<string, unknown>
): TelemetryEnvelope => ({ identity, status: "available", metrics });

const inactiveWorkerTelemetry = {
  calls: 0,
  failures: 0,
  durationMs: 0,
  tokens: { uncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 },
  costs: { providerBilledUsd: 0, apiEquivalentUsd: 0, subscriptionUsd: 0 }
};

/** Complete, zero-cost observer output for deterministic smoke executions. */
export const createDeterministicSmokeTelemetry = (
  identity: AttemptTelemetryIdentity
): NonHarborTelemetry => {
  const recallRan = conditionUsesKoed(identity.condition);
  const evidenceCount =
    identity.condition === "placebo" ||
    identity.condition === "relevant" ||
    identity.condition === "irrelevant" ||
    identity.condition.startsWith("relevant_")
      ? 1
      : 0;
  return {
    codex: available(identity, {
      tokens: { uncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 },
      costs: {
        providerBilledUsd: 0,
        apiEquivalentUsd: 0,
        subscriptionUsd: 0
      },
      turns: 1,
      toolCalls: recallRan ? 1 : 0,
      toolFailures: 0,
      mcpCalls: recallRan ? 1 : 0,
      mcpFailures: 0,
      memoryAnswerCalls: recallRan ? 1 : 0,
      memoryAnswerFailures: 0
    }),
    koedRecall: available(identity, {
      searches: recallRan ? 1 : 0,
      expansions: 0,
      stages: recallRan ? 1 : 0,
      evidenceCount,
      projectionMs: null,
      lcmMs: null,
      queueMs: null,
      memoryAnswerRequests: recallRan
        ? [{ responseDetail: "answer_only", searchDomain: "project" }]
        : []
    }),
    modelWorkflows: available(identity, {
      // Smoke exercises the contract with a deterministic executor, not an LLM.
      memoryAnswer: inactiveWorkerTelemetry,
      lcmSummary: inactiveWorkerTelemetry,
      sessionTitle: inactiveWorkerTelemetry
    }),
    embeddings: available(identity, {
      calls: 0,
      tokens: 0,
      durationMs: 0
    }),
    processRss: available(identity, {
      apiBytes: null,
      runtimeBytes: null,
      workerBytes: null
    })
  };
};

export class HarborExecutionAdapter {
  constructor(private readonly options: HarborExecutionAdapterOptions) {
    if (!path.isAbsolute(options.corpusManifest))
      throw new Error("Harbor corpus manifest path must be absolute");
    if (options.mode === "smoke" && !options.executor)
      throw new Error(
        "Deterministic smoke requires an injected subprocess executor"
      );
    if (options.mode === "recorded" && options.executor)
      throw new Error(
        "Recorded mode cannot replace the real Harbor subprocess executor"
      );
    if (options.mode === "recorded" && !options.frozenTaskImages)
      throw new Error("Recorded mode requires preflight-approved task images");
    if (
      options.mode === "recorded" &&
      Boolean(options.providerApiKey) === Boolean(options.codexAuthJsonPath)
    )
      throw new Error(
        "Recorded mode requires exactly one Codex authentication source"
      );
    if (
      options.mode === "recorded" &&
      !path.isAbsolute(options.containerCodexBinary ?? "")
    ) {
      throw new Error(
        "Recorded mode requires an absolute pinned container Codex binary"
      );
    }
  }

  private taskImage(task: CoordinatorTask): string {
    if (this.options.mode === "smoke")
      return `koed.invalid/${safeJobPart(task.name)}@sha256:${"0".repeat(64)}`;
    const image = this.options.frozenTaskImages?.[task.name];
    if (!image)
      throw new Error(`No preflight-approved task image for ${task.name}`);
    return image;
  }

  private client(
    input: CommonExecutionInput,
    task: CoordinatorTask,
    environment: NodeJS.ProcessEnv
  ): HarborClient {
    const timeoutMs =
      (input.config.timeouts.setup_seconds +
        (this.options.mode === "smoke"
          ? input.config.timeouts.agent_seconds +
            input.config.timeouts.verifier_seconds
          : task.agentTimeoutSeconds + task.verifierTimeoutSeconds) +
        input.config.timeouts.teardown_seconds) *
      1_000;
    const clientOptions: HarborClientOptions = {
      environment,
      timeoutMs,
      lifecycle: input.lifecycle,
      ...(this.options.executor ? { executor: this.options.executor } : {}),
      ...(this.options.harborProject
        ? { harborProject: this.options.harborProject }
        : {}),
      ...(this.options.uvExecutable
        ? { uvExecutable: this.options.uvExecutable }
        : {}),
      ...(this.options.requestId ? { requestId: this.options.requestId } : {}),
      ...(this.options.maxStdoutBytes
        ? { maxStdoutBytes: this.options.maxStdoutBytes }
        : {}),
      ...(this.options.maxStderrBytes
        ? { maxStderrBytes: this.options.maxStderrBytes }
        : {}),
      ...(this.options.lifecycleEventTimeoutMs
        ? { lifecycleEventTimeoutMs: this.options.lifecycleEventTimeoutMs }
        : {})
    };
    return new HarborClient(clientOptions);
  }

  private codex(
    input: CommonExecutionInput,
    condition: ReplayCondition,
    bridgeUrl?: string,
    bridgeToken?: string,
    developerInstructions?: string,
    requireMemoryAnswer = false
  ) {
    return createTrialCodexConfiguration({
      condition,
      model: input.config.coding_agent.id,
      reasoningEffort: input.config.coding_agent.reasoning_effort,
      requireMemoryAnswer:
        requireMemoryAnswer ||
        (this.options.productPathProof === true &&
          (condition === "relevant" || condition.startsWith("relevant_"))),
      ...(bridgeUrl ? { bridgeUrl } : {}),
      ...(bridgeToken ? { bridgeToken } : {}),
      ...(developerInstructions ? { developerInstructions } : {})
    });
  }

  async runSource(
    input: HarborSourceExecutionInput
  ): Promise<SourceAttemptExecution> {
    const codex = this.codex(
      input,
      "cold",
      undefined,
      undefined,
      input.developerInstructions
    );
    const request: HarborRunRequest = {
      schema_version: "koed-harbor-run-v1",
      attempt_kind: "source",
      task_name: input.task.name,
      task_image: this.taskImage(input.task),
      codex_version: input.config.codex_cli.version,
      codex_binary_sha256: `sha256:${input.config.codex_cli.container_sha256}`,
      codex_code_mode_host_sha256: `sha256:${input.config.codex_cli.container_code_mode_host_sha256}`,
      job_config: createHarborJobConfig(
        input,
        `source-${safeJobPart(input.task.name)}-${input.executionGeneration}`,
        "cold",
        codex,
        this.options.codexAuthJsonPath ? "subscription" : "api_key",
        this.options.mode
      ),
      corpus_manifest: this.options.corpusManifest,
      run_root: input.runRoot,
      result_path: `harbor-results/source-${safeJobPart(input.task.name)}-${input.executionGeneration}.json`,
      freeze_manifest_path: input.freezeManifestPath,
      freeze_trajectory_to: input.freezeTrajectoryPath,
      ...(input.developerInstructions
        ? {
            developer_instructions_sha256: createHash("sha256")
              .update(input.developerInstructions)
              .digest("hex")
          }
        : {})
    };
    const output = await this.client(input, input.task, {
      ...(this.options.providerApiKey
        ? { OPENAI_API_KEY: this.options.providerApiKey }
        : {}),
      ...(this.options.codexAuthJsonPath
        ? { CODEX_AUTH_JSON_PATH: this.options.codexAuthJsonPath }
        : {}),
      ...(this.options.containerCodexBinary
        ? { KOED_HARBOR_CODEX_BINARY: this.options.containerCodexBinary }
        : {})
    }).run(request, input.signal);
    const captured = extractCapturedResult(
      output,
      input.task,
      "source",
      sha256(codex.serialized)
    );
    const [frozenTrajectory, manifestText] = await Promise.all([
      readFile(path.join(input.runRoot, input.freezeTrajectoryPath), "utf8"),
      readFile(path.join(input.runRoot, input.freezeManifestPath), "utf8")
    ]);
    if (sha256(manifestText) !== captured.freezeManifestSha256)
      throw new Error(
        "Frozen source manifest differs from the Harbor result digest"
      );
    const freezeManifest = JSON.parse(manifestText) as HarborFreezeManifest;
    if (
      freezeManifest?.schema_version !== "koed-harbor-freeze-v1" ||
      freezeManifest.source_attempt?.task_name !== input.task.name ||
      freezeManifest.frozen_artifact?.sha256 !== sha256(frozenTrajectory)
    )
      throw new Error(
        "Frozen source artifacts do not match their Harbor manifest"
      );
    return {
      frozenTrajectory,
      freezeManifest,
      reward: captured.trial.reward,
      passed: captured.trial.passed,
      failureCategory: captured.trial.failureCategory,
      costUsd: captured.trial.usage.costUsd,
      sanitizedTokenQuartile: input.sanitizedTokenQuartile,
      result: captured as unknown as Record<string, unknown>
    };
  }

  async runReplay(
    input: HarborReplayExecutionInput
  ): Promise<HarborReplayExecution> {
    const codex = this.codex(
      input,
      input.condition,
      input.bridgeUrl,
      input.bridgeToken,
      input.developerInstructions,
      input.requireMemoryAnswer
    );
    const identity: AttemptTelemetryIdentity = {
      taskDigest: input.task.taskDigest,
      condition: input.condition,
      repeat: input.repeat
    };
    const replayTrajectoryPath = `harbor-replay-trajectories/${safeJobPart(input.task.name)}-${input.condition}-${input.repeat}-${input.executionGeneration}.atif.json`;
    const replayManifestPath = `harbor-replay-trajectories/${safeJobPart(input.task.name)}-${input.condition}-${input.repeat}-${input.executionGeneration}.freeze-manifest.json`;
    const request: HarborRunRequest = {
      schema_version: "koed-harbor-run-v1",
      attempt_kind: "replay",
      task_name: input.task.name,
      task_image: this.taskImage(input.task),
      codex_version: input.config.codex_cli.version,
      codex_binary_sha256: `sha256:${input.config.codex_cli.container_sha256}`,
      codex_code_mode_host_sha256: `sha256:${input.config.codex_cli.container_code_mode_host_sha256}`,
      job_config: createHarborJobConfig(
        input,
        `replay-${safeJobPart(input.task.name)}-${input.condition}-${input.repeat}-${input.executionGeneration}`,
        input.condition,
        codex,
        this.options.codexAuthJsonPath ? "subscription" : "api_key",
        this.options.mode
      ),
      corpus_manifest: this.options.corpusManifest,
      run_root: input.runRoot,
      replay_trajectory_path: replayTrajectoryPath,
      freeze_manifest_path: replayManifestPath,
      result_path:
        input.resultPath ??
        `harbor-results/replay-${safeJobPart(input.task.name)}-${input.condition}-${input.repeat}-${input.executionGeneration}.json`,
      ...(input.developerInstructions
        ? {
            developer_instructions_sha256: createHash("sha256")
              .update(input.developerInstructions)
              .digest("hex")
          }
        : {})
    };
    const output = await this.client(input, input.task, {
      ...(this.options.providerApiKey
        ? { OPENAI_API_KEY: this.options.providerApiKey }
        : {}),
      ...(this.options.codexAuthJsonPath
        ? { CODEX_AUTH_JSON_PATH: this.options.codexAuthJsonPath }
        : {}),
      ...(this.options.containerCodexBinary
        ? { KOED_HARBOR_CODEX_BINARY: this.options.containerCodexBinary }
        : {}),
      ...(codex.agentEnvironment ?? {})
    }).run(request, input.signal);
    const captured = extractCapturedResult(
      output,
      input.task,
      "replay",
      sha256(codex.serialized)
    );
    if (!("replay_trajectory_sha256" in output))
      throw new Error("Harbor replay result has no trajectory digest");
    const replayTrajectorySha256 = output.replay_trajectory_sha256;
    let replayTrajectory: Buffer;
    try {
      replayTrajectory = await readFile(
        path.join(input.runRoot, replayTrajectoryPath)
      );
    } catch (error) {
      throw new HarborClientError(
        "invalid-output",
        "Harbor replay trajectory artifact is missing",
        { cause: error }
      );
    }
    if (sha256(replayTrajectory) !== replayTrajectorySha256)
      throw new HarborClientError(
        "invalid-output",
        "Harbor replay trajectory artifact differs from its attested digest"
      );
    let replayFreezeManifest: HarborFreezeManifest;
    try {
      const rawManifest = await readFile(
        path.join(input.runRoot, replayManifestPath)
      );
      if (sha256(rawManifest) !== output.freeze_manifest_sha256)
        throw new Error("digest mismatch");
      replayFreezeManifest = JSON.parse(
        rawManifest.toString("utf8")
      ) as HarborFreezeManifest;
    } catch (error) {
      throw new HarborClientError(
        "invalid-output",
        "Harbor replay freeze manifest is missing or invalid",
        { cause: error }
      );
    }
    let observers;
    try {
      observers =
        this.options.mode === "smoke"
          ? createDeterministicSmokeTelemetry(identity)
          : await this.options.collectReplayTelemetry?.({ identity, captured });
    } catch (error) {
      throw new HarborClientError(
        "invalid-output",
        "Recorded replay telemetry collection failed",
        { cause: error, contractCode: "REPLAY_TELEMETRY_COLLECTION_FAILED" }
      );
    }
    if (!observers)
      throw new HarborClientError(
        "invalid-output",
        "Recorded replay requires complete non-Harbor telemetry collectors"
      );
    const telemetry: ReplayTelemetryMergeInput = {
      identity,
      harbor: available(identity, {
        reward: captured.trial.reward,
        passed: captured.trial.passed,
        setupMs: captured.trial.phaseTimings.setupMs,
        agentMs: captured.trial.phaseTimings.agentMs,
        verifierMs: captured.trial.phaseTimings.verifierMs,
        failureCategory: captured.trial.failureCategory,
        failureKind: captured.trial.failureCategory
          ? captured.trial.failureCategory.startsWith("agent")
            ? "agent"
            : "infrastructure"
          : null,
        failurePhase: captured.trial.failureCategory
          ? captured.trial.failureCategory.startsWith("agent")
            ? "agent"
            : "verifier"
          : null
      }),
      ...observers
    };
    assertCompleteReplayTelemetry(telemetry);
    return {
      result: captured,
      telemetry,
      replayTrajectoryArtifact: {
        path: replayTrajectoryPath,
        sha256: replayTrajectorySha256,
        freezeManifest: replayFreezeManifest
      }
    };
  }
}
