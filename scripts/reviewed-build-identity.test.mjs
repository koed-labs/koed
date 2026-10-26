import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as identity from "./reviewed-build-identity.mjs";
import {
  candidateFixture,
  runtimeIdentities
} from "./test-utils/release-candidate-fixture.mjs";

test("reviewed identity hashes independent build output and rejects colliding output bytes", () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/build-identity-test-"));
  try {
    assert.equal(typeof identity.collectReviewedAssets, "function");
    mkdirSync(resolve(root, "first"));
    mkdirSync(resolve(root, "second"));
    writeFileSync(resolve(root, "first/file.txt"), "hello\n");
    assert.deepEqual(identity.collectReviewedAssets(root), [
      {
        name: "file.txt",
        sha256:
          "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
      }
    ]);
    writeFileSync(resolve(root, "second/file.txt"), "substitution");
    assert.throws(() => identity.collectReviewedAssets(root), /Conflicting/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const approvedNames = [
  "koed-component-catalog",
  "koed-server-app-runtime-linux-x64",
  "koed-server-app-runtime-macos-arm64",
  "koed-desktop-final-assets",
  "koed-native-runtime-linux-x64",
  "koed-release-metadata"
];
const buildInput = (fixture) => ({
  root: fixture.assetsDir,
  repository: "org/repo",
  commit: "a".repeat(40),
  runId: 42,
  runAttempt: 1,
  version: "1.2.3",
  artifacts: approvedNames.map((name, index) => ({
    name,
    id: index + 1,
    digest: `sha256:${"b".repeat(64)}`,
    expired: false,
    workflow_run: { id: 42, head_sha: "a".repeat(40) }
  }))
});

test("createReviewedBuildIdentity binds approved build outputs and independent runtime matrix", () => {
  const f = candidateFixture();
  try {
    writeFileSync(
      resolve(f.assetsDir, "Koed-1.2.3-arm64.zip"),
      "protected zip"
    );
    const result = identity.createReviewedBuildIdentity(buildInput(f));
    assert.deepEqual(result.runtimeIdentities, runtimeIdentities);
    assert.equal(result.artifacts.length, 6);
    assert.deepEqual(result.npm, f.identity.npm);
  } finally {
    f.cleanup();
  }
});

for (const damage of [
  "repository",
  "commit",
  "run",
  "attempt",
  "missing-artifact",
  "duplicate-artifact",
  "expired-artifact",
  "artifact-commit",
  "artifact-run",
  "artifact-digest",
  "npm-name",
  "npm-version",
  "npm-integrity",
  "npm-inventory",
  "npm-bytes",
  "missing-zip",
  "duplicate-zip"
])
  test(`createReviewedBuildIdentity rejects ${damage}`, () => {
    const f = candidateFixture();
    try {
      const input = buildInput(f);
      const zip = resolve(f.assetsDir, "Koed-1.2.3-arm64.zip");
      writeFileSync(zip, "protected zip");
      if (damage === "repository") input.repository = "not-a-repository";
      if (damage === "commit") input.commit = "f".repeat(40);
      if (damage === "run") input.runId = 43;
      if (damage === "attempt") input.runAttempt = 0;
      if (damage === "missing-artifact") input.artifacts.pop();
      if (damage === "duplicate-artifact")
        input.artifacts.push(input.artifacts[0]);
      if (damage === "expired-artifact") input.artifacts[0].expired = true;
      if (damage === "artifact-commit")
        input.artifacts[0].workflow_run.head_sha = "f".repeat(40);
      if (damage === "artifact-run") input.artifacts[0].workflow_run.id = 43;
      if (damage === "artifact-digest") input.artifacts[0].digest = "bad";
      if (damage === "missing-zip") rmSync(zip);
      if (damage === "duplicate-zip")
        writeFileSync(resolve(f.assetsDir, "Koed-other-arm64.zip"), "other");
      if (damage.startsWith("npm-")) {
        const value = structuredClone(f.identity);
        if (damage === "npm-name") value.packageName = "@other/server";
        if (damage === "npm-version") value.version = "9.0.0";
        if (damage === "npm-integrity") value.npm.integrity = "bad";
        if (damage === "npm-inventory") value.npm.inventorySha256 = "bad";
        if (damage === "npm-bytes") value.npm.bytes = 0;
        writeFileSync(
          resolve(f.assetsDir, "koed-labs-server-release-identity.json"),
          JSON.stringify(value)
        );
      }
      assert.throws(
        () => identity.createReviewedBuildIdentity(input),
        /identity|artifact|ZIP/i
      );
    } finally {
      f.cleanup();
    }
  });
