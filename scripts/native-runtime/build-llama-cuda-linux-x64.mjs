#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildLlamaCuda } from "./procure-runtime.mjs";

const options = {
  sourcesPath: resolve(import.meta.dirname, "sources.linux-x64.json"),
  runtimeRoot: resolve(
    import.meta.dirname,
    "..",
    "..",
    "dist",
    "native-runtime",
    "linux-x64",
    "koed-runtime"
  ),
  json: false
};

for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value === "--") continue;
  if (value === "--sources")
    options.sourcesPath = resolve(process.argv[++index]);
  else if (value === "--runtime-root")
    options.runtimeRoot = resolve(process.argv[++index]);
  else if (value === "--json") options.json = true;
  else if (value === "--help" || value === "-h") options.help = true;
  else throw new Error(`Unknown option: ${value}`);
}

if (options.help) {
  console.log(
    "Usage: native-runtime:build:llama-cuda-linux-x64 -- [--sources <sources.json>] [--runtime-root <koed-runtime>] [--json]"
  );
  process.exit(0);
}
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("CUDA llama-server runtime builds require Linux x64.");
}
if (!existsSync(options.sourcesPath)) {
  throw new Error(
    `Native runtime sources file is missing: ${options.sourcesPath}`
  );
}
const sources = JSON.parse(readFileSync(options.sourcesPath, "utf8"));
if (!sources.llamaCppCuda) {
  throw new Error("Native runtime sources do not define llamaCppCuda.");
}
mkdirSync(options.runtimeRoot, { recursive: true });
const workDir =
  process.env.KOED_NATIVE_RUNTIME_WORK_DIR ??
  mkdtempSync(resolve(tmpdir(), "koed-llama-cuda-build-"));
const cacheDir =
  process.env.KOED_NATIVE_RUNTIME_CACHE_DIR ??
  resolve(import.meta.dirname, "..", "..", ".cache", "native-runtime");
const result = buildLlamaCuda({
  source: sources.llamaCppCuda,
  runtimeRoot: options.runtimeRoot,
  cacheDir,
  workDir
});
if (result.skipped) throw new Error(result.reason);
if (options.json) console.log(JSON.stringify(result, null, 2));
else console.log(`Built ${result.llamaServer}`);
