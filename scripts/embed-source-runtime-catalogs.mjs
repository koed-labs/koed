import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateNativeRuntimeCatalog } from "../packages/koed-server/dist/native-runtime-catalog.js";
import { validateReleaseManifestCatalog } from "./embed-component-manifest-catalog.mjs";
import { readProductionNativeCatalog } from "./native-runtime-pins.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// This is a source-build input, reviewed through Git like the control plane.
// Downloaded manifests, shell variables and a mutable "latest" release cannot
// supply development trust. Release builds retain their explicit CI authority.
export function embedSourceRuntimeCatalogs({
  repoRoot,
  environment = process.env
}) {
  const serverRoot = resolve(repoRoot, "packages/koed-server");
  const version = readJson(resolve(serverRoot, "package.json")).version;
  if (readJson(resolve(repoRoot, "package.json")).version !== version)
    throw new Error("Source workspace/control-plane version mismatch.");
  let native = readProductionNativeCatalog(repoRoot);
  let components;
  const releaseCatalogPath = environment.KOED_COMPONENT_MANIFEST_CATALOG;
  if (releaseCatalogPath || native !== null) {
    if (!releaseCatalogPath || native === null)
      throw new Error(
        "Release preparation requires both explicit runtime catalogs."
      );
    components = validateReleaseManifestCatalog(
      readJson(releaseCatalogPath),
      version
    );
  } else {
    const reviewed = readJson(
      resolve(repoRoot, "config/source-runtime-catalogs.json")
    );
    if (reviewed.schemaVersion !== 1 || reviewed.productVersion !== version)
      throw new Error(
        "No reviewed source runtime catalogs match this product version. Update config/source-runtime-catalogs.json from a reviewed compatible release."
      );
    native = validateNativeRuntimeCatalog(reviewed.native);
    components = validateReleaseManifestCatalog(reviewed.components, version);
    const compatibility = readJson(
      resolve(
        repoRoot,
        "scripts/native-runtime/core-compatibility.linux-x64.json"
      )
    );
    if (
      native.core.runtimeVersion !== version ||
      native.cuda?.runtimeVersion !== version ||
      native.minimumCoreVersion !== compatibility.minimumCoreVersion
    )
      throw new Error(
        "Reviewed source native runtime version/compatibility mismatch."
      );
  }
  // Validate both catalogs before changing either output. Source preparation's
  // dirty marker and lifecycle lock protect the pair until its manifest commits.
  const outputs = [
    [
      "native-runtime-catalog-data.mjs",
      `export const productionNativeRuntimeCatalog = ${JSON.stringify(native)};\n`
    ],
    [
      "component-manifest-catalog-data.js",
      `import { validateManifestCatalog } from "./component-manifest-catalog.js";\nexport const productionComponentManifestCatalog = validateManifestCatalog(${JSON.stringify(components)});\n`
    ]
  ];
  for (const [name, contents] of outputs) {
    const output = resolve(serverRoot, "dist", name);
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, contents);
      renameSync(temporary, output);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return { version, mode: releaseCatalogPath ? "release" : "source" };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(
    JSON.stringify(
      embedSourceRuntimeCatalogs({
        repoRoot: resolve(import.meta.dirname, "..")
      })
    )
  );
