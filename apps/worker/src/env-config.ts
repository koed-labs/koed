import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  requireEnv,
  resolveRerankerKeyFromEnv,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig
} from "@koed/shared";
import {
  resolveWorkerLogDestinationConfig,
  resolveWorkerLogLevel,
  type WorkerLogDestinationConfig,
  type WorkerLogLevel
} from "./logging.js";

export interface WorkerEnvConfig {
  redisUrl: string;
  databaseUrl?: string;
  databaseConfigured: boolean;
  embeddingServiceUrl: string;
  embeddingServiceToken?: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  rawProjectionIntervalMs: number;
  rawProjectionBatchLimit: number;
  rawProjectionActorLimit: number;
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
        "REDIS_URL",
        "DATA_ENCRYPTION_KEY",
        "EMBEDDING_SERVICE_URL",
        "EMBEDDING_SERVICE_TOKEN",
        "EMBEDDING_MODEL"
      ],
      environment
    );
  }

  return {
    redisUrl: environment.REDIS_URL ?? "redis://localhost:6379",
    ...(databaseUrl ? { databaseUrl } : {}),
    databaseConfigured: Boolean(databaseUrl),
    embeddingServiceUrl:
      environment.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000",
    ...(embeddingServiceToken ? { embeddingServiceToken } : {}),
    embeddingDimensions: embeddingModel.dimensions,
    embeddingVersion: embeddingModel.key,
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
    logLevel: resolveWorkerLogLevel(environment),
    logDestination: resolveWorkerLogDestinationConfig(environment),
    nodeEnv,
    production: nodeEnv === "production"
  };
};
