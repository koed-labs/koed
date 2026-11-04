#!/usr/bin/env node
// Prepare an offline, checkout-free CPU handover. This runs no native tests.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packageFrozenCore } from "./core-artifact.mjs";
import { writeDeterministicTarGz } from "../deterministic-tar-gzip.mjs";
import { sha256File } from "./manifest-lib.mjs";

const { values } = parseArgs({
  options: {
    "candidate-dir": { type: "string" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});
if (values.help) {
  console.log(
    "Usage: node scripts/native-runtime/package-core-qualification.mjs --candidate-dir <frozen-candidate> --out-dir <new-directory>"
  );
} else {
  if (!values["candidate-dir"] || !values["out-dir"])
    throw new Error("Provide --candidate-dir and a new --out-dir.");
  const candidate = resolve(values["candidate-dir"]);
  const out = resolve(values["out-dir"]);
  mkdirSync(out);
  const bundle = resolve(out, "koed-core-qualification");
  mkdirSync(bundle);
  // Repack the fully verified frozen tree. Require exact agreement with the
  // original candidate, including archive bytes, before handing it over.
  const packaged = packageFrozenCore({
    runtimeRoot: resolve(candidate, "koed-runtime"),
    outDir: bundle
  });
  const original = JSON.parse(
    readFileSync(resolve(candidate, "core-candidate.json"), "utf8")
  );
  if (
    JSON.stringify(original) !== JSON.stringify(packaged) ||
    sha256File(resolve(candidate, packaged.archive)) !== packaged.sha256
  )
    throw new Error(
      "Qualification handover does not match the frozen candidate."
    );
  const repo = resolve(import.meta.dirname, "../..");
  for (const path of [
    "scripts/native-runtime/qualify-core-linux-x64.mjs",
    "scripts/native-runtime/core-artifact.mjs",
    "scripts/native-runtime/content-policy.mjs",
    "scripts/native-runtime/loader-validation-lib.mjs",
    "scripts/native-runtime/manifest-lib.mjs",
    "scripts/deterministic-tar-gzip.mjs",
    "packages/koed-server/src/artifact-canonical-json.mjs",
    "config/release-artifact-size-policy.json"
  ]) {
    const target = resolve(bundle, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(repo, path), target);
  }
  copyFileSync(
    resolve(repo, "docs/qualification/linux-core-handover.md"),
    resolve(bundle, "README.md")
  );
  const archive = "koed-core-qualification.tar.gz";
  writeDeterministicTarGz({
    sourceDir: bundle,
    rootName: "koed-core-qualification",
    tarPath: resolve(out, archive),
    streaming: true
  });
  const sha256 = sha256File(resolve(out, archive));
  writeFileSync(resolve(out, `${archive}.sha256`), `${sha256}  ${archive}\n`, {
    flag: "wx"
  });
  console.log(
    JSON.stringify({ archive, sha256, candidate: packaged }, null, 2)
  );
}
