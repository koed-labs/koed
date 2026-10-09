#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stageRuntimeComponents } from "./component-assembly.mjs";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import { platformKey, readPackageVersion } from "./koed-server-package-lib.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const parseArgs = (args) => {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") continue;
    if (value === "--version") options.version = args[++index];
    else if (value === "--platform") options.platform = args[++index];
    else if (value === "--arch") options.architecture = args[++index];
    else if (value === "--out-dir") options.outDir = args[++index];
    else if (value !== "--json") throw new Error(`Unknown option: ${value}`);
  }
  options.version ??= readPackageVersion(
    repoRoot,
    "packages/koed-server/package.json"
  );
  options.platform ??= platformKey();
  options.architecture ??= process.arch;
  options.outDir ??= resolve(
    repoRoot,
    "dist",
    "koed-components",
    `${options.platform}-${options.architecture}`
  );
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Component releases must be built with Node.js 24.");
  const componentsRoot = resolve(options.outDir, "components");
  const staged = await stageRuntimeComponents({
    repoRoot,
    outputDir: componentsRoot,
    platform: options.platform,
    architecture: options.architecture
  });
  const pem =
    process.env.KOED_COMPONENT_SIGNING_PRIVATE_KEY_PEM ??
    (process.env.KOED_COMPONENT_SIGNING_PRIVATE_KEY_FILE
      ? readFileSync(
          resolve(process.env.KOED_COMPONENT_SIGNING_PRIVATE_KEY_FILE),
          "utf8"
        )
      : undefined);
  const keyId = process.env.KOED_COMPONENT_SIGNING_KEY_ID;
  const result = buildComponentReleaseSet({
    componentsRoot,
    outDir: options.outDir,
    version: options.version,
    target: { platform: options.platform, architecture: options.architecture },
    runtimes: [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: process.versions.modules
      }
    ],
    requiredFiles: {
      base: staged.baseRequired,
      privacy: staged.privacyRequired
    },
    signing: pem || keyId ? { keyId, privateKey: pem } : undefined
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
