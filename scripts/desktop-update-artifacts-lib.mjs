import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { load as parseYamlDocument } from "js-yaml";
import { blake2b } from "@noble/hashes/blake2.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ARTIFACT_NAMES = Object.freeze([
  "latest-mac.yml",
  "Koed-{version}-arm64.zip",
  "Koed-{version}-arm64.dmg",
  "Koed-{version}-arm64.zip.blockmap",
  "Koed-{version}-arm64.dmg.blockmap"
]);

function parseYaml(text, sourcePath) {
  try {
    return parseYamlDocument(text, { filename: sourcePath });
  } catch (error) {
    throw new Error(`Unable to parse ${sourcePath}: ${error.message}`, {
      cause: error
    });
  }
}

function assertSafeRelativeFile(value, fieldName) {
  if (typeof value !== "string" || !value || isAbsolute(value)) {
    throw new Error(`${fieldName} must be a relative filename`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("/") || normalized === "." || normalized === "..") {
    throw new Error(
      `${fieldName} must not contain a directory or traversal component`
    );
  }
  if (basename(normalized) !== normalized) {
    throw new Error(`${fieldName} is not a safe filename`);
  }
  return normalized;
}

function assertInsideRoot(root, fileName) {
  const candidate = resolve(root, fileName);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Artifact path escapes candidate directory: ${fileName}`);
  }
  return candidate;
}

function assertRegularCandidateFile(root, rootReal, fileName, label) {
  const candidate = assertInsideRoot(root, fileName);
  let info;
  try {
    info = lstatSync(candidate);
  } catch {
    throw new Error(`Manifest references missing artifact: ${fileName}`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${fileName}`);
  }
  if (!info.isFile())
    throw new Error(`${label} must be a regular file: ${fileName}`);
  const real = realpathSync(candidate);
  const rel = relative(rootReal, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `${label} resolves outside candidate directory: ${fileName}`
    );
  }
  return candidate;
}

function sha512Base64(path) {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

function blockMapChunkDigest(bytes) {
  return Buffer.from(blake2b(bytes, { dkLen: 18 })).toString("base64");
}

function verifyBlockMap(blockMapPath, artifactPath, artifactName) {
  let blockMap;
  try {
    blockMap = JSON.parse(
      gunzipSync(readFileSync(blockMapPath), { finishFlush: 2 })
    );
  } catch (error) {
    throw new Error(
      `Unable to decode ${basename(blockMapPath)}: ${error.message}`,
      { cause: error }
    );
  }
  if (
    blockMap?.version !== "2" ||
    !Array.isArray(blockMap.files) ||
    blockMap.files.length !== 1
  ) {
    throw new Error(`Unsupported blockmap format for ${artifactName}`);
  }
  const entry = blockMap.files[0];
  if (
    entry.name !== "file" ||
    Number(entry.offset) !== 0 ||
    !Array.isArray(entry.sizes) ||
    !Array.isArray(entry.checksums) ||
    entry.sizes.length !== entry.checksums.length
  ) {
    throw new Error(`Malformed blockmap chunks for ${artifactName}`);
  }
  const bytes = readFileSync(artifactPath);
  let offset = 0;
  for (let index = 0; index < entry.sizes.length; index += 1) {
    const size = Number(entry.sizes[index]);
    if (!Number.isInteger(size) || size <= 0 || offset + size > bytes.length) {
      throw new Error(`Blockmap chunk bounds do not match ${artifactName}`);
    }
    const actual = blockMapChunkDigest(bytes.subarray(offset, offset + size));
    if (actual !== entry.checksums[index]) {
      throw new Error(
        `Blockmap bytes do not match ${artifactName} at chunk ${index}`
      );
    }
    offset += size;
  }
  if (offset !== bytes.length)
    throw new Error(`Blockmap coverage does not match ${artifactName}`);
}

function expectedArtifacts(version) {
  return ARTIFACT_NAMES.map((template) =>
    template.replace("{version}", version)
  );
}

function assertVersion(version, source) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`${source} must contain a valid semantic product version`);
  }
}

export function validateDesktopUpdateArtifacts({
  root,
  expectedVersion = null
} = {}) {
  if (typeof root !== "string" || !root)
    throw new Error("Candidate artifact root is required");
  const candidateRoot = resolve(root);
  if (!existsSync(candidateRoot)) {
    throw new Error(
      `Candidate artifact root is not a directory: ${candidateRoot}`
    );
  }
  const rootInfo = lstatSync(candidateRoot);
  if (rootInfo.isSymbolicLink())
    throw new Error("Candidate artifact root must not be a symbolic link");
  if (!rootInfo.isDirectory())
    throw new Error(
      `Candidate artifact root is not a directory: ${candidateRoot}`
    );
  const rootReal = realpathSync(candidateRoot);

  const manifestName = "latest-mac.yml";
  const manifestPath = assertRegularCandidateFile(
    candidateRoot,
    rootReal,
    manifestName,
    "Updater metadata"
  );
  const manifest = parseYaml(readFileSync(manifestPath, "utf8"), manifestPath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("latest-mac.yml must contain a mapping");
  }

  const version = manifest.version;
  assertVersion(version, "latest-mac.yml version");
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(
      `Metadata version ${version} does not match candidate version ${expectedVersion}`
    );
  }
  const expected = expectedArtifacts(version);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.length)
    throw new Error("latest-mac.yml is missing its files list");

  const referenced = new Set();
  for (const [index, entry] of files.entries()) {
    if (!entry || typeof entry !== "object")
      throw new Error(`latest-mac.yml files[${index}] must be a mapping`);
    const url = assertSafeRelativeFile(
      entry.url,
      `latest-mac.yml files[${index}].url`
    );
    referenced.add(url);
    const artifactPath = assertRegularCandidateFile(
      candidateRoot,
      rootReal,
      url,
      "Manifest artifact"
    );
    if (
      (!url.endsWith(".zip") && !url.endsWith(".dmg")) ||
      !url.startsWith(`Koed-${version}-`)
    ) {
      throw new Error(
        `Manifest references an artifact outside the candidate Desktop build: ${url}`
      );
    }
    if (
      typeof entry.sha512 !== "string" ||
      entry.sha512 !== sha512Base64(artifactPath)
    ) {
      throw new Error(`Manifest SHA-512 does not match ${url}`);
    }
    if (
      entry.size !== undefined &&
      Number(entry.size) !== statSync(artifactPath).size
    ) {
      throw new Error(`Manifest size does not match ${url}`);
    }
  }

  if (!referenced.has(expectedArtifacts(version)[1])) {
    throw new Error(
      `Manifest files list is missing ${expectedArtifacts(version)[1]}`
    );
  }
  if (!referenced.has(expectedArtifacts(version)[2])) {
    throw new Error(
      `Manifest files list is missing ${expectedArtifacts(version)[2]}`
    );
  }

  const pathName = assertSafeRelativeFile(manifest.path, "latest-mac.yml path");
  if (!referenced.has(pathName))
    throw new Error("latest-mac.yml path is not present in files");
  if (
    typeof manifest.sha512 !== "string" ||
    manifest.sha512 !==
      sha512Base64(
        assertRegularCandidateFile(
          candidateRoot,
          rootReal,
          pathName,
          "Manifest artifact"
        )
      )
  ) {
    throw new Error(`Manifest top-level SHA-512 does not match ${pathName}`);
  }

  for (const artifactName of expected.slice(1)) {
    const artifactPath = assertRegularCandidateFile(
      candidateRoot,
      rootReal,
      artifactName,
      "Required updater artifact"
    );
    if (artifactName.endsWith(".zip") || artifactName.endsWith(".dmg")) {
      const blockMapPath = assertRegularCandidateFile(
        candidateRoot,
        rootReal,
        `${artifactName}.blockmap`,
        "Required updater blockmap"
      );
      verifyBlockMap(blockMapPath, artifactPath, artifactName);
    }
  }
  if (pathName !== expected[1]) {
    throw new Error(
      `Manifest ZIP ${pathName} does not match expected candidate artifact ${expected[1]}`
    );
  }

  const allowed = new Set(expected);
  for (const entry of readdirSync(candidateRoot, { withFileTypes: true })) {
    const name = entry.name;
    if (
      entry.isSymbolicLink() &&
      /^(?:latest-[^/]+\.ya?ml|Koed-.+\.(?:dmg|zip)(?:\.blockmap)?)$/.test(name)
    ) {
      throw new Error(
        `Candidate artifact must not be a symbolic link: ${name}`
      );
    }
    if (!entry.isFile()) continue;
    if (
      /^(?:latest-[^/]+\.ya?ml|Koed-.+\.(?:dmg|zip)(?:\.blockmap)?)$/.test(
        name
      ) &&
      !allowed.has(name)
    ) {
      throw new Error(
        `Candidate directory contains an artifact not belonging to version ${version}: ${name}`
      );
    }
  }

  return {
    version,
    channel: "stable",
    trust: "internal-ad-hoc-or-unsigned",
    manifest: manifestName,
    artifacts: [...allowed],
    root: candidateRoot
  };
}

export function artifactNamesForVersion(version) {
  assertVersion(version, "version");
  return expectedArtifacts(version);
}
