import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { ManagedConversationExecutionCheckpointRecord } from "@koed/db";
import { afterEach, describe, expect, it } from "vitest";

import { captureExecutionCheckpoint } from "./execution-checkpoint.js";
import {
  executeCheckpointFileOperation,
  resolveCheckpointFileMention
} from "./execution-file-authority.js";
import { createGitExecutionWorkspaceDriver } from "@koed/shared/execution-workspace";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const fixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), "koed-file-authority-"));
  roots.push(root);
  await mkdir(resolve(root, "src"));
  await writeFile(
    resolve(root, "src/app.ts"),
    "export const greeting = 'hello';\nexport const needle = 'found';\n"
  );
  await writeFile(resolve(root, "README.md"), "# Example\n");
  await writeFile(resolve(root, "unicode.txt"), "a😀b\n");
  await writeFile(resolve(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(resolve(root, ".env"), "API_KEY=do-not-expose\n");
  await symlink("README.md", resolve(root, "linked-readme"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Koed Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const workspace = await (
    await createGitExecutionWorkspaceDriver({
      managedRoot: resolve(root, ".managed")
    })
  ).select({ operationId: randomUUID(), path: root });
  const ownerUserId = randomUUID();
  const executionId = randomUUID();
  const commandId = randomUUID();
  const capture = await captureExecutionCheckpoint({
    workspace,
    executionId,
    executionGeneration: 1,
    sequence: 0,
    checkpointKind: "baseline"
  });
  const checkpoint: ManagedConversationExecutionCheckpointRecord = {
    id: randomUUID(),
    ownerUserId,
    executionId,
    executionGeneration: 1,
    commandId,
    providerTurnId: null,
    sourceGenerationId: null,
    sequence: 0,
    checkpointKind: "baseline",
    checkpointStatus: capture.status,
    failureCode: null,
    repositoryIdentityHash: capture.repositoryIdentityHash,
    worktreeIdentityHash: capture.worktreeIdentityHash,
    vcsDriver: capture.vcsDriver,
    checkpointRef: capture.checkpointRef,
    commitObjectId: capture.commitObjectId,
    capturedAt: capture.capturedAt,
    createdAt: capture.capturedAt!,
    updatedAt: capture.capturedAt!
  };
  return { root, workspace, checkpoint };
};

describe("execution file authority", () => {
  it("uses the completed workspace revision when a command has multiple checkpoints", async () => {
    const { workspace, checkpoint } = await fixture();
    const terminal = {
      ...checkpoint,
      id: randomUUID(),
      checkpointKind: "terminal" as const
    };
    const result = await executeCheckpointFileOperation({
      workspace,
      checkpoints: [checkpoint, terminal],
      operation: {
        kind: "browse",
        path: "",
        revision: null,
        offset: 0,
        limit: 100
      }
    });
    expect(result.revision.checkpointId).toBe(terminal.id);
  });

  it("browses, reads, searches, and resolves a checkpoint mention", async () => {
    const { workspace, checkpoint } = await fixture();
    const root = await executeCheckpointFileOperation({
      workspace,
      checkpoints: [checkpoint],
      operation: {
        kind: "browse",
        path: "",
        revision: null,
        offset: 0,
        limit: 100
      }
    });
    expect(root.kind).toBe("browse");
    if (root.kind !== "browse") throw new Error("unexpected result");
    expect(root.entries.map((entry) => entry.path)).toEqual([
      ".env",
      "README.md",
      "binary.dat",
      "linked-readme",
      "src",
      "unicode.txt"
    ]);
    const read = await executeCheckpointFileOperation({
      workspace,
      checkpoints: [checkpoint],
      operation: {
        kind: "read",
        path: "src/app.ts",
        revision: root.revision,
        offset: 0,
        limit: 1024
      }
    });
    expect(read).toMatchObject({
      kind: "read",
      path: "src/app.ts",
      content: expect.stringContaining("needle")
    });

    const firstUnicodePage = await executeCheckpointFileOperation({
      workspace,
      checkpoints: [checkpoint],
      operation: {
        kind: "read",
        path: "unicode.txt",
        revision: root.revision,
        offset: 0,
        limit: 3
      }
    });
    expect(firstUnicodePage).toMatchObject({
      kind: "read",
      content: "a",
      nextOffset: 1
    });
    if (
      firstUnicodePage.kind !== "read" ||
      firstUnicodePage.nextOffset === null
    ) {
      throw new Error("unexpected result");
    }
    await expect(
      executeCheckpointFileOperation({
        workspace,
        checkpoints: [checkpoint],
        operation: {
          kind: "read",
          path: "unicode.txt",
          revision: root.revision,
          offset: firstUnicodePage.nextOffset,
          limit: 4
        }
      })
    ).resolves.toMatchObject({ kind: "read", content: "😀" });
    await expect(
      executeCheckpointFileOperation({
        workspace,
        checkpoints: [checkpoint],
        operation: {
          kind: "read",
          path: "unicode.txt",
          revision: root.revision,
          offset: 2,
          limit: 4
        }
      })
    ).rejects.toThrow("ExecutionFileRangeBoundaryError");

    const search = await executeCheckpointFileOperation({
      workspace,
      checkpoints: [checkpoint],
      operation: {
        kind: "search",
        path: "src",
        revision: root.revision,
        query: "NEEDLE",
        caseSensitive: false,
        offset: 0,
        limit: 10
      }
    });
    expect(search).toMatchObject({
      kind: "search",
      totalMatches: 1,
      matches: [{ path: "src/app.ts", line: 2, column: 14 }]
    });

    const mention = await executeCheckpointFileOperation({
      workspace,
      checkpoints: [checkpoint],
      operation: {
        kind: "mention",
        path: "src/app.ts",
        revision: root.revision,
        startLine: 2,
        endLine: 2
      }
    });
    if (mention.kind !== "mention") throw new Error("unexpected result");
    await expect(
      resolveCheckpointFileMention({
        workspace,
        checkpoints: [checkpoint],
        operation: {
          kind: "mention",
          path: "src/app.ts",
          revision: root.revision,
          startLine: 2,
          endLine: 2
        },
        result: mention
      })
    ).resolves.toEqual({
      path: "src/app.ts",
      startLine: 2,
      endLine: 2,
      content: "export const needle = 'found';"
    });
    await expect(
      resolveCheckpointFileMention({
        workspace,
        checkpoints: [checkpoint],
        operation: {
          kind: "mention",
          path: "src/app.ts",
          revision: root.revision,
          startLine: 2,
          endLine: 2
        },
        result: { ...mention, expiresAt: "2000-01-01T00:00:00.000Z" }
      })
    ).rejects.toThrow("ExecutionFileMentionExpiredError");
  });

  it("fails closed for forged revisions, denied files, and binary content", async () => {
    const { workspace, checkpoint } = await fixture();
    const operation = {
      kind: "read" as const,
      path: "README.md",
      revision: {
        checkpointId: checkpoint.id,
        revisionDigest: "f".repeat(64)
      },
      offset: 0,
      limit: 1024
    };
    await expect(
      executeCheckpointFileOperation({
        workspace,
        checkpoints: [checkpoint],
        operation
      })
    ).rejects.toThrow("ExecutionFileStaleRevisionError");
    await expect(
      executeCheckpointFileOperation({
        workspace,
        checkpoints: [checkpoint],
        operation: { ...operation, path: ".env", revision: null }
      })
    ).rejects.toThrow("ExecutionFileContentDeniedError");
    await expect(
      executeCheckpointFileOperation({
        workspace,
        checkpoints: [checkpoint],
        operation: { ...operation, path: "binary.dat", revision: null }
      })
    ).rejects.toThrow("ExecutionFileBinaryError");
  });
});
