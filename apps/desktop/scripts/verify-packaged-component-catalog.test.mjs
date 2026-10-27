import assert from "node:assert/strict";
import { createPackage } from "@electron/asar";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { requiredComponentIdentities } from "../../../scripts/component-manifest-catalog.mjs";
import { verifyPackagedDesktopCatalog } from "./verify-packaged-component-catalog.mjs";
import { createAsarFixture } from "../../../scripts/test-utils/create-asar-fixture.mjs";

test("Desktop inspects trusted asar catalog, not catalog-less runtime copy", async () => {
  const scratch = resolve(import.meta.dirname, "../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "desktop-catalog-test-"));
  try {
    const source = resolve(root, "asar-source");
    const dist = resolve(source, "node_modules/@koed-labs/server/dist");
    mkdirSync(dist, { recursive: true });
    const catalog = {
      schemaVersion: 1,
      productVersion: "1.2.3",
      entries: requiredComponentIdentities.map((identity) => ({
        ...identity,
        manifestSha256: "a".repeat(64)
      }))
    };
    const catalogPath = resolve(root, "expected.json");
    writeFileSync(catalogPath, JSON.stringify(catalog));
    copyFileSync(
      resolve(
        import.meta.dirname,
        "../../../packages/koed-server/dist/component-manifest-catalog.js"
      ),
      resolve(dist, "component-manifest-catalog.js")
    );
    writeFileSync(
      resolve(dist, "component-manifest-catalog-data.js"),
      `import { validateManifestCatalog } from './component-manifest-catalog.js'; export const productionComponentManifestCatalog = validateManifestCatalog(${JSON.stringify(catalog)});`
    );
    const consumer =
      'import { productionComponentManifestCatalog } from "./component-manifest-catalog-data.js"; import { validateManifestCatalog } from "./component-manifest-catalog.js"; export const verify = () => validateManifestCatalog(productionComponentManifestCatalog);';
    writeFileSync(resolve(dist, "component-store.js"), consumer);
    const appPath = resolve(root, "Fixture.app");
    const resources = resolve(appPath, "Contents/Resources");
    mkdirSync(resources, { recursive: true });
    await createAsarFixture(
      createPackage,
      source,
      resolve(resources, "app.asar")
    );
    verifyPackagedDesktopCatalog({ appPath, catalogPath, version: "1.2.3" });
    for (const decoy of [
      '// "./component-manifest-catalog-data.js"\nexport const store = null;',
      'import { productionComponentManifestCatalog } from "./component-manifest-catalog-data.js"; export const store = null;'
    ]) {
      writeFileSync(resolve(dist, "component-store.js"), decoy);
      await createAsarFixture(
        createPackage,
        source,
        resolve(resources, "app.asar")
      );
      assert.throws(
        () =>
          verifyPackagedDesktopCatalog({
            appPath,
            catalogPath,
            version: "1.2.3"
          }),
        /does not validate imported catalog/i
      );
    }
    writeFileSync(resolve(dist, "component-store.js"), consumer);
    writeFileSync(
      resolve(dist, "component-manifest-catalog-data.js"),
      "export const productionComponentManifestCatalog = undefined;"
    );
    await createAsarFixture(
      createPackage,
      source,
      resolve(resources, "app.asar")
    );
    assert.throws(
      () =>
        verifyPackagedDesktopCatalog({
          appPath,
          catalogPath,
          version: "1.2.3"
        }),
      /catalog/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
