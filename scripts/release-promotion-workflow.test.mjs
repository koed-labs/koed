import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const release = readFileSync(
  resolve(root, ".github/workflows/release.yml"),
  "utf8"
);

test("asset jobs only run for absent releases or resumable drafts", () => {
  assert.match(
    release,
    /echo "draft=\$\(jq -r '\.draft' <<< "\$\{release\}"\)" >> "\$\{GITHUB_OUTPUT\}"/
  );
  assert.match(
    release,
    /id: release_assets\n\s+if: steps\.changesets\.outputs\.hasChangesets == 'false' && \(steps\.release\.outputs\.exists == 'false' \|\| steps\.release\.outputs\.draft == 'true'\)/
  );
});

test("release retries verify existing asset bytes and never clobber", () => {
  assert.doesNotMatch(release, /--clobber/);
  assert.match(release, /scripts\/ensure-release-assets\.mjs/);
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
});
