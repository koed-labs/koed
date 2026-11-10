#!/usr/bin/env node
import { runReleaseVerification } from "./release-candidate-readers.mjs";
import { verifyWorkflowApproval } from "./release-approval.mjs";
import { hashFileSync } from "./release-candidate-verification.mjs";
import { verifyFrozenComponentAssets } from "./verify-frozen-component-assets.mjs";
import { requiredComponentIdentities } from "./component-manifest-catalog.mjs";
import { verifyPackagedControlPlaneCatalog } from "./verify-packaged-control-plane-catalog.mjs";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  openSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  candidateNpmTag,
  compareVersions,
  planReleasePromotion
} from "./release-promotion-lib.mjs";

import { canonicalArtifactJson } from "../packages/koed-server/src/artifact-canonical-json.mjs";

export const canonicalReleaseJson = canonicalArtifactJson;

export const verifyNpmCandidate = async (expected, loadRegistryVersion) => {
  const actual = await loadRegistryVersion(
    expected.packageName,
    expected.version
  );
  if (!actual)
    throw new Error("npm candidate version is missing from registry.");
  if (
    actual.name !== expected.packageName ||
    actual.version !== expected.version
  )
    throw new Error("npm registry package or version mismatch.");
  if (actual.dist?.integrity !== expected.integrity)
    throw new Error("npm registry integrity mismatch.");
  return { verified: true };
};

const pollRegistry = async (read, check, options = {}) => {
  const {
    attempts = Infinity,
    timeoutMs = 300000,
    now = () => performance.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    initialDelayMs = 1000,
    maxDelayMs = 10000
  } = options;
  const deadline = now() + timeoutMs;
  let delay = initialDelayMs;
  let lastError;
  for (let attempt = 0; attempt < attempts && now() < deadline; attempt++) {
    let actual;
    try {
      actual = await read(Math.max(1, Math.floor(deadline - now())));
    } catch (error) {
      if (!error?.transient || attempt + 1 === attempts) throw error;
      lastError = error;
    }
    if (actual) {
      lastError = undefined;
      if (now() < deadline && (await check(actual)) && now() < deadline) return;
    }
    const remaining = deadline - now();
    if (attempt + 1 < attempts && remaining > 0)
      await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, maxDelayMs);
  }
  if (lastError)
    throw new Error(
      "npm registry polling deadline exceeded after transient errors.",
      { cause: lastError }
    );
};

export const waitForNpmCandidate = async (
  expected,
  loadRegistryVersion,
  options = {}
) => {
  let verified = false;
  await pollRegistry(
    (remaining) =>
      loadRegistryVersion(expected.packageName, expected.version, remaining),
    async (actual) => {
      await verifyNpmCandidate(expected, async () => actual);
      verified = true;
      return true;
    },
    options
  );
  if (!verified)
    throw new Error(
      "npm candidate version is missing from registry after waiting for publication."
    );
};

export const waitForNpmTag = async (
  packageName,
  tag,
  version,
  loadRegistryVersion,
  options = {}
) => {
  let verified = false;
  await pollRegistry(
    (remaining) => loadRegistryVersion(packageName, tag, remaining),
    (actual) => {
      if (actual.version !== version) return false;
      if (
        actual.name !== packageName ||
        (options.integrity && actual.dist?.integrity !== options.integrity)
      )
        throw new Error(
          `npm tag ${tag} package identity or integrity mismatch.`
        );
      verified = true;
      return true;
    },
    options
  );
  if (!verified)
    throw new Error(
      `npm tag ${tag} did not resolve to ${version} after waiting.`
    );
};

export const verifyPublishedAssets = (assets, directory, download) => {
  for (const asset of assets) {
    const path = resolve(directory, asset.name);
    try {
      download(asset, path);
    } finally {
      rmSync(path, { force: true });
    }
  }
};

export const parseArgs = (argv) => {
  const args = {};
  const flags = new Map([
    ["--repository", "repository"],
    ["--release-id", "releaseId"],
    ["--version", "version"],
    ["--expected-build", "expectedBuild"],
    ["--expected-build-sha256", "expectedBuildSha256"],
    ["--identity-artifact-id", "identityArtifactId"],
    ["--identity-artifact-digest", "identityArtifactDigest"],
    ["--reviewed-commit", "reviewedCommit"],
    ["--approved-run-id", "approvedRunId"],
    ["--approved-run-attempt", "approvedRunAttempt"]
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--verify-only") args.verifyOnly = true;
    else if (flags.has(argv[i])) {
      const flag = argv[i];
      const value = argv[++i];
      if (
        !value ||
        value.startsWith("--") ||
        args[flags.get(flag)] !== undefined
      )
        throw new Error(`Missing or duplicate option: ${flag}`);
      args[flags.get(flag)] = value;
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return args;
};

const command = (name, args, options = {}) =>
  execFileSync(name, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options
  });
export const registryVersion = async (
  packageName,
  version,
  fetchImpl = fetch,
  timeoutMs = 10000
) => {
  const name = encodeURIComponent(packageName).replace("%2F", "%2f");
  let response;
  try {
    response = await fetchImpl(
      `https://registry.npmjs.org/${name}/${version}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(10000, timeoutMs))
      }
    );
  } catch (cause) {
    throw Object.assign(new Error("npm registry request failed.", { cause }), {
      transient: true
    });
  }
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw Object.assign(
      new Error(`npm registry returned HTTP ${response.status}.`),
      {
        transient: response.status === 429 || response.status >= 500
      }
    );
  try {
    return await response.json();
  } catch (cause) {
    if (cause instanceof SyntaxError) throw cause;
    throw Object.assign(new Error("npm registry response failed.", { cause }), {
      transient: true
    });
  }
};

export const runReleasePromotion = async (args, adapters = {}) => {
  if (args.verifyOnly) return runReleaseVerification(args, adapters.readers);
  if (adapters.publicationApproved !== true)
    throw new Error(
      "Independent publication approval is required before promotion."
    );
  const candidate = await runReleaseVerification(args, adapters.readers);
  if (!candidate.desktop)
    throw new Error(
      "Full release promotion requires effective Desktop verification."
    );
  const recheckCandidate = async (expectPublished = false) => {
    const checked = await runReleaseVerification(args, adapters.readers, {
      expectPublished
    });
    if (
      canonicalReleaseJson({ ...checked, registry: candidate.registry }) !==
      canonicalReleaseJson(candidate)
    )
      throw new Error("Candidate changed before publication.");
  };
  const {
    run = command,
    fetchRegistry = (name, version, timeout) =>
      registryVersion(name, version, fetch, timeout)
  } = adapters;
  const temp = mkdtempSync(resolve(tmpdir(), "koed-release-promotion-"));
  const download = (asset, path) => {
    const reviewed = candidate.assets.find((item) => item.name === asset.name);
    if (!reviewed)
      throw new Error(
        `Release asset differs from protected build: ${asset.name}`
      );
    const fd = openSync(path, "wx", 0o600);
    try {
      run(
        "gh",
        [
          "api",
          "--header",
          "Accept: application/octet-stream",
          `repos/${args.repository}/releases/assets/${asset.id}`
        ],
        { encoding: null, stdio: ["ignore", fd, "inherit"] }
      );
    } finally {
      closeSync(fd);
    }
    // Authenticate each second download before any catalog/archive parsing.
    const digest = hashFileSync(path);
    if (digest !== reviewed.sha256)
      throw new Error(
        `Release asset differs from protected build: ${asset.name}`
      );
  };
  try {
    const release = JSON.parse(
      run("gh", ["api", `repos/${args.repository}/releases/${args.releaseId}`])
    );
    if (
      release.tag_name !== `v${args.version}` ||
      release.draft !== true ||
      release.prerelease !== false
    )
      throw new Error(
        "Expected matching GitHub draft release before promotion."
      );
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    const catalogName = "component-manifest-hashes.json";
    if (!assets.has(catalogName))
      throw new Error(
        "Complete component catalog is missing from draft release."
      );
    const catalogPath = resolve(temp, catalogName);
    download(assets.get(catalogName), catalogPath);
    const manifests = [...assets.keys()].filter((name) =>
      /^koed-(?:base|privacy)-.*\.tar\.gz\.manifest\.json$/.test(name)
    );
    if (manifests.length !== requiredComponentIdentities.length)
      throw new Error(
        "Expected the complete component target and variant manifest set."
      );
    for (const manifestName of manifests) {
      const archiveName = manifestName.replace(/\.manifest\.json$/, "");
      if (!assets.has(archiveName))
        throw new Error(`Component release set is incomplete: ${manifestName}`);
      download(assets.get(manifestName), resolve(temp, manifestName));
      download(assets.get(archiveName), resolve(temp, archiveName));
    }
    await verifyFrozenComponentAssets({
      assetsDir: temp,
      catalogPath,
      version: args.version,
      runtimeIdentities: candidate.runtimeIdentities
    });
    const identityName = "koed-labs-server-release-identity.json";
    const tarballName = "koed-labs-server.tgz";
    if (!assets.has(identityName) || !assets.has(tarballName))
      throw new Error("Public npm release artifacts are missing.");
    const identityPath = resolve(temp, identityName);
    const tarballPath = resolve(temp, tarballName);
    download(assets.get(identityName), identityPath);
    download(assets.get(tarballName), tarballPath);
    const identity = JSON.parse(readFileSync(identityPath, "utf8"));
    const expected = {
      packageName: "@koed-labs/server",
      version: args.version,
      integrity: identity.npm?.integrity
    };
    const integrity = `sha512-${hashFileSync(tarballPath, "sha512", "base64")}`;
    if (
      identity.packageName !== expected.packageName ||
      identity.version !== expected.version ||
      expected.integrity !== integrity
    )
      throw new Error(
        "npm tarball identity does not match exact package, version, and integrity."
      );
    run("tar", ["-xzf", tarballPath, "-C", temp]);
    verifyPackagedControlPlaneCatalog({
      modulePath: resolve(temp, "package/vendor/control-plane.js"),
      catalogPath,
      version: args.version
    });
    // Rerun from protected input, not a caller-supplied receipt; bind bytes used
    // below to the same evidence immediately before the first mutation.
    await recheckCandidate();
    const immutableAssets = [
      ...manifests.flatMap((name) => [
        name,
        name.replace(/\.manifest\.json$/, "")
      ]),
      catalogName,
      identityName,
      tarballName
    ];
    const expectedAssets = immutableAssets.map((name) => {
      const path =
        name === identityName
          ? identityPath
          : name === tarballName
            ? tarballPath
            : resolve(temp, name);
      const digest = hashFileSync(path);
      const reviewed = candidate.assets.find((asset) => asset.name === name);
      if (!reviewed || reviewed.sha256 !== digest)
        throw new Error(`Release asset differs from protected build: ${name}`);
      return { name, sha256: digest };
    });
    // Re-read the now-published release and re-hash every immutable asset
    // against protected build bytes before npm `latest` may depend on it.
    const verifyPublishedRelease = () => {
      const live = JSON.parse(
        run("gh", [
          "api",
          `repos/${args.repository}/releases/${args.releaseId}`
        ])
      );
      if (
        live.tag_name !== `v${args.version}` ||
        live.draft !== false ||
        live.prerelease !== false ||
        !Array.isArray(live.assets)
      )
        throw new Error("Published GitHub release identity mismatch.");
      const assetsByName = new Map();
      const ids = new Set();
      for (const asset of live.assets) {
        if (
          !Number.isSafeInteger(asset.id) ||
          asset.id <= 0 ||
          ids.has(asset.id) ||
          assetsByName.has(asset.name) ||
          !candidate.assets.some((reviewed) => reviewed.name === asset.name)
        )
          throw new Error("Published release asset inventory mismatch.");
        ids.add(asset.id);
        assetsByName.set(asset.name, asset);
      }
      const verifyDir = mkdtempSync(resolve(temp, "published-"));
      const verifiedAssets = candidate.assets.map(({ name }) => {
        const asset = assetsByName.get(name);
        if (!asset) throw new Error(`Published release asset missing: ${name}`);
        return asset;
      });
      verifyPublishedAssets(verifiedAssets, verifyDir, download);
    };
    // Every consumed immutable asset must match protected build bytes before
    // any irreversible mutation.
    let published = await fetchRegistry(expected.packageName, expected.version);
    if (!published) {
      await recheckCandidate();
      run("npm", [
        "publish",
        tarballPath,
        "--access",
        "public",
        "--tag",
        candidateNpmTag(args.version),
        "--provenance"
      ]);
      await waitForNpmCandidate(expected, fetchRegistry, {
        sleep: adapters.sleep
      });
    } else {
      await verifyNpmCandidate(expected, async () => published);
    }
    await recheckCandidate();
    run("npm", [
      "dist-tag",
      "add",
      `${expected.packageName}@${args.version}`,
      candidateNpmTag(args.version)
    ]);
    await waitForNpmTag(
      expected.packageName,
      candidateNpmTag(args.version),
      args.version,
      fetchRegistry,
      { sleep: adapters.sleep, integrity: expected.integrity }
    );
    const latest = await fetchRegistry(expected.packageName, "latest");
    const plan = planReleasePromotion(
      {
        version: args.version,
        catalogVerified: true,
        npm: {
          integrity: expected.integrity,
          inventorySha256: identity.npm.inventorySha256
        },
        github: { assets: expectedAssets }
      },
      {
        github: {
          tag_name: release.tag_name,
          draft: true,
          assets: expectedAssets.map(({ name, sha256 }) => ({ name, sha256 }))
        },
        npm: {
          version: args.version,
          integrity: expected.integrity,
          tag: candidateNpmTag(args.version),
          verified: true
        },
        latestVersion: latest?.version
      },
      { publish: true }
    );
    if (plan.status !== "ready")
      throw new Error(
        `Release planner blocked promotion: ${plan.reasons.join(" ")}`
      );
    let githubVerified = false;
    for (const action of plan.actions) {
      if (action.kind === "promote-latest") {
        // npm `latest` must never reference components that are not public.
        if (!githubVerified)
          throw new Error(
            "Refusing to promote npm latest before the published GitHub release is verified."
          );
        const currentLatest = await fetchRegistry(
          expected.packageName,
          "latest"
        );
        if (
          currentLatest != null &&
          (typeof currentLatest.version !== "string" ||
            !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(currentLatest.version) ||
            compareVersions(currentLatest.version, args.version) > 0)
        )
          throw new Error(
            "Refusing npm latest downgrade or invalid registry version."
          );
        await recheckCandidate(true);
        // npm dist-tag has no compare-and-swap: an external update can still race this read.
        run("npm", [
          "dist-tag",
          "add",
          `${expected.packageName}@${args.version}`,
          "latest"
        ]);
        await waitForNpmTag(
          expected.packageName,
          "latest",
          args.version,
          fetchRegistry,
          { sleep: adapters.sleep, integrity: expected.integrity }
        );
      } else if (action.kind === "publish-github") {
        await recheckCandidate();
        run("gh", [
          "api",
          "--method",
          "PATCH",
          `repos/${args.repository}/releases/${args.releaseId}`,
          "--field",
          "draft=false"
        ]);
        verifyPublishedRelease();
        githubVerified = true;
      } else
        throw new Error(`Unexpected release planner action: ${action.kind}`);
    }
    return {
      ok: true,
      verifiedComponents: manifests.length,
      npmIntegrity: expected.integrity,
      tag: release.tag_name,
      actions: plan.actions
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  for (const field of [
    "expectedBuild",
    "expectedBuildSha256",
    "identityArtifactId",
    "identityArtifactDigest",
    "reviewedCommit",
    "approvedRunId",
    "approvedRunAttempt",
    "repository",
    "releaseId",
    "version"
  ])
    if (!args[field])
      throw new Error(`Missing required verification option: ${field}`);
  if (args.verifyOnly) {
    console.log(JSON.stringify(await runReleaseVerification(args)));
    return;
  }
  if (process.env.KOED_NPM_PUBLICATION_AUTHORIZED !== "true")
    throw new Error("npm publication authorization is required.");
  const publicationApproved = verifyWorkflowApproval(args.version);
  const result = await runReleasePromotion(args, { publicationApproved });
  console.log(
    args.json
      ? JSON.stringify(result)
      : `Promoted ${result.tag} after verifying ${result.verifiedComponents} pinned components.`
  );
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
