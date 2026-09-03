#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  boundedMap,
  collectPlatformBinaries,
  listRuntimeFiles,
  linuxLoaderEnvironment,
  linuxLoaderIssues,
  macLoaderIssues
} from "./loader-validation-lib.mjs";
import { inspectNativeRuntimeContents } from "./content-policy.mjs";

const parseArgs = (argv) => {
  const options = { runtimeRoot: "", json: false, platform: process.platform };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--") continue;
    if (value === "--runtime-root") {
      options.runtimeRoot = argv[++i] ?? "";
    } else if (value === "--json") {
      options.json = true;
    } else if (value === "--platform") {
      options.platform = argv[++i] ?? process.platform;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  options.runtimeRoot ||= process.env.KOED_NATIVE_RUNTIME_SOURCE_DIR ?? "";
  if (!options.help && !options.runtimeRoot) {
    throw new Error(
      "Provide --runtime-root or KOED_NATIVE_RUNTIME_SOURCE_DIR."
    );
  }
  return options;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message
  };
};

const execFileAsync = promisify(execFile);

const runAsync = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...options
    });
    return {
      command: [command, ...args].join(" "),
      status: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (error) {
    return {
      command: [command, ...args].join(" "),
      status: error?.code === "ENOENT" ? 1 : (error?.code ?? 1),
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const timedPhase = async (timings, label, work) => {
  console.error(`[native-runtime-validation] ${label} started`);
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    timings[label] = durationMs;
    console.error(
      `[native-runtime-validation] ${label} finished in ${durationMs}ms`
    );
  }
};

const failOnBad = (entry) => {
  if (entry.status !== 0 || entry.error) {
    throw new Error(
      `${entry.command} failed: ${entry.stderr || entry.stdout || entry.error}`
    );
  }
};

const executableChecks = (runtimeRoot) => [
  [
    "postgres-17",
    resolve(runtimeRoot, "postgres", "bin", "pg_config"),
    ["--version"],
    /PostgreSQL\s+17/i
  ],
  [
    "initdb-17",
    resolve(runtimeRoot, "postgres", "bin", "initdb"),
    ["--version"],
    /PostgreSQL\)?\s+17/i
  ],
  [
    "llama-server",
    resolve(runtimeRoot, "llama.cpp", "llama-server"),
    ["--version"],
    /llama|version:|built with/i
  ]
];

const validateExecutables = (runtimeRoot) =>
  executableChecks(runtimeRoot).flatMap(([name, command, args, pattern]) => {
    if (!existsSync(command))
      return [{ name, command, ok: false, message: "missing" }];
    let result = run(command, args);
    if (name === "llama-server" && result.status !== 0)
      result = run(command, ["--help"]);
    const output = `${result.stdout}\n${result.stderr}`;
    return [
      {
        name,
        command,
        ok: result.status === 0 && pattern.test(output),
        output: output.trim()
      }
    ];
  });

const validateMacLoaders = async (runtimeRoot) => {
  const runtimeFiles = listRuntimeFiles(runtimeRoot);
  const binaries = collectPlatformBinaries({
    runtimeRoot,
    platform: "darwin"
  });
  const concurrency = Math.max(
    1,
    Number.parseInt(
      process.env.KOED_LOADER_VALIDATION_CONCURRENCY ?? "6",
      10
    ) || 6
  );
  return boundedMap(binaries, concurrency, async (file) => {
    const result = await runAsync("otool", ["-L", file]);
    const output = `${result.stdout}\n${result.stderr}`;
    const issues = macLoaderIssues({
      file,
      output,
      runtimeFiles,
      runtimeRoot
    });
    return {
      file,
      command: result.command,
      ok: result.status === 0 && issues.length === 0,
      issues,
      output: output.trim()
    };
  });
};

const validateLinuxLoaders = (runtimeRoot) => {
  const lddVersion = run("ldd", ["--version"]);
  failOnBad(lddVersion);
  const lddOutput = `${lddVersion.stdout}\n${lddVersion.stderr}`;
  if (/musl/i.test(lddOutput)) {
    throw new Error(
      "Linux native runtime artifacts require glibc 2.35+, not musl."
    );
  }
  const glibc = lddOutput.match(/(?:glibc|GNU libc|ldd)\D+(\d+)\.(\d+)/i);
  const major = glibc ? Number.parseInt(glibc[1] ?? "", 10) : Number.NaN;
  const minor = glibc ? Number.parseInt(glibc[2] ?? "", 10) : Number.NaN;
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    major < 2 ||
    (major === 2 && minor < 35)
  ) {
    throw new Error("Linux native runtime artifacts require glibc 2.35+.");
  }
  return collectPlatformBinaries({
    runtimeRoot,
    platform: "linux"
  }).map((file) => {
    const result = run("ldd", [file], {
      env: linuxLoaderEnvironment({ file, runtimeRoot })
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const issues = linuxLoaderIssues({ file, output, runtimeRoot });
    return {
      file,
      command: result.command,
      ok: result.status === 0 && issues.length === 0,
      issues,
      output: output.trim()
    };
  });
};

const validatePostgresExtensions = (runtimeRoot) => {
  const tempRoot = mkdtempSync(
    resolve(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "koed-postgres-extensions-validate-"
    )
  );
  const dataDir = resolve(tempRoot, "data");
  const socketDir = resolve(tempRoot, "socket");
  const logPath = resolve(tempRoot, "postgres.log");
  const initdb = resolve(runtimeRoot, "postgres", "bin", "initdb");
  const pgCtl = resolve(runtimeRoot, "postgres", "bin", "pg_ctl");
  const psql = resolve(runtimeRoot, "postgres", "bin", "psql");
  const port = String(55000 + Math.floor(Math.random() * 5000));
  const steps = [];
  try {
    const mkdir = run("mkdir", ["-p", socketDir]);
    steps.push(mkdir);
    failOnBad(mkdir);
    const init = run(initdb, [
      "-D",
      dataDir,
      "--auth=trust",
      "--username=koed"
    ]);
    steps.push(init);
    failOnBad(init);
    const start = run(pgCtl, [
      "-D",
      dataDir,
      "-l",
      logPath,
      "-o",
      `-p ${port} -k ${socketDir}`,
      "start"
    ]);
    steps.push(start);
    failOnBad(start);
    const createPgcrypto = run(psql, [
      "-h",
      socketDir,
      "-p",
      port,
      "-U",
      "koed",
      "-d",
      "postgres",
      "-c",
      "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
    ]);
    steps.push(createPgcrypto);
    failOnBad(createPgcrypto);
    const createVector = run(psql, [
      "-h",
      socketDir,
      "-p",
      port,
      "-U",
      "koed",
      "-d",
      "postgres",
      "-c",
      "CREATE EXTENSION IF NOT EXISTS vector;"
    ]);
    steps.push(createVector);
    failOnBad(createVector);
    return { ok: true, steps };
  } catch (error) {
    return {
      ok: false,
      steps,
      error: error instanceof Error ? error.message : String(error),
      log: existsSync(logPath)
        ? run("tail", ["-100", logPath]).stdout
        : undefined
    };
  } finally {
    if (existsSync(pgCtl) && existsSync(dataDir)) {
      run(pgCtl, ["-D", dataDir, "stop", "-m", "fast"]);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

const validatePackagedProvider = (runtimeRoot) => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-runtime-validate-"));
  try {
    const resourcesPath = resolve(runtimeRoot, "..");
    const env = {
      ...process.env,
      KOED_HOME: koedHome,
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: resourcesPath
    };
    const cli = resolve("packages", "koed-server", "dist", "cli.js");
    if (!existsSync(cli))
      return {
        skipped: true,
        reason: `${cli} is missing; build @koed/koed-server first.`
      };
    const status = run(
      process.execPath,
      [cli, "runtime", "status", "--provider", "packaged", "--json"],
      { env }
    );
    const install = run(
      process.execPath,
      [
        cli,
        "runtime",
        "install",
        "--provider",
        "packaged",
        "--dependency-mode",
        "bundled-local",
        "--json"
      ],
      { env }
    );
    return {
      skipped: false,
      status,
      install,
      ok: install.status === 0
    };
  } finally {
    rmSync(koedHome, { recursive: true, force: true });
  }
};

const runValidation = async (options) => {
  const runtimeRoot = resolve(options.runtimeRoot);
  if (!existsSync(runtimeRoot))
    throw new Error(`runtime root missing: ${runtimeRoot}`);
  const timings = {};
  const contentPolicy = await timedPhase(
    timings,
    "native content policy",
    async () => inspectNativeRuntimeContents(runtimeRoot)
  );
  const executables = await timedPhase(
    timings,
    "executable verification",
    async () => validateExecutables(runtimeRoot)
  );
  const loaders =
    options.platform === "darwin"
      ? await timedPhase(timings, "bounded loader verification", async () =>
          validateMacLoaders(runtimeRoot)
        )
      : options.platform === "linux"
        ? await timedPhase(timings, "loader verification", async () =>
            validateLinuxLoaders(runtimeRoot)
          )
        : [];
  const postgresExtensions = await timedPhase(
    timings,
    "PostgreSQL extension verification",
    async () => validatePostgresExtensions(runtimeRoot)
  );
  const packagedProvider = await timedPhase(
    timings,
    "packaged provider verification",
    async () => validatePackagedProvider(runtimeRoot)
  );
  const errors = [
    ...contentPolicy.forbidden.map(
      (path) => `forbidden native build artifact: ${path}`
    ),
    ...contentPolicy.duplicateCudaLibraries.map(
      (entry) =>
        `duplicate CUDA redistributable content: ${entry.paths.join(", ")}`
    ),
    ...executables
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.name} failed: ${entry.output ?? entry.message}`),
    ...loaders
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.file} loader failed: ${entry.output}`),
    ...(postgresExtensions.ok
      ? []
      : [
          `Postgres extension validation failed: ${postgresExtensions.error}${postgresExtensions.log ? `\n${postgresExtensions.log}` : ""}`
        ]),
    ...(packagedProvider.skipped || packagedProvider.ok
      ? []
      : ["packaged provider validation failed"])
  ];
  return {
    ok: errors.length === 0,
    runtimeRoot,
    platform: options.platform,
    contentPolicy,
    executables,
    loaders,
    postgresExtensions,
    packagedProvider,
    timings,
    errors
  };
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: native-runtime:validate -- --runtime-root <path> [--platform darwin|linux] [--json]"
    );
    process.exitCode = 0;
  } else {
    const result = await runValidation(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.ok) console.error(result.errors.join("\n"));
    else console.log("Native runtime validation passed.");
    process.exitCode = result.ok ? 0 : 1;
  }
} catch (error) {
  if (process.argv.includes("--json"))
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
