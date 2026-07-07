import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  requireEnv,
  resolveRerankerKeyFromEnv,
  resolveSupportedRerankerModelConfig,
  validateEnvelopeEncryptionProviderEnvironment
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

const requireWorkosAuthKitEnv = (environment: NodeJS.ProcessEnv): void => {
  if (environment.WORKOS_AUTHKIT_ENABLED !== "true") {
    return;
  }
  requireEnv(
    ["WORKOS_CLIENT_ID", "WORKOS_API_KEY", "WORKOS_REDIRECT_URI"],
    environment
  );
  try {
    const redirectUri = new URL(environment.WORKOS_REDIRECT_URI ?? "");
    if (
      redirectUri.protocol !== "https:" &&
      redirectUri.hostname !== "localhost"
    ) {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error(
      "WORKOS_REDIRECT_URI must be an absolute HTTPS URL, or localhost for development"
    );
  }
};

export const resolveApiEnv = (
  environment: NodeJS.ProcessEnv = process.env
): ApiEnvConfig => {
  const nodeEnv = environment.NODE_ENV ?? "development";
  const queueBackend =
    environment.WORK_QUEUE_BACKEND?.trim() === "local" ? "local" : "bullmq";
  resolveSupportedRerankerModelConfig(resolveRerankerKeyFromEnv(environment));
  requireWorkosAuthKitEnv(environment);
  if (nodeEnv === "production") {
    requireEnv(
      [
        "DATABASE_URL",
        ...(queueBackend === "bullmq" ? ["REDIS_URL"] : []),
        "API_TOKEN_PEPPER",
        "EMBEDDING_SERVICE_TOKEN",
        "CORS_ORIGINS"
      ],
      environment
    );
    validateEnvelopeEncryptionProviderEnvironment({ environment });
  }

  return {
    host:
      environment.API_HOST ??
      (nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: intEnv(environment, "API_PORT", 3300),
    nodeEnv,
    production: nodeEnv === "production"
  };
};
