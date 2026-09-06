import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type {
  ManagedConversationExecutionRecord,
  ManagedConversationExecutionCheckpointRecord,
  ManagedConversationRuntimeBindingRecord,
  MemorySourceRepository
} from "@koed/db";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import {
  CodexManagedConversationIdentityError,
  MemoryApiError
} from "@koed/mcp-server";

import {
  ManagedConversationSourceReplicaPendingError,
  assertManagedConversationExecutionOwner,
  createManagedConversationService,
  managedCodexRuntimeEnvironment,
  managedConversationTokenUsageInput,
  managedClaudeRuntimeHome,
  managedConversationFailureCode,
  managedConversationOriginSourceGeneration,
  reconcileBlockedManagedConversationSource,
  shouldPublishManagedConversationSource,
  shouldRequestManagedConversationSourceRestore,
  shouldRecoverForkPreparationFailure
} from "./managed-conversation-service.js";
import { captureExecutionCheckpoint } from "./execution-checkpoint.js";
import {
  createGitExecutionWorkspaceDriver,
  type GitExecutionWorkspaceDriver
} from "@koed/shared/execution-workspace";

describe("Managed Conversation token usage", () => {
  it("records the current provider context and cumulative processed count once per command", () => {
    const executionId = randomUUID();
    const sessionId = randomUUID();
    const commandId = randomUUID();
    expect(
      managedConversationTokenUsageInput({
        provider: "codex",
        executionId,
        executionGeneration: 3,
        sessionId,
        commandId,
        model: "gpt-5.6",
        providerTurnId: "provider-turn-7",
        tokenUsage: {
          last: {
            totalTokens: 42_000,
            inputTokens: 40_000,
            cachedInputTokens: 30_000,
            outputTokens: 2_000,
            reasoningOutputTokens: 500
          },
          total: { totalTokens: 125_000 },
          modelContextWindow: 258_000
        }
      })
    ).toMatchObject({
      workflowType: "managed_conversation",
      workflowId: executionId,
      sessionId,
      sourceRuntime: "codex",
      usageSource: "app_server",
      usageAccuracy: "provider_reported",
      usageKind: "turn_delta",
      model: "gpt-5.6",
      modelContextWindow: 258_000,
      totalTokens: 42_000,
      metadata: {
        provider: "codex",
        executionGeneration: 3,
        providerTurnId: "provider-turn-7",
        totalProcessedTokens: 125_000
      },
      idempotencyKey: `managed-conversation:${executionId}:command:${commandId}:usage`
    });
  });

  it("does not invent usage when a provider reports no bounded counts", () => {
    expect(
      managedConversationTokenUsageInput({
        provider: "claude",
        executionId: randomUUID(),
        executionGeneration: 1,
        sessionId: randomUUID(),
        commandId: randomUUID(),
        model: "claude-sonnet",
        tokenUsage: { last: {} }
      })
    ).toBeNull();
  });
});

describe("Managed Conversation execution owner", () => {
  it.each([
    ["codex", "codex.work"],
    ["claude", "claude.work"],
    ["pi", "pi.work"]
  ])("accepts exact supported owner %s", (provider, instanceId) => {
    expect(() =>
      assertManagedConversationExecutionOwner({
        provider,
        aiClientInstanceId: instanceId
      })
    ).not.toThrow();
  });

  it("fails closed for missing or unsupported owners", () => {
    expect(() =>
      assertManagedConversationExecutionOwner({ provider: "codex" })
    ).toThrow("ManagedConversationProviderUnavailableError");
    expect(() =>
      assertManagedConversationExecutionOwner({
        provider: "unknown",
        aiClientInstanceId: "unknown.default"
      })
    ).toThrow("ManagedConversationUnsupportedAiClientError");
  });
});

describe("Managed Claude runtime home isolation", () => {
  it("uses the persisted transcript home for resume and an exact override for fork", () => {
    const persistedHome = "/managed/claude/persisted";
    const forkHome = "/managed/claude/fork";
    const binding = {
      managedHome: persistedHome,
      transcriptPath: `${persistedHome}/projects/project/session.jsonl`
    };

    expect(managedClaudeRuntimeHome(binding)).toBe(persistedHome);
    expect(managedClaudeRuntimeHome(binding, forkHome)).toBe(forkHome);
  });

  it("requires a bound managed store when there is no exact override", () => {
    expect(
      managedClaudeRuntimeHome({
        managedHome: null,
        transcriptPath: null
      })
    ).toBeUndefined();
  });
});

describe("Managed Codex runtime environment", () => {
  it("uses the selected AI Client instance home and executable", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-codex-instance-"));
    try {
      const configHome = resolve(root, "selected-home");
      const registryPath = resolve(root, "ai-client-instances.json");
      await mkdir(configHome);
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          instances: [
            {
              instanceId: "codex.selected",
              driverId: "codex",
              displayName: "Selected Codex",
              executablePath: process.execPath,
              configHome
            }
          ]
        })
      );

      const environment = managedCodexRuntimeEnvironment({
        execution: {
          provider: "codex",
          aiClientInstanceId: "codex.selected"
        },
        env: {
          CODEX_HOME: resolve(root, "ambient-home"),
          KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
        }
      });

      expect(environment.CODEX_HOME).toBe(await realpath(configHome));
      expect(environment.MEMORY_CODEX_APP_SERVER_BINARY).toBe(
        await realpath(process.execPath)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the normal Codex home for the configured default instance", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-default-codex-"));
    const codexHome = resolve(root, "normal-codex-home");
    const registryPath = resolve(root, "ai-client-instances.json");
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          instances: [
            {
              instanceId: "codex.default",
              driverId: "codex",
              displayName: "Codex",
              executablePath: process.execPath,
              configHome: codexHome
            }
          ]
        })
      );
      const environment = managedCodexRuntimeEnvironment({
        execution: {
          provider: "codex",
          aiClientInstanceId: "codex.default"
        },
        env: {
          CODEX_HOME: codexHome,
          KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
        }
      });

      expect(environment.CODEX_HOME).toBe(codexHome);
      expect(environment.MEMORY_CODEX_APP_SERVER_BINARY).toBe(
        await realpath(process.execPath)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const terminalExecutionFixture = (input: {
  ownerUserId: string;
  executionId: string;
  deploymentId: string;
  deviceId: string;
}): ManagedConversationExecutionRecord => {
  const now = new Date().toISOString();
  return {
    id: input.executionId,
    ownerUserId: input.ownerUserId,
    projectId: "local-project",
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-test",
    reasoningEffort: "low",
    permissionMode: "supervised",
    runnerKind: "local_device",
    state: "stopped",
    stateVersion: 2,
    executionGeneration: 1,
    runnerDeploymentId: input.deploymentId,
    runnerDeviceId: input.deviceId,
    runnerId: null,
    runnerLeaseExpiresAt: null,
    logicalSessionId: null,
    providerThreadId: null,
    providerCliVersion: null,
    sourceGenerationId: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    quiescedAt: null,
    stoppedAt: now
  };
};

const startingExecutionFixture = (input: {
  ownerUserId: string;
  executionId: string;
  deploymentId: string;
  deviceId: string;
}): ManagedConversationExecutionRecord => ({
  ...terminalExecutionFixture(input),
  state: "starting",
  stateVersion: 1,
  startedAt: null,
  stoppedAt: null
});

const pendingBindingFixture = (input: {
  ownerUserId: string;
  executionId: string;
  deploymentId: string;
  deviceId: string;
  sourceProjectPath: string;
}): ManagedConversationRuntimeBindingRecord => {
  const now = new Date().toISOString();
  return {
    executionId: input.executionId,
    ownerUserId: input.ownerUserId,
    deploymentId: input.deploymentId,
    deviceId: input.deviceId,
    executionGeneration: 1,
    sourceProjectPath: input.sourceProjectPath,
    projectPath: input.sourceProjectPath,
    workspaceId: null,
    workspaceKind: "pending",
    workspaceLifecycle: "pending",
    cleanupState: "not_requested",
    vcsDriver: null,
    localRepositoryCommonDirectory: null,
    localGitDirectory: null,
    repositoryIdentityHash: null,
    worktreeIdentityHash: null,
    baseRef: null,
    baseObjectId: null,
    branchRef: null,
    headObjectId: null,
    creationOperationId: null,
    localSessionId: null,
    providerThreadId: null,
    transcriptPath: null,
    managedHome: null,
    providerCliVersion: null,
    sourceGenerationId: null,
    createdAt: now,
    updatedAt: now
  };
};

const cleanupBindingFixture = (input: {
  ownerUserId: string;
  executionId: string;
  deploymentId: string;
  deviceId: string;
  workspaceId: string;
}): ManagedConversationRuntimeBindingRecord => {
  const now = new Date().toISOString();
  return {
    executionId: input.executionId,
    ownerUserId: input.ownerUserId,
    deploymentId: input.deploymentId,
    deviceId: input.deviceId,
    executionGeneration: 1,
    sourceProjectPath: "/source",
    projectPath: "/managed/worktree",
    workspaceId: input.workspaceId,
    workspaceKind: "koed_managed_worktree",
    workspaceLifecycle: "cleanup_requested",
    cleanupState: "requested",
    vcsDriver: "git",
    localRepositoryCommonDirectory: "/source/.git",
    localGitDirectory: "/source/.git/worktrees/test",
    repositoryIdentityHash: "a".repeat(64),
    worktreeIdentityHash: "b".repeat(64),
    baseRef: "HEAD",
    baseObjectId: "c".repeat(40),
    branchRef: `refs/heads/koed/${input.executionId}/1/${input.workspaceId}`,
    headObjectId: "c".repeat(40),
    creationOperationId: input.workspaceId,
    localSessionId: null,
    providerThreadId: null,
    transcriptPath: null,
    managedHome: null,
    providerCliVersion: null,
    sourceGenerationId: null,
    createdAt: now,
    updatedAt: now
  };
};

describe("Managed Conversation service lifecycle", () => {
  it("executes rooted file operations independently from provider commands", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-managed-files-"));
    try {
      await writeFile(resolve(root, "README.md"), "# Rooted file result\n");
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Koed Test"], {
        cwd: root
      });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: root
      });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-m", "base"], { cwd: root });
      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const workspaceDriver = await createGitExecutionWorkspaceDriver({
        managedRoot: resolve(root, ".managed")
      });
      const workspace = await workspaceDriver.select({
        operationId: randomUUID(),
        path: root
      });
      const execution = terminalExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      });
      const now = new Date().toISOString();
      const binding: ManagedConversationRuntimeBindingRecord = {
        executionId,
        ownerUserId,
        deploymentId,
        deviceId,
        executionGeneration: 1,
        sourceProjectPath: workspace.canonicalPath,
        projectPath: workspace.canonicalPath,
        workspaceId: workspace.workspaceId,
        workspaceKind: workspace.ownership,
        workspaceLifecycle: "ready",
        cleanupState: "not_requested",
        vcsDriver: workspace.vcsDriver,
        localRepositoryCommonDirectory:
          workspace.localRepositoryCommonDirectory,
        localGitDirectory: workspace.localGitDirectory,
        repositoryIdentityHash: workspace.repositoryIdentityHash,
        worktreeIdentityHash: workspace.worktreeIdentityHash,
        baseRef: workspace.baseRef,
        baseObjectId: workspace.baseObjectId,
        branchRef: workspace.branchRef,
        headObjectId: workspace.headObjectId,
        creationOperationId: randomUUID(),
        localSessionId: null,
        providerThreadId: null,
        transcriptPath: null,
        managedHome: null,
        providerCliVersion: null,
        sourceGenerationId: null,
        createdAt: now,
        updatedAt: now
      };
      const capture = await captureExecutionCheckpoint({
        workspace,
        executionId,
        executionGeneration: 1,
        sequence: 0,
        checkpointKind: "baseline"
      });
      const checkpointCommandId = randomUUID();
      const checkpoint: ManagedConversationExecutionCheckpointRecord = {
        id: randomUUID(),
        ownerUserId,
        executionId,
        executionGeneration: 1,
        commandId: checkpointCommandId,
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
      const command = {
        id: randomUUID(),
        ownerUserId,
        executionId,
        executionGeneration: 1,
        commandKind: "file_read",
        attempts: 1,
        leaseToken: randomUUID(),
        payload: {
          operation: {
            kind: "read",
            path: "README.md",
            revision: null,
            offset: 0,
            limit: 1024
          }
        },
        execution
      };
      const complete = vi.fn(async () => true);
      const repository = {
        claimManagedConversationFileOperations: vi.fn(async () => [command]),
        getManagedConversationRuntimeBinding: vi.fn(async () => binding),
        listManagedConversationExecutionCheckpoints: vi.fn(async () => [
          checkpoint
        ]),
        renewManagedConversationCommandLease: vi.fn(async () => true),
        completeManagedConversationFileOperation: complete,
        failManagedConversationFileOperation: vi.fn(async () => true)
      } as unknown as MemorySourceRepository;
      const service = createManagedConversationService({
        repository,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: ownerUserId,
        appServerBinary: "codex",
        deviceId,
        deploymentId,
        koedHome: resolve(root, "koed-home"),
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        executionWorkspaceDriver: workspaceDriver,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        } as never
      });

      await expect(service.processFileOperationsOnce()).resolves.toBe(1);
      expect(complete).toHaveBeenCalledWith({
        commandId: command.id,
        leaseToken: command.leaseToken,
        result: expect.objectContaining({
          kind: "read",
          path: "README.md",
          content: "# Rooted file result\n"
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles Restore after files changed but command completion failed", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-checkpoint-restore-"));
    try {
      const projectPath = resolve(root, "project");
      await mkdir(projectPath);
      await writeFile(resolve(projectPath, "tracked.txt"), "baseline\n");
      execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: projectPath
      });
      execFileSync("git", ["config", "user.name", "Koed Test"], {
        cwd: projectPath
      });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: projectPath
      });
      execFileSync("git", ["add", "."], { cwd: projectPath });
      execFileSync("git", ["commit", "-m", "base"], { cwd: projectPath });

      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const workspaceDriver = await createGitExecutionWorkspaceDriver({
        managedRoot: resolve(root, ".managed")
      });
      const workspace = await workspaceDriver.select({
        operationId: randomUUID(),
        path: projectPath
      });
      const execution: ManagedConversationExecutionRecord = {
        ...terminalExecutionFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId
        }),
        state: "running",
        stoppedAt: null
      };
      const now = new Date().toISOString();
      const binding: ManagedConversationRuntimeBindingRecord = {
        executionId,
        ownerUserId,
        deploymentId,
        deviceId,
        executionGeneration: 1,
        sourceProjectPath: workspace.canonicalPath,
        projectPath: workspace.canonicalPath,
        workspaceId: workspace.workspaceId,
        workspaceKind: workspace.ownership,
        workspaceLifecycle: "ready",
        cleanupState: "not_requested",
        vcsDriver: workspace.vcsDriver,
        localRepositoryCommonDirectory:
          workspace.localRepositoryCommonDirectory,
        localGitDirectory: workspace.localGitDirectory,
        repositoryIdentityHash: workspace.repositoryIdentityHash,
        worktreeIdentityHash: workspace.worktreeIdentityHash,
        baseRef: workspace.baseRef,
        baseObjectId: workspace.baseObjectId,
        branchRef: workspace.branchRef,
        headObjectId: workspace.headObjectId,
        creationOperationId: randomUUID(),
        localSessionId: null,
        providerThreadId: null,
        transcriptPath: null,
        managedHome: null,
        providerCliVersion: null,
        sourceGenerationId: null,
        createdAt: now,
        updatedAt: now
      };
      const targetCapture = await captureExecutionCheckpoint({
        workspace,
        executionId,
        executionGeneration: 1,
        sequence: 1,
        checkpointKind: "baseline"
      });
      expect(targetCapture.status).toBe("ready");
      const target: ManagedConversationExecutionCheckpointRecord = {
        id: randomUUID(),
        ownerUserId,
        executionId,
        executionGeneration: 1,
        commandId: randomUUID(),
        providerTurnId: null,
        sourceGenerationId: null,
        sequence: 1,
        checkpointKind: "baseline",
        checkpointStatus: "ready",
        failureCode: null,
        repositoryIdentityHash: targetCapture.repositoryIdentityHash,
        worktreeIdentityHash: targetCapture.worktreeIdentityHash,
        vcsDriver: targetCapture.vcsDriver,
        checkpointRef: targetCapture.checkpointRef,
        commitObjectId: targetCapture.commitObjectId,
        capturedAt: targetCapture.capturedAt,
        createdAt: targetCapture.capturedAt!,
        updatedAt: targetCapture.capturedAt!
      };
      await writeFile(resolve(projectPath, "tracked.txt"), "changed\n");

      const commandId = randomUUID();
      const command = {
        id: commandId,
        ownerUserId,
        executionId,
        executionGeneration: 1,
        commandKind: "checkpoint_restore" as const,
        sequence: 2,
        attempts: 1,
        leaseToken: randomUUID(),
        payload: { checkpointId: target.id },
        execution
      };
      const persisted: ManagedConversationExecutionCheckpointRecord[] = [];
      const recordCheckpoint = vi.fn(async (_actor, input) => {
        const checkpoint: ManagedConversationExecutionCheckpointRecord = {
          ...input.checkpoint,
          ownerUserId,
          createdAt: now,
          updatedAt: now
        };
        persisted.push(checkpoint);
        return checkpoint;
      });
      const complete = vi
        .fn()
        .mockRejectedValueOnce(new Error("DatabaseTemporarilyUnavailableError"))
        .mockResolvedValue(true);
      const fail = vi.fn(async () => ({
        updated: true,
        reconciled: false,
        requeued: false
      }));
      const repository = {
        listManagedConversationExecutionsForRunner: vi.fn(async () => []),
        listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
          async () => []
        ),
        listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
        reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
        claimManagedConversationCommands: vi.fn(async () => [command]),
        getManagedConversationRuntimeBinding: vi.fn(async () => binding),
        listManagedConversationExecutionCheckpoints: vi.fn(async () => [
          target,
          ...persisted.filter(
            (checkpoint) => checkpoint.checkpointStatus === "ready"
          )
        ]),
        recordManagedConversationExecutionCheckpoint: recordCheckpoint,
        renewManagedConversationCommandLease: vi.fn(async () => true),
        completeManagedConversationCommand: complete,
        failManagedConversationCommand: fail
      } as unknown as MemorySourceRepository;
      const service = createManagedConversationService({
        repository,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: ownerUserId,
        appServerBinary: "codex",
        deviceId,
        deploymentId,
        koedHome: resolve(root, "koed-home"),
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        executionWorkspaceDriver: workspaceDriver,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        } as never
      });

      await expect(service.processOnce()).resolves.toEqual({
        completed: 0,
        failed: 1
      });
      expect(await readFile(resolve(projectPath, "tracked.txt"), "utf8")).toBe(
        "baseline\n"
      );
      expect(fail).toHaveBeenCalledWith(
        expect.objectContaining({ commandId, state: "queued" })
      );

      await expect(service.processOnce()).resolves.toEqual({
        completed: 1,
        failed: 0
      });
      expect(persisted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            commandId,
            checkpointKind: "recovery",
            checkpointStatus: "pending"
          }),
          expect.objectContaining({
            commandId,
            checkpointKind: "recovery",
            checkpointStatus: "ready",
            commitObjectId: expect.stringMatching(/^[0-9a-f]{40}$/)
          })
        ])
      );
      expect(complete).toHaveBeenLastCalledWith({
        commandId,
        leaseToken: command.leaseToken,
        result: expect.objectContaining({
          restoredCheckpointId: target.id,
          recoveryCheckpointId: expect.any(String),
          reconciled: true
        })
      });
      expect(recordCheckpoint).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          checkpoint: expect.objectContaining({
            checkpointKind: "terminal",
            checkpointStatus: "ready"
          }),
          diffs: expect.arrayContaining([
            expect.objectContaining({ diffScope: "full", fileCount: 0 })
          ])
        })
      );
      expect(
        persisted.filter(
          (checkpoint) =>
            checkpoint.checkpointKind === "recovery" &&
            checkpoint.checkpointStatus === "ready"
        )
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not block command processing on unrelated startup recovery", async () => {
    let finishRecovery!: (value: []) => void;
    const recovery = new Promise<[]>((resolve) => {
      finishRecovery = resolve;
    });
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(() => recovery),
      listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [])
    } as unknown as MemorySourceRepository;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: randomUUID(),
      appServerBinary: "codex",
      deviceId: randomUUID(),
      deploymentId: randomUUID(),
      koedHome: "/tmp/koed-managed-conversation-lifecycle-test",
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    });

    await expect(service.processOnce()).resolves.toEqual({
      completed: 0,
      failed: 0
    });
    await vi.waitFor(() =>
      expect(
        repository.listManagedConversationExecutionsForRunner
      ).toHaveBeenCalledOnce()
    );
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishRecovery([]);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("retries a transiently deferred runtime recovery", async () => {
    vi.useFakeTimers();
    try {
      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const execution: ManagedConversationExecutionRecord = {
        ...startingExecutionFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId
        }),
        state: "running",
        logicalSessionId: randomUUID(),
        providerThreadId: randomUUID()
      };
      const listExecutions = vi.fn(async () => [execution]);
      const repository = {
        listManagedConversationExecutionsForRunner: listExecutions,
        getManagedConversationRuntimeBinding: vi.fn(async () => {
          throw new Error("transient local runtime state");
        }),
        listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
          async () => []
        ),
        listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
        reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
        claimManagedConversationCommands: vi.fn(async () => [])
      } as unknown as MemorySourceRepository;
      const service = createManagedConversationService({
        repository,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: ownerUserId,
        appServerBinary: "codex",
        deviceId,
        deploymentId,
        koedHome: "/tmp/koed-managed-conversation-recovery-test",
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        } as never
      });

      await service.processOnce();
      await vi.waitFor(() => expect(listExecutions).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(listExecutions).toHaveBeenCalledTimes(2));
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a start against the selected dirty checkout without creating a worktree", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-workspace-prepare-"));
    try {
      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const sourceProjectPath = resolve(root, "project");
      await mkdir(sourceProjectPath);
      await writeFile(resolve(sourceProjectPath, "tracked.txt"), "initial\n");
      execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: sourceProjectPath
      });
      execFileSync("git", ["config", "user.name", "Koed Test"], {
        cwd: sourceProjectPath
      });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: sourceProjectPath
      });
      execFileSync("git", ["add", "tracked.txt"], { cwd: sourceProjectPath });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: sourceProjectPath
      });
      await writeFile(resolve(sourceProjectPath, "tracked.txt"), "dirty\n");
      const execution = startingExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      });
      const binding = pendingBindingFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId,
        sourceProjectPath
      });
      const bindWorkspace = vi.fn(async (_actor, input) => ({
        ...binding,
        ...input,
        workspaceLifecycle: "ready" as const,
        cleanupState: "not_requested" as const,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt
      }));
      const releaseStart = vi.fn(async () => true);
      const repository = {
        listManagedConversationExecutionsForRunner: vi.fn(async () => []),
        listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
          async () => []
        ),
        listPendingManagedConversationRuntimeBindings: vi.fn(async () => [
          binding
        ]),
        getManagedConversationExecution: vi.fn(async () => execution),
        bindManagedConversationExecutionWorkspace: bindWorkspace,
        releaseManagedConversationStartForRuntimeBinding: releaseStart,
        reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
        claimManagedConversationCommands: vi.fn(async () => [])
      } as unknown as MemorySourceRepository;
      const service = createManagedConversationService({
        repository,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: ownerUserId,
        appServerBinary: "codex",
        deviceId,
        deploymentId,
        koedHome: resolve(root, "koed-home"),
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        } as never
      });

      await expect(service.processOnce()).resolves.toEqual({
        completed: 0,
        failed: 0
      });
      const canonicalProjectPath = await realpath(sourceProjectPath);
      expect(bindWorkspace).toHaveBeenCalledWith(
        { userId: ownerUserId },
        expect.objectContaining({
          executionId,
          sourceProjectPath,
          projectPath: canonicalProjectPath,
          workspaceKind: "user_managed_checkout",
          vcsDriver: "git"
        })
      );
      expect(releaseStart).toHaveBeenCalledWith({
        ownerUserId,
        executionId,
        executionGeneration: 1,
        deploymentId,
        deviceId
      });
      expect(bindWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        releaseStart.mock.invocationCallOrder[0]!
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably fails a blocked start when its selected checkout is invalid", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const execution = startingExecutionFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId
    });
    const binding = pendingBindingFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId,
      sourceProjectPath: "/missing/source"
    });
    const failStart = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => [
        binding
      ]),
      getManagedConversationExecution: vi.fn(async () => execution),
      failManagedConversationStartForRuntimeBinding: failStart,
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [])
    } as unknown as MemorySourceRepository;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: "codex",
      deviceId,
      deploymentId,
      koedHome: "/unused",
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionWorkspaceDriver: {
        select: vi.fn(async () => {
          throw new Error("ExecutionWorkspaceDirectoryError");
        })
      } as unknown as GitExecutionWorkspaceDriver,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    });

    await service.processOnce();

    expect(failStart).toHaveBeenCalledWith({
      ownerUserId,
      executionId,
      executionGeneration: 1,
      deploymentId,
      deviceId,
      errorCode: "ExecutionWorkspaceDirectoryError"
    });
  });

  it("retries transient workspace preparation without failing the execution", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-workspace-retry-"));
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const sourceProjectPath = resolve(root, "project");
    await mkdir(sourceProjectPath);
    const execution = startingExecutionFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId
    });
    const binding = pendingBindingFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId,
      sourceProjectPath
    });
    const select = vi
      .fn()
      .mockRejectedValueOnce(new Error("ExecutionWorkspaceGitCommandError"))
      .mockResolvedValue({
        workspaceId: randomUUID(),
        vcsDriver: null,
        ownership: "non_vcs_directory" as const,
        canonicalPath: sourceProjectPath,
        localRepositoryCommonDirectory: null,
        localGitDirectory: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        baseRef: null,
        baseObjectId: null,
        branchRef: null,
        headObjectId: null
      });
    const bindWorkspace = vi.fn(async (_actor, input) => ({
      ...binding,
      ...input,
      workspaceLifecycle: "ready" as const,
      cleanupState: "not_requested" as const,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt
    }));
    const releaseStart = vi.fn(async () => true);
    const failStart = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => [
        binding
      ]),
      getManagedConversationExecution: vi.fn(async () => execution),
      bindManagedConversationExecutionWorkspace: bindWorkspace,
      releaseManagedConversationStartForRuntimeBinding: releaseStart,
      failManagedConversationStartForRuntimeBinding: failStart,
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [])
    } as unknown as MemorySourceRepository;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: "codex",
      deviceId,
      deploymentId,
      koedHome: resolve(root, "koed-home"),
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionWorkspaceDriver: {
        select
      } as unknown as GitExecutionWorkspaceDriver,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    });

    try {
      await service.processOnce();
      await vi.waitFor(() => expect(releaseStart).toHaveBeenCalledOnce(), {
        timeout: 2_000
      });
      expect(select).toHaveBeenCalledTimes(2);
      expect(bindWorkspace).toHaveBeenCalledOnce();
      expect(failStart).not.toHaveBeenCalled();
    } finally {
      await service.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes an explicitly requested clean workspace only after execution is terminal", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const workspaceId = randomUUID();
    const execution = terminalExecutionFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId
    });
    const binding = cleanupBindingFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId,
      workspaceId
    });
    const remove = vi.fn(async () => undefined);
    const completeCleanup = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
        async () => [binding]
      ),
      listManagedConversationExecutionCheckpoints: vi.fn(async () => []),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      getManagedConversationExecution: vi.fn(async () => execution),
      completeManagedConversationExecutionWorkspaceCleanup: completeCleanup,
      failManagedConversationExecutionWorkspaceCleanup: vi.fn(async () => true),
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [])
    } as unknown as MemorySourceRepository;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: "codex",
      deviceId,
      deploymentId,
      koedHome: "/unused",
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionWorkspaceDriver: {
        remove
      } as unknown as GitExecutionWorkspaceDriver,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    });

    await service.processOnce();

    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        canonicalPath: binding.projectPath
      })
    );
    expect(completeCleanup).toHaveBeenCalledWith({
      ownerUserId,
      executionId,
      executionGeneration: 1,
      deploymentId,
      deviceId,
      workspaceId
    });
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      completeCleanup.mock.invocationCallOrder[0]!
    );
  });

  it("records a refused dirty cleanup without deleting or retrying the workspace", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const workspaceId = randomUUID();
    const execution = terminalExecutionFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId
    });
    const binding = cleanupBindingFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId,
      workspaceId
    });
    const failCleanup = vi.fn(async () => true);
    const completeCleanup = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
        async () => [binding]
      ),
      listManagedConversationExecutionCheckpoints: vi.fn(async () => []),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      getManagedConversationExecution: vi.fn(async () => execution),
      completeManagedConversationExecutionWorkspaceCleanup: completeCleanup,
      failManagedConversationExecutionWorkspaceCleanup: failCleanup,
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [])
    } as unknown as MemorySourceRepository;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: "codex",
      deviceId,
      deploymentId,
      koedHome: "/unused",
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionWorkspaceDriver: {
        remove: vi.fn(async () => {
          throw new Error("ExecutionWorkspaceCleanupDirtyError");
        })
      } as unknown as GitExecutionWorkspaceDriver,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    });

    await service.processOnce();

    expect(completeCleanup).not.toHaveBeenCalled();
    expect(failCleanup).toHaveBeenCalledWith({
      ownerUserId,
      executionId,
      executionGeneration: 1,
      deploymentId,
      deviceId,
      workspaceId,
      lifecycle: "cleanup_failed"
    });
  });

  it("replays idempotent removal when cleanup persistence is temporarily unavailable", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const workspaceId = randomUUID();
    const execution = terminalExecutionFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId
    });
    const binding = cleanupBindingFixture({
      ownerUserId,
      executionId,
      deploymentId,
      deviceId,
      workspaceId
    });
    const remove = vi.fn(async () => undefined);
    const completeCleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("DatabaseTemporarilyUnavailableError"))
      .mockResolvedValue(true);
    const failCleanup = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionWorkspaceCleanupRequests: vi.fn(
        async () => [binding]
      ),
      listManagedConversationExecutionCheckpoints: vi.fn(async () => []),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      getManagedConversationExecution: vi.fn(async () => execution),
      completeManagedConversationExecutionWorkspaceCleanup: completeCleanup,
      failManagedConversationExecutionWorkspaceCleanup: failCleanup,
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [])
    } as unknown as MemorySourceRepository;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: "codex",
      deviceId,
      deploymentId,
      koedHome: "/unused",
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionWorkspaceDriver: {
        remove
      } as unknown as GitExecutionWorkspaceDriver,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    });

    try {
      await service.processOnce();
      await vi.waitFor(() => expect(completeCleanup).toHaveBeenCalledTimes(2), {
        timeout: 2_000
      });
      expect(remove).toHaveBeenCalledTimes(2);
      expect(failCleanup).not.toHaveBeenCalled();
    } finally {
      await service.stop();
    }
  });
});

describe("Managed Conversation source identity", () => {
  const sessionId = randomUUID();
  const providerThreadId = randomUUID();
  const sourceGenerationId = randomUUID();

  it("accepts the exact origin artifact registered for the managed thread", () => {
    expect(
      managedConversationOriginSourceGeneration(
        {
          sourceKind: "codex",
          externalSessionId: providerThreadId,
          replicaRole: "origin_local",
          sessionId,
          sourceGenerationId
        },
        { sessionId, providerThreadId, sourceKind: "codex" }
      )
    ).toBe(sourceGenerationId);
  });

  it.each([
    ["session", { sessionId: randomUUID() }],
    ["thread", { externalSessionId: randomUUID() }],
    ["replica role", { replicaRole: "hosted_personal" }],
    ["source kind", { sourceKind: "claude" }],
    ["generation", { sourceGenerationId: "not-a-uuid" }]
  ])("rejects a mismatched %s identity", (_label, mismatch) => {
    expect(() =>
      managedConversationOriginSourceGeneration(
        {
          sourceKind: "codex",
          externalSessionId: providerThreadId,
          replicaRole: "origin_local",
          sessionId,
          sourceGenerationId,
          ...mismatch
        },
        { sessionId, providerThreadId, sourceKind: "codex" }
      )
    ).toThrowError(
      expect.objectContaining({
        name: "ManagedConversationSourceIdentityError"
      })
    );
  });
});

describe("Managed Conversation failure codes", () => {
  it("preserves bounded semantic error messages from local guards", () => {
    expect(
      managedConversationFailureCode(
        new Error("ManagedConversationPrimarySourceError")
      )
    ).toBe("ManagedConversationPrimarySourceError");
  });

  it("does not expose arbitrary exception names or messages", () => {
    expect(
      managedConversationFailureCode(new Error("database password leaked"))
    ).toBe("ManagedConversationFailure");
    expect(
      managedConversationFailureCode(
        Object.assign(new Error("detail"), { name: "TypeError" })
      )
    ).toBe("ManagedConversationFailure");
  });

  it("preserves bounded domain failures through safe wrappers", () => {
    expect(
      managedConversationFailureCode(
        new Error("outer detail", {
          cause: new Error("ManagedConversationSourceReplicaError")
        })
      )
    ).toBe("ManagedConversationSourceReplicaError");
    expect(
      managedConversationFailureCode(
        new MemoryApiError("request failed", {
          payload: { error: "ManagedConversationSourceReleaseError" }
        })
      )
    ).toBe("ManagedConversationSourceReleaseError");
  });

  it("normalizes Codex runtime failures without exposing their details", () => {
    expect(
      managedConversationFailureCode(
        new CodexManagedConversationIdentityError([])
      )
    ).toBe("ManagedConversationSourceIdentityError");
    expect(
      managedConversationFailureCode(
        Object.assign(new Error("private capacity detail"), {
          name: "CodexManagedConversationCapacityError"
        })
      )
    ).toBe("ManagedConversationCapacityError");
  });

  it("preserves source-replica pending as a durable blocking condition", () => {
    const error = new ManagedConversationSourceReplicaPendingError(
      randomUUID()
    );
    expect(managedConversationFailureCode(error)).toBe(
      "ManagedConversationSourceReplicaPendingError"
    );
    expect(shouldRecoverForkPreparationFailure(error)).toBe(false);
    expect(
      shouldRecoverForkPreparationFailure(new Error("provider failed"))
    ).toBe(true);
    expect(shouldRequestManagedConversationSourceRestore(error)).toBe(false);
    expect(
      shouldRequestManagedConversationSourceRestore(
        new ManagedConversationSourceReplicaPendingError(
          randomUUID(),
          "local",
          "restore"
        )
      )
    ).toBe(true);
    expect(shouldPublishManagedConversationSource(error)).toBe(false);
    expect(
      shouldPublishManagedConversationSource(
        new ManagedConversationSourceReplicaPendingError(
          randomUUID(),
          "authority",
          "publish",
          "registered"
        )
      )
    ).toBe(true);
    expect(
      new ManagedConversationSourceReplicaPendingError(
        randomUUID(),
        "authority",
        "publish",
        "registered"
      ).readiness
    ).toBe("registered");
  });

  it("releases a source-blocked command when readiness won the wake race", async () => {
    const sourceGenerationId = randomUUID();
    const release = vi.fn(async () => undefined);
    const reconciled = await reconcileBlockedManagedConversationSource({
      blocked: true,
      sourceGenerationId,
      isReady: async (candidate) => candidate === sourceGenerationId,
      release
    });

    expect(reconciled).toBe(true);
    expect(release).toHaveBeenCalledWith(sourceGenerationId);
  });

  it("leaves a source-blocked command dormant until exact readiness", async () => {
    const release = vi.fn(async () => undefined);
    const reconciled = await reconcileBlockedManagedConversationSource({
      blocked: true,
      sourceGenerationId: randomUUID(),
      isReady: async () => false,
      release
    });

    expect(reconciled).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });
});
