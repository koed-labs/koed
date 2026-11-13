import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { log } from "node:console";
import process from "node:process";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeBuildPlan } from "./build-background-agent-native-lib.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const nodeGypPath = require.resolve("node-gyp/bin/node-gyp.js");
const arch = process.env.npm_config_arch || process.arch;
const teamId = process.env.DESKTOP_MACOS_APPLE_TEAM_ID;

if (teamId && !/^[A-Z0-9]{10}$/u.test(teamId))
  throw new Error(
    "DESKTOP_MACOS_APPLE_TEAM_ID must be a 10-character Team ID."
  );

const plan = createNativeBuildPlan({
  platform: process.platform,
  electronVersion,
  arch,
  desktopRoot
});

if (!plan) {
  const staleAddon = resolve(
    desktopRoot,
    "dist-electron/background-agent/native/koed_background_xpc.node"
  );
  rmSync(staleAddon, { force: true });
  log("Skipping macOS Background Agent native build on non-macOS host.");
} else {
  rmSync(plan.destinationPath, { force: true });
  prepareStagingDirectory(plan);
  const environment = {
    ...process.env,
    NODE_PATH: [
      resolve(plan.desktopRoot, "node_modules"),
      process.env.NODE_PATH
    ]
      .filter(Boolean)
      .join(delimiter)
  };
  for (const args of [plan.configureArgs, plan.buildArgs]) {
    execFileSync(process.execPath, [nodeGypPath, ...args], {
      cwd: plan.buildRoot,
      env: environment,
      stdio: "inherit"
    });
  }
  copyNativeAddon(plan.sourcePath, plan.destinationPath);
  log(`Built native Background Agent addon for Electron ${electronVersion}.`);
}

function prepareStagingDirectory(plan) {
  rmSync(plan.buildRoot, { recursive: true, force: true });
  const nativeSourceDirectory = resolve(
    plan.buildRoot,
    "src/background-agent/native"
  );
  mkdirSync(nativeSourceDirectory, { recursive: true });
  copyFileSync(
    resolve(plan.desktopRoot, "binding.gyp"),
    resolve(plan.buildRoot, "binding.gyp")
  );
  copyFileSync(
    resolve(plan.desktopRoot, "src/background-agent/native/xpc.mm"),
    resolve(nativeSourceDirectory, "xpc.mm")
  );
}

function copyNativeAddon(sourcePath, destinationPath) {
  const temporaryPath = `${destinationPath}.tmp`;
  mkdirSync(dirname(destinationPath), { recursive: true });
  try {
    copyFileSync(sourcePath, temporaryPath);
    renameSync(temporaryPath, destinationPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`Unable to copy native Background Agent addon: ${error}`, {
      cause: error
    });
  }
}
