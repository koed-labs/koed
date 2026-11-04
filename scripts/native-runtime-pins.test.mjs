import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  authenticateNativePins,
  verifyPackagedNativeCatalog
} from "./native-runtime-pins.mjs";
import { verifyReleaseCandidate } from "./release-candidate-verification.mjs";
import {
  setupCandidate,
  refreshCandidatePackage
} from "./test-utils/release-candidate-fixture.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
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
  const read = async (url) =>
    new Response(url === catalog.core.url ? archive : manifestBytes);
  return { catalog, archive, manifestBytes, read };
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

test("native URL authentication streams exact archive bytes and authenticates the manifest", async () => {
  const f = fixture();
  const report = await authenticateNativePins(f.catalog, f.read);
  assert.equal(report.core.sha256, f.catalog.core.sha256);
  assert.equal(report.cuda, null);
  for (const read of [
    async () => new Response(null, { status: 404 }),
    async () => new Response(Buffer.alloc(f.archive.length, 1)),
    async () => new Response(Buffer.alloc(f.archive.length + 1)),
    async (url) =>
      url === f.catalog.core.url
        ? f.read(url)
        : new Response("changed manifest")
  ])
    await assert.rejects(
      authenticateNativePins(f.catalog, read),
      /unavailable|differs|bound/
    );
  const changed = JSON.parse(f.manifestBytes);
  changed.contracts.layout = 2;
  const bytes = Buffer.from(canonicalArtifactJson(changed));
  f.catalog.core.manifestSha256 = hash(bytes);
  await assert.rejects(
    authenticateNativePins(
      f.catalog,
      async (url) =>
        new Response(url === f.catalog.core.url ? f.archive : bytes)
    ),
    /conflicts/
  );
});

test("product candidate verification authenticates effective native pins before promotion", async () => {
  const f = await setupCandidate();
  const native = fixture();
  try {
    const path = resolve(f.packageRoot, "vendor/control-plane.js");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "export const productionNativeRuntimeCatalog = null;",
        `export const productionNativeRuntimeCatalog = ${JSON.stringify(native.catalog)};`
      )
    );
    refreshCandidatePackage(f);
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /reader is missing/
    );
    f.readers.getNativeAsset = native.read;
    assert.equal(
      (await verifyReleaseCandidate(f.input, f.readers)).kind,
      "verified-release-candidate"
    );
    f.readers.getNativeAsset = async () => new Response(null, { status: 404 });
    await assert.rejects(
      verifyReleaseCandidate(f.input, f.readers),
      /unavailable/
    );
  } finally {
    f.cleanup();
  }
});
