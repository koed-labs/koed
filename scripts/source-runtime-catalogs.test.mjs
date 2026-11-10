import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { embedSourceRuntimeCatalogs } from "./embed-source-runtime-catalogs.mjs";
import { readPackagedCatalog } from "./static-packaged-catalog.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const reviewed = JSON.parse(
  readFileSync(resolve(repoRoot, "config/source-runtime-catalogs.json"), "utf8")
);
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const write = (root, path, value) => {
  const output = resolve(root, path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    typeof value === "string" ? value : JSON.stringify(value)
  );
  return output;
};
const fixture = (catalogs = structuredClone(reviewed)) => {
  mkdirSync(resolve(repoRoot, "scratch"), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, "scratch/source-catalogs-"));
  roots.push(root);
  write(root, "package.json", { version: reviewed.productVersion });
  write(root, "packages/koed-server/package.json", {
    version: reviewed.productVersion
  });
  write(root, "config/source-runtime-catalogs.json", catalogs);
  write(root, "scripts/native-runtime/core-compatibility.linux-x64.json", {
    minimumCoreVersion: reviewed.native.minimumCoreVersion
  });
  write(
    root,
    "packages/koed-server/src/native-runtime-catalog-data.mjs",
    "export const productionNativeRuntimeCatalog = null;\n"
  );
  write(
    root,
    "packages/koed-server/dist/native-runtime-catalog-data.mjs",
    "export const productionNativeRuntimeCatalog = null;\n"
  );
  write(
    root,
    "packages/koed-server/dist/component-manifest-catalog-data.js",
    "export const productionComponentManifestCatalog = null;\n"
  );
  return root;
};
const nativeOutput = (root) =>
  readPackagedCatalog(
    resolve(root, "packages/koed-server/dist/native-runtime-catalog-data.mjs"),
    "productionNativeRuntimeCatalog"
  );
const componentOutput = (root) =>
  readPackagedCatalog(
    resolve(
      root,
      "packages/koed-server/dist/component-manifest-catalog-data.js"
    ),
    "productionComponentManifestCatalog"
  );

test("a clean source build receives complete version-matched CPU/CUDA and component pins without changing source authority", () => {
  const root = fixture();
  const source = readFileSync(
    resolve(root, "packages/koed-server/src/native-runtime-catalog-data.mjs")
  );
  assert.deepEqual(
    embedSourceRuntimeCatalogs({ repoRoot: root, environment: {} }),
    { mode: "source", version: reviewed.productVersion }
  );
  assert.deepEqual(nativeOutput(root), reviewed.native);
  assert.deepEqual(componentOutput(root), reviewed.components);
  assert.deepEqual(
    readFileSync(
      resolve(root, "packages/koed-server/src/native-runtime-catalog-data.mjs")
    ),
    source
  );
  // A subsequent workspace rebuild may re-emit both null placeholders.
  write(
    root,
    "packages/koed-server/dist/native-runtime-catalog-data.mjs",
    "export const productionNativeRuntimeCatalog = null;\n"
  );
  write(
    root,
    "packages/koed-server/dist/component-manifest-catalog-data.js",
    "export const productionComponentManifestCatalog = null;\n"
  );
  embedSourceRuntimeCatalogs({ repoRoot: root, environment: {} });
  assert.deepEqual(nativeOutput(root), reviewed.native);
  assert.deepEqual(componentOutput(root), reviewed.components);
});

for (const [name, mutate] of [
  [
    "unreviewed product version",
    (value) => {
      value.productVersion = "99.0.0";
    }
  ],
  [
    "missing checksum",
    (value) => {
      delete value.native.cuda.sha256;
    }
  ],
  [
    "unapproved download host",
    (value) => {
      value.native.core.url = "https://example.com/runtime.tar.gz";
    }
  ],
  [
    "incompatible CUDA revision",
    (value) => {
      value.native.cuda.llamaCpp.revision = "e".repeat(40);
    }
  ],
  [
    "different native version",
    (value) => {
      value.native.cuda.runtimeVersion = "99.0.0";
    }
  ],
  [
    "missing CUDA pin",
    (value) => {
      value.native.cuda = null;
    }
  ],
  [
    "different component version",
    (value) => {
      value.components.productVersion = "99.0.0";
    }
  ],
  [
    "incomplete component catalog",
    (value) => {
      value.components.entries.pop();
    }
  ]
]) {
  test(`rejects ${name} before replacing either output`, () => {
    const input = structuredClone(reviewed);
    mutate(input);
    const root = fixture(input);
    assert.throws(() =>
      embedSourceRuntimeCatalogs({ repoRoot: root, environment: {} })
    );
    assert.equal(nativeOutput(root), null);
    assert.equal(componentOutput(root), null);
  });
}

test("requires the checkout, control plane and minimum native contract to match the reviewed input", () => {
  for (const [path, value] of [
    ["package.json", { version: "99.0.0" }],
    ["packages/koed-server/package.json", { version: "99.0.0" }],
    [
      "scripts/native-runtime/core-compatibility.linux-x64.json",
      { minimumCoreVersion: "99.0.0" }
    ]
  ]) {
    const root = fixture();
    write(root, path, value);
    assert.throws(
      () => embedSourceRuntimeCatalogs({ repoRoot: root, environment: {} }),
      /version|compatibility/
    );
    assert.equal(nativeOutput(root), null);
  }
});

test("preserves explicit release catalogs instead of substituting development pins", () => {
  const root = fixture();
  const native = structuredClone(reviewed.native);
  native.core.sha256 = "e".repeat(64);
  const components = structuredClone(reviewed.components);
  components.entries[0].manifestSha256 = "e".repeat(64);
  write(
    root,
    "packages/koed-server/src/native-runtime-catalog-data.mjs",
    `export const productionNativeRuntimeCatalog = ${JSON.stringify(native)};\n`
  );
  const path = write(root, "release-components.json", components);
  embedSourceRuntimeCatalogs({
    repoRoot: root,
    environment: { KOED_COMPONENT_MANIFEST_CATALOG: path }
  });
  assert.deepEqual(nativeOutput(root), native);
  assert.deepEqual(componentOutput(root), components);
});

test("does not mix a partial release input with the development catalogs", () => {
  const root = fixture();
  const path = write(root, "release-components.json", reviewed.components);
  assert.throws(
    () =>
      embedSourceRuntimeCatalogs({
        repoRoot: root,
        environment: { KOED_COMPONENT_MANIFEST_CATALOG: path }
      }),
    /both explicit/
  );
  assert.equal(nativeOutput(root), null);
  write(
    root,
    "packages/koed-server/src/native-runtime-catalog-data.mjs",
    `export const productionNativeRuntimeCatalog = ${JSON.stringify(reviewed.native)};\n`
  );
  assert.throws(
    () => embedSourceRuntimeCatalogs({ repoRoot: root, environment: {} }),
    /both explicit/
  );
});
