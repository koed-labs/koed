import { createHash, verify as cryptoVerify } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type {
  ArtifactTarget,
  ComponentId,
  ComponentManifest,
  ComponentSignature,
  RuntimeIdentity
} from "./component-contract.js";

const DOMAIN = Buffer.from("koed-component-manifest-v1\n");
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 100_000;
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

export interface ComponentVerificationInput {
  manifestBytes: Buffer;
  signature: ComponentSignature;
  archivePath: string;
  expectedComponent: ComponentId;
  expectedVersion: string;
  target: ArtifactTarget;
  runtime: RuntimeIdentity;
  trustedKeys: ReadonlyMap<string, string>;
}

export const canonicalComponentManifestBytes = (
  manifest: ComponentManifest
): Buffer => Buffer.from(canonicalJson(manifest), "utf8");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("component manifest has unsupported JSON value");
  return encoded;
}

function assertRecord(
  value: unknown,
  name: string,
  keys: readonly string[]
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  )
    throw new Error(`${name} has invalid fields`);
}

function safeRelativePath(
  path: unknown,
  label: string
): asserts path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  ) {
    throw new Error(`${label} is unsafe`);
  }
}

function validateManifest(value: unknown): asserts value is ComponentManifest {
  assertRecord(value, "component manifest", [
    "schemaVersion",
    "productVersion",
    "component",
    "target",
    "runtimes",
    "archive",
    "requiredFiles",
    "files"
  ]);
  const manifest = value as unknown as ComponentManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.productVersion) ||
    !["base", "privacy"].includes(manifest.component)
  )
    throw new Error("component manifest identity is invalid");
  assertRecord(
    manifest.target,
    "component target",
    manifest.target.libc
      ? ["platform", "architecture", "libc"]
      : ["platform", "architecture"]
  );
  if (
    !["macos", "linux"].includes(manifest.target.platform) ||
    !["arm64", "x64"].includes(manifest.target.architecture)
  )
    throw new Error("unsupported component target");
  if (manifest.target.libc) {
    assertRecord(manifest.target.libc, "component libc target", [
      "family",
      "minimumVersion"
    ]);
    if (
      manifest.target.platform !== "linux" ||
      manifest.target.libc.family !== "glibc" ||
      !isVersion(manifest.target.libc.minimumVersion)
    )
      throw new Error("component libc target is invalid");
  }
  assertRecord(manifest.archive, "component archive", [
    "name",
    "bytes",
    "sha256"
  ]);
  if (
    typeof manifest.archive.name !== "string" ||
    basename(manifest.archive.name) !== manifest.archive.name ||
    !Number.isSafeInteger(manifest.archive.bytes) ||
    manifest.archive.bytes < 1 ||
    !isHash(manifest.archive.sha256)
  )
    throw new Error("component archive metadata is invalid");
  if (
    !Array.isArray(manifest.runtimes) ||
    manifest.runtimes.length === 0 ||
    !Array.isArray(manifest.requiredFiles) ||
    manifest.requiredFiles.length > MAX_FILES ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > MAX_FILES
  )
    throw new Error("component manifest lists are invalid");
  for (const runtime of manifest.runtimes) {
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime))
      throw new Error("component runtime compatibility is invalid");
    const runtimeRecord = runtime as unknown as Record<string, unknown>;
    const runtimeKeys = [
      "kind",
      "runtimeRange",
      "nodeRange",
      ...(runtimeRecord.modulesAbi === undefined ? [] : ["modulesAbi"]),
      ...(runtimeRecord.minimumNapi === undefined ? [] : ["minimumNapi"])
    ];
    assertRecord(runtime, "component runtime compatibility", runtimeKeys);
    if (
      typeof runtimeRecord.kind !== "string" ||
      !["node", "electron"].includes(runtimeRecord.kind) ||
      !validRange(runtime.runtimeRange) ||
      !validRange(runtime.nodeRange) ||
      (runtimeRecord.modulesAbi !== undefined &&
        (typeof runtimeRecord.modulesAbi !== "string" ||
          !/^\d+$/.test(runtimeRecord.modulesAbi))) ||
      (runtimeRecord.minimumNapi !== undefined &&
        (typeof runtimeRecord.minimumNapi !== "number" ||
          !Number.isSafeInteger(runtimeRecord.minimumNapi) ||
          runtimeRecord.minimumNapi < 1))
    )
      throw new Error("component runtime compatibility is invalid");
    if (runtime.modulesAbi === undefined && runtime.minimumNapi === undefined)
      throw new Error("component runtime compatibility must bind ABI or N-API");
  }
  const paths = new Set<string>();
  for (const item of manifest.files) {
    assertRecord(item, "component file entry", ["path", "sha256"]);
    safeRelativePath(item.path, "component file path");
    if (!isHash(item.sha256) || paths.has(item.path))
      throw new Error("component file inventory is invalid or duplicate");
    paths.add(item.path);
  }
  const required = new Set<string>();
  for (const path of manifest.requiredFiles) {
    safeRelativePath(path, "required component path");
    if (required.has(path) || !paths.has(path))
      throw new Error(
        "required component file is duplicate or missing from inventory"
      );
    required.add(path);
  }
}

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isVersion = (value: unknown): value is string =>
  typeof value === "string" && /^\d+(?:\.\d+){1,2}$/.test(value);
function versionParts(value: string): number[] | undefined {
  if (!/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(value)) return;
  return [...value.split(/[.-]/).slice(0, 3), "0", "0"].slice(0, 3).map(Number);
}
function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return Number.NaN;
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}
function validRange(range: unknown): range is string {
  return (
    typeof range === "string" &&
    range.trim().length > 0 &&
    range
      .split(/\s+/)
      .every((part) => /^(?:>=|>|<=|<|=)?\d+(?:\.\d+){0,2}$/.test(part))
  );
}
function satisfies(version: string, range: string): boolean {
  return range.split(/\s+/).every((part) => {
    const match = /^(>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part);
    if (!match) return false;
    const comparison = compareVersions(version, match[2]!);
    switch (match[1]) {
      case ">=":
        return comparison >= 0;
      case ">":
        return comparison > 0;
      case "<=":
        return comparison <= 0;
      case "<":
        return comparison < 0;
      default:
        return comparison === 0;
    }
  });
}

function verifyCompatibility(
  manifest: ComponentManifest,
  input: ComponentVerificationInput
): void {
  if (manifest.component !== input.expectedComponent)
    throw new Error("component mismatch");
  if (manifest.productVersion !== input.expectedVersion)
    throw new Error("product version mismatch");
  if (canonicalJson(manifest.target) !== canonicalJson(input.target))
    throw new Error("component target mismatch");
  if (
    manifest.target.platform !== input.runtime.platform ||
    manifest.target.architecture !== input.runtime.architecture
  )
    throw new Error("runtime target mismatch");
  if (
    !isVersion(input.runtime.version) ||
    !isVersion(input.runtime.nodeVersion) ||
    typeof input.runtime.modulesAbi !== "string" ||
    !/^\d+$/.test(input.runtime.modulesAbi) ||
    !Number.isSafeInteger(input.runtime.napiVersion) ||
    input.runtime.napiVersion < 0
  )
    throw new Error("runtime identity is invalid");
  const compatibility = manifest.runtimes.find(
    (item) =>
      item.kind === input.runtime.kind &&
      satisfies(input.runtime.version, item.runtimeRange) &&
      satisfies(input.runtime.nodeVersion, item.nodeRange)
  );
  if (!compatibility) throw new Error("runtime version is incompatible");
  if (
    compatibility.modulesAbi !== undefined &&
    compatibility.modulesAbi !== input.runtime.modulesAbi
  )
    throw new Error("runtime ABI mismatch");
  if (
    compatibility.minimumNapi !== undefined &&
    input.runtime.napiVersion < compatibility.minimumNapi
  )
    throw new Error("runtime N-API version is incompatible");
  if (manifest.target.libc) {
    if (
      !isVersion(input.runtime.libcVersion) ||
      compareVersions(
        input.runtime.libcVersion,
        `${manifest.target.libc.minimumVersion}.0`
      ) < 0
    )
      throw new Error("runtime libc version is incompatible");
  }
}

function tarString(header: Buffer, offset: number, length: number): string {
  const value = header.subarray(offset, offset + length);
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}
function tarNumber(header: Buffer, offset: number, length: number): number {
  const text = tarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(text))
    throw new Error("malformed component tar numeric field");
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number))
    throw new Error("component tar field exceeds safe integer range");
  return number;
}
function verifyTarArchive(archive: Buffer, manifest: ComponentManifest): void {
  const expanded = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  const contents = new Map<string, Buffer>();
  const seenPaths = new Set<string>();
  let offset = 0;
  let expandedBytes = 0;
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = tarNumber(header, 148, 8);
    const check = Buffer.from(header);
    check.fill(0x20, 148, 156);
    if (storedChecksum !== check.reduce((sum, byte) => sum + byte, 0))
      throw new Error("malformed component tar header checksum");
    const type = tarString(header, 156, 1) || "0";
    if (type === "1")
      throw new Error("component archives must not contain hard links");
    if (type === "2")
      throw new Error("component archives must not contain symbolic links");
    if (type !== "0" && type !== "5")
      throw new Error(`unsupported component tar entry type: ${type}`);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const cleanPath = path.replace(/\/$/, "");
    safeRelativePath(cleanPath, "component archive path");
    const size = tarNumber(header, 124, 12);
    if (type === "5" && size !== 0)
      throw new Error("component directory tar entry must be empty");
    if (size > MAX_FILE_BYTES)
      throw new Error("component archive entry exceeds individual file limit");
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES)
      throw new Error("component archive exceeds expanded size limit");
    if (seenPaths.has(cleanPath))
      throw new Error(`duplicate component archive path: ${cleanPath}`);
    seenPaths.add(cleanPath);
    if (seenPaths.size > MAX_FILES)
      throw new Error("component archive exceeds file count limit");
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > expanded.length)
      throw new Error("component archive is truncated");
    if (type === "0")
      contents.set(path, expanded.subarray(offset, offset + size));
    offset += padded;
    if (contents.size > MAX_FILES)
      throw new Error("component archive exceeds file count limit");
  }
  const filePaths = [...contents.keys()];
  for (const path of filePaths) {
    const parents = path.split("/").slice(0, -1);
    for (let index = 1; index <= parents.length; index++) {
      const parentPath = parents.slice(0, index).join("/");
      if (contents.has(parentPath))
        throw new Error(`component archive file path conflict: ${parentPath}`);
    }
  }
  const expected = new Map(
    manifest.files.map((file) => [file.path, file.sha256])
  );
  if (contents.size !== expected.size)
    throw new Error("component archive file inventory mismatch");
  for (const [path, bytes] of contents) {
    if (!expected.has(path) || hash(bytes) !== expected.get(path))
      throw new Error(`component archive file hash mismatch: ${path}`);
  }
  for (const required of manifest.requiredFiles)
    if (!contents.has(required))
      throw new Error(`required component file is missing: ${required}`);
}

function verifyComponentSync(
  input: ComponentVerificationInput
): ComponentManifest {
  assertRecord(input.signature, "component signature", [
    "schemaVersion",
    "keyId",
    "algorithm",
    "signature"
  ]);
  if (
    input.signature.schemaVersion !== 1 ||
    input.signature.algorithm !== "ed25519"
  )
    throw new Error("unsupported component signature");
  if (
    typeof input.signature.keyId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.signature.keyId) ||
    typeof input.signature.signature !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signature.signature)
  )
    throw new Error("component signature encoding is invalid");
  const publicKey = input.trustedKeys.get(input.signature.keyId);
  if (!publicKey) throw new Error("untrusted component signing key");
  if (input.manifestBytes.length > MAX_MANIFEST_BYTES)
    throw new Error("component manifest exceeds size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifestBytes.toString("utf8"));
  } catch {
    throw new Error("component manifest JSON is invalid");
  }
  validateManifest(parsed);
  const manifest = parsed;
  const canonical = canonicalComponentManifestBytes(manifest);
  if (!canonical.equals(input.manifestBytes))
    throw new Error("component manifest is not canonical");
  const signature = Buffer.from(input.signature.signature, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== input.signature.signature ||
    !cryptoVerify(
      null,
      Buffer.concat([DOMAIN, canonical]),
      publicKey,
      signature
    )
  )
    throw new Error("component manifest signature is invalid");
  verifyCompatibility(manifest, input);
  const stat = lstatSync(input.archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE_BYTES)
    throw new Error("component archive is not a bounded regular file");
  if (basename(input.archivePath) !== manifest.archive.name)
    throw new Error("component archive name mismatch");
  if (stat.size !== manifest.archive.bytes)
    throw new Error("component archive size mismatch");
  const archive = readFileSync(input.archivePath);
  if (hash(archive) !== manifest.archive.sha256)
    throw new Error("component archive SHA-256 mismatch");
  verifyTarArchive(archive, manifest);
  return manifest;
}

export const verifyComponent = (
  input: ComponentVerificationInput
): Promise<ComponentManifest> =>
  Promise.resolve().then(() => verifyComponentSync(input));

function verifyExtractedComponentSync(
  root: string,
  manifest: ComponentManifest
): void {
  validateManifest(manifest);
  const canonicalRoot = resolve(root);
  if (
    !existsSync(canonicalRoot) ||
    lstatSync(canonicalRoot).isSymbolicLink() ||
    !lstatSync(canonicalRoot).isDirectory()
  )
    throw new Error("component root is not a regular directory");
  const observed = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(canonicalRoot, path).split(sep).join("/");
      safeRelativePath(relativePath, "extracted component path");
      const stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink > 1)
      )
        throw new Error(
          "component files must not contain links or special files"
        );
      if (stat.isDirectory()) visit(path);
      else {
        if (stat.size > MAX_FILE_BYTES)
          throw new Error("component file exceeds individual file limit");
        observed.add(relativePath);
        const expected = manifest.files.find(
          (file) => file.path === relativePath
        );
        if (!expected || hash(readFileSync(path)) !== expected.sha256)
          throw new Error(`component file hash mismatch: ${relativePath}`);
      }
    }
  };
  visit(canonicalRoot);
  for (const file of manifest.files)
    if (!observed.has(file.path))
      throw new Error(
        `required component file is missing or incomplete: ${file.path}`
      );
  for (const file of manifest.requiredFiles)
    if (!observed.has(file))
      throw new Error(`required component file is missing: ${file}`);
}

export const verifyExtractedComponent = (
  root: string,
  manifest: ComponentManifest
): Promise<void> =>
  Promise.resolve().then(() => verifyExtractedComponentSync(root, manifest));
