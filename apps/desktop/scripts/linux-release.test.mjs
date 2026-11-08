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

test("release guard rejects missing native assets and non-Linux x64 staging", (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = () =>
    spawnSync(process.execPath, [guard, root], { encoding: "utf8" });
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
