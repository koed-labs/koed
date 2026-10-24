import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildComponentManifestCatalog } from "./component-manifest-catalog.mjs";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";

export const verifyFrozenComponentAssets = async ({
  assetsDir,
  catalogPath,
  version
}) => {
  const names = readdirSync(assetsDir).filter((name) =>
    /^koed-(base|privacy)-.*\.tar\.gz\.manifest\.json$/.test(name)
  );
  const manifests = names.map((name) => readFileSync(resolve(assetsDir, name)));
  const catalog = buildComponentManifestCatalog({ version, manifests });
  if (
    !readFileSync(catalogPath).equals(canonicalComponentManifestBytes(catalog))
  )
    throw new Error("Frozen component catalog mismatch.");
  for (let index = 0; index < manifests.length; index++) {
    const manifest = JSON.parse(manifests[index]);
    const archiveName = `koed-${manifest.component}-${version}-${manifest.target.platform}-${manifest.target.architecture}.tar.gz`;
    if (
      manifest.archive.name !== archiveName ||
      names[index] !== `${archiveName}.manifest.json`
    )
      throw new Error("Frozen component filename/identity mismatch.");
    const path = resolve(assetsDir, archiveName);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (
      statSync(path).size !== manifest.archive.bytes ||
      hash.digest("hex") !== manifest.archive.sha256
    )
      throw new Error(
        `Frozen component archive digest/size mismatch: ${archiveName}`
      );
  }
  return catalog;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [assetsDir, catalogPath, version, ...extra] = process.argv.slice(2);
  if (!assetsDir || !catalogPath || !version || extra.length)
    throw new Error(
      "Usage: node scripts/verify-frozen-component-assets.mjs <assets-directory> <catalog-path> <version>"
    );
  await verifyFrozenComponentAssets({ assetsDir, catalogPath, version });
}
