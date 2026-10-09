#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  openSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  candidateNpmTag,
  planReleasePromotion
} from "./release-promotion-lib.mjs";

export const canonicalReleaseJson = (value) => {
  if (Array.isArray(value))
    return `[${value.map(canonicalReleaseJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalReleaseJson(value[key])}`
      )
      .join(",")}}`;
  return JSON.stringify(value);
};

export const verifyReleaseSignatures = (artifacts, trustRoots) => {
  if (
    trustRoots?.schemaVersion !== 1 ||
    !trustRoots.keys ||
    !Object.keys(trustRoots.keys).length
  )
    throw new Error("Production component trust roots are missing.");
  return artifacts.map(
    ({
      manifest: manifestPath,
      signature: signaturePath,
      component,
      version,
      target
    }) => {
      const manifestBytes = readFileSync(manifestPath);
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      const signature = JSON.parse(readFileSync(signaturePath, "utf8"));
      if (
        manifest.productVersion !== version ||
        manifest.component !== component ||
        `${manifest.target?.platform}-${manifest.target?.architecture}` !==
          target
      )
        throw new Error(
          `Component manifest identity or target mismatch: ${manifestPath}`
        );
      if (manifestBytes.toString("utf8") !== canonicalReleaseJson(manifest))
        throw new Error(`Component manifest is not canonical: ${manifestPath}`);
      const rawKey = trustRoots.keys[signature.keyId];
      if (
        signature.schemaVersion !== 1 ||
        signature.algorithm !== "ed25519" ||
        typeof rawKey !== "string" ||
        typeof signature.signature !== "string"
      )
        throw new Error(
          `Component signature or trusted key is invalid: ${signaturePath}`
        );
      const publicKey = createPublicKey(rawKey);
      const bytes = Buffer.from(signature.signature, "base64");
      const valid =
        bytes.length === 64 &&
        bytes.toString("base64") === signature.signature &&
        verify(
          null,
          Buffer.concat([
            Buffer.from("koed-component-manifest-v1\n"),
            Buffer.from(canonicalReleaseJson(manifest))
          ]),
          publicKey,
          bytes
        );
      if (!valid)
        throw new Error(
          `Component manifest signature is invalid: ${signaturePath}`
        );
      return { component, version, target, keyId: signature.keyId };
    }
  );
};

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

export const parseArgs = (argv) => {
  const args = {};
  const flags = new Map([
    ["--trust-roots", "trustRoots"],
    ["--trust-roots-sha256", "trustRootsSha256"],
    ["--controlplane-trust-roots-sha256", "controlplaneTrustRootsSha256"],
    ["--signer-url", "signerUrl"],
    ["--signer-key-id", "signerKeyId"],
    ["--repository", "repository"],
    ["--release-id", "releaseId"],
    ["--version", "version"]
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") args.json = true;
    else if (flags.has(argv[i])) args[flags.get(argv[i])] = argv[++i];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return args;
};

const command = (name, args, options = {}) =>
  execFileSync(name, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options
  });
const registryVersion = async (packageName, version) => {
  const name = encodeURIComponent(packageName).replace("%2F", "%2f");
  const response = await fetch(
    `https://registry.npmjs.org/${name}/${version}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`npm registry returned HTTP ${response.status}.`);
  return response.json();
};

export const runReleasePromotion = async (args, adapters = {}) => {
  const {
    run = command,
    fetchRegistry = registryVersion,
    fetchImpl = fetch
  } = adapters;
  const rootsBytes = readFileSync(resolve(args.trustRoots));
  const rootsDigest = createHash("sha256").update(rootsBytes).digest("hex");
  if (
    !/^[a-f0-9]{64}$/.test(args.trustRootsSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(args.controlplaneTrustRootsSha256 ?? "") ||
    rootsDigest !== args.trustRootsSha256
  )
    throw new Error(
      "Trust roots do not match configured and control-plane digests."
    );
  const roots = JSON.parse(rootsBytes.toString("utf8"));
  const temp = mkdtempSync(resolve(tmpdir(), "koed-release-promotion-"));
  const download = (asset, path) => {
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
  };
  try {
    const release = JSON.parse(
      run("gh", ["api", `repos/${args.repository}/releases/${args.releaseId}`])
    );
    if (release.tag_name !== `v${args.version}` || release.draft !== true)
      throw new Error(
        "Expected matching GitHub draft release before promotion."
      );
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    const manifests = [...assets.keys()].filter((name) =>
      /^koed-(?:base|privacy)-.*\.tar\.gz\.manifest\.json$/.test(name)
    );
    if (manifests.length !== 4)
      throw new Error("Expected four component target manifests.");
    const verified = [];
    for (const manifestName of manifests) {
      const signatureName = manifestName.replace(
        /\.manifest\.json$/,
        ".signature.json"
      );
      const archiveName = manifestName.replace(/\.manifest\.json$/, "");
      if (!assets.has(signatureName) || !assets.has(archiveName))
        throw new Error(`Component release set is incomplete: ${manifestName}`);
      const manifestPath = resolve(temp, manifestName);
      const signaturePath = resolve(temp, signatureName);
      const archivePath = resolve(temp, archiveName);
      download(assets.get(manifestName), manifestPath);
      download(assets.get(signatureName), signaturePath);
      download(assets.get(archiveName), archivePath);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const archiveBytes = readFileSync(archivePath);
      if (
        manifest.archive?.name !== archiveName ||
        manifest.archive.bytes !== archiveBytes.length ||
        manifest.archive.sha256 !==
          createHash("sha256").update(archiveBytes).digest("hex")
      )
        throw new Error(
          `Component archive does not match signed manifest: ${archiveName}`
        );
      const target = `${manifest.target?.platform}-${manifest.target?.architecture}`;
      const result = verifyReleaseSignatures(
        [
          {
            manifest: manifestPath,
            signature: signaturePath,
            component: manifest.component,
            version: args.version,
            target
          }
        ],
        roots
      );
      if (result[0].keyId !== args.signerKeyId)
        throw new Error(
          `Component signature uses unexpected key ID: ${manifestName}`
        );
      const external = await fetchImpl(
        `${args.signerUrl.replace(/\/$/, "")}/v1/verify`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            keyId: args.signerKeyId,
            manifest,
            signature: JSON.parse(readFileSync(signaturePath, "utf8"))
          })
        }
      );
      if (!external.ok || (await external.json()).verified !== true)
        throw new Error(
          `External signer rejected component signature: ${manifestName}`
        );
      verified.push(...result);
    }
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
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
    const builtRootsPath = resolve(temp, "component-trust-roots.mjs");
    writeFileSync(
      builtRootsPath,
      run("tar", ["-xOf", tarballPath, "package/dist/component-trust-roots.js"])
    );
    const builtRootsModule = await import(
      `${pathToFileURL(builtRootsPath).href}?${Date.now()}`
    );
    const builtRoots = Object.fromEntries(
      builtRootsModule.productionComponentTrustRoots
    );
    const builtRootsDigest = createHash("sha256")
      .update(canonicalReleaseJson(builtRoots))
      .digest("hex");
    if (
      builtRootsDigest !== args.controlplaneTrustRootsSha256 ||
      canonicalReleaseJson(builtRoots) !== canonicalReleaseJson(roots.keys)
    )
      throw new Error(
        "Configured trust roots do not match trusted roots embedded in the published control-plane package."
      );
    if (
      identity.packageName !== expected.packageName ||
      identity.version !== expected.version ||
      expected.integrity !== integrity
    )
      throw new Error(
        "npm tarball identity does not match exact package, version, and integrity."
      );
    let published = await fetchRegistry(expected.packageName, expected.version);
    if (!published) {
      run("npm", [
        "publish",
        tarballPath,
        "--access",
        "public",
        "--tag",
        candidateNpmTag(args.version),
        "--provenance"
      ]);
      published = await fetchRegistry(expected.packageName, expected.version);
    }
    await verifyNpmCandidate(expected, async () => published);
    run("npm", [
      "dist-tag",
      "add",
      `${expected.packageName}@${args.version}`,
      candidateNpmTag(args.version)
    ]);
    const latest = await fetchRegistry(expected.packageName, "latest");
    const immutableAssets = [
      ...manifests.flatMap((name) => [
        name,
        name.replace(/\.manifest\.json$/, ".signature.json"),
        name.replace(/\.manifest\.json$/, "")
      ]),
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
      const digest = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
      return { name, sha256: digest, signature: `verified:${digest}` };
    });
    const plan = planReleasePromotion(
      {
        version: args.version,
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
      { publish: true, signerReady: true, trustRootsReady: true }
    );
    if (plan.status !== "ready")
      throw new Error(
        `Release planner blocked promotion: ${plan.reasons.join(" ")}`
      );
    for (const action of plan.actions) {
      if (action.kind === "promote-latest")
        run("npm", [
          "dist-tag",
          "add",
          `${expected.packageName}@${args.version}`,
          "latest"
        ]);
      else if (action.kind === "publish-github")
        run("gh", [
          "api",
          "--method",
          "PATCH",
          `repos/${args.repository}/releases/${args.releaseId}`,
          "--field",
          "draft=false"
        ]);
      else throw new Error(`Unexpected release planner action: ${action.kind}`);
    }
    return {
      ok: true,
      verifiedSignatures: verified.length,
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
    "trustRoots",
    "trustRootsSha256",
    "controlplaneTrustRootsSha256",
    "signerUrl",
    "signerKeyId",
    "repository",
    "releaseId",
    "version"
  ])
    if (!args[field])
      throw new Error(`Missing required promotion option: ${field}`);
  const result = await runReleasePromotion(args);
  console.log(
    args.json
      ? JSON.stringify(result)
      : `Promoted ${result.tag} after verifying ${result.verifiedSignatures} signatures.`
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
