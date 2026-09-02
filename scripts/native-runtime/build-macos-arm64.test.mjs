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

const createFixtureRuntime = (sourceDir) => {
  for (const executable of ["initdb", "pg_ctl", "psql", "pg_config"]) {
    writeExecutable(resolve(sourceDir, "postgres", "bin", executable));
  }
  writeExecutable(resolve(sourceDir, "llama.cpp", "llama-server"));
};

test("macOS runtime staging can regenerate provenance without an archive", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-staging-test-"));
  const sourceDir = resolve(root, "source", "koed-runtime");
  const outDir = resolve(root, "output");
  try {
    createFixtureRuntime(sourceDir);

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
    assert.deepEqual(provenance.source, { kind: "verified-runtime-source" });
    assert.equal(provenance.generatedAt, "1970-01-01T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS runtime archives are identical across clean source and output paths", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-repeat-test-"));
  const firstSource = resolve(root, "first-source", "koed-runtime");
  const secondSource = resolve(root, "second-source", "koed-runtime");
  const firstOut = resolve(root, "first-output");
  const secondOut = resolve(root, "second-output");
  try {
    createFixtureRuntime(firstSource);
    createFixtureRuntime(secondSource);
    const build = (sourceDir, outDir) =>
      spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "build-macos-arm64.mjs"),
          "--source-dir",
          sourceDir,
          "--out-dir",
          outDir,
          "--version",
          "repeatable",
          "--allow-host-mismatch",
          "--json"
        ],
        {
          encoding: "utf8",
          env: { ...process.env, SOURCE_DATE_EPOCH: "123" }
        }
      );
    const first = build(firstSource, firstOut);
    const second = build(secondSource, secondOut);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const archiveName = "koed-native-runtime-macos-arm64-repeatable.tar.gz";
    assert.deepEqual(
      readFileSync(resolve(firstOut, archiveName)),
      readFileSync(resolve(secondOut, archiveName))
    );
    const listing = spawnSync("tar", ["-tzf", resolve(firstOut, archiveName)], {
      encoding: "utf8"
    });
    assert.equal(listing.status, 0, listing.stderr || listing.stdout);
    assert.match(listing.stdout, /koed-runtime\/postgres\/bin\/initdb/);
    assert.deepEqual(
      readFileSync(resolve(firstOut, "provenance.json")),
      readFileSync(resolve(secondOut, "provenance.json"))
    );
    const provenance = JSON.parse(
      readFileSync(resolve(firstOut, "provenance.json"), "utf8")
    );
    assert.equal(provenance.generatedAt, "1970-01-01T00:02:03.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
