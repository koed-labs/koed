#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const embeddingAppRoot = resolve(repoRoot, "apps", "embedding-service");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? 1}: ${result.stderr || result.stdout}`
    );
  }
  return result;
};

const sha256File = (path) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
};

const verifySha256 = (path, expected) => {
  const actual = sha256File(path);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}`
    );
  }
  return actual;
};

const download = ({ url, sha256, cacheDir }) => {
  if (!url || !sha256 || url.includes("TODO") || sha256.includes("TODO")) {
    throw new Error(
      `Pinned URL and SHA-256 are required for native runtime source: ${JSON.stringify({ url, sha256 })}`
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  const parsed = new URL(url);
  const filename = decodeURIComponent(basename(parsed.pathname));
  const target = resolve(cacheDir, filename);
  if (!existsSync(target) || sha256File(target) !== sha256.toLowerCase()) {
    rmSync(target, { force: true });
    run("curl", ["-L", "--fail", "--retry", "3", "--output", target, url], {
      stdio: "inherit"
    });
  }
  verifySha256(target, sha256);
  return target;
};

const copyEmbeddingServiceApp = (targetEmbedding) => {
  mkdirSync(targetEmbedding, { recursive: true });
  for (const entry of [
    "app.py",
    "auth.py",
    "env_config.py",
    "logging_config.py",
    "priority_scheduler.py",
    "runtime.py",
    "schemas.py",
    "settings.py",
    "vectors.py",
    "requirements.txt",
    "pyproject.toml"
  ]) {
    copyFileSync(
      resolve(embeddingAppRoot, entry),
      resolve(targetEmbedding, entry)
    );
  }
};

const chmodIfExists = (path) => {
  if (existsSync(path)) chmodSync(path, 0o755);
};

const materializeAbsoluteSymlinks = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      materializeAbsoluteSymlinks(path);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const target = readlinkSync(path);
    if (!target.startsWith("/") || !existsSync(target)) continue;
    const mode = statSync(target).mode;
    rmSync(path, { force: true });
    cpSync(target, path, {
      recursive: true,
      preserveTimestamps: true,
      dereference: true
    });
    if (!statSync(path).isDirectory()) chmodSync(path, mode & 0o777);
  }
};

const adHocSignIfDarwin = (path) => {
  if (process.platform !== "darwin") return;
  run("codesign", ["--force", "--sign", "-", path]);
};

const listFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return [path];
  });

const findFile = (root, predicate) => {
  for (const file of listFiles(root)) {
    if (predicate(file)) return file;
  }
  return undefined;
};

const extractArchive = (archive, outDir) => {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  if (archive.endsWith(".zip")) {
    run("unzip", ["-q", archive, "-d", outDir]);
  } else if (archive.endsWith(".tar.gz") || archive.endsWith(".tgz")) {
    run("tar", ["-xzf", archive, "-C", outDir]);
  } else {
    throw new Error(`Unsupported archive format: ${archive}`);
  }
};

const firstChildDir = (dir) => {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  );
  if (entries.length === 1) return resolve(dir, entries[0].name);
  return dir;
};

const stagePython = ({ source, runtimeRoot, cacheDir, workDir }) => {
  const archive = download({ ...source, cacheDir });
  const extractDir = resolve(workDir, "python");
  extractArchive(archive, extractDir);
  const pythonRoot = firstChildDir(extractDir);
  const pythonBin = findFile(
    pythonRoot,
    (file) => /\/python3?(\.\d+)?$/.test(file) && statSync(file).mode & 0o111
  );
  if (!pythonBin)
    throw new Error(
      "python-build-standalone archive did not contain a Python executable."
    );
  const targetEmbedding = resolve(runtimeRoot, "embedding-service");
  copyEmbeddingServiceApp(targetEmbedding);
  const venvDir = resolve(targetEmbedding, ".venv");
  rmSync(venvDir, { recursive: true, force: true });
  cpSync(pythonRoot, venvDir, {
    recursive: true,
    preserveTimestamps: true,
    dereference: true
  });
  materializeAbsoluteSymlinks(venvDir);
  const venvPython = resolve(venvDir, "bin", "python");
  chmodIfExists(venvPython);
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], {
    stdio: "inherit"
  });
  run(
    venvPython,
    [
      "-m",
      "pip",
      "install",
      "-r",
      resolve(targetEmbedding, "requirements.txt")
    ],
    { stdio: "inherit" }
  );
  run(venvPython, ["-c", "import fastapi, huggingface_hub, pydantic, uvicorn"]);
  materializeAbsoluteSymlinks(venvDir);
  chmodIfExists(venvPython);
  return { archive, pythonBin, venvPython };
};

const stageLlama = ({ source, runtimeRoot, cacheDir, workDir }) => {
  const archive = download({ ...source, cacheDir });
  const extractDir = resolve(workDir, "llama.cpp");
  extractArchive(archive, extractDir);
  const unpackedRoot = firstChildDir(extractDir);
  const llamaServer = findFile(
    unpackedRoot,
    (file) => basename(file) === "llama-server"
  );
  if (!llamaServer)
    throw new Error("llama.cpp archive did not contain llama-server.");
  const target = resolve(runtimeRoot, "llama.cpp");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(unpackedRoot, target, {
    recursive: true,
    preserveTimestamps: true,
    dereference: true
  });
  materializeAbsoluteSymlinks(target);
  chmodIfExists(resolve(target, "llama-server"));
  return { archive, llamaServer: resolve(target, "llama-server") };
};

const relocateMacosPostgresLibraries = (postgresRoot) => {
  if (process.platform !== "darwin") return;
  const libRoot = resolve(postgresRoot, "lib");
  const candidates = listFiles(postgresRoot).filter((file) => {
    const relativePath = relative(postgresRoot, file).replaceAll("\\", "/");
    return (
      relativePath.startsWith("bin/") || /\.(dylib|so)$/.test(relativePath)
    );
  });
  for (const file of candidates) {
    const otool = spawnSync("otool", ["-L", file], {
      encoding: "utf8",
      stdio: "pipe"
    });
    if (otool.status !== 0) continue;
    const relativePath = relative(postgresRoot, file).replaceAll("\\", "/");
    const loaderPrefix = relativePath.startsWith("bin/")
      ? "@loader_path/../lib"
      : "@loader_path";
    let changed = false;
    for (const line of otool.stdout.split("\n")) {
      const match = line.trim().match(/^(\/[^\s]+\/postgres\/lib\/([^\s]+))/);
      if (!match) continue;
      const [, dependency, name] = match;
      if (!dependency.startsWith(libRoot)) continue;
      run("install_name_tool", [
        "-change",
        dependency,
        `${loaderPrefix}/${name}`,
        file
      ]);
      changed = true;
    }
    if (relativePath.startsWith("lib/") && /\.dylib$/.test(relativePath)) {
      run("install_name_tool", ["-id", `@loader_path/${basename(file)}`, file]);
      changed = true;
    }
    if (changed) adHocSignIfDarwin(file);
  }
};

const stagePostgresArchive = ({ source, runtimeRoot, cacheDir, workDir }) => {
  const archive = download({ ...source, cacheDir });
  const extractDir = resolve(workDir, "postgres");
  extractArchive(archive, extractDir);
  const pgConfig = findFile(extractDir, (file) =>
    file.endsWith("/bin/pg_config")
  );
  if (!pgConfig)
    throw new Error("PostgreSQL archive did not contain bin/pg_config.");
  const postgresRoot = resolve(pgConfig, "..", "..");
  const target = resolve(runtimeRoot, "postgres");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(postgresRoot, target, { recursive: true, preserveTimestamps: true });
  for (const name of ["initdb", "pg_ctl", "psql", "pg_config"])
    chmodIfExists(resolve(target, "bin", name));
  relocateMacosPostgresLibraries(target);
  return { archive, pgConfig: resolve(target, "bin", "pg_config") };
};

const requireCommand = (command, installHint) => {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      `${command} is required to build the native runtime. ${installHint}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} --version failed with ${result.status ?? 1}: ${result.stderr || result.stdout}`
    );
  }
};

const requirePostgresBuildTools = () => {
  requireCommand(
    "bison",
    "Install bison before running native-runtime:build (for example: sudo apt-get install bison flex libssl-dev on Ubuntu/WSL)."
  );
  requireCommand(
    "flex",
    "Install flex before running native-runtime:build (for example: sudo apt-get install bison flex libssl-dev on Ubuntu/WSL)."
  );
};

const buildPostgresSource = ({ source, runtimeRoot, cacheDir, workDir }) => {
  requirePostgresBuildTools();
  const archive = download({ ...source, cacheDir });
  const extractDir = resolve(workDir, "postgres-source");
  extractArchive(archive, extractDir);
  const sourceRoot = firstChildDir(extractDir);
  const target = resolve(runtimeRoot, "postgres");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  run(
    "./configure",
    [
      `--prefix=${target}`,
      "--with-ssl=openssl",
      "--without-icu",
      "--without-readline",
      "--without-zlib"
    ],
    { cwd: sourceRoot, stdio: "inherit" }
  );
  run(
    "make",
    ["-j", String(process.env.KOED_NATIVE_RUNTIME_MAKE_JOBS ?? "2")],
    { cwd: sourceRoot, stdio: "inherit" }
  );
  run("make", ["install"], { cwd: sourceRoot, stdio: "inherit" });
  run("make", ["-C", "contrib/pgcrypto", "install"], {
    cwd: sourceRoot,
    stdio: "inherit"
  });
  for (const name of ["initdb", "pg_ctl", "psql", "pg_config"])
    chmodIfExists(resolve(target, "bin", name));
  relocateMacosPostgresLibraries(target);
  return { archive, pgConfig: resolve(target, "bin", "pg_config") };
};

const assertInside = (base, child, label) => {
  const resolvedBase = realpathSync(resolve(base));
  const resolvedChild = existsSync(child)
    ? realpathSync(resolve(child))
    : resolve(child);
  const rel = relative(resolvedBase, resolvedChild);
  if (rel === "" || (!rel.startsWith("..") && rel !== "..")) return;
  throw new Error(`${label} escaped PostgreSQL runtime root: ${child}`);
};

const copyPgvectorBuildOutputs = ({ buildDir, postgresRoot, pgConfig }) => {
  const control = resolve(buildDir, "vector.control");
  if (!existsSync(control))
    throw new Error("pgvector build directory is missing vector.control.");
  const sqlFiles = listFiles(buildDir).filter((file) =>
    /^vector--.*\.sql$/.test(basename(file))
  );
  const library = findFile(buildDir, (file) =>
    /\/vector\.(so|dylib)$/.test(file)
  );
  if (!library)
    throw new Error("pgvector build did not produce vector.so/vector.dylib.");

  const sharedir = run(pgConfig, ["--sharedir"]).stdout.trim();
  const pkglibdir = run(pgConfig, ["--pkglibdir"]).stdout.trim();
  assertInside(postgresRoot, sharedir, "pg_config --sharedir");
  assertInside(postgresRoot, pkglibdir, "pg_config --pkglibdir");
  const extensionDir = resolve(sharedir, "extension");
  const libDir = pkglibdir;
  mkdirSync(extensionDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  copyFileSync(control, resolve(extensionDir, "vector.control"));
  for (const file of sqlFiles)
    copyFileSync(file, resolve(extensionDir, basename(file)));
  const platformLibraryName =
    process.platform === "darwin" ? "vector.dylib" : "vector.so";
  copyFileSync(library, resolve(libDir, platformLibraryName));
  if (process.platform === "darwin")
    copyFileSync(library, resolve(libDir, "vector.so"));
  return { extensionDir, libDir, library, sqlFiles };
};

const buildPgvector = ({ source, runtimeRoot, cacheDir, workDir }) => {
  const archive = download({ ...source, cacheDir });
  const extractDir = resolve(workDir, "pgvector");
  extractArchive(archive, extractDir);
  const sourceRoot = firstChildDir(extractDir);
  const pgConfig = resolve(runtimeRoot, "postgres", "bin", "pg_config");
  if (!existsSync(pgConfig))
    throw new Error(`Cannot build pgvector; missing ${pgConfig}`);
  run("make", [`PG_CONFIG=${pgConfig}`], { cwd: sourceRoot, stdio: "inherit" });
  const copied = copyPgvectorBuildOutputs({
    buildDir: sourceRoot,
    postgresRoot: resolve(runtimeRoot, "postgres"),
    pgConfig
  });
  return { archive, ...copied };
};

const validateRequiredSources = (sources) => {
  for (const key of ["python", "llamaCpp", "postgres", "pgvector"]) {
    if (!sources[key])
      throw new Error(`Native runtime sources file is missing ${key}.`);
  }
};

export const procureRuntime = ({
  sourcesPath,
  runtimeRoot,
  platform,
  architecture,
  workDir,
  cacheDir
}) => {
  const resolvedSourcesPath = resolve(sourcesPath);
  const sources = JSON.parse(readFileSync(resolvedSourcesPath, "utf8"));
  validateRequiredSources(sources);
  const resolvedRuntimeRoot = resolve(runtimeRoot);
  const resolvedWorkDir = workDir
    ? resolve(workDir)
    : mkdtempSync(resolve(tmpdir(), "koed-native-procure-"));
  const resolvedCacheDir = cacheDir
    ? resolve(cacheDir)
    : resolve(repoRoot, ".cache", "native-runtime");
  rmSync(resolvedRuntimeRoot, { recursive: true, force: true });
  mkdirSync(resolvedRuntimeRoot, { recursive: true });

  const postgres =
    sources.postgres.kind === "source"
      ? buildPostgresSource({
          source: sources.postgres,
          runtimeRoot: resolvedRuntimeRoot,
          cacheDir: resolvedCacheDir,
          workDir: resolvedWorkDir
        })
      : stagePostgresArchive({
          source: sources.postgres,
          runtimeRoot: resolvedRuntimeRoot,
          cacheDir: resolvedCacheDir,
          workDir: resolvedWorkDir
        });
  const pgvector = buildPgvector({
    source: sources.pgvector,
    runtimeRoot: resolvedRuntimeRoot,
    cacheDir: resolvedCacheDir,
    workDir: resolvedWorkDir
  });
  const llamaCpp = stageLlama({
    source: sources.llamaCpp,
    runtimeRoot: resolvedRuntimeRoot,
    cacheDir: resolvedCacheDir,
    workDir: resolvedWorkDir
  });
  const python = stagePython({
    source: sources.python,
    runtimeRoot: resolvedRuntimeRoot,
    cacheDir: resolvedCacheDir,
    workDir: resolvedWorkDir
  });

  const result = {
    ok: true,
    sourcesPath: resolvedSourcesPath,
    runtimeRoot: resolvedRuntimeRoot,
    platform: platform ?? sources.platform,
    architecture: architecture ?? sources.architecture,
    cacheDir: resolvedCacheDir,
    workDir: resolvedWorkDir,
    components: { postgres, pgvector, llamaCpp, python }
  };
  return result;
};

const parseArgs = (argv) => {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--sources") options.sourcesPath = argv[++i];
    else if (arg === "--runtime-root") options.runtimeRoot = argv[++i];
    else if (arg === "--work-dir") options.workDir = argv[++i];
    else if (arg === "--cache-dir") options.cacheDir = argv[++i];
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        "Usage: node scripts/native-runtime/procure-runtime.mjs -- --sources <sources.json> --runtime-root <koed-runtime> [--json]"
      );
      process.exit(0);
    }
    if (!options.sourcesPath || !options.runtimeRoot)
      throw new Error("Provide --sources and --runtime-root.");
    const result = procureRuntime(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Procured native runtime at ${result.runtimeRoot}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
