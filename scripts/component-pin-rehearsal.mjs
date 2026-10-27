import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import { buildComponentManifestCatalog } from "./component-manifest-catalog.mjs";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import { discoverActualRuntimeIdentity } from "../packages/koed-server/dist/component-runtime-identity.js";
import { resolveKoedServerPaths } from "../packages/koed-server/dist/paths.js";
import {
  verifyComponent,
  verifyExtractedComponent
} from "../packages/koed-server/dist/component-verification.js";

const fixtureInstaller = async (root, catalog, label) => {
  const runtimeRoot = resolve(root, label);
  cpSync("packages/koed-server/dist", resolve(runtimeRoot, "dist"), {
    recursive: true
  });
  writeFileSync(resolve(runtimeRoot, "package.json"), '{"type":"module"}');
  symlinkSync(
    resolve("packages/koed-server/node_modules"),
    resolve(runtimeRoot, "node_modules"),
    "dir"
  );
  // Only disposable fixture control planes receive fixture pins. Production module stays untouched.
  writeFileSync(
    resolve(runtimeRoot, "dist/component-manifest-catalog-data.js"),
    `export const productionComponentManifestCatalog = ${JSON.stringify(catalog)};`
  );
  return import(
    pathToFileURL(resolve(runtimeRoot, "dist/component-commands.js")).href
  );
};

export const runPinRehearsal = async () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/pin-rehearsal-"));
  const originalFetch = globalThis.fetch;
  try {
    return await exerciseFixture(root);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
};

const exerciseFixture = async (root) => {
  const runtime = discoverActualRuntimeIdentity();
  const target = {
    platform: runtime.platform,
    architecture: runtime.architecture,
    ...(runtime.platform === "linux"
      ? { libc: { family: "glibc", minimumVersion: "2.31" } }
      : {})
  };
  const componentsRoot = resolve(root, "components");
  for (const component of ["base", "privacy"]) {
    mkdirSync(resolve(componentsRoot, component), { recursive: true });
    writeFileSync(
      resolve(componentsRoot, component, "main.js"),
      "throw new Error('FIXTURE_MUST_NOT_START');\n"
    );
  }
  const assets = resolve(root, "assets");
  const built = buildComponentReleaseSet({
    componentsRoot,
    outDir: assets,
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
    requiredFiles: { base: ["main.js"], privacy: ["main.js"] }
  });
  const manifests = Object.values(built.components).map((artifact) =>
    readFileSync(resolve(assets, artifact.manifest))
  );
  const catalog = buildComponentManifestCatalog({
    version: "1.2.3",
    manifests,
    required: ["base", "privacy"].map((component) => ({ component, target }))
  });
  const installer = await fixtureInstaller(root, catalog, "trusted-fixture");
  const base = {
    manifestPath: resolve(assets, built.components.base.manifest),
    archivePath: resolve(assets, built.components.base.archive)
  };
  const manifestBytes = readFileSync(base.manifestPath);
  const archiveBytes = readFileSync(base.archivePath);
  const offline = {
    kind: "offline",
    archivePath: base.archivePath,
    manifestPath: base.manifestPath
  };
  const paths = (label) =>
    resolveKoedServerPaths({ KOED_HOME: resolve(root, label) });
  const context = (label) => ({
    paths: paths(label),
    controlPlaneVersion: "1.2.3",
    target,
    runtime,
    owner: { kind: "cli", installationId: "pin-fixture" },
    isRunning: false
  });
  globalThis.fetch = async () => {
    throw new Error("offline fixture attempted network");
  };
  await installer.runComponentInstall(context("offline-home"), {
    component: "base",
    version: "1.2.3",
    source: offline,
    stageOnly: true
  });
  const fetched = [];
  globalThis.fetch = async (url) => {
    const name = new URL(url).pathname;
    fetched.push(name);
    if (!["/manifest", "/archive"].includes(name))
      throw new Error("unexpected fixture request");
    return new Response(name === "/manifest" ? manifestBytes : archiveBytes);
  };
  await installer.runComponentInstall(context("online-home"), {
    component: "base",
    version: "1.2.3",
    source: {
      kind: "online",
      archiveUrl: "https://fixture.invalid/archive",
      manifestUrl: "https://fixture.invalid/manifest"
    },
    stageOnly: true
  });
  assert.deepEqual(fetched, ["/manifest", "/archive"]);
  await rejectTamper({
    root,
    installer,
    context,
    offline,
    base,
    catalog,
    manifestBytes,
    archiveBytes,
    runtime,
    target
  });
  return {
    kind: "fixture-pin-rehearsal",
    accepted: ["offline", "online-fixture"],
    rejected: ["manifest", "archive", "file", "missing-pins", "wrong-pins"],
    nativeAcceptance: false
  };
};

const rejectTamper = async ({
  root,
  installer,
  context,
  offline,
  base,
  catalog,
  manifestBytes,
  archiveBytes,
  runtime,
  target
}) => {
  globalThis.fetch = async () => {
    throw new Error("offline fixture attempted network");
  };
  writeFileSync(
    base.manifestPath,
    Buffer.concat([manifestBytes, Buffer.from(" ")])
  );
  await assert.rejects(
    installer.runComponentInstall(context("manifest-home"), {
      component: "base",
      source: offline,
      stageOnly: true
    }),
    /canonical|digest/
  );
  writeFileSync(base.manifestPath, manifestBytes);
  writeFileSync(base.archivePath, Buffer.from("corrupt archive"));
  await assert.rejects(
    installer.runComponentInstall(context("archive-home"), {
      component: "base",
      source: offline,
      stageOnly: true
    }),
    /archive|size|hash/
  );
  writeFileSync(base.archivePath, archiveBytes);
  const manifest = await verifyComponent({
    manifestBytes,
    manifestCatalog: catalog,
    archivePath: base.archivePath,
    expectedComponent: "base",
    expectedVersion: "1.2.3",
    target,
    runtime
  });
  const payload = resolve(root, "tampered-payload");
  mkdirSync(payload);
  writeFileSync(resolve(payload, "main.js"), "tampered");
  await assert.rejects(
    verifyExtractedComponent(payload, manifest),
    /hash|size/
  );
  // A re-created archive is not sufficient to authorize changed file bytes.
  writeDeterministicTarGz({ sourceDir: payload, tarPath: base.archivePath });
  await assert.rejects(
    installer.runComponentInstall(context("file-home"), {
      component: "base",
      source: offline,
      stageOnly: true
    }),
    /archive|size|hash/
  );
  writeFileSync(base.archivePath, archiveBytes);
  for (const [label, pins] of [
    ["missing-pins", null],
    [
      "wrong-pins",
      {
        ...catalog,
        entries: catalog.entries.map((entry) => ({
          ...entry,
          manifestSha256: "a".repeat(64)
        }))
      }
    ]
  ]) {
    const isolated = await fixtureInstaller(root, pins, label);
    await assert.rejects(
      isolated.runComponentInstall(context(`${label}-home`), {
        component: "base",
        source: offline,
        stageOnly: true
      }),
      /catalog|pin|digest/i
    );
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runPinRehearsal()
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
