#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve, relative } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

const usage =
  () => `Usage: pnpm native-runtime:stage:homebrew -- --out <dir> [--force] [--json]

Stages Homebrew/Linuxbrew-provided native runtime assets for local packaged
Desktop smoke testing. The output is suitable for KOED_NATIVE_RUNTIME_SOURCE_DIR.
This is a development smoke helper, not a release-quality redistributable
runtime bundle.`;

const parseArgs = (argv) => {
  const options = { force: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--out") {
      options.out = argv[index + 1];
      index += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!options.help && !options.out) {
    throw new Error(`Missing required --out <dir>.\n\n${usage()}`);
  }
  return options;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? 1}${details ? `: ${details}` : ""}`
    );
  }
  return result.stdout.trim();
};

const maybeRun = (command, args) =>
  spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

const assertSupportedPlatform = () => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      "Homebrew-backed native runtime staging is supported on macOS, Linux, and WSL only."
    );
  }
};

const assertCommand = (command) => {
  const result = maybeRun(command, ["--version"]);
  if (result.error?.code === "ENOENT") {
    throw new Error(
      `${command} is not available. Install Homebrew/Linuxbrew before staging native runtime assets.`
    );
  }
};

const brewPrefix = (formula) => run("brew", ["--prefix", formula]);

const copyTree = (source, target) => {
  if (!existsSync(source)) throw new Error(`Missing source path: ${source}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true
  });
};

const copyFile = (source, target) => {
  if (!existsSync(source)) throw new Error(`Missing source file: ${source}`);
  const resolvedSource = realpathSync(source);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(resolvedSource, target, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true
  });
};

const makeExecutable = (path) => {
  if (existsSync(path)) chmodSync(path, 0o755);
};

const listDir = (path) => (existsSync(path) ? readdirSync(path) : []);

const copyPgvectorFiles = ({ pgConfigBin, postgresPrefix, targetPostgres }) => {
  const sharedir = run(pgConfigBin, ["--sharedir"]);
  const pkglibdir = run(pgConfigBin, ["--pkglibdir"]);
  const candidates = [
    resolve(sharedir, "extension"),
    resolve(postgresPrefix, "share", "postgresql@17", "extension"),
    resolve(postgresPrefix, "share", "postgresql", "extension"),
    resolve(
      dirname(postgresPrefix),
      "..",
      "share",
      "postgresql@17",
      "extension"
    ),
    resolve(dirname(postgresPrefix), "..", "share", "postgresql", "extension")
  ];
  const extensionDir = candidates.find((candidate) =>
    existsSync(resolve(candidate, "vector.control"))
  );
  if (!extensionDir) {
    throw new Error(
      "Could not find pgvector extension files. Expected vector.control under Postgres/Homebrew shared extension directories."
    );
  }

  const files = listDir(extensionDir).filter(
    (name) => name === "vector.control" || /^vector--.*\.sql$/.test(name)
  );
  if (
    !files.includes("vector.control") ||
    !files.some((name) => name.endsWith(".sql"))
  ) {
    throw new Error(`Incomplete pgvector extension files in ${extensionDir}.`);
  }

  const libraryCandidates = [
    resolve(pkglibdir, "vector.so"),
    resolve(pkglibdir, "vector.dylib"),
    resolve(pgConfigBin, "..", "..", "lib", "postgresql", "vector.so"),
    resolve(pgConfigBin, "..", "..", "lib", "postgresql", "vector.dylib"),
    resolve(pgConfigBin, "..", "..", "lib", "vector.so"),
    resolve(pgConfigBin, "..", "..", "lib", "vector.dylib")
  ];
  const library = libraryCandidates.find((candidate) => existsSync(candidate));
  if (!library) {
    throw new Error(
      `Could not find pgvector shared library. Expected vector.so or vector.dylib under ${pkglibdir}.`
    );
  }

  const relativeSharedir = relative(postgresPrefix, sharedir);
  const relativeTargets = relativeSharedir.startsWith("..")
    ? ["share/postgresql@17", "share/postgresql"]
    : [relativeSharedir];
  for (const relativeTarget of relativeTargets) {
    const targetExtensionDir = resolve(
      targetPostgres,
      relativeTarget,
      "extension"
    );
    for (const file of files) {
      copyFile(resolve(extensionDir, file), resolve(targetExtensionDir, file));
    }
  }

  const relativePkglibdir = relative(postgresPrefix, pkglibdir);
  const relativeLibraryTargets = relativePkglibdir.startsWith("..")
    ? ["lib/postgresql"]
    : [relativePkglibdir];
  for (const relativeTarget of relativeLibraryTargets) {
    copyFile(library, resolve(targetPostgres, relativeTarget, "vector.so"));
  }
  return {
    source: extensionDir,
    library,
    files,
    stagedSharedirs: relativeTargets,
    stagedLibraryDirs: relativeLibraryTargets
  };
};

const copyEmbeddingVenv = ({ targetEmbedding }) => {
  const sourceVenv = resolve(
    process.env.KOED_EMBEDDING_VENV_DIR?.trim() ||
      resolve(repoRoot, "apps", "embedding-service", ".venv")
  );
  const sourcePython = resolve(sourceVenv, "bin", "python");
  if (!existsSync(sourcePython)) {
    throw new Error(
      `Missing Embedding Service Python runtime: ${sourcePython}. Create apps/embedding-service/.venv before staging native assets, or set KOED_EMBEDDING_VENV_DIR. This script does not install Python dependencies.`
    );
  }
  copyTree(sourceVenv, resolve(targetEmbedding, ".venv"));
  makeExecutable(resolve(targetEmbedding, ".venv", "bin", "python"));
  return sourceVenv;
};

const validatePostgres = (initdb) => {
  const output = run(initdb, ["--version"]);
  if (
    !/PostgreSQL\)?\s+17(?:\.|\s|$)|\(PostgreSQL\)\s+17(?:\.|\s|$)/i.test(
      output
    )
  ) {
    throw new Error(`Expected PostgreSQL 17 from ${initdb}; got: ${output}`);
  }
  return output;
};

const isShellScript = (path) => {
  try {
    return readFileSync(path, "utf8").startsWith("#!");
  } catch {
    return false;
  }
};

const validateLlama = (llamaServer) => {
  const version = maybeRun(llamaServer, ["--version"]);
  const result =
    version.status === 0 ? version : maybeRun(llamaServer, ["--help"]);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not validate llama-server at ${llamaServer}: ${output || result.error?.message || "unknown error"}`
    );
  }
  return output.split("\n")[0] ?? "llama-server validated";
};

const loaderWarnings = (executables) => {
  const tool = process.platform === "darwin" ? "otool" : "ldd";
  const warnings = [];
  for (const executable of executables) {
    if (isShellScript(executable)) continue;
    const args =
      process.platform === "darwin" ? ["-L", executable] : [executable];
    const result = maybeRun(tool, args);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.error?.code === "ENOENT") {
      warnings.push(
        `${tool} is not available; loader validation skipped for ${executable}.`
      );
    } else if (result.status !== 0 || /not found/i.test(output)) {
      warnings.push(
        `${tool} reported possible loader issues for ${executable}: ${output}`
      );
    }
  }
  return warnings;
};

const ensureEmptyOutput = (outDir, force) => {
  if (!existsSync(outDir)) return;
  const entries = readdirSync(outDir);
  if (entries.length > 0 && !force) {
    throw new Error(
      `Output directory is not empty: ${outDir}. Pass --force to replace it.`
    );
  }
  rmSync(outDir, { recursive: true, force: true });
};

const stage = ({ out, force }) => {
  assertSupportedPlatform();
  assertCommand("brew");
  const outDir = resolve(out);
  ensureEmptyOutput(outDir, force);
  mkdirSync(outDir, { recursive: true });

  const postgresPrefix = brewPrefix("postgresql@17");
  const pgvectorPrefix = brewPrefix("pgvector");
  const llamaPrefix = brewPrefix("llama.cpp");
  const targetPostgres = resolve(outDir, "postgres");
  const targetLlama = resolve(outDir, "llama.cpp");
  const targetEmbedding = resolve(outDir, "embedding-service");

  copyTree(postgresPrefix, targetPostgres);
  copyTree(llamaPrefix, targetLlama);
  mkdirSync(targetEmbedding, { recursive: true });

  const pgConfigBin = resolve(postgresPrefix, "bin", "pg_config");
  const pgvector = copyPgvectorFiles({
    pgConfigBin,
    postgresPrefix,
    targetPostgres
  });
  const embeddingVenv = copyEmbeddingVenv({ targetEmbedding });

  const postgresExecutables = ["initdb", "pg_ctl", "psql", "pg_config"].map(
    (name) => resolve(targetPostgres, "bin", name)
  );
  const llamaServer = resolve(targetLlama, "bin", "llama-server");
  const packagedLlamaServer = resolve(targetLlama, "llama-server");
  for (const executable of postgresExecutables) makeExecutable(executable);
  if (existsSync(llamaServer)) {
    writeFileSync(
      packagedLlamaServer,
      '#!/bin/sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexport DYLD_LIBRARY_PATH="$DIR/lib:$DIR/../lib:${DYLD_LIBRARY_PATH:-}"\nexport LD_LIBRARY_PATH="$DIR/lib:$DIR/../lib:${LD_LIBRARY_PATH:-}"\nexec "$DIR/bin/llama-server" "$@"\n'
    );
  }
  makeExecutable(packagedLlamaServer);

  const postgresVersion = validatePostgres(
    resolve(targetPostgres, "bin", "initdb")
  );
  const llamaVersion = validateLlama(packagedLlamaServer);
  const warnings = [
    "Homebrew-staged native runtime assets are for local packaged smoke only; copied binaries may still depend on Homebrew dynamic libraries and are not release-quality redistribution artifacts.",
    ...loaderWarnings([
      resolve(targetPostgres, "bin", "initdb"),
      resolve(targetPostgres, "bin", "pg_ctl"),
      resolve(targetPostgres, "bin", "psql"),
      resolve(targetPostgres, "bin", "pg_config"),
      resolve(targetPostgres, "lib", "postgresql", "vector.so"),
      packagedLlamaServer,
      resolve(targetEmbedding, ".venv", "bin", "python")
    ])
  ];

  writeFileSync(
    resolve(outDir, "README.koed-native-runtime.txt"),
    `Koed native runtime staged from Homebrew/Linuxbrew for local packaged smoke testing.\n\nThis directory is suitable for KOED_NATIVE_RUNTIME_SOURCE_DIR. It is not a release-quality redistributable runtime bundle.\n\nPostgres: ${postgresPrefix}\npgvector: ${pgvectorPrefix}\nllama.cpp: ${llamaPrefix}\nEmbedding venv: ${embeddingVenv}\n`
  );

  return {
    ok: true,
    provider: "homebrew",
    outDir,
    platform: process.platform === "darwin" ? "macos" : process.platform,
    architecture: process.arch,
    sources: {
      postgresPrefix,
      pgvectorPrefix,
      llamaPrefix,
      embeddingVenv
    },
    validation: {
      postgresVersion,
      llamaVersion,
      pgvector
    },
    warnings
  };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = stage(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Staged Homebrew native runtime assets at ${result.outDir}`);
    for (const warning of result.warnings) console.warn(`[WARN] ${warning}`);
  }
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
