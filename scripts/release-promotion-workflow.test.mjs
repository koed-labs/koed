import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
    step.run?.includes("node scripts/release-promotion-adapter.mjs")
  );
  assert.equal(jobs["publish-release"].environment, "production");
  assert.equal(publication.env.KOED_RELEASE_PROMOTION_APPROVED, undefined);
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

test("desktop recovery is absent or fails closed until its source is authenticated", () => {
  const path = resolve(root, ".github/workflows/release-desktop-assets.yml");
  if (!existsSync(path)) return;
  const { jobs } = parse(readFileSync(path, "utf8"));
  assert.equal(
    jobs["recover-desktop-assets"].if,
    "${{ github.event_name == 'desktop-recovery-disabled' }}"
  );
});

test("production uses an npm version that supports OIDC dist-tag promotion", () => {
  const { jobs } = parse(release);
  const steps = jobs["publish-release"].steps;
  const provision = steps.findIndex((step) =>
    step.run?.includes("npm install --global npm@11.21.0")
  );
  const publish = steps.findIndex((step) =>
    step.run?.includes("scripts/release-promotion-adapter.mjs")
  );
  assert.ok(provision >= 0 && provision < publish);
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

test("production gate precedes dependency installation", () => {
  const workflow = parse(release);
  const steps = workflow.jobs["publish-release"].steps;
  const gate = steps.findIndex((step) =>
    step.run?.includes("scripts/release-approval.mjs")
  );
  const install = steps.findIndex((step) => step.run?.includes("pnpm install"));
  assert.ok(gate >= 0 && install > gate);
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

test("official promotion invokes pin-only adapter behind publication and approval gates", () => {
  for (const key of ["KOED_NPM_PUBLICATION_AUTHORIZED"])
    assert.ok(release.includes(key), `missing release gate ${key}`);
  assert.match(release, /node scripts\/release-promotion-adapter\.mjs/);
  const adapter = readFileSync(
    resolve(root, "scripts/release-promotion-adapter.mjs"),
    "utf8"
  );
  assert.match(adapter, /Missing required verification option: \$\{field\}/);
  assert.match(adapter, /main\(\)\.catch\([\s\S]*process\.exitCode = 1/);
  assert.doesNotMatch(adapter, /process\.exit\(0\)/);
  assert.doesNotMatch(release, /draft=false|npm publish|npm dist-tag/);
});
