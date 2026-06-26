import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnSyncReturns
} from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveKoedServerConfig, type KoedServerConfig } from "./config.js";
import {
  resolveLocalApiToken,
  writeExplorerCredential
} from "./credentials.js";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import { resolveLocalModelManifest } from "./local-models-runtime.js";
import {
  resolveBundledPostgresMode,
  startLocalPostgresRuntime
} from "./local-postgres-runtime.js";
import {
  ensureKoedHome,
  resolveKoedServerPaths,
  type KoedServerPaths
} from "./paths.js";
import { collectKoedServerStatus } from "./status.js";
import type { KoedServerRuntimeState } from "./types.js";

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
  spawnSync: SpawnSyncLike
): void => {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd: paths.repoRoot,
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

const spawnManagedProcess = (
  paths: KoedServerPaths,
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  spawn: SpawnLike
): ChildProcess => {
  console.log(`> Start ${label}`);
  const child = spawn(command, args, {
    cwd: paths.repoRoot,
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
      lastStatus.embeddingService.state === "healthy"
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

const resolveEffectiveWorkQueueBackend = (
  config: KoedServerConfig,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): "bullmq" | "local" => {
  if (environment.WORK_QUEUE_BACKEND) {
    return resolveWorkQueueBackend(environment.WORK_QUEUE_BACKEND);
  }
  if (repoEnv.WORK_QUEUE_BACKEND) {
    return resolveWorkQueueBackend(repoEnv.WORK_QUEUE_BACKEND);
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

const localServiceEnv = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  apiToken: ReturnType<typeof resolveLocalApiToken> | null,
  paths: KoedServerPaths
): NodeJS.ProcessEnv => {
  const apiPort = environment.API_HOST_PORT ?? repoEnv.API_HOST_PORT ?? "3300";
  const redisPort =
    environment.REDIS_HOST_PORT ?? repoEnv.REDIS_HOST_PORT ?? "16379";
  const embeddingPort =
    environment.EMBEDDING_SERVICE_HOST_PORT ??
    repoEnv.EMBEDDING_SERVICE_HOST_PORT ??
    "3800";
  const redisUrl = `redis://localhost:${redisPort}`;
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
  const mountedModelDirs = new Set(installedModelPaths.map(dirname));
  if (mountedModelDirs.size > 1) {
    throw new Error(
      `Bundled-local model paths must be in one directory so Docker Compose can mount them under /models. Move installed model files into ${paths.modelsDir} or set KOED_EMBEDDING_MODEL_PATH and KOED_RERANKER_MODEL_PATH to files in the same directory.`
    );
  }
  const localEmbeddingModelPath = existsSync(embeddingModel.modelPath)
    ? `/models/${basename(embeddingModel.modelPath)}`
    : undefined;
  const localRerankerModelPath = existsSync(rerankerModel.modelPath)
    ? `/models/${basename(rerankerModel.modelPath)}`
    : undefined;
  const mountedModelsDir = installedModelPaths[0]
    ? dirname(installedModelPaths[0])
    : paths.modelsDir;
  return {
    ...process.env,
    ...repoEnv,
    ...(apiToken ? { VITE_KOED_API_TOKEN: apiToken.token } : {}),
    ...environment,
    NODE_ENV: repoEnv.API_NODE_ENV ?? environment.NODE_ENV ?? "production",
    LOG_LEVEL: repoEnv.API_LOG_LEVEL ?? environment.LOG_LEVEL,
    WORK_QUEUE_BACKEND: queueBackend,
    KOED_MODELS_DIR: mountedModelsDir,
    WORKER_LOG_LEVEL: repoEnv.WORKER_LOG_LEVEL ?? environment.WORKER_LOG_LEVEL,
    API_PORT: apiPort,
    DATABASE_URL:
      serverConfig.dependencyMode === "external"
        ? (serverConfig.external?.databaseUrl ??
          environment.DATABASE_URL ??
          repoEnv.DATABASE_URL)
        : (repoEnv.DATABASE_URL ?? environment.DATABASE_URL),
    REDIS_URL:
      serverConfig.dependencyMode === "external"
        ? (serverConfig.external?.redisUrl ??
          environment.REDIS_URL ??
          repoEnv.REDIS_URL)
        : (environment.REDIS_URL ?? repoEnv.REDIS_URL ?? redisUrl),
    RATE_LIMIT_REDIS_URL: repoEnv.API_RATE_LIMIT_REDIS_URL ?? "",
    CACHE_REDIS_URL: repoEnv.API_CACHE_REDIS_URL ?? "",
    DATA_ENCRYPTION_KEY:
      repoEnv.API_DATA_ENCRYPTION_KEY ?? environment.DATA_ENCRYPTION_KEY,
    API_TOKEN_PEPPER: repoEnv.API_TOKEN_PEPPER ?? environment.API_TOKEN_PEPPER,
    EMBEDDING_SERVICE_URL:
      serverConfig.dependencyMode === "external"
        ? (serverConfig.external?.embeddingServiceUrl ??
          environment.EMBEDDING_SERVICE_URL ??
          repoEnv.EMBEDDING_SERVICE_URL)
        : (environment.EMBEDDING_SERVICE_URL ??
          repoEnv.EMBEDDING_SERVICE_URL ??
          embeddingServiceUrl),
    EMBEDDING_SERVICE_TOKEN:
      repoEnv.EMBEDDING_SERVICE_TOKEN ?? environment.EMBEDDING_SERVICE_TOKEN,
    EMBEDDING_MODEL: repoEnv.EMBEDDING_MODEL_KEY ?? environment.EMBEDDING_MODEL,
    EMBEDDING_MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localEmbeddingModelPath
        : environment.EMBEDDING_MODEL_PATH,
    RERANKER_KEY: repoEnv.EMBEDDING_RERANKER_KEY ?? environment.RERANKER_KEY,
    EMBEDDING_RERANKER_MODEL_PATH:
      serverConfig.dependencyMode === "bundled-local"
        ? localRerankerModelPath
        : (repoEnv.EMBEDDING_RERANKER_MODEL_PATH ??
          environment.EMBEDDING_RERANKER_MODEL_PATH),
    CORS_ORIGINS: repoEnv.API_CORS_ORIGINS ?? environment.CORS_ORIGINS,
    COOKIE_SECURE: repoEnv.API_COOKIE_SECURE ?? environment.COOKIE_SECURE,
    EXPLORER_API_BASE_URL: resolveApiUrl(environment, repoEnv),
    VITE_KOED_API_BASE_URL: resolveApiUrl(environment, repoEnv)
  };
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
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });

  const repoEnv = loadRepoEnv(paths.repoRoot);
  const apiToken = resolveLocalApiToken(environment, repoEnv);
  if (apiToken) {
    writeExplorerCredential(paths, {
      apiToken: apiToken.token,
      provisionedAt: new Date().toISOString(),
      source: apiToken.source
    });
  }
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const explorerUrl = resolveExplorerUrl(environment, repoEnv);
  const config = resolveKoedServerConfig(
    paths,
    koedServerConfigEnvironment(environment, repoEnv)
  );
  const initialQueueBackend = resolveEffectiveWorkQueueBackend(
    config,
    environment,
    repoEnv
  );
  const initialServiceEnv = localServiceEnv(
    environment,
    repoEnv,
    apiToken,
    paths
  );
  const useNativePostgres =
    config.dependencyMode === "bundled-local" &&
    resolveBundledPostgresMode(paths, initialServiceEnv) === "native";
  const dependencyServices =
    config.dependencyMode === "external"
      ? []
      : [
          ...(useNativePostgres ? [] : ["postgres"]),
          ...(initialQueueBackend === "bullmq" ? ["redis"] : []),
          "embedding-service"
        ];
  const runtimeServices =
    config.dependencyMode === "external"
      ? []
      : [
          useNativePostgres ? "postgres-native" : "postgres",
          ...(initialQueueBackend === "bullmq" ? ["redis"] : []),
          "embedding-service"
        ];
  const appServices = ["api", "worker", "explorer"];
  const childEnv = initialServiceEnv;

  runCommand(
    paths,
    "Prepare Koed environment",
    process.execPath,
    [resolve(paths.repoRoot, "scripts/setup-env.mjs")],
    childEnv,
    spawnSync
  );

  const refreshedRepoEnv = loadRepoEnv(paths.repoRoot);
  const refreshedApiToken = resolveLocalApiToken(environment, refreshedRepoEnv);
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
  }

  if (useNativePostgres) {
    const result = startLocalPostgresRuntime(paths, refreshedEnv, {
      spawnSync
    });
    Object.assign(refreshedEnv, result.env);
    if (!result.ok) {
      throw new Error(
        `Bundled-local native Postgres could not start: ${result.status.message ?? result.status.state}${result.status.action ? ` ${result.status.action}` : ""}`
      );
    }
  }

  if (config.dependencyMode !== "external" && dependencyServices.length > 0) {
    runCommand(
      paths,
      "Start Koed container dependencies",
      "docker",
      [
        "compose",
        "up",
        "-d",
        "--build",
        "--remove-orphans",
        ...dependencyServices
      ],
      refreshedEnv,
      spawnSync
    );
  }
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
      "@koed/explorer",
      "build"
    ],
    refreshedEnv,
    spawnSync
  );

  const children = {
    api: spawnManagedProcess(
      paths,
      "API",
      "pnpm",
      ["--filter", "@koed/api", "start"],
      refreshedEnv,
      spawn
    ),
    worker: spawnManagedProcess(
      paths,
      "Worker",
      "pnpm",
      ["--filter", "@koed/worker", "start"],
      refreshedEnv,
      spawn
    ),
    explorer: spawnManagedProcess(
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
        "127.0.0.1",
        "--port",
        refreshedRepoEnv.EXPLORER_WEB_HOST_PORT ??
          environment.EXPLORER_WEB_HOST_PORT ??
          "5174"
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

  const status = await waitForHealthyOrReady({
    environment: refreshedEnv,
    timeoutMs,
    pollIntervalMs,
    collectStatus
  });
  console.log(
    JSON.stringify(
      {
        ok: status.api.state === "healthy",
        state: status.state,
        api: status.api,
        database: status.database,
        redis: status.redis,
        embeddingService: status.embeddingService
      },
      null,
      2
    )
  );
  console.log(
    "Koed server supervisor is running. Press Ctrl-C to stop local app processes."
  );

  const shutdown = () => {
    for (const child of Object.values(children)) {
      child.kill("SIGTERM");
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
};
