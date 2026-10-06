import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const release = readFileSync(
  resolve(root, ".github/workflows/release.yml"),
  "utf8"
);
const recovery = readFileSync(
  resolve(root, ".github/workflows/release-desktop-assets.yml"),
  "utf8"
);

test("release retries verify existing asset bytes and never clobber", () => {
  assert.doesNotMatch(release, /--clobber/);
  assert.doesNotMatch(recovery, /--clobber/);
  assert.match(release, /scripts\/ensure-release-assets\.mjs/);
  assert.match(recovery, /scripts\/ensure-release-assets\.mjs/);
});

test("official promotion remains fail-closed without signer, trust, approval, and npm adapter", () => {
  for (const key of [
    "KOED_COMPONENT_SIGNER_URL",
    "KOED_COMPONENT_SIGNER_KEY_ID",
    "KOED_COMPONENT_TRUST_ROOTS_SHA256",
    "KOED_NPM_PUBLICATION_AUTHORIZED",
    "KOED_RELEASE_PROMOTION_APPROVED"
  ])
    assert.ok(release.includes(key), `missing release gate ${key}`);
  assert.match(
    release,
    /npm candidate\/registry promotion adapters are not implemented/
  );
  assert.match(recovery, /recovery cannot publish release/);
  assert.doesNotMatch(release, /draft=false|npm publish|npm dist-tag/);
  assert.doesNotMatch(recovery, /draft=false/);
});
