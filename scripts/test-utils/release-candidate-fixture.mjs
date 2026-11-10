import { createHash } from "node:crypto";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildComponentReleaseSet } from "../component-release-lib.mjs";
import {
  writeComponentManifestCatalog,
  requiredComponentIdentities
} from "../component-manifest-catalog.mjs";
import { writeDeterministicTarGz } from "../deterministic-tar-gzip.mjs";
import { createPackageReleaseIdentity } from "../package-release-identity.mjs";
import { createAsarFixture } from "./create-asar-fixture.mjs";
import { writeControlPlaneLauncher } from "../control-plane-bundle.mjs";
import {
  renderReleaseServerInstaller,
  serverInstallerAssetName
} from "../render-server-installer.mjs";

export const runtimeIdentities = [
  {
    kind: "node",
    version: "24.13.1",
    nodeVersion: "24.13.1",
    modulesAbi: "137",
    napiVersion: 10,
    platform: "linux",
    architecture: "x64",
    libcVersion: "2.35"
  },
  {
    kind: "node",
    version: "24.13.1",
    nodeVersion: "24.13.1",
    modulesAbi: "137",
    napiVersion: 10,
    platform: "macos",
    architecture: "arm64"
  },
  {
    kind: "electron",
    version: "45.2.3",
    nodeVersion: "24.22.2",
    modulesAbi: "150",
    napiVersion: 10,
    platform: "macos",
    architecture: "arm64"
  }
];
const { createPackage } = createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url)
)("@electron/asar");
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const candidateFixture = ({
  payload = "export {};\n",
  runtimes
} = {}) => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/candidate-test-"));
  const assetsDir = resolve(root, "assets");
  const componentsRoot = resolve(root, "components");
  for (const component of ["base", "privacy", "privacy-cpu"]) {
    mkdirSync(resolve(componentsRoot, component), { recursive: true });
    writeFileSync(resolve(componentsRoot, component, "main.js"), payload);
  }
  for (const target of [
    requiredComponentIdentities[0].target,
    requiredComponentIdentities.find(
      (entry) => entry.target.platform === "macos"
    ).target
  ])
    buildComponentReleaseSet({
      componentsRoot,
      outDir: assetsDir,
      version: "1.2.3",
      target,
      runtimes: runtimes ?? [
        {
          kind: "node",
          runtimeRange: ">=24 <25",
          nodeRange: ">=24 <25",
          modulesAbi: "137"
        },
        ...(target.platform === "macos"
          ? [
              {
                kind: "electron",
                runtimeRange: "=45.2.3",
                nodeRange: "=24.22.2",
                modulesAbi: "150",
                minimumNapi: 10
              }
            ]
          : [])
      ],
      requiredFiles: { base: ["main.js"], privacy: ["main.js"] }
    });
  const catalog = writeComponentManifestCatalog({
    manifestsDir: assetsDir,
    outputPath: resolve(assetsDir, "component-manifest-hashes.json"),
    version: "1.2.3"
  });
  const packageRoot = resolve(root, "package");
  mkdirSync(resolve(packageRoot, "vendor"), { recursive: true });
  mkdirSync(resolve(packageRoot, "bin"));
  mkdirSync(resolve(packageRoot, "dist"));
  writeFileSync(
    resolve(packageRoot, "package.json"),
    JSON.stringify({
      name: "@koed-labs/server",
      version: "1.2.3",
      bin: { koed: "bin/koed.js" },
      type: "module"
    })
  );
  writeControlPlaneLauncher(
    resolve(packageRoot, "bin/koed.js"),
    "../vendor/control-plane.js"
  );
  writeFileSync(
    resolve(packageRoot, "vendor/control-plane.js"),
    `throw new Error('CANDIDATE_EXECUTED');
export const productionComponentManifestCatalog = ${JSON.stringify(catalog)};
export const productionNativeRuntimeCatalog = null;
function validateManifestCatalog(value) { return value; }
function verifyComponent(options) { return options; }
export function runKoedServerCli(args) {
  const catalog = validateManifestCatalog(productionComponentManifestCatalog);
  return verifyComponent({ manifestCatalog: catalog });
}
export function shouldExitPackagedSupervisor(args) { return false; }`
  );
  const tarball = resolve(assetsDir, "koed-labs-server.tgz");
  writeDeterministicTarGz({
    sourceDir: packageRoot,
    tarPath: tarball,
    rootName: "package"
  });
  const identity = createPackageReleaseIdentity({
    packageRoot,
    tarball,
    version: "1.2.3"
  });
  writeFileSync(
    resolve(assetsDir, "koed-labs-server-release-identity.json"),
    JSON.stringify(identity)
  );
  return {
    root,
    assetsDir,
    catalog,
    identity,
    packageRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
};

export const addDesktopFixture = async (
  fixture,
  { stalePins = false } = {}
) => {
  const source = resolve(fixture.root, "asar-source");
  const dist = resolve(source, "node_modules/@koed-labs/server/dist");
  mkdirSync(dist, { recursive: true });
  copyFileSync(
    "packages/koed-server/dist/component-manifest-catalog.js",
    resolve(dist, "component-manifest-catalog.js")
  );
  writeFileSync(
    resolve(dist, "component-manifest-catalog-data.js"),
    `import { validateManifestCatalog } from './component-manifest-catalog.js'; export const productionComponentManifestCatalog = validateManifestCatalog(${stalePins ? "null" : JSON.stringify(fixture.catalog)});`
  );
  writeFileSync(
    resolve(dist, "component-store.js"),
    'import { productionComponentManifestCatalog } from "./component-manifest-catalog-data.js"; import { validateManifestCatalog } from "./component-manifest-catalog.js"; export const verify = () => validateManifestCatalog(productionComponentManifestCatalog);'
  );
  const resources = resolve(
    fixture.root,
    "desktop/Koed.app/Contents/Resources"
  );
  mkdirSync(resources, { recursive: true });
  await createAsarFixture(
    createPackage,
    source,
    resolve(resources, "app.asar")
  );
  const asset = "Koed-1.2.3-arm64.zip";
  rmSync(resolve(fixture.assetsDir, asset), { force: true });
  execFileSync("zip", ["-qr", resolve(fixture.assetsDir, asset), "Koed.app"], {
    cwd: resolve(fixture.root, "desktop")
  });
  return { asset, asarEntry: "Koed.app/Contents/Resources/app.asar" };
};

export const setupCandidate = async ({
  desktop = false,
  payload,
  native = false,
  nativePayload = "safe",
  nativeArchivePayload = nativePayload
} = {}) => {
  const fixture = candidateFixture({ payload });
  const desktopIdentity = desktop ? await addDesktopFixture(fixture) : null;
  const contents = new Map(
    readdirSync(fixture.assetsDir).map((name) => [
      name,
      readFileSync(resolve(fixture.assetsDir, name))
    ])
  );
  const expected = {
    schemaVersion: 1,
    repository: "org/repo",
    commit: "a".repeat(40),
    workflowPath: ".github/workflows/release.yml",
    runId: 42,
    runAttempt: 1,
    version: "1.2.3",
    artifacts: [{ id: 3, name: "frozen", digest: `sha256:${"b".repeat(64)}` }],
    assets: [...contents].map(([name, bytes]) => ({
      name,
      sha256: hash(bytes)
    })),
    npm: fixture.identity.npm,
    runtimeIdentities: structuredClone(runtimeIdentities),
    desktop: desktopIdentity
  };
  const input = {
    repository: expected.repository,
    commit: expected.commit,
    runId: 42,
    runAttempt: 1,
    version: "1.2.3",
    releaseId: 7,
    expected
  };
  const release = {
    id: 7,
    tag_name: "v1.2.3",
    draft: true,
    prerelease: false,
    assets: [...contents.keys()].map((name, i) => ({ id: i + 10, name }))
  };
  const readers = {
    getWorkflowRun: async () => ({
      id: 42,
      run_attempt: 1,
      head_sha: expected.commit,
      path: expected.workflowPath,
      repository: { full_name: "org/repo" },
      status: "in_progress"
    }),
    getArtifact: async (_repo, id) =>
      id === 99
        ? {
            id: 99,
            name: "koed-reviewed-release-identity",
            digest: `sha256:${"d".repeat(64)}`,
            expired: false,
            workflow_run: { id: 42, head_sha: expected.commit }
          }
        : {
            id: 3,
            name: "frozen",
            digest: `sha256:${"b".repeat(64)}`,
            expired: false,
            workflow_run: { id: 42, head_sha: expected.commit }
          },
    getRelease: async () => structuredClone(release),
    getAsset: async (_repo, id) =>
      (async function* () {
        yield Buffer.from(
          contents.get(release.assets.find((asset) => asset.id === id).name)
        );
      })(),
    getRegistryVersion: async (_name, version) =>
      version === "latest"
        ? null
        : {
            name: "@koed-labs/server",
            version: "1.2.3",
            dist: { integrity: fixture.identity.npm.integrity }
          }
  };
  const result = { ...fixture, contents, expected, input, readers, release };
  if (native) addNativeFixture(result, nativePayload, nativeArchivePayload);
  return result;
};

// Rehash candidate-controlled bytes so rejection exercises package inspection,
// not an earlier digest mismatch. Never execute or import package code.
export const refreshCandidatePackage = (fixture) => {
  const tarball = resolve(fixture.assetsDir, "koed-labs-server.tgz");
  writeDeterministicTarGz({
    sourceDir: fixture.packageRoot,
    tarPath: tarball,
    rootName: "package"
  });
  const identity = createPackageReleaseIdentity({
    packageRoot: fixture.packageRoot,
    tarball,
    version: "1.2.3"
  });
  fixture.expected.npm = identity.npm;
  fixture.readers.getRegistryVersion = async () => null;
  fixture.contents.set("koed-labs-server.tgz", readFileSync(tarball));
  fixture.contents.set(
    "koed-labs-server-release-identity.json",
    Buffer.from(JSON.stringify(identity))
  );
  fixture.expected.assets = [...fixture.contents].map(([name, bytes]) => ({
    name,
    sha256: hash(bytes)
  }));
};

const makeNativeFixturePin = (fixture, kind, platform) => {
  const components = {
    postgres: { major: 17, version: "17.6" },
    pgvector: { version: "0.8.3" },
    llamaCpp: { version: "b10514", revision: "a".repeat(40) }
  };
  const recipe = { kind, platform, fixture: true };
  const recipeId = hash(canonicalArtifactJson(recipe));
  const target =
    platform === "linux-x64"
      ? {
          platform: "linux",
          architecture: "x64",
          libc: { family: "glibc", minimumVersion: "2.35" }
        }
      : { platform: "macos", architecture: "arm64", minimumVersion: "14.0" };
  const coreComponents =
    platform === "macos-arm64"
      ? { ...components, llamaCpp: { version: "b10514" } }
      : components;
  const shared = {
    recipeId,
    runtimeVersion: "1.1.0",
    target,
    contracts:
      kind === "core"
        ? { layout: 1, postgres: 1, embedding: 1 }
        : { layout: 1, embedding: 1 },
    ...(kind === "core"
      ? { components: coreComponents }
      : {
          llamaCpp: components.llamaCpp,
          cuda: {
            toolkitVersion: "12.4",
            minimumDriverLinux: "550.54.14",
            architectures: [89]
          }
        })
  };
  return writeNativeFixturePin(fixture, kind, platform, recipe, shared);
};

const writeNativeFixturePin = (fixture, kind, platform, recipe, shared) => {
  const { recipeId } = shared;
  const manifest = Buffer.from(
    canonicalArtifactJson({
      ...shared,
      kind,
      schemaVersion: 1,
      recipe,
      inventory: []
    })
  );
  const archive = Buffer.from(`synthetic ${kind} ${platform}`);
  const name = `koed-native-${kind}-${recipeId}-${platform}.tar.gz`;
  const manifestName =
    platform === "macos-arm64"
      ? "native-core-manifest-macos-arm64.json"
      : `native-${kind}-manifest.json`;
  fixture.contents.set(name, archive);
  fixture.contents.set(manifestName, manifest);
  return {
    ...shared,
    url: `https://github.com/koed-labs/koed/releases/download/v1.2.3/${name}`,
    sha256: hash(archive),
    archiveBytes: archive.length,
    manifestSha256: hash(manifest),
    expandedBytes: manifest.length
  };
};

const addApprovedMacosFixture = (
  fixture,
  pin,
  nativePayload,
  nativeArchivePayload
) => {
  const tree = resolve(fixture.root, "approved-macos-tree");
  const evidence = resolve(fixture.root, "approved-evidence");
  mkdirSync(tree);
  mkdirSync(evidence);
  const inventory = [
    {
      path: "file",
      type: "file",
      mode: 0o644,
      bytes: Buffer.byteLength(nativePayload),
      sha256: hash(nativePayload)
    },
    {
      path: "provenance.json",
      type: "file",
      mode: 0o644,
      bytes: 1,
      sha256: hash("p")
    }
  ];
  const approved = hash(canonicalArtifactJson(inventory));
  const payload = inventory.slice(0, 1);
  const recipe = {
    kind: "core",
    platform: "macos-arm64",
    fixture: true,
    approvedDesktopInventorySha256: approved,
    frozenInventorySha256: hash(canonicalArtifactJson(payload))
  };
  const recipeId = hash(canonicalArtifactJson(recipe));
  const manifest = Buffer.from(
    `${canonicalArtifactJson({
      schemaVersion: 1,
      kind: "core",
      recipe,
      recipeId,
      inventory: payload,
      runtimeVersion: pin.runtimeVersion,
      target: pin.target,
      contracts: pin.contracts,
      components: pin.components
    })}\n`
  );
  writeFileSync(resolve(tree, "file"), nativeArchivePayload, { mode: 0o644 });
  writeFileSync(resolve(tree, "native-core-manifest.json"), manifest, {
    mode: 0o644
  });
  const archivePath = resolve(fixture.root, "macos-core.tar.gz");
  writeDeterministicTarGz({
    sourceDir: tree,
    rootName: "koed-runtime",
    tarPath: archivePath
  });
  const archive = readFileSync(archivePath);
  const name = `koed-native-core-${recipeId}-macos-arm64.tar.gz`;
  for (const name of [...fixture.contents.keys()])
    if (/^koed-native-core-.*-macos-arm64\.tar\.gz$/.test(name))
      fixture.contents.delete(name);
  fixture.contents.set(name, archive);
  fixture.contents.set("native-core-manifest-macos-arm64.json", manifest);
  writeFileSync(
    resolve(evidence, "approved-macos-inventory.json"),
    `${canonicalArtifactJson(inventory)}\n`
  );
  writeFileSync(
    resolve(evidence, "koed-native-runtime-macos-arm64-1.2.3.tar.gz"),
    "frozen"
  );
  execFileSync(
    "zip",
    [
      "-q",
      "artifact.zip",
      "approved-macos-inventory.json",
      "koed-native-runtime-macos-arm64-1.2.3.tar.gz"
    ],
    { cwd: evidence }
  );
  const zip = readFileSync(resolve(evidence, "artifact.zip"));
  const artifact = {
    id: 4,
    name: "koed-private-frozen-macos-native-runtime",
    digest: `sha256:${hash(zip)}`
  };
  fixture.expected.artifacts.push(artifact);
  const getArtifact = fixture.readers.getArtifact;
  fixture.readers.getArtifact = async (repository, id) =>
    id === 4
      ? {
          ...artifact,
          expired: false,
          workflow_run: { id: 42, head_sha: fixture.expected.commit }
        }
      : getArtifact(repository, id);
  fixture.readers.getArtifactArchive = async (repository, id) => {
    if (repository !== "org/repo" || id !== 4)
      throw new Error("Unexpected artifact request");
    return (async function* () {
      yield zip;
    })();
  };
  return {
    ...pin,
    recipeId,
    url: `https://github.com/koed-labs/koed/releases/download/v1.2.3/${name}`,
    sha256: hash(archive),
    archiveBytes: archive.length,
    manifestSha256: hash(manifest),
    expandedBytes: manifest.length + Buffer.byteLength(nativePayload)
  };
};

const addNativeFixture = (fixture, nativePayload, nativeArchivePayload) => {
  const catalog = {
    schemaVersion: 2,
    linux: {
      schemaVersion: 1,
      minimumCoreVersion: "1.0.0",
      core: makeNativeFixturePin(fixture, "core", "linux-x64"),
      cuda: makeNativeFixturePin(fixture, "cuda", "linux-x64")
    },
    macos: {
      schemaVersion: 1,
      minimumCoreVersion: "1.0.0",
      core: makeNativeFixturePin(fixture, "core", "macos-arm64"),
      cuda: null
    }
  };
  catalog.macos.core = addApprovedMacosFixture(
    fixture,
    catalog.macos.core,
    nativePayload,
    nativeArchivePayload
  );
  fixture.contents.set(
    "native-runtime-catalog.json",
    Buffer.from(JSON.stringify(catalog))
  );
  fixture.contents.set(
    serverInstallerAssetName,
    Buffer.from(renderReleaseServerInstaller("1.2.3"))
  );
  const entry = resolve(fixture.packageRoot, "vendor/control-plane.js");
  writeFileSync(
    entry,
    readFileSync(entry, "utf8").replace(
      "export const productionNativeRuntimeCatalog = null;",
      `export const productionNativeRuntimeCatalog = ${JSON.stringify(catalog)};`
    )
  );
  refreshCandidatePackage(fixture);
  fixture.identity = JSON.parse(
    fixture.contents.get("koed-labs-server-release-identity.json")
  );
  fixture.readers.getRegistryVersion = async (_name, version) =>
    version === "latest"
      ? null
      : {
          name: "@koed-labs/server",
          version: "1.2.3",
          dist: { integrity: fixture.identity.npm.integrity }
        };
  fixture.release.assets = [...fixture.contents.keys()].map((name, index) => ({
    id: index + 10,
    name
  }));
};

export const verificationArgs = (fixture) => {
  const bytes = Buffer.from(JSON.stringify(fixture.expected));
  const path = resolve(fixture.root, "reviewed-build.json");
  writeFileSync(path, bytes);
  return {
    expectedBuild: path,
    expectedBuildSha256: hash(bytes),
    identityArtifactId: 99,
    identityArtifactDigest: `sha256:${"d".repeat(64)}`,
    reviewedCommit: fixture.expected.commit,
    approvedRunId: 42,
    approvedRunAttempt: 1,
    repository: "org/repo",
    releaseId: 7,
    version: "1.2.3"
  };
};
