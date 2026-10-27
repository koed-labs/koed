import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const release = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8"
);
const ci = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8"
);

test("component release and CI contain no signing service or key prerequisites", () => {
  assert.doesNotMatch(
    release + ci,
    /KOED_COMPONENT_SIGN|KOED_COMPONENT_TRUST_ROOTS|KOED_CONTROLPLANE_TRUST_ROOTS|component_signing_rehearsal|component-signing-rehearsal|release-signing-adapter|\.signature\.json/
  );
  assert.equal(
    existsSync(new URL("../infra/component-signer", import.meta.url)),
    false
  );
});

test("pin-only release preserves protected identity, candidate verification and independent publication approval", () => {
  const workflow = parse(release);
  assert.ok(
    workflow.jobs["publish-release"].needs.includes("verify-release-candidate")
  );
  assert.ok(
    workflow.jobs["publish-release"].needs.includes("reviewed-release-identity")
  );
  assert.match(release, /KOED_NPM_PUBLICATION_AUTHORIZED/);
  assert.match(release, /KOED_RELEASE_PROMOTION_APPROVED/);
  assert.match(release, /verify-frozen-component-assets\.mjs/);
  assert.equal(
    workflow.jobs["publish-release"].permissions["id-token"],
    "write"
  );
  assert.equal(parse(ci).jobs["ci-required"].if, "always()");
});
