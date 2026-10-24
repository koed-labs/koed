import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { hqAcceptanceContract } from "./hq-acceptance-contract.mjs";
import {
  sharingHelpPoints,
  sharingHelpInstructions
} from "../../../packages/shared/src/sharing-help.ts";

const ids = new Set(hqAcceptanceContract.map((entry) => entry.id));
assert.deepEqual(
  sharingHelpPoints.map((point) => point.id),
  ["P1", "P2", "P3", "P4", "P5"]
);
const doc = await readFile(
  fileURLToPath(new URL("../../../docs/how-koed-works.md", import.meta.url)),
  "utf8"
);
for (const point of sharingHelpPoints) {
  assert.ok(point.keptTrueBy.length, `${point.id} has no acceptance proof`);
  for (const id of point.keptTrueBy)
    assert.ok(ids.has(id), `${point.id} refers to missing ${id}`);
  assert.ok(
    doc.includes(point.text),
    `${point.id} differs from the docs mirror`
  );
  assert.ok(
    sharingHelpInstructions.includes(point.text),
    `${point.id} differs from Chief instructions`
  );
}
process.stdout.write("HQ-725 help: P1–P5 mirror and acceptance IDs pass\n");
