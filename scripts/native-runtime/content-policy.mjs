import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync
} from "node:fs";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { basename, relative, resolve } from "node:path";
import { collectPlatformBinaries } from "./loader-validation-lib.mjs";

const forbiddenDirectoryPattern =
  /^(?:\.cache|__pycache__|cmakefiles|include|src|source|sources|test|tests|testing)$/i;
const forbiddenFilePattern =
  /(?:^|\/)(?:cmakecache\.txt|makefile|build\.ninja)$|\.(?:a|c|cc|cmake|cpp|cu|cxx|h|hh|hpp|la|lo|o|obj|pdb|pyc)$/i;
const licencePattern = /^(?:licen[cs]e|notice|copying)(?:\.|$)/i;
const cudaRedistributablePattern = /^libcu(?:blas|blaslt|dart)\.so(?:\.\d+)*$/i;

const walk = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return walk(root, path);
    return [
      {
        path,
        relativePath: relative(root, path).replaceAll("\\", "/"),
        stat: lstatSync(path)
      }
    ];
  });

const forbiddenDirectoriesUnder = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = resolve(dir, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    return [
      ...(forbiddenDirectoryPattern.test(entry.name) ? [relativePath] : []),
      ...forbiddenDirectoriesUnder(root, path)
    ];
  });

const licencesUnder = (root) =>
  walk(root).filter(
    (entry) => entry.stat.isFile() && licencePattern.test(basename(entry.path))
  );

const preserveLicences = (runtimeRoot, directory, preserved) => {
  const destinationRoot = resolve(runtimeRoot, "third-party-licenses");
  for (const licence of licencesUnder(directory)) {
    const sourceRelative = relative(runtimeRoot, licence.path).replaceAll(
      "\\",
      "/"
    );
    const destination = resolve(
      destinationRoot,
      sourceRelative.replaceAll("/", "__")
    );
    mkdirSync(destinationRoot, { recursive: true });
    copyFileSync(licence.path, destination);
    preserved.push(relative(runtimeRoot, destination).replaceAll("\\", "/"));
  }
};

const pruneDirectory = (runtimeRoot, directory, removed, preserved) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const relativePath = relative(runtimeRoot, path).replaceAll("\\", "/");
    if (entry.isDirectory() && forbiddenDirectoryPattern.test(entry.name)) {
      preserveLicences(runtimeRoot, path, preserved);
      rmSync(path, { recursive: true, force: true });
      removed.push(relativePath);
    } else if (entry.isDirectory()) {
      pruneDirectory(runtimeRoot, path, removed, preserved);
    } else if (entry.isFile() && forbiddenFilePattern.test(relativePath)) {
      rmSync(path, { force: true });
      removed.push(relativePath);
    }
  }
};

export const pruneNativeRuntimeBuildArtifacts = (runtimeRoot) => {
  const removed = [];
  const preservedLicences = [];
  if (existsSync(runtimeRoot)) {
    pruneDirectory(runtimeRoot, runtimeRoot, removed, preservedLicences);
  }
  return {
    removed: removed.sort(),
    preservedLicences: preservedLicences.sort()
  };
};

const sha256 = (path) => {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
};

export const stripNativeRuntimeBinaries = ({
  runtimeRoot,
  platform,
  spawnSync = nodeSpawnSync
}) => {
  const canonicalRuntimeRoot = realpathSync(runtimeRoot);
  const command = platform === "darwin" ? "/usr/bin/strip" : "strip";
  const flags = platform === "darwin" ? ["-x"] : ["--strip-unneeded"];
  const stripped = [];
  const signed = [];
  for (const path of collectPlatformBinaries({
    runtimeRoot: canonicalRuntimeRoot,
    platform
  }).sort()) {
    const result = spawnSync(command, [...flags, path], {
      encoding: "utf8",
      stdio: "pipe"
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Could not strip ${relative(canonicalRuntimeRoot, path)}: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`
      );
    }
    const relativePath = relative(canonicalRuntimeRoot, path).replaceAll(
      "\\",
      "/"
    );
    stripped.push(relativePath);
    if (platform === "darwin") {
      const signedResult = spawnSync(
        "/usr/bin/codesign",
        ["--force", "--sign", "-", path],
        { encoding: "utf8", stdio: "pipe" }
      );
      if (signedResult.error || signedResult.status !== 0) {
        throw new Error(
          `Could not ad-hoc sign ${relativePath} after stripping: ${signedResult.stderr || signedResult.stdout || signedResult.error?.message || "unknown error"}`
        );
      }
      signed.push(relativePath);
    }
  }
  return {
    command: [command, ...flags].join(" "),
    signingCommand:
      platform === "darwin" ? "/usr/bin/codesign --force --sign -" : null,
    stripped,
    signed
  };
};

export const inspectNativeRuntimeContents = (runtimeRoot) => {
  const entries = walk(runtimeRoot);
  const forbidden = [
    ...forbiddenDirectoriesUnder(runtimeRoot),
    ...entries
      .filter((entry) => {
        return forbiddenFilePattern.test(entry.relativePath);
      })
      .map((entry) => entry.relativePath)
  ].sort();
  const cudaLibraries = entries.filter(
    (entry) =>
      entry.stat.isFile() &&
      entry.relativePath.startsWith("llama.cpp/cuda/") &&
      cudaRedistributablePattern.test(basename(entry.relativePath))
  );
  const byHash = new Map();
  for (const entry of cudaLibraries) {
    const hash = sha256(entry.path);
    byHash.set(hash, [...(byHash.get(hash) ?? []), entry.relativePath]);
  }
  const duplicateCudaLibraries = [...byHash.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([hash, paths]) => ({ hash, paths: paths.sort() }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  return {
    ok: forbidden.length === 0 && duplicateCudaLibraries.length === 0,
    forbidden,
    duplicateCudaLibraries
  };
};
