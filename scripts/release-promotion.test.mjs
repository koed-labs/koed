import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  planReleasePromotion
} from "./release-promotion-lib.mjs";

for (const [lower, higher] of [
  ["1.2.3-rc-1", "1.2.3-rc-2"],
  ["1.2.3-rc-10", "1.2.3-rc-2"],
  ["1.2.3-rc", "1.2.3-rc-1"],
  ["1.2.3-rc.2", "1.2.3-rc.10"],
  ["1.2.3-rc.9007199254740992", "1.2.3-rc.9007199254740993"],
  ["1.2.3-rc.1", "1.2.3-rc.1a"],
  ["1.2.3-rc.1", "1.2.3-rc.1.0"],
  ["1.2.3-alpha", "1.2.3-beta"],
  ["1.2.3-rc-2", "1.2.3"],
  ["1.2.3", "1.2.4-rc-1"]
]) {
  test(`SemVer orders ${lower} before ${higher}`, () => {
    assert.ok(compareVersions(lower, higher) < 0);
    assert.ok(compareVersions(higher, lower) > 0);
    assert.equal(compareVersions(lower, lower), 0);
  });
}

test("planner blocks latest downgrade between hyphenated prereleases", () => {
  const sha256 = "a".repeat(64);
  const expected = {
    version: "1.2.3-rc-1",
    catalogVerified: true,
    npm: { integrity: "sha512-abc=", inventorySha256: sha256 },
    github: { assets: [{ name: "base.tar.gz", sha256 }] }
  };
  const plan = planReleasePromotion(
    expected,
    {
      latestVersion: "1.2.3-rc-2",
      npm: {
        version: expected.version,
        integrity: expected.npm.integrity,
        tag: "candidate-1.2.3-rc-1",
        verified: true
      },
      github: {
        tag_name: "v1.2.3-rc-1",
        draft: true,
        assets: expected.github.assets
      }
    },
    { publish: true, signerReady: true, trustRootsReady: true }
  );
  assert.equal(plan.status, "blocked");
  assert.match(plan.reasons.join(" "), /downgrade/);
  assert.deepEqual(plan.actions, []);
});
