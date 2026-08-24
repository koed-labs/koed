import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnSyncReturns
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertKoedAppRuntimeAvailable,
  resolveKoedAppRuntime
} from "./app-runtime.js";
import { resolveKoedServerConfig, type KoedServerConfig } from "./config.js";
import {
  resolveActiveIntegrationApiToken,
  resolveLocalApiToken,
  writeLocalAppCredential
} from "./credentials.js";
import {
  environmentWithRepoEnv,
  loadRepoEnv,
  resolveApiUrl
} from "./env-file.js";
import { startLocalEmbeddingRuntime } from "./local-embedding-runtime.js";
import { startLocalPrivacyRuntime } from "./local-privacy-runtime.js";
import { resolveLocalModelManifest } from "./local-models-runtime.js";
import { ensurePackagedLocalServiceSecrets } from "./local-service-secrets.js";
import {
  startLocalPostgresRuntime,
  stopLocalPostgresRuntime
} from "./local-postgres-runtime.js";
import {
  ensureKoedHome,
  resolveKoedServerPaths,
  type KoedServerPaths
} from "./paths.js";
import { allocateAndPersistLocalPorts } from "./ports.js";
import { ensureDeviceIdentity } from "./device-identity.js";
import { collectKoedServerStatus } from "./status.js";
import {
  acquireKoedServerSupervisorLock,
  releaseKoedServerSupervisorLock
} from "./supervisor-lock.js";

import { maintainSupervisorLog } from "./supervisor-log.js";
import { monitorSupervisorExitRequest } from "./supervisor-exit-request.js";
import type { KoedServerRuntimeState } from "./types.js";
import { provisionDesktopApiToken } from "./local-api-token.js";
import { migrateKoedOwnedCodexRegistrationBestEffort } from "./ai-client-registry.js";
import { resolveTeamCollaborationEnabled } from "@koed/shared";
export {
  provisionDesktopApiToken,
  provisionDesktopLocalCredential
} from "./local-api-token.js";

const localRuntimeFailureDetails = (details: unknown): string => {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return "";
  }
  const result = details as { exitCode?: unknown; stderr?: unknown };
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  const stderr =
    typeof result.stderr === "string"
      ? result.stderr.trim().slice(0, 2_000)
      : "";
  const parts = [
    exitCode === null ? null : `exit code ${exitCode}`,
    stderr || null
  ].filter((part): part is string => Boolean(part));
  return parts.length ? ` (${parts.join(": ")})` : "";
};

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

type SpawnLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawn>[2]
) => ChildProcess;

export interface KoedServerStartOptions {
  environment?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe";
  pollIntervalMs?: number;
  timeoutMs?: number;
  spawnSync?: SpawnSyncLike;
  spawn?: SpawnLike;
  collectStatus?: typeof collectKoedServerStatus;
  signal?: AbortSignal;
}

const runCommand = (
  paths: KoedServerPaths,
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  spawnSync: SpawnSyncLike,
  cwd = paths.repoRoot
): void => {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 1}.`);
  }
};

const createOpaqueSecret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

const appProcessEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const output = { ...environment };
  delete output.PRIVACY_RUNTIME_CONTROL_TOKEN;
  return output;
};

const spawnManagedProcess = (
  paths: KoedServerPaths,
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  spawn: SpawnLike,
  cwd = paths.repoRoot
): ChildProcess => {
  console.log(`> Start ${label}`);
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: "inherit"
  });
  child.on("exit", (code) => {
    console.log(`${label} exited with code ${code ?? "signal"}.`);
  });
  return child;
};

const waitForHealthyOrReady = async ({
  environment,
  timeoutMs,
  pollIntervalMs,
  collectStatus,
  isReady = (status) =>
    status.api.state === "healthy" &&
    status.database.state === "healthy" &&
    status.redis.state === "healthy" &&
    status.embeddingService.state === "healthy" &&
    status.workerQueues.state === "healthy"
}: {
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  pollIntervalMs: number;
  collectStatus: typeof collectKoedServerStatus;
  isReady?: (
    status: Awaited<ReturnType<typeof collectKoedServerStatus>>
  ) => boolean;
}) => {
  const startedAt = Date.now();
  let lastStatus = await collectStatus(environment);
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await collectStatus(environment);
    if (isReady(lastStatus)) {
      return lastStatus;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollIntervalMs));
  }
  return lastStatus;
};

const resolveWorkQueueBackend = (
  value: string | undefined
): "bullmq" | "local" => (value?.trim() === "local" ? "local" : "bullmq");

const prefixedApiEnv = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  name: string
): string | undefined =>
  environment[`API_${name}`] ??
  repoEnv[`API_${name}`] ??
  environment[name] ??
  repoEnv[name];

const resolveEffectiveWorkQueueBackend = (
  config: KoedServerConfig,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): "bullmq" | "local" => {
  if (environment.WORK_QUEUE_BACKEND) {
    return resolveWorkQueueBackend(environment.WORK_QUEUE_BACKEND);
  }
  if (config.dependencyMode === "bundled-local") {
    return "local";
  }
  return resolveWorkQueueBackend(repoEnv.WORK_QUEUE_BACKEND);
};

const koedServerConfigEnvironment = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): NodeJS.ProcessEnv => ({
  ...environment,
  KOED_RUNTIME_MODE: environment.KOED_RUNTIME_MODE ?? repoEnv.KOED_RUNTIME_MODE,
  KOED_DEPENDENCY_MODE:
    environment.KOED_DEPENDENCY_MODE ?? repoEnv.KOED_DEPENDENCY_MODE,
  KOED_EXTERNAL_DATABASE_URL:
    environment.KOED_EXTERNAL_DATABASE_URL ??
    repoEnv.KOED_EXTERNAL_DATABASE_URL,
  KOED_EXTERNAL_REDIS_URL:
    environment.KOED_EXTERNAL_REDIS_URL ?? repoEnv.KOED_EXTERNAL_REDIS_URL,
  KOED_EXTERNAL_EMBEDDING_SERVICE_URL:
    environment.KOED_EXTERNAL_EMBEDDING_SERVICE_URL ??
    repoEnv.KOED_EXTERNAL_EMBEDDING_SERVICE_URL,
  MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED:
    environment.MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED ??
    repoEnv.MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED,
  MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED:
    environment.MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED ??
    repoEnv.MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED,
  KOED_HARDWARE_ACCELERATION:
    environment.KOED_HARDWARE_ACCELERATION ?? repoEnv.KOED_HARDWARE_ACCELERATION
});

const bundledLocalDatabaseUrl = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): string => {
  const user = environment.POSTGRES_USER ?? repoEnv.POSTGRES_USER ?? "koed";
  const password =
    environment.POSTGRES_PASSWORD ??
    repoEnv.POSTGRES_PASSWORD ??
    environment.KOED_BUNDLED_POSTGRES_PASSWORD ??
    "koed-local-postgres";
  const database = environment.POSTGRES_DB ?? repoEnv.POSTGRES_DB ?? "koed";
  const host = environment.KOED_POSTGRES_HOST ?? "127.0.0.1";
  const port =
    environment.KOED_POSTGRES_PORT ??
    environment.POSTGRES_HOST_PORT ??
    repoEnv.POSTGRES_HOST_PORT ??
    "15432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
};

const corsOrigins = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): string => {
  const configured = [
    environment.API_CORS_ORIGINS,
    repoEnv.API_CORS_ORIGINS,
    environment.CORS_ORIGINS,
    repoEnv.CORS_ORIGINS
  ]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  configured.push("koed://app");
  return Array.from(new Set(configured)).join(",");
};

const localServiceEnv = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  apiToken: ReturnType<typeof resolveLocalApiToken> | null,
  paths: KoedServerPaths
): NodeJS.ProcessEnv => {
  const apiPort = environment.API_HOST_PORT ?? repoEnv.API_HOST_PORT ?? "3300";
  const embeddingPort =
    environment.EMBEDDING_SERVICE_HOST_PORT ??
    repoEnv.EMBEDDING_SERVICE_HOST_PORT ??
    "3800";
  const embeddingServiceUrl = `http://localhost:${embeddingPort}`;
  const privacyPort =
    environment.PRIVACY_SERVICE_PORT ?? repoEnv.PRIVACY_SERVICE_PORT ?? "8092";
  const privacyServiceUrl = `http://localhost:${privacyPort}`;
  const serverConfig = resolveKoedServerConfig(
    paths,
    koedServerConfigEnvironment(environment, repoEnv)
  );
  const queueBackend = resolveEffectiveWorkQueueBackend(
    serverConfig,
    environment,
    repoEnv
  );
  const modelEnvironment = { ...repoEnv, ...environment };
  const embeddingModel = resolveLocalModelManifest(
    paths,
    "embedding",
    modelEnvironment
  );
  const rerankerModel = resolveLocalModelManifest(
    paths,
    "reranker",
    modelEnvironment
  );
  const installedModelPaths = [
    embeddingModel.modelPath,
    rerankerModel.modelPath
  ].filter((modelPath) => existsSync(modelPath));
  const localEmbeddingModelPath = existsSync(embeddingModel.modelPath)
    ? embeddingModel.modelPath
    : undefined;
  const localRerankerModelPath = existsSync(rerankerModel.modelPath)
    ? rerankerModel.modelPath
    : undefined;
  const modelsDir = installedModelPaths[0]
    ? dirname(installedModelPaths[0])
    : paths.modelsDir;
  return {
    ...process.env,
    ...repoEnv,
    ...(apiToken ? { MEMORY_API_TOKEN: apiToken.token } : {}),
    ...environment,
    NODE_ENV:
      environment.API_NODE_ENV ??
      repoEnv.API_NODE_ENV ??
      environment.NODE_ENV ??
      "production",
    LOG_LEVEL:
      environment.API_LOG_LEVEL ??
      repoEnv.API_LOG_LEVEL ??
      environment.LOG_LEVEL,
    API_HOST: environment.API_HOST ?? repoEnv.API_HOST ?? "127.0.0.1",
    WORK_QUEUE_BACKEND: queueBackend,
    KOED_MODELS_DIR: modelsDir,
    KOED_EMBEDDING_ACCELERATION:
      environment.KOED_EMBEDDING_ACCELERATION ??
      repoEnv.KOED_EMBEDDING_ACCELERATION ??
      serverConfig.hardwareAcceleration,
    KOED_HARDWARE_ACCELERATION:
      environment.KOED_HARDWARE_ACCELERATION ??
      repoEnv.KOED_HARDWARE_ACCELERATION ??
      serverConfig.hardwareAcceleration,
    PRIVACY_RUNTIME_PROVIDER:
      environment.PRIVACY_RUNTIME_PROVIDER ??
      repoEnv.PRIVACY_RUNTIME_PROVIDER ??
      environment.KOED_HARDWARE_ACCELERATION ??
      repoEnv.KOED_HARDWARE_ACCELERATION ??
      serverConfig.hardwareAcceleration,
    WORKER_LOG_LEVEL: repoEnv.WORKER_LOG_LEVEL ?? environment.WORKER_LOG_LEVEL,
    KOED_EMBEDDING_POOL_KEY:
      environment.WORKER_KOED_EMBEDDING_POOL_KEY ??
      repoEnv.WORKER_KOED_EMBEDDING_POOL_KEY ??
      environment.KOED_EMBEDDING_POOL_KEY ??
      repoEnv.KOED_EMBEDDING_POOL_KEY,
    API_PORT: apiPort,
    DATABASE_URL:
      serverConfig.dependencyMode === "external"
        ? (serverConfig.external?.databaseUrl ??
          environment.DATABASE_URL ??
          repoEnv.DATABASE_URL)
        : bundledLocalDatabaseUrl(environment, repoEnv),
    REDIS_URL:
      serverConfig.external?.redisUrl ??
      environment.REDIS_URL ??
      repoEnv.REDIS_URL,
    RATE_LIMIT_STORE: prefixedApiEnv(environment, repoEnv, "RATE_LIMIT_STORE"),
    RATE_LIMIT_REDIS_URL:
      prefixedApiEnv(environment, repoEnv, "RATE_LIMIT_REDIS_URL") ?? "",
    AUTH_RATE_LIMIT_WINDOW_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "AUTH_RATE_LIMIT_WINDOW_MS"
    ),
    AUTH_RATE_LIMIT_MAX: prefixedApiEnv(
      environment,
      repoEnv,
      "AUTH_RATE_LIMIT_MAX"
    ),
    MEMORY_RATE_LIMIT_WINDOW_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_RATE_LIMIT_WINDOW_MS"
    ),
    MEMORY_RATE_LIMIT_MAX: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_RATE_LIMIT_MAX"
    ),
    MEMORY_READ_RATE_LIMIT_WINDOW_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_READ_RATE_LIMIT_WINDOW_MS"
    ),
    MEMORY_READ_RATE_LIMIT_MAX: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_READ_RATE_LIMIT_MAX"
    ),
    MEMORY_WRITE_RATE_LIMIT_WINDOW_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_WRITE_RATE_LIMIT_WINDOW_MS"
    ),
    MEMORY_WRITE_RATE_LIMIT_MAX: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_WRITE_RATE_LIMIT_MAX"
    ),
    MEMORY_RECALL_RATE_LIMIT_WINDOW_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_RECALL_RATE_LIMIT_WINDOW_MS"
    ),
    MEMORY_RECALL_RATE_LIMIT_MAX: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_RECALL_RATE_LIMIT_MAX"
    ),
    SOURCE_JOURNAL_RATE_LIMIT_WINDOW_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "SOURCE_JOURNAL_RATE_LIMIT_WINDOW_MS"
    ),
    SOURCE_JOURNAL_RATE_LIMIT_MAX: prefixedApiEnv(
      environment,
      repoEnv,
      "SOURCE_JOURNAL_RATE_LIMIT_MAX"
    ),
    CACHE_STORE: prefixedApiEnv(environment, repoEnv, "CACHE_STORE"),
    CACHE_REDIS_URL:
      prefixedApiEnv(environment, repoEnv, "CACHE_REDIS_URL") ?? "",
    GRAPH_CACHE_TTL_SECONDS: prefixedApiEnv(
      environment,
      repoEnv,
      "GRAPH_CACHE_TTL_SECONDS"
    ),
    GRAPH_UPDATE_DEBOUNCE_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "GRAPH_UPDATE_DEBOUNCE_MS"
    ),
    MEMORY_EVENT_GRAPH_UPDATE_DEBOUNCE_MS: prefixedApiEnv(
      environment,
      repoEnv,
      "MEMORY_EVENT_GRAPH_UPDATE_DEBOUNCE_MS"
    ),
    DATA_ENCRYPTION_KEY:
      environment.API_DATA_ENCRYPTION_KEY ??
      repoEnv.API_DATA_ENCRYPTION_KEY ??
      environment.DATA_ENCRYPTION_KEY ??
      repoEnv.DATA_ENCRYPTION_KEY,
    OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY:
      environment.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY ??
      repoEnv.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY,
    TEAM_MEMORY_DATA_ENCRYPTION_KEY: prefixedApiEnv(
      environment,
      repoEnv,
      "TEAM_MEMORY_DATA_ENCRYPTION_KEY"
    ),
    TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER: prefixedApiEnv(
      environment,
      repoEnv,
      "TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER"
    ),
    TEAM_MEMORY_MANAGED_KMS_KEY_ID: prefixedApiEnv(
      environment,
      repoEnv,
      "TEAM_MEMORY_MANAGED_KMS_KEY_ID"
    ),
    TEAM_MEMORY_MANAGED_KMS_KEY_VERSION: prefixedApiEnv(
      environment,
      repoEnv,
      "TEAM_MEMORY_MANAGED_KMS_KEY_VERSION"
    ),
    TEAM_MEMORY_MANAGED_KMS_ENDPOINT_URL: prefixedApiEnv(
      environment,
      repoEnv,
      "TEAM_MEMORY_MANAGED_KMS_ENDPOINT_URL"
    ),
    TEAM_MEMORY_MANAGED_KMS_AUTH_TOKEN: prefixedApiEnv(
      environment,
      repoEnv,
      "TEAM_MEMORY_MANAGED_KMS_AUTH_TOKEN"
    ),
    OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER:
      environment.OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER ??
      repoEnv.OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER,
    OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID:
      environment.OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID ??
      repoEnv.OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID,
    OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION:
      environment.OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION ??
      repoEnv.OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION,
    OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL:
      environment.OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL ??
      repoEnv.OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL,
    OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN:
      environment.OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN ??
      repoEnv.OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN,
    API_TOKEN_PEPPER: environment.API_TOKEN_PEPPER ?? repoEnv.API_TOKEN_PEPPER,
    COLLABORATION_LOCAL_BROKER_SECRET: prefixedApiEnv(
      environment,
      repoEnv,
      "COLLABORATION_LOCAL_BROKER_SECRET"
    ),
    COLLABORATION_REALTIME_CURSOR_SECRET: prefixedApiEnv(
      environment,
      repoEnv,
      "COLLABORATION_REALTIME_CURSOR_SECRET"
    ),
    COLLABORATION_REALTIME_STREAM_MAX_CLIENTS: prefixedApiEnv(
      environment,
      repoEnv,
      "COLLABORATION_REALTIME_STREAM_MAX_CLIENTS"
    ),
    COLLABORATION_REALTIME_STREAM_MAX_CLIENTS_PER_PRINCIPAL: prefixedApiEnv(
      environment,
      repoEnv,
      "COLLABORATION_REALTIME_STREAM_MAX_CLIENTS_PER_PRINCIPAL"
    ),
    EMBEDDING_SERVICE_URL:
      serverConfig.dependencyMode === "external"
        ? (serverConfig.external?.embeddingServiceUrl ??
          environment.EMBEDDING_SERVICE_URL ??
          repoEnv.EMBEDDING_SERVICE_URL)
        : (environment.EMBEDDING_SERVICE_URL ??
          repoEnv.EMBEDDING_SERVICE_URL ??
          embeddingServiceUrl),
    EMBEDDING_SERVICE_TOKEN:
      environment.EMBEDDING_SERVICE_TOKEN ?? repoEnv.EMBEDDING_SERVICE_TOKEN,
    PRIVACY_SERVICE_URL:
      serverConfig.dependencyMode === "external"
        ? (serverConfig.external?.privacyServiceUrl ??
          environment.PRIVACY_SERVICE_URL ??
          repoEnv.PRIVACY_SERVICE_URL ??
          process.env.PRIVACY_SERVICE_URL)
        : (environment.PRIVACY_SERVICE_URL ??
          repoEnv.PRIVACY_SERVICE_URL ??
          privacyServiceUrl),
    PRIVACY_SERVICE_TOKEN:
      serverConfig.dependencyMode === "external"
        ? (environment.PRIVACY_SERVICE_TOKEN ??
          repoEnv.PRIVACY_SERVICE_TOKEN ??
          process.env.PRIVACY_SERVICE_TOKEN)
        : (environment.PRIVACY_SERVICE_TOKEN ??
          repoEnv.PRIVACY_SERVICE_TOKEN ??
          process.env.PRIVACY_SERVICE_TOKEN ??
          createOpaqueSecret("privacy")),
    PRIVACY_RUNTIME_CONTROL_TOKEN:
      serverConfig.dependencyMode === "external"
        ? (environment.PRIVACY_RUNTIME_CONTROL_TOKEN ??
          repoEnv.PRIVACY_RUNTIME_CONTROL_TOKEN ??
          process.env.PRIVACY_RUNTIME_CONTROL_TOKEN)
        : (environment.PRIVACY_RUNTIME_CONTROL_TOKEN ??
          repoEnv.PRIVACY_RUNTIME_CONTROL_TOKEN ??
          process.env.PRIVACY_RUNTIME_CONTROL_TOKEN ??
          createOpaqueSecret("privacy-control")),
    EMBEDDING_MODEL:
      environment.EMBEDDING_MODEL_KEY ??
      environment.EMBEDDING_MODEL ??
      repoEnv.EMBEDDING_MODEL_KEY ??
      embeddingModel.key,
    MODEL_KEY:
      environment.EMBEDDING_MODEL_KEY ??
      environment.MODEL_KEY ??
      environment.EMBEDDING_MODEL ??
      repoEnv.EMBEDDING_MODEL_KEY ??
      embeddingModel.key,
    EMBEDDING_MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localEmbeddingModelPath
        : environment.EMBEDDING_MODEL_PATH,
    MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localEmbeddingModelPath
        : (environment.EMBEDDING_MODEL_PATH ?? environment.MODEL_PATH),
    RERANKER_KEY:
      environment.EMBEDDING_RERANKER_KEY ??
      environment.RERANKER_KEY ??
      repoEnv.EMBEDDING_RERANKER_KEY,
    EMBEDDING_RERANKER_MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localRerankerModelPath
        : (environment.EMBEDDING_RERANKER_MODEL_PATH ??
          repoEnv.EMBEDDING_RERANKER_MODEL_PATH),
    RERANKER_MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localRerankerModelPath
        : (environment.EMBEDDING_RERANKER_MODEL_PATH ??
          environment.RERANKER_MODEL_PATH ??
          repoEnv.EMBEDDING_RERANKER_MODEL_PATH ??
          repoEnv.RERANKER_MODEL_PATH),
    LLAMA_SERVER_BINARY:
      environment.LLAMA_SERVER_BINARY ??
      repoEnv.EMBEDDING_LLAMA_SERVER_BINARY ??
      environment.EMBEDDING_LLAMA_SERVER_BINARY,
    LLAMA_N_CTX:
      environment.EMBEDDING_LLAMA_N_CTX ??
      environment.LLAMA_N_CTX ??
      repoEnv.EMBEDDING_LLAMA_N_CTX,
    LLAMA_N_THREADS:
      environment.EMBEDDING_LLAMA_N_THREADS ??
      environment.LLAMA_N_THREADS ??
      repoEnv.EMBEDDING_LLAMA_N_THREADS,
    LLAMA_N_BATCH:
      environment.EMBEDDING_LLAMA_N_BATCH ??
      environment.LLAMA_N_BATCH ??
      repoEnv.EMBEDDING_LLAMA_N_BATCH,
    LLAMA_BATCH_TOKEN_HEADROOM:
      environment.EMBEDDING_LLAMA_BATCH_TOKEN_HEADROOM ??
      environment.LLAMA_BATCH_TOKEN_HEADROOM ??
      repoEnv.EMBEDDING_LLAMA_BATCH_TOKEN_HEADROOM,
    LLAMA_N_UBATCH:
      environment.EMBEDDING_LLAMA_N_UBATCH ??
      environment.LLAMA_N_UBATCH ??
      repoEnv.EMBEDDING_LLAMA_N_UBATCH,
    LLAMA_PARALLEL:
      environment.EMBEDDING_LLAMA_PARALLEL ??
      environment.LLAMA_PARALLEL ??
      repoEnv.EMBEDDING_LLAMA_PARALLEL,
    LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS:
      environment.EMBEDDING_LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS ??
      environment.LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS ??
      repoEnv.EMBEDDING_LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS,
    LLAMA_EMBEDDING_SERVER_PORT:
      environment.EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT ??
      environment.LLAMA_EMBEDDING_SERVER_PORT ??
      repoEnv.EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT,
    RERANKER_BATCH_LIMIT:
      environment.EMBEDDING_RERANKER_BATCH_LIMIT ??
      environment.RERANKER_BATCH_LIMIT ??
      repoEnv.EMBEDDING_RERANKER_BATCH_LIMIT,
    RERANKER_CONTEXT_PER_SLOT:
      environment.EMBEDDING_RERANKER_CONTEXT_PER_SLOT ??
      environment.RERANKER_CONTEXT_PER_SLOT ??
      repoEnv.EMBEDDING_RERANKER_CONTEXT_PER_SLOT,
    LLAMA_RERANKER_SERVER_PORT:
      environment.EMBEDDING_LLAMA_RERANKER_SERVER_PORT ??
      environment.LLAMA_RERANKER_SERVER_PORT ??
      repoEnv.EMBEDDING_LLAMA_RERANKER_SERVER_PORT,
    RERANKER_LLAMA_N_CTX:
      environment.EMBEDDING_RERANKER_LLAMA_N_CTX ??
      environment.RERANKER_LLAMA_N_CTX ??
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_CTX,
    RERANKER_LLAMA_N_THREADS:
      environment.EMBEDDING_RERANKER_LLAMA_N_THREADS ??
      environment.RERANKER_LLAMA_N_THREADS ??
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_THREADS,
    RERANKER_LLAMA_N_BATCH:
      environment.EMBEDDING_RERANKER_LLAMA_N_BATCH ??
      environment.RERANKER_LLAMA_N_BATCH ??
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_BATCH,
    RERANKER_LLAMA_N_UBATCH:
      environment.EMBEDDING_RERANKER_LLAMA_N_UBATCH ??
      environment.RERANKER_LLAMA_N_UBATCH ??
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_UBATCH,
    RERANKER_PARALLEL:
      environment.EMBEDDING_RERANKER_PARALLEL ??
      environment.RERANKER_PARALLEL ??
      repoEnv.EMBEDDING_RERANKER_PARALLEL,
    RERANKER_PROMPT_CACHE_ENABLED:
      environment.EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED ??
      environment.RERANKER_PROMPT_CACHE_ENABLED ??
      repoEnv.EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED,
    CORS_ORIGINS: corsOrigins(environment, repoEnv),
    COOKIE_SECURE: prefixedApiEnv(environment, repoEnv, "COOKIE_SECURE"),
    BROWSER_PUBLIC_URL: prefixedApiEnv(
      environment,
      repoEnv,
      "BROWSER_PUBLIC_URL"
    ),
    MEMORY_API_URL: resolveApiUrl(environment, repoEnv)
  };
};

const waitForChildExit = (
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> =>
  new Promise((resolveExit) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolveExit(true);
      return;
    }
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });

export const stopChildProcess = async (
  child: ChildProcess | undefined,
  timeoutMs = 5_000,
  label = "managed child"
): Promise<void> => {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, timeoutMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, timeoutMs))) {
    throw new Error(`Timed out stopping ${label} process ${child.pid}.`);
  }
};

const createManagedProcessMonitor = (
  options: {
    expectedSignals?: readonly NodeJS.Signals[];
  } = {}
): {
  watch: (name: string, child: ChildProcess) => void;
  result: Promise<void>;
  dispose: () => void;
} => {
  const expectedSignals = new Set(
    options.expectedSignals ?? (["SIGINT", "SIGTERM"] as const)
  );
  const listeners = new Map<
    ChildProcess,
    {
      exit: (code: number | null, signal: NodeJS.Signals | null) => void;
      error: (error: Error) => void;
    }
  >();
  let resolveResult!: () => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise;
    rejectResult = rejectPromise;
  });
  let settled = false;
  const dispose = () => {
    for (const [child, listener] of listeners) {
      child.off("exit", listener.exit);
      child.off("error", listener.error);
    }
    listeners.clear();
  };
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    dispose();
    if (error) rejectResult(error);
    else resolveResult();
  };
  const recordExit = (
    name: string,
    code: number | null,
    signal: NodeJS.Signals | null
  ) => {
    if (signal && expectedSignals.has(signal)) {
      settle();
      return;
    }
    settle(
      new Error(
        `Essential managed child ${name} exited unexpectedly with ${
          signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
        }.`
      )
    );
  };
  return {
    watch: (name, child) => {
      if (settled) return;
      if (child.exitCode != null || child.signalCode != null) {
        recordExit(name, child.exitCode, child.signalCode);
        return;
      }
      const listener = {
        exit: (code: number | null, signal: NodeJS.Signals | null) =>
          recordExit(name, code, signal),
        error: (error: Error) =>
          settle(
            new Error(
              `Essential managed child ${name} failed: ${error.message}`,
              {
                cause: error
              }
            )
          )
      };
      listeners.set(child, listener);
      child.once("exit", listener.exit);
      child.once("error", listener.error);
    },
    result,
    dispose
  };
};

export const waitForManagedProcessExits = (
  children: Record<string, ChildProcess>,
  options: {
    expectedSignals?: readonly NodeJS.Signals[];
  } = {}
): Promise<void> => {
  const entries = Object.entries(children);
  if (entries.length === 0) return Promise.resolve();
  const monitor = createManagedProcessMonitor(options);
  for (const [name, child] of entries) monitor.watch(name, child);
  return monitor.result;
};

export const startKoedServer = async ({
  environment = process.env,
  pollIntervalMs = 2_000,
  timeoutMs = 180_000,
  spawnSync = nodeSpawnSync as SpawnSyncLike,
  spawn = nodeSpawn as SpawnLike,
  collectStatus = collectKoedServerStatus,
  signal
}: KoedServerStartOptions = {}): Promise<void> => {
  const bootstrapPaths = resolveKoedServerPaths(environment);
  const bootstrapEnvironment = environmentWithRepoEnv(
    bootstrapPaths.repoRoot,
    environment
  );
  const paths = resolveKoedServerPaths(bootstrapEnvironment);
  ensureKoedHome(paths);
  const supervisorLock = acquireKoedServerSupervisorLock(paths);
  if (!supervisorLock.acquired) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          state: "already_running",
          koedHome: paths.koedHome,
          message: "A koed-server supervisor already owns this KOED_HOME.",
          ...(supervisorLock.ownerPid
            ? { supervisorPid: supervisorLock.ownerPid }
            : {})
        },
        null,
        2
      )
    );
    return;
  }
  await ensureDeviceIdentity(paths, { environment });
  const supervisorStartedAt = new Date().toISOString();
  const appRuntime = resolveKoedAppRuntime(paths, environment);
  assertKoedAppRuntimeAvailable(appRuntime, paths);
  environment = ensurePackagedLocalServiceSecrets(
    paths,
    appRuntime.kind === "packaged",
    environment
  );
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  const portAllocationEnvironment = environment.KOED_ENV_PATH?.trim()
    ? environmentWithRepoEnv(paths.repoRoot, environment)
    : environment;
  const allocatedPortEnvironment = await allocateAndPersistLocalPorts(
    paths,
    portAllocationEnvironment
  );
  environment = {
    ...environment,
    API_HOST_PORT: allocatedPortEnvironment.API_HOST_PORT,
    POSTGRES_HOST_PORT: allocatedPortEnvironment.POSTGRES_HOST_PORT,
    EMBEDDING_SERVICE_HOST_PORT:
      allocatedPortEnvironment.EMBEDDING_SERVICE_HOST_PORT,
    PRIVACY_SERVICE_PORT: allocatedPortEnvironment.PRIVACY_SERVICE_PORT,
    EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT:
      allocatedPortEnvironment.EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT,
    EMBEDDING_LLAMA_RERANKER_SERVER_PORT:
      allocatedPortEnvironment.EMBEDDING_LLAMA_RERANKER_SERVER_PORT
  };

  const repoEnv = loadRepoEnv(paths.repoRoot, environment);
  const migration = migrateKoedOwnedCodexRegistrationBestEffort({
    environment: { ...repoEnv, ...environment, KOED_HOME: paths.koedHome }
  });
  if (migration.diagnostic) {
    console.warn(migration.diagnostic);
  }
  const desktopManagedLocal = environment.KOED_AUTO_PORTS === "1";
  const apiToken = desktopManagedLocal
    ? null
    : resolveLocalApiToken(environment, repoEnv);
  if (apiToken) {
    writeLocalAppCredential(paths, {
      apiToken: apiToken.token,
      provisionedAt: new Date().toISOString(),
      source: apiToken.source
    });
  }
  const config = resolveKoedServerConfig(
    paths,
    koedServerConfigEnvironment(environment, repoEnv)
  );
  const initialServiceEnv = localServiceEnv(
    environment,
    repoEnv,
    apiToken,
    paths
  );
  const useBundledLocalDependencies = config.dependencyMode === "bundled-local";
  const teamCollaborationEnabled = resolveTeamCollaborationEnabled({
    ...repoEnv,
    ...environment
  });
  const localAiRuntimeEnabled = config.runtimeMode !== "external";
  const runtimeServices = useBundledLocalDependencies
    ? [
        "postgres-native",
        "embedding-service-native",
        ...(teamCollaborationEnabled ? ["privacy-service-native"] : [])
      ]
    : [];
  const appServices = [
    "api",
    "worker",
    ...(localAiRuntimeEnabled ? ["local-ai-runtime"] : [])
  ];
  const childEnv = initialServiceEnv;

  if (appRuntime.kind === "source") {
    runCommand(
      paths,
      "Prepare Koed environment",
      process.execPath,
      [resolve(paths.repoRoot, "scripts/setup-env.mjs")],
      childEnv,
      spawnSync
    );
  }

  const refreshedRepoEnv = loadRepoEnv(paths.repoRoot, environment);
  const refreshedApiToken = desktopManagedLocal
    ? null
    : resolveLocalApiToken(environment, refreshedRepoEnv);
  if (refreshedApiToken) {
    writeLocalAppCredential(paths, {
      apiToken: refreshedApiToken.token,
      provisionedAt: new Date().toISOString(),
      source: refreshedApiToken.source
    });
  }
  const refreshedEnv = localServiceEnv(
    environment,
    refreshedRepoEnv,
    refreshedApiToken,
    paths
  );
  const apiUrl = resolveApiUrl(environment, refreshedRepoEnv);

  let startedNativePostgres = false;
  let nativeEmbeddingProcess: ChildProcess | undefined;
  let nativePrivacyProcess: ChildProcess | undefined;
  const managedChildren: Record<string, ChildProcess> = {};
  const managedProcessMonitor = createManagedProcessMonitor({
    expectedSignals: []
  });
  const managedProcessOutcome = managedProcessMonitor.result.then(
    () => ({ error: null }),
    (error: unknown) => ({ error })
  );
  const manageChild = (name: string, child: ChildProcess): ChildProcess => {
    managedChildren[name] = child;
    managedProcessMonitor.watch(name, child);
    return child;
  };
  let runtimeStateWritten = false;
  let stopSupervisorExitMonitor: () => void = () => undefined;
  const runtimeStateOwnedByCurrentProcess = (): boolean => {
    try {
      const runtime = JSON.parse(
        readFileSync(paths.runtimeStatePath, "utf8")
      ) as Partial<KoedServerRuntimeState>;
      return (
        runtime.pid === process.pid && runtime.startedAt === supervisorStartedAt
      );
    } catch {
      return false;
    }
  };

  let cleanupPromise: Promise<void> | undefined;
  const cleanupStartedResources = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const cleanupErrors: string[] = [];
      const shutdownOrder = [
        "localAiRuntime",
        "worker",
        "api",
        "privacyService",
        "embeddingService"
      ];
      for (const name of shutdownOrder) {
        try {
          await stopChildProcess(managedChildren[name], 5_000, name);
        } catch (error) {
          cleanupErrors.push(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      if (
        nativeEmbeddingProcess &&
        !Object.values(managedChildren).includes(nativeEmbeddingProcess)
      ) {
        try {
          await stopChildProcess(
            nativeEmbeddingProcess,
            5_000,
            "embeddingService"
          );
        } catch (error) {
          cleanupErrors.push(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      if (startedNativePostgres) {
        const stopped = stopLocalPostgresRuntime(paths, refreshedEnv, {
          spawnSync
        });
        startedNativePostgres = false;
        if (!stopped.ok) {
          cleanupErrors.push(stopped.error ?? stopped.message);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new Error(cleanupErrors.join("; "));
      }
    })();
    return cleanupPromise;
  };
  let requestShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolveShutdown) => {
    requestShutdown = resolveShutdown;
  });
  const shutdown = () => requestShutdown();
  if (signal?.aborted) requestShutdown();
  else signal?.addEventListener("abort", shutdown, { once: true });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const stopSupervisorLogMaintenance = maintainSupervisorLog(refreshedEnv);
  try {
    if (config.dependencyMode === "external") {
      const queueBackend = resolveWorkQueueBackend(
        refreshedEnv.WORK_QUEUE_BACKEND
      );
      const requiredExternalServices: Array<[string, string | undefined]> = [
        ["DATABASE_URL", refreshedEnv.DATABASE_URL],
        ...(queueBackend === "bullmq"
          ? [
              ["REDIS_URL", refreshedEnv.REDIS_URL] as [
                string,
                string | undefined
              ]
            ]
          : []),
        ["EMBEDDING_SERVICE_URL", refreshedEnv.EMBEDDING_SERVICE_URL]
      ];
      if (teamCollaborationEnabled) {
        requiredExternalServices.push(
          ["PRIVACY_SERVICE_URL", refreshedEnv.PRIVACY_SERVICE_URL],
          ["PRIVACY_SERVICE_TOKEN", refreshedEnv.PRIVACY_SERVICE_TOKEN],
          [
            "PRIVACY_RUNTIME_CONTROL_TOKEN",
            refreshedEnv.PRIVACY_RUNTIME_CONTROL_TOKEN
          ]
        );
      }
      const missing = requiredExternalServices.flatMap(([name, value]) =>
        value?.trim() ? [] : [name]
      );
      if (missing.length > 0) {
        throw new Error(
          `External dependency mode requires Operator-managed service configuration: ${missing.join(", ")}. Set values in KOED_HOME/config/server.json or environment.`
        );
      }
    } else {
      const queueBackend = resolveWorkQueueBackend(
        refreshedEnv.WORK_QUEUE_BACKEND
      );
      if (queueBackend === "bullmq" && !refreshedEnv.REDIS_URL?.trim()) {
        throw new Error(
          "Bundled-local mode with WORK_QUEUE_BACKEND=bullmq requires an Operator-managed Redis URL. Set REDIS_URL or use WORK_QUEUE_BACKEND=local."
        );
      }
    }

    if (appRuntime.kind === "source") {
      runCommand(
        paths,
        "Build Koed server apps",
        "pnpm",
        [
          "--filter",
          "@koed/api",
          "--filter",
          "@koed/worker",
          "--filter",
          "@koed/embedding-service",
          "--filter",
          "@koed/privacy-service",
          "--filter",
          "@koed/mcp-server",
          "build"
        ],
        refreshedEnv,
        spawnSync
      );
    }

    if (useBundledLocalDependencies) {
      const result = startLocalPostgresRuntime(paths, refreshedEnv, {
        spawnSync
      });
      Object.assign(refreshedEnv, result.env);
      startedNativePostgres = result.started;
      if (!result.ok) {
        throw new Error(
          `Bundled-local native Postgres could not start: ${result.status.message ?? result.status.state}${localRuntimeFailureDetails(result.status.details)}${result.status.action ? ` ${result.status.action}` : ""}`
        );
      }
    }

    if (useBundledLocalDependencies && teamCollaborationEnabled) {
      const result = await startLocalPrivacyRuntime(paths, refreshedEnv, {
        spawn
      });
      Object.assign(refreshedEnv, result.env);
      nativePrivacyProcess = result.process;
      if (nativePrivacyProcess) {
        manageChild("privacyService", nativePrivacyProcess);
      }
      if (!result.ok) {
        throw new Error(
          `Bundled-local Privacy Filter Service could not start: ${result.status.message ?? result.status.state}${result.status.action ? ` ${result.status.action}` : ""}`
        );
      }
    }

    if (useBundledLocalDependencies) {
      const result = startLocalEmbeddingRuntime(
        paths,
        appProcessEnvironment(refreshedEnv),
        { spawn }
      );
      Object.assign(refreshedEnv, result.env);
      nativeEmbeddingProcess = result.process;
      if (nativeEmbeddingProcess) {
        manageChild("embeddingService", nativeEmbeddingProcess);
      }
      if (!result.ok) {
        throw new Error(
          `Bundled-local native Embedding Service could not start: ${result.status.message ?? result.status.state}${result.status.action ? ` ${result.status.action}` : ""}`
        );
      }
    }

    const api =
      appRuntime.kind === "packaged"
        ? spawnManagedProcess(
            paths,
            "API",
            process.execPath,
            [appRuntime.apiEntry],
            appProcessEnvironment(refreshedEnv),
            spawn,
            resolve(appRuntime.root, "api")
          )
        : spawnManagedProcess(
            paths,
            "API",
            process.execPath,
            [resolve(paths.repoRoot, "apps/api/dist/index.js")],
            appProcessEnvironment(refreshedEnv),
            spawn,
            resolve(paths.repoRoot, "apps/api")
          );
    manageChild("api", api);

    const runtime: KoedServerRuntimeState = {
      pid: process.pid,
      startedAt: supervisorStartedAt,
      repoRoot: paths.repoRoot,
      apiUrl,
      runtimeMode: config.runtimeMode,
      dependencyMode: config.dependencyMode,
      automaticPorts: desktopManagedLocal,
      codexTranscriptWatcherEnabled: config.codexTranscriptWatcherEnabled,
      claudeTranscriptWatcherEnabled: config.claudeTranscriptWatcherEnabled,
      services: [...runtimeServices, "api"],
      processes: {
        ...(nativeEmbeddingProcess
          ? { embeddingService: nativeEmbeddingProcess.pid ?? 0 }
          : {}),
        ...(nativePrivacyProcess
          ? { privacyService: nativePrivacyProcess.pid ?? 0 }
          : {}),
        api: api.pid ?? 0
      }
    };
    const persistRuntime = (): void => {
      writeFileSync(
        paths.runtimeStatePath,
        `${JSON.stringify(runtime, null, 2)}\n`,
        {
          mode: 0o600
        }
      );
      runtimeStateWritten = true;
    };
    persistRuntime();
    stopSupervisorExitMonitor = monitorSupervisorExitRequest(
      paths,
      {
        pid: process.pid,
        startedAt: supervisorStartedAt
      },
      {
        onExit: requestShutdown
      }
    );

    let status = await waitForHealthyOrReady({
      environment: refreshedEnv,
      timeoutMs,
      pollIntervalMs,
      collectStatus,
      isReady: (candidate) =>
        candidate.api.state === "healthy" &&
        candidate.database.state === "healthy"
    });
    if (status.api.state !== "healthy" || status.database.state !== "healthy") {
      throw new Error(
        "API and database did not become ready before local credential provisioning."
      );
    }
    if (desktopManagedLocal) {
      const desktopApiToken = await provisionDesktopApiToken(
        paths,
        appRuntime,
        refreshedEnv
      );
      if (desktopApiToken) {
        Object.assign(refreshedEnv, {
          MEMORY_API_TOKEN: desktopApiToken
        });
      }
    }

    let localAiRuntime: ChildProcess | undefined;
    if (localAiRuntimeEnabled) {
      const finalApiToken = resolveActiveIntegrationApiToken(
        paths,
        refreshedEnv,
        refreshedRepoEnv
      )?.token;
      if (!finalApiToken) {
        throw new Error(
          "A Personal API Token is required to start the local AI runtime."
        );
      }
      localAiRuntime = spawnManagedProcess(
        paths,
        "Local AI Runtime",
        process.execPath,
        [appRuntime.localAiRuntime],
        {
          ...appProcessEnvironment(refreshedEnv),
          KOED_HOME: paths.koedHome,
          MEMORY_API_URL: apiUrl,
          MEMORY_API_TOKEN: finalApiToken,
          MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: String(
            config.codexTranscriptWatcherEnabled
          ),
          MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED: String(
            config.claudeTranscriptWatcherEnabled
          )
        },
        spawn,
        appRuntime.kind === "packaged"
          ? resolve(appRuntime.root, "mcp-server")
          : resolve(paths.repoRoot, "packages", "mcp-server")
      );
      manageChild("localAiRuntime", localAiRuntime);
    }

    const worker =
      appRuntime.kind === "packaged"
        ? spawnManagedProcess(
            paths,
            "Worker",
            process.execPath,
            [appRuntime.workerEntry],
            appProcessEnvironment(refreshedEnv),
            spawn,
            resolve(appRuntime.root, "worker")
          )
        : spawnManagedProcess(
            paths,
            "Worker",
            process.execPath,
            [resolve(paths.repoRoot, "apps/worker/dist/index.js")],
            appProcessEnvironment(refreshedEnv),
            spawn,
            resolve(paths.repoRoot, "apps/worker")
          );
    manageChild("worker", worker);
    runtime.services = [...runtimeServices, ...appServices];
    runtime.processes = {
      ...runtime.processes,
      ...(localAiRuntime ? { localAiRuntime: localAiRuntime.pid ?? 0 } : {}),
      worker: worker.pid ?? 0
    };
    persistRuntime();

    console.log(
      JSON.stringify(
        {
          ok: true,
          state: "starting",
          koedHome: paths.koedHome,
          apiUrl,
          services: runtime.services
        },
        null,
        2
      )
    );

    status = await waitForHealthyOrReady({
      environment: refreshedEnv,
      timeoutMs,
      pollIntervalMs,
      collectStatus
    });

    status = await collectStatus(refreshedEnv);
    console.log(
      JSON.stringify(
        {
          ok: status.api.state === "healthy",
          state: status.state,
          api: status.api,
          database: status.database,
          redis: status.redis,
          embeddingService: status.embeddingService,
          privacyService: status.privacyService,
          workerQueues: status.workerQueues
        },
        null,
        2
      )
    );
    console.log(
      "Koed server supervisor is running. Press Ctrl-C to stop local app processes."
    );

    await Promise.race([
      shutdownRequested,
      managedProcessOutcome.then(({ error }) => {
        if (error) throw error;
      })
    ]);
    await cleanupStartedResources();
  } catch (error) {
    try {
      await cleanupStartedResources();
      if (runtimeStateOwnedByCurrentProcess()) {
        rmSync(paths.runtimeStatePath, { force: true });
      }
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError }
      );
    }
    throw error;
  } finally {
    stopSupervisorExitMonitor();
    stopSupervisorLogMaintenance();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    signal?.removeEventListener("abort", shutdown);
    managedProcessMonitor.dispose();
    if (runtimeStateWritten && runtimeStateOwnedByCurrentProcess()) {
      rmSync(paths.runtimeStatePath, { force: true });
    }
    releaseKoedServerSupervisorLock(supervisorLock);
  }
};
