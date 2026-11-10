#!/usr/bin/env node
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { parseArgs } from "node:util";
import {
  assertMacLicenses,
  coreInventory,
  coreRecipeId,
  freezeCore,
  packageFrozenCore
} from "./core-artifact.mjs";
import { listFiles, sha256File, sha256Files } from "./manifest-lib.mjs";
import { verifyApprovedMacosInventory } from "./macos-inventory.mjs";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    "out-dir": { type: "string" },
    "frozen-inventory-sha256": { type: "string" },
    "inspect-inventory": { type: "boolean" },
    "write-inventory": { type: "string" },
    version: { type: "string" }
  }
});
if (!values["source-dir"]) throw new Error("Missing frozen source directory.");
const input = realpathSync(resolve(values["source-dir"]));
if (values["inspect-inventory"] && values["write-inventory"])
  throw new Error(
    "Inventory inspection and evidence output are mutually exclusive."
  );
if (values["write-inventory"]) {
  const path = resolve(values["write-inventory"]);
  const output = resolve(realpathSync(dirname(path)), basename(path));
  const rel = relative(input, output);
  if (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  )
    throw new Error("Inventory evidence must be outside the frozen source.");
  const inventory = coreInventory(input, "macos", { desktop: true });
  assertMacLicenses(input, inventory);
  verifyApprovedMacosInventory(
    inventory,
    values["frozen-inventory-sha256"] ?? coreRecipeId(inventory)
  );
  writeFileSync(output, `${canonicalArtifactJson(inventory)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  process.exit(0);
}
if (values["inspect-inventory"]) {
  const inventory = coreInventory(input, "macos", { desktop: true });
  assertMacLicenses(input, inventory);
  console.log(coreRecipeId(inventory));
  process.exit(0);
}
if (
  !values["out-dir"] ||
  !/^[a-f0-9]{64}$/.test(values["frozen-inventory-sha256"] ?? "") ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(values.version ?? "")
)
  throw new Error(
    "Staging requires --out-dir, --version, and the freeze job's --frozen-inventory-sha256."
  );
const requestedOut = resolve(values["out-dir"]);
const out = resolve(
  realpathSync(dirname(requestedOut)),
  basename(requestedOut)
);
const outputRelative = relative(input, out);
if (
  outputRelative === "" ||
  (!isAbsolute(outputRelative) &&
    outputRelative !== ".." &&
    !outputRelative.startsWith(`..${sep}`))
)
  throw new Error("Output must be outside the frozen source.");
const frozenInventory = coreInventory(input, "macos", { desktop: true });
assertMacLicenses(input, frozenInventory);
for (const name of ["provenance.json", "runtime-asset-manifest.json"]) {
  if (frozenInventory.find((entry) => entry.path === name)?.type !== "file")
    throw new Error(`Frozen runtime requires regular file: ${name}`);
}
const provenance = JSON.parse(
  readFileSync(resolve(input, "provenance.json"), "utf8")
);
const pinned = provenance.source?.manifest;
if (
  provenance.schemaVersion !== 1 ||
  provenance.artifact?.platform !== "macos" ||
  provenance.artifact.architecture !== "arm64" ||
  provenance.artifact.version !== values.version ||
  provenance.source?.kind !== "pinned-sources" ||
  pinned?.platform !== "macos" ||
  pinned.architecture !== "arm64"
)
  throw new Error(
    "Frozen runtime requires matching pinned macOS build provenance."
  );
const assets = JSON.parse(
  readFileSync(resolve(input, "runtime-asset-manifest.json"), "utf8")
);
if (
  assets.schemaVersion !== 1 ||
  !Array.isArray(assets.assets) ||
  assets.assets.length !== 2 ||
  assets.assets
    .map((a) => a.id)
    .sort()
    .join(",") !== "llama.cpp,postgres"
)
  throw new Error("Invalid frozen runtime asset manifest.");
for (const asset of assets.assets) {
  const root = resolve(input, asset.id);
  const files = listFiles(root).sort();
  if (
    asset.platform !== "macos" ||
    asset.architecture !== "arm64" ||
    !Array.isArray(asset.expectedFiles) ||
    JSON.stringify(files) !== JSON.stringify([...asset.expectedFiles].sort()) ||
    sha256Files(root, files) !== asset.sha256
  )
    throw new Error(`Frozen runtime asset changed: ${asset.id}`);
}
const payloadInventory = verifyApprovedMacosInventory(
  frozenInventory,
  values["frozen-inventory-sha256"]
);
mkdirSync(out);
const runtimeRoot = resolve(out, "koed-runtime");
mkdirSync(runtimeRoot);
for (const name of [
  "postgres",
  "llama.cpp",
  "third-party-licenses",
  "runtime-asset-manifest.json"
])
  cpSync(resolve(input, name), resolve(runtimeRoot, name), {
    recursive: true,
    verbatimSymlinks: true
  });
if (
  coreRecipeId(coreInventory(runtimeRoot, "macos")) !==
  coreRecipeId(payloadInventory)
)
  throw new Error(
    "Copied runtime does not match the approved frozen inventory."
  );
const configuration = {
  runtimeVersion: values.version,
  target: { platform: "macos", architecture: "arm64", minimumVersion: "14.0" },
  contracts: { layout: 1, postgres: 1, embedding: 1 }
};
const sources = Object.fromEntries(
  ["postgres", "pgvector", "llamaCpp", "openssl"].map((key) => [
    key,
    pinned[key]
  ])
);
const recipe = {
  schemaVersion: 1,
  kind: "core",
  configuration,
  sources,
  provenance,
  approvedDesktopInventorySha256: values["frozen-inventory-sha256"],
  packagingRuntime: {
    node: process.version,
    zlib: process.versions.zlib,
    executableSha256: sha256File(process.execPath)
  },
  frozenInventorySha256: coreRecipeId(payloadInventory),
  logic: Object.fromEntries(
    [
      "scripts/native-runtime/stage-macos-core.mjs",
      "scripts/native-runtime/macos-inventory.mjs",
      "scripts/native-runtime/core-artifact.mjs",
      "scripts/native-runtime/manifest-lib.mjs",
      "scripts/deterministic-tar-gzip.mjs",
      "packages/koed-server/src/artifact-canonical-json.mjs"
    ].map((name) => [
      name,
      sha256File(resolve(import.meta.dirname, "../..", name))
    ])
  ),
  packaging: { format: "ustar-pax-gzip", epoch: 0, root: "koed-runtime" }
};
freezeCore({ runtimeRoot, configuration, recipe });
console.log(
  JSON.stringify(packageFrozenCore({ runtimeRoot, outDir: out }), null, 2)
);
