import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { embedComponentManifestCatalog } from "./embed-component-manifest-catalog.mjs";
import { requiredComponentIdentities } from "./component-manifest-catalog.mjs";

const version = "1.2.3";
const catalog = () => ({
  schemaVersion: 2,
  productVersion: version,
  entries: requiredComponentIdentities.map((identity) => ({
    ...identity,
    manifestSha256: "a".repeat(64)
  }))
});

test("control-plane builds carry complete explicit catalog across clean rebuilds", () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/catalog-build-test-"));
  try {
    const catalogPath = resolve(root, "input.json");
    const outputPath = resolve(root, "dist/component-manifest-catalog-data.js");
    writeFileSync(catalogPath, JSON.stringify(catalog()));
    mkdirSync(resolve(root, "dist"));
    embedComponentManifestCatalog({ catalogPath, outputPath, version });
    const first = readFileSync(outputPath, "utf8");
    assert.match(first, /validateManifestCatalog/);
    assert.match(first, /1\.2\.3/);
    rmSync(resolve(root, "dist"), { recursive: true });
    mkdirSync(resolve(root, "dist"));
    embedComponentManifestCatalog({ catalogPath, outputPath, version });
    assert.equal(readFileSync(outputPath, "utf8"), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent input emits no admission authority; wrong version and partial catalog fail", () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/catalog-build-test-"));
  try {
    const outputPath = resolve(root, "component-manifest-catalog-data.js");
    const catalogPath = resolve(root, "input.json");
    embedComponentManifestCatalog({ outputPath, version });
    assert.equal(
      readFileSync(outputPath, "utf8"),
      "export const productionComponentManifestCatalog = null;\n"
    );
    writeFileSync(catalogPath, JSON.stringify(catalog()));
    assert.throws(
      () =>
        embedComponentManifestCatalog({
          catalogPath,
          outputPath,
          version: "1.2.4"
        }),
      /version/i
    );
    const incomplete = catalog();
    incomplete.entries.pop();
    writeFileSync(catalogPath, JSON.stringify(incomplete));
    assert.throws(
      () => embedComponentManifestCatalog({ catalogPath, outputPath, version }),
      /complete|missing/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
