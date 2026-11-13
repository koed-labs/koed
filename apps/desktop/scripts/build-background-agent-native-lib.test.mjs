import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { createNativeBuildPlan } from "./build-background-agent-native-lib.mjs";

test("keeps the GYP file out of the package root to prevent implicit installs", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(packageJson.scripts.install, undefined);
  assert.equal(packageJson.scripts.preinstall, undefined);
  assert.equal(existsSync(new URL("../binding.gyp", import.meta.url)), false);
  assert.equal(
    existsSync(
      new URL("../src/background-agent/native/binding.gyp", import.meta.url)
    ),
    true
  );
});

test("does not compile the macOS XPC module for other host platforms", () => {
  assert.equal(
    createNativeBuildPlan({
      platform: "linux",
      electronVersion: "45.2.3",
      arch: "x64",
      desktopRoot: "/repo/apps/desktop"
    }),
    undefined
  );
});

test("targets the installed Electron ABI and copies to the Electron output tree", () => {
  assert.deepEqual(
    createNativeBuildPlan({
      platform: "darwin",
      electronVersion: "45.2.3",
      arch: "arm64",
      desktopRoot: "/repo/apps/desktop"
    }),
    {
      configureArgs: [
        "configure",
        "--target=45.2.3",
        "--dist-url=https://electronjs.org/headers",
        "--arch=arm64"
      ],
      buildArgs: ["build"],
      desktopRoot: "/repo/apps/desktop",
      buildRoot: "/repo/scratch/macos-background-native-build",
      sourcePath:
        "/repo/scratch/macos-background-native-build/build/Release/koed_background_xpc.node",
      destinationPath:
        "/repo/apps/desktop/dist-electron/background-agent/native/koed_background_xpc.node"
    }
  );
});

test("rejects unsupported Electron versions and architectures", () => {
  assert.throws(
    () =>
      createNativeBuildPlan({
        platform: "darwin",
        electronVersion: "45.x",
        arch: "arm64",
        desktopRoot: "/repo/apps/desktop"
      }),
    /Electron version must be an exact version/u
  );
  assert.throws(
    () =>
      createNativeBuildPlan({
        platform: "darwin",
        electronVersion: "45.2.3",
        arch: "universal",
        desktopRoot: "/repo/apps/desktop"
      }),
    /architecture must be arm64 or x64/u
  );
});
