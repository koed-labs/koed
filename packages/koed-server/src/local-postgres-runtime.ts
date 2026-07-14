import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import type { KoedServerComponentStatus } from "./types.js";
import type { KoedServerPaths } from "./paths.js";
import {
  canUseSourceCheckoutFallback,
  resolvePackagedKoedRuntimeRoot,
  type RuntimeArtifactSource
} from "./runtime-artifact-source.js";

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

export interface LocalPostgresRuntimePaths {
  dataDir: string;
  runDir: string;
  logPath: string;
  initdbBin: string;
  pgCtlBin: string;
  psqlBin: string;
  artifactSource: RuntimeArtifactSource;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}

export type LocalPostgresRuntimeStatusPaths = Omit<
  LocalPostgresRuntimePaths,
  "password"
>;

export interface LocalPostgresRuntimeStatus extends KoedServerComponentStatus {
  runtime: "native-postgres";
  paths: LocalPostgresRuntimeStatusPaths;
}

export interface LocalPostgresRuntimeStartResult {
  ok: boolean;
  started: boolean;
  status: LocalPostgresRuntimeStatus;
  env: NodeJS.ProcessEnv;
}

export interface LocalPostgresRuntimeStopResult {
  ok: boolean;
  message: string;
  stopped: boolean;
  error?: string;
}

export interface LocalPostgresRuntimeDependencies {
  existsSync?: typeof existsSync;
  spawnSync?: SpawnSyncLike;
}

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const hasAnyPostgresBinary = (
  binDir: string,
  exists: typeof existsSync = existsSync
): boolean =>
  ["initdb", "pg_ctl", "psql"].some((name) => exists(resolve(binDir, name)));

const resolvePostgresBinDir = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: typeof existsSync = existsSync
): { binDir: string; artifactSource: RuntimeArtifactSource } => {
  const override = trim(environment.KOED_POSTGRES_BIN_DIR);
  if (override) {
    return { binDir: resolve(override), artifactSource: "explicit-override" };
  }
  const koedRuntimeDir = resolve(paths.koedHome, "runtime", "postgres", "bin");
  if (hasAnyPostgresBinary(koedRuntimeDir, exists)) {
    return { binDir: koedRuntimeDir, artifactSource: "koed-home-runtime" };
  }
  const packagedRuntimeRoot = resolvePackagedKoedRuntimeRoot(environment);
  const packagedDir = packagedRuntimeRoot
    ? resolve(packagedRuntimeRoot, "postgres", "bin")
    : undefined;
  if (packagedDir && hasAnyPostgresBinary(packagedDir, exists)) {
    return { binDir: packagedDir, artifactSource: "packaged-resource" };
  }
  const vendorDir = resolve(paths.repoRoot, "vendor", "postgres", "bin");
  if (
    canUseSourceCheckoutFallback(environment) &&
    hasAnyPostgresBinary(vendorDir, exists)
  ) {
    return { binDir: vendorDir, artifactSource: "source-checkout" };
  }
  return { binDir: koedRuntimeDir, artifactSource: "koed-home-runtime" };
};

export const resolveLocalPostgresRuntimePaths = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: typeof existsSync = existsSync
): LocalPostgresRuntimePaths => {
  const { binDir, artifactSource } = resolvePostgresBinDir(
    paths,
    environment,
    exists
  );
  const hasBinaryOverride = Boolean(
    trim(environment.KOED_POSTGRES_INITDB_BIN) ??
    trim(environment.KOED_POSTGRES_PG_CTL_BIN) ??
    trim(environment.KOED_POSTGRES_PSQL_BIN)
  );
  const bin = (name: string, override: string | undefined) =>
    resolve(trim(override) ?? resolve(binDir, name));
  const password =
    trim(environment.POSTGRES_PASSWORD) ??
    trim(environment.KOED_BUNDLED_POSTGRES_PASSWORD) ??
    "koed-local-postgres";
  return {
    dataDir: resolve(
      trim(environment.KOED_POSTGRES_DATA_DIR) ?? paths.postgresDataDir
    ),
    runDir: resolve(
      trim(environment.KOED_POSTGRES_RUN_DIR) ?? paths.postgresRunDir
    ),
    logPath: resolve(
      trim(environment.KOED_POSTGRES_LOG_PATH) ?? paths.postgresLogPath
    ),
    initdbBin: bin("initdb", environment.KOED_POSTGRES_INITDB_BIN),
    pgCtlBin: bin("pg_ctl", environment.KOED_POSTGRES_PG_CTL_BIN),
    psqlBin: bin("psql", environment.KOED_POSTGRES_PSQL_BIN),
    artifactSource: hasBinaryOverride ? "explicit-override" : artifactSource,
    host: trim(environment.KOED_POSTGRES_HOST) ?? "127.0.0.1",
    port:
      trim(environment.KOED_POSTGRES_PORT) ??
      trim(environment.POSTGRES_HOST_PORT) ??
      "15432",
    database: trim(environment.POSTGRES_DB) ?? "koed",
    user: trim(environment.POSTGRES_USER) ?? "koed",
    password
  };
};

export const localPostgresEnv = (
  runtime: LocalPostgresRuntimePaths
): NodeJS.ProcessEnv => ({
  DATABASE_URL: `postgres://${encodeURIComponent(runtime.user)}:${encodeURIComponent(runtime.password)}@${runtime.host}:${runtime.port}/${encodeURIComponent(runtime.database)}`,
  POSTGRES_DB: runtime.database,
  POSTGRES_USER: runtime.user,
  POSTGRES_PASSWORD: runtime.password,
  POSTGRES_HOST_PORT: runtime.port
});

const safeRuntimePaths = (
  runtime: LocalPostgresRuntimePaths
): LocalPostgresRuntimeStatusPaths => ({
  dataDir: runtime.dataDir,
  runDir: runtime.runDir,
  logPath: runtime.logPath,
  initdbBin: runtime.initdbBin,
  pgCtlBin: runtime.pgCtlBin,
  psqlBin: runtime.psqlBin,
  artifactSource: runtime.artifactSource,
  host: runtime.host,
  port: runtime.port,
  database: runtime.database,
  user: runtime.user
});

const missingRuntime = (
  runtime: LocalPostgresRuntimePaths,
  missing: string[]
): LocalPostgresRuntimeStatus => ({
  runtime: "native-postgres",
  state: "not_configured",
  message: `Bundled-local native Postgres runtime is missing: ${missing.join(", ")}.`,
  action:
    runtime.artifactSource === "source-checkout" ||
    runtime.artifactSource === "explicit-override"
      ? "Install bundled Postgres/pgvector resources with koed-server runtime install --provider homebrew --dependency-mode bundled-local --json on macOS, Linux, or WSL, or set KOED_POSTGRES_BIN_DIR / KOED_POSTGRES_*_BIN overrides."
      : "Inspect native runtime with koed-server runtime status --provider packaged --json, then install packaged assets with koed-server runtime install --provider packaged --dependency-mode bundled-local --json or Homebrew-backed assets with --provider homebrew on macOS, Linux, or WSL.",
  details: { missing, artifactSource: runtime.artifactSource },
  paths: safeRuntimePaths(runtime)
});

const runtimeMissing = (
  runtime: LocalPostgresRuntimePaths,
  exists: typeof existsSync
): string[] =>
  (
    [
      ["initdb", runtime.initdbBin],
      ["pg_ctl", runtime.pgCtlBin],
      ["psql", runtime.psqlBin]
    ] satisfies Array<[string, string]>
  ).flatMap(([name, file]) => (exists(file) ? [] : [`${name} (${file})`]));

export const localPostgresRuntimeAvailable = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: typeof existsSync = existsSync
): boolean =>
  runtimeMissing(
    resolveLocalPostgresRuntimePaths(paths, environment, exists),
    exists
  ).length === 0;

export const resolveBundledPostgresMode = (
  paths: KoedServerPaths,
  environment?: NodeJS.ProcessEnv,
  exists?: typeof existsSync
): "native" => {
  void paths;
  void environment;
  void exists;
  return "native";
};

const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const sqlIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const run = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  spawnSync: SpawnSyncLike
): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

const commandOutput = (result: SpawnSyncReturns<string>): string =>
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

const validatePostgres17 = (
  runtime: LocalPostgresRuntimePaths,
  env: NodeJS.ProcessEnv,
  spawnSync: SpawnSyncLike
): LocalPostgresRuntimeStatus | null => {
  const version = run(runtime.initdbBin, ["--version"], env, spawnSync);
  const output = commandOutput(version);
  if (
    version.status === 0 &&
    (output === "" ||
      /PostgreSQL\)?\s+17(?:\.|\s|$)/i.test(output) ||
      /\(PostgreSQL\)\s+17(?:\.|\s|$)/i.test(output))
  ) {
    return null;
  }
  return {
    runtime: "native-postgres",
    state: "needs_attention",
    message: "Bundled-local native Postgres must be PostgreSQL 17 compatible.",
    action:
      "Run koed-server runtime status --provider packaged --json or koed-server runtime install --provider homebrew --dependency-mode bundled-local --json with PostgreSQL 17 assets.",
    details: {
      exitCode: version.status,
      output,
      artifactSource: runtime.artifactSource
    },
    paths: safeRuntimePaths(runtime)
  };
};

const healthyStatus = (
  runtime: LocalPostgresRuntimePaths,
  message: string
): LocalPostgresRuntimeStatus => ({
  runtime: "native-postgres",
  state: "healthy",
  message,
  details: {
    port: runtime.port,
    dataDir: runtime.dataDir,
    artifactSource: runtime.artifactSource
  },
  paths: safeRuntimePaths(runtime)
});

export const collectLocalPostgresRuntimeStatus = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LocalPostgresRuntimeDependencies = {}
): LocalPostgresRuntimeStatus => {
  const exists = dependencies.existsSync ?? existsSync;
  const spawnSync = dependencies.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const runtime = resolveLocalPostgresRuntimePaths(paths, environment, exists);
  const missing = runtimeMissing(runtime, exists);
  if (missing.length > 0) {
    return missingRuntime(runtime, missing);
  }
  if (!exists(resolve(runtime.dataDir, "PG_VERSION"))) {
    return {
      runtime: "native-postgres",
      state: "not_configured",
      message:
        "Bundled-local Postgres data directory has not been initialized.",
      action: "Run koed-server start to initialize bundled-local Postgres.",
      paths: safeRuntimePaths(runtime)
    };
  }
  const status = run(
    runtime.pgCtlBin,
    ["status", "-D", runtime.dataDir],
    environment,
    spawnSync
  );
  if (status.status === 0) {
    return healthyStatus(runtime, "Bundled-local native Postgres is running.");
  }
  return {
    runtime: "native-postgres",
    state: "starting",
    message: "Bundled-local native Postgres is not running yet.",
    details: { exitCode: status.status, stderr: status.stderr },
    paths: safeRuntimePaths(runtime)
  };
};

export const stopLocalPostgresRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LocalPostgresRuntimeDependencies = {}
): LocalPostgresRuntimeStopResult => {
  const exists = dependencies.existsSync ?? existsSync;
  const spawnSync = dependencies.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const runtime = resolveLocalPostgresRuntimePaths(paths, environment, exists);
  if (!exists(runtime.pgCtlBin)) {
    return {
      ok: false,
      stopped: false,
      message: "Bundled-local native Postgres pg_ctl binary was not found.",
      error: `${runtime.pgCtlBin} does not exist`
    };
  }
  if (!exists(resolve(runtime.dataDir, "PG_VERSION"))) {
    return {
      ok: true,
      stopped: false,
      message:
        "Bundled-local native Postgres data directory was not initialized."
    };
  }
  const status = run(
    runtime.pgCtlBin,
    ["status", "-D", runtime.dataDir],
    environment,
    spawnSync
  );
  if (status.status !== 0) {
    return {
      ok: true,
      stopped: false,
      message: "Bundled-local native Postgres was not running."
    };
  }
  const stopped = run(
    runtime.pgCtlBin,
    ["stop", "-D", runtime.dataDir, "-m", "fast"],
    environment,
    spawnSync
  );
  if (stopped.status !== 0) {
    return {
      ok: false,
      stopped: false,
      message: "Could not stop bundled-local native Postgres.",
      error: stopped.stderr.trim() || `exit code ${stopped.status ?? 1}`
    };
  }
  return {
    ok: true,
    stopped: true,
    message: "Bundled-local native Postgres stopped."
  };
};

export const startLocalPostgresRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LocalPostgresRuntimeDependencies = {}
): LocalPostgresRuntimeStartResult => {
  const exists = dependencies.existsSync ?? existsSync;
  const spawnSync = dependencies.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const runtime = resolveLocalPostgresRuntimePaths(paths, environment, exists);
  const env = { ...environment, ...localPostgresEnv(runtime) };
  const missing = runtimeMissing(runtime, exists);
  if (missing.length > 0) {
    return {
      ok: false,
      started: false,
      status: missingRuntime(runtime, missing),
      env
    };
  }
  const versionStatus = validatePostgres17(runtime, env, spawnSync);
  if (versionStatus) {
    return { ok: false, started: false, status: versionStatus, env };
  }
  mkdirSync(runtime.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(runtime.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(runtime.logPath), { recursive: true, mode: 0o700 });
  if (!exists(resolve(runtime.dataDir, "PG_VERSION"))) {
    const pwfile = resolve(runtime.runDir, "postgres.pw");
    writeFileSync(pwfile, `${runtime.password}\n`, { mode: 0o600 });
    const init = run(
      runtime.initdbBin,
      ["-D", runtime.dataDir, "--username", runtime.user, "--pwfile", pwfile],
      env,
      spawnSync
    );
    rmSync(pwfile, { force: true });
    if (init.status !== 0) {
      return {
        ok: false,
        started: false,
        env,
        status: {
          runtime: "native-postgres",
          state: "needs_attention",
          message:
            "Could not initialize bundled-local Postgres data directory.",
          details: { exitCode: init.status, stderr: init.stderr },
          paths: safeRuntimePaths(runtime)
        }
      };
    }
  }
  const status = run(
    runtime.pgCtlBin,
    ["status", "-D", runtime.dataDir],
    env,
    spawnSync
  );
  let startedByCurrentProcess = false;
  if (status.status !== 0) {
    const started = run(
      runtime.pgCtlBin,
      [
        "start",
        "-D",
        runtime.dataDir,
        "-l",
        runtime.logPath,
        "-o",
        `-h ${runtime.host} -p ${runtime.port}`
      ],
      env,
      spawnSync
    );
    if (started.status !== 0) {
      return {
        ok: false,
        started: false,
        env,
        status: {
          runtime: "native-postgres",
          state: "needs_attention",
          message: "Could not start bundled-local native Postgres.",
          details: { exitCode: started.status, stderr: started.stderr },
          paths: safeRuntimePaths(runtime)
        }
      };
    }
    startedByCurrentProcess = true;
  }
  const databaseExists = run(
    runtime.psqlBin,
    [
      "-h",
      runtime.host,
      "-p",
      runtime.port,
      "-U",
      runtime.user,
      "-d",
      "postgres",
      "-tAc",
      `select 1 from pg_database where datname = ${sqlLiteral(runtime.database)}`
    ],
    env,
    spawnSync
  );
  if (databaseExists.status !== 0) {
    return {
      ok: false,
      started: startedByCurrentProcess,
      env,
      status: {
        runtime: "native-postgres",
        state: "needs_attention",
        message: "Could not inspect bundled-local Koed database.",
        details: {
          exitCode: databaseExists.status,
          stderr: databaseExists.stderr
        },
        paths: safeRuntimePaths(runtime)
      }
    };
  }
  if (databaseExists.stdout.trim() !== "1") {
    const createDb = run(
      runtime.psqlBin,
      [
        "-h",
        runtime.host,
        "-p",
        runtime.port,
        "-U",
        runtime.user,
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `CREATE DATABASE ${sqlIdentifier(runtime.database)}`
      ],
      env,
      spawnSync
    );
    if (createDb.status !== 0) {
      return {
        ok: false,
        started: startedByCurrentProcess,
        env,
        status: {
          runtime: "native-postgres",
          state: "needs_attention",
          message: "Could not create bundled-local Koed database.",
          details: { exitCode: createDb.status, stderr: createDb.stderr },
          paths: safeRuntimePaths(runtime)
        }
      };
    }
  }
  const extension = run(
    runtime.psqlBin,
    [
      "-h",
      runtime.host,
      "-p",
      runtime.port,
      "-U",
      runtime.user,
      "-d",
      runtime.database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "CREATE EXTENSION IF NOT EXISTS vector"
    ],
    env,
    spawnSync
  );
  if (extension.status !== 0) {
    return {
      ok: false,
      started: startedByCurrentProcess,
      env,
      status: {
        runtime: "native-postgres",
        state: "needs_attention",
        message: "Could not enable pgvector for bundled-local Koed database.",
        details: { exitCode: extension.status, stderr: extension.stderr },
        paths: safeRuntimePaths(runtime)
      }
    };
  }
  return {
    ok: true,
    started: startedByCurrentProcess,
    env,
    status: healthyStatus(runtime, "Bundled-local native Postgres is running.")
  };
};
