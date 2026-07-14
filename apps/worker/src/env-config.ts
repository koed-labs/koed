import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  requireEnv,
  resolveKoedQueueBackend,
  resolveRerankerKeyFromEnv,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig,
  validateEnvelopeEncryptionProviderEnvironment,
  type KoedQueueBackend
} from "@koed/shared";
import {
  resolveWorkerLogDestinationConfig,
  resolveWorkerLogLevel,
  type WorkerLogDestinationConfig,
  type WorkerLogLevel
} from "./logging.js";

export interface WorkerEnvConfig {
  queueBackend: KoedQueueBackend;
  redisUrl: string;
  databaseUrl?: string;
  databaseConfigured: boolean;
  embeddingServiceUrl: string;
  embeddingServiceToken?: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  embeddingBatchLimit: number;
  embeddingMaxTextChars: number;
  embeddingMaxRequestChars: number;
  embeddingRequestTimeoutMs: number;
  rawProjectionIntervalMs: number;
  rawProjectionBatchLimit: number;
  rawProjectionActorLimit: number;
  crossIdentitySyncIntervalMs: number;
  crossIdentitySyncStaleAfterSeconds: number;
  koedHome: string;
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

const positiveIntEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const parsed = Number.parseInt(environment[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    queueBackend,
    redisUrl: environment.REDIS_URL ?? "redis://localhost:6379",
    ...(databaseUrl ? { databaseUrl } : {}),
    databaseConfigured: Boolean(databaseUrl),
    embeddingServiceUrl:
      environment.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000",
    ...(embeddingServiceToken ? { embeddingServiceToken } : {}),
    embeddingDimensions: embeddingModel.dimensions,
    embeddingVersion: embeddingModel.key,
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
    rawProjectionIntervalMs: positiveIntEnv(
      environment,
      "MEMORY_RAW_PROJECTION_INTERVAL_MS",
      5_000
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
    koedHome: resolve(environment.KOED_HOME ?? resolve(homedir(), ".koed")),
    logLevel: resolveWorkerLogLevel(environment),
    logDestination: resolveWorkerLogDestinationConfig(environment),
    nodeEnv,
    production: nodeEnv === "production"
  };
};
