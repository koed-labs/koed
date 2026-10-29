import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync
} from "node:fs";
import { resolve } from "node:path";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import {
  buildComponentManifestCatalog,
  requiredComponentIdentities,
  writeComponentManifestCatalog
} from "./component-manifest-catalog.mjs";

const version = "0.9.0";
const required = requiredComponentIdentities;
const manifestBytes = (identity) =>
  canonicalComponentManifestBytes({
    schemaVersion: identity.variant ? 2 : 1,
    productVersion: version,
    ...identity,
    runtimes: [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        minimumNapi: 10
      }
    ],
    archive: {
      name: `koed-${identity.component}-${version}-${identity.target.platform}-${identity.target.architecture}${identity.variant ? `-${identity.variant}` : ""}.tar.gz`,
      bytes: 123,
      sha256: "a".repeat(64)
    },
    requiredFiles: ["entry.js"],
    files: [{ path: "entry.js", sha256: "b".repeat(64) }]
  });
const manifests = () => required.map(manifestBytes);

test("catalog deterministically binds all independently required manifest identities", () => {
  const bytes = manifests();
  const catalog = buildComponentManifestCatalog({
    version,
    manifests: bytes,
    required
  });
  assert.deepEqual(
    catalog,
    buildComponentManifestCatalog({
      version,
      manifests: bytes.toReversed(),
      required
    })
  );
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.productVersion, version);
  assert.equal(catalog.entries.length, 5);
  for (const identity of required) {
    const entry = catalog.entries.find(
      (entry) =>
        entry.component === identity.component &&
        entry.variant === identity.variant &&
        entry.target.platform === identity.target.platform
    );
    assert.deepEqual(entry.target, identity.target);
    assert.equal(
      entry.manifestSha256,
      createHash("sha256").update(manifestBytes(identity)).digest("hex")
    );
  }
});

test("five files containing duplicate tuples cannot replace missing macOS identity", () => {
  const bytes = manifests();
  bytes[3] = bytes[1];
  assert.throws(
    () =>
      buildComponentManifestCatalog({ version, manifests: bytes, required }),
    /duplicate|missing/i
  );
});

test("catalog rejects missing, extra, wrong-version and wrong-libc identities", () => {
  const bytes = manifests();
  for (let index = 0; index < bytes.length; index++)
    assert.throws(
      () =>
        buildComponentManifestCatalog({
          version,
          manifests: bytes.filter((_, position) => position !== index),
          required
        }),
      /missing|complete/i
    );
  const wrongVersion = bytes.map((bytes) =>
    Buffer.from(bytes.toString().replaceAll(version, "0.9.1"))
  );
  assert.throws(
    () =>
      buildComponentManifestCatalog({
        version,
        manifests: wrongVersion,
        required
      }),
    /version/i
  );
  const wrongLibc = bytes.map((bytes) =>
    Buffer.from(bytes.toString().replace("2.35", "2.34"))
  );
  assert.throws(
    () =>
      buildComponentManifestCatalog({
        version,
        manifests: wrongLibc,
        required
      }),
    /identity|target|unexpected/i
  );
  const extra = manifestBytes({
    component: "base",
    target: { platform: "linux", architecture: "arm64" }
  });
  assert.throws(
    () =>
      buildComponentManifestCatalog({
        version,
        manifests: [...bytes, extra],
        required
      }),
    /unexpected|extra/i
  );
});

test("generator writes canonical complete catalog but never writes partial catalog", () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/catalog-test-"));
  const outputPath = resolve(root, "component-manifest-hashes.json");
  try {
    for (const identity of required)
      writeFileSync(
        resolve(
          root,
          `koed-${identity.component}-${version}-${identity.target.platform}-${identity.target.architecture}${identity.variant ? `-${identity.variant}` : ""}.tar.gz.manifest.json`
        ),
        manifestBytes(identity)
      );
    writeComponentManifestCatalog({ manifestsDir: root, outputPath, version });
    assert.deepEqual(
      JSON.parse(readFileSync(outputPath, "utf8")),
      buildComponentManifestCatalog({
        version,
        manifests: manifests(),
        required
      })
    );
    rmSync(outputPath);
    rmSync(
      resolve(root, `koed-privacy-${version}-macos-arm64.tar.gz.manifest.json`)
    );
    assert.throws(
      () =>
        writeComponentManifestCatalog({
          manifestsDir: root,
          outputPath,
          version
        }),
      /missing|complete/i
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog rejects noncanonical and duplicate-key manifests", () => {
  const bytes = manifests();
  const pretty = Buffer.from(JSON.stringify(JSON.parse(bytes[0]), null, 2));
  const duplicate = Buffer.from(
    bytes[0]
      .toString()
      .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')
  );
  for (const invalid of [pretty, duplicate])
    assert.throws(
      () =>
        buildComponentManifestCatalog({
          version,
          manifests: [invalid, ...bytes.slice(1)],
          required
        }),
      /canonical/i
    );
});
