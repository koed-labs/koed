import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { canonicalArtifactJson } from "../packages/koed-server/src/artifact-canonical-json.mjs";
import { validateNativeRuntimeCatalog } from "../packages/koed-server/dist/native-runtime-catalog.js";
import { readPackagedCatalog } from "./static-packaged-catalog.mjs";

const symbol = "productionNativeRuntimeCatalog";
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
  return value === null ? null : validateNativeRuntimeCatalog(value);
};

export const readPackagedNativeCatalog = (modulePath) => {
  const actual = readPackagedCatalog(modulePath, symbol);
  return actual === null ? null : validateNativeRuntimeCatalog(actual);
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
export function verifyDraftNativePins(catalog, { root, version, assets }) {
  if (!catalog?.cuda)
    throw new Error("The release CLI must include both native packages.");
  const hashes = new Map(assets.map((asset) => [asset.name, asset.sha256]));
  assert.deepEqual(
    catalog,
    JSON.parse(
      readFileSync(resolve(root, "native-runtime-catalog.json"), "utf8")
    ),
    "Native catalog differs from the release CLI."
  );
  for (const kind of ["core", "cuda"]) {
    const pin = catalog[kind];
    const archive = `koed-native-${kind}-${pin.recipeId}-linux-x64.tar.gz`;
    const manifestName = `native-${kind}-manifest.json`;
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
