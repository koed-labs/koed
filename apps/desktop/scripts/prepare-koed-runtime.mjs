#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { canonicalArtifactBytes } from "../../../packages/koed-server/src/artifact-canonical-json.mjs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { inventoryRuntime } from "./finalize-runtime-manifests.mjs";
import {
  pruneSharedAppRuntimeMetadata,
  stageSharedAppRuntime
} from "../../../scripts/app-runtime-staging.mjs";
import { prunePrivacyRuntimeForTarget } from "../../../scripts/privacy-runtime-package-policy.mjs";
import { removeClaudeAgentSdkPlatformRuntimes } from "../../../scripts/provider-runtime-package-policy.mjs";
import {
  prunePythonEmbeddingRuntimeFiles,
  writeRuntimeAssetManifest
} from "../../../scripts/native-runtime/manifest-lib.mjs";
import { copyNativeRuntimeSource } from "../../../scripts/native-runtime-copy.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const runtimeRoot = resolve(desktopRoot, ".koed-runtime");

const writeNativeManifest = () => writeRuntimeAssetManifest({ runtimeRoot });

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

stageSharedAppRuntime({ repoRoot, runtimeRoot });
removeClaudeAgentSdkPlatformRuntimes(runtimeRoot);
prunePrivacyRuntimeForTarget({
  repoRoot,
  runtimeRoot,
  platform: process.platform === "darwin" ? "macos" : process.platform,
  architecture: process.arch
});
pruneSharedAppRuntimeMetadata(runtimeRoot);
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
rmSync(resolve(runtimeRoot, "privacy-service"), {
  recursive: true,
  force: true
});
const nativeAssets = writeNativeManifest();
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
const bundleManifestPath = resolve(runtimeRoot, "desktop-bundle-manifest.json");
writeFileSync(bundleManifestPath, `${JSON.stringify(bundleManifest)}\n`, {
  mode: 0o600
});
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
