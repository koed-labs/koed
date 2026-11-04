#!/usr/bin/env node
// Package reviewed source and the existing CPU handover. No CUDA code executes.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeDeterministicTarGz } from "../deterministic-tar-gzip.mjs";
import { sha256File } from "./manifest-lib.mjs";

const { values } = parseArgs({
  options: {
    "core-bundle": { type: "string" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});
if (values.help) {
  console.log(
    "Usage: node scripts/native-runtime/package-cuda-handover.mjs --core-bundle <qualified-core-handover.tar.gz> --out-dir <new-directory>"
  );
} else {
  if (!values["core-bundle"] || !values["out-dir"])
    throw new Error("Provide --core-bundle and a new --out-dir.");
  const repo = resolve(import.meta.dirname, "../..");
  const evidencePath = "docs/qualification/linux-native-core-2026-11-04.json";
  const evidence = JSON.parse(
    readFileSync(resolve(repo, evidencePath), "utf8")
  );
  const coreBundleSha256 = sha256File(resolve(values["core-bundle"]));
  if (coreBundleSha256 !== evidence.handover.sha256)
    throw new Error(
      "Core handover differs from the recorded, qualified CPU candidate."
    );
  const out = resolve(values["out-dir"]);
  mkdirSync(out);
  const root = resolve(out, "koed-cuda-handover");
  mkdirSync(root);
  const files = [
    "scripts/native-runtime/build-cuda-addon-linux-x64.mjs",
    "scripts/native-runtime/cuda.linux-x64.json",
    "scripts/native-runtime/cuda-artifact.mjs",
    "scripts/native-runtime/cuda-artifact.test.mjs",
    "scripts/native-runtime/qualify-cuda-layout-linux-x64.mjs",
    "scripts/native-runtime/core-artifact.mjs",
    "scripts/native-runtime/content-policy.mjs",
    "scripts/native-runtime/loader-validation-lib.mjs",
    "scripts/native-runtime/manifest-lib.mjs",
    "scripts/deterministic-tar-gzip.mjs",
    "scripts/inspect-release-artifact.mjs",
    "scripts/release-artifact-inspector-lib.mjs",
    "packages/koed-server/src/artifact-canonical-json.mjs",
    "config/release-artifact-size-policy.json",
    "docs/qualification/linux-cuda-handover.md",
    evidencePath
  ];
  for (const path of files) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(repo, path), destination);
  }
  copyFileSync(
    resolve(repo, "docs/qualification/linux-cuda-handover.md"),
    resolve(root, "README.md")
  );
  copyFileSync(
    resolve(values["core-bundle"]),
    resolve(root, "koed-core-qualification.tar.gz")
  );
  writeFileSync(
    resolve(root, "koed-core-qualification.tar.gz.sha256"),
    `${coreBundleSha256}  koed-core-qualification.tar.gz\n`,
    { flag: "wx" }
  );
  const manifest = {
    schemaVersion: 1,
    status: "prepared-not-executed",
    scope: "ticket-08-candidate-packaging-and-layout",
    cudaCandidateIncluded: false,
    cudaQualificationExecuted: false,
    shippedCliQualificationIncluded: false,
    core: { ...evidence.candidate, handoverSha256: coreBundleSha256 },
    files: [
      ...files,
      "README.md",
      "koed-core-qualification.tar.gz",
      "koed-core-qualification.tar.gz.sha256"
    ].map((path) => ({ path, sha256: sha256File(resolve(root, path)) }))
  };
  writeFileSync(
    resolve(root, "handover.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" }
  );
  const archive = "koed-cuda-handover.tar.gz";
  writeDeterministicTarGz({
    sourceDir: root,
    rootName: "koed-cuda-handover",
    tarPath: resolve(out, archive),
    streaming: true
  });
  const sha256 = sha256File(resolve(out, archive));
  writeFileSync(resolve(out, `${archive}.sha256`), `${sha256}  ${archive}\n`, {
    flag: "wx"
  });
  console.log(
    JSON.stringify(
      { archive, sha256, status: manifest.status, coreBundleSha256 },
      null,
      2
    )
  );
}
