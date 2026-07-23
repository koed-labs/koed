#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const usage =
  "Usage: verify-macos-package.mjs --app <path-to-app> [--dmg <path-to-dmg>]";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) return undefined;
  return args[index + 1];
};
const app = valueFor("--app");
const dmg = valueFor("--dmg");
if (!app || args.some((arg) => arg === "--help" || arg === "-h")) {
  console.error(usage);
  process.exit(app ? 0 : 2);
}

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with ${result.status}.`
    );
  }
};

const verifyApp = (appPath) =>
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);

try {
  verifyApp(resolve(app));

  if (dmg) {
    const mountPath = mkdtempSync(join(tmpdir(), "koed-desktop-dmg-"));
    try {
      run("hdiutil", [
        "attach",
        "-nobrowse",
        "-readonly",
        "-mountpoint",
        mountPath,
        resolve(dmg)
      ]);
      const mountedApp = readdirSync(mountPath).find((name) =>
        name.endsWith(".app")
      );
      if (!mountedApp) {
        throw new Error(`No .app bundle found in ${basename(dmg)}.`);
      }
      verifyApp(join(mountPath, mountedApp));
    } finally {
      spawnSync("hdiutil", ["detach", mountPath], { stdio: "inherit" });
      rmSync(mountPath, { force: true, recursive: true });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
