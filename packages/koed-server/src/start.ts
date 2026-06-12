import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import {
  ensureKoedHome,
  resolveKoedServerPaths,
  type KoedServerPaths
} from "./paths.js";
import { collectKoedServerStatus } from "./status.js";
import type { KoedServerRuntimeState } from "./types.js";

export interface KoedServerStartOptions {
  environment?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe";
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const runCommand = (
  paths: KoedServerPaths,
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv
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

const spawnLogFollower = (
  paths: KoedServerPaths,
  services: string[],
  environment: NodeJS.ProcessEnv
): ChildProcess =>
  spawn("docker", ["compose", "logs", "--follow", ...services], {
    cwd: paths.repoRoot,
    env: environment,
    stdio: "inherit"
  });

const waitForHealthyOrReady = async ({
  environment,
  timeoutMs,
  pollIntervalMs
}: {
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  pollIntervalMs: number;
}) => {
  const startedAt = Date.now();
  let lastStatus = await collectKoedServerStatus(environment);
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await collectKoedServerStatus(environment);
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

export const startKoedServer = async ({
  environment = process.env,
  pollIntervalMs = 2_000,
  timeoutMs = 180_000
}: KoedServerStartOptions = {}): Promise<void> => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });

  const repoEnv = loadRepoEnv(paths.repoRoot);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...repoEnv,
    ...environment
  };
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const explorerUrl = resolveExplorerUrl(environment, repoEnv);
  const services = [
    "postgres",
    "redis",
    "embedding-service",
    "api",
    "worker",
    "explorer"
  ];

  runCommand(
    paths,
    "Prepare Koed environment",
    process.execPath,
    [resolve(paths.repoRoot, "scripts/setup-env.mjs")],
    childEnv
  );

  const refreshedRepoEnv = loadRepoEnv(paths.repoRoot);
  const refreshedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...refreshedRepoEnv,
    ...environment
  };

  runCommand(
    paths,
    "Start Koed local services",
    "docker",
    ["compose", "up", "-d", "--build", ...services],
    refreshedEnv
  );

  const runtime: KoedServerRuntimeState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    repoRoot: paths.repoRoot,
    apiUrl,
    explorerUrl,
    services
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
        services
      },
      null,
      2
    )
  );

  const status = await waitForHealthyOrReady({
    environment: refreshedEnv,
    timeoutMs,
    pollIntervalMs
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
    "Koed server supervisor is running. Press Ctrl-C to stop following logs; services will keep running."
  );

  const follower = spawnLogFollower(paths, services, refreshedEnv);
  const shutdown = () => {
    follower.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    follower.on("exit", () => resolvePromise());
    follower.on("error", rejectPromise);
  });
};
