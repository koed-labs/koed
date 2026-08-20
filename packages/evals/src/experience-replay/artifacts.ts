import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";

const MAX_ARTIFACT_PATH_BYTES = 4_096;
const MAX_JSON_ARTIFACT_BYTES = 512 * 1024 * 1024;

export const isPathInside = (candidate: string, parent: string): boolean => {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const pathParts = (candidate: string): string[] =>
  candidate.split(/[\\/]+/u).filter(Boolean);

export const assertBoundedPath = (candidate: string, label: string): void => {
  if (candidate.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  if (Buffer.byteLength(candidate) > MAX_ARTIFACT_PATH_BYTES) {
    throw new Error(`${label} is too long`);
  }
  if (pathParts(candidate).some((part) => Buffer.byteLength(part) > 255)) {
    throw new Error(`${label} contains an overlong component`);
  }
};

export const assertNoDotPathComponents = (
  candidate: string,
  label: string
): void => {
  if (pathParts(candidate).some((part) => part === "." || part === "..")) {
    throw new Error(`${label} must not contain dot path components`);
  }
};

/**
 * Checks the spelling supplied by the caller, rather than only its realpath.
 * This closes ordinary symlink aliases. Node has no portable openat/openat2 API,
 * so a hostile process able to rename a checked parent and restore it between
 * these checks can still win a pathname race. Every sensitive leaf is therefore
 * also opened with O_NOFOLLOW (where available), fstat'ed, and revalidated.
 */
export const assertNoSymlinkComponents = async (
  candidate: string,
  stopAt = path.parse(path.resolve(candidate)).root
): Promise<void> => {
  const absolute = path.resolve(candidate);
  const stop = path.resolve(stopAt);
  if (!isPathInside(absolute, stop)) {
    throw new Error(`Path ${absolute} is outside checked root ${stop}`);
  }
  const relative = path.relative(stop, absolute);
  let current = stop;
  const components = relative ? relative.split(path.sep) : [];
  const paths = [
    stop,
    ...components.map((component) => (current = path.join(current, component)))
  ];
  for (const componentPath of paths) {
    const metadata = await lstat(componentPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Path contains a symlink component: ${componentPath}`);
    }
  }
};

export const validateArtifactRelativePath = (value: string): string => {
  assertBoundedPath(value, "Artifact path");
  if (!value || path.isAbsolute(value)) {
    throw new Error("Artifact path must be a non-empty relative path");
  }
  assertNoDotPathComponents(value, "Artifact path");
  const normalized = path.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Artifact path must remain inside the run directory");
  }
  return normalized;
};

const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

export const assertRegularFile = async (
  handle: FileHandle,
  label: string
): Promise<void> => {
  if (!(await handle.stat()).isFile())
    throw new Error(`${label} is not a regular file`);
};

export const readTextFileNoFollow = async (
  filePath: string,
  maximumBytes: number
): Promise<string> => {
  assertBoundedPath(filePath, "Artifact path");
  assertNoDotPathComponents(filePath, "Artifact path");
  await assertNoSymlinkComponents(filePath);
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    await assertRegularFile(handle, "Artifact");
    const before = await handle.stat();
    const beforePath = await lstat(filePath);
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error("Artifact pathname changed before it was read");
    }
    if (before.size > maximumBytes)
      throw new Error("Artifact exceeds the read limit");
    const contents = await handle.readFile("utf8");
    if (Buffer.byteLength(contents) > maximumBytes) {
      throw new Error("Artifact exceeds the read limit");
    }
    await assertNoSymlinkComponents(filePath);
    const after = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== afterPath.dev ||
      after.ino !== afterPath.ino
    ) {
      throw new Error("Artifact changed while being read");
    }
    return contents;
  } finally {
    await handle.close();
  }
};

export const validateExistingRunDirectory = async (
  runDirectory: string,
  repositoryRoot: string
): Promise<string> => {
  assertBoundedPath(runDirectory, "Benchmark run path");
  assertNoDotPathComponents(runDirectory, "Benchmark run path");
  const requested = path.resolve(runDirectory);
  await assertNoSymlinkComponents(requested);
  const run = await realpath(requested);
  if (run !== requested) {
    throw new Error("Benchmark run path must not contain symlink components");
  }
  const repository = await realpath(repositoryRoot);
  if (isPathInside(run, repository)) {
    throw new Error("Benchmark run must be outside the repository");
  }
  const handle = await open(
    run,
    constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory())
      throw new Error("Benchmark run path is not a directory");
    await assertNoSymlinkComponents(requested);
    const current = await lstat(requested);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("Benchmark run path changed during validation");
    }
  } finally {
    await handle.close();
  }
  return run;
};

export const readJsonArtifact = async <T>(
  runRoot: string,
  relativePath: string
): Promise<T> => {
  const relative = validateArtifactRelativePath(relativePath);
  const root = path.resolve(runRoot);
  const candidate = path.join(root, relative);
  if (!isPathInside(candidate, root)) {
    throw new Error("Artifact read must remain inside the run directory");
  }
  await assertNoSymlinkComponents(candidate, root);
  return JSON.parse(
    await readTextFileNoFollow(candidate, MAX_JSON_ARTIFACT_BYTES)
  ) as T;
};

export const writeTextArtifactAtomic = async (
  runRoot: string,
  relativePath: string,
  contents: string
): Promise<void> => {
  const relative = validateArtifactRelativePath(relativePath);
  const root = path.resolve(runRoot);
  const destination = path.join(root, relative);
  if (!isPathInside(destination, root)) {
    throw new Error("Artifact write must remain inside the run directory");
  }
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(parent, root);
  const canonicalParent = await realpath(parent);
  if (
    canonicalParent !== path.resolve(parent) ||
    !isPathInside(canonicalParent, root)
  ) {
    throw new Error("Artifact escaped the run directory or used a symlink");
  }
  const rootHandle = await open(
    root,
    constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
  );
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${randomUUID()}.tmp`
  );
  let parentHandle: FileHandle | undefined;
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  let cleanupError: unknown;
  try {
    parentHandle = await open(
      parent,
      constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
    );
    const rootStats = await rootHandle.stat();
    const parentStats = await parentHandle.stat();
    if (!rootStats.isDirectory() || !parentStats.isDirectory()) {
      throw new Error("Artifact root and parent must be directories");
    }
    await parentHandle.chmod(0o700);
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    );
    temporaryCreated = true;
    await assertRegularFile(handle, "Temporary artifact");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await assertNoSymlinkComponents(parent, root);
    const temporaryStats = await handle.stat();
    const temporaryPathStats = await lstat(temporary);
    if (
      !temporaryPathStats.isFile() ||
      temporaryStats.dev !== temporaryPathStats.dev ||
      temporaryStats.ino !== temporaryPathStats.ino
    ) {
      throw new Error("Temporary artifact pathname changed before publication");
    }
    // link(2) publishes atomically and, unlike rename(2), never replaces an
    // existing artifact. Both names are in the already-validated parent.
    await link(temporary, destination);
    const destinationStats = await lstat(destination);
    if (
      !destinationStats.isFile() ||
      temporaryStats.dev !== destinationStats.dev ||
      temporaryStats.ino !== destinationStats.ino
    ) {
      throw new Error(
        "Published artifact does not match the opened temporary file"
      );
    }
    const currentRoot = await lstat(root);
    const currentParent = await lstat(parent);
    if (
      rootStats.dev !== currentRoot.dev ||
      rootStats.ino !== currentRoot.ino ||
      parentStats.dev !== currentParent.dev ||
      parentStats.ino !== currentParent.ino
    ) {
      throw new Error("Artifact path changed during atomic publication");
    }
  } finally {
    await handle?.close();
    if (temporaryCreated) {
      try {
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupError = error;
        }
      }
    }
    await parentHandle?.close();
    await rootHandle.close();
  }
  if (cleanupError) throw cleanupError;
};
