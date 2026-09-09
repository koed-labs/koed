import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureExecutionCheckpoint,
  diffExecutionCheckpoints,
  removeExecutionCheckpointRefs,
  restoreExecutionCheckpoint
} from "./execution-checkpoint.js";
import { createGitExecutionCheckoutDriver } from "@koed/shared/execution-checkout";

const roots: string[] = [];
const executionId = "b900056f-3845-4cab-b555-44b8fc1c9a16";
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

const fixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), "koed-checkpoint-test-"));
  roots.push(root);
  const source = resolve(root, "source");
  await mkdir(source);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Koed Test");
  git(source, "config", "user.email", "test@example.invalid");
  await writeFile(resolve(source, "tracked.txt"), "base\n");
  await writeFile(resolve(source, "rename.txt"), "rename\n");
  await writeFile(resolve(source, ".gitignore"), "ignored.txt\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  const driver = await createGitExecutionCheckoutDriver({
    managedRoot: resolve(root, "managed")
  });
  const checkout = await driver.select({
    operationId: "0f42d55a-f40e-46a9-ba54-454869ace13e",
    path: source
  });
  return { root, source, checkout };
};

const capture = (
  checkout: Awaited<ReturnType<typeof fixture>>["checkout"],
  sequence: number,
  checkpointKind: "baseline" | "terminal" | "recovery",
  onGitCommand?: (args: readonly string[]) => void
) =>
  captureExecutionCheckpoint({
    checkout,
    executionId,
    executionGeneration: 1,
    sequence,
    checkpointKind,
    ...(onGitCommand ? { onGitCommand } : {})
  });

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("execution checkpoints", () => {
  it("withholds denied content from both sides of patches, including renamed files", async () => {
    const { source, checkout } = await fixture();
    const privateMaterial = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    await writeFile(resolve(source, ".env"), "LOCAL_SETTING=private-before\n");
    await writeFile(resolve(source, "old.txt"), `${privateMaterial}\n`);
    await writeFile(
      resolve(source, "moved.txt"),
      `${privateMaterial}\nunchanged\n`
    );
    const baseline = await capture(checkout, 1, "baseline");
    await writeFile(resolve(source, ".env"), "LOCAL_SETTING=private-after\n");
    await writeFile(resolve(source, "old.txt"), "public now\n");
    await rm(resolve(source, "moved.txt"));
    await writeFile(
      resolve(source, "renamed.txt"),
      `${privateMaterial}\nunchanged\n`
    );
    await writeFile(resolve(source, "new.txt"), `${privateMaterial}\n`);
    await writeFile(resolve(source, "tracked.txt"), "visible change\n");
    const terminal = await capture(checkout, 1, "terminal");
    const diff = await diffExecutionCheckpoints({
      checkout,
      from: baseline,
      to: terminal
    });
    expect(
      diff?.files.find((file) => file.path === "tracked.txt")?.patch
    ).toContain("visible change");
    for (const file of diff!.files.filter(
      (file) => file.path !== "tracked.txt"
    )) {
      expect(file).toMatchObject({
        patch: null,
        patchTruncated: false,
        contentExcluded: true
      });
    }
    expect(
      diff!.files.find((file) => file.path === "renamed.txt")
    ).toMatchObject({ previousPath: "moved.txt" });
    expect(JSON.stringify(diff)).not.toContain(privateMaterial);
    expect(JSON.stringify(diff)).not.toContain("private-before");
    expect(JSON.stringify(diff)).not.toContain("private-after");
  });

  it("restores file/directory transitions in both directions", async () => {
    const { source, checkout } = await fixture();
    await writeFile(resolve(source, "item"), "original file\n");
    const target = await capture(checkout, 1, "baseline");
    await rm(resolve(source, "item"));
    await mkdir(resolve(source, "item/nested"), { recursive: true });
    await writeFile(resolve(source, "item/nested/child"), "nested file\n");
    const recovery = await capture(checkout, 2, "recovery");
    await restoreExecutionCheckpoint({ checkout, target, recovery });
    expect(await readFile(resolve(source, "item"), "utf8")).toBe(
      "original file\n"
    );
    const restored = await capture(checkout, 3, "recovery");
    await restoreExecutionCheckpoint({
      checkout,
      target: recovery,
      recovery: restored
    });
    expect(await readFile(resolve(source, "item/nested/child"), "utf8")).toBe(
      "nested file\n"
    );
  });

  it("preserves ignored content when it prevents a directory-to-file restore", async () => {
    const { source, checkout } = await fixture();
    await writeFile(resolve(source, ".gitignore"), "ignored.txt\n");
    await writeFile(resolve(source, "item"), "original file\n");
    const target = await capture(checkout, 1, "baseline");
    await rm(resolve(source, "item"));
    await mkdir(resolve(source, "item"));
    await writeFile(resolve(source, "item/child"), "tracked child\n");
    await writeFile(
      resolve(source, "item/ignored.txt"),
      "retained local content\n"
    );
    const recovery = await capture(checkout, 2, "recovery");
    await expect(
      restoreExecutionCheckpoint({ checkout, target, recovery })
    ).rejects.toThrow("CheckoutChanged");
    expect(await readFile(resolve(source, "item/child"), "utf8")).toBe(
      "tracked child\n"
    );
    expect(await readFile(resolve(source, "item/ignored.txt"), "utf8")).toBe(
      "retained local content\n"
    );
  });

  it("uses the checkpoint's original objects when local replacement refs exist", async () => {
    const { source, checkout } = await fixture();
    const baseline = await capture(checkout, 1, "baseline");
    await writeFile(resolve(source, "tracked.txt"), "updated\n");
    const terminal = await capture(checkout, 1, "terminal");
    git(
      source,
      "update-ref",
      `refs/replace/${baseline.commitObjectId}`,
      terminal.commitObjectId!
    );
    const diff = await diffExecutionCheckpoints({
      checkout,
      from: baseline,
      to: terminal
    });
    expect(
      diff!.files.find((file) => file.path === "tracked.txt")?.patch
    ).toContain("-base");
    await restoreExecutionCheckpoint({
      checkout,
      target: baseline,
      recovery: terminal
    });
    expect(await readFile(resolve(source, "tracked.txt"), "utf8")).toBe(
      "base\n"
    );
  });
  it("captures a large Project with a bounded number of Git processes", async () => {
    const { source, checkout } = await fixture();
    const directory = resolve(source, "many-files");
    await mkdir(directory);
    await Promise.all(
      Array.from({ length: 750 }, (_, index) =>
        writeFile(resolve(directory, `${index}.txt`), `file ${index}\n`)
      )
    );
    git(source, "add", "many-files");
    git(source, "commit", "-m", "many tracked files");
    const commands: readonly string[][] = [];

    const checkpoint = await capture(checkout, 1, "baseline", (args) =>
      (commands as string[][]).push([...args])
    );

    expect(checkpoint.status).toBe("ready");
    expect(commands.length).toBeLessThanOrEqual(14);
    expect(commands.some((args) => args[0] === "add" && args[1] === "-A")).toBe(
      true
    );
  });

  it("captures staged, unstaged, untracked, deleted, renamed, binary, and mode changes without mutating Git state", async () => {
    const { source, checkout } = await fixture();
    const baseline = await capture(checkout, 1, "baseline");

    await writeFile(resolve(source, "tracked.txt"), "staged\n");
    git(source, "add", "tracked.txt");
    await writeFile(resolve(source, "tracked.txt"), "working\n");
    await writeFile(resolve(source, "untracked.txt"), "new\n");
    await writeFile(
      resolve(source, "binary.bin"),
      Buffer.from([0, 1, 2, 3, 0xff])
    );
    git(source, "mv", "rename.txt", "renamed.txt");
    await writeFile(resolve(source, "executable.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(resolve(source, "executable.sh"), 0o755);
    const expectedStatus = git(source, "status", "--porcelain=v2", "-z");

    const terminal = await capture(checkout, 1, "terminal");
    const diff = await diffExecutionCheckpoints({
      checkout,
      from: baseline,
      to: terminal
    });

    expect(diff?.complete).toBe(true);
    expect(diff?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "binary.bin",
        "executable.sh",
        "renamed.txt",
        "tracked.txt",
        "untracked.txt"
      ])
    );
    expect(
      diff?.files.find((file) => file.path === "renamed.txt")
    ).toMatchObject({
      previousPath: "rename.txt",
      status: "renamed"
    });
    expect(diff?.files.find((file) => file.path === "binary.bin")?.binary).toBe(
      true
    );
    expect(git(source, "status", "--porcelain=v2", "-z")).toBe(expectedStatus);
  });

  it("uses normal Git ignore semantics", async () => {
    const { source, checkout } = await fixture();
    const baseline = await capture(checkout, 1, "baseline");
    await writeFile(resolve(source, "ignored.txt"), "local only\n");
    await writeFile(resolve(source, "included.txt"), "included\n");
    const terminal = await capture(checkout, 1, "terminal");
    const diff = await diffExecutionCheckpoints({
      checkout,
      from: baseline,
      to: terminal
    });

    expect(diff?.files.map((file) => file.path)).toContain("included.txt");
    expect(diff?.files.map((file) => file.path)).not.toContain("ignored.txt");
  });

  it("fails when the checkout mutates during capture", async () => {
    const { source, checkout } = await fixture();
    let changed = false;
    await expect(
      capture(checkout, 1, "baseline", (args) => {
        if (!changed && args[0] === "diff-files") {
          changed = true;
          writeFileSync(
            resolve(source, "tracked.txt"),
            "changed during capture\n"
          );
        }
      })
    ).rejects.toThrow("ExecutionCheckpointConcurrentMutationError");
  });

  it("rejects a branch change from the bound execution checkout", async () => {
    const { source, checkout } = await fixture();
    git(source, "switch", "-c", "unexpected-branch");
    await expect(capture(checkout, 1, "baseline")).rejects.toThrow(
      "ExecutionCheckpointCheckoutChangedError"
    );
  });

  it("replays an identical ref idempotently and rejects a collision", async () => {
    const { source, checkout } = await fixture();
    const first = await capture(checkout, 1, "baseline");
    expect(await capture(checkout, 1, "baseline")).toEqual(
      expect.objectContaining({ commitObjectId: first.commitObjectId })
    );
    git(source, "update-ref", first.checkpointRef!, "HEAD");
    await expect(capture(checkout, 1, "baseline")).rejects.toThrow(
      "ExecutionCheckpointRefCollisionError"
    );
  });

  it("reports checkpoint capability as unsupported outside Git", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-checkpoint-non-git-"));
    roots.push(root);
    const checkpoint = await captureExecutionCheckpoint({
      checkout: {
        checkoutId: "non-git",
        vcsDriver: null,
        ownership: "non_vcs_directory",
        canonicalPath: root,
        localRepositoryCommonDirectory: null,
        localGitDirectory: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        baseRef: null,
        baseObjectId: null,
        branchRef: null,
        headObjectId: null
      },
      executionId,
      executionGeneration: 1,
      sequence: 1,
      checkpointKind: "baseline"
    });
    expect(checkpoint).toEqual({
      status: "unsupported",
      vcsDriver: null,
      repositoryIdentityHash: null,
      worktreeIdentityHash: null,
      checkpointRef: null,
      commitObjectId: null,
      capturedAt: null
    });
  });

  it("restores content while preserving ignored files", async () => {
    const { source, checkout } = await fixture();
    const baseline = await capture(checkout, 1, "baseline");
    await writeFile(resolve(source, "tracked.txt"), "agent change\n");
    await writeFile(resolve(source, "new.txt"), "new\n");
    await writeFile(resolve(source, "ignored.txt"), "keep me\n");
    git(source, "add", "tracked.txt");
    const indexBefore = git(source, "write-tree");
    const recovery = await capture(checkout, 2, "recovery");
    await restoreExecutionCheckpoint({ checkout, target: baseline, recovery });

    expect(git(source, "show", `${baseline.commitObjectId}:tracked.txt`)).toBe(
      "base"
    );
    expect(git(source, "status", "--porcelain", "--", "new.txt")).toBe("");
    expect(git(source, "check-ignore", "ignored.txt")).toBe("ignored.txt");
    expect(git(source, "write-tree")).toBe(indexBefore);
  });

  it("refuses Restore when the checkout changed after its recovery checkpoint", async () => {
    const { source, checkout } = await fixture();
    const baseline = await capture(checkout, 1, "baseline");
    await writeFile(resolve(source, "tracked.txt"), "recoverable\n");
    const recovery = await capture(checkout, 2, "recovery");
    await writeFile(resolve(source, "tracked.txt"), "later manual change\n");

    await expect(
      restoreExecutionCheckpoint({ checkout, target: baseline, recovery })
    ).rejects.toThrow("ExecutionCheckpointRestoreCheckoutChangedError");
    expect(git(source, "diff", "--", "tracked.txt")).toContain(
      "later manual change"
    );
  });

  it("removes only refs that still match their recorded commit", async () => {
    const { source, checkout } = await fixture();
    const checkpoint = await capture(checkout, 1, "baseline");
    await removeExecutionCheckpointRefs({
      checkout,
      checkpoints: [checkpoint]
    });
    expect(() =>
      git(source, "show-ref", "--verify", "--quiet", checkpoint.checkpointRef!)
    ).toThrow();

    const replacement = await capture(checkout, 2, "baseline");
    git(source, "update-ref", replacement.checkpointRef!, "HEAD");
    await expect(
      removeExecutionCheckpointRefs({ checkout, checkpoints: [replacement] })
    ).rejects.toThrow("ExecutionCheckpointRefIdentityChangedError");
  });

  it("does not include hidden Koed refs in an ordinary push", async () => {
    const { root, source, checkout } = await fixture();
    await capture(checkout, 1, "baseline");
    const remote = resolve(root, "remote.git");
    git(root, "init", "--bare", remote);
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "-u", "origin", "main");
    expect(
      git(remote, "for-each-ref", "--format=%(refname)", "refs/koed")
    ).toBe("");
  });
});
