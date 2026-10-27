import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const release = readFileSync(
  resolve(root, ".github/workflows/release.yml"),
  "utf8"
);

test("candidate verification has read-only permissions and protected build identity dependencies", () => {
  const { jobs } = parse(release);
  const identity = jobs["reviewed-release-identity"];
  const verification = jobs["verify-release-candidate"];
  assert.ok(identity, "missing independent build identity job");
  assert.deepEqual(verification.permissions, {
    contents: "read",
    actions: "read"
  });
  assert.ok(verification.needs.includes("reviewed-release-identity"));
  assert.ok(jobs["publish-release"].needs.includes("verify-release-candidate"));
  assert.equal(
    verification.steps.some((step) => step.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
    false
  );
  const verifyStep = verification.steps.find((step) =>
    step.run?.includes("--verify-only")
  );
  assert.ok(verifyStep);
  assert.ok(verifyStep.run.includes("--identity-artifact-id"));
  assert.ok(identity.steps.some((step) => step.id === "identity-upload"));
});

test("reviewed identity comes from immutable build artifacts, not candidate draft; publication retains separate approval", () => {
  const { jobs } = parse(release);
  const identity = jobs["reviewed-release-identity"];
  const hashStep = identity.steps.find((step) => step.id === "identity");
  assert.match(hashStep.run, /scripts\/reviewed-build-identity\.mjs/);
  assert.doesNotMatch(
    identity.steps.map((step) => step.run ?? "").join("\n"),
    /releases\/|release download|release view/
  );
  assert.ok(
    jobs["verify-release-candidate"].steps.some((step) =>
      step.run?.includes("scripts/component-pin-rehearsal.mjs")
    )
  );
  const publication = jobs["publish-release"].steps.find((step) =>
    step.run?.includes("--trust-roots ")
  );
  assert.equal(
    publication.env.KOED_RELEASE_PROMOTION_APPROVED,
    "${{ vars.KOED_RELEASE_PROMOTION_APPROVED }}"
  );
  assert.equal(
    publication.env.KOED_NPM_PUBLICATION_AUTHORIZED,
    "${{ vars.KOED_NPM_PUBLICATION_AUTHORIZED }}"
  );
  assert.match(publication.run, /--expected-build-sha256/);
  const signed = jobs["signed-desktop-release-assets"];
  const desktop = (signed ?? jobs["unsigned-desktop-release-assets"]).steps;
  const retained = desktop.findIndex(
    (step) => step.with?.name === "koed-desktop-final-assets"
  );
  assert.ok(retained >= 0, "Desktop job retains final bytes");
  // Retain only after signing/notarization/sealing, integrity and composition
  // checks, so the protected identity binds the bytes that are published.
  for (const marker of signed
    ? [
        "desktop:package:release",
        "verify-macos-package",
        "inspect-desktop-artifact"
      ]
    : ["verify-packaged-component-catalog", "inspect-desktop-artifact"]) {
    const index = desktop.findIndex((step) => step.run?.includes(marker));
    assert.ok(index >= 0, `missing Desktop check: ${marker}`);
    assert.ok(
      retained > index,
      `final Desktop bytes retained before ${marker}`
    );
  }
  assert.match(
    desktop[retained].with.path,
    signed
      ? /koed-desktop-macos-arm64\.sha256/
      : /koed-desktop-macos-arm64-unsigned\.sha256/
  );
});

test("protected identity downloads flatten artifact-ID layout to expected CLI path", () => {
  const { jobs } = parse(release);
  for (const jobName of ["verify-release-candidate", "publish-release"]) {
    const job = jobs[jobName];
    const download = job.steps.find((step) =>
      step.with?.["artifact-ids"]?.includes(
        "needs.reviewed-release-identity.outputs.artifact_id"
      )
    );
    assert.ok(download, `${jobName}: missing identity artifact download`);
    assert.equal(
      download.with["merge-multiple"],
      true,
      `${jobName}: artifact-ID download must not add artifact-name subdirectory`
    );
    assert.equal(download.with.path, "scratch/expected-build");
    assert.ok(
      job.steps.some((step) =>
        step.run?.includes(
          "--expected-build scratch/expected-build/reviewed-build.json"
        )
      )
    );
  }
});

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
