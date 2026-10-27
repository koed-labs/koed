import assert from "node:assert/strict";
import test from "node:test";
import { runPinRehearsal } from "./component-pin-rehearsal.mjs";

test("isolated pin rehearsal exercises real online/offline installer, admission and tamper rejection without signer or native claims", async () => {
  const result = await runPinRehearsal();
  assert.equal(result.kind, "fixture-pin-rehearsal");
  assert.deepEqual(result.accepted, ["offline", "online-fixture"]);
  assert.deepEqual(result.rejected, [
    "manifest",
    "archive",
    "file",
    "missing-pins",
    "wrong-pins"
  ]);
  assert.equal(result.nativeAcceptance, false);
});
