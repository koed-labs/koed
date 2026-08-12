import { countTokensForModel } from "@koed/core";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import { createExperienceReplayCoordinatorDependencies } from "./coordinator-dependencies.js";
import type { LocalProductTemplateHandle } from "./local-product-adapter.js";
import { ProductPathPrerequisiteError } from "./preflight.js";
import { createRecordedLcmJobRunner } from "./recorded-runtime-lcm.js";
import { createRecordedReplayTelemetryCollector } from "./recorded-runtime-telemetry.js";

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
  const usage = template.attestation.scheduledLcmJobs;
  if (!usage) return 0;
  const price = config.price_table.models[config.lcm_summary.model.id];
  if (!price) throw new Error("Recorded LCM model has no price entry");
  return (
    (usage.inputTokens * price.uncached_input_usd_per_million +
      usage.outputTokens * price.output_usd_per_million) /
    1_000_000
  );
};

export const createRecordedCliExperienceReplayDependencies = (
  config: ResolvedExperienceReplayConfig,
  environment: Readonly<NodeJS.ProcessEnv>,
  options: {
    runId: string;
    corpusManifest: string;
    postgres: { adminUrl: string; user: string; password: string };
    frozenTaskImages: Readonly<Record<string, string>>;
  }
) => {
  const providerApiKey = required(environment, "OPENAI_API_KEY");
  const appServerBinary = required(
    environment,
    "MEMORY_CODEX_APP_SERVER_BINARY"
  );
  const embeddingUrl = required(
    environment,
    "KOED_EXPERIENCE_REPLAY_EMBEDDING_URL"
  );
  const embeddingToken = required(
    environment,
    "KOED_EXPERIENCE_REPLAY_EMBEDDING_TOKEN"
  );
  const runtimeEnvironment: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: providerApiKey,
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
  return createExperienceReplayCoordinatorDependencies({
    mode: "recorded",
    runId: options.runId,
    corpusManifest: options.corpusManifest,
    postgres: options.postgres,
    countEmbeddingTokens: (text) =>
      countTokensForModel(text, { model: config.embedding.tokenizer }).tokens,
    providerApiKey,
    frozenTaskImages: options.frozenTaskImages,
    collectReplayTelemetry: createRecordedReplayTelemetryCollector(environment),
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
    preparationCostUsd: priceForPreparation
  });
};
