import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { promisify } from "node:util";

import type { ManagedConversationExecutionCheckpointRecord } from "@koed/db";
import {
  MANAGED_CONVERSATION_FILE_MAX_READ_BYTES,
  MANAGED_CONVERSATION_FILE_PROTOCOL_VERSION,
  managedConversationFileOperationResultSchema,
  type ManagedConversationFileOperation,
  type ManagedConversationFileOperationResult
} from "@koed/shared";

import type { ExecutionWorkspaceIdentity } from "@koed/shared/execution-workspace";
import { classifyWorkspaceContent } from "./workspace-content-policy.js";

const execFileAsync = promisify(execFile);
const objectIdPattern = /^[0-9a-f]{40,64}$/;
const maxTreeOutputBytes = 16 * 1024 * 1024;
const maxSearchFiles = 5_000;
const maxSearchBytes = 32 * 1024 * 1024;
const maxSearchFileBytes = 2 * 1024 * 1024;
const mentionTtlMs = 15 * 60 * 1_000;
const decoder = new TextDecoder("utf-8", { fatal: true });

type FileCheckpoint = ManagedConversationExecutionCheckpointRecord & {
  vcsDriver: "git";
  checkpointStatus: "ready";
  commitObjectId: string;
  repositoryIdentityHash: string;
  worktreeIdentityHash: string;
};

type TreeEntry = {
  mode: string;
  type: "blob" | "tree";
  objectId: string;
  size: number | null;
  path: string;
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_")
    )
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: devNull,
  SSH_ASKPASS: devNull,
  GIT_SSH_COMMAND: "false",
  GIT_ALLOW_PROTOCOL: "",
  GIT_OPTIONAL_LOCKS: "0"
});

const git = async (
  root: string,
  args: readonly string[],
  maxBuffer = maxTreeOutputBytes
): Promise<Buffer> => {
  try {
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
        ...args
      ],
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer,
        env: gitEnvironment()
      }
    );
    return result.stdout;
  } catch (error) {
    throw Object.assign(new Error("ExecutionFileGitCommandError"), {
      name: "ExecutionFileGitCommandError",
      cause: error
    });
  }
};

const safePath = (value: string): string => {
  const normalized = value.normalize("NFC");
  if (
    normalized !== value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes(":") ||
    (value !== "" &&
      value.split("/").some((part) => !part || part === "." || part === ".."))
  ) {
    throw new Error("ExecutionFilePathError");
  }
  return normalized;
};

const parseTree = (bytes: Buffer): TreeEntry[] => {
  const entries: TreeEntry[] = [];
  for (const field of bytes.toString("utf8").split("\0")) {
    if (!field) continue;
    const tab = field.indexOf("\t");
    const header = field.slice(0, tab).trim().split(/\s+/);
    const [mode, type, objectId, sizeText] = header;
    const path = safePath(field.slice(tab + 1));
    if (
      tab < 0 ||
      !mode ||
      (type !== "blob" && type !== "tree") ||
      !objectId ||
      !objectIdPattern.test(objectId)
    ) {
      throw new Error("ExecutionFileTreeError");
    }
    const size = type === "tree" || sizeText === "-" ? null : Number(sizeText);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      throw new Error("ExecutionFileTreeError");
    }
    entries.push({ mode, type, objectId, size, path });
  }
  return entries;
};

const selectCheckpoint = (
  workspace: ExecutionWorkspaceIdentity,
  checkpoints: ManagedConversationExecutionCheckpointRecord[],
  request: ManagedConversationFileOperation
): FileCheckpoint => {
  const selected = request.revision
    ? checkpoints.find(
        (checkpoint) => checkpoint.id === request.revision!.checkpointId
      )
    : [...checkpoints]
        .filter(
          (checkpoint) =>
            checkpoint.checkpointStatus === "ready" && checkpoint.commitObjectId
        )
        .sort(
          (left, right) =>
            right.sequence - left.sequence ||
            Number(right.checkpointKind === "terminal") -
              Number(left.checkpointKind === "terminal")
        )[0];
  if (
    !selected ||
    selected.checkpointStatus !== "ready" ||
    selected.vcsDriver !== "git" ||
    !selected.commitObjectId ||
    !selected.repositoryIdentityHash ||
    !selected.worktreeIdentityHash ||
    selected.repositoryIdentityHash !== workspace.repositoryIdentityHash ||
    selected.worktreeIdentityHash !== workspace.worktreeIdentityHash ||
    selected.executionGeneration < 1
  ) {
    throw new Error("ExecutionFileRevisionUnavailableError");
  }
  const revisionDigest = sha256(
    [
      "koed-execution-file-revision-v1",
      selected.ownerUserId,
      selected.executionId,
      selected.executionGeneration,
      workspace.workspaceId,
      selected.id,
      selected.commitObjectId
    ].join("\0")
  );
  if (request.revision && request.revision.revisionDigest !== revisionDigest) {
    throw new Error("ExecutionFileStaleRevisionError");
  }
  return selected as FileCheckpoint;
};

const revisionFor = (
  workspace: ExecutionWorkspaceIdentity,
  checkpoint: FileCheckpoint
) => ({
  checkpointId: checkpoint.id,
  revisionDigest: sha256(
    [
      "koed-execution-file-revision-v1",
      checkpoint.ownerUserId,
      checkpoint.executionId,
      checkpoint.executionGeneration,
      workspace.workspaceId,
      checkpoint.id,
      checkpoint.commitObjectId
    ].join("\0")
  )
});

const baseResult = (
  workspace: ExecutionWorkspaceIdentity,
  checkpoint: FileCheckpoint
) => ({
  protocolVersion: MANAGED_CONVERSATION_FILE_PROTOCOL_VERSION,
  checkpointId: checkpoint.id,
  checkpointSequence: checkpoint.sequence,
  revision: revisionFor(workspace, checkpoint)
});

const treeish = (checkpoint: FileCheckpoint, path: string): string =>
  path
    ? `${checkpoint.commitObjectId}:${safePath(path)}`
    : checkpoint.commitObjectId;

const listTree = async (
  workspace: ExecutionWorkspaceIdentity,
  checkpoint: FileCheckpoint,
  path: string,
  recursive: boolean
): Promise<TreeEntry[]> =>
  parseTree(
    await git(workspace.canonicalPath, [
      "ls-tree",
      "-z",
      "-l",
      ...(recursive ? ["-r"] : []),
      treeish(checkpoint, path)
    ])
  );

const readBlob = async (
  workspace: ExecutionWorkspaceIdentity,
  checkpoint: FileCheckpoint,
  path: string
): Promise<{ bytes: Buffer; text: string; digest: string }> => {
  const normalized = safePath(path);
  if (!normalized) throw new Error("ExecutionFilePathError");
  const object = treeish(checkpoint, normalized);
  const sizeText = (
    await git(workspace.canonicalPath, ["cat-file", "-s", object])
  )
    .toString("utf8")
    .trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("ExecutionFileBlobError");
  }
  if (size > 32 * 1024 * 1024) {
    throw new Error("ExecutionFileCapacityError");
  }
  const bytes = await git(
    workspace.canonicalPath,
    ["cat-file", "blob", object],
    Math.max(size + 1_024, 1_024 * 1_024)
  );
  if (bytes.byteLength !== size) throw new Error("ExecutionFileBlobError");
  if (classifyWorkspaceContent(normalized, bytes)) {
    throw new Error("ExecutionFileContentDeniedError");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error("ExecutionFileBinaryError");
  }
  if (text.includes("\0")) throw new Error("ExecutionFileBinaryError");
  return { bytes, text, digest: sha256(bytes) };
};

const lineSelection = (
  text: string,
  startLine?: number,
  endLine?: number
): { startLine: number; endLine: number; content: string } => {
  const lines = text.split("\n");
  const start = startLine ?? 1;
  const end = endLine ?? lines.length;
  if (start > lines.length || end > lines.length || end < start) {
    throw new Error("ExecutionFileLineRangeError");
  }
  return {
    startLine: start,
    endLine: end,
    content: lines.slice(start - 1, end).join("\n")
  };
};

const decodeRange = (
  bytes: Buffer,
  offset: number,
  requestedEnd: number
): { content: string; end: number } => {
  for (
    let end = requestedEnd;
    end >= Math.max(offset, requestedEnd - 3);
    end--
  ) {
    try {
      return {
        content: decoder.decode(bytes.subarray(offset, end)),
        end
      };
    } catch {
      // A UTF-8 code point can span at most four bytes. Preserve the start
      // boundary and shorten only the end so nextOffset remains exact.
    }
  }
  throw new Error("ExecutionFileRangeBoundaryError");
};

export const executeCheckpointFileOperation = async (input: {
  workspace: ExecutionWorkspaceIdentity;
  checkpoints: ManagedConversationExecutionCheckpointRecord[];
  operation: ManagedConversationFileOperation;
}): Promise<ManagedConversationFileOperationResult> => {
  const checkpoint = selectCheckpoint(
    input.workspace,
    input.checkpoints,
    input.operation
  );
  const common = baseResult(input.workspace, checkpoint);
  const operation = input.operation;
  if (operation.kind === "browse") {
    const entries = await listTree(
      input.workspace,
      checkpoint,
      operation.path,
      false
    );
    const page = entries.slice(
      operation.offset,
      operation.offset + operation.limit
    );
    return managedConversationFileOperationResultSchema.parse({
      ...common,
      kind: "browse",
      path: operation.path,
      entries: page.map((entry) => ({
        path: operation.path ? `${operation.path}/${entry.path}` : entry.path,
        name: entry.path,
        entryKind: entry.type === "tree" ? "directory" : "file",
        size: entry.size,
        executable: entry.mode === "100755"
      })),
      totalEntries: entries.length,
      nextOffset:
        operation.offset + page.length < entries.length
          ? operation.offset + page.length
          : null
    });
  }
  if (operation.kind === "read") {
    const file = await readBlob(input.workspace, checkpoint, operation.path);
    const requestedEnd = Math.min(
      file.bytes.byteLength,
      operation.offset + operation.limit
    );
    const { content, end } = decodeRange(
      file.bytes,
      operation.offset,
      requestedEnd
    );
    return managedConversationFileOperationResultSchema.parse({
      ...common,
      kind: "read",
      path: operation.path,
      content,
      contentDigest: file.digest,
      totalBytes: file.bytes.byteLength,
      offset: operation.offset,
      nextOffset: end < file.bytes.byteLength ? end : null,
      lineCount: file.text.split("\n").length
    });
  }
  if (operation.kind === "mention") {
    const file = await readBlob(input.workspace, checkpoint, operation.path);
    const selected = lineSelection(
      file.text,
      operation.startLine,
      operation.endLine
    );
    const selectedBytes = Buffer.byteLength(selected.content, "utf8");
    if (selectedBytes > MANAGED_CONVERSATION_FILE_MAX_READ_BYTES) {
      throw new Error("ExecutionFileCapacityError");
    }
    return managedConversationFileOperationResultSchema.parse({
      ...common,
      kind: "mention",
      path: operation.path,
      contentDigest: file.digest,
      totalBytes: file.bytes.byteLength,
      startLine: selected.startLine,
      endLine: selected.endLine,
      selectedBytes,
      expiresAt: new Date(Date.now() + mentionTtlMs).toISOString()
    });
  }

  const entries = await listTree(
    input.workspace,
    checkpoint,
    operation.path,
    true
  );
  const query = operation.caseSensitive
    ? operation.query
    : operation.query.toLocaleLowerCase("en-US");
  const matches: Array<{
    path: string;
    line: number;
    column: number;
    preview: string;
    contentDigest: string;
  }> = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncated = false;
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (
      scannedFiles >= maxSearchFiles ||
      entry.size === null ||
      entry.size > maxSearchFileBytes ||
      scannedBytes + entry.size > maxSearchBytes
    ) {
      truncated = true;
      continue;
    }
    const fullPath = operation.path
      ? `${operation.path}/${entry.path}`
      : entry.path;
    let file: Awaited<ReturnType<typeof readBlob>>;
    try {
      file = await readBlob(input.workspace, checkpoint, fullPath);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "ExecutionFileBinaryError",
          "ExecutionFileContentDeniedError",
          "ExecutionFileCapacityError"
        ].includes(error.message)
      ) {
        continue;
      }
      throw error;
    }
    scannedFiles += 1;
    scannedBytes += file.bytes.byteLength;
    for (const [lineIndex, line] of file.text.split("\n").entries()) {
      const haystack = operation.caseSensitive
        ? line
        : line.toLocaleLowerCase("en-US");
      let from = 0;
      while (from <= haystack.length) {
        const found = haystack.indexOf(query, from);
        if (found < 0) break;
        matches.push({
          path: fullPath,
          line: lineIndex + 1,
          column: found + 1,
          preview: line.slice(0, 4_096),
          contentDigest: file.digest
        });
        from = found + Math.max(query.length, 1);
        if (matches.length > operation.offset + operation.limit + 10_000) {
          truncated = true;
          break;
        }
      }
      if (truncated && matches.length > operation.offset + operation.limit)
        break;
    }
    if (truncated && matches.length > operation.offset + operation.limit) break;
  }
  const page = matches.slice(
    operation.offset,
    operation.offset + operation.limit
  );
  return managedConversationFileOperationResultSchema.parse({
    ...common,
    kind: "search",
    path: operation.path,
    query: operation.query,
    matches: page,
    totalMatches: matches.length,
    nextOffset:
      operation.offset + page.length < matches.length
        ? operation.offset + page.length
        : null,
    scannedFiles,
    scannedBytes,
    truncated
  });
};

export const resolveCheckpointFileMention = async (input: {
  workspace: ExecutionWorkspaceIdentity;
  checkpoints: ManagedConversationExecutionCheckpointRecord[];
  operation: Extract<ManagedConversationFileOperation, { kind: "mention" }>;
  result: Extract<ManagedConversationFileOperationResult, { kind: "mention" }>;
}): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}> => {
  if (Date.parse(input.result.expiresAt) <= Date.now()) {
    throw new Error("ExecutionFileMentionExpiredError");
  }
  const reparsed = await executeCheckpointFileOperation({
    workspace: input.workspace,
    checkpoints: input.checkpoints,
    operation: { ...input.operation, revision: input.result.revision }
  });
  if (
    reparsed.kind !== "mention" ||
    reparsed.contentDigest !== input.result.contentDigest ||
    reparsed.startLine !== input.result.startLine ||
    reparsed.endLine !== input.result.endLine
  ) {
    throw new Error("ExecutionFileMentionChangedError");
  }
  const checkpoint = selectCheckpoint(input.workspace, input.checkpoints, {
    ...input.operation,
    revision: input.result.revision
  });
  const file = await readBlob(
    input.workspace,
    checkpoint,
    input.operation.path
  );
  const selected = lineSelection(
    file.text,
    input.result.startLine,
    input.result.endLine
  );
  return {
    path: input.operation.path,
    startLine: selected.startLine,
    endLine: selected.endLine,
    content: selected.content
  };
};
