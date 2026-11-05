#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { procureRuntime } from "./procure-runtime.mjs";
import {
  pruneNativeRuntimeBuildArtifacts,
  stripNativeRuntimeBinaries
} from "./content-policy.mjs";
import { collectPlatformBinaries } from "./loader-validation-lib.mjs";
import { sha256File, writeRuntimeAssetManifest } from "./manifest-lib.mjs";
import { freezeCore, packageFrozenCore } from "./core-artifact.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const buildRoot = "/tmp/koed-native-core-v1";
const logicFiles = [
  "scripts/native-runtime/build-core-linux-x64.mjs",
  "scripts/native-runtime/core-artifact.mjs",
  "scripts/native-runtime/procure-runtime.mjs",
  "scripts/native-runtime/content-policy.mjs",
  "scripts/native-runtime/manifest-lib.mjs",
  "scripts/native-runtime/loader-validation-lib.mjs",
  "scripts/deterministic-tar-gzip.mjs",
  "packages/koed-server/src/artifact-canonical-json.mjs"
];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    ...options
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.stderr || result.error?.message || result.stdout}`
    );
  return result.stdout?.trim() ?? "";
};

const identifyToolchain = () => ({
  osRelease: readFileSync("/etc/os-release", "utf8"),
  packages: run("dpkg-query", ["-W", "-f=${binary:Package}=${Version}\n"])
    .split("\n")
    .sort(),
  node: { version: process.version, sha256: sha256File(process.execPath) },
  tools: Object.fromEntries(
    [
      "cc",
      "c++",
      "ld",
      "as",
      "ar",
      "make",
      "strip",
      "patchelf",
      "tar",
      "gzip",
      "bison",
      "flex",
      "perl",
      "curl"
    ].map((name) => {
      const path = realpathSync(`/usr/bin/${name}`);
      return [
        name,
        { sha256: sha256File(path), version: run(path, ["--version"]) }
      ];
    })
  ),
  linkLibraries: Object.fromEntries(
    ["libssl.so", "libcrypto.so"].map((name) => {
      const path = realpathSync(run("cc", [`-print-file-name=${name}`]));
      return [name, sha256File(path)];
    })
  )
});

export const buildLinuxCore = ({ outDir, sourceDir, runtimeVersion }) => {
  const out = resolve(outDir);
  // A new output directory prevents overwriting frozen candidates or payloads.
  mkdirSync(out, { recursive: false });
  const runtimeRoot = resolve(out, "koed-runtime");
  if (sourceDir) {
    cpSync(resolve(sourceDir), runtimeRoot, {
      recursive: true,
      verbatimSymlinks: true
    });
    return packageFrozenCore({ runtimeRoot, outDir: out });
  }
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.getuid?.() === 0
  )
    throw new Error(
      "Cold CPU core builds require an unprivileged Linux x64 build user on Ubuntu 22.04."
    );
  if (
    !/^VERSION_ID="22\.04"$/m.test(readFileSync("/etc/os-release", "utf8")) ||
    !/\b2\.35\b/.test(run("ldd", ["--version"]))
  )
    throw new Error(
      "Cold CPU core builds require the Ubuntu 22.04 / glibc 2.35 baseline."
    );
  mkdirSync(buildRoot); // Never silently reuse or remove another build's work.
  const originalEnvironment = { ...process.env };
  const originalUmask = process.umask();
  try {
    const environment = {
      PATH: "/usr/bin:/bin",
      HOME: resolve(buildRoot, "home"),
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: "0",
      CC: "/usr/bin/cc",
      CXX: "/usr/bin/c++",
      CFLAGS: `-O2 -march=x86-64 -mtune=generic -ffile-prefix-map=${buildRoot}=/usr/src/koed-native`,
      CXXFLAGS: `-O2 -march=x86-64 -mtune=generic -ffile-prefix-map=${buildRoot}=/usr/src/koed-native`,
      LDFLAGS: "",
      MAKEFLAGS: "",
      KOED_NATIVE_RUNTIME_MAKE_JOBS: "2"
    };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    process.umask(0o022);
    mkdirSync(environment.HOME);
    const configuration = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "core.linux-x64.json"), "utf8")
    );
    if (runtimeVersion) configuration.runtimeVersion = runtimeVersion;
    const combinedSources = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "sources.linux-x64.json"),
        "utf8"
      )
    );
    const sources = Object.fromEntries(
      ["postgres", "pgvector", "llamaCpp"].map((key) => [
        key,
        combinedSources[key]
      ])
    );
    // The upstream CPU llama-server links GNU OpenMP. A minimal Jammy host
    // has libstdc++ but need not have libgomp. The launcher loads from cpu/.
    const redistributables = {
      "libgomp.so.1": realpathSync(
        run("cc", ["-print-file-name=libgomp.so.1"])
      ),
      "libgomp-copyright.txt": "/usr/share/doc/libgomp1/copyright",
      "libgomp-GPL-3.txt": "/usr/share/common-licenses/GPL-3"
    };
    const recipe = {
      schemaVersion: 1,
      kind: "core",
      configuration,
      sources,
      toolchain: identifyToolchain(),
      bundledLibraries: Object.fromEntries(
        Object.entries(redistributables).map(([name, path]) => [
          name,
          sha256File(path)
        ])
      ),
      environment,
      logic: Object.fromEntries(
        logicFiles.map((path) => [path, sha256File(resolve(repoRoot, path))])
      ),
      packaging: {
        format: "ustar-pax-gzip",
        epoch: 0,
        root: "koed-runtime",
        uid: 0,
        gid: 0,
        compression: "node:zlib createGzip, default level, mtime 0",
        strip: "--strip-unneeded",
        postgresRunpath: "$ORIGIN relative to postgres/lib"
      }
    };
    const sourceFile = resolve(buildRoot, "sources.json");
    writeFileSync(
      sourceFile,
      JSON.stringify({ platform: "linux", architecture: "x64", ...sources })
    );
    const builtRoot = resolve(buildRoot, "koed-runtime");
    procureRuntime({
      sourcesPath: sourceFile,
      runtimeRoot: builtRoot,
      platform: "linux",
      architecture: "x64",
      workDir: resolve(buildRoot, "work"),
      cacheDir: resolve(buildRoot, "cache")
    });
    if (existsSync(resolve(builtRoot, "llama.cpp/cuda")))
      throw new Error("CPU-only procurement produced CUDA content.");
    pruneNativeRuntimeBuildArtifacts(builtRoot);
    stripNativeRuntimeBinaries({ runtimeRoot: builtRoot, platform: "linux" });
    for (const [name, path] of Object.entries(redistributables))
      copyFileSync(path, resolve(builtRoot, "llama.cpp/cpu", name));
    // PostgreSQL tools must find their selected libpq after relocation.
    for (const file of collectPlatformBinaries({
      runtimeRoot: resolve(builtRoot, "postgres"),
      platform: "linux"
    })) {
      const library = relative(
        dirname(file),
        resolve(builtRoot, "postgres/lib")
      );
      run("patchelf", [
        "--set-rpath",
        library ? `$ORIGIN/${library}` : "$ORIGIN",
        file
      ]);
    }
    writeRuntimeAssetManifest({
      runtimeRoot: builtRoot,
      platform: "linux",
      architecture: "x64",
      versions: {
        postgres: sources.postgres.version,
        llamaCpp: sources.llamaCpp.version
      }
    });
    // PostgreSQL installs timezone aliases as hard links. Copy to independent
    // files before freezing; the admitted archive never carries hard links.
    cpSync(builtRoot, runtimeRoot, { recursive: true, verbatimSymlinks: true });
    freezeCore({ runtimeRoot, configuration, recipe });
    return packageFrozenCore({ runtimeRoot, outDir: out });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    process.umask(originalUmask);
    rmSync(buildRoot, { recursive: true, force: true });
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "out-dir": { type: "string" },
      "source-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" }
    }
  });
  if (values.help)
    console.log(
      "Usage: node scripts/native-runtime/build-core-linux-x64.mjs --out-dir <new-directory> [--source-dir <frozen-core>] [--json]"
    );
  else {
    if (!values["out-dir"]) throw new Error("Provide a new --out-dir.");
    const report = buildLinuxCore({
      outDir: values["out-dir"],
      sourceDir: values["source-dir"]
    });
    console.log(JSON.stringify(report, null, 2));
  }
}
