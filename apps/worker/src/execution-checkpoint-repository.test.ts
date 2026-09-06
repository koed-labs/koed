import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "@koed/db";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  captureExecutionCheckpoint,
  diffExecutionCheckpoints,
  restoreExecutionCheckpoint,
  type ExecutionCheckpointCapture
} from "./execution-checkpoint.js";
import { createGitExecutionWorkspaceDriver } from "@koed/shared/execution-workspace";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

describeDb("execution checkpoint repository integration", () => {
  let pool: ReturnType<typeof createDbPool>;
  let repository: ReturnType<typeof createMemorySourceRepository>;
  let root: string;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    repository = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 73).toString("base64")
      )
    });
    await runDbMigrations(pool);
    root = await mkdtemp(resolve(tmpdir(), "koed-checkpoint-repository-"));
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    await pool.end();
  });

  it("persists a real Git turn as an encrypted owner-only exact diff", async () => {
    const owner = await repository.createUser({
      email: `checkpoint-owner-${randomUUID()}@example.invalid`
    });
    const stranger = await repository.createUser({
      email: `checkpoint-stranger-${randomUUID()}@example.invalid`
    });
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const runnerId = `checkpoint-runner-${randomUUID()}`;
    const source = resolve(root, "source");
    await mkdir(source);
    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.name", "Koed Test");
    git(source, "config", "user.email", "test@example.invalid");
    await writeFile(resolve(source, "feature.ts"), "export const value = 1;\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "base");
    const workspace = await (
      await createGitExecutionWorkspaceDriver({
        managedRoot: resolve(root, "managed")
      })
    ).select({ operationId: randomUUID(), path: source });

    const managed = await repository.createManagedConversation(
      { userId: owner.id },
      {
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "gpt-test",
        permissionMode: "supervised",
        runnerKind: "local_device",
        projectId: `checkpoint-project-${randomUUID()}`,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        idempotencyKey: randomUUID()
      }
    );
    const [start] = await repository.claimManagedConversationCommands({
      ownerUserId: owner.id,
      runnerId,
      deploymentId,
      deviceId,
      leaseMs: 60_000
    });
    const running = await repository.bindManagedConversationRuntime(
      { userId: owner.id },
      {
        executionId: managed.execution.id,
        expectedStateVersion: start!.execution.stateVersion,
        executionGeneration: 1,
        runnerId,
        logicalSessionId: randomUUID(),
        providerThreadId: randomUUID(),
        providerCliVersion: "integration-test"
      }
    );
    await repository.completeManagedConversationCommand({
      commandId: start!.id,
      leaseToken: start!.leaseToken!,
      result: { started: true }
    });
    const prompt = await repository.enqueueManagedConversationPrompt(
      { userId: owner.id },
      {
        executionId: running.id,
        executionGeneration: running.executionGeneration,
        idempotencyKey: randomUUID(),
        clientUserMessageId: randomUUID(),
        prompt: "Update the feature value."
      }
    );
    const [claimed] = await repository.claimManagedConversationCommands({
      ownerUserId: owner.id,
      runnerId,
      deploymentId,
      deviceId,
      leaseMs: 60_000
    });
    const sourceGenerationId = randomUUID();
    await repository.bindManagedConversationSourceGeneration(
      { userId: owner.id },
      {
        executionId: running.id,
        executionGeneration: 1,
        runnerId,
        sourceGenerationId
      }
    );

    const initial = await captureExecutionCheckpoint({
      workspace,
      executionId: running.id,
      executionGeneration: 1,
      sequence: prompt.sequence,
      checkpointKind: "baseline"
    });
    await writeFile(resolve(source, "feature.ts"), "export const value = 2;\n");
    const terminal = await captureExecutionCheckpoint({
      workspace,
      executionId: running.id,
      executionGeneration: 1,
      sequence: prompt.sequence,
      checkpointKind: "terminal"
    });
    const diff = await diffExecutionCheckpoints({
      workspace,
      from: initial,
      to: terminal
    });
    expect(diff).not.toBeNull();

    const checkpointInput = (input: {
      id: string;
      commandId: string;
      kind: "baseline" | "terminal" | "recovery";
      sequence: number;
      sourceGenerationId: string | null;
      capture: ExecutionCheckpointCapture;
    }) => ({
      id: input.id,
      executionId: running.id,
      executionGeneration: 1,
      commandId: input.commandId,
      providerTurnId: input.kind === "terminal" ? "provider-turn-1" : null,
      sourceGenerationId: input.sourceGenerationId,
      sequence: input.sequence,
      checkpointKind: input.kind,
      checkpointStatus: input.capture.status,
      failureCode: null,
      repositoryIdentityHash: input.capture.repositoryIdentityHash,
      worktreeIdentityHash: input.capture.worktreeIdentityHash,
      vcsDriver: input.capture.vcsDriver,
      checkpointRef: input.capture.checkpointRef,
      commitObjectId: input.capture.commitObjectId,
      capturedAt: input.capture.capturedAt
    });
    const initialId = randomUUID();
    const terminalId = randomUUID();
    await repository.recordManagedConversationExecutionCheckpoint(
      { userId: owner.id },
      {
        checkpoint: checkpointInput({
          id: initialId,
          commandId: claimed!.id,
          kind: "baseline",
          sequence: prompt.sequence,
          sourceGenerationId: null,
          capture: initial
        })
      }
    );
    await repository.markManagedConversationCheckpointPending({
      commandId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      sourceGenerationId,
      providerTurnId: "provider-turn-1"
    });
    await repository.recordManagedConversationExecutionCheckpoint(
      { userId: owner.id },
      {
        checkpoint: checkpointInput({
          id: terminalId,
          commandId: claimed!.id,
          kind: "terminal",
          sequence: prompt.sequence,
          sourceGenerationId,
          capture: terminal
        }),
        diffs: [
          {
            id: randomUUID(),
            scopeKey: `turn:${claimed!.id}`,
            diffScope: "turn",
            fromCheckpointId: initialId,
            toCheckpointId: terminalId,
            revisionDigest: diff!.revisionDigest,
            complete: diff!.complete,
            truncated: diff!.truncated,
            fileCount: diff!.fileCount,
            byteCount: diff!.byteCount,
            payload: JSON.parse(JSON.stringify(diff)) as Record<string, unknown>
          }
        ]
      }
    );
    await repository.completeManagedConversationCommand({
      commandId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      result: { turnId: "provider-turn-1" }
    });

    await expect(
      repository.getManagedConversationExecutionDiff(
        { userId: owner.id },
        {
          executionId: running.id,
          executionGeneration: 1,
          scopeKey: `turn:${claimed!.id}`
        }
      )
    ).resolves.toMatchObject({
      complete: true,
      payload: {
        files: [
          expect.objectContaining({
            path: "feature.ts",
            patch: expect.stringContaining("value = 2")
          })
        ]
      }
    });
    await expect(
      repository.getManagedConversationExecutionDiff(
        { userId: stranger.id },
        {
          executionId: running.id,
          executionGeneration: 1,
          scopeKey: `turn:${claimed!.id}`
        }
      )
    ).resolves.toBeNull();
    const restore =
      await repository.enqueueManagedConversationCheckpointRestore(
        { userId: owner.id },
        {
          executionId: running.id,
          executionGeneration: 1,
          checkpointId: initialId,
          idempotencyKey: randomUUID()
        }
      );
    const [restoreCommand] = await repository.claimManagedConversationCommands({
      ownerUserId: owner.id,
      runnerId,
      deploymentId,
      deviceId,
      leaseMs: 60_000
    });
    expect(restoreCommand?.id).toBe(restore.id);
    const recovery = await captureExecutionCheckpoint({
      workspace,
      executionId: running.id,
      executionGeneration: 1,
      sequence: restore.sequence,
      checkpointKind: "recovery"
    });
    const recoveryId = randomUUID();
    await repository.recordManagedConversationExecutionCheckpoint(
      { userId: owner.id },
      {
        checkpoint: checkpointInput({
          id: recoveryId,
          commandId: restore.id,
          kind: "recovery",
          sequence: restore.sequence,
          sourceGenerationId,
          capture: recovery
        })
      }
    );
    await restoreExecutionCheckpoint({ workspace, target: initial, recovery });
    expect(await readFile(resolve(source, "feature.ts"), "utf8")).toBe(
      "export const value = 1;\n"
    );
    const restored = await captureExecutionCheckpoint({
      workspace,
      executionId: running.id,
      executionGeneration: 1,
      sequence: restore.sequence,
      checkpointKind: "terminal"
    });
    const restoredId = randomUUID();
    const full = (await diffExecutionCheckpoints({
      workspace,
      from: initial,
      to: restored
    }))!;
    const restoreDiff = (await diffExecutionCheckpoints({
      workspace,
      from: recovery,
      to: restored
    }))!;
    await repository.recordManagedConversationExecutionCheckpoint(
      { userId: owner.id },
      {
        checkpoint: checkpointInput({
          id: restoredId,
          commandId: restore.id,
          kind: "terminal",
          sequence: restore.sequence,
          sourceGenerationId,
          capture: restored
        }),
        diffs: [
          {
            scopeKey: "full",
            diffScope: "full" as const,
            fromCheckpointId: initialId,
            value: full
          },
          {
            scopeKey: `turn:${restore.id}`,
            diffScope: "turn" as const,
            fromCheckpointId: recoveryId,
            value: restoreDiff
          }
        ].map(({ value, ...scope }) => ({
          ...scope,
          id: randomUUID(),
          toCheckpointId: restoredId,
          revisionDigest: value.revisionDigest,
          complete: value.complete,
          truncated: value.truncated,
          fileCount: value.fileCount,
          byteCount: value.byteCount,
          payload: JSON.parse(JSON.stringify(value)) as Record<string, unknown>
        }))
      }
    );
    await repository.completeManagedConversationCommand({
      commandId: restore.id,
      leaseToken: restoreCommand!.leaseToken!,
      result: {
        restoredCheckpointId: initialId,
        recoveryCheckpointId: recoveryId
      }
    });
    await expect(
      repository.getManagedConversationExecutionDiff(
        { userId: owner.id },
        {
          executionId: running.id,
          executionGeneration: 1,
          scopeKey: "full"
        }
      )
    ).resolves.toMatchObject({
      toCheckpointId: restoredId,
      fileCount: 0,
      payload: { files: [] }
    });
    await expect(
      repository.getManagedConversationExecutionDiff(
        { userId: owner.id },
        {
          executionId: running.id,
          executionGeneration: 1,
          scopeKey: `turn:${restore.id}`
        }
      )
    ).resolves.toMatchObject({
      fromCheckpointId: recoveryId,
      toCheckpointId: restoredId,
      payload: {
        files: [
          expect.objectContaining({
            path: "feature.ts",
            patch: expect.stringContaining("+export const value = 1")
          })
        ]
      }
    });
    const raw = await pool.query<{ encrypted_payload: string }>(
      `select encrypted_payload::text as encrypted_payload
         from managed_conversation_execution_diffs
        where execution_id = $1`,
      [running.id]
    );
    expect(raw.rows[0]?.encrypted_payload).not.toContain("feature.ts");
    expect(raw.rows[0]?.encrypted_payload).not.toContain("value = 2");
  });
});
