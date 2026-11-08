import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const desktop = resolve(import.meta.dirname, "..");
const guard = resolve(desktop, "scripts/validate-linux-release.mjs");

test("Linux release config targets x64 AppImage with explicit artifact name", () => {
  const config = parse(
    readFileSync(join(desktop, "electron-builder.yml"), "utf8")
  );
  assert.ok(config.linux.target.includes("AppImage"));
  assert.equal(config.linux.artifactName, "Koed-${version}-${arch}.${ext}");
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  assert.match(pkg.scripts["package:linux:release"], /--linux AppImage --x64/);
});

test("release guard rejects missing source and non-Linux x64 staging", (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = () =>
    spawnSync(process.execPath, [guard, root], {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: "" }
    });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "darwin", architecture: "arm64" } })
  );
  let result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linux x64/);
  writeFileSync(
    join(root, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
  );
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native|Linux x64/i);
});

test("release guard accepts validated staging and propagates validator failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
  );
  const module = await import("./validate-linux-release.mjs");
  const options = {
    runtimeRoot: root,
    platform: "linux",
    arch: "x64",
    nativeRuntimeSource: root
  };
  const runValidator = (_command, args) => {
    assert.equal(args[1], "--runtime-root");
    assert.equal(
      readFileSync(join(args[2], "desktop-bundle-manifest.json"), "utf8"),
      readFileSync(join(root, "desktop-bundle-manifest.json"), "utf8")
    );
    return {
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        packagedProvider: { skipped: false, ok: true }
      }),
      stderr: ""
    };
  };
  assert.doesNotThrow(() =>
    module.validateLinuxRelease({ ...options, runValidator })
  );
  assert.throws(
    () =>
      module.validateLinuxRelease({
        ...options,
        runValidator: () => ({
          status: 1,
          stdout: JSON.stringify({ ok: false }),
          stderr: ""
        })
      }),
    /validation failed/i
  );
  assert.throws(
    () =>
      module.validateLinuxRelease({
        ...options,
        runValidator: () => ({
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            packagedProvider: { skipped: true }
          }),
          stderr: ""
        })
      }),
    /validation failed/i
  );
});

test(
  "Linux x64 release guard accepts a validated staged runtime",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !process.env.KOED_TEST_LINUX_RELEASE_RUNTIME
  },
  () => {
    const root = process.env.KOED_TEST_LINUX_RELEASE_RUNTIME;
    const result = spawnSync(process.execPath, [guard, root], {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: root },
      timeout: 300000
    });
    assert.equal(result.status, 0, result.stderr);
  }
);

test(
  "Linux x64 release guard runs native validator and rejects incomplete runtime",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(
      join(root, "desktop-bundle-manifest.json"),
      JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
    );
    const result = spawnSync(process.execPath, [guard, root], {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: root }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /native.runtime.validation/i);
    assert.match(result.stderr, /validation failed/i);
  }
);
