import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import { verifyFrozenComponentAssets } from "./verify-frozen-component-assets.mjs";
import {
  candidateFixture,
  runtimeIdentities
} from "./test-utils/release-candidate-fixture.mjs";
import { verifyComponent } from "../packages/koed-server/dist/component-verification.js";
import { discoverActualRuntimeIdentity } from "../packages/koed-server/dist/component-runtime-identity.js";

for (const check of [
  "canonical bytes",
  "payload-relative archive",
  "frozen catalog and pinned installer admission"
]) {
  test(`generated pin-only release satisfies ${check}`, async () => {
    const f = candidateFixture();
    try {
      const runtime = discoverActualRuntimeIdentity();
      const target = {
        platform: runtime.platform,
        architecture: runtime.architecture
      };
      const archive = resolve(
        f.assetsDir,
        `koed-base-1.2.3-${target.platform}-${target.architecture}.tar.gz`
      );
      const manifestBytes = readFileSync(`${archive}.manifest.json`);
      const manifest = JSON.parse(manifestBytes);
      if (check === "canonical bytes")
        assert.deepEqual(
          manifestBytes,
          canonicalComponentManifestBytes(manifest)
        );
      else if (check === "payload-relative archive") {
        const paths = execFileSync("tar", ["-tzf", archive], {
          encoding: "utf8"
        })
          .trim()
          .split("\n");
        assert.ok(paths.includes("main.js"), JSON.stringify(paths));
        assert.ok(!paths.includes("base/main.js"));
      } else {
        const catalog = await verifyFrozenComponentAssets({
          assetsDir: f.assetsDir,
          catalogPath: resolve(f.assetsDir, "component-manifest-hashes.json"),
          version: "1.2.3",
          runtimeIdentities
        });
        assert.equal(catalog.entries.length, 4);
        await verifyComponent({
          manifestBytes,
          archivePath: archive,
          expectedComponent: "base",
          expectedVersion: "1.2.3",
          target,
          runtime,
          manifestCatalog: {
            schemaVersion: 1,
            productVersion: "1.2.3",
            entries: [
              {
                component: "base",
                target,
                manifestSha256: createHash("sha256")
                  .update(manifestBytes)
                  .digest("hex")
              }
            ]
          }
        });
      }
    } finally {
      f.cleanup();
    }
  });
}
