#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { copyNativeRuntimeSource } from "../native-runtime-copy.mjs";
import {
  sourceDate,
  writeDeterministicTarGz
} from "../deterministic-tar-gzip.mjs";
import {
  prunePythonEmbeddingRuntimeFiles,
  writeRuntimeAssetManifest,
  sha256File
} from "./manifest-lib.mjs";
import { procureRuntime } from "./procure-runtime.mjs";
import {
  pruneNativeRuntimeBuildArtifacts,
  stripNativeRuntimeBinaries
} from "./content-policy.mjs";

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
    else if (value === "--no-archive") options.noArchive = true;
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
  options.version ||= process.env.KOED_NATIVE_RUNTIME_VERSION ?? "dev";
  return options;
};

const assertHost = (allowMismatch) => {
  if (allowMismatch) return;
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      "macOS arm64 native runtime artifact build requires darwin/arm64. Use --allow-host-mismatch only for layout tests."
    );
  }
};

const readSources = (sourcesPath) => {
  const path = resolve(sourcesPath);
  if (!existsSync(path)) return { path, sources: null };
  return { path, sources: JSON.parse(readFileSync(path, "utf8")) };
};

const describeSource = (sourceDir, sourcesPath) => {
  if (!sourceDir) {
    return {
      kind: "pinned-sources",
      manifest: readSources(sourcesPath).sources
    };
  }
  const provenancePath = resolve(sourceDir, "provenance.json");
  if (existsSync(provenancePath)) {
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    if (provenance.source) return provenance.source;
    if (provenance.sources) {
      return { kind: "pinned-sources", manifest: provenance.sources };
    }
  }
  return { kind: "verified-runtime-source" };
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
  copyNativeRuntimeSource(resolved, runtimeRoot);
  return { sourceDir: resolved };
};

const writeProvenance = ({
  outDir,
  runtimeRoot,
  version,
  sourceDir,
  sourcesPath,
  noArchive
}) => {
  const source = describeSource(sourceDir, sourcesPath);
  const provenance = {
    schemaVersion: 1,
    artifact: { platform: "macos", architecture: "arm64", version },
    strategy: noArchive
      ? "koed-verified-runtime-staging"
      : "koed-verified-runtime-tarball",
    source,
    generatedAt: sourceDate(),
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
  writeDeterministicTarGz({
    sourceDir: resolve(outDir, "koed-runtime"),
    rootName: "koed-runtime",
    tarPath,
    streaming: true
  });
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

const timedPhase = (timings, label, work) => {
  console.error(`[native-runtime] ${label} started`);
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    timings[label] = durationMs;
    console.error(`[native-runtime] ${label} finished in ${durationMs}ms`);
  }
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: native-runtime:build:macos-arm64 -- [--source-dir <koed-runtime>] [--sources <sources.json>] [--out-dir <dir>] [--version <version>] [--no-archive] [--json]"
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
  const timings = {};
  let contentPruning;
  let binaryStripping;
  const procurement = timedPhase(timings, "runtime payload procurement", () =>
    copySourceRuntime({
      sourceDir: options.sourceDir,
      runtimeRoot,
      sourcesPath: options.sourcesPath,
      workDir
    })
  );
  const nativeAssets = timedPhase(
    timings,
    "payload pruning and manifest generation",
    () => {
      prunePythonEmbeddingRuntimeFiles(runtimeRoot);
      contentPruning = pruneNativeRuntimeBuildArtifacts(runtimeRoot);
      binaryStripping = stripNativeRuntimeBinaries({
        runtimeRoot,
        platform: "darwin"
      });
      return writeRuntimeAssetManifest({
        runtimeRoot,
        platform: "macos",
        architecture: "arm64"
      });
    }
  );
  if (nativeAssets.length === 0)
    throw new Error(
      "No native runtime assets were staged; refusing to publish empty artifact."
    );
  timedPhase(timings, "current provenance generation", () =>
    writeProvenance({
      outDir,
      runtimeRoot,
      version: options.version,
      sourceDir: options.sourceDir,
      sourcesPath: options.sourcesPath,
      noArchive: options.noArchive
    })
  );
  const artifact = options.noArchive
    ? null
    : timedPhase(timings, "archive and checksum generation", () =>
        archive({ outDir, version: options.version })
      );
  const result = {
    ok: true,
    outDir,
    runtimeRoot,
    nativeAssets,
    artifact,
    procurement,
    contentPruning,
    binaryStripping,
    timings
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (artifact) console.log(`Built ${artifact.tarPath}`);
  else console.log(`Staged ${runtimeRoot} without an archive.`);
};

main();
