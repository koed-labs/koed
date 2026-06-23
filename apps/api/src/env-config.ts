import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  requireEnv,
  resolveRerankerKeyFromEnv,
  resolveSupportedRerankerModelConfig
} from "@koed/shared";

export interface ApiEnvConfig {
  host: string;
  port: number;
  nodeEnv: string;
  production: boolean;
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const loadApiEnv = (): void => {
  loadDotenv({ path: resolve(appDir, ".env"), override: false, quiet: true });
};

const intEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const parsed = Number.parseInt(environment[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveApiEnv = (
  environment: NodeJS.ProcessEnv = process.env
): ApiEnvConfig => {
  const nodeEnv = environment.NODE_ENV ?? "development";
  resolveSupportedRerankerModelConfig(resolveRerankerKeyFromEnv(environment));
  if (nodeEnv === "production") {
    requireEnv(
      [
        "DATABASE_URL",
        "REDIS_URL",
        "DATA_ENCRYPTION_KEY",
        "API_TOKEN_PEPPER",
        "EMBEDDING_SERVICE_TOKEN",
        "CORS_ORIGINS"
      ],
      environment
    );
  }

  return {
    host:
      environment.API_HOST ??
      (nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: intEnv(environment, "API_PORT", 3000),
    nodeEnv,
    production: nodeEnv === "production"
  };
};
