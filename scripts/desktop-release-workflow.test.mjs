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
test("Linux Desktop can access the complete native catalog before embedding pins", () => {
  const linux = jobs["linux-desktop-release-assets"];
  const embed = linux.steps.find(
    (s) => s.name === "Embed native package pins in the release build"
  );
  assert.equal(
    embed.env.NATIVE_CATALOG,
    "${{ needs.macos-native-packages.outputs.catalog }}"
  );
  assert.ok(linux.needs.includes("macos-native-packages"));
});
test("Linux release builds and smokes verified runtime and retains exact final assets", () => {
  const linux = jobs["linux-desktop-release-assets"];
  assert.ok(linux, "missing Linux Desktop release job");
  assert.equal(linux["runs-on"], "ubuntu-22.04");
  for (const dependency of [
    "release",
    "component-manifest-catalog",
    "linux-native-packages"
  ])
    assert.ok(linux.needs.includes(dependency));
  // Desktop bundles only the pinned CPU core, never the combined CPU and
  // CUDA runtime (ADR 0067).
  assert.ok(!linux.needs.includes("native-runtime-linux-x64-release-assets"));
  const steps = linux.steps;
  const commands = steps.map((s) => s.run ?? "").join("\n");
  assert.ok(steps.some((s) => s.with?.name === "koed-linux-native-packages"));
  assert.ok(
    !steps.some((s) => s.with?.name === "koed-native-runtime-linux-x64")
  );
  assert.doesNotMatch(commands, /koed-native-runtime-linux-x64-/);
  const core = steps.find(
    (s) => s.name === "Verify and extract Linux CPU core"
  );
  assert.ok(core, "missing CPU core verification step");
  assert.match(
    core.env.NATIVE_CATALOG,
    /linux-native-packages\.outputs\.catalog/
  );
  assert.match(core.run, /\.core\.sha256/);
  assert.match(core.run, /\.core\.manifestSha256/);
  assert.match(core.run, /koed-native-core-\$\{recipe\}-linux-x64\.tar\.gz/);
  assert.match(core.run, /verifyFrozenCore/);
  const build = steps.find((s) => s.name === "Build Linux Desktop artifacts");
  assert.equal(
    build.env.KOED_NATIVE_RUNTIME_SOURCE_DIR,
    "${{ runner.temp }}/koed-linux-runtime/koed-runtime"
  );
  assert.ok(
    steps.indexOf(core) < steps.indexOf(build),
    "CPU core must be verified before Desktop packaging"
  );
  assert.match(commands, /sha256sum --check/);
  assert.match(commands, /native-runtime:validate/);
  assert.match(commands, /verify-frozen-component-assets/);
  assert.match(commands, /desktop:package:linux:release/);
  assert.match(commands, /--appimage-direct/);
  assert.match(commands, /verify-linux/);
  const retained = steps.findIndex(
    (s) => s.with?.name === "koed-desktop-linux-final-assets"
  );
  const upload = steps.findIndex((s) =>
    s.run?.includes("ensure-release-assets.mjs")
  );
  const sizeGate = steps.findIndex((s) => s.run?.includes("size-linux"));
  assert.ok(sizeGate >= 0 && sizeGate < retained);
  assert.ok(retained >= 0 && upload > retained);
  assert.match(steps[retained].with.path, /Koed-.*-x86_64\.AppImage/);
  assert.match(steps[retained].with.path, /koed-desktop-linux-x64\.sha256/);
  // Trusted-build evidence (ADR 0068) comes from the final AppImage, never
  // the unpacked directory, and is retained and published with it.
  const evidence = steps.findIndex((s) =>
    s.run?.includes("linux-desktop-build-evidence.mjs")
  );
  const packaged = steps.findIndex((s) =>
    s.run?.includes("desktop:package:linux:release")
  );
  assert.ok(evidence >= packaged && evidence < retained);
  assert.doesNotMatch(steps[evidence].run, /linux-unpacked\/resources/);
  assert.match(
    steps[retained].with.path,
    /koed-desktop-linux-x64\.evidence\.json/
  );
  assert.match(steps[upload].run, /koed-desktop-linux-x64\.evidence\.json/);
});

test("macOS native build freezes once and both consumers bind the same immutable artifact", () => {
  const freeze = jobs["frozen-macos-native-runtime"];
  const stage = jobs["macos-native-packages"];
  assert.ok(freeze && stage);
  const builds = Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((s) => /native-runtime:build:macos-arm64/.test(s.run ?? ""));
  assert.equal(builds.length, 1);
  assert.ok(freeze.steps.includes(builds[0]));
  const upload = freeze.steps.find((s) => s.id === "freeze-upload");
  assert.equal(
    freeze.outputs.artifact_id,
    "${{ steps.freeze-upload.outputs.artifact-id }}"
  );
  assert.equal(upload.with.name, "koed-private-frozen-macos-native-runtime");
  const evidence = freeze.steps.find((s) => s.id === "inventory");
  assert.match(evidence.run, /--inspect-inventory/);
  assert.match(evidence.run, /--write-inventory/);
  assert.equal(evidence.env, undefined);
  assert.equal(
    freeze.outputs.inventory_sha256,
    "${{ steps.inventory.outputs.sha256 }}"
  );
  assert.ok(freeze.steps.indexOf(evidence) < freeze.steps.indexOf(upload));
  assert.match(upload.with.path, /approved-macos-inventory\.json/);
  for (const consumer of [stage, desktop]) {
    assert.ok(consumer.needs.includes("frozen-macos-native-runtime"));
    const download = consumer.steps.find(
      (s) => s.name === "Download frozen macOS native runtime"
    );
    assert.equal(
      download.with["artifact-ids"],
      "${{ needs.frozen-macos-native-runtime.outputs.artifact_id }}"
    );
    const verify = consumer.steps.find(
      (s) => s.name === "Verify frozen macOS inventory"
    );
    assert.match(verify.run, /--inspect-inventory/);
    assert.equal(
      verify.env.FROZEN_INVENTORY_SHA256,
      "${{ needs.frozen-macos-native-runtime.outputs.inventory_sha256 }}"
    );
  }
  assert.match(
    stage.steps.find((s) => s.name === "Stage frozen macOS core").run,
    /--frozen-inventory-sha256/
  );
  assert.ok(
    jobs["standalone-koed-server-release-assets"].needs.includes(
      "macos-native-packages"
    )
  );
  assert.equal(
    step("Embed native package pins in the release build").env.NATIVE_CATALOG,
    "${{ needs.macos-native-packages.outputs.catalog }}"
  );
});

test("promotion binds public macOS assets and private freeze identity", () => {
  const reviewed = jobs["reviewed-release-identity"];
  assert.ok(reviewed.needs.includes("macos-native-packages"));
  assert.ok(reviewed.needs.includes("frozen-macos-native-runtime"));
  const sources = reviewed.steps.find((s) => s.id === "sources");
  assert.equal(
    sources.env.FROZEN_MACOS_ARTIFACT_ID,
    "${{ needs.frozen-macos-native-runtime.outputs.artifact_id }}"
  );
  assert.match(sources.run, /koed-macos-native-packages/);
  const gate = jobs["publish-release"].steps.find(
    (s) => s.name === "Verify required release assets"
  ).run;
  assert.match(gate, /native-core-manifest-macos-arm64\.json/);
  assert.match(gate, /koed-native-core-\*-macos-arm64\.tar\.gz/);
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
