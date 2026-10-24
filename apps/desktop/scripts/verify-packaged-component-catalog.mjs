import { extractFile, uncache } from "@electron/asar";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { verifyPackagedControlPlaneCatalog } from "../../../scripts/verify-packaged-control-plane-catalog.mjs";

import { assertPackagedCatalogConsumer } from "../../../scripts/static-catalog-binding.mjs";

export const verifyPackagedDesktopCatalog = ({
  appPath,
  catalogPath,
  version
}) => {
  const scratch = resolve(import.meta.dirname, "../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "desktop-catalog-inspection-"));
  try {
    const asarPath = resolve(appPath, "Contents/Resources/app.asar");
    uncache(asarPath);
    const prefix = "node_modules/@koed-labs/server/dist/";
    const store = extractFile(asarPath, `${prefix}component-store.js`).toString(
      "utf8"
    );
    assertPackagedCatalogConsumer(store);
    writeFileSync(
      resolve(root, "component-manifest-catalog-data.js"),
      extractFile(asarPath, `${prefix}component-manifest-catalog-data.js`)
    );
    writeFileSync(resolve(root, "package.json"), '{"type":"module"}\n');
    return verifyPackagedControlPlaneCatalog({
      modulePath: resolve(root, "component-manifest-catalog-data.js"),
      catalogPath,
      version
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [appPath, catalogPath, version, ...extra] = process.argv.slice(2);
  if (!appPath || !catalogPath || !version || extra.length)
    throw new Error(
      "Usage: node apps/desktop/scripts/verify-packaged-component-catalog.mjs <app-path> <catalog> <version>"
    );
  verifyPackagedDesktopCatalog({ appPath, catalogPath, version });
}
