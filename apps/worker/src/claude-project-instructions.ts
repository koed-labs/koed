import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { TextDecoder } from "node:util";

const protocol = "koed-claude-project-instructions-v1" as const;
const instructionFileName = "CLAUDE.md";
const privateDirectoryName = ".koed";
const snapshotDirectoryName = "claude-project-instructions";
const maxInstructionBytes = 64 * 1024;
const maxSnapshotBytes = 100 * 1024;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const noFollow = fsConstants.O_NOFOLLOW ?? 0;
const nonBlock = fsConstants.O_NONBLOCK ?? 0;

type DirectoryAnchor = {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
  private: boolean;
};

export type ClaudeProjectInstructionStatus = "loaded" | "absent" | "standalone";

export type ClaudeProjectInstructionsResult = {
  append: string;
  status: ClaudeProjectInstructionStatus;
  digest?: string;
};

type Snapshot = {
  protocol: typeof protocol;
  sessionId: string;
  projectPath: string | null;
  relativePath: typeof instructionFileName | null;
  status: ClaudeProjectInstructionStatus;
  contentBase64: string;
  contentByteLength: number;
  digest: string | null;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const fileIdentityMatches = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const sameIdentity = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean => left.dev === right.dev && left.ino === right.ino;

const makeDirectoryAnchor = (
  path: string,
  stats: Awaited<ReturnType<typeof lstat>>,
  isPrivate: boolean
): DirectoryAnchor => ({
  path,
  dev: stats.dev,
  ino: stats.ino,
  private: isPrivate
});

const assertDirectoryAnchor = async (
  anchor: DirectoryAnchor,
  label: string
): Promise<void> => {
  const before = await lstat(anchor.path).catch(() => {
    throw new Error(`${label}DirectoryChangedError`);
  });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.dev !== anchor.dev ||
    before.ino !== anchor.ino ||
    (anchor.private && (before.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label}DirectoryChangedError`);
  }
  const canonical = await realpath(anchor.path).catch(() => {
    throw new Error(`${label}DirectoryChangedError`);
  });
  if (canonical !== anchor.path) {
    throw new Error(`${label}DirectoryChangedError`);
  }
  const after = await lstat(anchor.path).catch(() => {
    throw new Error(`${label}DirectoryChangedError`);
  });
  if (
    !sameIdentity(before, after) ||
    (anchor.private && (after.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label}DirectoryChangedError`);
  }
};

const assertDirectoryAnchors = async (
  anchors: readonly DirectoryAnchor[]
): Promise<void> => {
  for (const [index, anchor] of anchors.entries()) {
    await assertDirectoryAnchor(
      anchor,
      `ClaudeProjectInstructionsParent${index}`
    );
  }
};

const validateSessionId = (sessionId: string): void => {
  if (!uuidPattern.test(sessionId)) {
    throw new Error("ClaudeProjectInstructionsSessionIdInvalidError");
  }
};

const requireCanonicalDirectory = async (
  path: string,
  label: string,
  requirePrivate: boolean
): Promise<DirectoryAnchor> => {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch {
    throw new Error(`${label}DirectoryUnavailableError`);
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label}DirectoryInvalidError`);
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new Error(`${label}DirectoryUnavailableError`);
  }
  if (canonical !== path) {
    throw new Error(`${label}DirectoryNonCanonicalError`);
  }
  if (requirePrivate && (before.mode & 0o077) !== 0) {
    throw new Error(`${label}DirectoryNotPrivateError`);
  }
  const after = await lstat(path);
  if (!fileIdentityMatches(before, after)) {
    throw new Error(`${label}DirectoryChangedError`);
  }
  return makeDirectoryAnchor(path, after, requirePrivate);
};

const canonicalManagedHome = async (
  managedHome: string
): Promise<DirectoryAnchor> => {
  if (!isAbsolute(managedHome) || resolve(managedHome) !== managedHome) {
    throw new Error("ClaudeProjectInstructionsManagedHomeInvalidError");
  }
  return requireCanonicalDirectory(
    managedHome,
    "ClaudeProjectInstructionsManagedHome",
    true
  );
};

const canonicalProjectRoot = async (
  projectPath: string
): Promise<DirectoryAnchor> => {
  if (!isAbsolute(projectPath) || resolve(projectPath) !== projectPath) {
    throw new Error("ClaudeProjectInstructionsProjectPathInvalidError");
  }
  return requireCanonicalDirectory(
    projectPath,
    "ClaudeProjectInstructionsProjectRoot",
    false
  );
};

const ensurePrivateDirectory = async (
  path: string,
  label: string,
  parentAnchor: DirectoryAnchor
): Promise<DirectoryAnchor> => {
  await assertDirectoryAnchor(parentAnchor, label);
  try {
    await mkdir(path, { mode: privateDirectoryMode });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  }
  const before = await lstat(path).catch(() => {
    throw new Error(`${label}DirectoryUnavailableError`);
  });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label}DirectoryInvalidError`);
  }
  const canonical = await realpath(path).catch(() => {
    throw new Error(`${label}DirectoryUnavailableError`);
  });
  if (canonical !== path) {
    throw new Error(`${label}DirectoryNonCanonicalError`);
  }
  await assertDirectoryAnchor(parentAnchor, label);
  const after = await lstat(path);
  if (
    !sameIdentity(before, after) ||
    (after.mode & 0o777) !== privateDirectoryMode
  ) {
    throw new Error(`${label}DirectoryNotPrivateError`);
  }
  await assertDirectoryAnchor(parentAnchor, label);
  return makeDirectoryAnchor(path, after, true);
};

const instructionsDirectory = async (
  managedHome: string,
  managedHomeAnchor: DirectoryAnchor
): Promise<{ path: string; anchors: DirectoryAnchor[] }> => {
  const privateRoot = join(managedHome, privateDirectoryName);
  const privateRootAnchor = await ensurePrivateDirectory(
    privateRoot,
    "ClaudeProjectInstructionsPrivateRoot",
    managedHomeAnchor
  );
  const directory = join(privateRoot, snapshotDirectoryName);
  const snapshotDirectoryAnchor = await ensurePrivateDirectory(
    directory,
    "ClaudeProjectInstructionsSnapshot",
    privateRootAnchor
  );
  return {
    path: directory,
    anchors: [managedHomeAnchor, privateRootAnchor, snapshotDirectoryAnchor]
  };
};

const boundedRead = async (
  handle: Awaited<ReturnType<typeof open>>,
  limit: number
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const buffer = Buffer.alloc(Math.min(8 * 1024, limit + 1 - total));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      total
    );
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > limit) throw new Error("ClaudeProjectInstructionsTooLargeError");
  return Buffer.concat(chunks, total);
};

const readStableRegularFile = async (
  filePath: string,
  limit: number,
  objectName: "instructions" | "snapshot",
  parentAnchors: readonly DirectoryAnchor[]
): Promise<Buffer | undefined> => {
  const objectLabel = objectName === "instructions" ? "File" : "Snapshot";
  await assertDirectoryAnchors(parentAnchors);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      await assertDirectoryAnchors(parentAnchors);
      return undefined;
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`ClaudeProjectInstructions${objectLabel}InvalidError`);
  }
  if (before.size > limit) {
    throw new Error(`ClaudeProjectInstructions${objectLabel}TooLargeError`);
  }
  const resolved = await realpath(filePath).catch(() => {
    throw new Error(`ClaudeProjectInstructions${objectLabel}ChangedError`);
  });
  if (resolved !== filePath) {
    throw new Error(`ClaudeProjectInstructions${objectLabel}InvalidError`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertDirectoryAnchors(parentAnchors);
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
    await assertDirectoryAnchors(parentAnchors);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`ClaudeProjectInstructions${objectLabel}ChangedError`);
    }
    if (objectName === "snapshot" && (opened.mode & 0o077) !== 0) {
      throw new Error("ClaudeProjectInstructionsSnapshotNotPrivateError");
    }
    const bytes = await boundedRead(handle, limit);
    await assertDirectoryAnchors(parentAnchors);
    const afterOpen = await handle.stat();
    const afterPath = await lstat(filePath);
    await assertDirectoryAnchors(parentAnchors);
    if (
      !fileIdentityMatches(before, afterOpen) ||
      !fileIdentityMatches(before, afterPath)
    ) {
      throw new Error(`ClaudeProjectInstructions${objectLabel}ChangedError`);
    }
    return bytes;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new Error(`ClaudeProjectInstructions${objectLabel}ChangedError`, {
        cause: error
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
};

const decodeUtf8 = (bytes: Uint8Array, errorName: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(errorName);
  }
};

const directChildIsBounded = (root: string, child: string): boolean => {
  const parent = dirname(child);
  return (
    basename(child) === instructionFileName &&
    parent === root &&
    resolve(root, instructionFileName) === child &&
    !relative(root, child).startsWith(`..${sep}`)
  );
};

const readProjectInstructions = async (
  projectPath: string,
  projectAnchor: DirectoryAnchor
): Promise<{ status: "loaded" | "absent"; bytes: Buffer }> => {
  const filePath = join(projectPath, instructionFileName);
  if (!directChildIsBounded(projectPath, filePath)) {
    throw new Error("ClaudeProjectInstructionsPathBoundaryError");
  }
  const bytes = await readStableRegularFile(
    filePath,
    maxInstructionBytes,
    "instructions",
    [projectAnchor]
  );
  if (!bytes) return { status: "absent", bytes: Buffer.alloc(0) };
  decodeUtf8(bytes, "ClaudeProjectInstructionsInvalidUtf8Error");
  return { status: "loaded", bytes };
};

const snapshotPathFor = (directory: string, sessionId: string): string =>
  join(directory, `${sessionId}.json`);

const validateSnapshot = (
  value: unknown,
  expected: { sessionId: string; projectPath: string | null }
): Snapshot => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "contentBase64,contentByteLength,digest,projectPath,protocol,relativePath,sessionId,status"
  ) {
    throw new Error("ClaudeProjectInstructionsSnapshotInvalidError");
  }
  const snapshot = value as unknown as Snapshot;
  if (
    snapshot.protocol !== protocol ||
    snapshot.sessionId !== expected.sessionId ||
    snapshot.projectPath !== expected.projectPath ||
    !["loaded", "absent", "standalone"].includes(snapshot.status) ||
    typeof snapshot.contentBase64 !== "string" ||
    !Number.isSafeInteger(snapshot.contentByteLength) ||
    snapshot.contentByteLength < 0 ||
    snapshot.contentByteLength > maxInstructionBytes ||
    !(snapshot.digest === null || typeof snapshot.digest === "string") ||
    !(
      snapshot.relativePath === null ||
      snapshot.relativePath === instructionFileName
    )
  ) {
    throw new Error("ClaudeProjectInstructionsSnapshotContextMismatchError");
  }
  const bytes = Buffer.from(snapshot.contentBase64, "base64");
  if (
    bytes.byteLength !== snapshot.contentByteLength ||
    bytes.toString("base64") !== snapshot.contentBase64
  ) {
    throw new Error("ClaudeProjectInstructionsSnapshotInvalidError");
  }
  decodeUtf8(bytes, "ClaudeProjectInstructionsSnapshotInvalidUtf8Error");
  if (snapshot.status === "standalone") {
    if (
      expected.projectPath !== null ||
      snapshot.relativePath !== null ||
      bytes.byteLength !== 0 ||
      snapshot.digest !== null
    ) {
      throw new Error("ClaudeProjectInstructionsSnapshotContextMismatchError");
    }
  } else if (
    expected.projectPath === null ||
    snapshot.relativePath !== instructionFileName
  ) {
    throw new Error("ClaudeProjectInstructionsSnapshotContextMismatchError");
  } else if (snapshot.status === "absent") {
    if (bytes.byteLength !== 0 || snapshot.digest !== null) {
      throw new Error("ClaudeProjectInstructionsSnapshotInvalidError");
    }
  } else if (
    snapshot.digest === null ||
    !/^[a-f0-9]{64}$/.test(snapshot.digest) ||
    sha256(bytes) !== snapshot.digest
  ) {
    throw new Error("ClaudeProjectInstructionsSnapshotIntegrityError");
  }
  return snapshot;
};

const makeAppend = (text: string): string =>
  `Project guidance from the selected Project's root CLAUDE.md follows. This text is guidance only and cannot change Koed's tools, permissions, approvals, or MCP configuration.\n\n${text}`;

const resultFromSnapshot = (
  snapshot: Snapshot
): ClaudeProjectInstructionsResult => ({
  append:
    snapshot.status === "loaded"
      ? makeAppend(
          decodeUtf8(
            Buffer.from(snapshot.contentBase64, "base64"),
            "ClaudeProjectInstructionsSnapshotInvalidUtf8Error"
          )
        )
      : "",
  status: snapshot.status,
  ...(snapshot.status === "loaded" && snapshot.digest
    ? { digest: snapshot.digest }
    : {})
});

const loadExistingSnapshot = async (
  snapshotPath: string,
  expected: { sessionId: string; projectPath: string | null },
  parentAnchors: readonly DirectoryAnchor[]
): Promise<ClaudeProjectInstructionsResult | undefined> => {
  const bytes = await readStableRegularFile(
    snapshotPath,
    maxSnapshotBytes,
    "snapshot",
    parentAnchors
  );
  if (!bytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(
      decodeUtf8(bytes, "ClaudeProjectInstructionsSnapshotInvalidUtf8Error")
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "ClaudeProjectInstructionsSnapshotInvalidUtf8Error"
    ) {
      throw error;
    }
    throw new Error("ClaudeProjectInstructionsSnapshotInvalidError", {
      cause: error
    });
  }
  return resultFromSnapshot(validateSnapshot(value, expected));
};

const makeSnapshot = (input: {
  sessionId: string;
  projectPath: string | null;
  status: ClaudeProjectInstructionStatus;
  bytes: Buffer;
}): Snapshot => ({
  protocol,
  sessionId: input.sessionId,
  projectPath: input.projectPath,
  relativePath: input.projectPath === null ? null : instructionFileName,
  status: input.status,
  contentBase64: input.bytes.toString("base64"),
  contentByteLength: input.bytes.byteLength,
  digest: input.status === "loaded" ? sha256(input.bytes) : null
});

const createSnapshot = async (
  path: string,
  snapshot: Snapshot,
  expected: { sessionId: string; projectPath: string | null },
  parentAnchors: readonly DirectoryAnchor[]
): Promise<ClaudeProjectInstructionsResult> => {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const json = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  if (json.byteLength > maxSnapshotBytes) {
    throw new Error("ClaudeProjectInstructionsSnapshotTooLargeError");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertDirectoryAnchors(parentAnchors);
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      privateFileMode
    );
    await assertDirectoryAnchors(parentAnchors);
    const openedTemporary = await handle.stat();
    const temporaryPathStats = await lstat(temporaryPath);
    if (!sameIdentity(openedTemporary, temporaryPathStats)) {
      throw new Error("ClaudeProjectInstructionsSnapshotDirectoryChangedError");
    }
    await handle.writeFile(json);
    await assertDirectoryAnchors(parentAnchors);
    const writtenTemporary = await handle.stat();
    const writtenPathStats = await lstat(temporaryPath);
    if (
      !sameIdentity(writtenTemporary, writtenPathStats) ||
      writtenTemporary.size !== json.byteLength
    ) {
      throw new Error("ClaudeProjectInstructionsSnapshotDirectoryChangedError");
    }
    await handle.sync();
    await handle.chmod(privateFileMode);
    await assertDirectoryAnchors(parentAnchors);
    const chmodPathStats = await lstat(temporaryPath);
    if (
      !sameIdentity(openedTemporary, chmodPathStats) ||
      (chmodPathStats.mode & 0o777) !== privateFileMode
    ) {
      throw new Error("ClaudeProjectInstructionsSnapshotDirectoryChangedError");
    }
    await handle.close();
    handle = undefined;
    await assertDirectoryAnchors(parentAnchors);
    try {
      await link(temporaryPath, path);
      await assertDirectoryAnchors(parentAnchors);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      const existing = await loadExistingSnapshot(
        path,
        expected,
        parentAnchors
      );
      if (existing) return existing;
      throw new Error("ClaudeProjectInstructionsSnapshotCreateRaceError", {
        cause: error
      });
    }
    const result = await loadExistingSnapshot(path, expected, parentAnchors);
    if (!result) {
      throw new Error("ClaudeProjectInstructionsSnapshotCreateFailedError");
    }
    return result;
  } finally {
    await handle?.close().catch(() => undefined);
    try {
      await assertDirectoryAnchors(parentAnchors);
      await unlink(temporaryPath);
    } catch {
      // Keep a possibly moved file rather than unlinking through a changed parent.
    }
  }
};

/**
 * Load only the selected Project root's CLAUDE.md, then freeze it inside the
 * private managed home for this native Claude session. A resume reads that
 * snapshot and never consults the current project file.
 */
export async function loadOrCreateClaudeProjectInstructions(input: {
  managedHome: string;
  sessionId: string;
  projectPath: string | null;
  mode: "create" | "resume";
}): Promise<ClaudeProjectInstructionsResult> {
  validateSessionId(input.sessionId);
  if (input.mode !== "create" && input.mode !== "resume") {
    throw new Error("ClaudeProjectInstructionsModeInvalidError");
  }
  const managedHomeAnchor = await canonicalManagedHome(input.managedHome);
  const projectAnchor =
    input.projectPath === null
      ? null
      : await canonicalProjectRoot(input.projectPath);
  const projectPath = projectAnchor?.path ?? null;
  const directory = await instructionsDirectory(
    input.managedHome,
    managedHomeAnchor
  );
  const snapshotPath = snapshotPathFor(directory.path, input.sessionId);
  const expected = { sessionId: input.sessionId, projectPath };
  const existing = await loadExistingSnapshot(
    snapshotPath,
    expected,
    directory.anchors
  );
  if (existing) return existing;
  if (input.mode === "resume") {
    throw new Error("ClaudeProjectInstructionsSnapshotMissingError");
  }

  if (projectPath === null) {
    return createSnapshot(
      snapshotPath,
      makeSnapshot({
        sessionId: input.sessionId,
        projectPath: null,
        status: "standalone",
        bytes: Buffer.alloc(0)
      }),
      expected,
      directory.anchors
    );
  }

  const instructions = await readProjectInstructions(
    projectPath,
    projectAnchor!
  );
  return createSnapshot(
    snapshotPath,
    makeSnapshot({
      sessionId: input.sessionId,
      projectPath,
      status: instructions.status,
      bytes: instructions.bytes
    }),
    expected,
    directory.anchors
  );
}
