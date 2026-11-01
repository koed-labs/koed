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
      variant: stage === "linux-cuda" ? "cuda" : "cpu",
      compatible: stage === "linux-cuda",
      reason:
        stage === "linux-cuda"
          ? "cuda_compatibility_established"
          : "probe_tool_unavailable"
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
      ]),
      report("linux-cuda", "linux", "x64", [
        cases("cuda", 2),
        cases("cuda-fallback", 2)
      ])
    ]
  };
};

test("requires all native stages with matching frozen identities and masking", () => {
  assert.equal(verifyPrivacyReleaseReports(make()).ok, true);
});
for (const [name, modify] of [
  ["missing CUDA stage", (input) => input.reports.pop()],
  ["duplicate native stage", (input) => (input.reports[2] = input.reports[1])],
  [
    "stale source revision",
    (input) => (input.reports[2].sourceRevision = "e".repeat(40))
  ],
  [
    "wrong catalog",
    (input) => (input.reports[2].catalogSha256 = "e".repeat(64))
  ],
  [
    "emulated or unconfirmed host",
    (input) => (input.reports[2].environment.nativeHost = false)
  ],
  [
    "wrong native architecture",
    (input) => (input.reports[2].environment.runtime.architecture = "arm64")
  ],
  [
    "wrong archive",
    (input) => (input.reports[2].cases[0].archiveSha256 = "e".repeat(64))
  ],
  [
    "CPU execution disguised as CUDA",
    (input) =>
      (input.reports[2].cases[0].verification.executedProviders = [
        "CPUExecutionProvider"
      ])
  ],
  [
    "missing CPU recovery proof",
    (input) => delete input.reports[2].cases[1].verification.fallbackReason
  ],
  [
    "unready service",
    (input) => (input.reports[2].cases[1].service.ok = false)
  ],
  [
    "wrong service classifier",
    (input) =>
      (input.reports[2].cases[0].service.classifier.classifierHash = "e".repeat(
        64
      ))
  ],
  [
    "masking mismatch",
    (input) =>
      (input.reports[2].cases[0].verification.maskingSha256 = "e".repeat(64))
  ],
  [
    "incompatible hardware probe",
    (input) => (input.reports[2].compatibility.variant = "cpu")
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

test("publication and reviewed identity require protected frozen-component GPU qualification", () => {
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
  assert.ok(
    jobs["privacy-release-qualification"].needs.includes(
      "privacy-native-cuda-qualification"
    )
  );
  assert.deepEqual(jobs["privacy-native-cuda-qualification"]["runs-on"], [
    "self-hosted",
    "linux",
    "x64",
    "koed-cuda"
  ]);
  assert.match(
    jobs["privacy-native-cuda-qualification"].if,
    /github.ref == 'refs\/heads\/main'/
  );
  assert.ok(
    jobs["privacy-native-cuda-qualification"].needs.includes(
      "component-manifest-catalog"
    )
  );
  assert.ok(
    jobs["privacy-native-cuda-qualification"].steps.some((step) =>
      step.run?.includes("--stage linux-cuda")
    )
  );
  assert.equal(
    jobs["privacy-native-cuda-qualification"].steps.some((step) =>
      step.run?.includes("build-koed-component-release")
    ),
    false
  );
});
