import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { compileParity } from "../../../scripts/hq-acceptance-parity.mjs";
import { hqAcceptanceContract } from "./hq-acceptance-contract.mjs";
import { earlyProofs } from "./validate-hq901-early-proofs.mjs";
import { lateProofs } from "./validate-hq901-late-proofs.mjs";

const strings = (value) => {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
};

export function freshBrowserProof(root, proof, startedAt) {
  if (!proof.runner || !proof.reportPath || !proof.proofId) return false;
  const path = resolve(root, proof.reportPath);
  if (!existsSync(path) || statSync(path).mtimeMs < startedAt) return false;
  const record = JSON.parse(readFileSync(path, "utf8"));
  return record.status === "pass" && strings(record).includes(proof.proofId);
}

// This report establishes only the simulated-IPC clauses. The full release
// parity command separately executes every real/unit prerequisite, including
// dependencies shared by simulated and real assertions.
export function compileBrowserParity(root, startedAt) {
  assert.ok(Number.isFinite(startedAt), "A fresh chain start is required.");
  const contract = hqAcceptanceContract.filter(
    (item) => item.harness === "simulated-ipc"
  );
  const ids = new Set(contract.map((item) => item.id));
  const claims = [...earlyProofs, ...lateProofs].filter((item) =>
    ids.has(item.id)
  );
  const externalPrerequisites = claims.flatMap((item) =>
    (item.requires ?? [])
      .filter((id) => !ids.has(id))
      .map((id) => ({ assertion: item.id, requires: id }))
  );
  const approved = new Set(hqAcceptanceContract.map((item) => item.id));
  assert.ok(
    externalPrerequisites.every((item) => approved.has(item.requires)),
    "Unknown external acceptance prerequisite"
  );
  return {
    scope: "simulated-ipc-only",
    releaseReady: false,
    externalPrerequisites,
    ...compileParity(
      contract,
      claims.map((item) => ({
        ...item,
        requires: (item.requires ?? []).filter((id) => ids.has(id))
      })),
      (proof) => freshBrowserProof(root, proof, startedAt)
    )
  };
}
