import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import {
  buildComponentManifest,
  listFiles,
  sha256File,
  signComponentManifest
} from "./koed-server-package-lib.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const components = ["base", "privacy"];

export const buildComponentReleaseSet = ({
  componentsRoot,
  outDir,
  version,
  target,
  runtimes,
  requiredFiles,
  signing
}) => {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ""))
    throw new Error("Component release requires valid product version.");
  if (Boolean(signing?.keyId) !== Boolean(signing?.privateKey))
    throw new Error("Component signing requires both keyId and privateKey.");
  mkdirSync(outDir, { recursive: true });
  const records = {};
  for (const component of components) {
    const componentRoot = resolve(componentsRoot, component);
    const archiveName = `koed-${component}-${version}-${target.platform}-${target.architecture}.tar.gz`;
    const archivePath = resolve(outDir, archiveName);
    writeDeterministicTarGz({
      sourceDir: componentRoot,
      rootName: component,
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
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const signatureName = `${archiveName}.signature.json`;
    const signaturePath = resolve(outDir, signatureName);
    const signature = signing
      ? signComponentManifest({
          manifest,
          keyId: signing.keyId,
          privateKey: signing.privateKey
        }).signature
      : {
          schemaVersion: 1,
          status: "unsigned-placeholder",
          algorithm: "ed25519",
          keyId: null,
          signature: null
        };
    writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`);
    const checksumPath = `${archivePath}.sha256`;
    const archiveSha256 = sha256File(archivePath);
    writeFileSync(checksumPath, `${archiveSha256}  ${basename(archivePath)}\n`);
    records[component] = {
      archive: archiveName,
      archiveSha256,
      manifest: manifestName,
      manifestSha256: sha256(readFileSync(manifestPath)),
      signature: signatureName,
      signatureStatus: signing ? "signed" : "unsigned-placeholder",
      checksum: basename(checksumPath)
    };
  }
  const distribution = {
    schemaVersion: 1,
    id: "koed-standalone-components",
    version,
    target,
    components: records,
    signatureStatus: components.every(
      (component) => records[component].signatureStatus === "signed"
    )
      ? "component-manifests-signed"
      : "unsigned-placeholder"
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
    components: records,
    productionReady:
      distribution.signatureStatus === "component-manifests-signed"
  };
};

export const componentReleaseInventorySha256 = (root) => {
  const entries = listFiles(root)
    .map((path) => `${path}\0${sha256(readFileSync(resolve(root, path)))}`)
    .join("\0");
  return sha256(entries);
};
