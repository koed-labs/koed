#!/usr/bin/env node
/* global console, process */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
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
  "privacy-service/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/capture-hook.js",
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

console.log(
  JSON.stringify({ ok: true, runtimeRoot, required, nativeAssets }, null, 2)
);
