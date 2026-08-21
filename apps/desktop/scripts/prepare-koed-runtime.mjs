#!/usr/bin/env node
/* global console, process */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  prunePythonEmbeddingRuntimeFiles,
  writeRuntimeAssetManifest
} from "../../../scripts/native-runtime/manifest-lib.mjs";
import { copyNativeRuntimeSource } from "../../../scripts/native-runtime-copy.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const runtimeRoot = resolve(desktopRoot, ".koed-runtime");

const run = (label, command, args) => {
  console.log(`> ${label}`);
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with ${result.status ?? 1}`);
  }
  console.log(
    `< ${label} finished in ${Math.round(performance.now() - startedAt)}ms`
  );
};

const deploy = (filter, to) =>
  run(`Deploy ${filter}`, "pnpm", [
    "--filter",
    filter,
    "deploy",
    "--legacy",
    "--prod",
    resolve(runtimeRoot, to)
  ]);

const writeNativeManifest = () => writeRuntimeAssetManifest({ runtimeRoot });

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

deploy("@koed/api", "api");
deploy("@koed/worker", "worker");
deploy("@koed/embedding-service", "embedding-service");
deploy("@koed/privacy-service", "privacy-service");
deploy("@koed/mcp-server", "mcp-server");
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
  "api/node_modules/@koed/db/dist/index.js",
  "api/node_modules/@koed/db/drizzle/meta/_journal.json",
  "worker/dist/index.js",
  "embedding-service/dist/index.js",
  "privacy-service/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/capture-hook.js",
  "mcp-server/dist/prompts/mcp-server-instructions.md",
  "mcp-server/dist/prompts/codex-global-agent-guidance.md"
];
const missing = required.filter(
  (entry) => !existsSync(resolve(runtimeRoot, entry))
);
if (missing.length > 0) {
  throw new Error(`Prepared Koed runtime is missing: ${missing.join(", ")}`);
}

// `pnpm deploy --prod` leaves workspace dependency metadata in production mode.
// Restore dev install state so follow-up package/test commands do not prompt.
run("Restore workspace dependencies", "pnpm", [
  "install",
  "--config.confirmModulesPurge=false"
]);

console.log(
  JSON.stringify({ ok: true, runtimeRoot, required, nativeAssets }, null, 2)
);
