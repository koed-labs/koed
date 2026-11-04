import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
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

const authenticate = async (
  url,
  expectedHash,
  limit,
  exactBytes,
  read,
  retain
) => {
  const signal = AbortSignal.timeout(180_000);
  const response = await read(url, { method: "GET", signal });
  if (!response.ok || !response.body)
    throw new Error(
      `Published native asset is unavailable: HTTP ${response.status} (${url}).`
    );
  if (response.url && new URL(response.url).protocol !== "https:") {
    await response.body.cancel();
    throw new Error("Published native asset redirected outside HTTPS.");
  }
  const hash = createHash("sha256"),
    chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > limit)
      throw new Error(
        "Published native asset exceeds its compiled size bound."
      );
    hash.update(chunk);
    if (retain) chunks.push(chunk);
  }
  if (
    (exactBytes !== undefined && bytes !== exactBytes) ||
    hash.digest("hex") !== expectedHash
  )
    throw new Error(
      "Published native asset digest or size differs from the compiled pin."
    );
  return retain ? Buffer.concat(chunks) : bytes;
};

export const authenticateNativePins = async (value, read = fetch) => {
  const catalog = validateNativeRuntimeCatalog(value);
  const pin = catalog.core;
  const bytes = await authenticate(
    pin.url,
    pin.sha256,
    pin.archiveBytes,
    pin.archiveBytes,
    read,
    false
  );
  const manifestUrl = new URL("native-core-manifest.json", pin.url).href;
  const raw = await authenticate(
    manifestUrl,
    pin.manifestSha256,
    8 * 1024 * 1024,
    undefined,
    read,
    true
  );
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
    manifest.kind !== "core" ||
    manifest.schemaVersion !== 1 ||
    manifest.recipeId !== pin.recipeId ||
    manifest.runtimeVersion !== pin.runtimeVersion ||
    canonicalArtifactJson(manifest.target) !==
      canonicalArtifactJson(pin.target) ||
    canonicalArtifactJson(manifest.contracts) !==
      canonicalArtifactJson(pin.contracts) ||
    canonicalArtifactJson(manifest.components) !==
      canonicalArtifactJson(pin.components) ||
    createHash("sha256")
      .update(canonicalArtifactJson(manifest.recipe))
      .digest("hex") !== pin.recipeId
  )
    throw new Error(
      "Published native manifest conflicts with compiled identity or contracts."
    );
  return {
    core: {
      recipeId: pin.recipeId,
      sha256: pin.sha256,
      archiveBytes: bytes,
      manifestSha256: pin.manifestSha256
    },
    cuda: null
  };
};
