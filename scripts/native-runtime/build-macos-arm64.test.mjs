import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const writeExecutable = (path) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "fixture\n", { mode: 0o755 });
};

test("macOS runtime staging can regenerate provenance without an archive", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-staging-test-"));
  const sourceDir = resolve(root, "source", "koed-runtime");
  const outDir = resolve(root, "output");
  try {
    for (const executable of ["initdb", "pg_ctl", "psql", "pg_config"]) {
      writeExecutable(resolve(sourceDir, "postgres", "bin", executable));
    }
    writeExecutable(resolve(sourceDir, "llama.cpp", "llama-server"));

    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "build-macos-arm64.mjs"),
        "--source-dir",
        sourceDir,
        "--out-dir",
        outDir,
        "--version",
        "staged-head",
        "--no-archive",
        "--allow-host-mismatch",
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.artifact, null);
    assert.equal(
      Object.hasOwn(output.timings, "archive and checksum generation"),
      false
    );
    assert.deepEqual(output.nativeAssets, ["postgres", "llama.cpp"]);
    assert.equal(
      readdirSync(outDir).some((entry) => entry.endsWith(".tar.gz")),
      false
    );
    assert.equal(
      readdirSync(outDir).some((entry) => entry.endsWith(".sha256")),
      false
    );
    assert.equal(
      existsSync(
        resolve(outDir, "koed-runtime", "runtime-asset-manifest.json")
      ),
      true
    );
    const provenance = JSON.parse(
      readFileSync(resolve(outDir, "provenance.json"), "utf8")
    );
    assert.equal(provenance.artifact.version, "staged-head");
    assert.equal(provenance.strategy, "koed-verified-runtime-staging");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
