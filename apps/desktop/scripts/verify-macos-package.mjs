#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function commandRunner(runCommand) {
  return (command, args) => {
    const result = runCommand(command, args, { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed with ${result.status}.`
      );
    }
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  };
}

function verifyApp(appPath, expectedVersion, expectedTeamId, run) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  const bundleVersion = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    resolve(appPath, "Contents/Info.plist")
  ]).trim();
  const rendererVersion = JSON.parse(
    readFileSync(
      resolve(appPath, "Contents/Resources/app-dist/koed-release-version.json"),
      "utf8"
    )
  ).version;
  if (
    bundleVersion !== expectedVersion ||
    rendererVersion !== expectedVersion
  ) {
    throw new Error(
      `Packaged Desktop version mismatch: expected ${expectedVersion}, bundle ${bundleVersion}, renderer ${String(rendererVersion)}.`
    );
  }
  if (!expectedTeamId) return;
  const details = run("codesign", ["-dv", "--verbose=4", appPath]);
  if (!/^Authority=Developer ID Application: .+$/m.test(details)) {
    throw new Error(
      "Packaged Desktop requires Developer ID Application authority."
    );
  }
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1];
  if (team !== expectedTeamId)
    throw new Error("Packaged Desktop signing team mismatch.");
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
}

export function verifyMacosPackage({
  appPath,
  dmgPath,
  expectedVersion,
  expectedTeamId,
  runCommand = spawnSync
}) {
  const run = commandRunner(runCommand);
  verifyApp(resolve(appPath), expectedVersion, expectedTeamId, run);
  if (!dmgPath) return;
  const mountPath = mkdtempSync(join(tmpdir(), "koed-desktop-dmg-"));
  let mounted = false;
  try {
    run("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPath,
      resolve(dmgPath)
    ]);
    mounted = true;
    const apps = readdirSync(mountPath).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1)
      throw new Error(`Expected one .app bundle in ${basename(dmgPath)}.`);
    verifyApp(join(mountPath, apps[0]), expectedVersion, expectedTeamId, run);
  } finally {
    // Never recursively delete a mount point while the image is still mounted.
    if (mounted) run("hdiutil", ["detach", mountPath]);
    rmSync(mountPath, { force: true, recursive: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const valueFor = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const appPath = valueFor("--app");
  if (!appPath || args.includes("--help") || args.includes("-h")) {
    console.error(
      "Usage: verify-macos-package.mjs --app <path-to-app> [--dmg <path-to-dmg>] [--expected-version <version>] [--expected-team-id <id>]"
    );
    process.exitCode = appPath ? 0 : 2;
    return;
  }
  verifyMacosPackage({
    appPath,
    dmgPath: valueFor("--dmg"),
    expectedVersion:
      valueFor("--expected-version") ??
      JSON.parse(
        readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")
      ).version,
    expectedTeamId: valueFor("--expected-team-id")
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
