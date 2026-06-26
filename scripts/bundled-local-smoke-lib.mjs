import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const parseBundledLocalSmokeArgs = (argv) => {
  const options = { json: false, timeoutMs: 180_000, pollIntervalMs: 2_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (value === "--poll-interval-ms") {
      options.pollIntervalMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown bundled-local smoke option: ${value}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("--poll-interval-ms must be a positive integer.");
  }
  return options;
};

export const bundledLocalSmokeUsage = `Usage: pnpm smoke:bundled-local -- [options]

Options:
  --json                    Emit JSON result
  --timeout-ms <number>     Max wait for healthy status (default 180000)
  --poll-interval-ms <num>  Poll interval (default 2000)
  --help, -h                Show this help
`;

export const createBundledLocalSmokeDeps = () => ({
  spawn,
  spawnSync,
  fetch: globalThis.fetch.bind(globalThis),
  mkdtemp: fsp.mkdtemp,
  rm: fsp.rm,
  writeFile: fsp.writeFile,
  mkdir: fsp.mkdir,
  fileExists: (filePath) => fs.existsSync(filePath),
  setTimeout: sleep,
  now: () => Date.now(),
  randomUUID,
  getFreePort
});

export const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const assertCommand = (deps, command, args, label, options = {}) => {
  const result = deps.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status ?? 1}: ${String(result.stderr ?? result.stdout ?? "").trim()}`
    );
  }
};

export const preflightBundledLocalSmoke = (deps) => {
  assertCommand(deps, "docker", ["--version"], "Docker CLI preflight");
  assertCommand(deps, "docker", ["info"], "Docker daemon preflight");
  assertCommand(deps, "pnpm", ["--version"], "pnpm preflight");
};

export const buildBundledLocalSmokeEnvironment = async ({
  root = defaultRoot,
  deps = createBundledLocalSmokeDeps(),
  baseEnv = process.env,
  koedHome,
  composeProjectName
} = {}) => {
  const id = deps.randomUUID().slice(0, 8);
  const home =
    koedHome ??
    (await deps.mkdtemp(path.join(os.tmpdir(), "koed-bundled-smoke-home-")));
  const envPath = path.join(home, "repo.env");
  const ports = {
    api: await deps.getFreePort(),
    explorer: await deps.getFreePort(),
    postgres: await deps.getFreePort(),
    redis: await deps.getFreePort(),
    embedding: await deps.getFreePort()
  };
  const queueBackend =
    baseEnv.WORK_QUEUE_BACKEND === "bullmq" ? "bullmq" : "local";
  const composeProject = composeProjectName ?? `koed-smoke-${id}`;
  const env = {
    ...baseEnv,
    KOED_HOME: home,
    KOED_REPO_ROOT: root,
    KOED_ENV_PATH: envPath,
    KOED_DEPENDENCY_MODE: "bundled-local",
    WORK_QUEUE_BACKEND: queueBackend,
    COMPOSE_PROJECT_NAME: composeProject,
    API_HOST_PORT: String(ports.api),
    EXPLORER_WEB_HOST_PORT: String(ports.explorer),
    POSTGRES_HOST_PORT: String(ports.postgres),
    REDIS_HOST_PORT: String(ports.redis),
    EMBEDDING_SERVICE_HOST_PORT: String(ports.embedding),
    MEMORY_API_URL: `http://localhost:${ports.api}`,
    EMBEDDING_SERVICE_URL: `http://localhost:${ports.embedding}`
  };
  const expectedServices = [
    "postgres",
    ...(queueBackend === "bullmq" ? ["redis"] : []),
    "embedding-service"
  ];
  return {
    id,
    root,
    koedHome: home,
    envPath,
    ports,
    env,
    composeProject,
    expectedServices,
    queueBackend
  };
};

const pushLog = (logs, prefix, chunk, echo) => {
  for (const line of chunk.toString().split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const rendered = `${prefix} ${trimmed}`;
    logs.push(rendered);
    if (logs.length > 200) logs.shift();
    echo?.(rendered);
  }
};

export const runJsonCommand = (deps, command, args, options) => {
  const result = deps.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? 1}: ${String(result.stderr ?? result.stdout ?? "").trim()}`
    );
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `Could not parse JSON from ${command} ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

const modelInstallConfigured = (env) =>
  Boolean(
    env.KOED_EMBEDDING_MODEL_URL?.trim() &&
    env.KOED_EMBEDDING_MODEL_SHA256?.trim()
  );

export const maybeInstallEmbeddingModel = ({ deps, context, steps }) => {
  if (!modelInstallConfigured(context.env)) {
    steps.push({
      step: "embedding-model-install",
      state: "skipped",
      reason: "missing KOED_EMBEDDING_MODEL_URL or KOED_EMBEDDING_MODEL_SHA256"
    });
    return;
  }
  const cli = path.join(
    context.root,
    "packages",
    "koed-server",
    "dist",
    "cli.js"
  );
  const install = runJsonCommand(
    deps,
    process.execPath,
    [cli, "models", "install", "--kind", "embedding", "--json"],
    {
      cwd: context.root,
      env: context.env
    }
  );
  if (!install.ok) {
    throw new Error(
      `Embedding model install failed: ${JSON.stringify(install)}`
    );
  }
  const status = runJsonCommand(
    deps,
    process.execPath,
    [cli, "models", "status", "--kind", "embedding", "--json"],
    {
      cwd: context.root,
      env: context.env
    }
  );
  if (status.state !== "installed") {
    throw new Error(
      `Embedding model status was not installed: ${JSON.stringify(status)}`
    );
  }
  steps.push({
    step: "embedding-model-install",
    state: "installed",
    modelPath: status.modelPath
  });
};

const assertHealthyStatus = (status, context) => {
  const failures = [];
  if (status.dependencyMode !== "bundled-local")
    failures.push("dependencyMode");
  for (const key of ["api", "database", "embeddingService"]) {
    if (status[key]?.state !== "healthy") failures.push(key);
  }
  if (context.queueBackend === "local") {
    if (status.redis?.state !== "healthy") failures.push("redis");
    if (status.redis?.details?.backend !== "local")
      failures.push("redis.localQueueBypass");
  } else if (status.redis?.state !== "healthy") {
    failures.push("redis");
  }
  if (failures.length > 0) {
    throw new Error(
      `Bundled-local smoke status not healthy: ${failures.join(", ")}\n${JSON.stringify(status, null, 2)}`
    );
  }
};

export const waitForBundledLocalHealthy = async ({
  deps,
  context,
  child,
  logs,
  timeoutMs,
  pollIntervalMs
}) => {
  const cli = path.join(
    context.root,
    "packages",
    "koed-server",
    "dist",
    "cli.js"
  );
  const startedAt = deps.now();
  let lastStatus = null;
  while (deps.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `koed-server exited before healthy status (code ${child.exitCode}). Recent logs:\n${logs.slice(-80).join("\n")}`
      );
    }
    try {
      lastStatus = runJsonCommand(
        deps,
        process.execPath,
        [cli, "status", "--json"],
        {
          cwd: context.root,
          env: context.env
        }
      );
      assertHealthyStatus(lastStatus, context);
      return lastStatus;
    } catch (error) {
      logs.push(
        `[status] ${error instanceof Error ? error.message : String(error)}`
      );
      if (logs.length > 200) logs.shift();
    }
    await deps.setTimeout(pollIntervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for bundled-local health. Last status:\n${JSON.stringify(lastStatus, null, 2)}\nRecent logs:\n${logs.slice(-80).join("\n")}`
  );
};

export const cleanupBundledLocalSmoke = async ({ deps, context, child }) => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      deps.setTimeout(5_000)
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  deps.spawnSync(
    "docker",
    ["compose", "-p", context.composeProject, "down", "--remove-orphans"],
    {
      cwd: context.root,
      env: context.env,
      stdio: "ignore"
    }
  );
  await deps.rm(context.koedHome, { recursive: true, force: true });
};

export const runBundledLocalSmoke = async ({
  root = defaultRoot,
  env = process.env,
  timeoutMs = 180_000,
  pollIntervalMs = 2_000,
  json = false,
  deps = createBundledLocalSmokeDeps(),
  echo = json ? undefined : console.log
} = {}) => {
  const steps = [];
  let context;
  let child = null;
  const logs = [];
  try {
    preflightBundledLocalSmoke(deps);
    steps.push({ step: "preflight", state: "passed" });
    context = await buildBundledLocalSmokeEnvironment({
      root,
      deps,
      baseEnv: env
    });
    await deps.mkdir(context.koedHome, { recursive: true });
    steps.push({
      step: "environment",
      state: "created",
      koedHome: context.koedHome,
      composeProject: context.composeProject,
      ports: context.ports,
      queueBackend: context.queueBackend
    });

    assertCommand(
      deps,
      "pnpm",
      ["--filter", "@koed/koed-server", "build"],
      "koed-server build",
      { cwd: context.root, env: context.env }
    );
    steps.push({ step: "koed-server-build", state: "passed" });
    maybeInstallEmbeddingModel({ deps, context, steps });

    const cli = path.join(
      context.root,
      "packages",
      "koed-server",
      "dist",
      "cli.js"
    );
    child = deps.spawn(process.execPath, [cli, "start"], {
      cwd: context.root,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk) =>
      pushLog(logs, "[koed-server]", chunk, echo)
    );
    child.stderr?.on("data", (chunk) =>
      pushLog(logs, "[koed-server:err]", chunk, echo)
    );
    steps.push({ step: "koed-server-start", state: "started", pid: child.pid });

    const status = await waitForBundledLocalHealthy({
      deps,
      context,
      child,
      logs,
      timeoutMs,
      pollIntervalMs
    });
    steps.push({ step: "status", state: "healthy" });
    return {
      ok: true,
      state: "passed",
      koedHome: context.koedHome,
      composeProject: context.composeProject,
      steps,
      status
    };
  } catch (error) {
    return {
      ok: false,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
      ...(context
        ? { koedHome: context.koedHome, composeProject: context.composeProject }
        : {}),
      steps,
      logs: logs.slice(-80)
    };
  } finally {
    if (context) {
      await cleanupBundledLocalSmoke({ deps, context, child }).catch(
        (error) => {
          steps.push({
            step: "cleanup",
            state: "failed",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      );
    }
  }
};

export const renderBundledLocalSmokeResult = (result) =>
  `${JSON.stringify(result, null, 2)}\n`;
