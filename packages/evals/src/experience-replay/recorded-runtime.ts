import { countTokensForModel } from "@koed/core";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import type { ExperienceReplayCodexAuthMode } from "./core/index.js";
import { resolveRecordedCodexAuthentication } from "./codex-auth.js";
import { createExperienceReplayCoordinatorDependencies } from "./coordinator-dependencies.js";
import type { LocalProductTemplateHandle } from "./local-product-adapter.js";
import {
  EXPERIENCE_REPLAY_REPOSITORY_ROOT,
  ProductPathPrerequisiteError
} from "./preflight.js";
import { createRecordedLcmJobRunner } from "./recorded-runtime-lcm.js";
import { createRecordedReplayTelemetryCollector } from "./recorded-runtime-telemetry.js";
import { runTrajectoryJudge } from "./trajectory-judge.js";

const required = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string
): string => {
  const value = environment[name]?.trim();
  if (!value || /[\0\r\n]/u.test(value)) {
    throw new ProductPathPrerequisiteError([`${name} is required`]);
  }
  return value;
};

const priceForPreparation = (
  template: LocalProductTemplateHandle,
  config: ResolvedExperienceReplayConfig
): number => {
  const usage =
    template.attestation.campaignScheduledLcmJobs ??
    template.attestation.scheduledLcmJobs;
  if (!usage) return 0;
  const price = config.price_table.models[config.lcm_summary.model.id];
  if (!price) throw new Error("Recorded LCM model has no price entry");
  return (
    (usage.inputTokens * price.uncached_input_usd_per_million +
      usage.outputTokens * price.output_usd_per_million) /
    1_000_000
  );
};

const cleanRepositoryCommit = (): string => {
  for (const args of [
    ["diff", "--quiet", "--"],
    ["diff", "--cached", "--quiet", "--"]
  ]) {
    const result = spawnSync("git", args, {
      cwd: EXPERIENCE_REPLAY_REPOSITORY_ROOT,
      stdio: "ignore"
    });
    if (result.error || result.status === null || result.status > 1) {
      throw new ProductPathPrerequisiteError([
        "Git could not attest the tracked Koed source state"
      ]);
    }
    if (result.status === 1) {
      throw new ProductPathPrerequisiteError([
        "Recorded runs require a clean tracked Koed source state"
      ]);
    }
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: EXPERIENCE_REPLAY_REPOSITORY_ROOT,
    encoding: "utf8"
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new ProductPathPrerequisiteError([
      "Git returned an invalid Koed source revision"
    ]);
  }
  return commit;
};

const CAMPAIGN_TEMPLATE_MATERIALIZATION_PATHS = [
  "apps/api",
  "apps/worker",
  "packages/core",
  "packages/db",
  "packages/shared",
  "packages/evals/src/experience-replay/atif",
  "packages/evals/src/experience-replay/ingestion.ts",
  "packages/evals/src/experience-replay/local-product-adapter.ts",
  "packages/evals/src/experience-replay/product-api-process.ts",
  "packages/evals/src/experience-replay/product-state.ts",
  "packages/evals/src/experience-replay/recorded-runtime-lcm.ts",
  "packages/mcp-server/src/lcm-summary-service.ts",
  "packages/mcp-server/src/lcm-summary-worker.ts",
  "packages/mcp-server/src/prompt-loader.ts",
  "prompts/app-server/lcm-summary-base.md",
  "prompts/lcm-summary-leaf.md",
  "prompts/lcm-summary-partial.md",
  "prompts/lcm-summary-reduce.md",
  "prompts/lcm-summary-rollup.md"
] as const;

const campaignTemplateMaterializationSourceHash = (): string => {
  const entries = CAMPAIGN_TEMPLATE_MATERIALIZATION_PATHS.map((sourcePath) => {
    const objectId = execFileSync("git", ["rev-parse", `HEAD:${sourcePath}`], {
      cwd: EXPERIENCE_REPLAY_REPOSITORY_ROOT,
      encoding: "utf8"
    }).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(objectId)) {
      throw new ProductPathPrerequisiteError([
        `Git returned an invalid materialization source object for ${sourcePath}`
      ]);
    }
    return [sourcePath, objectId] as const;
  });
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")}`;
};

export const createRecordedCliExperienceReplayDependencies = (
  config: ResolvedExperienceReplayConfig,
  environment: Readonly<NodeJS.ProcessEnv>,
  options: {
    runId: string;
    corpusManifest: string;
    postgres: { adminUrl: string; user: string; password: string };
    frozenTaskImages: Readonly<Record<string, string>>;
    codexAuthMode: ExperienceReplayCodexAuthMode;
    productPathProof: boolean;
  }
) => {
  const authentication = resolveRecordedCodexAuthentication(
    environment,
    options.codexAuthMode
  );
  const appServerBinary = required(
    environment,
    "MEMORY_CODEX_APP_SERVER_BINARY"
  );
  const containerCodexBinary = required(
    environment,
    "KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_BINARY"
  );
  const embeddingUrl = required(
    environment,
    "KOED_EXPERIENCE_REPLAY_EMBEDDING_URL"
  );
  const embeddingToken = required(
    environment,
    "KOED_EXPERIENCE_REPLAY_EMBEDDING_TOKEN"
  );
  const koedHome =
    environment.KOED_HOME?.trim() || path.join(os.homedir(), ".koed");
  const campaignTemplateCacheDirectory =
    environment.KOED_EXPERIENCE_REPLAY_CAMPAIGN_TEMPLATE_CACHE_DIR?.trim() ||
    path.join(koedHome, "benchmark-cache", "campaign-templates");
  const repositoryCommit = cleanRepositoryCommit();
  const materializationSourceHash = campaignTemplateMaterializationSourceHash();
  const runtimeEnvironment: NodeJS.ProcessEnv = {
    ...(authentication.mode === "api_key"
      ? { OPENAI_API_KEY: authentication.apiKey }
      : {}),
    EMBEDDING_SERVICE_URL: embeddingUrl,
    EMBEDDING_SERVICE_TOKEN: embeddingToken,
    EMBEDDING_MODEL: config.embedding.model,
    MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
    MEMORY_ANSWER_PROVIDER: "codex",
    MEMORY_ANSWER_MODEL: config.memory_answer.model.id,
    MEMORY_ANSWER_REASONING_EFFORT: config.memory_answer.model.reasoning_effort,
    MEMORY_ANSWER_TIMEOUT_MS: String(config.timeouts.agent_seconds * 1_000),
    MEMORY_LCM_SUMMARY_PROVIDER: "codex",
    MEMORY_LCM_SUMMARY_MODEL: config.lcm_summary.model.id,
    MEMORY_LCM_SUMMARY_REASONING_EFFORT:
      config.lcm_summary.model.reasoning_effort,
    MEMORY_LCM_SUMMARY_TIMEOUT_MS: String(
      config.timeouts.preparation_seconds * 1_000
    ),
    MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS: String(
      config.admission.max_input_tokens_per_call
    )
  };
  const runScheduledLcmJobs = createRecordedLcmJobRunner({
    config,
    environment: runtimeEnvironment
  });
  const judgeTrajectory = async (
    input: Parameters<typeof runTrajectoryJudge>[0]
  ) => {
    const judgeHome = await mkdtemp(
      path.join(os.tmpdir(), "koed-experience-replay-judge-")
    );
    try {
      if (authentication.mode === "subscription") {
        const target = path.join(judgeHome, "auth.json");
        await copyFile(authentication.authJsonPath, target);
        await chmod(target, 0o600);
      }
      return await runTrajectoryJudge(input, {
        config: {
          appServerBinary,
          model: config.trajectory_judge.model.id,
          reasoningEffort: config.trajectory_judge.model.reasoning_effort,
          timeoutMs: config.timeouts.judge_seconds * 1_000,
          cwd: EXPERIENCE_REPLAY_REPOSITORY_ROOT,
          env: {
            ...(authentication.mode === "api_key"
              ? { OPENAI_API_KEY: authentication.apiKey }
              : {}),
            CODEX_HOME: judgeHome
          }
        },
        price: config.price_table.models[config.trajectory_judge.model.id]
      });
    } finally {
      await rm(judgeHome, { recursive: true, force: true });
    }
  };
  return createExperienceReplayCoordinatorDependencies({
    mode: "recorded",
    runId: options.runId,
    corpusManifest: options.corpusManifest,
    postgres: options.postgres,
    countEmbeddingTokens: (text) =>
      countTokensForModel(text, { model: config.embedding.tokenizer }).tokens,
    ...(authentication.mode === "api_key"
      ? { providerApiKey: authentication.apiKey }
      : { codexAuthJsonPath: authentication.authJsonPath }),
    containerCodexBinary,
    productPathProof: options.productPathProof,
    frozenTaskImages: options.frozenTaskImages,
    collectReplayTelemetry: createRecordedReplayTelemetryCollector({
      authMode: authentication.mode,
      workflowModels: {
        mcp_memory_answer: config.memory_answer.model.id,
        lcm_summary: config.lcm_summary.model.id,
        session_title: config.session_title.model.id
      },
      prices: config.price_table.models
    }),
    recordedEmbedding: {
      url: embeddingUrl,
      token: embeddingToken,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      modelArtifactHash: config.embedding.artifact_sha256
    },
    productApiEnvironment: {},
    productRuntimeEnvironment: runtimeEnvironment,
    lcmSummaryConfig: {
      model: config.lcm_summary.model.id,
      promptVersion: config.lcm_summary.prompt_version
    },
    runScheduledLcmJobs,
    judgeTrajectory,
    preparationCostUsd: priceForPreparation,
    campaignTemplateCacheDirectory,
    repositoryCommit,
    campaignTemplateMaterializationSourceHash: materializationSourceHash,
    preparationRequestTimeoutMs: config.timeouts.preparation_seconds * 1_000
  });
};
