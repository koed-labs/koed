import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const target of [
  { platform: "linux", architecture: "x64" },
  { platform: "macos", architecture: "arm64" }
]) {
  test(`builds pin-only ${target.platform} releases with canonical manifests and deterministic archives`, () => {
    const scratch = resolve(import.meta.dirname, "../scratch");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(resolve(scratch, "koed-component-release-"));
    try {
      const componentsRoot = resolve(root, "components");
      const outDir = resolve(root, "release");
      for (const component of ["base", "privacy"]) {
        write(
          resolve(componentsRoot, component, "service.js"),
          `export {}; // ${component}\n`
        );
        write(
          resolve(componentsRoot, component, "third-party-notices.json"),
          "{}\n"
        );
      }
      const options = {
        componentsRoot,
        outDir,
        version: "1.2.3",
        target,
        runtimes: [
          { kind: "node", runtimeRange: ">=24 <25", nodeRange: ">=24 <25" }
        ],
        requiredFiles: { base: ["service.js"], privacy: ["service.js"] }
      };
      for (const component of ["base", "privacy"]) {
        write(
          resolve(
            outDir,
            `koed-${component}-1.2.3-${target.platform}-${target.architecture}.tar.gz.signature.json`
          ),
          '{"status":"unsigned-placeholder"}\n'
        );
      }
      const result = buildComponentReleaseSet(options);
      const distributionBytes = readFileSync(result.distributionManifest);
      const distribution = JSON.parse(distributionBytes);
      assert.deepEqual(Object.keys(distribution).sort(), [
        "components",
        "id",
        "schemaVersion",
        "target",
        "version"
      ]);
      assert.equal(distribution.version, "1.2.3");
      assert.equal(result.productionReady, undefined);
      assert.deepEqual(Object.keys(distribution.components).sort(), [
        "base",
        "privacy"
      ]);
      const expectedFiles = [result.distributionManifest.split("/").at(-1)];
      for (const component of ["base", "privacy"]) {
        const entry = distribution.components[component];
        assert.deepEqual(Object.keys(entry).sort(), [
          "archive",
          "archiveSha256",
          "checksum",
          "manifest",
          "manifestSha256"
        ]);
        const manifestBytes = readFileSync(resolve(outDir, entry.manifest));
        const manifest = JSON.parse(manifestBytes);
        assert.deepEqual(
          manifestBytes,
          canonicalComponentManifestBytes(manifest)
        );
        assert.equal(manifest.component, component);
        assert.equal(manifest.archive.sha256, entry.archiveSha256);
        assert.equal(
          sha256(readFileSync(resolve(outDir, entry.archive))),
          entry.archiveSha256
        );
        assert.equal(sha256(manifestBytes), entry.manifestSha256);
        assert.equal(
          readFileSync(resolve(outDir, entry.checksum), "utf8"),
          `${entry.archiveSha256}  ${entry.archive}\n`
        );
        expectedFiles.push(entry.archive, entry.manifest, entry.checksum);
      }
      assert.deepEqual(readdirSync(outDir).sort(), expectedFiles.sort());
      const rebuilt = buildComponentReleaseSet({
        ...options,
        outDir: resolve(root, "rebuilt")
      });
      assert.deepEqual(rebuilt.components, result.components);
      assert.deepEqual(
        readFileSync(rebuilt.distributionManifest),
        distributionBytes
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
