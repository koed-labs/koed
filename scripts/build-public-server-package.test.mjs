import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const node24 = process.execPath;

test("assembled public package has only koed bin and self-contained control plane", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "koed public package "));
  try {
    execFileSync(
      node24,
      [
        resolve(repoRoot, "scripts/build-public-server-package.mjs"),
        "--out-dir",
        scratch
      ],
      { cwd: repoRoot, stdio: "pipe" }
    );
    const packageDir = resolve(scratch, "package");
    const manifest = JSON.parse(
      readFileSync(resolve(packageDir, "package.json"), "utf8")
    );
    assert.equal(manifest.name, "@koed-labs/server");
    assert.equal(manifest.private, false);
    assert.deepEqual(manifest.bin, { koed: "bin/koed.js" });
    assert.deepEqual(manifest.engines, { node: ">=24 <25" });
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.equal(manifest.scripts, undefined);
    assert.ok(readFileSync(resolve(packageDir, "LICENSE"), "utf8").length > 0);
    assert.ok(
      readFileSync(resolve(packageDir, "third-party-notices.json"), "utf8")
        .length > 0
    );
    assert.ok(
      readFileSync(resolve(packageDir, "bin/koed.js"), "utf8").includes(
        "vendor/control-plane.js"
      )
    );
    const tarball = resolve(scratch, "tarballs", "koed-labs-server.tgz");
    assert.equal(
      readdirSync(resolve(scratch, "tarballs")).filter((name) =>
        name.endsWith(".tgz")
      ).length,
      1
    );
    const packedFiles = execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf8"
    }).split("\n");
    assert.ok(packedFiles.some((file) => file.endsWith("/bin/koed.js")));
    assert.ok(
      packedFiles.some((file) => file.endsWith("/vendor/control-plane.js"))
    );
    assert.ok(packedFiles.every((file) => !file.includes("node_modules/")));
    const inspectTree = (directory) => {
      for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        const info = lstatSync(path);
        assert.equal(
          info.isSymbolicLink(),
          false,
          `unexpected symlink: ${path}`
        );
        if (info.isDirectory()) inspectTree(path);
      }
    };
    inspectTree(packageDir);
    for (const relative of [
      "package.json",
      "bin/koed.js",
      "vendor/control-plane.js",
      "LICENSE",
      "third-party-notices.json"
    ]) {
      const text = readFileSync(resolve(packageDir, relative), "utf8");
      assert.doesNotMatch(text, /workspace:\*|file:\/\//);
      assert.doesNotMatch(text, /\/Users\/[^\s"']+\/agents\/koed/);
    }
    const packageText = JSON.stringify(manifest);
    assert.doesNotMatch(packageText, /koed-server|workspace:|file:/);
    assert.ok(!manifest.bin["koed-server"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
