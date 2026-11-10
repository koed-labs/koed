import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { canonicalArtifactJson } from "../packages/koed-server/src/artifact-canonical-json.mjs";
import {
  compareNativeVersions,
  validateNativeRuntimeCatalog
} from "../packages/koed-server/dist/native-runtime-catalog.js";
import { verifyPackagedNativeCatalog } from "./native-runtime-pins.mjs";
import { verifyReleaseCandidate } from "./release-candidate-verification.mjs";
import {
  setupCandidate,
  refreshCandidatePackage
} from "./test-utils/release-candidate-fixture.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("a catalog-less control plane still rejects native installation authority", async () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/catalogless-native-"));
  try {
    writeFileSync(resolve(root, "package.json"), '{"type":"module"}\n');
    mkdirSync(resolve(root, "node_modules"));
    symlinkSync(
      resolve("packages/koed-server/node_modules/zod"),
      resolve(root, "node_modules/zod"),
      "junction"
    );
    copyFileSync(
      resolve("packages/koed-server/dist/native-runtime-catalog.js"),
      resolve(root, "native-runtime-catalog.js")
    );
    writeFileSync(
      resolve(root, "native-runtime-catalog-data.mjs"),
      "export const productionNativeRuntimeCatalog = null;\n"
    );
    const { getNativeRuntimeCatalog } = await import(
      pathToFileURL(resolve(root, "native-runtime-catalog.js")).href
    );
    assert.throws(
      () => getNativeRuntimeCatalog(),
      /no reviewed native runtime pin/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const cudaFixture = (catalog) => {
  const archive = Buffer.from("CUDA archive"),
    recipe = { kind: "cuda", fixture: "separate" };
  const recipeId = hash(canonicalArtifactJson(recipe)),
    url = `https://github.com/koed-labs/koed/releases/download/native-cuda-${recipeId}/koed-native-cuda-${recipeId}-linux-x64.tar.gz`;
  const shared = {
    recipeId,
    runtimeVersion: "1.0.0",
    target: catalog.core.target,
    contracts: { layout: 1, embedding: 1 },
    llamaCpp: catalog.core.components.llamaCpp,
    cuda: {
      toolkitVersion: "12.4",
      minimumDriverLinux: "550.54.14",
      architectures: [89]
    }
  };
  const raw = Buffer.from(
    JSON.stringify({
      ...shared,
      kind: "cuda",
      schemaVersion: 1,
      recipe,
      inventory: []
    })
  );
  const pin = {
    ...shared,
    url,
    sha256: hash(archive),
    archiveBytes: archive.length,
    expandedBytes: raw.length,
    manifestSha256: hash(raw)
  };
  return { pin, archive, manifest: raw };
};

test("rejects CUDA packages with a different llama.cpp revision", () => {
  const { catalog } = fixture();
  const { pin } = cudaFixture(catalog);
  assert.throws(
    () =>
      validateNativeRuntimeCatalog({
        ...catalog,
        cuda: {
          ...pin,
          llamaCpp: { ...pin.llamaCpp, revision: "e".repeat(40) }
        }
      }),
    /does not match/
  );
});
const fixture = () => {
  const recipe = { fixture: true };
  const recipeId = hash(canonicalArtifactJson(recipe));
  const archive = Buffer.from("synthetic native archive");
  const manifest = {
    inventory: [{ type: "file", bytes: 42 }],
    schemaVersion: 1,
    kind: "core",
    recipeId,
    recipe,
    runtimeVersion: "1.1.0",
    target: {
      platform: "linux",
      architecture: "x64",
      libc: { family: "glibc", minimumVersion: "2.35" }
    },
    contracts: { layout: 1, postgres: 1, embedding: 1 },
    components: {
      postgres: { major: 17, version: "17.6" },
      pgvector: { version: "0.8.3" },
      llamaCpp: { version: "b10514", revision: "a".repeat(40) }
    }
  };
  const manifestBytes = Buffer.from(canonicalArtifactJson(manifest));
  const catalog = {
    schemaVersion: 1,
    minimumCoreVersion: "1.0.0",
    cuda: null,
    core: {
      recipeId,
      runtimeVersion: manifest.runtimeVersion,
      target: manifest.target,
      contracts: manifest.contracts,
      components: manifest.components,
      url: `https://github.com/koed-labs/koed/releases/download/native-core-${recipeId}/koed-native-core-${recipeId}-linux-x64.tar.gz`,
      sha256: hash(archive),
      archiveBytes: archive.length,
      expandedBytes: manifestBytes.length + 42,
      manifestSha256: hash(manifestBytes)
    }
  };
  return { catalog, archive, manifestBytes };
};

test("CPU-only native catalog enforces URL, target, contract, version and fixed pgvector boundaries", () => {
  const { catalog } = fixture();
  assert.deepEqual(validateNativeRuntimeCatalog(catalog), catalog);
  assert.equal(compareNativeVersions("1.10.0", "1.2.0"), 1);
  for (const mutate of [
    (value) => {
      delete value.core;
    },
    (value) => {
      value.minimumCoreVersion = "2.0.0";
    },
    (value) => {
      value.core.url += "?override=true";
    },
    (value) => {
      value.core.contracts.layout = 2;
    },
    (value) => {
      value.core.components.pgvector.version = "0.8.4";
    },
    (value) => {
      value.core.target.libc.minimumVersion = "2.34";
    },
    (value) => {
      value.core.archiveBytes = 50_000_001;
    },
    (value) => {
      value.cuda = { unpublished: true };
    }
  ]) {
    const changed = structuredClone(catalog);
    mutate(changed);
    assert.throws(
      () => validateNativeRuntimeCatalog(changed),
      /Invalid compiled/
    );
  }
});

test("packaged native authority is inspected statically and must equal the reviewed pins", () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/native-pins-"));
  const modulePath = resolve(root, "control-plane.mjs");
  const { catalog } = fixture();
  try {
    writeFileSync(
      modulePath,
      `throw new Error('DO NOT EXECUTE'); export const productionNativeRuntimeCatalog = ${JSON.stringify(catalog)};`
    );
    assert.deepEqual(
      verifyPackagedNativeCatalog({ modulePath, expected: catalog }),
      catalog
    );
    for (const source of [
      "export const productionNativeRuntimeCatalog = null;",
      "export const unrelated = null;",
      "export const productionNativeRuntimeCatalog = fetch('https://example.com');",
      `export const productionNativeRuntimeCatalog = ${JSON.stringify(catalog)}; productionNativeRuntimeCatalog.core.sha256 = '${"b".repeat(64)}';`
    ]) {
      writeFileSync(modulePath, source);
      assert.throws(() =>
        verifyPackagedNativeCatalog({ modulePath, expected: catalog })
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion binds both packaged pins to the same product draft", async () => {
  const f = await setupCandidate();
  try {
    const native = fixture(),
      { catalog } = native;
    const cuda = cudaFixture(catalog);
    catalog.cuda = cuda.pin;
    for (const [kind, archive, manifest] of [
      ["core", native.archive, native.manifestBytes],
      ["cuda", cuda.archive, cuda.manifest]
    ]) {
      const pin = catalog[kind];
      const name = `koed-native-${kind}-${pin.recipeId}-linux-x64.tar.gz`;
      pin.url = `https://github.com/koed-labs/koed/releases/download/v${f.expected.version}/${name}`;
      f.contents.set(name, archive);
      f.contents.set(`native-${kind}-manifest.json`, manifest);
    }
    f.contents.set(
      "native-runtime-catalog.json",
      Buffer.from(JSON.stringify(catalog))
    );
    const path = resolve(f.packageRoot, "vendor/control-plane.js");
    const source = readFileSync(path, "utf8");
    function pack() {
      writeFileSync(
        path,
        source.replace(
          "export const productionNativeRuntimeCatalog = null;",
          `export const productionNativeRuntimeCatalog = ${JSON.stringify(catalog)};`
        )
      );
      refreshCandidatePackage(f);
      f.release.assets = [...f.contents.keys()].map((name, index) => ({
        id: index + 10,
        name
      }));
    }
    pack();
    assert.equal(
      (await verifyReleaseCandidate(f.input, f.readers)).kind,
      "verified-release-candidate"
    );
    f.contents.set("native-cuda-manifest.json", Buffer.from("changed"));
    pack();
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /differs from the product draft/
    );
    f.contents.set("native-cuda-manifest.json", cuda.manifest);
    catalog.cuda.url = catalog.cuda.url.replace("/v1.2.3/", "/v1.2.2/");
    f.contents.set(
      "native-runtime-catalog.json",
      Buffer.from(JSON.stringify(catalog))
    );
    pack();
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /differs from the product draft/
    );
  } finally {
    f.cleanup();
  }
});
