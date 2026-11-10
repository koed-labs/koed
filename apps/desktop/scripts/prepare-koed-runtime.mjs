#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertStagedNativeRuntimeMatches } from "./validate-linux-release.mjs";
import { canonicalArtifactBytes } from "../../../packages/koed-server/src/artifact-canonical-json.mjs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import {
  inventoryRuntime,
  writeDesktopBundleManifest
} from "./finalize-runtime-manifests.mjs";
import { stageRuntimeComponents } from "../../../scripts/component-assembly.mjs";
import { assertNoPrivacyPayload } from "./privacy-payload-inventory.mjs";
import {
  listFiles,
  prunePythonEmbeddingRuntimeFiles,
  sha256Files,
  writeRuntimeAssetManifest
} from "../../../scripts/native-runtime/manifest-lib.mjs";
import { copyNativeRuntimeSource } from "../../../scripts/native-runtime-copy.mjs";
import { verifyFrozenCore } from "../../../scripts/native-runtime/core-artifact.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const runtimeRoot = resolve(desktopRoot, ".koed-runtime");

const writeNativeManifest = () => writeRuntimeAssetManifest({ runtimeRoot });

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

mkdirSync(resolve(repoRoot, "scratch"), { recursive: true });
const componentsRoot = mkdtempSync(
  resolve(repoRoot, "scratch/desktop-components-")
);
let privacyOnlyPackages;
try {
  const staged = await stageRuntimeComponents({
    repoRoot,
    outputDir: componentsRoot,
    platform: process.platform === "darwin" ? "macos" : process.platform,
    architecture: process.arch
  });
  cpSync(staged.baseRoot, runtimeRoot, { recursive: true });
  privacyOnlyPackages = staged.privacyOnlyPackages;
  writeFileSync(
    resolve(runtimeRoot, "desktop-privacy-exclusions.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: privacyOnlyPackages }, null, 2)}\n`
  );
} finally {
  rmSync(componentsRoot, { recursive: true, force: true });
}
const nativeRuntimeSource = process.env.KOED_NATIVE_RUNTIME_SOURCE_DIR?.trim();
if (nativeRuntimeSource) {
  if (!existsSync(nativeRuntimeSource)) {
    throw new Error(
      `KOED_NATIVE_RUNTIME_SOURCE_DIR does not exist: ${nativeRuntimeSource}`
    );
  }
  copyNativeRuntimeSource(resolve(nativeRuntimeSource), runtimeRoot);
}
prunePythonEmbeddingRuntimeFiles(runtimeRoot);
assertNoPrivacyPayload(runtimeRoot, privacyOnlyPackages);
const preservedManifest =
  process.platform === "linux" &&
  nativeRuntimeSource &&
  existsSync(resolve(runtimeRoot, "native-core-manifest.json"));
let nativeAssets;
if (preservedManifest) {
  const core = verifyFrozenCore(resolve(nativeRuntimeSource));
  assertStagedNativeRuntimeMatches({
    source: resolve(nativeRuntimeSource),
    staged: runtimeRoot
  });
  if (
    process.arch !== "x64" ||
    core.target.platform !== "linux" ||
    core.target.architecture !== "x64"
  ) {
    throw new Error("Frozen Linux runtime requires a Linux x64 target.");
  }
  const manifest = JSON.parse(
    readFileSync(resolve(runtimeRoot, "runtime-asset-manifest.json"), "utf8")
  );
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== 2 ||
    manifest.assets
      .map((asset) => asset.id)
      .sort()
      .join(",") !== "llama.cpp,postgres"
  ) {
    throw new Error("Invalid frozen runtime asset manifest.");
  }
  for (const asset of manifest.assets) {
    const root = resolve(runtimeRoot, asset.id);
    const files = listFiles(root).sort();
    const executables =
      asset.id === "postgres"
        ? {
            initdb: "bin/initdb",
            pg_ctl: "bin/pg_ctl",
            psql: "bin/psql",
            pg_config: "bin/pg_config"
          }
        : { llama_server: "llama-server" };
    if (
      asset.platform !== "linux" ||
      asset.architecture !== "x64" ||
      typeof asset.version !== "string" ||
      !asset.version.trim() ||
      asset.packagedResourcePath !== asset.id ||
      asset.installPath !== asset.id ||
      !isDeepStrictEqual(asset.executablePaths, executables) ||
      (asset.id === "llama.cpp" &&
        !isDeepStrictEqual(asset.variants, [
          {
            backend: "cpu",
            executablePath: "cpu/llama-server",
            requirements: { platform: "linux", architecture: "x64" }
          }
        ])) ||
      !Array.isArray(asset.expectedFiles) ||
      JSON.stringify(files) !==
        JSON.stringify([...asset.expectedFiles].sort()) ||
      sha256Files(root, files) !== asset.sha256
    ) {
      throw new Error(`Frozen runtime asset changed: ${asset.id}`);
    }
  }
  nativeAssets = manifest.assets.map((asset) => asset.id);
} else {
  nativeAssets = writeNativeManifest();
}
if (nativeRuntimeSource && nativeAssets.length === 0) {
  throw new Error(
    `KOED_NATIVE_RUNTIME_SOURCE_DIR did not contain recognized native assets: ${nativeRuntimeSource}`
  );
}

const required = [
  "api/dist/index.js",
  "node_modules/@koed/db/dist/index.js",
  "node_modules/@koed/db/drizzle/meta/_journal.json",
  "worker/dist/index.js",
  "embedding-service/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/capture-hook.js",
  "mcp-server/dist/codex-memory-hook.js",
  "mcp-server/dist/prompts/codex-global-agent-guidance.md",
  "node_modules/@koed/mcp-server/dist/prompts/mcp-server-instructions.md",
  "node_modules/@koed/mcp-server/dist/prompts/codex-global-agent-guidance.md"
];
const missing = required.filter(
  (entry) => !existsSync(resolve(runtimeRoot, entry))
);
if (missing.length > 0) {
  throw new Error(`Prepared Koed runtime is missing: ${missing.join(", ")}`);
}

const runtimeFiles = inventoryRuntime(runtimeRoot);
const bundleManifest = {
  schemaVersion: 1,
  productVersion: JSON.parse(
    readFileSync(resolve(desktopRoot, "package.json"), "utf8")
  ).version,
  component: "base",
  target: {
    platform: process.platform === "darwin" ? "macos" : process.platform,
    architecture: process.arch === "arm64" ? "arm64" : "x64"
  },
  files: runtimeFiles
};
writeDesktopBundleManifest(runtimeRoot, bundleManifest);
const bundleManifestDigest = createHash("sha256")
  .update(canonicalArtifactBytes(bundleManifest))
  .digest("hex");

console.log(
  JSON.stringify(
    { ok: true, runtimeRoot, required, nativeAssets, bundleManifestDigest },
    null,
    2
  )
);
