import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareNativeVersions,
  validateNativeRuntimeCatalog
} from "../packages/koed-server/dist/native-runtime-catalog.js";

export const sourceCatalogPath = "config/source-runtime-catalogs.json";
export const releaseRoot =
  "https://github.com/koed-labs/koed/releases/download/";
export const releaseVersion = (tag) => {
  if (
    typeof tag !== "string" ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
  )
    throw new Error("Expected a stable Koed release tag, such as v0.11.1.");
  return tag.slice(1);
};

export class NativeCompatibilityError extends Error {}

export function sourceNativeCatalog(document, minimumCoreVersion) {
  if (document?.schemaVersion !== 2)
    throw new Error("Invalid reviewed source native catalog format.");
  releaseVersion(document.sourceRelease);
  const provenance = document.provenance;
  if (
    !Number.isSafeInteger(provenance?.releaseId) ||
    provenance.releaseId <= 0 ||
    !Number.isSafeInteger(provenance?.nativeCatalogAssetId) ||
    provenance.nativeCatalogAssetId <= 0 ||
    !/^[a-f0-9]{64}$/.test(provenance.nativeCatalogSha256 ?? "") ||
    provenance.nativeCatalogUrl !==
      `${releaseRoot}${document.sourceRelease}/native-runtime-catalog.json`
  )
    throw new Error("Invalid source native catalog provenance.");
  const native = validateNativeRuntimeCatalog(document.native);
  if (!native.cuda)
    throw new Error("Source setup requires a complete CPU/CUDA catalog.");
  for (const kind of ["core", "cuda"]) {
    const pin = native[kind];
    if (
      compareNativeVersions(
        pin.runtimeVersion,
        releaseVersion(document.sourceRelease)
      ) > 0
    )
      throw new Error(
        "Native artifact version is newer than its published release."
      );
    if (
      pin.url !==
      `${releaseRoot}${document.sourceRelease}/koed-native-${kind}-${pin.recipeId}-linux-x64.tar.gz`
    )
      throw new Error(
        "Source native pin does not belong to the reviewed release."
      );
  }
  // A published catalog's older floor must never lower the checkout's policy.
  const floor =
    compareNativeVersions(native.minimumCoreVersion, minimumCoreVersion) >= 0
      ? native.minimumCoreVersion
      : minimumCoreVersion;
  if (compareNativeVersions(native.core.runtimeVersion, floor) < 0)
    throw new NativeCompatibilityError(
      `Native runtime ${native.core.runtimeVersion} is below required ${floor}.`
    );
  return validateNativeRuntimeCatalog({ ...native, minimumCoreVersion: floor });
}

export function readSourceNativeCatalog(repoRoot) {
  const read = (path) =>
    JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
  const policy = read(
    "scripts/native-runtime/core-compatibility.linux-x64.json"
  );
  if (policy.schemaVersion !== 1)
    throw new Error("Invalid native compatibility policy.");
  return sourceNativeCatalog(
    read(sourceCatalogPath),
    policy.minimumCoreVersion
  );
}
