import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseManifestCatalog } from "./embed-component-manifest-catalog.mjs";
import { readPackagedCatalog } from "./static-packaged-catalog.mjs";

export const verifyPackagedControlPlaneCatalog = ({
  modulePath,
  catalogPath,
  version,
  catalog
}) => {
  const expected = validateReleaseManifestCatalog(
    catalog ?? JSON.parse(readFileSync(catalogPath, "utf8")),
    version
  );
  const actual = validateReleaseManifestCatalog(
    readPackagedCatalog(modulePath),
    version
  );
  assert.deepEqual(
    actual,
    expected,
    "Packaged control-plane catalog mismatch."
  );
  return actual;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [modulePath, catalogPath, version, ...extra] = process.argv.slice(2);
  if (!modulePath || !catalogPath || !version || extra.length)
    throw new Error(
      "Usage: node scripts/verify-packaged-control-plane-catalog.mjs <effective-module> <catalog> <version>"
    );
  verifyPackagedControlPlaneCatalog({ modulePath, catalogPath, version });
}
