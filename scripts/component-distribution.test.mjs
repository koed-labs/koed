import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import { verifyReleaseSignatures } from "./release-promotion-adapter.mjs";
import { verifyComponent } from "../packages/koed-server/dist/component-verification.js";
import { discoverActualRuntimeIdentity } from "../packages/koed-server/dist/component-runtime-identity.js";

const fixture = () => {
  const scratch = resolve(import.meta.dirname, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "koed-distribution-contract-"));
  const runtime = discoverActualRuntimeIdentity();
  const target = {
    platform: runtime.platform,
    architecture: runtime.architecture
  };
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  for (const component of ["base", "privacy"]) {
    const dir = resolve(root, "components", component);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "service.js"), "export {};\n");
    writeFileSync(resolve(dir, "third-party-notices.json"), "[]\n");
  }
  const release = buildComponentReleaseSet({
    componentsRoot: resolve(root, "components"),
    outDir: resolve(root, "release"),
    version: "1.2.3",
    target,
    runtimes: [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: runtime.modulesAbi
      }
    ],
    requiredFiles: { base: ["service.js"], privacy: ["service.js"] },
    signing: {
      keyId: "test-only",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" })
    }
  });
  const record = release.components.base;
  return {
    root,
    runtime,
    target,
    publicKey,
    record,
    manifest: resolve(root, "release", record.manifest),
    signature: resolve(root, "release", record.signature),
    archive: resolve(root, "release", record.archive)
  };
};

for (const check of [
  "canonical bytes",
  "payload-relative archive",
  "release signature and pinned installer admission"
]) {
  test(`generated signed release satisfies ${check}`, async () => {
    const f = fixture();
    try {
      const manifestBytes = readFileSync(f.manifest);
      const manifest = JSON.parse(manifestBytes);
      if (check === "canonical bytes")
        assert.deepEqual(
          manifestBytes,
          canonicalComponentManifestBytes(manifest)
        );
      else if (check === "payload-relative archive") {
        const paths = execFileSync("tar", ["-tzf", f.archive], {
          encoding: "utf8"
        })
          .trim()
          .split("\n");
        assert.ok(paths.includes("service.js"), JSON.stringify(paths));
        assert.ok(!paths.includes("base/service.js"));
      } else {
        verifyReleaseSignatures(
          [
            {
              manifest: f.manifest,
              signature: f.signature,
              component: "base",
              version: "1.2.3",
              target: `${f.runtime.platform}-${f.runtime.architecture}`
            }
          ],
          { schemaVersion: 1, keys: { "test-only": f.publicKey } }
        );
        await verifyComponent({
          manifestBytes,
          archivePath: f.archive,
          expectedComponent: "base",
          expectedVersion: "1.2.3",
          target: f.target,
          runtime: f.runtime,
          manifestCatalog: {
            schemaVersion: 1,
            productVersion: "1.2.3",
            entries: [
              {
                component: "base",
                target: f.target,
                manifestSha256: createHash("sha256")
                  .update(manifestBytes)
                  .digest("hex")
              }
            ]
          }
        });
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}
