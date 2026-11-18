import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const setup = (t) => {
  const base = resolve("scratch", "candidate-cli-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "Koed.zip"), "zip");
  writeFileSync(join(root, "Koed.dmg"), "dmg");
  const tuple = {
    repository: "koed-labs/koed",
    pr: 537,
    candidateSha: "a".repeat(40),
    workflowSha: "b".repeat(40),
    runId: 1,
    runAttempt: 1,
    artifactId: 2,
    artifactSha256: "c".repeat(64),
    expectedTeamId: "ABCDEFGHIJ",
    version: "1.0.0"
  };
  return {
    root,
    tuple,
    env: {
      ...process.env,
      CANDIDATE_OUTPUT_DIR: root,
      CANDIDATE_ZIP_SHA: hash("zip"),
      CANDIDATE_DMG_SHA: hash("dmg"),
      CANDIDATE_TUPLE: JSON.stringify(tuple)
    }
  };
};
const run = (command, env) =>
  spawnSync(process.execPath, ["scripts/macos-candidate.mjs", command], {
    env,
    encoding: "utf8"
  });

test("checks signed bytes and writes provenance only for matching digests", (t) => {
  const { root, tuple, env } = setup(t);
  assert.equal(run("verify-hashes", env).status, 0);
  assert.equal(run("write-provenance", env).status, 0);
  const result = JSON.parse(
    readFileSync(join(root, "provenance.json"), "utf8")
  );
  assert.deepEqual(result.tuple, tuple);
  assert.equal(result.zipSha256, hash("zip"));
  assert.equal(run("write-provenance", env).status, 1);
});

test("rejects altered signed output before writing provenance", (t) => {
  const { root, env } = setup(t);
  writeFileSync(join(root, "Koed.dmg"), "tampered");
  assert.equal(run("verify-hashes", env).status, 1);
  assert.equal(run("write-provenance", env).status, 1);
});
