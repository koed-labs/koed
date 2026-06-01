import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  requireEnv,
  resolveRerankerKeyFromEnv,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig
} from "@koed/shared";

export interface WorkerEnvConfig {
  redisUrl: string;
  databaseConfigured: boolean;
  embeddingServiceUrl: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  nodeEnv: string;
  production: boolean;
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const loadWorkerEnv = (): void => {
  loadDotenv({ path: resolve(appDir, ".env"), override: false, quiet: true });
};

export const resolveWorkerEnv = (
  environment: NodeJS.ProcessEnv = process.env
): WorkerEnvConfig => {
  const nodeEnv = environment.NODE_ENV ?? "development";
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
    databaseConfigured: Boolean(environment.DATABASE_URL),
    embeddingServiceUrl:
      environment.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000",
    embeddingDimensions: embeddingModel.dimensions,
    embeddingVersion: embeddingModel.key,
    nodeEnv,
    production: nodeEnv === "production"
  };
};
