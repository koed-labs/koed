#!/usr/bin/env node
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { prunePythonEmbeddingRuntimeFiles } from "./native-runtime/manifest-lib.mjs";
import {
  pruneSharedAppRuntimeMetadata,
  stageSharedAppRuntime
} from "./app-runtime-staging.mjs";
import { prunePrivacyRuntimeForTarget } from "./privacy-runtime-package-policy.mjs";
import { removeClaudeAgentSdkPlatformRuntimes } from "./provider-runtime-package-policy.mjs";
import {
  deterministicArchiveEntries,
  sourceDate,
  writeDeterministicTarGz
} from "./deterministic-tar-gzip.mjs";
import {
  buildPackageManifest,
  buildPackageProvenance,
  platformKey,
  pruneStandalonePackageMetadata,
  readPackageVersion,
  sha256File,
  validatePackageRoot,
  writePackageManifest,
  writePackageProvenance
} from "./koed-server-package-lib.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

const usage = () => `Usage: pnpm koed-server:package -- [options]

Builds a standalone koed-server JS/service runtime package artifact.

Options:
  --platform <platform>      Package platform key. Defaults to current host.
  --arch <arch>              Package architecture. Defaults to current host.
  --version <version>        Package version. Defaults to @koed/koed-server.
  --out-dir <dir>            Output directory. Defaults to dist/koed-server-package/<platform>-<arch>.
  --json                     Print JSON result.
  -h, --help                 Show help.
`;

const parseArgs = (argv) => {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--") continue;
    if (value === "--platform") options.platform = argv[++i];
    else if (value === "--arch") options.architecture = argv[++i];
    else if (value === "--version") options.version = argv[++i];
    else if (value === "--out-dir") options.outDir = argv[++i];
    else if (value === "--json") options.json = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}\n\n${usage()}`);
  }
  options.platform ||=
    process.env.KOED_SERVER_PACKAGE_PLATFORM ?? platformKey();
  options.architecture ||=
    process.env.KOED_SERVER_PACKAGE_ARCHITECTURE ?? process.arch;
  options.version ||=
    process.env.KOED_SERVER_PACKAGE_VERSION ??
    readPackageVersion(repoRoot, "packages/koed-server/package.json");
  options.outDir ||=
    process.env.KOED_SERVER_PACKAGE_OUT_DIR ??
    resolve(
      repoRoot,
      "dist",
      "koed-server-package",
      `${options.platform}-${options.architecture}`
    );
  return options;
};

const run = (label, command, args, options = {}) => {
  console.error(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with ${result.status ?? 1}`);
  }
  return result;
};

const writeLauncher = (packageRoot) => {
  const launcher = resolve(packageRoot, "bin", "koed-server");
  mkdirSync(resolve(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    launcher,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      'ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
      'export KOED_SERVER_PACKAGE_ROOT="${KOED_SERVER_PACKAGE_ROOT:-$ROOT}"',
      'export KOED_JS_RUNTIME_ROOT="${KOED_JS_RUNTIME_ROOT:-$ROOT/koed-runtime}"',
      'exec node "$ROOT/koed-runtime/koed-server/dist/cli.js" "$@"',
      ""
    ].join("\n")
  );
  chmodSync(launcher, 0o755);
};

const validatePackagedCli = (packageRoot) =>
  run(
    "Validate packaged koed-server CLI",
    process.execPath,
    [
      resolve(packageRoot, "koed-runtime", "koed-server", "dist", "cli.js"),
      "--help"
    ],
    { cwd: packageRoot, stdio: "pipe" }
  );

const writeReadme = (packageRoot) => {
  writeFileSync(
    resolve(packageRoot, "README.txt"),
    [
      "Standalone koed-server package",
      "",
      "This artifact contains the Koed JS/service app runtime only.",
      "It excludes the retired Explorer service, native runtime assets, model files, and Python embedding runtime files.",
      "",
      "Contents:",
      "- bin/koed-server",
      "- koed-runtime/api",
      "- koed-runtime/worker",
      "- koed-runtime/embedding-service",
      "- koed-runtime/privacy-service",
      "- koed-runtime/mcp-server",
      "",
      "Native runtime assets and models are installed separately under KOED_HOME.",
      ""
    ].join("\n")
  );
};

const assertArchiveHasNoSymlinks = (sourceDir) => {
  const symlinks = deterministicArchiveEntries(sourceDir).filter(
    (entry) => entry.type === "symlink"
  );
  if (symlinks.length > 0) {
    throw new Error(
      `Standalone koed-server package archive still contains symlinks:\n${symlinks
        .map((entry) => entry.relativePath)
        .slice(0, 20)
        .join("\n")}`
    );
  }
};

const createArchive = ({ outDir, packageDirName }) => {
  const tarName = `${packageDirName}.tar.gz`;
  const tarPath = resolve(outDir, tarName);
  writeDeterministicTarGz({
    sourceDir: resolve(outDir, packageDirName),
    rootName: packageDirName,
    tarPath
  });
  const sha256 = sha256File(tarPath);
  const sha256Path = resolve(outDir, `${tarName}.sha256`);
  writeFileSync(sha256Path, `${sha256}  ${basename(tarPath)}\n`);
  return { tarPath, sha256Path, sha256 };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const outDir = resolve(options.outDir);
  const packageDirName = `koed-server-${options.version}-${options.platform}-${options.architecture}`;
  const packageRoot = resolve(outDir, packageDirName);
  const runtimeRoot = resolve(packageRoot, "koed-runtime");
  let result;

  {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(runtimeRoot, { recursive: true });

    stageSharedAppRuntime({ repoRoot, runtimeRoot });
    prunePythonEmbeddingRuntimeFiles(runtimeRoot);
    removeClaudeAgentSdkPlatformRuntimes(packageRoot);
    prunePrivacyRuntimeForTarget({
      repoRoot,
      runtimeRoot,
      platform: options.platform,
      architecture: options.architecture
    });
    pruneSharedAppRuntimeMetadata(runtimeRoot);
    pruneStandalonePackageMetadata(packageRoot);
    validatePackagedCli(packageRoot);
    writeLauncher(packageRoot);
    writeReadme(packageRoot);
    const manifest = buildPackageManifest({
      packageRoot,
      repoRoot,
      platform: options.platform,
      architecture: options.architecture,
      version: options.version,
      createdAt: sourceDate()
    });
    writePackageManifest(packageRoot, manifest);
    const validation = validatePackageRoot(packageRoot);
    if (!validation.ok) {
      throw new Error(
        `Standalone koed-server package validation failed:\n${validation.errors.join("\n")}`
      );
    }

    assertArchiveHasNoSymlinks(packageRoot);
    const artifact = createArchive({ outDir, packageDirName });
    const provenancePath = resolve(
      outDir,
      `koed-server-app-runtime-${options.version}-${options.platform}-${options.architecture}.provenance.json`
    );
    const provenance = buildPackageProvenance({
      archivePath: artifact.tarPath,
      manifestPath: resolve(packageRoot, "koed-server-package-manifest.json"),
      manifest,
      createdAt: manifest.createdAt
    });
    writePackageProvenance(provenancePath, provenance);

    result = {
      ok: true,
      packageRoot,
      runtimeRoot,
      manifestPath: resolve(packageRoot, "koed-server-package-manifest.json"),
      requiredFiles: validation.requiredFiles,
      artifact,
      provenance: {
        path: provenancePath,
        signaturePath:
          provenance.signature.status === "signed"
            ? `${provenancePath}.sig`
            : null,
        signatureStatus: provenance.signature.status
      }
    };
  }

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Built ${result.artifact.tarPath}`);
};

main();
