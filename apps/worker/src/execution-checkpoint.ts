import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { resolve } from "node:path";

import type { ExecutionWorkspaceIdentity } from "@koed/shared/execution-workspace";

const objectIdPattern = /^[0-9a-f]{40,64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const checkpointRefPattern =
  /^refs\/koed\/checkpoints\/[0-9a-f-]{36}\/[1-9][0-9]*\/(?:0|[1-9][0-9]*)\/(?:baseline|terminal|recovery)$/i;
const maxGitOutputBytes = 32 * 1024 * 1024;
const maxPatchBytesPerFile = 512 * 1024;
const maxDiffBytes = 16 * 1024 * 1024;

export type ExecutionCheckpointKind = "baseline" | "terminal" | "recovery";

export interface ExecutionCheckpointCapture {
  status: "ready" | "unsupported";
  vcsDriver: "git" | null;
  repositoryIdentityHash: string | null;
  worktreeIdentityHash: string | null;
  checkpointRef: string | null;
  commitObjectId: string | null;
  capturedAt: string | null;
}

export interface ExecutionCheckpointDiffFile {
  path: string;
  previousPath?: string;
  status:
    | "added"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "type_changed"
    | "unknown";
  binary: boolean;
  patch: string | null;
  patchTruncated: boolean;
}

export interface ExecutionCheckpointDiff {
  fromCommitObjectId: string;
  toCommitObjectId: string;
  complete: boolean;
  files: ExecutionCheckpointDiffFile[];
  fileCount: number;
  returnedFileCount: number;
  byteCount: number;
  truncated: boolean;
  continuation: { nextFileIndex: number; revisionDigest: string } | null;
  revisionDigest: string;
}

type GitResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const gitEnvironment = (indexFile?: string): NodeJS.ProcessEnv => ({
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
  GIT_OPTIONAL_LOCKS: "0",
  ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {})
});

const runGit = (
  cwd: string,
  args: readonly string[],
  options: {
    indexFile?: string;
    input?: Uint8Array;
    allowNonZero?: boolean;
    maxBuffer?: number;
    onGitCommand?: (args: readonly string[]) => void;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<GitResult> =>
  new Promise((resolveResult, reject) => {
    options.onGitCommand?.(args);
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
        "diff.external=",
        "-c",
        "diff.trustExitCode=false",
        ...args
      ],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: options.maxBuffer ?? maxGitOutputBytes,
        env: { ...gitEnvironment(options.indexFile), ...options.env }
      },
      (error, stdout, stderr) => {
        const exitCode =
          error &&
          typeof (error as NodeJS.ErrnoException & { code?: unknown }).code ===
            "number"
            ? ((error as NodeJS.ErrnoException & { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        if (error && !options.allowNonZero) {
          reject(
            Object.assign(new Error("ExecutionCheckpointGitCommandError"), {
              name: "ExecutionCheckpointGitCommandError",
              cause: error
            })
          );
          return;
        }
        resolveResult({
          exitCode,
          stdout: Buffer.from(stdout),
          stderr: Buffer.from(stderr)
        });
      }
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });

const gitText = async (
  cwd: string,
  args: readonly string[],
  options: Parameters<typeof runGit>[2] = {}
): Promise<string> =>
  (await runGit(cwd, args, options)).stdout.toString("utf8");

const checkpointRefFor = (input: {
  executionId: string;
  executionGeneration: number;
  sequence: number;
  checkpointKind: ExecutionCheckpointKind;
}): string =>
  `refs/koed/checkpoints/${input.executionId}/${input.executionGeneration}/${input.sequence}/${input.checkpointKind}`;

const assertIdentity = (input: {
  executionId: string;
  executionGeneration: number;
  sequence: number;
  checkpointKind: ExecutionCheckpointKind;
}): void => {
  if (
    !uuidPattern.test(input.executionId) ||
    !Number.isSafeInteger(input.executionGeneration) ||
    input.executionGeneration < 1 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0
  ) {
    throw new Error("ExecutionCheckpointIdentityError");
  }
};

const resolveHead = async (
  root: string,
  onGitCommand?: (args: readonly string[]) => void
): Promise<string | null> => {
  const result = await runGit(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    {
      allowNonZero: true,
      onGitCommand
    }
  );
  if (result.exitCode !== 0) return null;
  const objectId = result.stdout.toString("utf8").trim();
  if (!objectIdPattern.test(objectId)) {
    throw new Error("ExecutionCheckpointIdentityError");
  }
  return objectId;
};

const resolveBranch = async (
  root: string,
  onGitCommand?: (args: readonly string[]) => void
): Promise<string | null> => {
  const result = await runGit(root, ["symbolic-ref", "-q", "HEAD"], {
    allowNonZero: true,
    onGitCommand
  });
  return result.exitCode === 0
    ? result.stdout.toString("utf8").trim() || null
    : null;
};

const publishRef = async (input: {
  root: string;
  checkpointRef: string;
  commitObjectId: string;
  onGitCommand?: (args: readonly string[]) => void;
}): Promise<void> => {
  const symbolic = await runGit(
    input.root,
    ["symbolic-ref", "-q", input.checkpointRef],
    { allowNonZero: true, onGitCommand: input.onGitCommand }
  );
  if (symbolic.exitCode === 0) {
    throw new Error("ExecutionCheckpointRefCollisionError");
  }
  const existing = await runGit(
    input.root,
    ["rev-parse", "--verify", "--quiet", input.checkpointRef],
    { allowNonZero: true, onGitCommand: input.onGitCommand }
  );
  if (existing.exitCode === 0) {
    if (existing.stdout.toString("utf8").trim() !== input.commitObjectId) {
      throw new Error("ExecutionCheckpointRefCollisionError");
    }
    return;
  }
  await runGit(input.root, ["update-ref", "--stdin"], {
    input: Buffer.from(
      `create ${input.checkpointRef} ${input.commitObjectId}\n`
    ),
    onGitCommand: input.onGitCommand
  });
};

const changedStatus = (code: string): ExecutionCheckpointDiffFile["status"] => {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("C")) return "copied";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("T")) return "type_changed";
  return "unknown";
};

const safeRelativePath = (path: string): string => {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("ExecutionCheckpointPathError");
  }
  return path;
};

const nulFields = (value: string): string[] =>
  value.split("\0").filter(Boolean);

const nameStatus = async (root: string, from: string, to: string) => {
  const fields = nulFields(
    await gitText(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--name-status",
      "-z",
      from,
      to
    ])
  );
  const entries: Array<{ code: string; path: string; previousPath?: string }> =
    [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const previousPath = safeRelativePath(fields[index++]!);
      const path = safeRelativePath(fields[index++]!);
      entries.push({ code, path, previousPath });
    } else {
      entries.push({ code, path: safeRelativePath(fields[index++]!) });
    }
  }
  return entries;
};

export const captureExecutionCheckpoint = async (input: {
  workspace: ExecutionWorkspaceIdentity;
  executionId: string;
  executionGeneration: number;
  sequence: number;
  checkpointKind: ExecutionCheckpointKind;
  onGitCommand?: (args: readonly string[]) => void;
}): Promise<ExecutionCheckpointCapture> => {
  assertIdentity(input);
  if (input.workspace.vcsDriver !== "git") {
    return {
      status: "unsupported",
      vcsDriver: null,
      repositoryIdentityHash: null,
      worktreeIdentityHash: null,
      checkpointRef: null,
      commitObjectId: null,
      capturedAt: null
    };
  }

  const root = input.workspace.canonicalPath;
  if (!input.workspace.localGitDirectory) {
    throw new Error("ExecutionCheckpointIdentityError");
  }
  const temporary = await mkdtemp(
    resolve(input.workspace.localGitDirectory, "koed-index-")
  );
  const indexFile = resolve(temporary, "index");
  const checkpointRef = checkpointRefFor(input);
  try {
    const beforeHead = await resolveHead(root, input.onGitCommand);
    const beforeBranch = await resolveBranch(root, input.onGitCommand);
    if (beforeBranch !== input.workspace.branchRef) {
      throw new Error("ExecutionCheckpointWorkspaceChangedError");
    }

    await runGit(
      root,
      beforeHead ? ["read-tree", beforeHead] : ["read-tree", "--empty"],
      { indexFile, onGitCommand: input.onGitCommand }
    );
    await runGit(root, ["add", "-A", "--", "."], {
      indexFile,
      onGitCommand: input.onGitCommand
    });

    const workingChanged = await runGit(
      root,
      ["diff-files", "--quiet", "--ignore-submodules=none"],
      { indexFile, allowNonZero: true, onGitCommand: input.onGitCommand }
    );
    const newUntracked = await gitText(
      root,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { indexFile, onGitCommand: input.onGitCommand }
    );
    const afterHead = await resolveHead(root, input.onGitCommand);
    const afterBranch = await resolveBranch(root, input.onGitCommand);
    if (
      workingChanged.exitCode !== 0 ||
      newUntracked.length > 0 ||
      afterHead !== beforeHead ||
      afterBranch !== beforeBranch
    ) {
      throw new Error("ExecutionCheckpointConcurrentMutationError");
    }

    const treeObjectId = (
      await gitText(root, ["write-tree"], {
        indexFile,
        onGitCommand: input.onGitCommand
      })
    ).trim();
    if (!objectIdPattern.test(treeObjectId)) {
      throw new Error("ExecutionCheckpointTreeError");
    }
    const commitObjectId = (
      await gitText(
        root,
        ["commit-tree", treeObjectId, "-m", "koed checkpoint"],
        {
          onGitCommand: input.onGitCommand,
          indexFile,
          maxBuffer: maxGitOutputBytes,
          env: {
            GIT_AUTHOR_NAME: "Koed",
            GIT_AUTHOR_EMAIL: "checkpoint@koed.invalid",
            GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
            GIT_COMMITTER_NAME: "Koed",
            GIT_COMMITTER_EMAIL: "checkpoint@koed.invalid",
            GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
          }
        }
      )
    ).trim();
    if (!objectIdPattern.test(commitObjectId)) {
      throw new Error("ExecutionCheckpointCommitError");
    }
    await publishRef({
      root,
      checkpointRef,
      commitObjectId,
      ...(input.onGitCommand ? { onGitCommand: input.onGitCommand } : {})
    });
    return {
      status: "ready",
      vcsDriver: "git",
      repositoryIdentityHash: input.workspace.repositoryIdentityHash,
      worktreeIdentityHash: input.workspace.worktreeIdentityHash,
      checkpointRef,
      commitObjectId,
      capturedAt: new Date().toISOString()
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

export const diffExecutionCheckpoints = async (input: {
  workspace: ExecutionWorkspaceIdentity;
  from: ExecutionCheckpointCapture;
  to: ExecutionCheckpointCapture;
}): Promise<ExecutionCheckpointDiff | null> => {
  if (
    input.workspace.vcsDriver !== "git" ||
    input.from.status !== "ready" ||
    input.to.status !== "ready" ||
    !input.from.commitObjectId ||
    !input.to.commitObjectId
  ) {
    return null;
  }
  const root = input.workspace.canonicalPath;
  const changed = await nameStatus(
    root,
    input.from.commitObjectId,
    input.to.commitObjectId
  );
  const revisionDigest = sha256(
    `${input.from.commitObjectId}\0${input.to.commitObjectId}`
  );
  const files: ExecutionCheckpointDiffFile[] = [];
  let byteCount = 0;
  let truncated = false;
  for (const entry of changed) {
    const paths = [
      ...new Set(
        [entry.previousPath, entry.path].filter((value): value is string =>
          Boolean(value)
        )
      )
    ];
    const result = await runGit(
      root,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        input.from.commitObjectId,
        input.to.commitObjectId,
        "--",
        ...paths
      ],
      { allowNonZero: true, maxBuffer: maxPatchBytesPerFile }
    );
    const patch = result.exitCode === 0 ? result.stdout.toString("utf8") : null;
    const patchBytes = patch ? Buffer.byteLength(patch, "utf8") : 0;
    const patchTruncated =
      patch === null || byteCount + patchBytes > maxDiffBytes;
    if (patchTruncated) truncated = true;
    else byteCount += patchBytes;
    files.push({
      path: entry.path,
      ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
      status: changedStatus(entry.code),
      binary: Boolean(
        patch?.includes("GIT binary patch") || patch?.includes("Binary files ")
      ),
      patch: patchTruncated ? null : patch,
      patchTruncated
    });
  }
  return {
    fromCommitObjectId: input.from.commitObjectId,
    toCommitObjectId: input.to.commitObjectId,
    complete: !truncated,
    files,
    fileCount: files.length,
    returnedFileCount: files.length,
    byteCount,
    truncated,
    continuation: truncated
      ? {
          nextFileIndex: files.findIndex((file) => file.patchTruncated),
          revisionDigest
        }
      : null,
    revisionDigest
  };
};

export const restoreExecutionCheckpoint = async (input: {
  workspace: ExecutionWorkspaceIdentity;
  target: ExecutionCheckpointCapture;
  recovery: ExecutionCheckpointCapture;
}): Promise<void> => {
  if (
    input.workspace.vcsDriver !== "git" ||
    input.target.status !== "ready" ||
    input.recovery.status !== "ready" ||
    !input.target.commitObjectId ||
    !input.recovery.commitObjectId ||
    input.target.repositoryIdentityHash !==
      input.workspace.repositoryIdentityHash ||
    input.target.worktreeIdentityHash !==
      input.workspace.worktreeIdentityHash ||
    input.recovery.repositoryIdentityHash !==
      input.workspace.repositoryIdentityHash ||
    input.recovery.worktreeIdentityHash !==
      input.workspace.worktreeIdentityHash ||
    !input.workspace.localGitDirectory
  ) {
    throw new Error("ExecutionCheckpointRestoreUnavailableError");
  }
  const root = input.workspace.canonicalPath;
  const temporary = await mkdtemp(
    resolve(input.workspace.localGitDirectory, "koed-restore-index-")
  );
  const indexFile = resolve(temporary, "index");
  try {
    if (
      !(await workspaceMatchesExecutionCheckpoint({
        workspace: input.workspace,
        checkpoint: input.recovery
      }))
    ) {
      throw new Error("ExecutionCheckpointRestoreWorkspaceChangedError");
    }

    const removedPaths = nulFields(
      await gitText(root, [
        "diff",
        "--name-only",
        "--diff-filter=D",
        "-z",
        input.recovery.commitObjectId,
        input.target.commitObjectId
      ])
    ).map(safeRelativePath);
    for (const path of removedPaths) {
      await rm(resolve(root, path), { recursive: true, force: true });
    }

    await runGit(root, ["read-tree", input.target.commitObjectId], {
      indexFile
    });
    await runGit(root, ["checkout-index", "--all", "--force"], {
      indexFile
    });
    await runGit(root, ["add", "-A", "--", "."], { indexFile });
    const restoredTree = (
      await gitText(root, ["write-tree"], { indexFile })
    ).trim();
    const targetTree = (
      await gitText(root, [
        "rev-parse",
        `${input.target.commitObjectId}^{tree}`
      ])
    ).trim();
    if (restoredTree !== targetTree) {
      throw new Error("ExecutionCheckpointRestoreVerificationError");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

export const workspaceMatchesExecutionCheckpoint = async (input: {
  workspace: ExecutionWorkspaceIdentity;
  checkpoint: ExecutionCheckpointCapture;
}): Promise<boolean> => {
  if (
    input.workspace.vcsDriver !== "git" ||
    input.checkpoint.status !== "ready" ||
    !input.checkpoint.commitObjectId ||
    input.checkpoint.repositoryIdentityHash !==
      input.workspace.repositoryIdentityHash ||
    input.checkpoint.worktreeIdentityHash !==
      input.workspace.worktreeIdentityHash ||
    !input.workspace.localGitDirectory
  ) {
    return false;
  }
  const root = input.workspace.canonicalPath;
  const temporary = await mkdtemp(
    resolve(input.workspace.localGitDirectory, "koed-match-index-")
  );
  const indexFile = resolve(temporary, "index");
  try {
    await runGit(root, ["read-tree", input.checkpoint.commitObjectId], {
      indexFile
    });
    await runGit(root, ["add", "-A", "--", "."], { indexFile });
    const currentTree = (
      await gitText(root, ["write-tree"], { indexFile })
    ).trim();
    const checkpointTree = (
      await gitText(root, [
        "rev-parse",
        `${input.checkpoint.commitObjectId}^{tree}`
      ])
    ).trim();
    return currentTree === checkpointTree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

export const removeExecutionCheckpointRefs = async (input: {
  workspace: ExecutionWorkspaceIdentity;
  checkpoints: Array<
    Pick<ExecutionCheckpointCapture, "checkpointRef" | "commitObjectId">
  >;
}): Promise<void> => {
  if (input.workspace.vcsDriver !== "git") return;
  const commonDirectory = input.workspace.localRepositoryCommonDirectory;
  if (!commonDirectory) throw new Error("ExecutionCheckpointIdentityError");
  const removals: Array<{ ref: string; expected: string }> = [];
  for (const checkpoint of [...input.checkpoints].reverse()) {
    if (!checkpoint.checkpointRef || !checkpoint.commitObjectId) continue;
    if (
      !checkpointRefPattern.test(checkpoint.checkpointRef) ||
      !objectIdPattern.test(checkpoint.commitObjectId)
    ) {
      throw new Error("ExecutionCheckpointRefIdentityChangedError");
    }
    const current = await runGit(
      commonDirectory,
      [
        "--git-dir",
        commonDirectory,
        "rev-parse",
        "--verify",
        "--quiet",
        checkpoint.checkpointRef
      ],
      { allowNonZero: true }
    );
    if (current.exitCode !== 0) continue;
    if (current.stdout.toString("utf8").trim() !== checkpoint.commitObjectId) {
      throw new Error("ExecutionCheckpointRefIdentityChangedError");
    }
    removals.push({
      ref: checkpoint.checkpointRef,
      expected: checkpoint.commitObjectId
    });
  }
  if (removals.length === 0) return;
  const commands = [
    "start",
    ...removals.map(({ ref, expected }) => `delete ${ref} ${expected}`),
    "prepare",
    "commit",
    ""
  ].join("\n");
  await runGit(
    commonDirectory,
    ["--git-dir", commonDirectory, "update-ref", "--stdin", "--no-deref"],
    { input: Buffer.from(commands) }
  );
};
