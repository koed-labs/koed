#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
  prunePythonEmbeddingRuntimeFiles,
  writeRuntimeAssetManifest,
  sha256File
} from "./manifest-lib.mjs";
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
    resolve(import.meta.dirname, "sources.linux-x64.json");
  options.outDir ||=
    process.env.KOED_NATIVE_RUNTIME_OUT_DIR ??
    resolve(repoRoot, "dist", "native-runtime", "linux-x64");
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
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  return result;
};

const assertHost = (allowMismatch) => {
  if (allowMismatch) return;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "Linux x64 native runtime artifact build requires linux/x64. Use --allow-host-mismatch only for layout tests."
    );
  }
  const ldd = run("ldd", ["--version"]);
  const output = `${ldd.stdout}\n${ldd.stderr}`;
  if (/musl/i.test(output))
    throw new Error(
      "Linux x64 native runtime artifacts require glibc 2.35+, not musl."
    );
  const match = output.match(/(?:glibc|GNU libc|ldd)\D+(\d+)\.(\d+)/i);
  const major = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  const minor = match ? Number.parseInt(match[2] ?? "", 10) : Number.NaN;
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    major < 2 ||
    (major === 2 && minor < 35)
  ) {
    throw new Error("Linux x64 native runtime artifacts require glibc 2.35+.");
  }
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: native-runtime:build:linux-x64 -- [--source-dir <koed-runtime>] [--sources <sources.json>] [--out-dir <dir>] [--version <version>] [--json]"
    );
    return;
  }
  assertHost(options.allowHostMismatch);
  const outDir = resolve(options.outDir);
  const runtimeRoot = resolve(outDir, "koed-runtime");
  const sourceDir = options.sourceDir ? resolve(options.sourceDir) : undefined;
  if (sourceDir && !existsSync(sourceDir))
    throw new Error(
      `Native runtime source directory does not exist: ${sourceDir}`
    );
  process.env.KOED_NATIVE_RUNTIME_WORK_DIR ||= mkdtempSync(
    resolve(tmpdir(), "koed-native-runtime-linux-")
  );
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const procurement = sourceDir
    ? (cpSync(sourceDir, runtimeRoot, {
        recursive: true,
        preserveTimestamps: true
      }),
      { sourceDir })
    : procureRuntime({
        sourcesPath: options.sourcesPath,
        runtimeRoot,
        platform: "linux",
        architecture: "x64",
        workDir: process.env.KOED_NATIVE_RUNTIME_WORK_DIR
      });
  prunePythonEmbeddingRuntimeFiles(runtimeRoot);
  const nativeAssets = writeRuntimeAssetManifest({
    runtimeRoot,
    platform: "linux",
    architecture: "x64"
  });
  if (nativeAssets.length === 0)
    throw new Error(
      "No native runtime assets were staged; refusing to publish empty artifact."
    );
  const provenance = {
    schemaVersion: 1,
    artifact: {
      platform: "linux",
      architecture: "x64",
      version: options.version
    },
    sourceDir,
    sourcesPath: options.sourcesPath,
    generatedAt: new Date().toISOString(),
    glibcBaseline: "2.35+"
  };
  writeFileSync(
    resolve(runtimeRoot, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`
  );
  writeFileSync(
    resolve(outDir, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`
  );
  const tarName = `koed-native-runtime-linux-x64-${options.version}.tar.gz`;
  const tarPath = resolve(outDir, tarName);
  run("tar", ["-czf", tarPath, "koed-runtime"], { cwd: outDir });
  const sha256 = sha256File(tarPath);
  const sha256Path = resolve(outDir, `${tarName}.sha256`);
  writeFileSync(sha256Path, `${sha256}  ${basename(tarPath)}\n`);
  const result = {
    ok: true,
    outDir,
    runtimeRoot,
    nativeAssets,
    artifact: { tarPath, sha256Path, sha256 },
    procurement
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Built ${tarPath}`);
};

main();
