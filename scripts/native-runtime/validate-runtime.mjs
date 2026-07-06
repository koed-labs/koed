#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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
  ],
  [
    "python",
    resolve(runtimeRoot, "embedding-service", ".venv", "bin", "python"),
    ["--version"],
    /Python\s+3\./i
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

const pgConfigValue = (runtimeRoot, flag) => {
  const pgConfig = resolve(runtimeRoot, "postgres", "bin", "pg_config");
  if (!existsSync(pgConfig)) return undefined;
  const result = run(pgConfig, [flag]);
  if (result.status !== 0 || result.error) return undefined;
  return result.stdout.trim();
};

const collectLoaderFiles = (runtimeRoot, platform) => {
  const files = [
    resolve(runtimeRoot, "postgres", "bin", "initdb"),
    resolve(runtimeRoot, "postgres", "bin", "pg_ctl"),
    resolve(runtimeRoot, "postgres", "bin", "psql"),
    resolve(runtimeRoot, "postgres", "bin", "pg_config"),
    resolve(runtimeRoot, "llama.cpp", "llama-server")
  ];
  const pkglibdir = pgConfigValue(runtimeRoot, "--pkglibdir");
  if (pkglibdir) {
    files.push(
      resolve(pkglibdir, platform === "darwin" ? "vector.dylib" : "vector.so")
    );
  } else {
    files.push(
      resolve(
        runtimeRoot,
        "postgres",
        "lib",
        platform === "darwin" ? "vector.dylib" : "vector.so"
      ),
      resolve(
        runtimeRoot,
        "postgres",
        "lib",
        "postgresql",
        platform === "darwin" ? "vector.dylib" : "vector.so"
      )
    );
  }
  return files.filter(existsSync);
};

const validateMacLoaders = (runtimeRoot) =>
  collectLoaderFiles(runtimeRoot, "darwin").map((file) => {
    const result = run("otool", ["-L", file]);
    const output = `${result.stdout}\n${result.stderr}`;
    const forbidden = [
      /\/opt\/homebrew\//,
      /\/usr\/local\/Cellar\//,
      /not found/i
    ].filter((pattern) => pattern.test(output));
    return {
      file,
      command: result.command,
      ok: result.status === 0 && forbidden.length === 0,
      output: output.trim()
    };
  });

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
  return collectLoaderFiles(runtimeRoot, "linux").map((file) => {
    const result = run("ldd", [file]);
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      file,
      command: result.command,
      ok: result.status === 0 && !/not found/i.test(output),
      output: output.trim()
    };
  });
};

const validatePgvectorExtension = (runtimeRoot) => {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "koed-pgvector-validate-"));
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
    const createExtension = run(psql, [
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
    steps.push(createExtension);
    failOnBad(createExtension);
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

const runValidation = (options) => {
  const runtimeRoot = resolve(options.runtimeRoot);
  if (!existsSync(runtimeRoot))
    throw new Error(`runtime root missing: ${runtimeRoot}`);
  const executables = validateExecutables(runtimeRoot);
  const loaders =
    options.platform === "darwin"
      ? validateMacLoaders(runtimeRoot)
      : options.platform === "linux"
        ? validateLinuxLoaders(runtimeRoot)
        : [];
  const pgvectorExtension = validatePgvectorExtension(runtimeRoot);
  const packagedProvider = validatePackagedProvider(runtimeRoot);
  const errors = [
    ...executables
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.name} failed: ${entry.output ?? entry.message}`),
    ...loaders
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.file} loader failed: ${entry.output}`),
    ...(pgvectorExtension.ok
      ? []
      : [`pgvector extension validation failed: ${pgvectorExtension.error}`]),
    ...(packagedProvider.skipped || packagedProvider.ok
      ? []
      : ["packaged provider validation failed"])
  ];
  return {
    ok: errors.length === 0,
    runtimeRoot,
    platform: options.platform,
    executables,
    loaders,
    pgvectorExtension,
    packagedProvider,
    errors
  };
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: native-runtime:validate -- --runtime-root <path> [--platform darwin|linux] [--json]"
    );
    process.exit(0);
  }
  const result = runValidation(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(result.errors.join("\n"));
  else console.log("Native runtime validation passed.");
  process.exit(result.ok ? 0 : 1);
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
  process.exit(1);
}
