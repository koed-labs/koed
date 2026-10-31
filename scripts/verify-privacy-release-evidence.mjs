#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyFrozenComponentAssets } from "./verify-frozen-component-assets.mjs";
import {
  PINNED_PRIVACY_MODEL_REVISION,
  PINNED_PRIVACY_CLASSIFIER_HASH
} from "../packages/shared/dist/privacy-classifier-generation.js";
import { isPrivacyInferenceVerification } from "../packages/koed-server/dist/privacy-inference.js";

const stages = new Map([
  ["macos", { platform: "macos", architecture: "arm64", cases: ["macos"] }],
  [
    "linux-cpu",
    { platform: "linux", architecture: "x64", cases: ["cpu", "cuda-fallback"] }
  ],
  [
    "linux-cuda",
    { platform: "linux", architecture: "x64", cases: ["cuda", "cuda-fallback"] }
  ]
]);
const digest = /^[a-f0-9]{64}$/;
export function verifyPrivacyReleaseReports({
  catalog,
  catalogSha256,
  version,
  sourceRevision,
  reports,
  manifests
}) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(catalog.productVersion, version);
  assert.equal(
    reports.length,
    stages.size,
    "All three native stages are required"
  );
  assert.equal(
    new Set(reports.map((report) => report.stage)).size,
    stages.size,
    "Duplicate native stage"
  );
  const masking = new Set();
  for (const report of reports) {
    const target = stages.get(report.stage);
    assert.ok(target, "Unknown native stage");
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.version, version);
    assert.equal(
      report.sourceRevision,
      sourceRevision,
      "Stale qualification source revision"
    );
    assert.equal(
      report.catalogSha256,
      catalogSha256,
      "Qualification belongs to another catalog"
    );
    assert.equal(report.modelRevision, PINNED_PRIVACY_MODEL_REVISION);
    assert.equal(
      report.environment?.nativeHost,
      true,
      "Native target confirmation is required"
    );
    const runtime = report.environment?.runtime;
    assert.equal(runtime?.kind, "node");
    assert.equal(runtime.platform, target.platform);
    assert.equal(runtime.architecture, target.architecture);
    assert.equal(Number(runtime.version.split(".")[0]), 24);
    assert.equal(runtime.modulesAbi, "137");
    assert.equal(
      report.cases?.length,
      target.cases.length,
      "Incomplete native case matrix"
    );
    assert.deepEqual(
      report.cases.map((item) => item.name).sort(),
      [...target.cases].sort()
    );
    if (report.stage === "linux-cpu")
      assert.equal(report.compatibility?.variant, "cpu");
    if (report.stage === "linux-cuda") {
      assert.equal(report.compatibility?.variant, "cuda");
      assert.equal(report.compatibility.compatible, true);
      assert.equal(
        report.compatibility.reason,
        "cuda_compatibility_established"
      );
    }
    for (const item of report.cases) {
      const variant =
        item.name === "macos"
          ? undefined
          : item.name === "cpu"
            ? "cpu"
            : "cuda";
      const entry = catalog.entries.find(
        (pin) =>
          pin.component === "privacy" &&
          pin.target.platform === target.platform &&
          pin.target.architecture === target.architecture &&
          pin.variant === variant
      );
      assert.ok(entry, "Missing exact Privacy manifest pin");
      assert.equal(item.manifestDigest, entry.manifestSha256);
      const manifest = manifests.find(
        (value) =>
          value.component === "privacy" &&
          value.target.platform === target.platform &&
          value.target.architecture === target.architecture &&
          value.variant === variant
      );
      assert.ok(manifest);
      assert.equal(
        item.archiveSha256,
        manifest.archive.sha256,
        "Qualification belongs to another runtime archive"
      );
      const requested = variant === "cuda" ? "cuda" : "cpu";
      const active = item.name === "cuda" ? "cuda" : "cpu";
      assert.equal(
        isPrivacyInferenceVerification(item.verification, requested),
        true,
        "Missing actual provider execution evidence"
      );
      assert.equal(item.verification.proof, "onnx-execution-profile");
      assert.equal(item.verification.activeProvider, active);
      assert.match(item.verification.maskingSha256, digest);
      assert.notEqual(item.verification.maskingSha256, "0".repeat(64));
      masking.add(item.verification.maskingSha256);
      const serviceProvider = item.name === "macos" ? "coreml" : active;
      assert.equal(item.service?.ok, true, "Service readiness did not pass");
      assert.equal(item.service.provider, serviceProvider);
      assert.equal(
        item.service.classifier?.modelRevision,
        PINNED_PRIVACY_MODEL_REVISION
      );
      assert.equal(
        item.service.classifier?.classifierHash,
        PINNED_PRIVACY_CLASSIFIER_HASH
      );
      assert.ok(item.service.verifiedProviders?.includes("cpu"));
      assert.equal(item.service.behavior?.unavailableProviderRejected, true);
      if (serviceProvider !== "cpu") {
        assert.ok(item.service.verifiedProviders.includes(serviceProvider));
        for (const check of [
          "switchedToCpu",
          "switchedBack",
          "idleUnloadReload"
        ])
          assert.equal(item.service.behavior[check], true);
      }
    }
  }
  assert.equal(masking.size, 1, "Native masking outputs disagree");
  return {
    ok: true,
    version,
    sourceRevision,
    catalogSha256,
    stages: reports.map((report) => report.stage).sort(),
    maskingSha256: [...masking][0]
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [assetsDir, catalogPath, version, sourceRevision, ...paths] =
    process.argv.slice(2);
  assert.ok(
    assetsDir && catalogPath && version && sourceRevision && paths.length === 3,
    "Usage: verify-privacy-release-evidence <frozen-assets> <catalog> <version> <source-sha> <macos-report> <linux-cpu-report> <linux-cuda-report>"
  );
  const catalog = await verifyFrozenComponentAssets({
    assetsDir,
    catalogPath,
    version
  });
  const manifests = catalog.entries.map((entry) => {
    const suffix = `${version}-${entry.target.platform}-${entry.target.architecture}${entry.variant ? `-${entry.variant}` : ""}`;
    return JSON.parse(
      readFileSync(
        resolve(
          assetsDir,
          `koed-${entry.component}-${suffix}.tar.gz.manifest.json`
        )
      )
    );
  });
  console.log(
    JSON.stringify(
      verifyPrivacyReleaseReports({
        catalog,
        catalogSha256: createHash("sha256")
          .update(readFileSync(catalogPath))
          .digest("hex"),
        version,
        sourceRevision,
        manifests,
        reports: paths.map((path) => JSON.parse(readFileSync(path)))
      }),
      null,
      2
    )
  );
}
