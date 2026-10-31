import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import { componentArchiveName } from "../packages/koed-server/src/component-artifact-identity.mjs";
import {
  buildComponentManifest,
  canonicalComponentManifestBytes,
  listFiles,
  sha256File
} from "./koed-server-package-lib.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const buildComponentReleaseSet = ({
  componentsRoot,
  outDir,
  version,
  target,
  runtimes,
  requiredFiles,
  privacyCpuRoot
}) => {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ""))
    throw new Error("Component release requires valid product version.");
  mkdirSync(outDir, { recursive: true });
  const records = {};
  const components =
    target.platform === "linux"
      ? [
          { component: "base" },
          { component: "privacy", variant: "cpu" },
          { component: "privacy", variant: "cuda" }
        ]
      : [{ component: "base" }, { component: "privacy" }];
  for (const { component, variant } of components) {
    const identity = variant ? `${component}-${variant}` : component;
    const componentRoot =
      variant === "cpu"
        ? resolve(privacyCpuRoot ?? resolve(componentsRoot, "privacy-cpu"))
        : resolve(componentsRoot, component);
    const archiveName = componentArchiveName({
      component,
      productVersion: version,
      target,
      variant
    });
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
      variant,
      productVersion: version,
      target,
      runtimes,
      requiredFiles: requiredFiles[identity] ?? requiredFiles[component]
    });
    const manifestName = `${archiveName}.manifest.json`;
    const manifestPath = resolve(outDir, manifestName);
    writeFileSync(manifestPath, canonicalComponentManifestBytes(manifest));
    rmSync(`${archivePath}.signature.json`, { force: true });
    const checksumPath = `${archivePath}.sha256`;
    const archiveSha256 = sha256File(archivePath);
    writeFileSync(checksumPath, `${archiveSha256}  ${basename(archivePath)}\n`);
    records[identity] = {
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
