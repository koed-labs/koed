import assert from "node:assert/strict";
import test from "node:test";
import { decideAssetAction } from "./ensure-release-assets.mjs";

test("existing same-byte asset is idempotent and mismatched asset never overwrites", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(
    decideAssetAction({ expectedSha256: digest, actualSha256: digest }),
    { action: "skip" }
  );
  assert.deepEqual(
    decideAssetAction({ expectedSha256: digest, actualSha256: "b".repeat(64) }),
    { action: "block" }
  );
  assert.deepEqual(
    decideAssetAction({ expectedSha256: digest, actualSha256: null }),
    { action: "upload" }
  );
});
