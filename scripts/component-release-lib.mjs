import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import {
  buildComponentManifest,
  canonicalComponentManifestBytes,
  listFiles,
  sha256File
} from "./koed-server-package-lib.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const components = ["base", "privacy"];

export const buildComponentReleaseSet = ({
  componentsRoot,
  outDir,
  version,
  target,
  runtimes,
  requiredFiles
}) => {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ""))
    throw new Error("Component release requires valid product version.");
  mkdirSync(outDir, { recursive: true });
  const records = {};
  for (const component of components) {
    const componentRoot = resolve(componentsRoot, component);
    const archiveName = `koed-${component}-${version}-${target.platform}-${target.architecture}.tar.gz`;
    const archivePath = resolve(outDir, archiveName);
    writeDeterministicTarGz({
      sourceDir: componentRoot,
      rootName: "",
      tarPath: archivePath
    });
    const manifest = buildComponentManifest({
      componentRoot,
      archivePath,
      component,
      productVersion: version,
      target,
      runtimes,
      requiredFiles: requiredFiles[component]
    });
    const manifestName = `${archiveName}.manifest.json`;
    const manifestPath = resolve(outDir, manifestName);
    writeFileSync(manifestPath, canonicalComponentManifestBytes(manifest));
    rmSync(`${archivePath}.signature.json`, { force: true });
    const checksumPath = `${archivePath}.sha256`;
    const archiveSha256 = sha256File(archivePath);
    writeFileSync(checksumPath, `${archiveSha256}  ${basename(archivePath)}\n`);
    records[component] = {
      archive: archiveName,
      archiveSha256,
      manifest: manifestName,
      manifestSha256: sha256(readFileSync(manifestPath)),
      checksum: basename(checksumPath)
    };
  }
  const distribution = {
    schemaVersion: 1,
    id: "koed-standalone-components",
    version,
    target,
    components: records
  };
  const distributionManifest = resolve(
    outDir,
    `koed-distribution-${version}-${target.platform}-${target.architecture}.json`
  );
  writeFileSync(
    distributionManifest,
    `${JSON.stringify(distribution, null, 2)}\n`
  );
  return {
    distributionManifest,
    components: records
  };
};

export const componentReleaseInventorySha256 = (root) => {
  const entries = listFiles(root)
    .map((path) => `${path}\0${sha256(readFileSync(resolve(root, path)))}`)
    .join("\0");
  return sha256(entries);
};
