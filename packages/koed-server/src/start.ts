import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnSyncReturns
} from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveLocalApiToken,
  writeExplorerCredential
} from "./credentials.js";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
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
      lastStatus.redis.state === "healthy"
    ) {
      return lastStatus;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollIntervalMs));
  }
  return lastStatus;
};

const localServiceEnv = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  apiToken: ReturnType<typeof resolveLocalApiToken> | null
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
  return {
    ...process.env,
    ...repoEnv,
    ...(apiToken ? { VITE_KOED_API_TOKEN: apiToken.token } : {}),
    ...environment,
    NODE_ENV: repoEnv.API_NODE_ENV ?? environment.NODE_ENV ?? "production",
    LOG_LEVEL: repoEnv.API_LOG_LEVEL ?? environment.LOG_LEVEL,
    WORKER_LOG_LEVEL: repoEnv.WORKER_LOG_LEVEL ?? environment.WORKER_LOG_LEVEL,
    API_PORT: apiPort,
    DATABASE_URL: repoEnv.DATABASE_URL ?? environment.DATABASE_URL,
    REDIS_URL: redisUrl,
    RATE_LIMIT_REDIS_URL: repoEnv.API_RATE_LIMIT_REDIS_URL ?? "",
    CACHE_REDIS_URL: repoEnv.API_CACHE_REDIS_URL ?? "",
    DATA_ENCRYPTION_KEY:
      repoEnv.API_DATA_ENCRYPTION_KEY ?? environment.DATA_ENCRYPTION_KEY,
    API_TOKEN_PEPPER: repoEnv.API_TOKEN_PEPPER ?? environment.API_TOKEN_PEPPER,
    EMBEDDING_SERVICE_URL: embeddingServiceUrl,
    EMBEDDING_SERVICE_TOKEN:
      repoEnv.EMBEDDING_SERVICE_TOKEN ?? environment.EMBEDDING_SERVICE_TOKEN,
    EMBEDDING_MODEL: repoEnv.EMBEDDING_MODEL_KEY ?? environment.EMBEDDING_MODEL,
    RERANKER_KEY: repoEnv.EMBEDDING_RERANKER_KEY ?? environment.RERANKER_KEY,
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
  const dependencyServices = ["postgres", "redis", "embedding-service"];
  const appServices = ["api", "worker", "explorer"];
  const childEnv = localServiceEnv(environment, repoEnv, apiToken);

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
    refreshedApiToken
  );

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
    services: [...dependencyServices, ...appServices],
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
        redis: status.redis
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
