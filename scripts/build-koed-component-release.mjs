#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { stageRuntimeComponents } from "./component-assembly.mjs";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import { parse } from "yaml";
import {
  assertElectronVersionMatchesLock,
  componentRuntimeDeclarations
} from "./koed-component-runtime-policy.mjs";
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
  let electronIdentity;
  if (
    options.platform === "macos" &&
    options.architecture === "arm64" &&
    process.platform === "darwin" &&
    process.arch === "arm64"
  ) {
    const lock = parse(
      readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8")
    );
    const installedElectron = JSON.parse(
      readFileSync(
        resolve(repoRoot, "apps/desktop/node_modules/electron/package.json"),
        "utf8"
      )
    );
    assertElectronVersionMatchesLock({
      lockVersion:
        lock.importers?.["apps/desktop"]?.devDependencies?.electron?.version,
      installedVersion: installedElectron.version
    });
    const electronPath = resolve(
      repoRoot,
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    );
    const measured = spawnSync(
      electronPath,
      [
        "-p",
        "JSON.stringify({electron:process.versions.electron,node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})"
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      }
    );
    if (measured.error) throw measured.error;
    if (measured.status !== 0)
      throw new Error(
        `Unable to measure the installed Electron runtime: ${measured.stderr}`
      );
    const identity = JSON.parse(measured.stdout.trim());
    if (identity.platform !== "darwin" || identity.arch !== "arm64")
      throw new Error("Installed Electron does not match macOS arm64 target.");
    electronIdentity = {
      version: identity.electron,
      nodeVersion: identity.node,
      modulesAbi: identity.modules,
      napiVersion: Number(identity.napi)
    };
  }
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
    target: {
      platform: options.platform,
      architecture: options.architecture,
      ...(options.platform === "linux"
        ? { libc: { family: "glibc", minimumVersion: "2.35" } }
        : {})
    },
    runtimes: componentRuntimeDeclarations({
      nodeModulesAbi: process.versions.modules,
      electronIdentity
    }),
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
