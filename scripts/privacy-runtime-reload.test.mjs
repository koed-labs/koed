import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPrivacyReload,
  classificationSignature
} from "./privacy-runtime-reload.mjs";

const classification = {
  classifier: { modelKey: "fixture", classifierHash: "verified" },
  fields: [{ spans: [{ start: 0, end: 5, label: "private_person" }] }]
};
const check = (status, result = classification) =>
  assertPrivacyReload({
    provider: "coreml",
    status,
    classification: result,
    initialSignature: classificationSignature(classification)
  });

test("accepts a successful accelerator reload even if it becomes idle before status is read", () => {
  assert.doesNotThrow(() =>
    check({ activeProvider: "coreml", acceleratorResident: false })
  );
});

test("rejects CPU fallback after accelerator reload", () => {
  assert.throws(
    () => check({ activeProvider: "cpu", acceleratorResident: false }),
    /provider/
  );
});

test("rejects changed classification after reload", () => {
  assert.throws(
    () =>
      check(
        { activeProvider: "coreml", acceleratorResident: true },
        { ...classification, fields: [{ spans: [] }] }
      ),
    /classification/
  );
});
