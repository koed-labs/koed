import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnSyncReturns
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertKoedAppRuntimeAvailable,
  resolveKoedAppRuntime,
  type KoedAppRuntime
} from "./app-runtime.js";
import { resolveKoedServerConfig, type KoedServerConfig } from "./config.js";
import {
  resolveLocalApiToken,
  writeExplorerCredential
} from "./credentials.js";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import { startLocalEmbeddingRuntime } from "./local-embedding-runtime.js";
import { resolveLocalModelManifest } from "./local-models-runtime.js";
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
import { collectKoedServerStatus } from "./status.js";
import { stopKoedServer } from "./stop.js";
import type { KoedServerRuntimeState } from "./types.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

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

const parseCreatedApiToken = (output: string): string | null => {
  const match = /^Token:\s*(\S+)$/m.exec(output);
  return match?.[1] ?? null;
};

const importRuntimeDbModule = async <T>(
  runtime: KoedAppRuntime,
  modulePath: string
): Promise<T> =>
  import(
    pathToFileURL(resolve(runtime.dbPackageRoot, modulePath)).href
  ) as Promise<T>;

const createOpaqueSecret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

const hashApiToken = (apiTokenPepper: string, token: string): string =>
  createHash("sha256").update(`${apiTokenPepper}${token}`).digest("hex");

const provisionPackagedDesktopApiToken = async (
  paths: KoedServerPaths,
  runtime: KoedAppRuntime,
  environment: NodeJS.ProcessEnv
): Promise<string> => {
  const [{ createDbPool }, { createDb }, { createUserApiTokenRepository }] =
    await Promise.all([
      importRuntimeDbModule<{
        createDbPool: (config?: { connectionString?: string }) => unknown;
      }>(runtime, "dist/connection.js"),
      importRuntimeDbModule<{ createDb: (pool: unknown) => unknown }>(
        runtime,
        "dist/connection.js"
      ),
      importRuntimeDbModule<{
        createUserApiTokenRepository: (db: unknown) => {
          findUserByEmail: (email: string) => Promise<{ id: string } | null>;
          createUser: (input: {
            email: string;
            displayName: string | null;
            passwordHash: string | null;
          }) => Promise<{ id: string }>;
          createApiToken: (input: {
            ownerUserId: string;
            name: string;
            tokenHash: string;
            tokenPrefix: string;
            scopes: string[];
            audit: { actorUserId: string | null; actorType: string };
          }) => Promise<unknown>;
        };
      }>(runtime, "dist/user-api-token-repository.js")
    ]);
  if (!environment.API_TOKEN_PEPPER?.trim()) {
    throw new Error(
      "API_TOKEN_PEPPER is required before provisioning Desktop API Token."
    );
  }
  const pool = createDbPool({
    connectionString: environment.DATABASE_URL
  }) as { end: () => Promise<void> };
  try {
    const repo = createUserApiTokenRepository(createDb(pool));
    const email = "desktop@koed.local";
    const owner =
      (await repo.findUserByEmail(email)) ??
      (await repo.createUser({
        email,
        displayName: null,
        passwordHash: null
      }));
    const token = createOpaqueSecret("cmt");
    await repo.createApiToken({
      ownerUserId: owner.id,
      name: "Koed Desktop",
      tokenHash: hashApiToken(environment.API_TOKEN_PEPPER, token),
      tokenPrefix: token.slice(0, 12),
      scopes: [],
      audit: { actorUserId: null, actorType: "local_operator_script" }
    });
    writeExplorerCredential(paths, {
      apiToken: token,
      provisionedAt: new Date().toISOString(),
      source: "environment"
    });
    return token;
  } finally {
    await pool.end();
  }
};

export const provisionDesktopApiToken = async (
  paths: KoedServerPaths,
  runtime: KoedAppRuntime,
  environment: NodeJS.ProcessEnv,
  spawnSync: SpawnSyncLike
): Promise<string | null> => {
  if (environment.KOED_AUTO_PORTS !== "1") {
    return null;
  }
  console.log("> Provision Koed Desktop API Token");
  if (runtime.kind === "packaged") {
    return provisionPackagedDesktopApiToken(paths, runtime, environment);
  }
  const result = spawnSync(
    "pnpm",
    [
      "api-token:create",
      "--owner-email",
      "desktop@koed.local",
      "--name",
      "Koed Desktop"
    ],
    {
      cwd: paths.repoRoot,
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Provision Koed Desktop API Token failed with exit code ${result.status ?? 1}: ${(result.stderr || result.stdout || "").trim()}`
    );
  }
  const token = parseCreatedApiToken(result.stdout ?? "");
  if (!token) {
    throw new Error("Provision Koed Desktop API Token did not return a token.");
  }
  writeExplorerCredential(paths, {
    apiToken: token,
    provisionedAt: new Date().toISOString(),
    source: "environment"
  });
  return token;
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
  collectStatus
}: {
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  pollIntervalMs: number;
  collectStatus: typeof collectKoedServerStatus;
}) => {
  const startedAt = Date.now();
  let lastStatus = await collectStatus(environment);
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await collectStatus(environment);
    if (
      lastStatus.api.state === "healthy" &&
      lastStatus.database.state === "healthy" &&
      lastStatus.redis.state === "healthy" &&
      lastStatus.embeddingService.state === "healthy" &&
      lastStatus.workerQueues.state === "healthy"
    ) {
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
    repoEnv.KOED_EXTERNAL_EMBEDDING_SERVICE_URL
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

const readLocalServiceSecrets = (
  paths: KoedServerPaths
): Record<string, string> => {
  try {
    return JSON.parse(
      readFileSync(
        resolve(paths.configDir, "local-service-secrets.json"),
        "utf8"
      )
    ) as Record<string, string>;
  } catch {
    return {};
  }
};

const ensurePackagedLocalServiceSecrets = (
  paths: KoedServerPaths,
  runtime: KoedAppRuntime,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  if (runtime.kind !== "packaged") {
    return environment;
  }
  const secretsPath = resolve(paths.configDir, "local-service-secrets.json");
  const existing = readLocalServiceSecrets(paths);
  const secrets = {
    POSTGRES_PASSWORD:
      existing.POSTGRES_PASSWORD ?? randomBytes(32).toString("base64url"),
    API_DATA_ENCRYPTION_KEY:
      existing.API_DATA_ENCRYPTION_KEY ?? randomBytes(32).toString("base64"),
    API_TOKEN_PEPPER:
      existing.API_TOKEN_PEPPER ?? randomBytes(48).toString("base64url"),
    EMBEDDING_SERVICE_TOKEN:
      existing.EMBEDDING_SERVICE_TOKEN ?? randomBytes(32).toString("base64url")
  };
  writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600
  });
  return {
    ...secrets,
    ...environment
  };
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
  try {
    const explorerOrigin = new URL(resolveExplorerUrl(environment, repoEnv))
      .origin;
    configured.push(explorerOrigin);
  } catch {
    // Keep configured origins only.
  }
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
    ...(apiToken ? { VITE_KOED_API_TOKEN: apiToken.token } : {}),
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
    WORKER_LOG_LEVEL: repoEnv.WORKER_LOG_LEVEL ?? environment.WORKER_LOG_LEVEL,
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
    API_TOKEN_PEPPER: environment.API_TOKEN_PEPPER ?? repoEnv.API_TOKEN_PEPPER,
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
    EMBEDDING_MODEL:
      repoEnv.EMBEDDING_MODEL_KEY ??
      environment.EMBEDDING_MODEL_KEY ??
      environment.EMBEDDING_MODEL ??
      embeddingModel.key,
    MODEL_KEY:
      repoEnv.EMBEDDING_MODEL_KEY ??
      environment.EMBEDDING_MODEL_KEY ??
      environment.MODEL_KEY ??
      environment.EMBEDDING_MODEL ??
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
      repoEnv.EMBEDDING_RERANKER_KEY ??
      environment.EMBEDDING_RERANKER_KEY ??
      environment.RERANKER_KEY,
    EMBEDDING_RERANKER_MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localRerankerModelPath
        : (repoEnv.EMBEDDING_RERANKER_MODEL_PATH ??
          environment.EMBEDDING_RERANKER_MODEL_PATH),
    RERANKER_MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localRerankerModelPath
        : (repoEnv.EMBEDDING_RERANKER_MODEL_PATH ??
          environment.EMBEDDING_RERANKER_MODEL_PATH ??
          repoEnv.RERANKER_MODEL_PATH ??
          environment.RERANKER_MODEL_PATH),
    LLAMA_SERVER_BINARY:
      environment.LLAMA_SERVER_BINARY ??
      repoEnv.EMBEDDING_LLAMA_SERVER_BINARY ??
      environment.EMBEDDING_LLAMA_SERVER_BINARY,
    LLAMA_N_CTX:
      repoEnv.EMBEDDING_LLAMA_N_CTX ??
      environment.EMBEDDING_LLAMA_N_CTX ??
      environment.LLAMA_N_CTX,
    LLAMA_N_THREADS:
      repoEnv.EMBEDDING_LLAMA_N_THREADS ??
      environment.EMBEDDING_LLAMA_N_THREADS ??
      environment.LLAMA_N_THREADS,
    LLAMA_N_BATCH:
      repoEnv.EMBEDDING_LLAMA_N_BATCH ??
      environment.EMBEDDING_LLAMA_N_BATCH ??
      environment.LLAMA_N_BATCH,
    LLAMA_BATCH_TOKEN_HEADROOM:
      repoEnv.EMBEDDING_LLAMA_BATCH_TOKEN_HEADROOM ??
      environment.EMBEDDING_LLAMA_BATCH_TOKEN_HEADROOM ??
      environment.LLAMA_BATCH_TOKEN_HEADROOM,
    LLAMA_N_UBATCH:
      repoEnv.EMBEDDING_LLAMA_N_UBATCH ??
      environment.EMBEDDING_LLAMA_N_UBATCH ??
      environment.LLAMA_N_UBATCH,
    LLAMA_PARALLEL:
      repoEnv.EMBEDDING_LLAMA_PARALLEL ??
      environment.EMBEDDING_LLAMA_PARALLEL ??
      environment.LLAMA_PARALLEL,
    LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS:
      repoEnv.EMBEDDING_LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS ??
      environment.EMBEDDING_LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS ??
      environment.LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS,
    LLAMA_EMBEDDING_SERVER_PORT:
      repoEnv.EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT ??
      environment.EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT ??
      environment.LLAMA_EMBEDDING_SERVER_PORT,
    RERANKER_BATCH_LIMIT:
      repoEnv.EMBEDDING_RERANKER_BATCH_LIMIT ??
      environment.EMBEDDING_RERANKER_BATCH_LIMIT ??
      environment.RERANKER_BATCH_LIMIT,
    RERANKER_CONTEXT_PER_SLOT:
      repoEnv.EMBEDDING_RERANKER_CONTEXT_PER_SLOT ??
      environment.EMBEDDING_RERANKER_CONTEXT_PER_SLOT ??
      environment.RERANKER_CONTEXT_PER_SLOT,
    LLAMA_RERANKER_SERVER_PORT:
      repoEnv.EMBEDDING_LLAMA_RERANKER_SERVER_PORT ??
      environment.EMBEDDING_LLAMA_RERANKER_SERVER_PORT ??
      environment.LLAMA_RERANKER_SERVER_PORT,
    RERANKER_LLAMA_N_CTX:
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_CTX ??
      environment.EMBEDDING_RERANKER_LLAMA_N_CTX ??
      environment.RERANKER_LLAMA_N_CTX,
    RERANKER_LLAMA_N_THREADS:
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_THREADS ??
      environment.EMBEDDING_RERANKER_LLAMA_N_THREADS ??
      environment.RERANKER_LLAMA_N_THREADS,
    RERANKER_LLAMA_N_BATCH:
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_BATCH ??
      environment.EMBEDDING_RERANKER_LLAMA_N_BATCH ??
      environment.RERANKER_LLAMA_N_BATCH,
    RERANKER_LLAMA_N_UBATCH:
      repoEnv.EMBEDDING_RERANKER_LLAMA_N_UBATCH ??
      environment.EMBEDDING_RERANKER_LLAMA_N_UBATCH ??
      environment.RERANKER_LLAMA_N_UBATCH,
    RERANKER_PARALLEL:
      repoEnv.EMBEDDING_RERANKER_PARALLEL ??
      environment.EMBEDDING_RERANKER_PARALLEL ??
      environment.RERANKER_PARALLEL,
    RERANKER_PROMPT_CACHE_ENABLED:
      repoEnv.EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED ??
      environment.EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED ??
      environment.RERANKER_PROMPT_CACHE_ENABLED,
    CORS_ORIGINS: corsOrigins(environment, repoEnv),
    COOKIE_SECURE: repoEnv.API_COOKIE_SECURE ?? environment.COOKIE_SECURE,
    EXPLORER_API_BASE_URL: resolveApiUrl(environment, repoEnv),
    VITE_KOED_API_BASE_URL: resolveApiUrl(environment, repoEnv)
  };
};

const sleepSync = (ms: number): void => {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
};

const processRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopChildProcessSync = (child: ChildProcess | undefined): void => {
  if (!child?.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (
    child.exitCode === null &&
    processRunning(child.pid) &&
    Date.now() < deadline
  ) {
    sleepSync(100);
  }
  if (child.exitCode !== null || !processRunning(child.pid)) return;
  child.kill("SIGKILL");
  const killDeadline = Date.now() + 5_000;
  while (
    child.exitCode === null &&
    processRunning(child.pid) &&
    Date.now() < killDeadline
  ) {
    sleepSync(100);
  }
  if (child.exitCode === null && processRunning(child.pid)) {
    throw new Error(
      `Timed out stopping native Embedding Service process ${child.pid}.`
    );
  }
};

export const startKoedServer = async ({
  environment = process.env,
  pollIntervalMs = 2_000,
  timeoutMs = 180_000,
  spawnSync = nodeSpawnSync as SpawnSyncLike,
  spawn = nodeSpawn as SpawnLike,
  collectStatus = collectKoedServerStatus
}: KoedServerStartOptions = {}): Promise<void> => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  const appRuntime = resolveKoedAppRuntime(paths, environment);
  assertKoedAppRuntimeAvailable(appRuntime, paths);
  environment = ensurePackagedLocalServiceSecrets(
    paths,
    appRuntime,
    environment
  );
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  environment = await allocateAndPersistLocalPorts(paths, environment);

  const repoEnv = loadRepoEnv(paths.repoRoot);
  const desktopManagedLocal = environment.KOED_AUTO_PORTS === "1";
  const apiToken = desktopManagedLocal
    ? null
    : resolveLocalApiToken(environment, repoEnv);
  if (apiToken) {
    writeExplorerCredential(paths, {
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
  const runtimeServices = useBundledLocalDependencies
    ? ["postgres-native", "embedding-service-native"]
    : [];
  const appServices = ["api", "worker", "explorer"];
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

  const refreshedRepoEnv = loadRepoEnv(paths.repoRoot);
  const refreshedApiToken = desktopManagedLocal
    ? null
    : resolveLocalApiToken(environment, refreshedRepoEnv);
  if (refreshedApiToken) {
    writeExplorerCredential(paths, {
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
  const explorerUrl = resolveExplorerUrl(environment, refreshedRepoEnv);

  let startedNativePostgres = false;
  let nativeEmbeddingProcess: ChildProcess | undefined;
  const runtimeStateOwnedByCurrentProcess = (): boolean => {
    try {
      const runtime = JSON.parse(
        readFileSync(paths.runtimeStatePath, "utf8")
      ) as Partial<KoedServerRuntimeState>;
      return runtime.pid === process.pid;
    } catch {
      return true;
    }
  };

  const cleanupStartedResources = () => {
    const cleanupErrors: string[] = [];
    try {
      stopChildProcessSync(nativeEmbeddingProcess);
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
    if (startedNativePostgres) {
      const stopped = stopLocalPostgresRuntime(paths, refreshedEnv, {
        spawnSync
      });
      if (!stopped.ok) {
        cleanupErrors.push(stopped.error ?? stopped.message);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.join("; "));
    }
  };
  const shutdown = () => {
    if (!runtimeStateOwnedByCurrentProcess()) {
      process.exit(0);
    }
    stopKoedServer({ environment: refreshedEnv, spawnSync });
    try {
      cleanupStartedResources();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
          "@koed/explorer",
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
      if (!result.ok) {
        startedNativePostgres = result.status.state !== "not_configured";
        throw new Error(
          `Bundled-local native Postgres could not start: ${result.status.message ?? result.status.state}${result.status.action ? ` ${result.status.action}` : ""}`
        );
      }
      startedNativePostgres = true;
    }

    if (useBundledLocalDependencies) {
      const result = startLocalEmbeddingRuntime(paths, refreshedEnv, {
        spawn
      });
      Object.assign(refreshedEnv, result.env);
      nativeEmbeddingProcess = result.process;
      if (!result.ok) {
        throw new Error(
          `Bundled-local native Embedding Service could not start: ${result.status.message ?? result.status.state}${result.status.action ? ` ${result.status.action}` : ""}`
        );
      }
    }

    const explorerPort = (() => {
      if (environment.EXPLORER_WEB_HOST_PORT) {
        return environment.EXPLORER_WEB_HOST_PORT;
      }
      if (refreshedRepoEnv.EXPLORER_WEB_HOST_PORT) {
        return refreshedRepoEnv.EXPLORER_WEB_HOST_PORT;
      }
      try {
        return new URL(explorerUrl).port || "5174";
      } catch {
        return "5174";
      }
    })();
    const explorerHost =
      environment.EXPLORER_WEB_HOST ??
      refreshedRepoEnv.EXPLORER_WEB_HOST ??
      "127.0.0.1";

    const children = {
      ...(nativeEmbeddingProcess
        ? { embeddingService: nativeEmbeddingProcess }
        : {}),
      api:
        appRuntime.kind === "packaged"
          ? spawnManagedProcess(
              paths,
              "API",
              process.execPath,
              [appRuntime.apiEntry],
              refreshedEnv,
              spawn,
              resolve(appRuntime.root, "api")
            )
          : spawnManagedProcess(
              paths,
              "API",
              "pnpm",
              ["--filter", "@koed/api", "start"],
              refreshedEnv,
              spawn
            ),
      worker:
        appRuntime.kind === "packaged"
          ? spawnManagedProcess(
              paths,
              "Worker",
              process.execPath,
              [appRuntime.workerEntry],
              refreshedEnv,
              spawn,
              resolve(appRuntime.root, "worker")
            )
          : spawnManagedProcess(
              paths,
              "Worker",
              "pnpm",
              ["--filter", "@koed/worker", "start"],
              refreshedEnv,
              spawn
            ),
      explorer:
        appRuntime.kind === "packaged"
          ? spawnManagedProcess(
              paths,
              "Explorer",
              process.execPath,
              [
                resolve(currentDir, "explorer-static-server.js"),
                appRuntime.explorerDist,
                "--host",
                explorerHost,
                "--port",
                explorerPort
              ],
              refreshedEnv,
              spawn,
              appRuntime.explorerDist
            )
          : spawnManagedProcess(
              paths,
              "Explorer",
              "pnpm",
              [
                "--filter",
                "@koed/explorer",
                "exec",
                "vite",
                "preview",
                "--host",
                explorerHost,
                "--port",
                explorerPort
              ],
              refreshedEnv,
              spawn
            )
    };

    const runtime: KoedServerRuntimeState = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      repoRoot: paths.repoRoot,
      apiUrl,
      explorerUrl,
      runtimeMode: config.runtimeMode,
      dependencyMode: config.dependencyMode,
      services: [...runtimeServices, ...appServices],
      processes: {
        ...(nativeEmbeddingProcess
          ? { embeddingService: nativeEmbeddingProcess.pid ?? 0 }
          : {}),
        api: children.api.pid ?? 0,
        worker: children.worker.pid ?? 0,
        explorer: children.explorer.pid ?? 0
      }
    };
    writeFileSync(
      paths.runtimeStatePath,
      `${JSON.stringify(runtime, null, 2)}\n`,
      {
        mode: 0o600
      }
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          state: "starting",
          koedHome: paths.koedHome,
          apiUrl,
          explorerUrl,
          services: runtime.services
        },
        null,
        2
      )
    );

    let status = await waitForHealthyOrReady({
      environment: refreshedEnv,
      timeoutMs,
      pollIntervalMs,
      collectStatus
    });
    if (desktopManagedLocal && status.api.state === "healthy") {
      const desktopApiToken = await provisionDesktopApiToken(
        paths,
        appRuntime,
        refreshedEnv,
        spawnSync
      );
      if (desktopApiToken) {
        Object.assign(refreshedEnv, {
          MEMORY_API_TOKEN: desktopApiToken,
          VITE_KOED_API_TOKEN: desktopApiToken
        });
        status = await collectStatus(refreshedEnv);
      }
    }
    console.log(
      JSON.stringify(
        {
          ok: status.api.state === "healthy",
          state: status.state,
          api: status.api,
          database: status.database,
          redis: status.redis,
          embeddingService: status.embeddingService,
          workerQueues: status.workerQueues
        },
        null,
        2
      )
    );
    console.log(
      "Koed server supervisor is running. Press Ctrl-C to stop local app processes."
    );

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const exits = new Set<string>();
      for (const [name, child] of Object.entries(children)) {
        child.on("exit", () => {
          exits.add(name);
          if (exits.size === Object.keys(children).length) {
            resolvePromise();
          }
        });
        child.on("error", rejectPromise);
      }
    });
  } catch (error) {
    try {
      cleanupStartedResources();
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError }
      );
    }
    throw error;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
};
