import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync
} from "node:fs";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyFrozenComponentAssets } from "./verify-frozen-component-assets.mjs";
import { inspectReleasePackage } from "./inspect-release-package.mjs";
import { validateReviewedRuntimeIdentities } from "./reviewed-build-identity-runtimes.mjs";
import { compareVersions } from "./release-promotion-lib.mjs";
import { verifyPackagedDesktopCatalog } from "../apps/desktop/scripts/verify-packaged-component-catalog.mjs";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
// Chunked so large release assets are never loaded into a single Buffer.
export const hashFileSync = (path, algorithm = "sha256", encoding = "hex") => {
  const hash = createHash(algorithm);
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0; )
      hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest(encoding);
};
const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const fail = (message) => {
  throw new Error(message);
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export const validateReviewedBuildIdentity = (expected) => {
  validateReviewedRuntimeIdentities(expected?.runtimeIdentities);
  if (
    expected?.schemaVersion !== 1 ||
    !/^[\w.-]+\/[\w.-]+$/.test(expected.repository ?? "") ||
    !/^[a-f0-9]{40}$/.test(expected.commit ?? "") ||
    expected.workflowPath !== ".github/workflows/release.yml" ||
    !positive(expected.runId) ||
    !positive(expected.runAttempt) ||
    !versionPattern.test(expected.version ?? "")
  )
    fail("Invalid protected reviewed-build identity.");
  if (
    !Array.isArray(expected.artifacts) ||
    !expected.artifacts.length ||
    new Set(expected.artifacts.map((a) => a.id)).size !==
      expected.artifacts.length
  )
    fail("Missing or duplicate protected build artifact identity.");
  for (const artifact of expected.artifacts)
    if (
      !positive(artifact.id) ||
      typeof artifact.name !== "string" ||
      !artifact.name ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")
    )
      fail("Invalid protected build artifact identity.");
  if (
    !Array.isArray(expected.assets) ||
    !expected.assets.length ||
    new Set(expected.assets.map((a) => a.name)).size !== expected.assets.length
  )
    fail("Missing or duplicate protected asset identity.");
  for (const asset of expected.assets)
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name ?? "") ||
      !digestPattern.test(asset.sha256 ?? "")
    )
      fail("Invalid protected asset identity.");
  if (
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected.npm?.integrity ?? "") ||
    !digestPattern.test(expected.npm?.inventorySha256 ?? "") ||
    !positive(expected.npm?.bytes)
  )
    fail("Invalid protected npm identity.");
  if (
    expected.desktop !== null &&
    (!expected.desktop ||
      !expected.assets.some((a) => a.name === expected.desktop.asset) ||
      expected.desktop.asarEntry !== "Koed.app/Contents/Resources/app.asar")
  )
    fail("Invalid protected Desktop identity.");
  return expected;
};

const verifyBuildOrigin = async (expected, readers) => {
  const run = await readers.getWorkflowRun(expected.repository, expected.runId);
  if (
    run.id !== expected.runId ||
    run.run_attempt !== expected.runAttempt ||
    run.head_sha !== expected.commit ||
    run.path !== expected.workflowPath ||
    run.repository?.full_name !== expected.repository ||
    !["in_progress", "completed"].includes(run.status) ||
    (run.status === "completed" && run.conclusion !== "success")
  )
    fail("Approved workflow run identity mismatch.");
  for (const expectedArtifact of expected.artifacts) {
    const artifact = await readers.getArtifact(
      expected.repository,
      expectedArtifact.id
    );
    if (
      artifact.expired !== false ||
      artifact.id !== expectedArtifact.id ||
      artifact.name !== expectedArtifact.name ||
      artifact.digest !== expectedArtifact.digest ||
      artifact.workflow_run?.id !== expected.runId ||
      artifact.workflow_run?.head_sha !== expected.commit
    )
      fail("Protected build artifact identity mismatch or expired artifact.");
  }
};

export const writeCandidateAsset = async (
  stream,
  path,
  limit = 4 * 1024 ** 3
) => {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    try {
      if (typeof stream.cancel === "function") await stream.cancel();
      else if (typeof stream.destroy === "function") stream.destroy();
      else if (typeof stream.return === "function") await stream.return();
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "Asset open and stream cancellation failed.",
        { cause: cancelError }
      );
    }
    throw error;
  }
  let size = 0;
  try {
    await pipeline(
      stream,
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(
            size > limit
              ? new Error("Candidate reader response exceeds size limit.")
              : null,
            chunk
          );
        }
      }),
      createWriteStream(path, { fd, autoClose: true })
    );
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
};

const downloadCandidate = async (input, expected, readers, root) => {
  const release = await readers.getRelease(
    expected.repository,
    input.releaseId
  );
  if (
    String(release.id) !== String(input.releaseId) ||
    release.draft !== true ||
    release.prerelease !== false ||
    release.tag_name !== `v${expected.version}` ||
    !Array.isArray(release.assets)
  )
    fail("Candidate draft identity mismatch.");
  const assets = new Map();
  const ids = new Set();
  for (const asset of release.assets) {
    if (!positive(asset.id) || assets.has(asset.name) || ids.has(asset.id))
      fail("Duplicate candidate asset identity.");
    assets.set(asset.name, asset);
    ids.add(asset.id);
  }
  if (
    assets.size !== expected.assets.length ||
    [...assets.keys()].some(
      (name) => !expected.assets.some((asset) => asset.name === name)
    )
  )
    fail("Candidate release asset inventory mismatch.");
  for (const asset of expected.assets) {
    const remote = assets.get(asset.name);
    if (!remote) fail(`Missing protected candidate asset: ${asset.name}`);
    const stream = await readers.getAsset(expected.repository, remote.id);
    const path = resolve(root, asset.name);
    await writeCandidateAsset(stream, path);
    if (hashFileSync(path) !== asset.sha256)
      fail(`Candidate asset digest mismatch: ${asset.name}`);
  }
  // Manifest additions cannot hide outside the protected inventory.
  for (const name of assets.keys())
    if (
      /^koed-(base|privacy)-.*\.manifest\.json$/.test(name) &&
      !expected.assets.some((a) => a.name === name)
    )
      fail("Unreviewed component manifest asset.");
  return release;
};

const inspectDesktop = (expected, root, catalogPath) => {
  if (expected.desktop === null) return null;
  const archive = resolve(root, expected.desktop.asset);
  const entry = expected.desktop.asarEntry;
  const listing = execFileSync("unzip", ["-Z1", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  }).split("\n");
  if (listing.filter((name) => name === entry).length !== 1)
    fail("Desktop archive ASAR identity is missing or duplicate.");
  const appPath = resolve(root, "desktop/Koed.app");
  mkdirSync(resolve(appPath, "Contents/Resources"), { recursive: true });
  const asarPath = resolve(appPath, "Contents/Resources/app.asar");
  // Stream the entry to disk; a buffered read caps at maxBuffer (ENOBUFS).
  const asarFd = openSync(asarPath, "wx");
  try {
    execFileSync("unzip", ["-p", archive, entry], {
      stdio: ["ignore", asarFd, "inherit"]
    });
  } finally {
    closeSync(asarFd);
  }
  verifyPackagedDesktopCatalog({
    appPath,
    catalogPath,
    version: expected.version
  });
  return {
    asset: expected.desktop.asset,
    asarSha256: hashFileSync(asarPath),
    catalogVerified: true
  };
};

/** Evidence only. Readers expose GETs, never a shell, signer or mutation capability. */
export const verifyReleaseCandidate = async (input, readers) => {
  const original = JSON.stringify(input);
  const snapshot = structuredClone(input);
  const expected = validateReviewedBuildIdentity(snapshot.expected);
  for (const field of [
    "repository",
    "commit",
    "runId",
    "runAttempt",
    "version"
  ])
    if (snapshot[field] !== expected[field])
      fail(`Protected candidate identity mismatch: ${field}`);
  if (!positive(Number(snapshot.releaseId)))
    fail("Invalid candidate release identity.");
  await verifyBuildOrigin(expected, readers);
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/release-candidate-"));
  try {
    const release = await downloadCandidate(snapshot, expected, readers, root);
    const catalogPath = resolve(root, "component-manifest-hashes.json");
    await verifyFrozenComponentAssets({
      assetsDir: root,
      catalogPath,
      version: expected.version,
      runtimeIdentities: expected.runtimeIdentities
    });
    const identity = JSON.parse(
      readFileSync(
        resolve(root, "koed-labs-server-release-identity.json"),
        "utf8"
      )
    );
    if (
      identity.packageName !== "@koed-labs/server" ||
      identity.version !== expected.version ||
      JSON.stringify(identity.npm) !== JSON.stringify(expected.npm)
    )
      fail("npm release identity mismatch.");
    const npm = inspectReleasePackage({
      bytes: readFileSync(resolve(root, "koed-labs-server.tgz")),
      expected: expected.npm,
      version: expected.version,
      root: resolve(root, "package"),
      catalogPath
    });
    const desktop = inspectDesktop(expected, root, catalogPath);
    const registry = await readers.getRegistryVersion(
      "@koed-labs/server",
      expected.version
    );
    if (
      registry &&
      (registry.name !== "@koed-labs/server" ||
        registry.version !== expected.version ||
        registry.dist?.integrity !== npm.integrity)
    )
      fail("npm candidate registry identity/integrity mismatch.");
    const latest = await readers.getRegistryVersion(
      "@koed-labs/server",
      "latest"
    );
    if (
      latest &&
      (!versionPattern.test(latest.version ?? "") ||
        compareVersions(latest.version, expected.version) > 0)
    )
      fail("Refusing npm latest downgrade or invalid registry version.");
    if (JSON.stringify(input) !== original)
      fail("Protected build identity changed during verification.");
    return {
      kind: "verified-release-candidate",
      runtimeIdentities: structuredClone(expected.runtimeIdentities),
      repository: expected.repository,
      commit: expected.commit,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      version: expected.version,
      releaseId: snapshot.releaseId,
      assets: expected.assets.map((asset) => ({
        ...asset,
        id: release.assets.find((a) => a.name === asset.name).id
      })),
      components: 4,
      npm,
      desktop,
      registry: registry ? "verified" : "unpublished"
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
