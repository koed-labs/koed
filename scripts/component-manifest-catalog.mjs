import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import { validateComponentManifest } from "../packages/koed-server/dist/component-verification.js";
import { manifestPinKey } from "../packages/koed-server/dist/component-manifest-catalog.js";

export const writeComponentManifestCatalog = ({
  manifestsDir,
  outputPath,
  version
}) => {
  const manifests = readdirSync(manifestsDir)
    .filter((name) =>
      /^koed-(base|privacy)-.*\.tar\.gz\.manifest\.json$/.test(name)
    )
    .map((name) => readFileSync(resolve(manifestsDir, name)));
  const catalog = buildComponentManifestCatalog({ version, manifests });
  writeFileSync(outputPath, canonicalComponentManifestBytes(catalog), {
    flag: "wx"
  });
  return catalog;
};

export const requiredComponentIdentities = Object.freeze([
  ...["base", "privacy"].map((component) => ({
    component,
    target: {
      platform: "linux",
      architecture: "x64",
      libc: { family: "glibc", minimumVersion: "2.35" }
    }
  })),
  ...["base", "privacy"].map((component) => ({
    component,
    target: { platform: "macos", architecture: "arm64" }
  }))
]);

export const componentCatalogKey = manifestPinKey;

export const buildComponentManifestCatalog = ({
  version,
  manifests,
  required = requiredComponentIdentities
}) => {
  const expected = new Set(required.map(componentCatalogKey));
  if (expected.size !== required.length)
    throw new Error("Duplicate required component identity.");
  const found = new Set();
  const entries = manifests.map((bytes) => {
    const manifest = JSON.parse(bytes.toString("utf8"));
    validateComponentManifest(manifest);
    if (!bytes.equals(canonicalComponentManifestBytes(manifest)))
      throw new Error("Component manifest is not canonical.");
    if (manifest.productVersion !== version)
      throw new Error("Component manifest version mismatch.");
    const key = componentCatalogKey(manifest);
    if (!expected.has(key))
      throw new Error("Unexpected component identity or target.");
    if (found.has(key))
      throw new Error("Duplicate component manifest identity.");
    found.add(key);
    return {
      component: manifest.component,
      target: manifest.target,
      manifestSha256: createHash("sha256").update(bytes).digest("hex")
    };
  });
  if (found.size !== expected.size)
    throw new Error(
      "Missing required component manifests; catalog incomplete."
    );
  entries.sort((left, right) =>
    componentCatalogKey(left).localeCompare(componentCatalogKey(right))
  );
  return { schemaVersion: 1, productVersion: version, entries };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [manifestsDir, outputPath, version, ...extra] = process.argv.slice(2);
  if (!manifestsDir || !outputPath || !version || extra.length)
    throw new Error(
      "Usage: node scripts/component-manifest-catalog.mjs <manifests-directory> <output-file> <product-version>"
    );
  writeComponentManifestCatalog({ manifestsDir, outputPath, version });
}
