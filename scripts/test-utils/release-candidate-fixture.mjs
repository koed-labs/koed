import { createHash } from "node:crypto";
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
    version: "39.8.10",
    nodeVersion: "22.22.1",
    modulesAbi: "140",
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
                runtimeRange: "=39.8.10",
                nodeRange: "=22.22.1",
                modulesAbi: "140",
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

export const setupCandidate = async ({ desktop = false, payload } = {}) => {
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
  return { ...fixture, contents, expected, input, readers, release };
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
