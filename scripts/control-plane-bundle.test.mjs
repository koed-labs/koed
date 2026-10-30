import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { bundleControlPlane } from "./control-plane-bundle.mjs";
import { requiredComponentIdentities } from "./component-manifest-catalog.mjs";

test("effective external control plane embeds exact catalog despite stale dist; frozen runtime stays unchanged", async () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/control-plane-test-"));
  try {
    const server = resolve(root, "packages/koed-server/dist");
    mkdirSync(server, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      '{"type":"module","version":"1.2.3"}\n'
    );
    writeFileSync(
      resolve(server, "cli.js"),
      'import {pins} from "./component-store.js"; import {resolveKoedControlPlaneVersion} from "./app-runtime.js"; export const runKoedServerCli = async (args) => { console.log(args.includes("--version") ? resolveKoedControlPlaneVersion() : JSON.stringify(pins)); return 0; }; export const shouldExitPackagedSupervisor = () => false;\n'
    );
    copyFileSync(
      resolve("packages/koed-server/dist/app-runtime.js"),
      resolve(server, "app-runtime.js")
    );
    writeFileSync(
      resolve(server, "component-store.js"),
      'export { productionComponentManifestCatalog as pins } from "./component-manifest-catalog-data.js";\n'
    );
    const frozen = resolve(server, "component-manifest-catalog-data.js");
    writeFileSync(
      frozen,
      'throw new Error("STALE CATALOG MUST NOT EXECUTE");\n'
    );
    const before = readFileSync(frozen);
    writeFileSync(
      resolve(server, "privacy-service-bootstrap.js"),
      "export {};\n"
    );
    copyFileSync(
      resolve("packages/koed-server/dist/component-manifest-catalog.js"),
      resolve(server, "component-manifest-catalog.js")
    );
    const catalog = {
      schemaVersion: 1,
      productVersion: "1.2.3",
      entries: requiredComponentIdentities.map((identity) => ({
        ...identity,
        manifestSha256: "a".repeat(64)
      }))
    };
    const vendorRoot = resolve(root, "control-plane");
    await bundleControlPlane({
      repoRoot: root,
      vendorRoot,
      version: "1.2.3",
      catalog
    });
    assert.deepEqual(readFileSync(frozen), before);
    const result = spawnSync(
      process.execPath,
      [resolve(vendorRoot, "cli.js")],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), catalog);
    const version = spawnSync(
      process.execPath,
      [resolve(vendorRoot, "cli.js"), "--version"],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, "1.2.3\n");
    const info = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `console.log(JSON.stringify((await import(${JSON.stringify(resolve(vendorRoot, "control-plane.js"))})).productionComponentManifestCatalog))`
      ],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(info.status, 0, info.stderr);
    assert.deepEqual(JSON.parse(info.stdout), catalog);
    await assert.rejects(
      bundleControlPlane({
        repoRoot: root,
        vendorRoot,
        version: "1.2.3",
        catalog: null
      }),
      /catalog/i
    );
    await assert.rejects(
      bundleControlPlane({
        repoRoot: root,
        vendorRoot,
        version: "1.2.3",
        catalog,
        cataloglessDevelopment: true
      }),
      /authority/i
    );
    await bundleControlPlane({
      repoRoot: root,
      vendorRoot,
      version: "1.2.3",
      catalog: null,
      cataloglessDevelopment: true
    });
    const disabled = spawnSync(
      process.execPath,
      [resolve(vendorRoot, "cli.js")],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(JSON.parse(disabled.stdout), null);
    await assert.rejects(
      bundleControlPlane({
        repoRoot: root,
        vendorRoot,
        version: "1.2.4",
        catalog
      }),
      /version/i
    );
    writeFileSync(
      resolve(server, "component-store.js"),
      "export const pins = null;\n"
    );
    await assert.rejects(
      bundleControlPlane({
        repoRoot: root,
        vendorRoot,
        version: "1.2.3",
        catalog
      }),
      /runtime.*catalog/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production standalone and public npm packaging require explicit catalog input", () => {
  const env = { ...process.env };
  delete env.KOED_COMPONENT_MANIFEST_CATALOG;
  for (const builder of [
    "build-koed-server-package.mjs",
    "build-public-server-package.mjs"
  ]) {
    const result = spawnSync(process.execPath, [resolve("scripts", builder)], {
      encoding: "utf8",
      env
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /requires KOED_COMPONENT_MANIFEST_CATALOG build input/
    );
  }
});

test("standalone development mode rejects release catalog input before staging", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/build-koed-server-package.mjs"),
      "--catalogless-development",
      "--json"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        KOED_COMPONENT_MANIFEST_CATALOG: "must-not-read-catalog.json"
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicts with release catalog build input/);
});
