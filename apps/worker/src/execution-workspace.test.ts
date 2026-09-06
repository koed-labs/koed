import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createGitExecutionWorkspaceDriver } from "@koed/shared/execution-workspace";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (name: string): string => {
  const path = mkdtempSync(join(tmpdir(), name));
  temporaryDirectories.push(path);
  return path;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

const gitMaybe = (cwd: string, ...args: string[]): string | null => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

const repository = (): string => {
  const path = temporaryDirectory("koed-workspace-repository-");
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Koed Test");
  git(path, "config", "user.email", "koed@example.test");
  writeFileSync(join(path, "README.md"), "initial\n");
  git(path, "add", "README.md");
  git(path, "commit", "-m", "initial");
  return path;
};

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runner-owned execution workspaces", () => {
  it("reports a non-Git directory without inventing VCS capabilities", async () => {
    const root = temporaryDirectory("koed-managed-root-");
    const project = temporaryDirectory("koed-non-git-project-");
    const driver = await createGitExecutionWorkspaceDriver({
      managedRoot: root
    });

    await expect(
      driver.select({ operationId: randomUUID(), path: project })
    ).resolves.toMatchObject({
      vcsDriver: null,
      ownership: "non_vcs_directory",
      canonicalPath: project,
      repositoryIdentityHash: null,
      branchRef: null
    });
  });

  it("creates, lists, verifies, retries, and removes one opaque managed worktree", async () => {
    const source = repository();
    const managedRoot = temporaryDirectory("koed-managed-root-");
    const driver = await createGitExecutionWorkspaceDriver({ managedRoot });
    const creation = {
      executionId: randomUUID(),
      executionGeneration: 1,
      operationId: randomUUID(),
      sourcePath: source
    };

    const created = await driver.create(creation);
    expect(created).toMatchObject({
      workspaceId: creation.operationId,
      vcsDriver: "git",
      ownership: "koed_managed_worktree",
      baseRef: "HEAD",
      baseObjectId: git(source, "rev-parse", "HEAD"),
      headObjectId: git(source, "rev-parse", "HEAD")
    });
    expect(created.branchRef).toBe(
      `refs/heads/koed/${creation.executionId}/1/${creation.operationId}`
    );
    expect(created.canonicalPath).toContain(managedRoot);
    expect(await driver.create(creation)).toMatchObject({
      workspaceId: created.workspaceId,
      worktreeIdentityHash: created.worktreeIdentityHash
    });
    expect(await driver.verify(created)).toMatchObject({
      repositoryIdentityHash: created.repositoryIdentityHash,
      worktreeIdentityHash: created.worktreeIdentityHash
    });
    expect(await driver.list(source)).toContainEqual(
      expect.objectContaining({
        workspaceId: created.workspaceId,
        ownership: "koed_managed_worktree",
        canonicalPath: created.canonicalPath,
        branchRef: created.branchRef
      })
    );
    await expect(
      driver.select({
        operationId: created.workspaceId,
        path: created.canonicalPath,
        expectedRepositoryIdentityHash: created.repositoryIdentityHash!
      })
    ).resolves.toMatchObject({
      workspaceId: created.workspaceId,
      ownership: "koed_managed_worktree",
      branchRef: created.branchRef
    });
    await expect(
      driver.select({
        operationId: randomUUID(),
        path: created.canonicalPath,
        expectedRepositoryIdentityHash: created.repositoryIdentityHash!
      })
    ).rejects.toThrow("ExecutionWorkspaceSelectionOwnershipError");

    await driver.remove(created);
    expect(
      gitMaybe(source, "show-ref", "--verify", created.branchRef!)
    ).toBeNull();
    expect(
      (await driver.list(source)).some(
        (workspace) => workspace.canonicalPath === created.canonicalPath
      )
    ).toBe(false);
  });

  it("recovers exact branch reservation and completed filesystem cleanup after process interruption", async () => {
    const source = repository();
    const managedRoot = temporaryDirectory("koed-managed-root-");
    const driver = await createGitExecutionWorkspaceDriver({ managedRoot });
    const creation = {
      executionId: randomUUID(),
      executionGeneration: 1,
      operationId: randomUUID(),
      sourcePath: source
    };
    const branchRef = `refs/heads/koed/${creation.executionId}/1/${creation.operationId}`;
    const headObjectId = git(source, "rev-parse", "HEAD");
    git(
      source,
      "update-ref",
      branchRef,
      headObjectId,
      "0000000000000000000000000000000000000000"
    );

    const created = await driver.create(creation);
    expect(created).toMatchObject({ branchRef, headObjectId });

    git(source, "worktree", "remove", created.canonicalPath);
    expect(git(source, "show-ref", "--verify", branchRef)).toContain(
      headObjectId
    );
    await driver.remove(created);
    await expect(driver.remove(created)).resolves.toBeUndefined();
    expect(gitMaybe(source, "show-ref", "--verify", branchRef)).toBeNull();
  });

  it("handles a linked-worktree source through the shared Git common directory", async () => {
    const source = repository();
    const linked = temporaryDirectory("koed-source-linked-");
    rmSync(linked, { recursive: true, force: true });
    git(source, "worktree", "add", "--detach", linked, "HEAD");
    const driver = await createGitExecutionWorkspaceDriver({
      managedRoot: temporaryDirectory("koed-managed-root-")
    });

    const sourceIdentity = await driver.inspect(source);
    const created = await driver.create({
      executionId: randomUUID(),
      executionGeneration: 3,
      operationId: randomUUID(),
      sourcePath: linked
    });

    expect(created.repositoryIdentityHash).toBe(
      sourceIdentity.repositoryIdentityHash
    );
    await driver.remove(created);
    git(source, "worktree", "remove", linked);
  });

  it("refuses dirty sources, dirty cleanup, and symlinked roots", async () => {
    const source = repository();
    const managedRoot = temporaryDirectory("koed-managed-root-");
    const driver = await createGitExecutionWorkspaceDriver({ managedRoot });
    writeFileSync(join(source, "README.md"), "dirty\n");
    await expect(
      driver.create({
        executionId: randomUUID(),
        executionGeneration: 1,
        operationId: randomUUID(),
        sourcePath: source
      })
    ).rejects.toThrow("ExecutionWorkspaceSourceDirtyError");
    git(source, "restore", "README.md");

    const created = await driver.create({
      executionId: randomUUID(),
      executionGeneration: 1,
      operationId: randomUUID(),
      sourcePath: source
    });
    writeFileSync(join(created.canonicalPath, "untracked.txt"), "retain me\n");
    await expect(driver.remove(created)).rejects.toThrow(
      "ExecutionWorkspaceCleanupDirtyError"
    );
    rmSync(join(created.canonicalPath, "untracked.txt"));
    writeFileSync(join(source, ".git", "info", "exclude"), "ignored.log\n");
    writeFileSync(
      join(created.canonicalPath, "ignored.log"),
      "retain me too\n"
    );
    await expect(driver.remove(created)).rejects.toThrow(
      "ExecutionWorkspaceCleanupDirtyError"
    );

    const symlinkParent = temporaryDirectory("koed-symlink-parent-");
    const symlink = join(symlinkParent, "project");
    symlinkSync(source, symlink, "dir");
    await expect(driver.inspect(symlink)).rejects.toThrow(
      "ExecutionWorkspaceDirectoryError"
    );

    const escaped = temporaryDirectory("koed-managed-escaped-");
    const executionId = randomUUID();
    symlinkSync(escaped, join(managedRoot, executionId), "dir");
    await expect(
      driver.create({
        executionId,
        executionGeneration: 1,
        operationId: randomUUID(),
        sourcePath: source
      })
    ).rejects.toThrow("ExecutionWorkspaceRootBoundaryError");
  });

  it("selects an existing dirty checkout only when its repository identity matches", async () => {
    const source = repository();
    const other = repository();
    const driver = await createGitExecutionWorkspaceDriver({
      managedRoot: temporaryDirectory("koed-managed-root-")
    });
    writeFileSync(join(source, "README.md"), "intentional local state\n");
    const sourceIdentity = await driver.inspect(source);

    await expect(
      driver.select({
        operationId: randomUUID(),
        path: source,
        expectedRepositoryIdentityHash: sourceIdentity.repositoryIdentityHash!
      })
    ).resolves.toMatchObject({
      ownership: "user_managed_checkout",
      canonicalPath: source,
      repositoryIdentityHash: sourceIdentity.repositoryIdentityHash
    });
    await expect(
      driver.select({
        operationId: randomUUID(),
        path: other,
        expectedRepositoryIdentityHash: sourceIdentity.repositoryIdentityHash!
      })
    ).rejects.toThrow("ExecutionWorkspaceSelectionIdentityError");
  });

  it("does not adopt a colliding operation-owned path", async () => {
    const source = repository();
    const managedRoot = temporaryDirectory("koed-managed-root-");
    const driver = await createGitExecutionWorkspaceDriver({ managedRoot });
    const executionId = randomUUID();
    const operationId = randomUUID();
    mkdirSync(join(managedRoot, executionId, "1", operationId), {
      recursive: true
    });

    await expect(
      driver.create({
        executionId,
        executionGeneration: 1,
        operationId,
        sourcePath: source
      })
    ).rejects.toThrow("ExecutionWorkspacePathCollisionError");
    expect(
      gitMaybe(
        source,
        "show-ref",
        "--verify",
        `refs/heads/koed/${executionId}/1/${operationId}`
      )
    ).toBeNull();
  });

  it("accepts a detached source but refuses an occupied opaque branch", async () => {
    const source = repository();
    const managedRoot = temporaryDirectory("koed-managed-root-");
    const driver = await createGitExecutionWorkspaceDriver({ managedRoot });
    git(source, "checkout", "--detach");
    await expect(driver.inspect(source)).resolves.toMatchObject({
      branchRef: null,
      ownership: "user_managed_checkout"
    });

    const detached = await driver.create({
      executionId: randomUUID(),
      executionGeneration: 1,
      operationId: randomUUID(),
      sourcePath: source
    });
    await driver.remove(detached);

    const executionId = randomUUID();
    const operationId = randomUUID();
    const branchRef = `refs/heads/koed/${executionId}/1/${operationId}`;
    git(source, "commit", "--allow-empty", "-m", "new base");
    const previousObjectId = git(source, "rev-parse", "HEAD^");
    git(source, "update-ref", branchRef, previousObjectId);
    await expect(
      driver.create({
        executionId,
        executionGeneration: 1,
        operationId,
        sourcePath: source
      })
    ).rejects.toThrow("ExecutionWorkspaceBranchCollisionError");
    expect(git(source, "show-ref", "--verify", branchRef)).toContain(
      previousObjectId
    );
  });

  it("refuses to remove a clean managed worktree whose HEAD advanced", async () => {
    const source = repository();
    const driver = await createGitExecutionWorkspaceDriver({
      managedRoot: temporaryDirectory("koed-managed-root-")
    });
    const created = await driver.create({
      executionId: randomUUID(),
      executionGeneration: 1,
      operationId: randomUUID(),
      sourcePath: source
    });
    writeFileSync(join(created.canonicalPath, "committed.txt"), "retained\n");
    git(created.canonicalPath, "add", "committed.txt");
    git(
      created.canonicalPath,
      "-c",
      "user.name=Koed Test",
      "-c",
      "user.email=koed@example.test",
      "commit",
      "-m",
      "advance"
    );

    await expect(driver.remove(created)).rejects.toThrow(
      "ExecutionWorkspaceCleanupChangedError"
    );
  });
});
