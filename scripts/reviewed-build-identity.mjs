import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sha256,
  hashFileSync,
  validateReviewedBuildIdentity
} from "./release-candidate-verification.mjs";

import { reviewedRuntimeIdentities } from "./reviewed-build-identity-runtimes.mjs";
import {
  linuxAppImageName,
  linuxAsarEntry,
  linuxChecksumName,
  linuxEvidenceName
} from "./linux-desktop-build-evidence.mjs";

const sourceNames = [
  "koed-component-catalog",
  "koed-server-app-runtime-linux-x64",
  "koed-server-app-runtime-macos-arm64",
  "koed-desktop-final-assets",
  "koed-desktop-linux-final-assets",
  "koed-native-runtime-linux-x64",
  "koed-linux-native-packages",
  "koed-release-metadata"
];

export const collectReviewedAssets = (root) => {
  const found = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        if (!entry.isFile())
          throw new Error("Reviewed outputs require regular files.");
        const digest = hashFileSync(path);
        if (found.has(entry.name) && found.get(entry.name) !== digest)
          throw new Error(`Conflicting reviewed output: ${entry.name}`);
        found.set(entry.name, digest);
      }
    }
  };
  walk(resolve(root));
  return [...found]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, digest]) => ({ name, sha256: digest }));
};

// The catalog artifact also contains recursively staged component trees; only
// its catalog is uploaded. All other selected artifacts are release staging dirs.
export const collectPublicReleaseAssets = (root) => {
  const found = new Map();
  for (const source of sourceNames) {
    const directory = resolve(root, source);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        source === "koed-component-catalog" &&
        entry.name !== "component-manifest-hashes.json"
      )
        continue;
      if (!entry.isFile())
        throw new Error(
          `Unexpected nested release output: ${source}/${entry.name}`
        );
      const digest = hashFileSync(resolve(directory, entry.name));
      if (found.has(entry.name) && found.get(entry.name) !== digest)
        throw new Error(`Conflicting reviewed output: ${entry.name}`);
      found.set(entry.name, digest);
    }
  }
  return [...found]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, digest]) => ({ name, sha256: digest }));
};

export const createReviewedBuildIdentity = ({
  root,
  artifacts,
  repository,
  commit,
  runId,
  runAttempt,
  version
}) => {
  const selected = sourceNames.map((name) => {
    const matches = artifacts.filter(
      (artifact) =>
        artifact.name === name &&
        artifact.expired === false &&
        artifact.workflow_run?.id === runId &&
        artifact.workflow_run?.head_sha === commit
    );
    if (matches.length !== 1)
      throw new Error(`Missing/duplicate approved build artifact: ${name}`);
    const { id, digest } = matches[0];
    return { id, name, digest };
  });
  const assets = collectPublicReleaseAssets(root);
  const find = (name) => {
    if (!assets.some((asset) => asset.name === name))
      throw new Error(`Missing reviewed output: ${name}`);
    const source = sourceNames.find((source) =>
      readdirSync(resolve(root, source), { withFileTypes: true }).some(
        (entry) =>
          entry.isFile() &&
          entry.name === name &&
          (source !== "koed-component-catalog" ||
            name === "component-manifest-hashes.json")
      )
    );
    return readFileSync(resolve(root, source, name), "utf8");
  };
  const identity = JSON.parse(find("koed-labs-server-release-identity.json"));
  if (
    identity.packageName !== "@koed-labs/server" ||
    identity.version !== version
  )
    throw new Error("Reviewed npm identity mismatch.");
  const desktop = assets.filter((asset) =>
    /^Koed-.*-arm64\.zip$/.test(asset.name)
  );
  if (desktop.length !== 1)
    throw new Error("One final Desktop ZIP is required.");
  const images = assets.filter((asset) =>
    /^Koed-.*-x86_64\.AppImage$/.test(asset.name)
  );
  if (
    images.length !== 1 ||
    images[0].name !== linuxAppImageName(version) ||
    !assets.some((asset) => asset.name === linuxChecksumName) ||
    !assets.some((asset) => asset.name === linuxEvidenceName)
  )
    throw new Error(
      "One version-matched Linux AppImage, checksum and build evidence are required."
    );
  const linuxFiles = readdirSync(
    resolve(root, "koed-desktop-linux-final-assets")
  );
  if (
    [images[0].name, linuxChecksumName, linuxEvidenceName].some(
      (name) => !linuxFiles.includes(name)
    )
  )
    throw new Error(
      "Linux AppImage, checksum and build evidence must belong to the final artifact."
    );
  return validateReviewedBuildIdentity({
    schemaVersion: 1,
    repository,
    commit,
    workflowPath: ".github/workflows/release.yml",
    runId,
    runAttempt,
    version,
    artifacts: selected,
    assets,
    npm: identity.npm,
    runtimeIdentities: reviewedRuntimeIdentities(),
    desktop: {
      asset: desktop[0].name,
      asarEntry: "Koed.app/Contents/Resources/app.asar"
    },
    linuxDesktop: {
      asset: images[0].name,
      checksum: linuxChecksumName,
      evidence: linuxEvidenceName,
      asarEntry: linuxAsarEntry
    }
  });
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [root, artifactsPath, output, version, ...extra] =
    process.argv.slice(2);
  if (!root || !artifactsPath || !output || !version || extra.length)
    throw new Error(
      "Usage: reviewed-build-identity.mjs <build-outputs> <artifacts-json> <output> <version>"
    );
  const identity = createReviewedBuildIdentity({
    root,
    artifacts: JSON.parse(readFileSync(artifactsPath, "utf8")).artifacts,
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.GITHUB_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    version
  });
  const bytes = Buffer.from(`${JSON.stringify(identity)}\n`);
  writeFileSync(output, bytes, { flag: "wx" });
  console.log(sha256(bytes));
}
