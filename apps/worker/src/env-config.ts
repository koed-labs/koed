import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  requireEnv,
  resolveTeamCollaborationEnabled,
  resolveKoedQueueBackend,
  resolveRerankerKeyFromEnv,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig,
  validateEnvelopeEncryptionProviderEnvironment,
  type KoedQueueBackend
} from "@koed/shared";
import type { HistoricalImportBatchConfig } from "./historical-admission.js";
import {
  resolveWorkerLogDestinationConfig,
  resolveWorkerLogLevel,
  type WorkerLogDestinationConfig,
  type WorkerLogLevel
} from "./logging.js";

export interface WorkerEnvConfig {
  teamCollaborationEnabled: boolean;
  queueBackend: KoedQueueBackend;
  redisUrl: string;
  databaseUrl?: string;
  databaseConfigured: boolean;
  embeddingServiceUrl: string;
  embeddingServiceToken?: string;
  embeddingPoolKey: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  embeddingModelArtifactHash: string;
  embeddingTokenizer: string;
  embeddingInputTransform: string;
  embeddingPooling: string;
  embeddingNormalization: string;
  embeddingBatchLimit: number;
  embeddingMaxTextChars: number;
  embeddingMaxRequestChars: number;
  embeddingRequestTimeoutMs: number;
  embeddingCapacityRefinedDelayMs: number;
  rawProjectionBatchLimit: number;
  rawProjectionActorLimit: number;
  crossIdentitySyncIntervalMs: number;
  crossIdentitySyncStaleAfterSeconds: number;
  retentionPurgeIntervalMs: number;
  collaborationReplayPruneIntervalMs: number;
  collaborationReplayPruneBatchLimit: number;
  managedConversationApiUrl?: string;
  managedConversationApiToken?: string;
  managedConversationAppServerBinary: string;
  managedConversationModel: string;
  managedConversationClaudeModel: string;
  managedConversationReasoningEffort: string;
  koedHome: string;
  historicalImport: HistoricalImportBatchConfig;
  historicalImportApiReadyUrl?: string;
  historicalImportApiReadyTimeoutMs: number;
  logLevel: WorkerLogLevel;
  logDestination: WorkerLogDestinationConfig;
  nodeEnv: string;
  production: boolean;
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const loadWorkerEnv = (): void => {
  loadDotenv({ path: resolve(appDir, ".env"), override: false, quiet: true });
};

const optionalEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const embeddingPoolKey = (value: string | undefined): string => {
  const key = optionalEnv(value) ?? "default";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
    throw new Error(
      "KOED_EMBEDDING_POOL_KEY must be 1-64 letters, numbers, dots, underscores, or hyphens"
    );
  }
  return key;
};

const positiveIntEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const parsed = Number.parseInt(environment[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const boundedIntEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number => {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
};

const optionalHttpUrl = (
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined => {
  const value = optionalEnv(environment[name]);
  if (!value) {
    return undefined;
  }
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
  return url.toString();
};

export const resolveWorkerEnv = (
  environment: NodeJS.ProcessEnv = process.env
): WorkerEnvConfig => {
  const nodeEnv = environment.NODE_ENV ?? "development";
  const queueBackend = resolveKoedQueueBackend(environment.WORK_QUEUE_BACKEND);
  const databaseUrl = optionalEnv(environment.DATABASE_URL);
  const embeddingServiceToken = optionalEnv(
    environment.EMBEDDING_SERVICE_TOKEN
  );
  const managedConversationApiUrl = optionalHttpUrl(
    environment,
    "MEMORY_API_URL"
  );
  const historicalImportApiReadyUrl =
    optionalHttpUrl(environment, "MEMORY_HISTORICAL_IMPORT_API_READY_URL") ??
    (managedConversationApiUrl
      ? new URL("/ready", managedConversationApiUrl).toString()
      : undefined);
  const managedConversationApiToken = optionalEnv(environment.MEMORY_API_TOKEN);
  const embeddingModel = resolveSupportedEmbeddingModelConfig(
    environment.EMBEDDING_MODEL
  );
  resolveSupportedRerankerModelConfig(resolveRerankerKeyFromEnv(environment));
  if (nodeEnv === "production") {
    requireEnv(
      [
        "DATABASE_URL",
        ...(queueBackend === "bullmq" ? ["REDIS_URL"] : []),
        "EMBEDDING_SERVICE_URL",
        "EMBEDDING_SERVICE_TOKEN",
        "EMBEDDING_MODEL"
      ],
      environment
    );
    validateEnvelopeEncryptionProviderEnvironment({ environment });
  }

  return {
    teamCollaborationEnabled: resolveTeamCollaborationEnabled(environment),
    queueBackend,
    redisUrl: environment.REDIS_URL ?? "redis://localhost:6379",
    ...(databaseUrl ? { databaseUrl } : {}),
    databaseConfigured: Boolean(databaseUrl),
    embeddingServiceUrl:
      environment.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000",
    ...(embeddingServiceToken ? { embeddingServiceToken } : {}),
    embeddingPoolKey: embeddingPoolKey(environment.KOED_EMBEDDING_POOL_KEY),
    embeddingDimensions: embeddingModel.dimensions,
    embeddingVersion: embeddingModel.key,
    embeddingModelArtifactHash:
      optionalEnv(environment.KOED_EMBEDDING_MODEL_SHA256) ??
      embeddingModel.defaultArtifactSha256,
    embeddingTokenizer: embeddingModel.tokenizer,
    embeddingInputTransform: embeddingModel.inputTransform,
    embeddingPooling: embeddingModel.pooling,
    embeddingNormalization: embeddingModel.normalization,
    embeddingBatchLimit: positiveIntEnv(
      environment,
      "EMBEDDING_BATCH_LIMIT",
      16
    ),
    embeddingMaxTextChars: positiveIntEnv(
      environment,
      "EMBEDDING_MAX_TEXT_CHARS",
      200_000
    ),
    embeddingMaxRequestChars: positiveIntEnv(
      environment,
      "EMBEDDING_MAX_REQUEST_CHARS",
      1_000_000
    ),
    embeddingRequestTimeoutMs: positiveIntEnv(
      environment,
      "EMBEDDING_REQUEST_TIMEOUT_MS",
      900_000
    ),
    embeddingCapacityRefinedDelayMs: boundedIntEnv(
      environment,
      "EMBEDDING_CAPACITY_REFINED_DELAY_MS",
      30 * 60_000,
      1_000,
      24 * 60 * 60_000
    ),
    rawProjectionBatchLimit: positiveIntEnv(
      environment,
      "MEMORY_RAW_PROJECTION_BATCH_LIMIT",
      1000
    ),
    rawProjectionActorLimit: positiveIntEnv(
      environment,
      "MEMORY_RAW_PROJECTION_ACTOR_LIMIT",
      10
    ),
    crossIdentitySyncIntervalMs: positiveIntEnv(
      environment,
      "CROSS_IDENTITY_SYNC_INTERVAL_MS",
      1_000
    ),
    crossIdentitySyncStaleAfterSeconds: positiveIntEnv(
      environment,
      "CROSS_IDENTITY_SYNC_STALE_AFTER_SECONDS",
      86_400
    ),
    retentionPurgeIntervalMs: positiveIntEnv(
      environment,
      "RETENTION_PURGE_INTERVAL_MS",
      1_000
    ),
    collaborationReplayPruneIntervalMs: positiveIntEnv(
      environment,
      "COLLABORATION_REPLAY_PRUNE_INTERVAL_MS",
      60_000
    ),
    collaborationReplayPruneBatchLimit: positiveIntEnv(
      environment,
      "COLLABORATION_REPLAY_PRUNE_BATCH_LIMIT",
      1_000
    ),
    ...(managedConversationApiUrl ? { managedConversationApiUrl } : {}),
    ...(managedConversationApiToken ? { managedConversationApiToken } : {}),
    managedConversationAppServerBinary:
      optionalEnv(environment.MEMORY_CODEX_APP_SERVER_BINARY) ?? "codex",
    managedConversationModel:
      optionalEnv(environment.KOED_MANAGED_CONVERSATION_MODEL) ?? "gpt-5.4",
    managedConversationClaudeModel:
      optionalEnv(environment.KOED_MANAGED_CONVERSATION_CLAUDE_MODEL) ??
      "claude-haiku-4-5-20251001",
    managedConversationReasoningEffort:
      optionalEnv(environment.KOED_MANAGED_CONVERSATION_REASONING_EFFORT) ??
      "high",
    koedHome: resolve(environment.KOED_HOME ?? resolve(homedir(), ".koed")),
    historicalImport: {
      maxRows: boundedIntEnv(
        environment,
        "MEMORY_HISTORICAL_IMPORT_BATCH_ROWS",
        100,
        1,
        1000
      ),
      maxBytes: boundedIntEnv(
        environment,
        "MEMORY_HISTORICAL_IMPORT_BATCH_BYTES",
        1_000_000,
        1,
        10_000_000
      ),
      maxRuntimeMs: boundedIntEnv(
        environment,
        "MEMORY_HISTORICAL_IMPORT_BATCH_RUNTIME_MS",
        15_000,
        100,
        60_000
      ),
      maxConcurrency: boundedIntEnv(
        environment,
        "MEMORY_HISTORICAL_IMPORT_CONCURRENCY",
        1,
        1,
        1
      ),
      maxLiveProjectionRows: boundedIntEnv(
        environment,
        "MEMORY_HISTORICAL_IMPORT_LIVE_BACKLOG_MAX",
        0,
        0,
        10_000
      )
    },
    ...(historicalImportApiReadyUrl ? { historicalImportApiReadyUrl } : {}),
    historicalImportApiReadyTimeoutMs: boundedIntEnv(
      environment,
      "MEMORY_HISTORICAL_IMPORT_API_READY_TIMEOUT_MS",
      1_000,
      100,
      10_000
    ),
    logLevel: resolveWorkerLogLevel(environment),
    logDestination: resolveWorkerLogDestinationConfig(environment),
    nodeEnv,
    production: nodeEnv === "production"
  };
};
