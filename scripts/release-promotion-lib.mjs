const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256Pattern = /^[a-f0-9]{64}$/;

const validateExpected = (expected) => {
  if (
    !isRecord(expected) ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(expected.version ?? "")
  )
    throw new Error("Expected release version must be valid SemVer.");
  if (
    !isRecord(expected.npm) ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(expected.npm.integrity ?? "") ||
    !sha256Pattern.test(expected.npm.inventorySha256 ?? "")
  )
    throw new Error(
      "Expected npm integrity and inventory digest are required."
    );
  if (
    !Array.isArray(expected.github?.assets) ||
    expected.github.assets.length === 0
  )
    throw new Error("Expected GitHub release assets are required.");
  const names = new Set();
  for (const asset of expected.github.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      !asset.name ||
      names.has(asset.name) ||
      !sha256Pattern.test(asset.sha256 ?? "") ||
      typeof asset.signature !== "string" ||
      !asset.signature
    )
      throw new Error(
        "Expected release assets require unique names, SHA-256, and signatures."
      );
    names.add(asset.name);
  }
};

const blocked = (reasons) => ({ status: "blocked", reasons, actions: [] });
const compareVersions = (left, right) => {
  const parse = (version) => {
    const [core, prerelease] = version.split("-");
    return { core: core.split(".").map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
};

export const planReleasePromotion = (expected, remote, authorization) => {
  validateExpected(expected);
  if (!isRecord(remote) || !isRecord(authorization))
    throw new Error("Remote release state and authorization must be records.");
  const reasons = [];
  if (!authorization.publish)
    reasons.push("Independent publication authorization is unavailable.");
  if (!authorization.signerReady)
    reasons.push("Production signer is unavailable.");
  if (!authorization.trustRootsReady)
    reasons.push("Approved production trust roots are unavailable.");
  if (reasons.length) return blocked(reasons);

  const github = remote.github;
  if (
    !isRecord(github) ||
    typeof github.draft !== "boolean" ||
    !Array.isArray(github.assets) ||
    github.tag_name !== `v${expected.version}`
  )
    throw new Error(
      "Remote GitHub draft identity is malformed or does not match expected version."
    );
  if (github.published === true)
    return blocked([
      "GitHub release is already published; immutable release cannot be resumed as draft."
    ]);
  const actualAssets = new Map();
  for (const asset of github.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      actualAssets.has(asset.name) ||
      !sha256Pattern.test(asset.sha256 ?? "")
    )
      return blocked([
        "Remote GitHub assets contain invalid or duplicate identity."
      ]);
    actualAssets.set(asset.name, asset.sha256);
  }
  for (const expectedAsset of expected.github.assets) {
    const actual = actualAssets.get(expectedAsset.name);
    if (actual && actual !== expectedAsset.sha256)
      return blocked([
        `Existing GitHub asset differs from immutable expected bytes: ${expectedAsset.name}`
      ]);
  }
  if (!github.draft)
    return blocked([
      "GitHub release is not a draft; immutable release cannot be resumed for promotion."
    ]);

  const missingAssets = expected.github.assets
    .filter((asset) => !actualAssets.has(asset.name))
    .map((asset) => asset.name);
  const npm = remote.npm;
  if (npm !== null && npm !== undefined) {
    if (
      !isRecord(npm) ||
      npm.version !== expected.version ||
      npm.integrity !== expected.npm.integrity
    )
      return blocked([
        "Published npm version differs from expected immutable tarball."
      ]);
    if (![`${expected.version}-candidate`, "latest"].includes(npm.tag))
      return blocked([
        "Published npm dist-tag does not identify expected candidate or stable release."
      ]);
  }
  if (
    remote.latestVersion &&
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(remote.latestVersion)
  )
    throw new Error("Remote npm latest version is invalid SemVer.");
  if (
    remote.latestVersion &&
    compareVersions(remote.latestVersion, expected.version) > 0
  )
    return blocked(["Refusing to downgrade npm latest tag."]);

  const actions = [];
  if (missingAssets.length) {
    if (!github.draft)
      return blocked([
        "Required GitHub assets are missing from published release."
      ]);
    actions.push({ kind: "upload-missing-draft-assets", names: missingAssets });
    return { status: "ready", reasons: [], actions };
  }
  if (!npm) {
    actions.push({
      kind: "publish-candidate",
      tag: `${expected.version}-candidate`
    });
    return { status: "ready", reasons: [], actions };
  }
  if (npm.verified !== true) {
    actions.push({ kind: "verify-registry" });
    return { status: "ready", reasons: [], actions };
  }
  if (npm.tag !== "latest") actions.push({ kind: "promote-latest" });
  if (github.draft) actions.push({ kind: "publish-github" });
  return { status: "ready", reasons: [], actions };
};
