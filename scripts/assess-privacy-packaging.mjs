#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { inspectRuntimeComponentOwnership } from "./component-assembly.mjs";
import { inventoryDesktopPayload } from "../apps/desktop/scripts/privacy-payload-inventory.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const sourceRoot = option("--runtime");
const app = option("--app");
const output = option("--out");
if (!sourceRoot || !app || !output)
  throw new Error(
    "Usage: assess-privacy-packaging --runtime <shared-runtime> --app <Koed.app> --out <directory> [--dmg <path>] [--zip <path>]"
  );
const repoRoot = resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  readFileSync(
    resolve(repoRoot, "config/privacy-runtime-package-policy.json"),
    "utf8"
  )
);
const ownership = inspectRuntimeComponentOwnership({
  sourceRoot: resolve(sourceRoot),
  excludedPackages: policy.removeStandaloneOnnxruntimeWeb
    ? ["onnxruntime-web"]
    : []
});
const inventory = inventoryDesktopPayload(
  resolve(app),
  ownership.packages
    .filter((entry) => entry.ownership === "privacy")
    .map((entry) => entry.name)
);
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const provenance = {
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim(),
  sourceChanges: execFileSync("git", ["status", "--short"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim(),
  lockfileSha256: hash(resolve(repoRoot, "pnpm-lock.yaml")),
  node: process.versions.node,
  pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
  platform: process.platform,
  architecture: process.arch,
  buildConfigurationSha256: hash(
    resolve(repoRoot, "apps/desktop/electron-builder.yml")
  ),
  distributions: ["--dmg", "--zip"].flatMap((name) =>
    option(name)
      ? [
          {
            path: resolve(option(name)),
            bytes: statSync(option(name)).size,
            sha256: hash(option(name))
          }
        ]
      : []
  )
};
mkdirSync(resolve(output), { recursive: true });
for (const [name, value] of Object.entries({
  provenance,
  ownership,
  inventory
}))
  writeFileSync(
    resolve(output, `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`
  );
console.log(
  JSON.stringify(
    {
      output: resolve(output),
      physicalBytes: inventory.physicalBytes,
      privacyPhysicalBytes: inventory.privacyPhysicalBytes,
      privacyAsarLogicalBytes: inventory.privacyAsarLogicalBytes,
      packages: ownership.packages.length,
      baseUnresolvedEdges: ownership.audits.base.unresolved,
      privacyUnresolvedEdges: ownership.audits.privacy.unresolved,
      ...provenance
    },
    null,
    2
  )
);
