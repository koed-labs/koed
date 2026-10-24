import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
const { jobs } = parse(
  readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8"
  )
);

test("both component targets freeze before complete catalog and control-plane packaging", () => {
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? [])
      assert.doesNotMatch(step.run ?? "", /--catalogless-development/);
  }
  const frozen = jobs["frozen-component-release-assets"];
  assert.ok(frozen, "independent component-build job missing");
  assert.deepEqual(
    frozen.strategy.matrix.include
      .map((target) => `${target.platform}-${target.arch}`)
      .sort(),
    ["linux-x64", "macos-arm64"]
  );
  assert.equal(frozen.needs, "release");
  assert.ok(
    !frozen.steps.some((step) =>
      /public-package|koed-server:package|desktop:package/.test(step.run ?? "")
    )
  );
  const catalog = jobs["component-manifest-catalog"];
  assert.ok(catalog.needs.includes("frozen-component-release-assets"));
  assert.ok(
    catalog.steps.some((step) =>
      /scripts\/component-manifest-catalog.mjs/.test(step.run ?? "")
    )
  );
  assert.ok(
    catalog.steps.some((step) =>
      /verify-frozen-component-assets/.test(step.run ?? "")
    )
  );
  for (const name of [
    "standalone-koed-server-release-assets",
    jobs["signed-desktop-release-assets"]
      ? "signed-desktop-release-assets"
      : "unsigned-desktop-release-assets"
  ]) {
    const job = jobs[name];
    assert.ok(
      job.needs.includes("component-manifest-catalog"),
      `${name} missing catalog dependency`
    );
    assert.match(
      job.env.KOED_COMPONENT_MANIFEST_CATALOG,
      /component-manifest-hashes\.json$/
    );
    assert.ok(
      job.steps.some((step) => step.with?.name === "koed-component-catalog"),
      `${name} missing immutable artifact`
    );
    assert.ok(
      !job.steps.some((step) =>
        /build-koed-component-release/.test(step.run ?? "")
      ),
      `${name} must never rebuild frozen components`
    );
  }
});
