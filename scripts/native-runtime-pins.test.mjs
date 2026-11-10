import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalArtifactJson } from "../packages/koed-server/src/artifact-canonical-json.mjs";
import {
  compareNativeVersions,
  getNativeRuntimeCatalog,
  validateNativeRuntimeCatalog
} from "../packages/koed-server/dist/native-runtime-catalog.js";
import {
  createCompiledNativeCatalog,
  verifyPackagedNativeCatalog
} from "./native-runtime-pins.mjs";
import { verifyReleaseCandidate } from "./release-candidate-verification.mjs";
import {
  setupCandidate,
  refreshCandidatePackage
} from "./test-utils/release-candidate-fixture.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

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
  assert.throws(
    () => getNativeRuntimeCatalog(),
    /no reviewed native runtime pin/
  );
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

test("packaged catalog inspection accepts both targets and rejects a substituted macOS pin", () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/native-pins-v2-"));
  const modulePath = resolve(root, "control-plane.mjs");
  const linux = fixture().catalog;
  const macos = structuredClone(linux);
  macos.core.target = {
    platform: "macos",
    architecture: "arm64",
    minimumVersion: "14.0"
  };
  macos.core.components.llamaCpp = { version: "b10514" };
  macos.core.url = macos.core.url.replace("linux-x64", "macos-arm64");
  const expected = { schemaVersion: 2, linux, macos };
  try {
    writeFileSync(
      modulePath,
      `export const productionNativeRuntimeCatalog = ${JSON.stringify(expected)};`
    );
    assert.deepEqual(
      verifyPackagedNativeCatalog({ modulePath, expected }),
      expected
    );
    const changed = structuredClone(expected);
    changed.macos.core.sha256 = "b".repeat(64);
    writeFileSync(
      modulePath,
      `export const productionNativeRuntimeCatalog = ${JSON.stringify(changed)};`
    );
    assert.throws(
      () => verifyPackagedNativeCatalog({ modulePath, expected }),
      /differ/
    );
    changed.macos.core.target.platform = "linux";
    writeFileSync(
      modulePath,
      `export const productionNativeRuntimeCatalog = ${JSON.stringify(changed)};`
    );
    assert.throws(
      () => verifyPackagedNativeCatalog({ modulePath, expected }),
      /Invalid compiled/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiled release catalog requires valid Linux CUDA and macOS core pins", () => {
  const linux = fixture().catalog;
  linux.cuda = cudaFixture(linux).pin;
  const macos = structuredClone(linux);
  macos.cuda = null;
  macos.core.target = {
    platform: "macos",
    architecture: "arm64",
    minimumVersion: "14.0"
  };
  macos.core.components.llamaCpp = { version: "b10514" };
  macos.core.url = macos.core.url.replace("linux-x64", "macos-arm64");
  assert.deepEqual(createCompiledNativeCatalog(linux, macos), {
    schemaVersion: 2,
    linux,
    macos
  });
  assert.throws(() => createCompiledNativeCatalog(linux, null), /required/);
  assert.throws(
    () => createCompiledNativeCatalog({ ...linux, cuda: null }, macos),
    /required/
  );
  const wrong = structuredClone(macos);
  wrong.core.url = linux.core.url;
  assert.throws(
    () => createCompiledNativeCatalog(linux, wrong),
    /Invalid compiled/
  );
});

test("candidate binds schema 2 macOS and Linux pins to reviewed release bytes", async () => {
  const f = await setupCandidate({ native: true });
  try {
    const linuxFixture = fixture();
    const linux = linuxFixture.catalog;
    const cuda = cudaFixture(linux);
    linux.cuda = cuda.pin;
    const initialCatalog = JSON.parse(
      f.contents.get("native-runtime-catalog.json")
    );
    const macCore = initialCatalog.macos.core;
    const macBytes = f.contents.get("native-core-manifest-macos-arm64.json");
    const macArchive = f.contents.get(
      `koed-native-core-${macCore.recipeId}-macos-arm64.tar.gz`
    );
    const macos = {
      schemaVersion: 1,
      minimumCoreVersion: macCore.runtimeVersion,
      core: macCore,
      cuda: null
    };
    for (const [pin, platform, kind, archive, manifest, manifestName] of [
      [
        linux.core,
        "linux-x64",
        "core",
        linuxFixture.archive,
        linuxFixture.manifestBytes,
        "native-core-manifest.json"
      ],
      [
        linux.cuda,
        "linux-x64",
        "cuda",
        cuda.archive,
        cuda.manifest,
        "native-cuda-manifest.json"
      ],
      [
        macCore,
        "macos-arm64",
        "core",
        macArchive,
        macBytes,
        "native-core-manifest-macos-arm64.json"
      ]
    ]) {
      const name = `koed-native-${kind}-${pin.recipeId}-${platform}.tar.gz`;
      pin.url = `https://github.com/koed-labs/koed/releases/download/v${f.expected.version}/${name}`;
      f.contents.set(name, archive);
      f.contents.set(manifestName, manifest);
    }
    const catalog = { schemaVersion: 2, linux, macos };
    const linuxDir = resolve(f.root, "assembly-linux");
    const macDir = resolve(f.root, "assembly-macos");
    mkdirSync(resolve(macDir, "koed-runtime"), { recursive: true });
    mkdirSync(linuxDir);
    for (const [name, bytes] of f.contents) {
      if (
        /^(koed-native-.*-linux-x64\.tar\.gz|native-(core|cuda)-manifest\.json)$/.test(
          name
        )
      )
        writeFileSync(resolve(linuxDir, name), bytes);
    }
    const { url: _url, ...reportPin } = macCore;
    writeFileSync(
      resolve(macDir, "core-candidate.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "core",
        archive: `koed-native-core-${macCore.recipeId}-macos-arm64.tar.gz`,
        ...reportPin
      })
    );
    writeFileSync(
      resolve(
        macDir,
        `koed-native-core-${macCore.recipeId}-macos-arm64.tar.gz`
      ),
      macArchive
    );
    writeFileSync(
      resolve(macDir, "koed-runtime/native-core-manifest.json"),
      macBytes
    );
    const assemble = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/native-runtime/assemble-release-catalog.mjs",
          f.expected.version,
          macDir,
          linuxDir
        ],
        {
          env: { ...process.env, LINUX_CATALOG: JSON.stringify(linux) },
          encoding: "utf8"
        }
      );
    const assembled = assemble();
    assert.equal(assembled.status, 0, assembled.stderr);
    assert.deepEqual(
      JSON.parse(
        readFileSync(resolve(linuxDir, "native-runtime-catalog.json"))
      ),
      catalog
    );
    writeFileSync(
      resolve(macDir, "koed-runtime/native-core-manifest.json"),
      "altered"
    );
    assert.notEqual(assemble().status, 0);
    f.contents.set(
      "native-runtime-catalog.json",
      Buffer.from(JSON.stringify(catalog))
    );
    const path = resolve(f.packageRoot, "vendor/control-plane.js");
    const source = readFileSync(path, "utf8");
    const originalCatalog = `export const productionNativeRuntimeCatalog = ${JSON.stringify(initialCatalog)};`;
    const pack = () => {
      writeFileSync(
        path,
        source.replace(
          originalCatalog,
          `export const productionNativeRuntimeCatalog = ${JSON.stringify(catalog)};`
        )
      );
      refreshCandidatePackage(f);
      f.release.assets = [...f.contents.keys()].map((name, index) => ({
        id: index + 10,
        name
      }));
    };
    pack();
    assert.equal(
      (await verifyReleaseCandidate(f.input, f.readers)).kind,
      "verified-release-candidate"
    );
    f.contents.set(
      "native-core-manifest-macos-arm64.json",
      Buffer.from("changed")
    );
    pack();
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /differs from the product draft/
    );
    f.contents.set("native-core-manifest-macos-arm64.json", macBytes);
    const macName = `koed-native-core-${macCore.recipeId}-macos-arm64.tar.gz`;
    f.contents.set(macName, Buffer.from("substituted archive"));
    pack();
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /differs from the product draft/
    );
    f.contents.set(macName, macArchive);
    catalog.macos = null;
    pack();
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /all required native packages/
    );
    catalog.macos = macos;
    catalog.linux = null;
    pack();
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /all required native packages/
    );
    catalog.linux = linux;
    f.contents.set(
      "native-runtime-catalog.json",
      Buffer.from(JSON.stringify(linux))
    );
    writeFileSync(
      path,
      source.replace(
        originalCatalog,
        `export const productionNativeRuntimeCatalog = ${JSON.stringify(linux)};`
      )
    );
    refreshCandidatePackage(f);
    f.release.assets = [...f.contents.keys()].map((name, index) => ({
      id: index + 10,
      name
    }));
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /schema 2/
    );
  } finally {
    f.cleanup();
  }
});

test("promotion binds both packaged pins to the same product draft", async () => {
  const f = await setupCandidate();
  const donor = await setupCandidate({ native: true });
  try {
    f.expected.artifacts.push(
      donor.expected.artifacts.find((artifact) => artifact.id === 4)
    );
    const getArtifact = f.readers.getArtifact;
    f.readers.getArtifact = (repo, id) =>
      id === 4 ? donor.readers.getArtifact(repo, id) : getArtifact(repo, id);
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
    f.input.allowLegacyNativeCatalog = true;
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /schema 2/
    );
    assert.equal(
      (
        await verifyReleaseCandidate(f.input, f.readers, {
          allowLegacyNativeCatalog: true
        })
      ).kind,
      "verified-release-candidate"
    );
    for (const name of [
      `koed-native-core-${"a".repeat(64)}-macos-arm64.tar.gz`,
      "native-core-manifest-macos-arm64.json"
    ]) {
      f.contents.set(name, Buffer.from("unverified macOS native asset"));
      pack();
      await assert.rejects(
        verifyReleaseCandidate(f.input, f.readers, {
          allowLegacyNativeCatalog: true
        }),
        /macOS native assets require a schema 2 release catalog/
      );
      f.contents.delete(name);
    }
    f.contents.set("native-cuda-manifest.json", Buffer.from("changed"));
    pack();
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers, {
        allowLegacyNativeCatalog: true
      }),
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
      verifyReleaseCandidate(f.input, f.readers, {
        allowLegacyNativeCatalog: true
      }),
      /differs from the product draft/
    );
  } finally {
    donor.cleanup();
    f.cleanup();
  }
});
