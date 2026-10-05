import { createHash, verify as cryptoVerify } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync
} from "node:fs";
import { Readable } from "node:stream";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
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
const MAX_DEPTH = 128;
const MAX_DIRECTORIES = 100_000;
const MAX_TAR_BYTES = MAX_EXPANDED_BYTES + MAX_FILES * 1024 + 1024;

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
  typeof value === "string" &&
  /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}$/.test(value) &&
  value.split(".").every((part) => Number.isSafeInteger(Number(part)));
function versionParts(value: string): number[] | undefined {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(value)
  )
    return;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return;
  return [...parts, 0, 0].slice(0, 3);
}
function compareVersions(a: string, b: string): number | undefined {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return;
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}
function validRange(range: unknown): range is string {
  return (
    typeof range === "string" &&
    range.trim().length > 0 &&
    range.split(/\s+/).every((part) => {
      const match =
        /^(?:>=|>|<=|<|=)?((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2})$/.exec(
          part
        );
      return Boolean(match && versionParts(match[1]!));
    })
  );
}
function satisfies(version: string, range: string): boolean {
  return range.split(/\s+/).every((part) => {
    const match =
      /^(>=|>|<=|<|=)?((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2})$/.exec(part);
    if (!match) return false;
    const comparison = compareVersions(version, match[2]!);
    if (comparison === undefined) return false;
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
  const versionMatches = manifest.runtimes.filter(
    (item) =>
      item.kind === input.runtime.kind &&
      satisfies(input.runtime.version, item.runtimeRange) &&
      satisfies(input.runtime.nodeVersion, item.nodeRange)
  );
  if (!versionMatches.length)
    throw new Error("runtime version is incompatible");
  const abiMatches = versionMatches.filter(
    (item) =>
      item.modulesAbi === undefined ||
      item.modulesAbi === input.runtime.modulesAbi
  );
  if (!abiMatches.length) throw new Error("runtime ABI mismatch");
  const compatibility = abiMatches.find(
    (item) =>
      item.minimumNapi === undefined ||
      input.runtime.napiVersion >= item.minimumNapi
  );
  if (!compatibility) throw new Error("runtime N-API version is incompatible");
  if (manifest.target.libc) {
    const comparison = isVersion(input.runtime.libcVersion)
      ? compareVersions(
          input.runtime.libcVersion,
          manifest.target.libc.minimumVersion
        )
      : undefined;
    if (comparison === undefined || comparison < 0)
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
function* archiveChunks(archiveFd: number): Generator<Buffer> {
  let position = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = readSync(archiveFd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

async function* tarBlocks(
  stream: AsyncIterable<Buffer>
): AsyncGenerator<Buffer> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let totalBytes = 0;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 512) {
      totalBytes += 512;
      if (totalBytes > MAX_TAR_BYTES)
        throw new Error("component archive exceeds expanded size limit");
      yield pending.subarray(0, 512);
      pending = pending.subarray(512);
    }
  }
  if (pending.length)
    throw new Error("component archive has partial tar block");
}

async function verifyTarArchive(
  archiveFd: number,
  manifest: ComponentManifest
): Promise<void> {
  const contents = new Map<string, string>();
  const seenPaths = new Set<string>();
  let expandedBytes = 0;
  let zeroBlocks = 0;
  let ended = false;
  const gunzip = createGunzip();
  const archiveSource = Readable.from(archiveChunks(archiveFd));
  const blocks = tarBlocks(archiveSource.pipe(gunzip));
  try {
    for await (const header of blocks) {
      if (ended) {
        if (!header.every((byte) => byte === 0))
          throw new Error(
            "component archive contains data after tar terminator"
          );
        continue;
      }
      if (header.every((byte) => byte === 0)) {
        zeroBlocks++;
        if (zeroBlocks === 2) ended = true;
        continue;
      }
      if (zeroBlocks)
        throw new Error("component archive has incomplete tar terminator");
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
      const rawPath = prefix ? `${prefix}/${name}` : name;
      const path = rawPath.replace(/\/$/, "");
      safeRelativePath(path, "component archive path");
      const size = tarNumber(header, 124, 12);
      if (type === "5" && size !== 0)
        throw new Error("component directory tar entry must be empty");
      if (size > MAX_FILE_BYTES)
        throw new Error(
          "component archive entry exceeds individual file limit"
        );
      expandedBytes += size;
      if (expandedBytes > MAX_EXPANDED_BYTES)
        throw new Error("component archive exceeds expanded size limit");
      if (seenPaths.has(path))
        throw new Error(`duplicate component archive path: ${path}`);
      seenPaths.add(path);
      if (seenPaths.size > MAX_FILES)
        throw new Error("component archive exceeds file count limit");
      if (type === "5") continue;
      const digest = createHash("sha256");
      let remaining = size;
      while (remaining > 0) {
        const data = await blocks.next();
        if (data.done) throw new Error("component archive is truncated");
        const count = Math.min(remaining, 512);
        digest.update(data.value.subarray(0, count));
        remaining -= count;
      }
      contents.set(path, digest.digest("hex"));
    }
  } finally {
    archiveSource.destroy();
    gunzip.destroy();
  }
  if (!ended) throw new Error("component archive is missing tar terminator");
  for (const path of contents.keys()) {
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
  for (const [path, digest] of contents)
    if (!expected.has(path) || digest !== expected.get(path))
      throw new Error(`component archive file hash mismatch: ${path}`);
  for (const required of manifest.requiredFiles)
    if (!contents.has(required))
      throw new Error(`required component file is missing: ${required}`);
}

async function verifyComponentSync(
  input: ComponentVerificationInput
): Promise<ComponentManifest> {
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
  if (constants.O_NOFOLLOW === undefined)
    throw new Error("component archive no-follow access is unavailable");
  const archiveFd = openSync(
    input.archivePath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const opened = fstatSync(archiveFd);
    if (!opened.isFile() || !sameObject(stat, opened))
      throw new Error("component archive changed during verification");
    const archiveHash = createHash("sha256");
    for (const chunk of archiveChunks(archiveFd)) archiveHash.update(chunk);
    if (!sameArchiveState(opened, fstatSync(archiveFd)))
      throw new Error("component archive changed during verification");
    if (archiveHash.digest("hex") !== manifest.archive.sha256)
      throw new Error("component archive SHA-256 mismatch");
    await verifyTarArchive(archiveFd, manifest);
    if (!sameArchiveState(opened, fstatSync(archiveFd)))
      throw new Error("component archive changed during verification");
  } finally {
    closeSync(archiveFd);
  }
  return manifest;
}

export const verifyComponent = (
  input: ComponentVerificationInput
): Promise<ComponentManifest> => verifyComponentSync(input);

function hashFileDescriptor(fd: number): string {
  const digest = createHash("sha256");
  let position = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) return digest.digest("hex");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function sameObject(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameArchiveState(
  left: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  },
  right: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }
): boolean {
  return (
    sameObject(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

interface ExtractedTreeLimits {
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  maxDirectories: number;
  maxDepth: number;
  maxEntries: number;
}

const EXTRACTED_TREE_LIMITS: ExtractedTreeLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxExpandedBytes: MAX_EXPANDED_BYTES,
  maxFiles: MAX_FILES,
  maxDirectories: MAX_DIRECTORIES,
  maxDepth: MAX_DEPTH,
  maxEntries: MAX_FILES + MAX_DIRECTORIES
};

interface ExtractedTreeTestSeams {
  limits?: Partial<ExtractedTreeLimits>;
  beforeReadDirectory?: (path: string) => void;
  beforeOpenFile?: (path: string) => void;
}

function verifyExtractedComponentSync(
  root: string,
  manifest: ComponentManifest,
  seams: ExtractedTreeTestSeams = {}
): void {
  validateManifest(manifest);
  const canonicalRoot = resolve(root);
  const rootStat = lstatSync(canonicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("component root is not a regular directory");
  const observed = new Set<string>();
  const expectedFiles = new Map(
    manifest.files.map((file) => [file.path, file.sha256])
  );
  const limits = { ...EXTRACTED_TREE_LIMITS, ...seams.limits };
  const stack = [canonicalRoot];
  let directories = 0;
  let entries = 0;
  let totalBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    const beforeDirectory = lstatSync(current);
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink())
      throw new Error(
        "component directory ancestry changed during verification"
      );
    seams.beforeReadDirectory?.(current);
    const directoryEntries = readdirSync(current, { withFileTypes: true });
    for (const entry of directoryEntries) {
      if (++entries > limits.maxEntries)
        throw new Error("component tree exceeds entry count limit");
      const path = resolve(current, entry.name);
      const relativePath = relative(canonicalRoot, path).split(sep).join("/");
      safeRelativePath(relativePath, "extracted component path");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error(
          "component files must not contain links or special files"
        );
      if (stat.isDirectory()) {
        if (++directories > limits.maxDirectories)
          throw new Error("component tree exceeds directory count limit");
        const depth = relativePath.split("/").length;
        if (depth > limits.maxDepth)
          throw new Error("component tree exceeds directory depth limit");
        stack.push(path);
        continue;
      }
      if (stat.nlink > 1)
        throw new Error(
          "component files must not contain links or special files"
        );
      if (stat.size > limits.maxFileBytes)
        throw new Error("component file exceeds individual file limit");
      totalBytes += stat.size;
      if (totalBytes > limits.maxExpandedBytes)
        throw new Error("component tree exceeds expanded size limit");
      if (observed.size >= limits.maxFiles)
        throw new Error("component tree exceeds file count limit");
      observed.add(relativePath);
      const expectedHash = expectedFiles.get(relativePath);
      seams.beforeOpenFile?.(path);
      if (constants.O_NOFOLLOW === undefined)
        throw new Error("component file no-follow access is unavailable");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || !sameObject(stat, opened))
          throw new Error("component file changed during verification");
        const fileHash = hashFileDescriptor(fd);
        const after = fstatSync(fd);
        const afterPath = lstatSync(path);
        if (
          !sameArchiveState(opened, after) ||
          !sameArchiveState(after, afterPath)
        )
          throw new Error("component file changed during verification");
        if (!expectedHash || fileHash !== expectedHash)
          throw new Error(`component file hash mismatch: ${relativePath}`);
      } finally {
        closeSync(fd);
      }
    }
    if (!sameObject(beforeDirectory, lstatSync(current)))
      throw new Error(
        "component directory ancestry changed during verification"
      );
  }
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

export const verifyExtractedComponentWithTestSeams = (
  root: string,
  manifest: ComponentManifest,
  seams: ExtractedTreeTestSeams
): Promise<void> =>
  Promise.resolve().then(() =>
    verifyExtractedComponentSync(root, manifest, seams)
  );
