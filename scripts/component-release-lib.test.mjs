import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

test("builds independently hashed, signed base/privacy archives and distribution manifest", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-component-release-"));
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
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const result = buildComponentReleaseSet({
      componentsRoot,
      outDir,
      version: "1.2.3",
      target: { platform: "linux", architecture: "x64" },
      runtimes: [
        { kind: "node", runtimeRange: ">=24 <25", nodeRange: ">=24 <25" }
      ],
      requiredFiles: { base: ["service.js"], privacy: ["service.js"] },
      signing: {
        keyId: "fixture-only",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" })
      }
    });
    const manifest = JSON.parse(
      readFileSync(result.distributionManifest, "utf8")
    );
    assert.equal(manifest.version, "1.2.3");
    assert.deepEqual(Object.keys(manifest.components).sort(), [
      "base",
      "privacy"
    ]);
    for (const component of ["base", "privacy"]) {
      const entry = manifest.components[component];
      const componentManifest = JSON.parse(
        readFileSync(resolve(outDir, entry.manifest), "utf8")
      );
      const signature = JSON.parse(
        readFileSync(resolve(outDir, entry.signature), "utf8")
      );
      assert.equal(componentManifest.component, component);
      assert.equal(componentManifest.archive.sha256, entry.archiveSha256);
      assert.equal(signature.keyId, "fixture-only");
      assert.equal(
        verify(
          null,
          Buffer.concat([
            Buffer.from("koed-component-manifest-v1\n"),
            canonicalComponentManifestBytes(componentManifest)
          ]),
          publicKey,
          Buffer.from(signature.signature, "base64")
        ),
        true
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsigned component build is explicitly marked non-production", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-component-unsigned-"));
  try {
    const componentsRoot = resolve(root, "components");
    for (const component of ["base", "privacy"])
      write(resolve(componentsRoot, component, "x"), "x");
    const result = buildComponentReleaseSet({
      componentsRoot,
      outDir: resolve(root, "release"),
      version: "1.2.3",
      target: { platform: "macos", architecture: "arm64" },
      runtimes: [],
      requiredFiles: { base: ["x"], privacy: ["x"] }
    });
    assert.equal(result.productionReady, false);
    const manifest = JSON.parse(
      readFileSync(result.distributionManifest, "utf8")
    );
    assert.equal(manifest.signatureStatus, "unsigned-placeholder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
