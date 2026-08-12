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
  const options = {
    json: false,
    full: false,
    installRuntime: false,
    timeoutMs: 180_000,
    pollIntervalMs: 2_000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--full") {
      options.full = true;
      continue;
    }
    if (value === "--install-runtime") {
      options.installRuntime = true;
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
  --full                    Also run personal capture/recall smoke after native health
  --install-runtime         Explicitly run Homebrew-backed runtime install before startup
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
  readFile: fsp.readFile,
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
  assertCommand(deps, "pnpm", ["--version"], "pnpm preflight");
};

export const buildBundledLocalSmokeEnvironment = async ({
  root = defaultRoot,
  deps = createBundledLocalSmokeDeps(),
  baseEnv = process.env,
  koedHome
} = {}) => {
  const id = deps.randomUUID().slice(0, 8);
  const home =
    koedHome ??
    (await deps.mkdtemp(path.join(os.tmpdir(), "koed-bundled-smoke-home-")));
  const envPath = path.join(home, "repo.env");
  const codexHome = path.join(home, "codex");
  const ports = {
    api: await deps.getFreePort(),
    postgres: await deps.getFreePort(),
    redis: await deps.getFreePort(),
    embedding: await deps.getFreePort()
  };
  const queueBackend =
    baseEnv.WORK_QUEUE_BACKEND === "bullmq" ? "bullmq" : "local";
  const env = {
    ...baseEnv,
    KOED_HOME: home,
    KOED_REPO_ROOT: root,
    KOED_ENV_PATH: envPath,
    KOED_RUNTIME_MODE: "local-personal",
    KOED_DEPENDENCY_MODE: "bundled-local",
    KOED_AUTO_PORTS: "1",
    CODEX_HOME: codexHome,
    CODEX_CONFIG_PATH: path.join(codexHome, "config.toml"),
    KOED_BUNDLED_POSTGRES_MODE: "native",
    KOED_BUNDLED_EMBEDDING_MODE: "native",
    WORK_QUEUE_BACKEND: queueBackend,
    API_HOST_PORT: String(ports.api),
    POSTGRES_HOST_PORT: String(ports.postgres),
    KOED_POSTGRES_HOST: "127.0.0.1",
    KOED_POSTGRES_PORT: String(ports.postgres),
    KOED_POSTGRES_DATA_DIR: path.join(home, "data", "postgres"),
    KOED_POSTGRES_RUN_DIR: path.join(home, "run", "postgres"),
    KOED_POSTGRES_LOG_PATH: path.join(home, "logs", "postgres.log"),
    REDIS_HOST_PORT: String(ports.redis),
    EMBEDDING_SERVICE_HOST_PORT: String(ports.embedding),
    MEMORY_API_URL: `http://localhost:${ports.api}`,
    EMBEDDING_SERVICE_URL: `http://localhost:${ports.embedding}`
  };
  const expectedServices = ["postgres-native", "embedding-service-native"];
  return {
    id,
    root,
    koedHome: home,
    envPath,
    ports,
    env,
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

const parseJsonCommandOutput = (command, args, result) => {
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `Could not parse JSON from ${command} ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

const commandFailureDetails = (result) => {
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  if (!stdout) return stderr;
  try {
    return [stderr, JSON.stringify(JSON.parse(stdout), null, 2)]
      .filter(Boolean)
      .join("\n");
  } catch {
    return [stderr, stdout].filter(Boolean).join("\n");
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
    const details = commandFailureDetails(result);
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? 1}${details ? `:\n${details}` : ""}`
    );
  }
  return parseJsonCommandOutput(command, args, result);
};

const runJsonCommandAllowExit = (deps, command, args, options) => {
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
  const parsed = parseJsonCommandOutput(command, args, result);
  return { exitCode: result.status ?? 0, ...parsed };
};

const modelInstallConfigured = (env) =>
  Boolean(
    env.KOED_EMBEDDING_MODEL_URL?.trim() &&
    env.KOED_EMBEDDING_MODEL_SHA256?.trim()
  );

const defaultEmbeddingModelPath = (context) =>
  path.join(context.koedHome, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf");

const firstExistingOrDefault = (deps, candidates) =>
  candidates.find((candidate) => candidate && deps.fileExists(candidate)) ??
  candidates.find(Boolean);

const nativeLlamaServerPath = (deps, env, context) => {
  const dockerDefault = "/opt/llama.cpp/llama-server";
  for (const value of [
    env.KOED_EMBEDDING_LLAMA_SERVER_BIN,
    env.LLAMA_SERVER_BINARY,
    env.EMBEDDING_LLAMA_SERVER_BINARY
  ]) {
    if (value?.trim() && value.trim() !== dockerDefault) return value.trim();
  }
  return firstExistingOrDefault(deps, [
    path.join(context.koedHome, "runtime", "llama.cpp", "llama-server"),
    path.join(context.root, "vendor", "llama.cpp", "llama-server")
  ]);
};

const nativePostgresBinPath = (deps, env, context, name, override) => {
  if (override?.trim()) return override.trim();
  const binDirs = [
    env.KOED_POSTGRES_BIN_DIR,
    path.join(context.koedHome, "runtime", "postgres", "bin"),
    path.join(context.root, "vendor", "postgres", "bin")
  ].filter(Boolean);
  return firstExistingOrDefault(
    deps,
    binDirs.map((binDir) => path.join(binDir, name))
  );
};

const nativeEmbeddingEntryPath = (deps, context) =>
  firstExistingOrDefault(deps, [
    path.join(
      context.koedHome,
      "runtime",
      "embedding-service",
      "dist",
      "index.js"
    ),
    path.join(context.root, "apps", "embedding-service", "dist", "index.js")
  ]);

export const assertNativeBundledLocalResources = ({ deps, context }) => {
  const env = context.env;
  const required = [
    [
      "Postgres initdb",
      nativePostgresBinPath(
        deps,
        env,
        context,
        "initdb",
        env.KOED_POSTGRES_INITDB_BIN
      )
    ],
    [
      "Postgres pg_ctl",
      nativePostgresBinPath(
        deps,
        env,
        context,
        "pg_ctl",
        env.KOED_POSTGRES_PG_CTL_BIN
      )
    ],
    [
      "Postgres psql",
      nativePostgresBinPath(
        deps,
        env,
        context,
        "psql",
        env.KOED_POSTGRES_PSQL_BIN
      )
    ],
    ["Embedding Service entry", nativeEmbeddingEntryPath(deps, context)],
    ["llama-server", nativeLlamaServerPath(deps, env, context)]
  ];
  const missing = required.filter(([, filePath]) => !deps.fileExists(filePath));
  const modelPath =
    env.KOED_EMBEDDING_MODEL_PATH ?? defaultEmbeddingModelPath(context);
  if (!deps.fileExists(modelPath) && !modelInstallConfigured(env)) {
    missing.push(["Embedding model", modelPath]);
  }
  if (missing.length > 0) {
    throw new Error(
      `Native bundled-local smoke resources missing: ${missing
        .map(([label, filePath]) => `${label} (${filePath})`)
        .join(
          ", "
        )}. Install native resources or set KOED_* overrides before running bundled-local smoke.`
    );
  }
};

export const maybeInstallHomebrewRuntime = ({ deps, context, steps }) => {
  const cli = path.join(
    context.root,
    "packages",
    "koed-server",
    "dist",
    "cli.js"
  );
  const statusBefore = runJsonCommandAllowExit(
    deps,
    process.execPath,
    [cli, "runtime", "status", "--provider", "homebrew", "--json"],
    {
      cwd: context.root,
      env: context.env
    }
  );
  steps.push({
    step: "homebrew-runtime-status-before",
    state: statusBefore.state ?? "unknown",
    ok: Boolean(statusBefore.ok),
    linked: Boolean(statusBefore.koedRuntime?.linked)
  });

  if (!statusBefore.ok) {
    const install = runJsonCommand(
      deps,
      process.execPath,
      [
        cli,
        "runtime",
        "install",
        "--provider",
        "homebrew",
        "--dependency-mode",
        "bundled-local",
        "--json"
      ],
      {
        cwd: context.root,
        env: context.env
      }
    );
    if (!install.ok) {
      throw new Error(
        `Homebrew runtime install failed: ${JSON.stringify(install)}`
      );
    }
    steps.push({
      step: "homebrew-runtime-install",
      state: install.state ?? "installed",
      installedPackages: install.installedPackages ?? [],
      linkedPaths: install.linkedPaths ?? []
    });
  } else {
    steps.push({
      step: "homebrew-runtime-install",
      state: "skipped",
      reason: "runtime already installed"
    });
  }

  const statusAfter = runJsonCommand(
    deps,
    process.execPath,
    [cli, "runtime", "status", "--provider", "homebrew", "--json"],
    {
      cwd: context.root,
      env: context.env
    }
  );
  if (!statusAfter.ok || !statusAfter.koedRuntime?.linked) {
    throw new Error(
      `Homebrew runtime status was not installed under KOED_HOME: ${JSON.stringify(statusAfter)}`
    );
  }
  steps.push({
    step: "homebrew-runtime-status-after",
    state: statusAfter.state,
    linked: Boolean(statusAfter.koedRuntime?.linked),
    postgresBinDir: statusAfter.koedRuntime?.postgresBinDir,
    llamaServerBin: statusAfter.koedRuntime?.llamaServerBin
  });
};

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
  for (const key of ["api", "database", "workerQueues", "embeddingService"]) {
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

const parseCreatedToken = (output) => {
  const match = /^Token:\s*(\S+)$/m.exec(output);
  if (!match) {
    throw new Error(
      `Could not parse API Token from bootstrap output: ${output}`
    );
  }
  return match[1];
};

const parseEnvContents = (contents) => {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match)
      values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
};

const localPostgresDatabaseUrl = (env) => {
  const user = env.POSTGRES_USER?.trim() || "koed";
  const password =
    env.POSTGRES_PASSWORD?.trim() ||
    env.KOED_BUNDLED_POSTGRES_PASSWORD?.trim() ||
    "koed-local-postgres";
  const database = env.POSTGRES_DB?.trim() || "koed";
  const host = env.KOED_POSTGRES_HOST?.trim() || "127.0.0.1";
  const port =
    env.KOED_POSTGRES_PORT?.trim() || env.POSTGRES_HOST_PORT?.trim() || "15432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
};

const refreshContextEnvFromEnvPath = async ({ deps, context }) => {
  if (!context.envPath || !deps.fileExists(context.envPath)) return;
  const contents = await deps.readFile(context.envPath, "utf8");
  Object.assign(context.env, parseEnvContents(contents));
  Object.assign(context.env, {
    API_HOST_PORT: String(context.ports.api),
    POSTGRES_HOST_PORT: String(context.ports.postgres),
    KOED_POSTGRES_HOST: "127.0.0.1",
    KOED_POSTGRES_PORT: String(context.ports.postgres),
    KOED_POSTGRES_DATA_DIR: path.join(context.koedHome, "data", "postgres"),
    KOED_POSTGRES_RUN_DIR: path.join(context.koedHome, "run", "postgres"),
    KOED_POSTGRES_LOG_PATH: path.join(context.koedHome, "logs", "postgres.log"),
    REDIS_HOST_PORT: String(context.ports.redis),
    EMBEDDING_SERVICE_HOST_PORT: String(context.ports.embedding),
    MEMORY_API_URL: `http://localhost:${context.ports.api}`,
    EMBEDDING_SERVICE_URL: `http://localhost:${context.ports.embedding}`
  });
  if (context.env.KOED_DEPENDENCY_MODE === "bundled-local") {
    context.env.DATABASE_URL = localPostgresDatabaseUrl(context.env);
  }
};

export const createSmokeApiToken = async ({ deps, context }) => {
  await refreshContextEnvFromEnvPath({ deps, context });
  if (!context.env.DATABASE_URL?.trim()) {
    throw new Error(
      `Full smoke could not resolve isolated DATABASE_URL from ${context.envPath}.`
    );
  }
  const result = deps.spawnSync(
    "pnpm",
    [
      "api-token:create",
      "--owner-email",
      `smoke-${context.id}@koed.local`,
      "--name",
      "Bundled Local Smoke"
    ],
    {
      cwd: context.root,
      env: context.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (result.error) {
    throw new Error(`API Token bootstrap failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `API Token bootstrap failed with exit code ${result.status ?? 1}: ${String(result.stderr ?? result.stdout ?? "").trim()}`
    );
  }
  return parseCreatedToken(result.stdout ?? "");
};

const fetchJson = async (deps, url, options = {}) => {
  const response = await deps.fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return body;
};

const assertSmokeQueueDrain = (queueDrain) => {
  if (!queueDrain || typeof queueDrain !== "object") {
    throw new Error("Full smoke response did not include queue drain counts.");
  }
  for (const label of ["embedding", "compaction"]) {
    const counts = queueDrain[label];
    if (!counts || typeof counts !== "object") {
      throw new Error(`Full smoke queue drain missing ${label} counts.`);
    }
    for (const key of ["waiting", "active", "delayed", "failed"]) {
      if (!Number.isFinite(counts[key])) {
        throw new Error(
          `Full smoke queue drain missing numeric ${label}.${key}.`
        );
      }
    }
    if (counts.failed > 0) {
      throw new Error(
        `Full smoke queue ${label} has ${counts.failed} failed job(s).`
      );
    }
    const pending = counts.waiting + counts.active + counts.delayed;
    if (pending > 0) {
      throw new Error(
        `Full smoke queue ${label} still has ${pending} pending job(s).`
      );
    }
  }
};

export const runFullPersonalSmoke = async ({ deps, context, steps }) => {
  const token = await createSmokeApiToken({ deps, context });
  context.env.MEMORY_API_TOKEN = token;
  steps.push({ step: "api-token", state: "created" });

  const apiUrl = context.env.MEMORY_API_URL.replace(/\/+$/, "");
  const smoke = await fetchJson(deps, `${apiUrl}/self-host/smoke-test`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  if (!smoke.ok) {
    throw new Error(
      `Full personal smoke recall failed: ${JSON.stringify(smoke)}`
    );
  }
  const marker = smoke.marker;
  const evidenceText = JSON.stringify(smoke.recall ?? smoke);
  if (!marker || !evidenceText.includes(marker)) {
    throw new Error(
      `Full personal smoke Evidence Bundle did not contain marker ${marker}.`
    );
  }
  steps.push({
    step: "personal-capture-recall",
    state: "passed",
    marker,
    hits: smoke.recall?.hits ?? null
  });

  assertSmokeQueueDrain(smoke.queueDrain);
  steps.push({
    step: "queue-embedding-drain",
    state: "passed",
    workerQueues: smoke.queueDrain
  });

  await fetchJson(deps, context.env.MEMORY_API_URL);
  return smoke;
};

const destroyChildStream = (stream) => {
  if (stream && typeof stream.destroy === "function") {
    stream.destroy();
  }
};

const waitForChildClose = async (deps, child, timeoutMs = 5_000) => {
  if (!child || child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => child.once("exit", resolve)),
    deps.setTimeout(timeoutMs)
  ]);
};

export const cleanupBundledLocalSmoke = async ({ deps, context, child }) => {
  const cli = path.join(
    context.root,
    "packages",
    "koed-server",
    "dist",
    "cli.js"
  );
  if (deps.fileExists(cli)) {
    deps.spawnSync(process.execPath, [cli, "stop", "--json"], {
      cwd: context.root,
      env: context.env,
      stdio: "ignore"
    });
  }
  if (child) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        deps.setTimeout(5_000)
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    await waitForChildClose(deps, child);
    destroyChildStream(child.stdout);
    destroyChildStream(child.stderr);
  }
  await deps.rm(context.koedHome, { recursive: true, force: true });
};

export const runBundledLocalSmoke = async ({
  root = defaultRoot,
  env = process.env,
  timeoutMs = 180_000,
  pollIntervalMs = 2_000,
  json = false,
  full = false,
  installRuntime = false,
  deps = createBundledLocalSmokeDeps(),
  echo = json ? undefined : console.log
} = {}) => {
  const steps = [];
  let context;
  let child = null;
  const logs = [];
  try {
    preflightBundledLocalSmoke(deps, { full });
    steps.push({ step: "preflight", state: "passed", full });
    context = await buildBundledLocalSmokeEnvironment({
      root,
      deps,
      baseEnv: env,
      full
    });
    await deps.mkdir(context.koedHome, { recursive: true });
    steps.push({
      step: "environment",
      state: "created",
      koedHome: context.koedHome,
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
    if (installRuntime) {
      maybeInstallHomebrewRuntime({ deps, context, steps });
    }
    assertNativeBundledLocalResources({ deps, context });
    steps.push({ step: "native-resources", state: "present" });
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
    const fullSmoke = full
      ? await runFullPersonalSmoke({
          deps,
          context,
          steps,
          timeoutMs,
          pollIntervalMs
        })
      : null;
    return {
      ok: true,
      state: "passed",
      koedHome: context.koedHome,
      steps,
      status,
      ...(fullSmoke ? { fullSmoke } : {})
    };
  } catch (error) {
    return {
      ok: false,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
      ...(context ? { koedHome: context.koedHome } : {}),
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
