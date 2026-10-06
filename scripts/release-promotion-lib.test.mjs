import assert from "node:assert/strict";
import test from "node:test";
import { planReleasePromotion } from "./release-promotion-lib.mjs";

const sha256 = "a".repeat(64);
const expected = {
  version: "1.2.3",
  npm: { integrity: "sha512-abc=", inventorySha256: sha256 },
  github: {
    assets: [
      { name: "base.tar.gz", sha256, signature: "ed25519:fixture" },
      { name: "privacy.tar.gz", sha256, signature: "ed25519:fixture" }
    ]
  }
};
const authorized = {
  publish: true,
  signerReady: true,
  trustRootsReady: true
};
const remoteDraft = {
  npm: null,
  github: {
    tag_name: "v1.2.3",
    draft: true,
    assets: [{ name: "base.tar.gz", sha256 }]
  }
};

test("partial draft only uploads missing assets; signer absence blocks publication", () => {
  const plan = planReleasePromotion(expected, remoteDraft, authorized);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions, [
    { kind: "upload-missing-draft-assets", names: ["privacy.tar.gz"] }
  ]);
  const blocked = planReleasePromotion(expected, remoteDraft, {
    ...authorized,
    signerReady: false
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(
    !blocked.actions.some((action) => action.kind === "publish-candidate")
  );
});

test("immutable mismatches and incomplete candidates block stable promotion", () => {
  const mismatch = planReleasePromotion(
    expected,
    {
      npm: {
        version: expected.version,
        integrity: "sha512-wrong=",
        tag: "1.2.3-candidate"
      },
      github: { tag_name: "v1.2.3", draft: true, assets: [] }
    },
    authorized
  );
  assert.equal(mismatch.status, "blocked");
  assert.match(mismatch.reasons.join(" "), /immutable tarball/);

  const candidate = planReleasePromotion(
    expected,
    {
      npm: {
        version: expected.version,
        integrity: expected.npm.integrity,
        tag: "1.2.3-candidate"
      },
      github: {
        tag_name: "v1.2.3",
        draft: true,
        assets: expected.github.assets
      }
    },
    authorized
  );
  assert.deepEqual(candidate.actions, [{ kind: "verify-registry" }]);
  const firstPublication = planReleasePromotion(
    expected,
    {
      npm: null,
      github: {
        tag_name: "v1.2.3",
        draft: true,
        assets: expected.github.assets
      }
    },
    authorized
  );
  assert.deepEqual(firstPublication.actions, [
    { kind: "publish-candidate", tag: "1.2.3-candidate" }
  ]);
  const downgrade = planReleasePromotion(
    expected,
    {
      npm: null,
      latestVersion: "1.10.0",
      github: {
        tag_name: "v1.2.3",
        draft: true,
        assets: expected.github.assets
      }
    },
    authorized
  );
  assert.equal(downgrade.status, "blocked");
  assert.match(downgrade.reasons.join(" "), /downgrade/);
});

test("verified complete candidate promotes latest then GitHub without overwriting", () => {
  const plan = planReleasePromotion(
    expected,
    {
      npm: {
        version: expected.version,
        integrity: expected.npm.integrity,
        tag: "1.2.3-candidate",
        verified: true
      },
      github: {
        tag_name: "v1.2.3",
        draft: true,
        assets: expected.github.assets,
        published: false
      }
    },
    authorized
  );
  assert.deepEqual(plan.actions, [
    { kind: "promote-latest" },
    { kind: "publish-github" }
  ]);
  const unverified = planReleasePromotion(
    expected,
    {
      npm: {
        version: expected.version,
        integrity: expected.npm.integrity,
        tag: "1.2.3-candidate",
        verified: false
      },
      github: {
        tag_name: "v1.2.3",
        draft: true,
        assets: expected.github.assets,
        published: false
      }
    },
    authorized
  );
  assert.deepEqual(unverified.actions, [{ kind: "verify-registry" }]);
});
