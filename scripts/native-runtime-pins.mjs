import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { canonicalArtifactJson } from "../packages/koed-server/src/artifact-canonical-json.mjs";
import {
  validateCompiledNativeRuntimeCatalog,
  validateNativeRuntimeCatalog
} from "../packages/koed-server/dist/native-runtime-catalog.js";
import { readPackagedCatalog } from "./static-packaged-catalog.mjs";

export const createCompiledNativeCatalog = (linux, macos) => {
  const compiled = validateCompiledNativeRuntimeCatalog({
    schemaVersion: 2,
    linux,
    macos
  });
  if (!compiled.linux?.cuda || !compiled.macos)
    throw new Error("All required native packages must be present.");
  return compiled;
};

const symbol = "productionNativeRuntimeCatalog";
const validateCatalog = (value) =>
  value?.schemaVersion === 2
    ? validateCompiledNativeRuntimeCatalog(value)
    : validateNativeRuntimeCatalog(value);
export const readProductionNativeCatalog = (
  repoRoot = resolve(import.meta.dirname, "..")
) => {
  const value = readPackagedCatalog(
    resolve(
      repoRoot,
      "packages/koed-server/src/native-runtime-catalog-data.mjs"
    ),
    symbol
  );
  return value === null ? null : validateCatalog(value);
};

export const readPackagedNativeCatalog = (modulePath) => {
  const actual = readPackagedCatalog(modulePath, symbol);
  return actual === null ? null : validateCatalog(actual);
};

export const verifyPackagedNativeCatalog = ({ modulePath, expected }) => {
  const catalog = readPackagedNativeCatalog(modulePath);
  assert.deepEqual(
    catalog,
    expected,
    "Packaged Control Plane native pins differ from reviewed source authority."
  );
  return catalog;
};

// downloadCandidate already authenticated every draft asset against its protected build hash.
export function verifyDraftNativePins(
  catalog,
  { root, version, assets, allowLegacyNativeCatalog = false }
) {
  if (!catalog) throw new Error("Missing required native release catalog.");
  const validated = validateCatalog(catalog);
  if (validated.schemaVersion !== 2 && !allowLegacyNativeCatalog)
    throw new Error("A schema 2 native release catalog is required.");
  if (
    validated.schemaVersion !== 2 &&
    assets.some((asset) =>
      /^(?:koed-native-core-.*-macos-arm64\.tar\.gz|native-core-manifest-macos-arm64\.json)$/.test(
        asset.name
      )
    )
  )
    throw new Error("macOS native assets require a schema 2 release catalog.");
  const linux = validated.schemaVersion === 2 ? validated.linux : validated;
  const macos = validated.schemaVersion === 2 ? validated.macos : null;
  if (!linux?.cuda || (validated.schemaVersion === 2 && !macos))
    throw new Error(
      "The release CLI must include all required native packages."
    );
  const hashes = new Map(assets.map((asset) => [asset.name, asset.sha256]));
  assert.deepEqual(
    catalog,
    JSON.parse(
      readFileSync(resolve(root, "native-runtime-catalog.json"), "utf8")
    ),
    "Native catalog differs from the release CLI."
  );
  const pins = [
    {
      kind: "core",
      pin: linux.core,
      platform: "linux-x64",
      manifestName: "native-core-manifest.json"
    },
    {
      kind: "cuda",
      pin: linux.cuda,
      platform: "linux-x64",
      manifestName: "native-cuda-manifest.json"
    },
    ...(macos
      ? [
          {
            kind: "core",
            pin: macos.core,
            platform: "macos-arm64",
            manifestName: "native-core-manifest-macos-arm64.json"
          }
        ]
      : [])
  ];
  for (const { kind, pin, platform, manifestName } of pins) {
    const archive = `koed-native-${kind}-${pin.recipeId}-${platform}.tar.gz`;
    if (
      pin.url !==
        `https://github.com/koed-labs/koed/releases/download/v${version}/${archive}` ||
      hashes.get(archive) !== pin.sha256 ||
      hashes.get(manifestName) !== pin.manifestSha256 ||
      statSync(resolve(root, archive)).size !== pin.archiveBytes ||
      statSync(resolve(root, manifestName)).size > 8 * 1024 * 1024
    )
      throw new Error(`Native ${kind} pin differs from the product draft.`);
    const raw = readFileSync(resolve(root, manifestName));
    const manifest = JSON.parse(raw.toString("utf8"));
    const expanded = Array.isArray(manifest.inventory)
      ? manifest.inventory.reduce(
          (total, entry) =>
            entry.type === "file" &&
            Number.isSafeInteger(entry.bytes) &&
            entry.bytes >= 0
              ? total + entry.bytes
              : ["directory", "symlink"].includes(entry.type)
                ? total
                : NaN,
          raw.length
        )
      : NaN;
    if (
      !Number.isSafeInteger(expanded) ||
      expanded !== pin.expandedBytes ||
      manifest.kind !== kind ||
      manifest.schemaVersion !== 1 ||
      manifest.recipeId !== pin.recipeId ||
      manifest.runtimeVersion !== pin.runtimeVersion ||
      canonicalArtifactJson(manifest.target) !==
        canonicalArtifactJson(pin.target) ||
      canonicalArtifactJson(manifest.contracts) !==
        canonicalArtifactJson(pin.contracts) ||
      (kind === "core"
        ? canonicalArtifactJson(manifest.components) !==
          canonicalArtifactJson(pin.components)
        : canonicalArtifactJson(manifest.llamaCpp) !==
            canonicalArtifactJson(pin.llamaCpp) ||
          canonicalArtifactJson(manifest.cuda) !==
            canonicalArtifactJson(pin.cuda)) ||
      createHash("sha256")
        .update(canonicalArtifactJson(manifest.recipe))
        .digest("hex") !== pin.recipeId
    )
      throw new Error(
        "Published native manifest conflicts with compiled identity or contracts."
      );
  }
}
