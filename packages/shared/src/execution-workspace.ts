import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

// This driver is shared by every server-side capability that acts on an execution workspace.

const execFileAsync = promisify(execFile);
const objectIdPattern = /^[0-9a-f]{40,64}$/;
const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ExecutionWorkspaceOwnership =
  | "koed_managed_worktree"
  | "user_managed_checkout"
  | "non_vcs_directory";

export interface ExecutionWorkspaceIdentity {
  workspaceId: string;
  vcsDriver: "git" | null;
  ownership: ExecutionWorkspaceOwnership;
  canonicalPath: string;
  localRepositoryCommonDirectory: string | null;
  localGitDirectory: string | null;
  repositoryIdentityHash: string | null;
  worktreeIdentityHash: string | null;
  baseRef: string | null;
  baseObjectId: string | null;
  branchRef: string | null;
  headObjectId: string | null;
}

export interface GitExecutionWorkspaceDriver {
  inspect(path: string): Promise<ExecutionWorkspaceIdentity>;
  list(repositoryPath: string): Promise<ExecutionWorkspaceIdentity[]>;
  select(input: {
    operationId: string;
    path: string;
    expectedRepositoryIdentityHash?: string;
  }): Promise<ExecutionWorkspaceIdentity>;
  create(input: {
    executionId: string;
    executionGeneration: number;
    operationId: string;
    sourcePath: string;
    baseRef?: string;
  }): Promise<ExecutionWorkspaceIdentity>;
  verify(
    workspace: ExecutionWorkspaceIdentity
  ): Promise<ExecutionWorkspaceIdentity>;
  remove(workspace: ExecutionWorkspaceIdentity): Promise<void>;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const requireOpaqueId = (value: string, name: string): string => {
  if (!opaqueIdPattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value.toLowerCase();
};

const requireGeneration = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Execution generation is invalid");
  }
  return value;
};

const git = async (
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {}
): Promise<string | null> => {
  try {
    const result = await execFileAsync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0"
        }
      }
    );
    return result.stdout.trim();
  } catch (error) {
    if (options.allowFailure) return null;
    throw Object.assign(new Error("ExecutionWorkspaceGitCommandError"), {
      name: "ExecutionWorkspaceGitCommandError",
      cause: error
    });
  }
};

const canonicalDirectory = async (path: string): Promise<string> => {
  const requested = resolve(path);
  const requestedMetadata = await lstat(requested).catch((error: unknown) => {
    throw Object.assign(new Error("ExecutionWorkspaceDirectoryError"), {
      name: "ExecutionWorkspaceDirectoryError",
      cause: error
    });
  });
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error("ExecutionWorkspaceDirectoryError");
  }
  const canonical = await realpath(requested).catch((error: unknown) => {
    throw Object.assign(new Error("ExecutionWorkspaceDirectoryError"), {
      name: "ExecutionWorkspaceDirectoryError",
      cause: error
    });
  });
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("ExecutionWorkspaceDirectoryError");
  }
  return canonical;
};

const gitIdentity = async (path: string) => {
  const topLevel = await git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel"
  ]);
  const commonDirectory = await git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]);
  const gitDirectory = await git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir"
  ]);
  const headObjectId = await git(path, ["rev-parse", "HEAD^{commit}"]);
  if (!topLevel || !commonDirectory || !gitDirectory || !headObjectId) {
    throw new Error("ExecutionWorkspaceGitIdentityError");
  }
  const canonicalPath = await canonicalDirectory(topLevel);
  const canonicalCommonDirectory = await realpath(commonDirectory);
  const canonicalGitDirectory = await realpath(gitDirectory);
  if (!objectIdPattern.test(headObjectId)) {
    throw new Error("ExecutionWorkspaceGitIdentityError");
  }
  return {
    canonicalPath,
    commonDirectory: canonicalCommonDirectory,
    gitDirectory: canonicalGitDirectory,
    repositoryIdentityHash: sha256(
      `git-common-directory\0${canonicalCommonDirectory}`
    ),
    worktreeIdentityHash: sha256(
      `git-worktree\0${canonicalCommonDirectory}\0${canonicalGitDirectory}\0${canonicalPath}`
    ),
    headObjectId
  };
};

const currentBranch = async (path: string): Promise<string | null> =>
  git(path, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true });

const dirty = async (
  path: string,
  includeIgnored = false
): Promise<boolean> => {
  const status = await git(path, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
    ...(includeIgnored ? ["--ignored=matching"] : []),
    "-z"
  ]);
  return Boolean(status);
};

const worktreePathForBranch = async (
  cwd: string,
  gitDirectory: string,
  branchRef: string
): Promise<string | null> => {
  const output = await git(cwd, [
    "--git-dir",
    gitDirectory,
    "worktree",
    "list",
    "--porcelain",
    "-z"
  ]);
  let worktreePath: string | null = null;
  for (const field of (output ?? "").split("\0")) {
    if (field.startsWith("worktree ")) {
      worktreePath = field.slice("worktree ".length);
    } else if (field === `branch ${branchRef}` && worktreePath) {
      return resolve(worktreePath);
    } else if (!field) {
      worktreePath = null;
    }
  }
  return null;
};

const ensureManagedDirectoryChain = async (
  managedRoot: string,
  directory: string
): Promise<void> => {
  const path = relative(managedRoot, directory);
  if (!path || path.startsWith(`..${sep}`) || path === "..") {
    throw new Error("ExecutionWorkspaceRootBoundaryError");
  }
  let current = managedRoot;
  for (const component of path.split(sep)) {
    current = resolve(current, component);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    });
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("ExecutionWorkspaceRootBoundaryError");
    }
    if ((await realpath(current)) !== current) {
      throw new Error("ExecutionWorkspaceRootBoundaryError");
    }
  }
};

const inspectGit = async (
  path: string,
  ownership: Exclude<ExecutionWorkspaceOwnership, "non_vcs_directory">,
  workspaceId: string = randomUUID(),
  baseRef: string | null = null,
  baseObjectId: string | null = null
): Promise<ExecutionWorkspaceIdentity> => {
  const identity = await gitIdentity(path);
  return {
    workspaceId,
    vcsDriver: "git",
    ownership,
    canonicalPath: identity.canonicalPath,
    localRepositoryCommonDirectory: identity.commonDirectory,
    localGitDirectory: identity.gitDirectory,
    repositoryIdentityHash: identity.repositoryIdentityHash,
    worktreeIdentityHash: identity.worktreeIdentityHash,
    baseRef,
    baseObjectId,
    branchRef: await currentBranch(identity.canonicalPath),
    headObjectId: identity.headObjectId
  };
};

export const createGitExecutionWorkspaceDriver = async (input: {
  managedRoot: string;
}): Promise<GitExecutionWorkspaceDriver> => {
  await mkdir(resolve(input.managedRoot), { recursive: true, mode: 0o700 });
  const managedRoot = await canonicalDirectory(input.managedRoot);

  const managedCoordinates = (
    canonicalPath: string
  ): {
    workspaceId: string;
    branchRef: string;
  } | null => {
    if (!inside(managedRoot, canonicalPath)) return null;
    const components = relative(managedRoot, canonicalPath).split(sep);
    if (
      components.length !== 3 ||
      !opaqueIdPattern.test(components[0]!) ||
      !/^[1-9][0-9]*$/.test(components[1]!) ||
      !opaqueIdPattern.test(components[2]!)
    ) {
      throw new Error("ExecutionWorkspaceIdentityChangedError");
    }
    const executionId = components[0]!.toLowerCase();
    const generation = Number(components[1]);
    const workspaceId = components[2]!.toLowerCase();
    if (!Number.isSafeInteger(generation)) {
      throw new Error("ExecutionWorkspaceIdentityChangedError");
    }
    return {
      workspaceId,
      branchRef: `refs/heads/koed/${executionId}/${generation}/${workspaceId}`
    };
  };

  const inspect = async (path: string): Promise<ExecutionWorkspaceIdentity> => {
    const canonicalPath = await canonicalDirectory(path);
    const isGit = await git(
      canonicalPath,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowFailure: true
      }
    );
    if (isGit !== "true") {
      return {
        workspaceId: randomUUID(),
        vcsDriver: null,
        ownership: "non_vcs_directory",
        canonicalPath,
        localRepositoryCommonDirectory: null,
        localGitDirectory: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        baseRef: null,
        baseObjectId: null,
        branchRef: null,
        headObjectId: null
      };
    }
    const managed = managedCoordinates(canonicalPath);
    if (!managed) {
      return inspectGit(canonicalPath, "user_managed_checkout");
    }
    const workspace = await inspectGit(
      canonicalPath,
      "koed_managed_worktree",
      managed.workspaceId
    );
    if (workspace.branchRef !== managed.branchRef) {
      throw new Error("ExecutionWorkspaceIdentityChangedError");
    }
    return workspace;
  };

  const verify = async (
    workspace: ExecutionWorkspaceIdentity
  ): Promise<ExecutionWorkspaceIdentity> => {
    if (workspace.vcsDriver !== "git") {
      const current = await inspect(workspace.canonicalPath);
      if (
        current.vcsDriver !== null ||
        current.canonicalPath !== workspace.canonicalPath ||
        workspace.ownership !== "non_vcs_directory"
      ) {
        throw new Error("ExecutionWorkspaceIdentityChangedError");
      }
      return { ...current, workspaceId: workspace.workspaceId };
    }
    const current = await inspectGit(
      workspace.canonicalPath,
      workspace.ownership === "koed_managed_worktree"
        ? "koed_managed_worktree"
        : "user_managed_checkout",
      workspace.workspaceId,
      workspace.baseRef,
      workspace.baseObjectId
    );
    if (
      current.repositoryIdentityHash !== workspace.repositoryIdentityHash ||
      current.worktreeIdentityHash !== workspace.worktreeIdentityHash ||
      current.branchRef !== workspace.branchRef ||
      (workspace.ownership === "koed_managed_worktree" &&
        !inside(managedRoot, current.canonicalPath))
    ) {
      throw new Error("ExecutionWorkspaceIdentityChangedError");
    }
    return current;
  };

  return {
    inspect,

    async list(repositoryPath) {
      const repository = await inspect(repositoryPath);
      if (repository.vcsDriver !== "git") return [repository];
      const output = await git(repository.canonicalPath, [
        "worktree",
        "list",
        "--porcelain",
        "-z"
      ]);
      const paths = (output ?? "")
        .split("\0")
        .filter((entry) => entry.startsWith("worktree "))
        .map((entry) => entry.slice("worktree ".length));
      const worktrees: ExecutionWorkspaceIdentity[] = [];
      for (const path of paths) {
        const candidate = await inspect(path);
        if (
          candidate.repositoryIdentityHash === repository.repositoryIdentityHash
        ) {
          worktrees.push(candidate);
        }
      }
      return worktrees;
    },

    async select(selectInput) {
      const workspaceId = requireOpaqueId(
        selectInput.operationId,
        "Workspace operation id"
      );
      const selected = await inspect(selectInput.path);
      if (
        selectInput.expectedRepositoryIdentityHash &&
        selected.repositoryIdentityHash !==
          selectInput.expectedRepositoryIdentityHash
      ) {
        throw new Error("ExecutionWorkspaceSelectionIdentityError");
      }
      if (
        selected.ownership === "koed_managed_worktree" &&
        selected.workspaceId !== workspaceId
      ) {
        throw new Error("ExecutionWorkspaceSelectionOwnershipError");
      }
      return { ...selected, workspaceId };
    },

    async create(createInput) {
      const executionId = requireOpaqueId(
        createInput.executionId,
        "Execution id"
      );
      const generation = requireGeneration(createInput.executionGeneration);
      const workspaceId = requireOpaqueId(
        createInput.operationId,
        "Workspace operation id"
      );
      const source = await inspect(createInput.sourcePath);
      if (source.vcsDriver !== "git") {
        throw new Error("ExecutionWorkspaceGitUnavailableError");
      }
      if (await dirty(source.canonicalPath)) {
        throw new Error("ExecutionWorkspaceSourceDirtyError");
      }
      const baseRef = createInput.baseRef?.trim() || "HEAD";
      const baseObjectId = await git(source.canonicalPath, [
        "rev-parse",
        "--verify",
        `${baseRef}^{commit}`
      ]);
      if (!baseObjectId || !objectIdPattern.test(baseObjectId)) {
        throw new Error("ExecutionWorkspaceBaseRefError");
      }
      const branchName = `koed/${executionId}/${generation}/${workspaceId}`;
      const branchRef = `refs/heads/${branchName}`;
      const workspacePath = resolve(
        managedRoot,
        executionId,
        String(generation),
        workspaceId
      );
      if (!inside(managedRoot, workspacePath)) {
        throw new Error("ExecutionWorkspaceRootBoundaryError");
      }
      await ensureManagedDirectoryChain(managedRoot, dirname(workspacePath));
      if (
        await lstat(workspacePath)
          .then(() => true)
          .catch(() => false)
      ) {
        const existing = await inspectGit(
          workspacePath,
          "koed_managed_worktree",
          workspaceId,
          baseRef,
          baseObjectId
        ).catch(() => null);
        if (
          existing?.repositoryIdentityHash === source.repositoryIdentityHash &&
          existing.branchRef === branchRef &&
          existing.headObjectId === baseObjectId
        ) {
          return existing;
        }
        throw new Error("ExecutionWorkspacePathCollisionError");
      }
      const existingBranchObjectId = await git(
        source.canonicalPath,
        ["rev-parse", "--verify", `${branchRef}^{commit}`],
        { allowFailure: true }
      );
      if (existingBranchObjectId && existingBranchObjectId !== baseObjectId) {
        throw new Error("ExecutionWorkspaceBranchCollisionError");
      }
      const attachedPath = existingBranchObjectId
        ? await worktreePathForBranch(
            managedRoot,
            source.localRepositoryCommonDirectory!,
            branchRef
          )
        : null;
      if (attachedPath) {
        throw new Error("ExecutionWorkspaceBranchCollisionError");
      }
      let createdBranch = false;
      if (!existingBranchObjectId) {
        await git(source.canonicalPath, [
          "update-ref",
          branchRef,
          baseObjectId,
          "0000000000000000000000000000000000000000"
        ]);
        createdBranch = true;
      }
      try {
        await git(source.canonicalPath, [
          "worktree",
          "add",
          "--no-guess-remote",
          workspacePath,
          branchName
        ]);
        const created = await inspectGit(
          workspacePath,
          "koed_managed_worktree",
          workspaceId,
          baseRef,
          baseObjectId
        );
        if (
          created.repositoryIdentityHash !== source.repositoryIdentityHash ||
          created.branchRef !== branchRef ||
          created.headObjectId !== baseObjectId ||
          !inside(managedRoot, created.canonicalPath)
        ) {
          throw new Error("ExecutionWorkspaceCreationVerificationError");
        }
        return created;
      } catch (error) {
        if (createdBranch) {
          await git(
            source.canonicalPath,
            ["worktree", "remove", workspacePath],
            { allowFailure: true }
          );
          await git(
            source.canonicalPath,
            ["update-ref", "-d", branchRef, baseObjectId],
            { allowFailure: true }
          );
        }
        throw error;
      }
    },

    verify,

    async remove(workspace) {
      if (
        workspace.vcsDriver !== "git" ||
        workspace.ownership !== "koed_managed_worktree" ||
        !workspace.branchRef ||
        !workspace.headObjectId ||
        !workspace.localRepositoryCommonDirectory
      ) {
        throw new Error("ExecutionWorkspaceCleanupOwnershipError");
      }
      const commonDirectory = await realpath(
        workspace.localRepositoryCommonDirectory
      );
      if (
        sha256(`git-common-directory\0${commonDirectory}`) !==
        workspace.repositoryIdentityHash
      ) {
        throw new Error("ExecutionWorkspaceCleanupIdentityError");
      }
      const pathExists = await lstat(workspace.canonicalPath)
        .then(() => true)
        .catch(() => false);
      if (!pathExists) {
        const attachedPath = await worktreePathForBranch(
          managedRoot,
          commonDirectory,
          workspace.branchRef
        );
        if (attachedPath) {
          throw new Error("ExecutionWorkspaceCleanupIdentityError");
        }
        const branchObjectId = await git(
          managedRoot,
          [
            "--git-dir",
            commonDirectory,
            "rev-parse",
            "--verify",
            `${workspace.branchRef}^{commit}`
          ],
          { allowFailure: true }
        );
        if (branchObjectId && branchObjectId !== workspace.headObjectId) {
          throw new Error("ExecutionWorkspaceCleanupChangedError");
        }
        if (branchObjectId) {
          await git(managedRoot, [
            "--git-dir",
            commonDirectory,
            "update-ref",
            "-d",
            workspace.branchRef,
            workspace.headObjectId
          ]);
        }
        return;
      }
      const verified = await verify(workspace);
      if (verified.headObjectId !== workspace.headObjectId) {
        throw new Error("ExecutionWorkspaceCleanupChangedError");
      }
      if (await dirty(verified.canonicalPath, true)) {
        throw new Error("ExecutionWorkspaceCleanupDirtyError");
      }
      await git(managedRoot, [
        "--git-dir",
        commonDirectory,
        "worktree",
        "remove",
        verified.canonicalPath
      ]);
      await git(managedRoot, [
        "--git-dir",
        commonDirectory,
        "update-ref",
        "-d",
        workspace.branchRef,
        workspace.headObjectId
      ]);
    }
  };
};
