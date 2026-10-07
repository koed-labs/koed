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

test("official promotion invokes configured adapter behind signer and approval gates", () => {
  for (const key of [
    "KOED_COMPONENT_SIGNER_URL",
    "KOED_COMPONENT_SIGNER_KEY_ID",
    "KOED_COMPONENT_TRUST_ROOTS_SHA256",
    "KOED_NPM_PUBLICATION_AUTHORIZED",
    "KOED_RELEASE_PROMOTION_APPROVED"
  ])
    assert.ok(release.includes(key), `missing release gate ${key}`);
  assert.match(release, /node scripts\/release-promotion-adapter\.mjs/);
  const adapter = readFileSync(
    resolve(root, "scripts/release-promotion-adapter.mjs"),
    "utf8"
  );
  assert.match(adapter, /Missing required promotion option: \$\{field\}/);
  assert.match(adapter, /main\(\)\.catch\([\s\S]*process\.exitCode = 1/);
  assert.doesNotMatch(adapter, /process\.exit\(0\)/);
  assert.doesNotMatch(release, /draft=false|npm publish|npm dist-tag/);
  assert.doesNotMatch(recovery, /draft=false/);
});
