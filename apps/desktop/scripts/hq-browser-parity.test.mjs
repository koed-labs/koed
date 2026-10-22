import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { freshBrowserProof } from "./hq-browser-parity.mjs";

test("browser proof requires a fresh passing record with the exact proof ID", () => {
  const scratch = resolve(import.meta.dirname, "../../..", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "hq-browser-parity-test-"));
  const proof = {
    runner: "owning-validator.mjs",
    reportPath: "report.json",
    proofId: "S01.1.full"
  };
  const path = resolve(root, proof.reportPath);
  const startedAt = Date.now() - 1000;
  const record = (status, id) => {
    writeFileSync(path, JSON.stringify({ status, proofIds: [id] }));
  };
  try {
    assert.equal(freshBrowserProof(root, proof, startedAt), false);
    record("pass", proof.proofId);
    assert.equal(freshBrowserProof(root, proof, startedAt), true);
    record("pass", "S01.1.partial");
    assert.equal(freshBrowserProof(root, proof, startedAt), false);
    for (const status of ["fail", "skip", "pending"]) {
      record(status, proof.proofId);
      assert.equal(freshBrowserProof(root, proof, startedAt), false);
    }
    record("pass", proof.proofId);
    utimesSync(path, new Date(0), new Date(0));
    assert.equal(freshBrowserProof(root, proof, startedAt), false);
    assert.equal(
      freshBrowserProof(root, { ...proof, runner: undefined }, 0),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
