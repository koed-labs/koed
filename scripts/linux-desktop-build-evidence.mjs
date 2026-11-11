import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
// Cyclic with the verifier; only used at call time, never during evaluation.
import { hashFileSync } from "./release-candidate-verification.mjs";

// Trust model (ADR 0068): the reviewed release build extracts the ASAR from the
// final AppImage it just produced and verifies its catalog. Candidate
// verification never parses or executes the AppImage; it binds this evidence to
// the exact candidate bytes by hash.
export const linuxEvidenceName = "koed-desktop-linux-x64.evidence.json";
export const linuxChecksumName = "koed-desktop-linux-x64.sha256";
export const linuxAsarEntry = "resources/app.asar";
export const linuxAppImageName = (version) => `Koed-${version}-x86_64.AppImage`;

const digest = /^[a-f0-9]{64}$/;
const maxEvidenceBytes = 64 * 1024;
const evidenceKind = "koed-linux-desktop-build-evidence";
const topKeys = [
  "schemaVersion",
  "kind",
  "trust",
  "repository",
  "commit",
  "runId",
  "runAttempt",
  "version",
  "appImage",
  "asar",
  "catalogSha256",
  "catalogVerified"
];
const fail = (message) => {
  throw new Error(`Linux Desktop build evidence: ${message}`);
};
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export const serializeLinuxDesktopEvidence = (evidence) =>
  `${JSON.stringify(evidence, null, 2)}\n`;

export const buildLinuxDesktopEvidence = ({
  repository,
  commit,
  runId,
  runAttempt,
  version,
  appImageSha256,
  asarSha256,
  catalogSha256
}) => ({
  schemaVersion: 1,
  kind: evidenceKind,
  trust: "reviewed-build-extraction",
  repository,
  commit,
  runId,
  runAttempt,
  version,
  appImage: { name: linuxAppImageName(version), sha256: appImageSha256 },
  asar: { entry: linuxAsarEntry, sha256: asarSha256 },
  catalogSha256,
  catalogVerified: true
});

/**
 * Validate evidence against the protected identity and candidate files.
 * Reads only the evidence, checksum and catalog; the AppImage was already
 * hash-matched to the protected identity during download.
 */
export const verifyLinuxDesktopEvidence = ({
  expected,
  evidencePath,
  checksumPath,
  catalogPath
}) => {
  const linux = expected.linuxDesktop;
  const appImage = expected.assets.find((a) => a.name === linux.asset);
  if (!appImage) fail("protected AppImage identity missing.");
  if (statSync(evidencePath).size > maxEvidenceBytes) fail("file too large.");
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch {
    fail("not valid JSON.");
  }
  if (
    !exactKeys(evidence, topKeys) ||
    !exactKeys(evidence.appImage, ["name", "sha256"]) ||
    !exactKeys(evidence.asar, ["entry", "sha256"])
  )
    fail("unexpected shape.");
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== evidenceKind ||
    evidence.trust !== "reviewed-build-extraction" ||
    evidence.catalogVerified !== true
  )
    fail("unsupported schema or unverified catalog.");
  if (
    evidence.repository !== expected.repository ||
    evidence.commit !== expected.commit ||
    evidence.runId !== expected.runId ||
    evidence.version !== expected.version ||
    !positive(evidence.runAttempt) ||
    evidence.runAttempt > expected.runAttempt
  )
    fail("reviewed build identity mismatch.");
  if (
    evidence.appImage.name !== linux.asset ||
    evidence.appImage.sha256 !== appImage.sha256
  )
    fail("AppImage bytes do not match the reviewed build.");
  if (
    evidence.asar.entry !== linux.asarEntry ||
    !digest.test(evidence.asar.sha256 ?? "")
  )
    fail("invalid ASAR identity.");
  if (evidence.catalogSha256 !== hashFileSync(catalogPath))
    fail("component catalog mismatch.");
  if (statSync(checksumPath).size > 256) fail("checksum file too large.");
  if (
    readFileSync(checksumPath, "utf8") !==
    `${appImage.sha256}  ${linux.asset}\n`
  )
    fail("checksum file does not match the AppImage.");
  return {
    asset: linux.asset,
    appImageSha256: appImage.sha256,
    asarSha256: evidence.asar.sha256,
    catalogVerified: true,
    trust: evidence.trust
  };
};

// Runs only inside the reviewed release build on its own freshly built output.
export const writeLinuxDesktopEvidence = async ({
  releaseDirectory,
  catalogPath,
  version,
  repository,
  commit,
  runId,
  runAttempt
}) => {
  const { withExtractedAppImage } =
    await import("../apps/desktop/scripts/smoke-packaged-desktop-app-lib.mjs");
  const { verifyPackagedAsarCatalog } =
    await import("../apps/desktop/scripts/verify-packaged-component-catalog.mjs");
  const imagePath = resolve(releaseDirectory, linuxAppImageName(version));
  const appImageSha256 = hashFileSync(imagePath);
  const asarSha256 = await withExtractedAppImage(imagePath, async (root) => {
    const asarPath = resolve(root, linuxAsarEntry);
    if (!statSync(asarPath).isFile()) fail("extracted ASAR is not a file.");
    verifyPackagedAsarCatalog({ asarPath, catalogPath, version });
    return hashFileSync(asarPath);
  });
  if (hashFileSync(imagePath) !== appImageSha256)
    fail("AppImage changed during evidence capture.");
  const evidence = buildLinuxDesktopEvidence({
    repository,
    commit,
    runId,
    runAttempt,
    version,
    appImageSha256,
    asarSha256,
    catalogSha256: hashFileSync(catalogPath)
  });
  writeFileSync(
    resolve(releaseDirectory, linuxEvidenceName),
    serializeLinuxDesktopEvidence(evidence),
    { flag: "wx" }
  );
  return evidence;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [releaseDirectory, catalogPath, version, ...extra] =
    process.argv.slice(2);
  const env = process.env;
  if (!releaseDirectory || !catalogPath || !version || extra.length)
    throw new Error(
      "Usage: node scripts/linux-desktop-build-evidence.mjs <release-dir> <catalog> <version>"
    );
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    !env.GITHUB_REPOSITORY ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !positive(runId) ||
    !positive(runAttempt)
  )
    throw new Error("GitHub run identity is required for build evidence.");
  const evidence = await writeLinuxDesktopEvidence({
    releaseDirectory,
    catalogPath,
    version,
    repository: env.GITHUB_REPOSITORY,
    commit: env.GITHUB_SHA,
    runId,
    runAttempt
  });
  process.stdout.write(serializeLinuxDesktopEvidence(evidence));
}
