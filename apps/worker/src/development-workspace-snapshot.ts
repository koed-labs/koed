import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const protocol = "koed-development-workspace-snapshot-v1" as const;
const maxFileBytes = 32 * 1024 * 1024;
const maxPackageBytes = 256 * 1024 * 1024;
const maxFiles = 25_000;
const secretPathPattern =
  /(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|credentials$|\.npmrc$|\.pypirc$|service-account[^/]*\.json$)/i;
const environmentTemplatePathPattern =
  /(^|\/)\.env(?:\.[^/]*)?\.(?:example|sample|template)$/i;
const secretContentPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{20,}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/
] as const;

type GitResult = { stdout: string; stderr: string };
type GitBufferResult = { stdout: Buffer; stderr: Buffer };

function git(
  cwd: string,
  args: readonly string[],
  options: { encoding: "buffer"; maxBuffer?: number }
): Promise<GitBufferResult>;
function git(
  cwd: string,
  args: readonly string[],
  options?: { encoding?: BufferEncoding; maxBuffer?: number }
): Promise<GitResult>;
async function git(
  cwd: string,
  args: readonly string[],
  options: { encoding?: BufferEncoding | "buffer"; maxBuffer?: number } = {}
): Promise<GitResult | GitBufferResult> {
  const encoding = options.encoding ?? "utf8";
  const result = await execFileAsync(
    "git",
    [
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      `core.askPass=${devNull}`,
      "-c",
      "protocol.file.allow=always",
      ...args
    ],
    {
      cwd,
      encoding: encoding === "buffer" ? "buffer" : encoding,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: devNull,
        SSH_ASKPASS: devNull,
        GIT_SSH_COMMAND: "false",
        GIT_ALLOW_PROTOCOL: "file"
      },
      maxBuffer: options.maxBuffer ?? maxPackageBytes
    }
  );
  return result as GitResult | GitBufferResult;
}

const gitBufferWithInput = (
  cwd: string,
  args: readonly string[],
  input: Uint8Array
): Promise<Buffer> =>
  new Promise((resolveResult, reject) => {
    const child = execFile(
      "git",
      [
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "credential.helper=",
        "-c",
        `core.askPass=${devNull}`,
        "-c",
        "protocol.file.allow=always",
        ...args
      ],
      {
        cwd,
        encoding: "buffer",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: devNull,
          SSH_ASKPASS: devNull,
          GIT_SSH_COMMAND: "false",
          GIT_ALLOW_PROTOCOL: "file"
        },
        maxBuffer: maxPackageBytes + maxFiles * 128
      },
      (error, stdout) => {
        if (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("WorkspaceSnapshotGitBatchError")
          );
        } else {
          resolveResult(stdout);
        }
      }
    );
    child.stdin?.end(input);
  });

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
};

const normalizedRelativePath = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("WorkspaceSnapshotPathError");
  }
  return normalized;
};

const decodeBase64 = (value: unknown): Buffer => {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(maxPackageBytes / 3) * 4
  ) {
    throw new Error("WorkspaceSnapshotEncodingError");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength > maxPackageBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new Error("WorkspaceSnapshotEncodingError");
  }
  return decoded;
};

const assertSafeDestination = (
  root: string,
  relativePath: string
): Promise<string> => {
  const normalized = normalizedRelativePath(relativePath);
  const target = resolve(root, ...normalized.split("/"));
  if (!target.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error("WorkspaceSnapshotPathTraversalError");
  }
  return Promise.resolve(target);
};

const assertTrustedDirectory = async (
  path: string,
  expectedDevice?: bigint
): Promise<{ path: string; device: bigint }> => {
  const resolved = resolve(path);
  const canonicalPath = await realpath(resolved);
  if (canonicalPath !== resolved) {
    throw new Error("WorkspaceSnapshotUnsafeDirectoryError");
  }
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("WorkspaceSnapshotUnsafeDirectoryError");
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== BigInt(process.getuid())
  ) {
    throw new Error("WorkspaceSnapshotDirectoryOwnerError");
  }
  if (expectedDevice !== undefined && metadata.dev !== expectedDevice) {
    throw new Error("WorkspaceSnapshotFilesystemBoundaryError");
  }
  return { path: resolved, device: metadata.dev };
};

const prepareTrustedDestination = async (
  trustedRootPath: string,
  targetPath: string
): Promise<{ root: string; target: string; device: bigint }> => {
  const trustedRoot = resolve(trustedRootPath);
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await chmod(trustedRoot, 0o700);
  const root = await assertTrustedDirectory(trustedRoot);
  const target = resolve(targetPath);
  const targetRelative = relative(root.path, target);
  if (
    !targetRelative ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    resolve(root.path, targetRelative) !== target
  ) {
    throw new Error("WorkspaceSnapshotPathTraversalError");
  }
  let current = root.path;
  for (const part of targetRelative.split(sep).slice(0, -1)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    await assertTrustedDirectory(current, root.device);
  }
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error("WorkspaceSnapshotTargetExistsError", { cause: error });
    }
    throw error;
  }
  await assertTrustedDirectory(target, root.device);
  return { root: root.path, target, device: root.device };
};

const writeExclusiveFile = async (
  path: string,
  bytes: Uint8Array,
  mode: number
): Promise<void> => {
  const handle = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    mode
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const assertNoSecrets = (path: string, bytes: Uint8Array): void => {
  if (
    secretPathPattern.test(path) &&
    !environmentTemplatePathPattern.test(path)
  ) {
    throw new Error("WorkspaceSnapshotSecretPathError");
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (secretContentPatterns.some((pattern) => pattern.test(text))) {
    throw new Error("WorkspaceSnapshotSecretContentError");
  }
};

const assertPortableBlob = (path: string, content: Buffer): void => {
  if (
    content
      .subarray(0, 128)
      .toString("utf8")
      .startsWith("version https://git-lfs.github.com/spec/v1\n")
  ) {
    throw new Error("WorkspaceSnapshotLfsUnsupportedError");
  }
  assertNoSecrets(normalizedRelativePath(path), content);
};

const gitText = async (cwd: string, args: readonly string[]): Promise<string> =>
  ((await git(cwd, args)) as GitResult).stdout.trim();

const assertStableRepository = async (root: string): Promise<void> => {
  const gitDir = await gitText(root, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = await gitText(root, ["rev-parse", "--git-common-dir"]);
  const resolvedGitDir = await realpath(resolve(root, gitDir));
  const resolvedCommonDir = await realpath(resolve(root, commonDir));
  const activeMarkers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer"
  ];
  for (const operationRoot of new Set([resolvedGitDir, resolvedCommonDir])) {
    for (const marker of activeMarkers) {
      try {
        await lstat(resolve(operationRoot, marker));
        throw new Error("WorkspaceSnapshotActiveGitOperationError");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "WorkspaceSnapshotActiveGitOperationError"
        ) {
          throw error;
        }
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }
  const unmerged = await gitText(root, ["ls-files", "--unmerged"]);
  if (unmerged) throw new Error("WorkspaceSnapshotUnmergedIndexError");
  const indexTags = await gitText(root, ["ls-files", "-v"]);
  if (
    indexTags
      .split("\n")
      .filter(Boolean)
      .some((line) => line[0] !== "H")
  ) {
    throw new Error("WorkspaceSnapshotIndexFlagsError");
  }
  const sparse = await gitText(root, [
    "config",
    "--bool",
    "core.sparseCheckout"
  ]).catch(() => "");
  if (sparse === "true")
    throw new Error("WorkspaceSnapshotSparseCheckoutError");
  const partial = await gitText(root, [
    "config",
    "--get-regexp",
    "^remote\\..*\\.promisor$"
  ]).catch(() => "");
  if (partial) throw new Error("WorkspaceSnapshotPartialCloneError");
  const alternates = resolve(
    resolvedCommonDir,
    "objects",
    "info",
    "alternates"
  );
  try {
    if ((await stat(alternates)).size > 0) {
      throw new Error("WorkspaceSnapshotAlternatesError");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "WorkspaceSnapshotAlternatesError"
    ) {
      throw error;
    }
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const gitlinks = await gitText(root, ["ls-files", "--stage"]);
  if (gitlinks.split("\n").some((line) => line.startsWith("160000 "))) {
    throw new Error("WorkspaceSnapshotSubmoduleError");
  }
  const trackedPaths = (
    await git(root, ["ls-files", "-z"], { encoding: "buffer" })
  ).stdout;
  if (trackedPaths.byteLength > 0) {
    const attributes = await new Promise<Buffer>((resolveResult, reject) => {
      const child = execFile(
        "git",
        [
          "-c",
          `core.hooksPath=${devNull}`,
          "-c",
          "core.fsmonitor=false",
          "check-attr",
          "--all",
          "-z",
          "--stdin"
        ],
        {
          cwd: root,
          encoding: "buffer",
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: devNull,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: devNull,
            SSH_ASKPASS: devNull,
            GIT_SSH_COMMAND: "false",
            GIT_ALLOW_PROTOCOL: "file"
          },
          maxBuffer: maxPackageBytes
        },
        (error, stdout) => {
          if (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("WorkspaceSnapshotGitAttributeError")
            );
          } else resolveResult(stdout);
        }
      );
      child.stdin?.end(trackedPaths);
    });
    const values = attributes.toString("utf8").split("\0");
    for (let index = 0; index + 2 < values.length; index += 3) {
      const attribute = values[index + 1];
      const value = values[index + 2];
      if (
        (attribute === "filter" || attribute === "working-tree-encoding") &&
        value !== "unspecified" &&
        value !== "unset"
      ) {
        throw new Error("WorkspaceSnapshotContentTransformUnsupportedError");
      }
    }
  }
};

const assertSupportedWorkspaceShape = async (root: string): Promise<void> => {
  const listPaths = async (args: readonly string[]): Promise<string[]> =>
    (
      await git(root, args, {
        encoding: "buffer"
      })
    ).stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  const trackedPaths = await listPaths(["ls-files", "--cached", "-z"]);
  const untrackedPaths = await listPaths([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);
  if (new Set([...trackedPaths, ...untrackedPaths]).size > maxFiles) {
    throw new Error("WorkspaceSnapshotFileCountError");
  }
  const checkedDirectories = new Set<string>();
  const assertPath = async (
    rawPath: string,
    allowTrackedDeletion: boolean
  ): Promise<void> => {
    if (rawPath.endsWith("/")) {
      throw new Error("WorkspaceSnapshotNestedRepositoryError");
    }
    const path = normalizedRelativePath(rawPath);
    const absolute = await assertSafeDestination(root, path);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (
        allowTrackedDeletion &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    let parent = dirname(absolute);
    while (parent !== root && !checkedDirectories.has(parent)) {
      const parentMetadata = await lstat(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
        throw new Error("WorkspaceSnapshotUnsupportedFileError");
      }
      checkedDirectories.add(parent);
      parent = dirname(parent);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("WorkspaceSnapshotSymlinkUnsupportedError");
    }
    if (!metadata.isFile()) {
      throw new Error("WorkspaceSnapshotUnsupportedFileError");
    }
  };
  for (const path of trackedPaths) {
    await assertPath(path, true);
  }
  for (const path of untrackedPaths) {
    await assertPath(path, false);
  }
};

const scanGitBlobs = async (
  root: string,
  entries: Array<{ objectId: string; path: string }>,
  requireBlobs = false
): Promise<void> => {
  if (entries.length > maxFiles) {
    throw new Error("WorkspaceSnapshotFileCountError");
  }
  if (!entries.length) return;
  const output = await gitBufferWithInput(
    root,
    ["cat-file", "--batch"],
    Buffer.from(`${entries.map(({ objectId }) => objectId).join("\n")}\n`)
  );
  let cursor = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, cursor);
    if (headerEnd === -1) {
      throw new Error("WorkspaceSnapshotGitBatchError");
    }
    const header = output.subarray(cursor, headerEnd).toString("ascii");
    const match = /^([0-9a-f]+) ([a-z]+) ([0-9]+)$/.exec(header);
    if (!match || match[1] !== entry.objectId) {
      throw new Error("WorkspaceSnapshotGitBatchError");
    }
    const objectType = match[2];
    if (requireBlobs && objectType !== "blob") {
      throw new Error("WorkspaceSnapshotIndexShapeError");
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) {
      throw new Error("WorkspaceSnapshotFileSizeError");
    }
    totalBytes += size;
    if (totalBytes > maxPackageBytes) {
      throw new Error("WorkspaceSnapshotExpandedSizeError");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.byteLength || output[contentEnd] !== 0x0a) {
      throw new Error("WorkspaceSnapshotGitBatchError");
    }
    if (objectType === "blob") {
      assertPortableBlob(entry.path, output.subarray(contentStart, contentEnd));
    }
    cursor = contentEnd + 1;
  }
  if (cursor !== output.byteLength) {
    throw new Error("WorkspaceSnapshotGitBatchError");
  }
};

const scanReachableGitBlobs = async (root: string): Promise<void> => {
  const entries = (
    await gitText(root, [
      "rev-list",
      "--objects",
      "--filter=object:type=blob",
      "HEAD"
    ])
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      const objectId = separator === -1 ? line : line.slice(0, separator);
      return {
        objectId,
        path:
          separator === -1
            ? `git-object/${objectId}`
            : line.slice(separator + 1)
      };
    });
  await scanGitBlobs(root, entries);
};

const scanIndexAndWorkingTree = async (root: string): Promise<void> => {
  const indexEntries = (
    await git(root, ["ls-files", "--stage", "-z"], { encoding: "buffer" })
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (indexEntries.length > maxFiles) {
    throw new Error("WorkspaceSnapshotFileCountError");
  }
  const blobs = indexEntries.map((entry) => {
    const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t(.+)$/.exec(entry);
    if (!match || match[3] !== "0") {
      throw new Error("WorkspaceSnapshotIndexShapeError");
    }
    return {
      objectId: match[2]!,
      path: normalizedRelativePath(match[4]!)
    };
  });
  await scanGitBlobs(root, blobs, true);

  const trackedPaths = (
    await git(root, ["ls-files", "-z"], { encoding: "buffer" })
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const rawPath of trackedPaths) {
    const path = normalizedRelativePath(rawPath);
    const absolute = await assertSafeDestination(root, path);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("WorkspaceSnapshotUnsupportedFileError");
    }
    if (metadata.size > maxFileBytes) {
      throw new Error("WorkspaceSnapshotFileSizeError");
    }
    assertPortableBlob(path, await readFile(absolute));
  }
};

export type DevelopmentWorkspaceSnapshotPackage = {
  protocol: typeof protocol;
  snapshotId: string;
  createdAt: string;
  headCommit: string;
  sourceStateDigest: string;
  bundleSha256: string;
  stagedPatchSha256: string;
  workingPatchSha256: string;
  untrackedDigest: string;
  remotesDigest: string;
  manifestDigest: string;
  bundleBase64: string;
  stagedPatchBase64: string;
  workingPatchBase64: string;
  remotes: Array<{
    name: string;
    fetchUrls: string[];
    pushUrls: string[];
    fetchRefspecs: string[];
  }>;
  untrackedFiles: Array<{
    path: string;
    mode: number;
    sha256: string;
    contentBase64: string;
  }>;
};

type WorkspaceRemote = DevelopmentWorkspaceSnapshotPackage["remotes"][number];

const safeRemoteValue = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_096 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`WorkspaceSnapshot${label}Error`);
  }
  return normalized;
};

const safeRemoteUrl = (value: string): string => {
  const url = safeRemoteValue(value, "RemoteUrl");
  if (/^(?:\.{0,2}\/|\/|[A-Za-z]:[\\/]|file:)/i.test(url)) {
    throw new Error("WorkspaceSnapshotLocalRemoteUnsupportedError");
  }
  if (url.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("WorkspaceSnapshotRemoteUrlError");
    }
    if (
      !["https:", "ssh:", "git:"].includes(parsed.protocol) ||
      parsed.password ||
      /(?:token|secret|password|credential|key)=/i.test(parsed.search)
    ) {
      throw new Error("WorkspaceSnapshotRemoteCredentialError");
    }
  } else if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^\s]+$/.test(url)) {
    throw new Error("WorkspaceSnapshotRemoteUrlError");
  }
  return url;
};

const workspaceRemotes = async (root: string): Promise<WorkspaceRemote[]> => {
  const names = (await gitText(root, ["remote"]))
    .split("\n")
    .filter(Boolean)
    .sort();
  return Promise.all(
    names.map(async (name) => {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
        throw new Error("WorkspaceSnapshotRemoteNameError");
      }
      const values = async (key: string): Promise<string[]> =>
        (
          await gitText(root, ["config", "--local", "--get-all", key]).catch(
            () => ""
          )
        )
          .split("\n")
          .filter(Boolean);
      const fetchUrls = (await values(`remote.${name}.url`)).map(safeRemoteUrl);
      if (!fetchUrls.length) {
        throw new Error("WorkspaceSnapshotRemoteUrlError");
      }
      const explicitPushUrls = (await values(`remote.${name}.pushurl`)).map(
        safeRemoteUrl
      );
      const fetchRefspecs = (await values(`remote.${name}.fetch`)).map(
        (value) => safeRemoteValue(value, "RemoteRefspec")
      );
      return {
        name,
        fetchUrls,
        pushUrls: explicitPushUrls,
        fetchRefspecs
      };
    })
  );
};

const sourceStateDigest = async (root: string): Promise<string> => {
  const status = (
    await git(
      root,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      {
        encoding: "buffer"
      }
    )
  ).stdout;
  const index = (
    await git(root, ["ls-files", "--stage", "-z"], { encoding: "buffer" })
  ).stdout;
  const staged = (
    await git(root, ["diff", "--cached", "--binary", "--full-index"], {
      encoding: "buffer"
    })
  ).stdout;
  const working = (
    await git(root, ["diff", "--binary", "--full-index"], {
      encoding: "buffer"
    })
  ).stdout;
  const untracked = (
    await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: "buffer"
    })
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedContent: Buffer[] = [];
  for (const rawPath of untracked) {
    const path = normalizedRelativePath(rawPath);
    const content = await readFile(await assertSafeDestination(root, path));
    untrackedContent.push(
      Buffer.from(path, "utf8"),
      Buffer.from([0]),
      content,
      Buffer.from([0])
    );
  }
  const remotes = await workspaceRemotes(root);
  return sha256(
    Buffer.concat([
      Buffer.from(status),
      Buffer.from(index),
      Buffer.from(staged),
      Buffer.from(working),
      ...untrackedContent,
      Buffer.from(canonical(remotes), "utf8")
    ])
  );
};

export const createDevelopmentWorkspaceSnapshot = async (
  projectPath: string,
  identity?: { snapshotId: string; createdAt: string }
): Promise<DevelopmentWorkspaceSnapshotPackage> => {
  const root = await realpath(projectPath);
  if ((await gitText(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new Error("WorkspaceSnapshotRootMismatchError");
  }
  await assertStableRepository(root);
  await assertSupportedWorkspaceShape(root);
  const before = await sourceStateDigest(root);
  await scanReachableGitBlobs(root);
  await scanIndexAndWorkingTree(root);
  const snapshotId = identity?.snapshotId ?? randomUUID();
  const temporary = await mkdtemp(join(dirname(root), ".koed-snapshot-"));
  try {
    const bundlePath = join(temporary, "repository.bundle");
    await git(root, ["bundle", "create", bundlePath, "HEAD"]);
    const bundle = await readFile(bundlePath);
    const stagedPatch = (
      await git(root, ["diff", "--cached", "--binary", "--full-index"], {
        encoding: "buffer"
      })
    ).stdout;
    const workingPatch = (
      await git(root, ["diff", "--binary", "--full-index"], {
        encoding: "buffer"
      })
    ).stdout;
    const untracked = (
      await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
        encoding: "buffer"
      })
    ).stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    if (untracked.length > maxFiles) {
      throw new Error("WorkspaceSnapshotFileCountError");
    }
    const untrackedFiles: DevelopmentWorkspaceSnapshotPackage["untrackedFiles"] =
      [];
    let packageBytes =
      bundle.byteLength + stagedPatch.byteLength + workingPatch.byteLength;
    for (const rawPath of untracked) {
      const path = normalizedRelativePath(rawPath);
      const absolute = await assertSafeDestination(root, path);
      const file = await lstat(absolute);
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new Error("WorkspaceSnapshotUnsupportedFileError");
      }
      if (file.size > maxFileBytes) {
        throw new Error("WorkspaceSnapshotFileSizeError");
      }
      const content = await readFile(absolute);
      assertNoSecrets(path, content);
      packageBytes += content.byteLength;
      if (packageBytes > maxPackageBytes) {
        throw new Error("WorkspaceSnapshotExpandedSizeError");
      }
      untrackedFiles.push({
        path,
        mode: file.mode & 0o777,
        sha256: sha256(content),
        contentBase64: content.toString("base64")
      });
    }
    const after = await sourceStateDigest(root);
    if (before !== after) {
      throw new Error("WorkspaceSnapshotConcurrentMutationError");
    }
    const untrackedDigest = sha256(
      canonical(
        untrackedFiles.map(({ path, mode, sha256: digest }) => ({
          path,
          mode,
          sha256: digest
        }))
      )
    );
    const remotes = await workspaceRemotes(root);
    const remotesDigest = sha256(canonical(remotes));
    const manifest = {
      protocol,
      snapshotId,
      createdAt: identity?.createdAt ?? new Date().toISOString(),
      headCommit: await gitText(root, ["rev-parse", "HEAD"]),
      sourceStateDigest: before,
      bundleSha256: sha256(bundle),
      stagedPatchSha256: sha256(stagedPatch),
      workingPatchSha256: sha256(workingPatch),
      untrackedDigest,
      remotesDigest
    };
    return {
      ...manifest,
      manifestDigest: sha256(canonical(manifest)),
      bundleBase64: bundle.toString("base64"),
      stagedPatchBase64: stagedPatch.toString("base64"),
      workingPatchBase64: workingPatch.toString("base64"),
      remotes,
      untrackedFiles
    };
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
};

const verifyPackage = (snapshot: DevelopmentWorkspaceSnapshotPackage): void => {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Object.keys(snapshot).sort().join(",") !==
      [
        "bundleBase64",
        "bundleSha256",
        "createdAt",
        "headCommit",
        "manifestDigest",
        "protocol",
        "remotes",
        "remotesDigest",
        "snapshotId",
        "sourceStateDigest",
        "stagedPatchBase64",
        "stagedPatchSha256",
        "untrackedDigest",
        "untrackedFiles",
        "workingPatchBase64",
        "workingPatchSha256"
      ]
        .sort()
        .join(",") ||
    !Array.isArray(snapshot.untrackedFiles) ||
    snapshot.untrackedFiles.length > maxFiles
  ) {
    throw new Error("WorkspaceSnapshotShapeError");
  }
  if (snapshot.protocol !== protocol) {
    throw new Error("WorkspaceSnapshotProtocolError");
  }
  const bundle = decodeBase64(snapshot.bundleBase64);
  const staged = decodeBase64(snapshot.stagedPatchBase64);
  const working = decodeBase64(snapshot.workingPatchBase64);
  let expandedBytes =
    bundle.byteLength + staged.byteLength + working.byteLength;
  if (
    expandedBytes > maxPackageBytes ||
    sha256(bundle) !== snapshot.bundleSha256 ||
    sha256(staged) !== snapshot.stagedPatchSha256 ||
    sha256(working) !== snapshot.workingPatchSha256
  ) {
    throw new Error("WorkspaceSnapshotDigestError");
  }
  const seenPaths = new Set<string>();
  const untrackedManifest = snapshot.untrackedFiles.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      Object.keys(file).sort().join(",") !==
        ["contentBase64", "mode", "path", "sha256"].sort().join(",") ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error("WorkspaceSnapshotShapeError");
    }
    const path = normalizedRelativePath(file.path);
    if (seenPaths.has(path)) {
      throw new Error("WorkspaceSnapshotDuplicatePathError");
    }
    seenPaths.add(path);
    const content = decodeBase64(file.contentBase64);
    expandedBytes += content.byteLength;
    if (
      content.byteLength > maxFileBytes ||
      expandedBytes > maxPackageBytes ||
      sha256(content) !== file.sha256
    ) {
      throw new Error("WorkspaceSnapshotDigestError");
    }
    assertNoSecrets(path, content);
    return { path, mode: file.mode, sha256: file.sha256 };
  });
  const untrackedDigest = sha256(canonical(untrackedManifest));
  if (untrackedDigest !== snapshot.untrackedDigest) {
    throw new Error("WorkspaceSnapshotDigestError");
  }
  const seenRemotes = new Set<string>();
  const remotes = snapshot.remotes.map((remote) => {
    if (
      !remote ||
      typeof remote !== "object" ||
      Object.keys(remote).sort().join(",") !==
        ["fetchRefspecs", "fetchUrls", "name", "pushUrls"].sort().join(",") ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(remote.name) ||
      seenRemotes.has(remote.name) ||
      !Array.isArray(remote.fetchUrls) ||
      !remote.fetchUrls.length ||
      !Array.isArray(remote.pushUrls) ||
      !Array.isArray(remote.fetchRefspecs)
    ) {
      throw new Error("WorkspaceSnapshotRemoteShapeError");
    }
    seenRemotes.add(remote.name);
    return {
      name: remote.name,
      fetchUrls: remote.fetchUrls.map(safeRemoteUrl),
      pushUrls: remote.pushUrls.map(safeRemoteUrl),
      fetchRefspecs: remote.fetchRefspecs.map((value) =>
        safeRemoteValue(value, "RemoteRefspec")
      )
    };
  });
  if (sha256(canonical(remotes)) !== snapshot.remotesDigest) {
    throw new Error("WorkspaceSnapshotDigestError");
  }
  const manifest = {
    protocol: snapshot.protocol,
    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.createdAt,
    headCommit: snapshot.headCommit,
    sourceStateDigest: snapshot.sourceStateDigest,
    bundleSha256: snapshot.bundleSha256,
    stagedPatchSha256: snapshot.stagedPatchSha256,
    workingPatchSha256: snapshot.workingPatchSha256,
    untrackedDigest: snapshot.untrackedDigest,
    remotesDigest: snapshot.remotesDigest
  };
  if (sha256(canonical(manifest)) !== snapshot.manifestDigest) {
    throw new Error("WorkspaceSnapshotManifestError");
  }
};

export const materializeDevelopmentWorkspaceSnapshot = async (
  snapshot: DevelopmentWorkspaceSnapshotPackage,
  targetPath: string,
  trustedRootPath: string
): Promise<{ path: string; stateDigest: string }> => {
  verifyPackage(snapshot);
  const destination = await prepareTrustedDestination(
    trustedRootPath,
    targetPath
  );
  const target = destination.target;
  const staging = await mkdtemp(
    join(destination.root, `.${basename(target)}.koed-restore-`)
  );
  try {
    await chmod(staging, 0o700);
    await assertTrustedDirectory(staging, destination.device);
    const bundlePath = join(staging, ".koed-repository.bundle");
    await writeExclusiveFile(
      bundlePath,
      decodeBase64(snapshot.bundleBase64),
      0o600
    );
    await git(target, ["init", "--initial-branch=koed-restore"]);
    await git(target, [
      "-c",
      "fetch.fsckObjects=true",
      "fetch",
      "--no-tags",
      bundlePath,
      snapshot.headCommit
    ]);
    if (
      (await gitText(target, ["rev-parse", "FETCH_HEAD"])) !==
      snapshot.headCommit
    ) {
      throw new Error("WorkspaceSnapshotGitBoundaryError");
    }
    const treeModes = await gitText(target, [
      "ls-tree",
      "-r",
      "--full-tree",
      snapshot.headCommit
    ]);
    if (
      treeModes
        .split("\n")
        .some(
          (line) => line.startsWith("120000 ") || line.startsWith("160000 ")
        )
    ) {
      throw new Error("WorkspaceSnapshotUnsupportedGitEntryError");
    }
    await git(target, ["checkout", "--detach", snapshot.headCommit]);
    await assertSupportedWorkspaceShape(target);
    for (const remote of snapshot.remotes) {
      await git(target, [
        "config",
        "--local",
        `remote.${remote.name}.url`,
        remote.fetchUrls[0]!
      ]);
      for (const url of remote.fetchUrls.slice(1)) {
        await git(target, [
          "config",
          "--local",
          "--add",
          `remote.${remote.name}.url`,
          url
        ]);
      }
      for (const url of remote.pushUrls) {
        await git(target, [
          "config",
          "--local",
          "--add",
          `remote.${remote.name}.pushurl`,
          url
        ]);
      }
      for (const refspec of remote.fetchRefspecs) {
        await git(target, [
          "config",
          "--local",
          "--add",
          `remote.${remote.name}.fetch`,
          refspec
        ]);
      }
    }
    const stagedPatch = decodeBase64(snapshot.stagedPatchBase64);
    const workingPatch = decodeBase64(snapshot.workingPatchBase64);
    if (stagedPatch.byteLength > 0) {
      const path = join(staging, "staged.patch");
      await writeExclusiveFile(path, stagedPatch, 0o600);
      await git(target, ["apply", "--index", "--binary", path]);
    }
    if (workingPatch.byteLength > 0) {
      const path = join(staging, "working.patch");
      await writeExclusiveFile(path, workingPatch, 0o600);
      await git(target, ["apply", "--binary", path]);
    }
    for (const file of snapshot.untrackedFiles) {
      const destinationPath = await assertSafeDestination(target, file.path);
      const content = decodeBase64(file.contentBase64);
      if (
        content.byteLength > maxFileBytes ||
        sha256(content) !== file.sha256
      ) {
        throw new Error("WorkspaceSnapshotDigestError");
      }
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      const parent = await realpath(dirname(destinationPath));
      if (
        parent !== dirname(destinationPath) ||
        (parent !== target && !parent.startsWith(`${target}${sep}`))
      ) {
        throw new Error("WorkspaceSnapshotUnsafeDirectoryError");
      }
      await writeExclusiveFile(destinationPath, content, file.mode & 0o777);
    }
    await assertSupportedWorkspaceShape(target);
    const restoredDigest = await sourceStateDigest(target);
    if (restoredDigest !== snapshot.sourceStateDigest) {
      throw new Error("WorkspaceSnapshotStateMismatchError");
    }
    await rm(bundlePath, { force: true });
    return { path: target, stateDigest: restoredDigest };
  } catch (error) {
    await rm(target, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
};

export const verifyDevelopmentWorkspaceSnapshotMaterialization = async (
  snapshot: DevelopmentWorkspaceSnapshotPackage,
  targetPath: string
): Promise<{ path: string; stateDigest: string }> => {
  verifyPackage(snapshot);
  const target = await realpath(resolve(targetPath));
  if ((await gitText(target, ["rev-parse", "--show-toplevel"])) !== target) {
    throw new Error("WorkspaceSnapshotRootMismatchError");
  }
  await assertStableRepository(target);
  await assertSupportedWorkspaceShape(target);
  const stateDigest = await sourceStateDigest(target);
  if (stateDigest !== snapshot.sourceStateDigest) {
    throw new Error("WorkspaceSnapshotStateMismatchError");
  }
  return { path: target, stateDigest };
};
