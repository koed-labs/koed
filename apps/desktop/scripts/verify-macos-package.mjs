#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
const expectedVersion =
  valueFor("--expected-version") ??
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")
  ).version;
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

const verifyVersion = (appPath) => {
  const plist = spawnSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print :CFBundleShortVersionString",
      resolve(appPath, "Contents/Info.plist")
    ],
    { encoding: "utf8" }
  );
  if (plist.error) throw plist.error;
  if (plist.status !== 0) {
    throw new Error(
      `Could not read the packaged Desktop version from ${appPath}.`
    );
  }
  const bundleVersion = plist.stdout.trim();
  const rendererMetadataPath = resolve(
    appPath,
    "Contents/Resources/app-dist/koed-release-version.json"
  );
  const rendererVersion = JSON.parse(
    readFileSync(rendererMetadataPath, "utf8")
  ).version;
  if (
    bundleVersion !== expectedVersion ||
    rendererVersion !== expectedVersion
  ) {
    throw new Error(
      `Packaged Desktop version mismatch: expected ${expectedVersion}, bundle ${bundleVersion}, renderer ${String(rendererVersion)}.`
    );
  }
};

try {
  verifyApp(resolve(app));
  verifyVersion(resolve(app));

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
      verifyVersion(join(mountPath, mountedApp));
    } finally {
      spawnSync("hdiutil", ["detach", mountPath], { stdio: "inherit" });
      rmSync(mountPath, { force: true, recursive: true });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
