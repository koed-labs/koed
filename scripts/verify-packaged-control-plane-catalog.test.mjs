import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { requiredComponentIdentities } from "./component-manifest-catalog.mjs";
import { verifyPackagedControlPlaneCatalog } from "./verify-packaged-control-plane-catalog.mjs";

test("inspects effective module, not neighboring sidecar or source checkout", () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/packaged-catalog-test-"));
  try {
    const modulePath = resolve(root, "control-plane.mjs");
    const catalogPath = resolve(root, "catalog.json");
    const catalog = {
      schemaVersion: 2,
      productVersion: "1.2.3",
      entries: requiredComponentIdentities.map((identity) => ({
        ...identity,
        manifestSha256: "a".repeat(64)
      }))
    };
    writeFileSync(catalogPath, JSON.stringify(catalog));
    writeFileSync(
      modulePath,
      `export const productionComponentManifestCatalog = ${JSON.stringify(catalog)};\n`
    );
    verifyPackagedControlPlaneCatalog({
      modulePath,
      catalogPath,
      version: "1.2.3"
    });
    const marker = resolve(root, "candidate-code-executed");
    writeFileSync(
      modulePath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "EXECUTED"); export const productionComponentManifestCatalog = ${JSON.stringify(catalog)};\n`
    );
    verifyPackagedControlPlaneCatalog({
      modulePath,
      catalogPath,
      version: "1.2.3"
    });
    assert.equal(
      existsSync(marker),
      false,
      "inspection must not execute release-controlled code"
    );
    writeFileSync(
      resolve(root, "authority.mjs"),
      `const pins = validateManifestCatalog(${JSON.stringify(catalog)}); export { pins };\n`
    );
    writeFileSync(
      modulePath,
      'import { pins as authority } from "./authority.mjs"; export { authority as productionComponentManifestCatalog };\n'
    );
    verifyPackagedControlPlaneCatalog({
      modulePath,
      catalogPath,
      version: "1.2.3"
    });
    writeFileSync(
      modulePath,
      "export const productionComponentManifestCatalog = undefined;\n"
    );
    assert.throws(
      () =>
        verifyPackagedControlPlaneCatalog({
          modulePath,
          catalogPath,
          version: "1.2.3"
        }),
      /catalog/i
    );
    for (const invalid of [
      `const productionComponentManifestCatalog = ${JSON.stringify(catalog)};`,
      `export let productionComponentManifestCatalog = ${JSON.stringify(catalog)}; productionComponentManifestCatalog = null;`,
      `export var productionComponentManifestCatalog = ${JSON.stringify(catalog)}; productionComponentManifestCatalog = null;`,
      `export const productionComponentManifestCatalog = ${JSON.stringify(catalog)}; productionComponentManifestCatalog.productVersion = "9.9.9";`,
      `export const productionComponentManifestCatalog = ${JSON.stringify(catalog)}; const alias = productionComponentManifestCatalog.entries; alias.push({});`,
      `export const productionComponentManifestCatalog = (() => (${JSON.stringify(catalog)}))();`
    ]) {
      writeFileSync(modulePath, invalid);
      assert.throws(
        () =>
          verifyPackagedControlPlaneCatalog({
            modulePath,
            catalogPath,
            version: "1.2.3"
          }),
        /static.*catalog|catalog.*static/i
      );
    }
    const nested = resolve(root, "nested");
    mkdirSync(nested);
    const escaping = resolve(nested, "control-plane.mjs");
    writeFileSync(
      escaping,
      'export { pins as productionComponentManifestCatalog } from "../authority.mjs";'
    );
    assert.throws(
      () =>
        verifyPackagedControlPlaneCatalog({
          modulePath: escaping,
          catalogPath,
          version: "1.2.3"
        }),
      /escapes package/i
    );
    const mutated = structuredClone(catalog);
    mutated.entries[0].manifestSha256 = "b".repeat(64);
    writeFileSync(
      modulePath,
      `export const productionComponentManifestCatalog = ${JSON.stringify(mutated)};\n`
    );
    assert.throws(
      () =>
        verifyPackagedControlPlaneCatalog({
          modulePath,
          catalogPath,
          version: "1.2.3"
        }),
      /catalog.*mismatch/i
    );
    assert.throws(
      () =>
        verifyPackagedControlPlaneCatalog({
          modulePath,
          catalogPath,
          version: "1.2.4"
        }),
      /version/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
