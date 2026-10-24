import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifestCatalog } from "../packages/koed-server/dist/component-manifest-catalog.js";
import {
  componentCatalogKey,
  requiredComponentIdentities
} from "./component-manifest-catalog.mjs";

export const validateReleaseManifestCatalog = (value, version) => {
  const catalog = validateManifestCatalog(value);
  if (catalog.productVersion !== version)
    throw new Error("Component catalog/control-plane version mismatch.");
  const expected = new Set(
    requiredComponentIdentities.map(componentCatalogKey)
  );
  if (
    catalog.entries.length !== expected.size ||
    catalog.entries.some((entry) => !expected.has(componentCatalogKey(entry)))
  )
    throw new Error(
      "Component catalog is incomplete or contains an unexpected target."
    );
  return catalog;
};

export const embedComponentManifestCatalog = ({
  catalogPath,
  outputPath,
  version
}) => {
  const catalog = catalogPath
    ? validateReleaseManifestCatalog(
        JSON.parse(readFileSync(catalogPath, "utf8")),
        version
      )
    : null;
  const source = catalog
    ? `import { validateManifestCatalog } from "./component-manifest-catalog.js";\nexport const productionComponentManifestCatalog = validateManifestCatalog(${JSON.stringify(catalog)});\n`
    : "export const productionComponentManifestCatalog = null;\n";
  writeFileSync(outputPath, source);
  return catalog;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const packageRoot = resolve(repoRoot, "packages/koed-server");
  embedComponentManifestCatalog({
    catalogPath: process.env.KOED_COMPONENT_MANIFEST_CATALOG,
    outputPath: resolve(packageRoot, "dist/component-manifest-catalog-data.js"),
    version: JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8")
    ).version
  });
}
