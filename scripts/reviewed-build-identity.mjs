import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sha256,
  validateReviewedBuildIdentity
} from "./release-candidate-verification.mjs";

import { reviewedRuntimeIdentities } from "./reviewed-build-identity-runtimes.mjs";

const sourceNames = [
  "koed-component-catalog",
  "koed-server-app-runtime-linux-x64",
  "koed-server-app-runtime-macos-arm64",
  "koed-desktop-final-assets",
  "koed-native-runtime-linux-x64",
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
        const digest = sha256(readFileSync(path));
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
  const assets = collectReviewedAssets(root);
  const find = (name) => {
    const paths = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === name && entry.isFile()) paths.push(path);
      }
    };
    walk(resolve(root));
    if (!paths.length) throw new Error(`Missing reviewed output: ${name}`);
    return readFileSync(paths[0], "utf8");
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
