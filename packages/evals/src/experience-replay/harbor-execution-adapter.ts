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

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
  };
  trial: {
    jobId: string;
    trialId: string;
    taskName: string;
    rewardField: "reward";
    reward: number;
    passed: boolean;
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
}

export interface HarborExecutionAdapterOptions {
  /** Smoke requires an executor; recorded mode always launches the locked runner. */
  mode: "smoke" | "recorded";
  corpusManifest: string;
  providerApiKey?: string;
  /** Preflight-approved immutable task image by canonical task name. */
  frozenTaskImages?: Readonly<Record<string, string>>;
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
}

export interface HarborReplayExecutionInput extends CommonExecutionInput {
  condition: ReplayCondition;
  repeat: number;
  executionGeneration: number;
  resultPath?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
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
    result.n_errored_trials !== 0 ||
    !Array.isArray(result.trials) ||
    result.trials.length !== 1
  )
    throw new Error("Harbor execution was not one successful isolated trial");
  const trial = exactRecord(
    result.trials[0],
    ["trial_id", "task_name", "primary_reward", "errored"],
    "Harbor trial result"
  );
  if (trial.task_name !== task.name || trial.errored !== false)
    throw new Error("Harbor trial identity or error state is invalid");
  const primary = exactRecord(
    trial.primary_reward,
    ["field", "value", "passed"],
    "Harbor primary reward"
  );
  const reward = primary.value;
  const usage = exactRecord(
    result.usage,
    ["input_tokens", "cached_input_tokens", "output_tokens", "cost_usd"],
    "Harbor usage"
  );
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
    primary.field !== "reward" ||
    typeof reward !== "number" ||
    !Number.isFinite(reward) ||
    reward < task.reward.minimum ||
    reward > task.reward.maximum ||
    typeof primary.passed !== "boolean" ||
    primary.passed !== (reward === task.reward.successValue)
  )
    throw new Error(
      "Harbor primary reward violates the CoordinatorTask contract"
    );

  const runtime = exactRecord(
    output.runtime,
    ["harbor_version", "harbor_commit", "uv_lock_sha256"],
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
      uvLockSha256
    },
    trial: {
      jobId: safeString(result.job_id, "Harbor job id"),
      trialId: safeString(trial.trial_id, "Harbor trial id"),
      taskName: task.name,
      rewardField: "reward",
      reward,
      passed: primary.passed,
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

const jobConfig = (
  input: CommonExecutionInput,
  jobName: string,
  condition: ReplayCondition,
  codex: ReturnType<typeof createTrialCodexConfiguration>
): Record<string, JsonValue> => ({
  job_name: jobName,
  quiet: true,
  retry: { max_retries: 0 },
  environment: { delete: true },
  verifier: {
    disable: false,
    override_timeout_sec: input.config.timeouts.verifier_seconds
  },
  agents: [
    {
      name: "codex",
      model_name: input.config.coding_agent.id,
      n_concurrent: 1,
      override_timeout_sec: input.config.timeouts.agent_seconds,
      extra_allowed_hosts: [
        ...(condition === "cold" ? [] : ["host.docker.internal"]),
        ...(input.config.profile === "smoke" ? [] : ["api.openai.com"])
      ],
      env: {
        ...(input.config.profile === "smoke"
          ? {}
          : { OPENAI_API_KEY: "${OPENAI_API_KEY}" }),
        ...(codex.agentEnvironment
          ? { KOED_BENCHMARK_MCP_TOKEN: "${KOED_BENCHMARK_MCP_TOKEN}" }
          : {})
      },
      kwargs: { config: codex.inline as JsonValue }
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
  const recallRan = identity.condition !== "cold";
  const evidenceCount =
    identity.condition === "placebo" || identity.condition === "relevant"
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
      queueMs: null
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
    environment: NodeJS.ProcessEnv
  ): HarborClient {
    const timeoutMs =
      (input.config.timeouts.setup_seconds +
        input.config.timeouts.agent_seconds +
        input.config.timeouts.verifier_seconds +
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
    bridgeToken?: string
  ) {
    return createTrialCodexConfiguration({
      condition,
      model: input.config.coding_agent.id,
      reasoningEffort: input.config.coding_agent.reasoning_effort,
      ...(bridgeUrl ? { bridgeUrl } : {}),
      ...(bridgeToken ? { bridgeToken } : {})
    });
  }

  async runSource(
    input: HarborSourceExecutionInput
  ): Promise<SourceAttemptExecution> {
    const codex = this.codex(input, "cold");
    const request: HarborRunRequest = {
      schema_version: "koed-harbor-run-v1",
      attempt_kind: "source",
      task_name: input.task.name,
      task_image: this.taskImage(input.task),
      job_config: jobConfig(
        input,
        `source-${safeJobPart(input.task.name)}-${input.executionGeneration}`,
        "cold",
        codex
      ),
      corpus_manifest: this.options.corpusManifest,
      run_root: input.runRoot,
      freeze_manifest_path: input.freezeManifestPath,
      freeze_trajectory_to: input.freezeTrajectoryPath
    };
    const output = await this.client(input, {
      ...(this.options.providerApiKey
        ? { OPENAI_API_KEY: this.options.providerApiKey }
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
      input.bridgeToken
    );
    const identity: AttemptTelemetryIdentity = {
      taskDigest: input.task.taskDigest,
      condition: input.condition,
      repeat: input.repeat
    };
    const request: HarborRunRequest = {
      schema_version: "koed-harbor-run-v1",
      attempt_kind: "replay",
      task_name: input.task.name,
      task_image: this.taskImage(input.task),
      job_config: jobConfig(
        input,
        `replay-${safeJobPart(input.task.name)}-${input.condition}-${input.repeat}-${input.executionGeneration}`,
        input.condition,
        codex
      ),
      corpus_manifest: this.options.corpusManifest,
      run_root: input.runRoot,
      ...(input.resultPath ? { result_path: input.resultPath } : {})
    };
    const output = await this.client(input, {
      ...(this.options.providerApiKey
        ? { OPENAI_API_KEY: this.options.providerApiKey }
        : {}),
      ...(codex.agentEnvironment ?? {})
    }).run(request, input.signal);
    const captured = extractCapturedResult(
      output,
      input.task,
      "replay",
      sha256(codex.serialized)
    );
    const observers =
      this.options.mode === "smoke"
        ? createDeterministicSmokeTelemetry(identity)
        : await this.options.collectReplayTelemetry?.({ identity, captured });
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
        failureCategory: null,
        failureKind: null,
        failurePhase: null
      }),
      ...observers
    };
    assertCompleteReplayTelemetry(telemetry);
    return {
      result: captured,
      telemetry
    };
  }
}
