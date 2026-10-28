import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const jobs = workflow.jobs;
const desktop = jobs["signed-desktop-release-assets"];
const step = (name) => desktop.steps.find((s) => s.name === name);
test("all job dependencies exist; publication requires successful signer", () => {
  for (const job of Object.values(jobs))
    for (const need of [job.needs ?? []].flat())
      assert.ok(jobs[need], `unknown dependency ${need}`);
  assert.ok(
    jobs["publish-release"].needs.includes("signed-desktop-release-assets")
  );
  assert.match(
    jobs["publish-release"].if,
    /needs\['signed-desktop-release-assets'\]\.result == 'success'/
  );
});
test("signer restricted to approved main SHA, inline production builder, scoped secrets", () => {
  assert.equal(desktop.environment, "desktop-release");
  assert.match(desktop.if, /github.ref == 'refs\/heads\/main'/);
  assert.equal(step("Checkout").with.ref, "${{ github.sha }}");
  assert.match(
    step("Build signed Desktop artifacts").run,
    /pnpm desktop:package:release/
  );
  assert.equal(
    step("Build signed Desktop artifacts").env.APPLE_API_KEY,
    "${{ steps.signing.outputs.apple-api-key-path }}"
  );
  assert.equal(step("Remove temporary signing key").if, "always()");
  assert.equal(desktop.uses, undefined);
  for (const s of desktop.steps)
    if (JSON.stringify(s).includes("secrets.DESKTOP_MACOS"))
      assert.ok(
        [
          "Prepare macOS signing credentials",
          "Build signed Desktop artifacts"
        ].includes(s.name)
      );
});
test("trust, smoke, composition, hashes precede immutable release upload", () => {
  const names = desktop.steps.map((s) => s.name);
  const ordered = [
    "Verify Desktop artifact code integrity",
    "Packaged Desktop native smoke",
    "Inspect and gate Desktop artifact composition",
    "Generate Desktop artifact checksums",
    "Upload signed Desktop assets to GitHub release"
  ];
  for (let i = 1; i < ordered.length; i++)
    assert.ok(names.indexOf(ordered[i]) > names.indexOf(ordered[i - 1]));
  assert.match(step(ordered[0]).run, /--expected-team-id/);
  assert.match(
    step(ordered[1]).env.KOED_DESKTOP_PACKAGE_SMOKE_APP_PATH,
    /steps\.desktop\.outputs\.app/
  );
  assert.match(step(ordered[2]).run, /steps\.desktop\.outputs\.app/);
  assert.match(step(ordered.at(-1)).run, /ensure-release-assets\.mjs/);
  assert.match(step(ordered.at(-1)).run, /koed-desktop-macos-arm64\.sha256/);
  assert.match(
    jobs["publish-release"].steps.find(
      (s) => s.name === "Verify required release assets"
    ).run,
    /koed-desktop-macos-arm64\.sha256/
  );
});
test("manual and alternate recovery signers removed", () => {
  assert.equal(
    existsSync(".github/workflows/release-desktop-assets.yml"),
    false
  );
  assert.equal(
    existsSync(".github/workflows/signed-desktop-release-assets.yml"),
    false
  );
  assert.equal(existsSync("scripts/desktop-notarize.mjs"), false);
});
