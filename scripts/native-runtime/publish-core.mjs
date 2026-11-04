#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";
import {
  coreManifestName,
  packageFrozenCore,
  verifyFrozenCore
} from "./core-artifact.mjs";
import { sha256File } from "./manifest-lib.mjs";
import { compareVersions } from "../release-promotion-lib.mjs";
import { verifyWorkflowApproval } from "../release-approval.mjs";

const repository = "koed-labs/koed";
const readJson = (path, maximum = 1024 * 1024) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maximum)
    throw new Error(`Invalid candidate report: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
};

export const readCoreCandidate = (directory) => {
  const root = resolve(directory);
  const manifest = verifyFrozenCore(resolve(root, "koed-runtime"));
  const candidate = readJson(resolve(root, "core-candidate.json"));
  const archive = `koed-native-core-${manifest.recipeId}-linux-x64.tar.gz`;
  const archivePath = resolve(root, archive);
  const manifestPath = resolve(root, "koed-runtime", coreManifestName);
  const policy = readJson(
    new URL("../../config/release-artifact-size-policy.json", import.meta.url)
  );
  const archiveStat = lstatSync(archivePath);
  if (
    !archiveStat.isFile() ||
    archiveStat.nlink !== 1 ||
    !Number.isSafeInteger(policy.nativeCoreArchiveMaximum) ||
    !Number.isSafeInteger(policy.nativeCoreExpandedMaximum) ||
    archiveStat.size <= 0 ||
    archiveStat.size > policy.nativeCoreArchiveMaximum
  )
    throw new Error("Invalid native archive or CPU core size budget.");
  mkdirSync(resolve("scratch"), { recursive: true });
  const repack = mkdtempSync(resolve("scratch/native-publication-"));
  try {
    const expected = packageFrozenCore({
      runtimeRoot: resolve(root, "koed-runtime"),
      outDir: repack
    });
    if (
      canonicalArtifactJson(candidate) !== canonicalArtifactJson(expected) ||
      sha256File(archivePath) !== expected.sha256 ||
      archiveStat.size !== expected.archiveBytes
    )
      throw new Error(
        "Native candidate differs from its frozen archive or manifest."
      );
  } finally {
    rmSync(repack, { recursive: true, force: true });
  }
  const qualification = readJson(resolve(root, "qualification.json"));
  if (
    qualification.ok !== true ||
    qualification.recipeId !== candidate.recipeId ||
    qualification.manifestSha256 !== candidate.manifestSha256 ||
    qualification.cudaExecuted !== false ||
    qualification.modelSha256 !==
      "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439" ||
    JSON.stringify(qualification.launcherPolicies) !== '["auto","cpu"]' ||
    !Number.isSafeInteger(qualification.loaderChecks) ||
    qualification.loaderChecks < 1 ||
    qualification.postgres?.initialized !== true ||
    qualification.postgres.restarted !== true ||
    qualification.postgres.pgvector !== candidate.components.pgvector.version ||
    qualification.postgres.pgcrypto !== true ||
    qualification.embedding?.backend !== "cpu" ||
    qualification.embedding.inputs !== 2 ||
    qualification.embedding.dimensions !== 1024 ||
    qualification.embedding.finite !== true ||
    qualification.embedding.nonzero !== true ||
    qualification.cleanupError ||
    qualification.error
  )
    throw new Error(
      "Exact CPU qualification evidence is missing, incomplete, or failed."
    );
  const paths = [
    archivePath,
    resolve(root, "core-candidate.json"),
    manifestPath,
    resolve(root, "qualification.json")
  ];
  return {
    ...candidate,
    tag: `native-core-${candidate.recipeId}`,
    assets: paths.map((path) => ({
      path,
      name: path.split("/").at(-1),
      bytes: lstatSync(path).size,
      sha256: sha256File(path)
    }))
  };
};

const checkRelease = (release, candidate, commit) => {
  if (
    release.tag_name !== candidate.tag ||
    release.target_commitish !== commit ||
    release.prerelease !== false ||
    !Array.isArray(release.assets) ||
    new Set(release.assets.map((asset) => asset.name)).size !==
      release.assets.length ||
    release.assets.some(
      (asset) =>
        !candidate.assets.some((expected) => expected.name === asset.name)
    )
  )
    throw new Error(
      "Native release identity or asset set conflicts with this candidate."
    );
};

// No delete, overwrite, tag replacement, or edit of a published release exists
// in this adapter. A retry authenticates every retained byte before returning.
export const publishCore = async ({ candidate, commit, client }) => {
  if (!/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw new Error("Provide the reviewed build commit.");
  const releases = await client.listReleases();
  const matches = releases.filter(
    (release) => release.tag_name === candidate.tag
  );
  if (matches.length > 1) throw new Error("Ambiguous native release identity.");
  for (const release of releases.filter(
    (release) =>
      matches[0]?.draft !== false &&
      !release.draft &&
      release.tag_name.startsWith("native-core-") &&
      release.tag_name !== candidate.tag
  )) {
    const version = /^Native CPU core (\d+\.\d+\.\d+)$/.exec(
      release.name ?? ""
    )?.[1];
    if (!version || compareVersions(candidate.runtimeVersion, version) <= 0)
      throw new Error(
        "A new native recipe requires a greater runtime version than all published cores."
      );
  }
  const tagCommit = await client.getTagCommit(candidate.tag);
  if (tagCommit !== null && tagCommit !== commit)
    throw new Error(
      "Existing native tag points to a different commit; never move or delete it."
    );
  let release = matches[0];
  if (!release)
    release = await client.createRelease({
      tag_name: candidate.tag,
      target_commitish: commit,
      name: `Native CPU core ${candidate.runtimeVersion}`,
      body: `Retained Linux x64 CPU runtime. Recipe: ${candidate.recipeId}. Archive SHA-256: ${candidate.sha256}. Do not delete this release, its assets, or its tag.`,
      draft: true,
      prerelease: false,
      make_latest: "false"
    });
  checkRelease(release, candidate, commit);
  const verifyAssets = async (current, allowMissing) => {
    checkRelease(current, candidate, commit);
    for (const expected of candidate.assets) {
      const asset = current.assets.find(
        (asset) => asset.name === expected.name
      );
      if (!asset) {
        if (allowMissing && current.draft) continue;
        throw new Error(`Missing retained native asset: ${expected.name}`);
      }
      if (
        asset.state !== "uploaded" ||
        asset.size !== expected.bytes ||
        (await client.hashAsset(asset.id, expected.bytes)) !== expected.sha256
      )
        throw new Error(
          `Changed native asset; refusing replacement: ${expected.name}`
        );
    }
  };
  await verifyAssets(release, true);
  if (release.draft) {
    for (const asset of candidate.assets)
      if (!release.assets.some((existing) => existing.name === asset.name))
        await client.upload(candidate.tag, asset.path);
    release = await client.getRelease(release.id);
    await verifyAssets(release, false);
    release = await client.publishRelease(release.id, {
      draft: false,
      make_latest: "false"
    });
  }
  await verifyAssets(release, false);
  if (release.draft || (await client.getTagCommit(candidate.tag)) !== commit)
    throw new Error("Native publication or retained tag verification failed.");
  if ((await client.getLatestRelease())?.tag_name === candidate.tag)
    throw new Error(
      "Native release unexpectedly became the latest product release; Operator review is required."
    );
  return {
    tag: candidate.tag,
    releaseId: release.id,
    immutable: release.immutable === true,
    published: true
  };
};

const githubClient = () => {
  const gh = (args, options = {}) =>
    execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options
    });
  const api = (path, body, method) =>
    JSON.parse(
      gh(
        [
          "api",
          `repos/${repository}/${path}`,
          ...(body ? ["--method", method ?? "POST", "--input", "-"] : [])
        ],
        body ? { input: JSON.stringify(body) } : {}
      )
    );
  return {
    listReleases: () =>
      JSON.parse(
        gh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/releases?per_page=100`
        ])
      ).flat(),
    getRelease: (id) => api(`releases/${id}`),
    getTagCommit: (tag) => {
      // matching-refs returns an empty list for an absent tag; permission and
      // network failures remain errors rather than being mistaken for absence.
      const matches = api(`git/matching-refs/tags/${tag}`).filter(
        (ref) => ref.ref === `refs/tags/${tag}`
      );
      if (!matches.length) return null;
      if (matches.length !== 1 || matches[0].object.type !== "commit")
        throw new Error(
          "Native tag must be one retained lightweight commit tag."
        );
      return matches[0].object.sha;
    },
    createRelease: (body) => api("releases", body),
    upload: (tag, path) =>
      gh(["release", "upload", tag, path, "--repo", repository]),
    hashAsset: (id, bytes) =>
      createHash("sha256")
        .update(
          gh(
            [
              "api",
              "--header",
              "Accept: application/octet-stream",
              `repos/${repository}/releases/assets/${id}`
            ],
            { encoding: null, maxBuffer: bytes + 1 }
          )
        )
        .digest("hex"),
    publishRelease: (id, body) => api(`releases/${id}`, body, "PATCH"),
    getLatestRelease: () => api("releases/latest")
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "candidate-dir": { type: "string" },
      publish: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help)
    console.log(
      "Usage: node scripts/native-runtime/publish-core.mjs --candidate-dir <qualified-candidate> [--publish]"
    );
  else {
    if (!values["candidate-dir"]) throw new Error("Provide --candidate-dir.");
    const candidate = readCoreCandidate(values["candidate-dir"]);
    if (!values.publish)
      console.log(JSON.stringify({ validated: true, candidate }, null, 2));
    else {
      if (
        process.env.GITHUB_REPOSITORY !== repository ||
        process.env.GITHUB_REF !== "refs/heads/main"
      )
        throw new Error(
          "Native publication requires the trusted default-branch workflow."
        );
      verifyWorkflowApproval(candidate.runtimeVersion);
      console.log(
        JSON.stringify(
          await publishCore({
            candidate,
            commit: process.env.GITHUB_SHA,
            client: githubClient()
          }),
          null,
          2
        )
      );
    }
  }
}
