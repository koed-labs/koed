#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { writeRuntimeAssetManifest, sha256File } from "./manifest-lib.mjs";
import { procureRuntime } from "./procure-runtime.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");

const parseArgs = (argv) => {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--") continue;
    if (value === "--json") options.json = true;
    else if (value === "--source-dir") options.sourceDir = argv[++i];
    else if (value === "--sources") options.sourcesPath = argv[++i];
    else if (value === "--out-dir") options.outDir = argv[++i];
    else if (value === "--version") options.version = argv[++i];
    else if (value === "--allow-host-mismatch")
      options.allowHostMismatch = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  options.sourceDir ||= process.env.KOED_NATIVE_RUNTIME_SOURCE_DIR;
  options.sourcesPath ||=
    process.env.KOED_NATIVE_RUNTIME_SOURCES ??
    resolve(import.meta.dirname, "sources.macos-arm64.json");
  options.outDir ||=
    process.env.KOED_NATIVE_RUNTIME_OUT_DIR ??
    resolve(repoRoot, "dist", "native-runtime", "macos-arm64");
  options.version ||=
    process.env.KOED_NATIVE_RUNTIME_VERSION ??
    `dev-${new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14)}`;
  return options;
};

const run = (command, args, opts = {}) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
    ...opts
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? 1}: ${result.stderr || result.stdout}`
    );
  }
  return result;
};

const assertHost = (allowMismatch) => {
  if (allowMismatch) return;
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      "macOS arm64 native runtime artifact build requires darwin/arm64. Use --allow-host-mismatch only for layout tests."
    );
  }
};

const readSources = () => {
  const path =
    process.env.KOED_NATIVE_RUNTIME_SOURCES ??
    resolve(import.meta.dirname, "sources.macos-arm64.json");
  if (!existsSync(path)) return { path, sources: null };
  return { path, sources: JSON.parse(readFileSync(path, "utf8")) };
};

const copySourceRuntime = ({
  sourceDir,
  runtimeRoot,
  sourcesPath,
  workDir
}) => {
  if (!sourceDir) {
    return procureRuntime({
      sourcesPath,
      runtimeRoot,
      platform: "macos",
      architecture: "arm64",
      workDir
    });
  }
  const resolved = resolve(sourceDir);
  if (!existsSync(resolved))
    throw new Error(
      `Native runtime source directory does not exist: ${resolved}`
    );
  cpSync(resolved, runtimeRoot, { recursive: true, preserveTimestamps: true });
  return { sourceDir: resolved };
};

const writeProvenance = ({ outDir, runtimeRoot, version, sourceDir }) => {
  const provenance = {
    schemaVersion: 1,
    artifact: { platform: "macos", architecture: "arm64", version },
    strategy: "koed-verified-runtime-tarball",
    sourceDir: sourceDir ? resolve(sourceDir) : undefined,
    sources: readSources().sources,
    generatedAt: new Date().toISOString(),
    node: process.version,
    host: { platform: process.platform, architecture: process.arch },
    validation: {
      command:
        "pnpm native-runtime:validate -- --runtime-root <koed-runtime> --platform darwin --json"
    }
  };
  writeFileSync(
    resolve(runtimeRoot, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`
  );
  writeFileSync(
    resolve(runtimeRoot, "README.koed-native-runtime.txt"),
    "Koed packaged native runtime artifact. Validate with `pnpm native-runtime:validate -- --runtime-root koed-runtime --platform darwin --json`.\n"
  );
  writeFileSync(
    resolve(outDir, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`
  );
};

const archive = ({ outDir, version }) => {
  const tarName = `koed-native-runtime-macos-arm64-${version}.tar.gz`;
  const tarPath = resolve(outDir, tarName);
  run("tar", ["-czf", tarPath, "koed-runtime"], { cwd: outDir });
  const sha = sha256File(tarPath);
  writeFileSync(
    resolve(outDir, `${tarName}.sha256`),
    `${sha}  ${basename(tarPath)}\n`
  );
  return {
    tarPath,
    sha256Path: resolve(outDir, `${tarName}.sha256`),
    sha256: sha
  };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: native-runtime:build:macos-arm64 -- [--source-dir <koed-runtime>] [--sources <sources.json>] [--out-dir <dir>] [--version <version>] [--json]"
    );
    return;
  }
  assertHost(options.allowHostMismatch);
  const outDir = resolve(options.outDir);
  const runtimeRoot = resolve(outDir, "koed-runtime");
  const workDir =
    process.env.KOED_NATIVE_RUNTIME_WORK_DIR ??
    mkdtempSync(resolve(tmpdir(), "koed-native-runtime-"));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const procurement = copySourceRuntime({
    sourceDir: options.sourceDir,
    runtimeRoot,
    sourcesPath: options.sourcesPath,
    workDir
  });
  const nativeAssets = writeRuntimeAssetManifest({
    runtimeRoot,
    platform: "macos",
    architecture: "arm64"
  });
  if (nativeAssets.length === 0)
    throw new Error(
      "No native runtime assets were staged; refusing to publish empty artifact."
    );
  writeProvenance({
    outDir,
    runtimeRoot,
    version: options.version,
    sourceDir: options.sourceDir
  });
  const artifact = archive({ outDir, version: options.version });
  const result = {
    ok: true,
    outDir,
    runtimeRoot,
    nativeAssets,
    artifact,
    procurement
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Built ${artifact.tarPath}`);
};

main();
