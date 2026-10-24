import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import {
  requiredComponentIdentities,
  writeComponentManifestCatalog
} from "./component-manifest-catalog.mjs";
import { verifyFrozenComponentAssets } from "./verify-frozen-component-assets.mjs";

test("frozen assets match complete catalog; manifest/archive mutation and missing tuples reject", async () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/frozen-assets-test-"));
  try {
    const componentsRoot = resolve(root, "components");
    const assetsDir = resolve(root, "assets");
    for (const component of ["base", "privacy"]) {
      mkdirSync(resolve(componentsRoot, component), { recursive: true });
      writeFileSync(
        resolve(componentsRoot, component, "main.js"),
        "export {};\n"
      );
    }
    for (const target of [
      requiredComponentIdentities[0].target,
      requiredComponentIdentities[2].target
    ])
      buildComponentReleaseSet({
        componentsRoot,
        outDir: assetsDir,
        version: "1.2.3",
        target,
        runtimes: [
          {
            kind: "node",
            runtimeRange: ">=24 <25",
            nodeRange: ">=24 <25",
            modulesAbi: "137"
          }
        ],
        requiredFiles: { base: ["main.js"], privacy: ["main.js"] }
      });
    const catalogPath = resolve(assetsDir, "component-manifest-hashes.json");
    writeComponentManifestCatalog({
      manifestsDir: assetsDir,
      outputPath: catalogPath,
      version: "1.2.3"
    });
    await verifyFrozenComponentAssets({
      assetsDir,
      catalogPath,
      version: "1.2.3"
    });
    const archive = resolve(assetsDir, "koed-base-1.2.3-linux-x64.tar.gz");
    const original = readFileSync(archive);
    writeFileSync(archive, Buffer.alloc(original.length));
    await assert.rejects(
      verifyFrozenComponentAssets({ assetsDir, catalogPath, version: "1.2.3" }),
      /archive.*mismatch/i
    );
    writeFileSync(archive, original);
    rmSync(
      resolve(assetsDir, "koed-privacy-1.2.3-macos-arm64.tar.gz.manifest.json")
    );
    await assert.rejects(
      verifyFrozenComponentAssets({ assetsDir, catalogPath, version: "1.2.3" }),
      /missing|complete/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
