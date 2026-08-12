import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

export const claudeAgentSdkVersion = "0.3.226";
export const claudeAgentSdkPackage = "@anthropic-ai/claude-agent-sdk";

const platformPackageMetadata = new Map(
  [
    ["darwin-arm64", { os: "darwin", cpu: "arm64" }],
    ["darwin-x64", { os: "darwin", cpu: "x64" }],
    ["linux-arm64", { os: "linux", cpu: "arm64", libc: "glibc" }],
    ["linux-arm64-musl", { os: "linux", cpu: "arm64", libc: "musl" }],
    ["linux-x64", { os: "linux", cpu: "x64", libc: "glibc" }],
    ["linux-x64-musl", { os: "linux", cpu: "x64", libc: "musl" }],
    ["win32-arm64", { os: "win32", cpu: "arm64" }],
    ["win32-x64", { os: "win32", cpu: "x64" }]
  ].map(([suffix, metadata]) => [
    `@anthropic-ai/claude-agent-sdk-${suffix}`,
    metadata
  ])
);

export const claudeAgentSdkPlatformPackages = Object.freeze([
  ...platformPackageMetadata.keys()
]);

const platformPackagePrefix = "claude-agent-sdk-";
const expectedDocumentationFiles = ["LICENSE.md", "README.md"];

const normalized = (root, path) => relative(root, path).replaceAll("\\", "/");

const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error
    });
  }
};

const walk = (root, directory = root, entries = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    entries.push({ path, entry });
    if (entry.isDirectory()) walk(root, path, entries);
  }
  return entries;
};

const packageNameAt = (path) =>
  basename(dirname(path)) === "@anthropic-ai"
    ? `@anthropic-ai/${basename(path)}`
    : null;

const platformCandidates = (root) =>
  walk(root).filter(
    ({ path }) =>
      basename(dirname(path)) === "@anthropic-ai" &&
      basename(path).startsWith(platformPackagePrefix)
  );

const assertStringArray = (actual, expected, label) => {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}.`);
  }
};

const validatePlatformPackageDirectory = (path, expectedName) => {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`Provider runtime package is not a directory: ${path}`);
  }

  const metadata = platformPackageMetadata.get(expectedName);
  if (!metadata) {
    throw new Error(
      `Unknown Claude Agent SDK platform package: ${expectedName}`
    );
  }
  const executable = metadata.os === "win32" ? "claude.exe" : "claude";
  const expectedEntries = [
    ...expectedDocumentationFiles,
    executable,
    "package.json"
  ].sort();
  const actualEntries = readdirSync(path).sort();
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((value, index) => value !== expectedEntries[index])
  ) {
    throw new Error(
      `Claude Agent SDK platform package ${expectedName} has an unknown file shape at ${path}. Expected ${expectedEntries.join(", ")}; found ${actualEntries.join(", ")}.`
    );
  }

  for (const file of expectedEntries) {
    if (!lstatSync(resolve(path, file)).isFile()) {
      throw new Error(
        `Claude Agent SDK platform package ${expectedName} contains a non-file entry: ${file}`
      );
    }
  }

  const manifest = readJson(
    resolve(path, "package.json"),
    `${expectedName} package.json`
  );
  if (manifest.name !== expectedName) {
    throw new Error(
      `Claude Agent SDK platform package name mismatch at ${path}: expected ${expectedName}, found ${String(manifest.name)}.`
    );
  }
  if (manifest.version !== claudeAgentSdkVersion) {
    throw new Error(
      `Claude Agent SDK platform package version mismatch for ${expectedName}: expected ${claudeAgentSdkVersion}, found ${String(manifest.version)}.`
    );
  }
  assertStringArray(manifest.os, [metadata.os], `${expectedName} os`);
  assertStringArray(manifest.cpu, [metadata.cpu], `${expectedName} cpu`);
  if (metadata.libc) {
    assertStringArray(manifest.libc, [metadata.libc], `${expectedName} libc`);
  } else if (manifest.libc !== undefined) {
    throw new Error(`${expectedName} must not declare libc.`);
  }
  assertStringArray(
    manifest.files,
    [executable, "README.md", "LICENSE.md"],
    `${expectedName} files`
  );
};

const validateCandidate = (root, candidate) => {
  const expectedName = packageNameAt(candidate.path);
  if (!platformPackageMetadata.has(expectedName)) {
    throw new Error(
      `Unknown Claude Agent SDK provider runtime package at ${normalized(root, candidate.path)}: ${String(expectedName)}`
    );
  }
  const stat = lstatSync(candidate.path);
  if (stat.isSymbolicLink()) {
    let target;
    try {
      target = realpathSync(candidate.path);
    } catch (error) {
      throw new Error(
        `Claude Agent SDK platform package symlink is unresolved at ${normalized(root, candidate.path)}: ${error.message}`,
        { cause: error }
      );
    }
    validatePlatformPackageDirectory(target, expectedName);
    return;
  }
  validatePlatformPackageDirectory(candidate.path, expectedName);
};

/**
 * Remove only verified native Claude Agent SDK platform packages. The SDK's
 * JavaScript package is intentionally retained; Koed supplies the User's
 * explicitly confirmed local Claude Code executable to the SDK at runtime.
 */
export const removeClaudeAgentSdkPlatformRuntimes = (root) => {
  const packageRoot = resolve(root);
  if (!existsSync(packageRoot)) {
    throw new Error(
      `Provider runtime package root does not exist: ${packageRoot}`
    );
  }
  const candidates = platformCandidates(packageRoot);
  for (const candidate of candidates) validateCandidate(packageRoot, candidate);

  // Remove deeper aliases/directories first. Every target was validated above;
  // symlinks are unlinked without following targets outside packageRoot.
  const removalPaths = [...new Set(candidates.map(({ path }) => path))].sort(
    (left, right) => right.length - left.length
  );
  for (const path of removalPaths) {
    rmSync(path, { recursive: true, force: false });
  }
  assertNoClaudeAgentSdkPlatformRuntimes(packageRoot);
  return removalPaths.map((path) => normalized(packageRoot, path));
};

export const assertNoClaudeAgentSdkPlatformRuntimes = (root) => {
  const packageRoot = resolve(root);
  if (!existsSync(packageRoot)) return;
  const remaining = platformCandidates(packageRoot).map(({ path }) =>
    normalized(packageRoot, path)
  );
  const looseExecutables = walk(packageRoot)
    .filter(
      ({ path }) =>
        (basename(path) === "claude" || basename(path) === "claude.exe") &&
        `/${normalized(packageRoot, path)}`.includes("/@anthropic-ai/")
    )
    .map(({ path }) => normalized(packageRoot, path));
  const leftovers = [...new Set([...remaining, ...looseExecutables])].sort();
  if (leftovers.length > 0) {
    throw new Error(
      `Packaged Koed runtime still contains a Claude Agent SDK provider executable/runtime:\n${leftovers.join("\n")}`
    );
  }
};
