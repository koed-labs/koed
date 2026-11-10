import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { verifyPrivacyReleaseReports } from "./verify-privacy-release-evidence.mjs";
import {
  PINNED_PRIVACY_MODEL_REVISION,
  PINNED_PRIVACY_CLASSIFIER_HASH
} from "../packages/shared/dist/privacy-classifier-generation.js";

const make = () => {
  const version = "0.9.2",
    sourceRevision = "a".repeat(40),
    catalogSha256 = "b".repeat(64);
  const specs = [
    ["macos", "macos", "arm64", undefined],
    ["cpu", "linux", "x64", "cpu"],
    ["cuda", "linux", "x64", "cuda"]
  ];
  const entries = specs.map(([, platform, architecture, variant], index) => ({
    component: "privacy",
    target: { platform, architecture },
    ...(variant ? { variant } : {}),
    manifestSha256: String(index + 1).repeat(64)
  }));
  const manifests = entries.map((entry) => ({
    ...entry,
    archive: { sha256: "c".repeat(64) }
  }));
  const cases = (name, index) => {
    const accelerated = name === "cuda" || name === "macos";
    const serviceProvider =
      name === "macos" ? "coreml" : name === "cuda" ? "cuda" : "cpu";
    return {
      name,
      manifestDigest: entries[index].manifestSha256,
      archiveSha256: "c".repeat(64),
      verification: {
        activeProvider: name === "cuda" ? "cuda" : "cpu",
        requestedProvider: index === 2 ? "cuda" : "cpu",
        executedProviders: [
          name === "cuda" ? "CUDAExecutionProvider" : "CPUExecutionProvider"
        ],
        proof: "onnx-execution-profile",
        maskingSha256: "d".repeat(64),
        ...(name === "cuda-fallback"
          ? { fallbackReason: "cuda_initialization_or_inference_failed" }
          : {})
      },
      service: {
        ok: true,
        classifier: {
          modelRevision: PINNED_PRIVACY_MODEL_REVISION,
          classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
        },
        provider: serviceProvider,
        verifiedProviders: accelerated ? ["cpu", serviceProvider] : ["cpu"],
        behavior: {
          unavailableProviderRejected: true,
          switchedToCpu: accelerated,
          switchedBack: accelerated,
          idleUnloadReload: accelerated
        }
      }
    };
  };
  const report = (stage, platform, architecture, items) => ({
    schemaVersion: 1,
    stage,
    version,
    sourceRevision,
    catalogSha256,
    modelRevision: PINNED_PRIVACY_MODEL_REVISION,
    environment: {
      nativeHost: true,
      runtime: {
        kind: "node",
        platform,
        architecture,
        version: "24.14.0",
        modulesAbi: "137"
      }
    },
    compatibility: {
      variant: "cpu",
      compatible: false,
      reason: "probe_tool_unavailable"
    },
    cases: items
  });
  return {
    catalog: { productVersion: version, entries },
    catalogSha256,
    version,
    sourceRevision,
    manifests,
    reports: [
      report("macos", "macos", "arm64", [cases("macos", 0)]),
      report("linux-cpu", "linux", "x64", [
        cases("cpu", 1),
        cases("cuda-fallback", 2)
      ])
    ]
  };
};

test("requires macOS and Linux CPU stages with matching frozen identities and masking", () => {
  assert.equal(verifyPrivacyReleaseReports(make()).ok, true);
});
for (const [name, modify] of [
  ["missing Linux CPU stage", (input) => input.reports.pop()],
  ["duplicate native stage", (input) => (input.reports[1] = input.reports[0])],
  [
    "stale source revision",
    (input) => (input.reports[1].sourceRevision = "e".repeat(40))
  ],
  [
    "wrong catalog",
    (input) => (input.reports[1].catalogSha256 = "e".repeat(64))
  ],
  [
    "emulated or unconfirmed host",
    (input) => (input.reports[1].environment.nativeHost = false)
  ],
  [
    "wrong native architecture",
    (input) => (input.reports[1].environment.runtime.architecture = "arm64")
  ],
  [
    "wrong archive",
    (input) => (input.reports[1].cases[0].archiveSha256 = "e".repeat(64))
  ],
  [
    "missing CPU recovery proof",
    (input) => delete input.reports[1].cases[1].verification.fallbackReason
  ],
  [
    "unready service",
    (input) => (input.reports[1].cases[1].service.ok = false)
  ],
  [
    "wrong service classifier",
    (input) =>
      (input.reports[1].cases[0].service.classifier.classifierHash = "e".repeat(
        64
      ))
  ],
  [
    "masking mismatch",
    (input) =>
      (input.reports[1].cases[0].verification.maskingSha256 = "e".repeat(64))
  ],
  [
    "missing accelerated reload",
    (input) =>
      (input.reports[0].cases[0].service.behavior.idleUnloadReload = false)
  ]
])
  test(`rejects ${name}`, () => {
    const input = make();
    modify(input);
    assert.throws(() => verifyPrivacyReleaseReports(input));
  });

test("publication and reviewed identity require hosted native Privacy qualification without a self-hosted GPU", () => {
  const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const jobs = workflow.jobs;
  assert.ok(
    jobs["publish-release"].needs.includes("privacy-release-qualification")
  );
  assert.ok(
    jobs["standalone-koed-server-release-metadata"].needs.includes(
      "privacy-release-qualification"
    )
  );
  assert.ok(
    jobs["reviewed-release-identity"].needs.includes(
      "privacy-release-qualification"
    )
  );
  assert.equal(jobs["privacy-native-cuda-qualification"], undefined);
  const frozenSteps = jobs["frozen-component-release-assets"].steps;
  assert.ok(
    !frozenSteps.some(
      (step) =>
        step.name === "Block release pending native CUDA GPU qualification"
    )
  );
  for (const version of ["24", "26"]) {
    const smoke = frozenSteps.find(
      (step) => step.name === `Smoke frozen components on Node ${version}`
    );
    assert.match(smoke.run, /component-runtime-compatibility-smoke\.mjs/);
    assert.match(smoke.run, /--variant cuda/);
  }
  for (const [name, job] of Object.entries(jobs))
    assert.ok(
      !JSON.stringify(job["runs-on"] ?? "").includes("self-hosted"),
      `${name} must not require a self-hosted runner`
    );
});
