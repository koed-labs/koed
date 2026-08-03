import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDevelopmentWorkspaceSnapshot,
  materializeDevelopmentWorkspaceSnapshot
} from "./development-workspace-snapshot.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileAsync("git", args, { cwd, encoding: "utf8" });

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "koed-workspace-source-"));
  roots.push(root);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Koed Test");
  await git(root, "config", "user.email", "koed@example.invalid");
  await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
  await writeFile(join(root, "staged.txt"), "base\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Development Workspace Snapshot", () => {
  it("reconstructs staged, unstaged, and untracked local-only Git state", async () => {
    const source = await repository();
    await writeFile(join(source, "staged.txt"), "staged change\n", "utf8");
    await git(source, "add", "staged.txt");
    await writeFile(join(source, "tracked.txt"), "working change\n", "utf8");
    await writeFile(join(source, "untracked.txt"), "local only\n", "utf8");

    const snapshot = await createDevelopmentWorkspaceSnapshot(source);
    const targetRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    roots.push(targetRoot);
    const target = join(targetRoot, "restored");
    await expect(
      materializeDevelopmentWorkspaceSnapshot(snapshot, target, targetRoot)
    ).resolves.toMatchObject({
      path: target,
      stateDigest: snapshot.sourceStateDigest
    });

    await expect(readFile(join(target, "tracked.txt"), "utf8")).resolves.toBe(
      "working change\n"
    );
    await expect(readFile(join(target, "staged.txt"), "utf8")).resolves.toBe(
      "staged change\n"
    );
    await expect(readFile(join(target, "untracked.txt"), "utf8")).resolves.toBe(
      "local only\n"
    );
    await expect(
      git(target, "diff", "--cached", "--name-only").then(({ stdout }) =>
        stdout.trim()
      )
    ).resolves.toBe("staged.txt");
    await expect(
      git(target, "diff", "--name-only").then(({ stdout }) => stdout.trim())
    ).resolves.toBe("tracked.txt");
  });

  it("reconstructs staged and unstaged tracked deletions", async () => {
    const source = await repository();
    await rm(join(source, "staged.txt"));
    await git(source, "add", "staged.txt");
    await rm(join(source, "tracked.txt"));

    const snapshot = await createDevelopmentWorkspaceSnapshot(source);
    const targetRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    roots.push(targetRoot);
    const target = join(targetRoot, "restored");
    await expect(
      materializeDevelopmentWorkspaceSnapshot(snapshot, target, targetRoot)
    ).resolves.toMatchObject({
      path: target,
      stateDigest: snapshot.sourceStateDigest
    });

    await expect(readFile(join(target, "staged.txt"), "utf8")).rejects.toThrow(
      "ENOENT"
    );
    await expect(readFile(join(target, "tracked.txt"), "utf8")).rejects.toThrow(
      "ENOENT"
    );
    await expect(
      git(target, "status", "--short").then(({ stdout }) => stdout)
    ).resolves.toBe("D  staged.txt\n D tracked.txt\n");
  });

  it("restores sanitized changed remote configuration without credentials", async () => {
    const source = await repository();
    await git(
      source,
      "remote",
      "add",
      "origin",
      "https://git.example.invalid/acme/project.git"
    );
    await git(
      source,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "ssh://git@git.example.invalid/acme/project.git"
    );
    const snapshot = await createDevelopmentWorkspaceSnapshot(source);
    const targetRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    roots.push(targetRoot);
    const target = join(targetRoot, "restored");

    await materializeDevelopmentWorkspaceSnapshot(snapshot, target, targetRoot);

    await expect(
      git(target, "remote", "get-url", "origin").then(({ stdout }) =>
        stdout.trim()
      )
    ).resolves.toBe("https://git.example.invalid/acme/project.git");
    await expect(
      git(target, "remote", "get-url", "--push", "origin").then(({ stdout }) =>
        stdout.trim()
      )
    ).resolves.toBe("ssh://git@git.example.invalid/acme/project.git");
  });

  it("rejects credential-bearing and device-local remote URLs", async () => {
    const credentialRemote = await repository();
    await git(
      credentialRemote,
      "remote",
      "add",
      "origin",
      "https://alice:secret@git.example.invalid/acme/project.git"
    );
    await expect(
      createDevelopmentWorkspaceSnapshot(credentialRemote)
    ).rejects.toThrow("WorkspaceSnapshotRemoteCredentialError");

    const localRemote = await repository();
    await git(localRemote, "remote", "add", "origin", "../bare-repository");
    await expect(
      createDevelopmentWorkspaceSnapshot(localRemote)
    ).rejects.toThrow("WorkspaceSnapshotLocalRemoteUnsupportedError");
  });

  it("fails closed for known secrets and modified packages", async () => {
    const source = await repository();
    await writeFile(join(source, ".env"), "TOKEN=secret\n", "utf8");
    await expect(createDevelopmentWorkspaceSnapshot(source)).rejects.toThrow(
      "WorkspaceSnapshotSecretPathError"
    );
    await rm(join(source, ".env"));
    const snapshot = await createDevelopmentWorkspaceSnapshot(source);
    snapshot.bundleBase64 = `${snapshot.bundleBase64.slice(0, -4)}AAAA`;
    const targetRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    roots.push(targetRoot);
    await expect(
      materializeDevelopmentWorkspaceSnapshot(
        snapshot,
        join(targetRoot, "restored"),
        targetRoot
      )
    ).rejects.toThrow("WorkspaceSnapshotDigestError");
  });

  it("allows environment templates but still scans their content", async () => {
    const safe = await repository();
    await writeFile(
      join(safe, ".env.example"),
      "SERVICE_TOKEN=replace-me\n",
      "utf8"
    );
    await git(safe, "add", ".env.example");
    await git(safe, "commit", "-m", "safe environment template");
    await expect(createDevelopmentWorkspaceSnapshot(safe)).resolves.toEqual(
      expect.objectContaining({
        protocol: "koed-development-workspace-snapshot-v1"
      })
    );

    const unsafe = await repository();
    const credentialShapedValue = ["sk", "live", "x".repeat(32)].join("_");
    await writeFile(
      join(unsafe, ".env.production.example"),
      `SERVICE_TOKEN=${credentialShapedValue}\n`,
      "utf8"
    );
    await git(unsafe, "add", ".env.production.example");
    await git(unsafe, "commit", "-m", "unsafe environment template");
    await expect(createDevelopmentWorkspaceSnapshot(unsafe)).rejects.toThrow(
      "WorkspaceSnapshotSecretContentError"
    );
  });

  it("rejects secrets introduced through staged or tracked working bytes", async () => {
    const staged = await repository();
    await writeFile(join(staged, ".env.production"), "TOKEN=secret\n", "utf8");
    await git(staged, "add", ".env.production");
    await expect(createDevelopmentWorkspaceSnapshot(staged)).rejects.toThrow(
      "WorkspaceSnapshotSecretPathError"
    );

    const working = await repository();
    const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    await writeFile(
      join(working, "tracked.txt"),
      `${privateKeyHeader}\n${"x".repeat(64)}\n`,
      "utf8"
    );
    await expect(createDevelopmentWorkspaceSnapshot(working)).rejects.toThrow(
      "WorkspaceSnapshotSecretContentError"
    );
  });

  it("never overwrites an existing destination", async () => {
    const source = await repository();
    const snapshot = await createDevelopmentWorkspaceSnapshot(source);
    const targetRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    roots.push(targetRoot);
    const target = join(targetRoot, "existing");
    await mkdir(target);
    await expect(
      materializeDevelopmentWorkspaceSnapshot(snapshot, target, targetRoot)
    ).rejects.toThrow("WorkspaceSnapshotTargetExistsError");
  });

  it("rejects nested repositories and symlinks it cannot reproduce exactly", async () => {
    const nested = await repository();
    await mkdir(join(nested, "nested"));
    await git(join(nested, "nested"), "init");
    await expect(createDevelopmentWorkspaceSnapshot(nested)).rejects.toThrow(
      "WorkspaceSnapshotNestedRepositoryError"
    );

    const linked = await repository();
    await symlink("tracked.txt", join(linked, "linked.txt"));
    await expect(createDevelopmentWorkspaceSnapshot(linked)).rejects.toThrow(
      "WorkspaceSnapshotSymlinkUnsupportedError"
    );
  });

  it("ignores excluded dependency symlinks outside the packaged source set", async () => {
    const source = await repository();
    await writeFile(join(source, ".gitignore"), "node_modules/\n", "utf8");
    await git(source, "add", ".gitignore");
    await git(source, "commit", "-m", "ignore dependencies");
    await mkdir(join(source, "node_modules"));
    await symlink("../tracked.txt", join(source, "node_modules", "package"));

    await expect(createDevelopmentWorkspaceSnapshot(source)).resolves.toEqual(
      expect.objectContaining({
        protocol: "koed-development-workspace-snapshot-v1"
      })
    );
  });

  it("rejects semantic index flags that the package cannot reproduce", async () => {
    const source = await repository();
    await git(source, "update-index", "--skip-worktree", "tracked.txt");

    await expect(createDevelopmentWorkspaceSnapshot(source)).rejects.toThrow(
      "WorkspaceSnapshotIndexFlagsError"
    );
  });

  it("reconstructs local state from a linked worktree", async () => {
    const source = await repository();
    const linked = await mkdtemp(join(tmpdir(), "koed-linked-worktree-"));
    await rm(linked, { recursive: true, force: true });
    roots.push(linked);
    await git(source, "worktree", "add", "--detach", linked);
    await writeFile(join(linked, "staged.txt"), "linked staged\n", "utf8");
    await git(linked, "add", "staged.txt");
    await writeFile(join(linked, "tracked.txt"), "linked working\n", "utf8");
    await writeFile(join(linked, "untracked.txt"), "linked local\n", "utf8");

    const snapshot = await createDevelopmentWorkspaceSnapshot(linked);
    const targetRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    roots.push(targetRoot);
    const target = join(targetRoot, "restored");
    await materializeDevelopmentWorkspaceSnapshot(snapshot, target, targetRoot);

    await expect(readFile(join(target, "staged.txt"), "utf8")).resolves.toBe(
      "linked staged\n"
    );
    await expect(readFile(join(target, "tracked.txt"), "utf8")).resolves.toBe(
      "linked working\n"
    );
    await expect(readFile(join(target, "untracked.txt"), "utf8")).resolves.toBe(
      "linked local\n"
    );
  });

  it("rejects content transforms it cannot reproduce", async () => {
    const transformed = await repository();
    await writeFile(
      join(transformed, ".gitattributes"),
      "*.txt filter=unsafe\n",
      "utf8"
    );
    await git(transformed, "add", ".gitattributes");
    await git(transformed, "commit", "-m", "attributes");
    await expect(
      createDevelopmentWorkspaceSnapshot(transformed)
    ).rejects.toThrow("WorkspaceSnapshotContentTransformUnsupportedError");
  });

  it("rejects Git LFS pointers until their object closure is portable", async () => {
    const source = await repository();
    await writeFile(
      join(source, "large.bin"),
      [
        "version https://git-lfs.github.com/spec/v1",
        `oid sha256:${"a".repeat(64)}`,
        "size 1234",
        ""
      ].join("\n"),
      "utf8"
    );
    await git(source, "add", "large.bin");
    await git(source, "commit", "-m", "lfs pointer");
    await expect(createDevelopmentWorkspaceSnapshot(source)).rejects.toThrow(
      "WorkspaceSnapshotLfsUnsupportedError"
    );
  });

  it("rejects a destination reached through a symlinked directory", async () => {
    const source = await repository();
    const snapshot = await createDevelopmentWorkspaceSnapshot(source);
    const trustedRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    const outside = await mkdtemp(join(tmpdir(), "koed-workspace-outside-"));
    roots.push(trustedRoot, outside);
    await symlink(outside, join(trustedRoot, "redirect"));

    await expect(
      materializeDevelopmentWorkspaceSnapshot(
        snapshot,
        join(trustedRoot, "redirect", "restored"),
        trustedRoot
      )
    ).rejects.toThrow("WorkspaceSnapshotUnsafeDirectoryError");
  });

  it("rejects malformed encodings, duplicate paths, and unknown package fields", async () => {
    const source = await repository();
    await writeFile(join(source, "untracked.txt"), "local\n", "utf8");
    const snapshot = await createDevelopmentWorkspaceSnapshot(source);
    const targetRoot = await mkdtemp(join(tmpdir(), "koed-workspace-target-"));
    roots.push(targetRoot);

    await expect(
      materializeDevelopmentWorkspaceSnapshot(
        { ...snapshot, bundleBase64: "not-base64" },
        join(targetRoot, "bad-encoding"),
        targetRoot
      )
    ).rejects.toThrow("WorkspaceSnapshotEncodingError");
    await expect(
      materializeDevelopmentWorkspaceSnapshot(
        { ...snapshot, bundleBase64: "!!!!" },
        join(targetRoot, "bad-alphabet"),
        targetRoot
      )
    ).rejects.toThrow("WorkspaceSnapshotEncodingError");
    await expect(
      materializeDevelopmentWorkspaceSnapshot(
        {
          ...snapshot,
          untrackedFiles: [
            snapshot.untrackedFiles[0]!,
            snapshot.untrackedFiles[0]!
          ]
        },
        join(targetRoot, "duplicate"),
        targetRoot
      )
    ).rejects.toThrow("WorkspaceSnapshotDuplicatePathError");
    await expect(
      materializeDevelopmentWorkspaceSnapshot(
        { ...snapshot, unexpected: true } as never,
        join(targetRoot, "unknown"),
        targetRoot
      )
    ).rejects.toThrow("WorkspaceSnapshotShapeError");
  });
});
