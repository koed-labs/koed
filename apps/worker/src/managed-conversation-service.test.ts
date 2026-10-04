import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type {
  ManagedConversationExecutionRecord,
  ManagedConversationExecutionCheckpointRecord,
  ManagedConversationProjectMoveRecord,
  ManagedConversationRuntimeBindingRecord,
  MemorySourceRepository
} from "@koed/db";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import {
  CodexManagedConversationSession,
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
  managedConversationProviderHistoryAvailable,
  managedConversationCodexHistoryProof,
  managedConversationRebasedPrefixMatches,
  managedPersonalAgentTurnDeclaredComplete,
  managedPersonalAgentSignalThreadMatchesCurrentCommand,
  managedConversationOriginSourceGeneration,
  managedConversationAssistantOutputForTurn,
  codexAssistantFinalTextForTurn,
  reconcileBlockedManagedConversationSource,
  shouldPublishManagedConversationSource,
  shouldRequestManagedConversationSourceRestore,
  shouldRecoverForkPreparationFailure,
  gitWorkingTreeEditState,
  diffExecutionCheckpointsForCheckout,
  createManagedConversationRuntimeSessionSingleflight,
  startManagedConversationRuntimeSession
} from "./managed-conversation-service.js";
import { ManagedConversationRuntimeRegistry } from "./managed-conversation-provider-runtime.js";
import { captureExecutionCheckpoint } from "./execution-checkpoint.js";
import {
  createGitExecutionCheckoutDriver,
  type GitExecutionCheckoutDriver
} from "@koed/shared/execution-checkout";
import { ProjectMoveLocalJournal } from "./project-move-local-journal.js";

describe("managed Conversation provider history recovery", () => {
  it("checks the durable accepted prefix even when a rebased child has no segments", () => {
    const parentArtifactId = randomUUID();
    const parentSourceGenerationId = randomUUID();
    const acceptedBytes = Buffer.from("old row\n");
    const artifact = {
      journalStartOffset: acceptedBytes.byteLength,
      journalStartLine: 1
    };
    const rebaseProof = {
      parentArtifactId,
      parentSourceGenerationId,
      acceptedFrontier: {
        offset: acceptedBytes.byteLength,
        line: 1,
        fileSize: acceptedBytes.byteLength,
        prefixSha256: createHash("sha256").update(acceptedBytes).digest("hex"),
        modifiedAt: new Date().toISOString()
      }
    };

    expect(
      managedConversationRebasedPrefixMatches(
        artifact,
        rebaseProof,
        Buffer.concat([acceptedBytes, Buffer.from("new row\n")])
      )
    ).toBe(true);
    const rewritten = Buffer.from(acceptedBytes);
    rewritten[0] = 0x4e;
    expect(
      managedConversationRebasedPrefixMatches(artifact, rebaseProof, rewritten)
    ).toBe(false);
    expect(
      managedConversationRebasedPrefixMatches(
        artifact,
        rebaseProof,
        Buffer.from("short\n")
      )
    ).toBe(false);
  });

  it("proves only complete same-thread terminal Codex history with stable user identities", () => {
    const target = randomUUID();
    const userId = randomUUID();
    const turnId = randomUUID();
    const proof = managedConversationCodexHistoryProof(
      {
        id: randomUUID(),
        status: { type: "notLoaded" },
        turns: [
          {
            id: turnId,
            status: "completed",
            items: [
              {
                id: randomUUID(),
                type: "userMessage",
                clientId: `koed-user-message:${userId}`,
                content: [{ type: "text", text: "Prior prompt" }]
              },
              {
                id: randomUUID(),
                type: "agentMessage",
                text: "Prior answer"
              }
            ]
          }
        ]
      },
      target
    );

    expect(proof).toMatchObject({
      turnCount: 1,
      messageCount: 2,
      terminal: true,
      targetPromptAbsent: true
    });
    expect(proof.providerHistorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.canonicalHistorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.messages.map((message) => message.kind).sort()).toEqual([
      "assistant",
      "user"
    ]);
  });

  it.each([
    [
      "target message present",
      (target: string, user: string, turn: string) => ({
        id: randomUUID(),
        status: { type: "notLoaded" },
        turns: [
          {
            id: turn,
            status: "completed",
            items: [
              {
                type: "userMessage",
                clientId: `koed-user-message:${target}`,
                content: [{ text: "old" }]
              }
            ]
          }
        ]
      })
    ],
    [
      "active turn",
      (_target: string, user: string, turn: string) => ({
        id: randomUUID(),
        status: { type: "notLoaded" },
        turns: [
          {
            id: turn,
            status: "inProgress",
            items: [
              {
                type: "userMessage",
                clientId: `koed-user-message:${user}`,
                content: [{ text: "old" }]
              }
            ]
          }
        ]
      })
    ],
    [
      "missing user identity",
      (_target: string, _user: string, turn: string) => ({
        id: randomUUID(),
        status: { type: "notLoaded" },
        turns: [
          {
            id: turn,
            status: "completed",
            items: [{ type: "userMessage", content: [{ text: "old" }] }]
          }
        ]
      })
    ]
  ])("rejects unprovable Codex history (%s)", (_name, build) => {
    const target = randomUUID();
    const user = randomUUID();
    const turn = randomUUID();
    expect(() =>
      managedConversationCodexHistoryProof(build(target, user, turn), target)
    ).toThrow("ManagedConversationSourceRebaseProofError");
  });

  it("requires an existing transcript for a running provider session", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-provider-history-"));
    try {
      const transcriptPath = resolve(root, "missing-transcript.jsonl");
      const execution = {
        state: "running",
        providerThreadId: "provider-thread-id"
      } as Pick<
        ManagedConversationExecutionRecord,
        "state" | "providerThreadId"
      >;
      const binding = {
        localSessionId: "local-session-id",
        providerThreadId: "provider-thread-id",
        transcriptPath,
        managedHome: root
      } as Pick<
        ManagedConversationRuntimeBindingRecord,
        "localSessionId" | "providerThreadId" | "transcriptPath" | "managedHome"
      >;

      expect(
        managedConversationProviderHistoryAvailable(execution, binding)
      ).toBe(false);
      await writeFile(transcriptPath, "provider history\n");
      expect(
        managedConversationProviderHistoryAvailable(execution, binding)
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not require provider history before the initial start is bound", () => {
    expect(
      managedConversationProviderHistoryAvailable(
        { state: "starting", providerThreadId: null },
        {
          localSessionId: null,
          providerThreadId: null,
          transcriptPath: null,
          managedHome: null
        }
      )
    ).toBe(true);
  });
});

describe("managed Personal Agent turn status recovery", () => {
  it("uses a persisted completion only for the successful provider turn it names", () => {
    const payload = {
      personalAgentTurnStatus: "complete",
      personalAgentTurnStatusProviderTurnId: "codex-turn-2"
    };
    expect(
      managedPersonalAgentTurnDeclaredComplete(
        payload,
        undefined,
        "codex-turn-2"
      )
    ).toBe(true);
    expect(
      managedPersonalAgentTurnDeclaredComplete(
        payload,
        undefined,
        "codex-turn-3"
      )
    ).toBe(false);
    expect(
      managedPersonalAgentTurnDeclaredComplete(
        { ...payload, personalAgentTurnStatus: "awaiting_owner" },
        undefined,
        "codex-turn-2"
      )
    ).toBe(false);
    expect(
      managedPersonalAgentTurnDeclaredComplete(payload, "complete", undefined)
    ).toBe(true);
  });

  it("fences provider signals against the claimed command, not a stale session snapshot", () => {
    const capturedAtSessionStart = { providerThreadId: null };
    const activeCommand = {
      execution: { providerThreadId: "current-thread" }
    } as never;
    expect(capturedAtSessionStart.providerThreadId).toBeNull();
    expect(
      managedPersonalAgentSignalThreadMatchesCurrentCommand(
        activeCommand,
        "current-thread"
      )
    ).toBe(true);
    expect(
      managedPersonalAgentSignalThreadMatchesCurrentCommand(
        activeCommand,
        "stale-thread"
      )
    ).toBe(false);
  });
});

describe("Managed Conversation runtime session singleflight", () => {
  it("shares a gated Pi start between recovery and command lookup", async () => {
    const registry = new ManagedConversationRuntimeRegistry();
    const getOrCreate =
      createManagedConversationRuntimeSessionSingleflight(registry);
    const executionId = randomUUID();
    const identity = {
      executionGeneration: 7,
      aiClientInstanceId: "local-client",
      configIdentityHash: "config-hash",
      settingsKey: "settings-key"
    };
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const start = vi.fn(async () => await startGate);
    const session = {
      closeAndWait: vi.fn(async () => undefined),
      start
    };
    const create = vi.fn(async () => {
      await session.start();
      return session as never;
    });

    const recoveryLookup = getOrCreate({
      provider: "pi",
      executionId,
      identity,
      create
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const promptLookup = getOrCreate({
      provider: "pi",
      executionId,
      identity,
      create
    });
    releaseStart();
    const [recovery, prompt] = await Promise.all([
      recoveryLookup,
      promptLookup
    ]);

    expect(recovery.session).toBe(prompt.session);
    expect(recovery.created).toBe(true);
    expect(prompt.created).toBe(false);
    expect(create).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(registry.get("pi", executionId, identity)?.session).toBe(
      recovery.session
    );
  });

  it("closes a late session instead of publishing it after shutdown", async () => {
    const registry = new ManagedConversationRuntimeRegistry();
    let serviceActive = true;
    const getOrCreate = createManagedConversationRuntimeSessionSingleflight(
      registry,
      () => serviceActive
    );
    const executionId = randomUUID();
    const identity = {
      executionGeneration: 1,
      aiClientInstanceId: "local-client",
      configIdentityHash: "config-hash",
      settingsKey: "settings-key"
    };
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const session = { closeAndWait: vi.fn(async () => undefined) };
    const create = vi.fn(async () => {
      await creationGate;
      return session as never;
    });
    const initializing = getOrCreate({
      provider: "codex",
      executionId,
      identity,
      create
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    serviceActive = false;
    releaseCreation();

    await expect(initializing).rejects.toMatchObject({
      name: "ManagedConversationRuntimeInitializationInvalidatedError"
    });
    expect(session.closeAndWait).toHaveBeenCalledOnce();
    expect(registry.has(executionId)).toBe(false);
  });

  it("closes a Pi child when initial session startup fails", async () => {
    const failure = new Error("Pi session startup failed");
    const session = {
      start: vi.fn(async () => {
        throw failure;
      }),
      closeAndWait: vi.fn(async () => undefined)
    };

    await expect(startManagedConversationRuntimeSession(session)).rejects.toBe(
      failure
    );
    expect(session.closeAndWait).toHaveBeenCalledOnce();
  });
});

describe("Managed Conversation assistant output buffers", () => {
  it("recovers only the final answer tied to the exact Codex turn", () => {
    const transcript = [
      {
        timestamp: "2026-09-26T17:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "target-turn" }
      },
      {
        timestamp: "2026-09-26T17:00:01.000Z",
        type: "response_item",
        payload: {
          id: "reasoning-target",
          type: "reasoning",
          summary: ["Internal reasoning must not be surfaced"]
        }
      },
      {
        timestamp: "2026-09-26T17:00:02.000Z",
        type: "response_item",
        payload: {
          id: "answer-target",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Recovered answer" }]
        }
      },
      {
        timestamp: "2026-09-26T17:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "other-turn" }
      },
      {
        timestamp: "2026-09-26T17:00:04.000Z",
        type: "response_item",
        payload: {
          id: "answer-other",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Other turn" }]
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");

    expect(
      codexAssistantFinalTextForTurn({
        bytes: Buffer.from(`${transcript}\n`),
        turnId: "target-turn",
        sessionId: randomUUID(),
        providerThreadId: randomUUID()
      })
    ).toEqual({ text: "Recovered answer", providerItemId: "answer-target" });
    expect(
      codexAssistantFinalTextForTurn({
        bytes: Buffer.from(`${transcript}\n`),
        turnId: "missing-turn",
        sessionId: randomUUID(),
        providerThreadId: randomUUID()
      })
    ).toBeNull();
  });

  it("collects ordered assistant message items for one turn and excludes other buffers", () => {
    const executionId = randomUUID();
    const turnId = randomUUID();
    const entries = new Map([
      [
        `${executionId}:${turnId}:message-1`,
        { kind: "assistant" as const, text: "First part", itemId: "runtime-1" }
      ],
      [
        `${executionId}:${turnId}:message-2`,
        { kind: "assistant" as const, text: "Second part", itemId: "runtime-2" }
      ],
      [
        `${executionId}:${turnId}:reasoning`,
        {
          kind: "other" as const,
          text: "Not user-visible",
          itemId: "runtime-3"
        }
      ],
      [
        `${executionId}:${randomUUID()}:message-3`,
        {
          kind: "assistant" as const,
          text: "Another turn",
          itemId: "runtime-4"
        }
      ]
    ]);

    const result = managedConversationAssistantOutputForTurn(
      entries,
      executionId,
      turnId
    );
    expect(result.map(([, buffer]) => buffer.text)).toEqual([
      "First part",
      "Second part"
    ]);
    expect(result.map(([, buffer]) => buffer.itemId)).toEqual([
      "runtime-1",
      "runtime-2"
    ]);
  });
});

describe("managed Conversation Project Move runner safeguards", () => {
  it("does not diff checkpoint refs across repositories after a Project Move", async () => {
    const capture = (repositoryIdentityHash: string) => ({
      status: "ready" as const,
      vcsDriver: "git" as const,
      repositoryIdentityHash,
      worktreeIdentityHash: `worktree-${repositoryIdentityHash}`,
      checkpointRef:
        "refs/koed/checkpoints/10000000-0000-4000-8000-000000000001/1/1/baseline",
      commitObjectId: "a".repeat(40),
      capturedAt: new Date(0).toISOString()
    });
    const checkout = {
      checkoutId: randomUUID(),
      vcsDriver: "git" as const,
      ownership: "user_managed_checkout" as const,
      canonicalPath: "/missing/destination",
      localRepositoryCommonDirectory: "/missing/destination/.git",
      localGitDirectory: "/missing/destination/.git",
      repositoryIdentityHash: "destination-repository",
      worktreeIdentityHash: "destination-worktree",
      baseRef: "refs/heads/main",
      baseObjectId: "b".repeat(40),
      branchRef: "refs/heads/main",
      headObjectId: "b".repeat(40)
    };

    await expect(
      diffExecutionCheckpointsForCheckout({
        checkout,
        from: capture("source-repository"),
        to: capture("destination-repository")
      })
    ).resolves.toBeNull();
  });

  it("classifies staged, unstaged, and untracked edits, and treats Git failures as unknown", async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), "koed-project-move-edit-state-")
    );
    const checkout = resolve(root, "checkout");
    await mkdir(checkout, { recursive: true });
    execFileSync("git", ["init", "-q", checkout]);
    expect(gitWorkingTreeEditState(checkout)).toBe("clean");
    const file = resolve(checkout, "tracked.txt");
    await writeFile(file, "initial");
    execFileSync("git", ["add", "tracked.txt"], { cwd: checkout });
    expect(gitWorkingTreeEditState(checkout)).toBe("changed");
    execFileSync("git", ["reset", "-q"], { cwd: checkout });
    expect(gitWorkingTreeEditState(checkout)).toBe("changed");
    execFileSync("git", ["add", "tracked.txt"], { cwd: checkout });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "base"
      ],
      { cwd: checkout }
    );
    await writeFile(file, "unstaged change");
    expect(gitWorkingTreeEditState(checkout)).toBe("changed");
    expect(gitWorkingTreeEditState(root)).toBe("unknown");
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    {
      registeredDestination: true,
      recoveredBinding: false,
      failState: "failed"
    },
    {
      registeredDestination: false,
      recoveredBinding: true,
      failState: "failed"
    },
    {
      registeredDestination: false,
      recoveredBinding: true,
      failState: "claimed"
    },
    {
      registeredDestination: false,
      recoveredBinding: true,
      failState: "completed"
    },
    {
      registeredDestination: true,
      recoveredBinding: false,
      invalidJournalSource: true,
      failState: "claimed"
    }
  ])(
    "$registeredDestination registered destination / $recoveredBinding recovered binding handles destination metadata safely ($failState fail result)",
    async ({
      registeredDestination,
      recoveredBinding,
      invalidJournalSource = false,
      failState
    }) => {
      const root = await mkdtemp(
        resolve(tmpdir(), "koed-project-move-registered-")
      );
      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const providerThreadId = randomUUID();
      const localSessionId = randomUUID();
      const sourcePath = resolve(root, "source");
      const destinationPath = resolve(root, "destination");
      const koedHome = resolve(root, "koed-home");
      const destinationProjectId = `lp_${randomUUID().replaceAll("-", "")}`;
      const moveId = randomUUID();
      const transcriptPath = resolve(root, "transcript.jsonl");
      const managedHome = resolve(root, "managed-home");
      let canonicalDestinationPath = destinationPath;
      const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
      const start = vi
        .spyOn(CodexManagedConversationSession.prototype, "start")
        .mockImplementation(() => {
          return Promise.resolve({
            // The native resume response can retain the original thread cwd even
            // though subsequent turns use the destination binding's cwd.
            thread: {
              id: providerThreadId,
              path: transcriptPath,
              cwd: sourcePath
            } as never,
            sessionId: localSessionId,
            transcriptPath,
            codexHome: managedHome
          });
        });
      const runTurn = vi.spyOn(
        CodexManagedConversationSession.prototype,
        "runTurn"
      );
      const close = vi
        .spyOn(CodexManagedConversationSession.prototype, "closeAndWait")
        .mockResolvedValue();
      await mkdir(sourcePath, { recursive: true });
      await mkdir(destinationPath, { recursive: true });
      canonicalDestinationPath = await realpath(destinationPath);
      await mkdir(resolve(koedHome, "config"), { recursive: true });
      await writeFile(
        resolve(koedHome, "config", "projects.json"),
        JSON.stringify({
          schemaVersion: 3,
          projects: registeredDestination
            ? [
                {
                  localProjectId: destinationProjectId,
                  displayName: "Registered destination",
                  path: { cwd: destinationPath, projectRoot: destinationPath }
                }
              ]
            : []
        })
      );
      execFileSync("git", ["init", "-q", sourcePath]);

      let execution: ManagedConversationExecutionRecord = {
        ...terminalExecutionFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId
        }),
        state: "running",
        stateVersion: 3,
        logicalSessionId: randomUUID(),
        providerThreadId,
        runnerId: randomUUID(),
        runnerLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      const sourceBinding: ManagedConversationRuntimeBindingRecord = {
        ...pendingBindingFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId,
          sourceProjectPath: sourcePath
        }),
        projectPath: sourcePath,
        checkoutId: randomUUID(),
        checkoutKind: "koed_managed_worktree",
        checkoutLifecycle: "ready",
        vcsDriver: "git",
        localRepositoryCommonDirectory: resolve(sourcePath, ".git"),
        localGitDirectory: resolve(sourcePath, ".git"),
        repositoryIdentityHash: "a".repeat(64),
        worktreeIdentityHash: "b".repeat(64),
        baseRef: "HEAD",
        baseObjectId: "c".repeat(40),
        branchRef: `refs/heads/koed/${executionId}/1`,
        headObjectId: "c".repeat(40),
        creationOperationId: randomUUID(),
        localSessionId,
        providerThreadId,
        transcriptPath,
        managedHome
      };
      let binding = recoveredBinding
        ? {
            ...sourceBinding,
            projectPath: canonicalDestinationPath,
            sourceProjectPath: sourcePath,
            checkoutId: randomUUID()
          }
        : sourceBinding;
      let move = {
        id: moveId,
        ownerUserId,
        executionId,
        executionGeneration: 1,
        sourceProjectId: execution.projectId,
        destinationProjectId,
        state: "claimed",
        claimToken: randomUUID(),
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        claimedByRunnerId: "",
        assignedDeploymentId: deploymentId,
        assignedDeviceId: deviceId
      } as ManagedConversationProjectMoveRecord;
      if (recoveredBinding || invalidJournalSource) {
        const journalSource = invalidJournalSource
          ? { ...sourceBinding, providerThreadId: randomUUID() }
          : sourceBinding;
        new ProjectMoveLocalJournal({ koedHome }).write({
          schemaVersion: 1,
          moveId,
          sourceRuntimeBinding: journalSource,
          sourceProjectId: execution.projectId,
          destinationProjectId,
          destinationLocalPath: canonicalDestinationPath,
          phase: recoveredBinding ? "binding_committed" : "requested",
          updatedAt: new Date().toISOString()
        });
      }
      const sourceIdentity = {
        checkoutId: sourceBinding.checkoutId!,
        vcsDriver: "git" as const,
        ownership: "koed_managed_worktree" as const,
        canonicalPath: sourcePath,
        localRepositoryCommonDirectory:
          sourceBinding.localRepositoryCommonDirectory,
        localGitDirectory: sourceBinding.localGitDirectory,
        repositoryIdentityHash: sourceBinding.repositoryIdentityHash,
        worktreeIdentityHash: sourceBinding.worktreeIdentityHash,
        baseRef: sourceBinding.baseRef,
        baseObjectId: sourceBinding.baseObjectId,
        branchRef: sourceBinding.branchRef,
        headObjectId: sourceBinding.headObjectId
      };
      const destinationIdentity = {
        ...sourceIdentity,
        checkoutId: randomUUID(),
        ownership: "non_vcs_directory" as const,
        canonicalPath: canonicalDestinationPath,
        vcsDriver: null,
        localRepositoryCommonDirectory: null,
        localGitDirectory: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        baseRef: null,
        baseObjectId: null,
        branchRef: null,
        headObjectId: null
      };
      const checkoutDriver = {
        verify: vi.fn(async () => sourceIdentity),
        select: vi.fn(async ({ path }: { path: string }) => {
          expect(path).toBe(canonicalDestinationPath);
          return destinationIdentity;
        }),
        remove: vi.fn(async () => undefined)
      } as unknown as GitExecutionCheckoutDriver;
      const completeMove = vi.fn(async () => {
        move = { ...move, state: "completed" };
        execution = { ...execution, projectId: destinationProjectId };
        return move;
      });
      const repository = {
        listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
          async () => []
        ),
        listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
        listManagedConversationExecutionsForRunner: vi.fn(async () => []),
        getManagedConversationExecution: vi.fn(async () => execution),
        getManagedConversationRuntimeBinding: vi.fn(async () => binding),
        listLcmGraphThreads: vi.fn(async () => []),
        claimManagedConversationProjectMoves: vi.fn(
          async (claim: { runnerId: string }) => {
            move = { ...move, claimedByRunnerId: claim.runnerId };
            return [move];
          }
        ),
        getManagedConversationProjectMove: vi.fn(async () => move),
        renewManagedConversationProjectMoveLease: vi.fn(async () => true),
        failManagedConversationProjectMove: vi.fn(async () => {
          move = { ...move, state: failState };
          return move;
        }),
        completeManagedConversationProjectMove: completeMove,
        transitionManagedConversationProjectMoveRuntimeBinding: vi.fn(
          async (
            _actor,
            input: { expectedProjectPath: string; projectPath: string }
          ) => {
            expect(binding.projectPath).toBe(input.expectedProjectPath);
            binding = {
              ...binding,
              sourceProjectPath: input.projectPath,
              projectPath: input.projectPath,
              checkoutId: null,
              checkoutKind: "pending",
              checkoutLifecycle: "pending",
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
              managedHome: null
            };
            return binding;
          }
        ),
        bindManagedConversationExecutionCheckout: vi.fn(
          async (_actor, input: Record<string, unknown>) => {
            binding = {
              ...binding,
              ...input,
              checkoutLifecycle: "ready",
              cleanupState: "not_requested"
            } as ManagedConversationRuntimeBindingRecord;
            return binding;
          }
        ),
        bindManagedConversationLocalRuntime: vi.fn(
          async (_actor, input: Record<string, unknown>) => {
            binding = {
              ...binding,
              ...input
            } as ManagedConversationRuntimeBindingRecord;
            return binding;
          }
        ),
        reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
        cancelManagedConversationRuntimeItems: vi.fn(async () => 0),
        releaseManagedConversationRunner: vi.fn(async () => true),
        claimManagedConversationCommands: vi.fn(async () => [])
      } as unknown as MemorySourceRepository;
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const service = createManagedConversationService({
        repository,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: ownerUserId,
        appServerBinary: "codex",
        deviceId,
        deploymentId,
        koedHome,
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        executionCheckoutDriver: checkoutDriver,
        logger: logger as never
      });
      try {
        const result = await service.processOnce();
        expect(result).toMatchObject(
          recoveredBinding && failState === "failed"
            ? { completed: 0, failed: 1 }
            : recoveredBinding || invalidJournalSource
              ? { completed: 0, failed: 0 }
              : { completed: 1, failed: 0 }
        );
        expect(repository.listLcmGraphThreads).not.toHaveBeenCalled();
        if (recoveredBinding) {
          expect(completeMove).not.toHaveBeenCalled();
          expect(
            repository.failManagedConversationProjectMove
          ).toHaveBeenCalledOnce();
          expect(
            repository.transitionManagedConversationProjectMoveRuntimeBinding
          ).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              expectedProjectPath: canonicalDestinationPath,
              projectPath: sourcePath
            })
          );
          expect(binding).toMatchObject({
            projectPath: sourcePath,
            localSessionId,
            providerThreadId,
            transcriptPath,
            managedHome
          });
          const journal = new ProjectMoveLocalJournal({ koedHome }).read(
            moveId
          );
          if (failState === "failed") {
            expect(journal).toBeNull();
          } else {
            expect(journal?.phase).toBe("binding_committed");
          }
        } else if (invalidJournalSource) {
          expect(completeMove).not.toHaveBeenCalled();
          expect(
            repository.failManagedConversationProjectMove
          ).toHaveBeenCalledOnce();
          expect(binding.projectPath).toBe(sourcePath);
          expect(
            new ProjectMoveLocalJournal({ koedHome }).read(moveId)?.phase
          ).toBe("requested");
        } else {
          expect(completeMove).toHaveBeenCalledWith(
            expect.objectContaining({
              moveId,
              destinationProjectName: "Registered destination"
            })
          );
          expect(binding).toMatchObject({
            projectPath: canonicalDestinationPath,
            localSessionId,
            providerThreadId,
            transcriptPath,
            managedHome
          });
        }
        expect(start).toHaveBeenCalledTimes(invalidJournalSource ? 0 : 1);
        expect(runTurn).not.toHaveBeenCalled();
        expect(checkoutDriver.remove).toHaveBeenCalledTimes(
          recoveredBinding || invalidJournalSource ? 0 : 1
        );
      } finally {
        await service.stop();
        start.mockRestore();
        runTurn.mockRestore();
        close.mockRestore();
        restoreRegistry();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { reason: "changed", checkoutKind: "koed_managed_worktree" },
    { reason: "unknown", checkoutKind: "koed_managed_worktree" },
    { reason: "changed", checkoutKind: "user_managed_checkout" },
    { reason: "unknown", checkoutKind: "user_managed_checkout" }
  ] as const)(
    "moves a dirty $checkoutKind and preserves a durable local locator ($reason)",
    async ({ reason: retentionReason, checkoutKind }) => {
      const root = await mkdtemp(resolve(tmpdir(), "koed-project-move-dirty-"));
      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const providerThreadId = randomUUID();
      const localSessionId = randomUUID();
      const moveId = randomUUID();
      const destinationProjectId = `lp_${randomUUID().replaceAll("-", "")}`;
      const sourcePath = resolve(root, "source");
      const destinationPath = resolve(root, "destination");
      const koedHome = resolve(root, "koed-home");
      const sourceProjectRootPath = resolve(root, "source-project-root");
      const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
      const start = vi
        .spyOn(CodexManagedConversationSession.prototype, "start")
        .mockImplementation(() =>
          Promise.resolve({
            thread: {
              id: providerThreadId,
              path: resolve(root, "transcript.jsonl"),
              cwd: sourcePath
            } as never,
            sessionId: localSessionId,
            transcriptPath: resolve(root, "transcript.jsonl"),
            codexHome: resolve(root, "managed-home")
          })
        );
      const close = vi
        .spyOn(CodexManagedConversationSession.prototype, "closeAndWait")
        .mockResolvedValue();
      await mkdir(sourcePath, { recursive: true });
      await mkdir(destinationPath, { recursive: true });
      await mkdir(resolve(koedHome, "config"), { recursive: true });
      await writeFile(
        resolve(koedHome, "config", "projects.json"),
        JSON.stringify({
          schemaVersion: 3,
          projects: [
            {
              localProjectId: destinationProjectId,
              displayName: "Destination",
              path: { cwd: destinationPath, projectRoot: destinationPath }
            }
          ]
        })
      );
      execFileSync("git", ["init", "-q", sourcePath]);
      await writeFile(
        resolve(sourcePath, "changed.txt"),
        "uncommitted source edit"
      );

      const execution: ManagedConversationExecutionRecord = {
        ...terminalExecutionFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId
        }),
        state: "running",
        stateVersion: 3,
        logicalSessionId: randomUUID(),
        providerThreadId,
        runnerId: randomUUID(),
        runnerLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      const sourceBinding: ManagedConversationRuntimeBindingRecord = {
        ...pendingBindingFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId,
          sourceProjectPath: sourceProjectRootPath
        }),
        projectPath: sourcePath,
        checkoutId: randomUUID(),
        checkoutKind,
        checkoutLifecycle: "ready",
        vcsDriver: "git",
        localRepositoryCommonDirectory: resolve(sourcePath, ".git"),
        localGitDirectory: resolve(sourcePath, ".git"),
        repositoryIdentityHash: "a".repeat(64),
        worktreeIdentityHash: "b".repeat(64),
        baseRef: "HEAD",
        baseObjectId: "c".repeat(40),
        branchRef: `refs/heads/koed/${executionId}/1`,
        headObjectId: "c".repeat(40),
        creationOperationId: randomUUID(),
        localSessionId,
        providerThreadId: execution.providerThreadId,
        transcriptPath: resolve(root, "transcript.jsonl"),
        managedHome: resolve(root, "managed-home")
      };
      let move = {
        id: moveId,
        ownerUserId,
        executionId,
        executionGeneration: 1,
        sourceProjectId: execution.projectId,
        destinationProjectId,
        state: "claimed",
        claimToken: randomUUID(),
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        claimedByRunnerId: randomUUID(),
        assignedDeploymentId: deploymentId,
        assignedDeviceId: deviceId
      } as ManagedConversationProjectMoveRecord;
      const identity = {
        checkoutId: sourceBinding.checkoutId!,
        vcsDriver: "git" as const,
        ownership: checkoutKind,
        canonicalPath: sourcePath,
        localRepositoryCommonDirectory:
          sourceBinding.localRepositoryCommonDirectory,
        localGitDirectory: sourceBinding.localGitDirectory,
        repositoryIdentityHash: sourceBinding.repositoryIdentityHash,
        worktreeIdentityHash: sourceBinding.worktreeIdentityHash,
        baseRef: sourceBinding.baseRef,
        baseObjectId: sourceBinding.baseObjectId,
        branchRef: sourceBinding.branchRef,
        headObjectId:
          retentionReason === "unknown"
            ? "d".repeat(40)
            : sourceBinding.headObjectId
      };
      const destinationIdentity = {
        ...identity,
        checkoutId: randomUUID(),
        ownership: "non_vcs_directory" as const,
        canonicalPath: await realpath(destinationPath),
        vcsDriver: null,
        localRepositoryCommonDirectory: null,
        localGitDirectory: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        baseRef: null,
        baseObjectId: null,
        branchRef: null,
        headObjectId: null
      };
      const checkoutDriver = {
        verify: vi.fn(async () => identity),
        select: vi.fn(async () => destinationIdentity),
        remove: vi.fn(async () => undefined)
      } as unknown as GitExecutionCheckoutDriver;
      let binding = sourceBinding;
      const completeMove = vi.fn(async () => {
        move = { ...move, state: "completed" };
        return move;
      });
      const repository = {
        listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
          async () => []
        ),
        listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
        listManagedConversationExecutionsForRunner: vi.fn(async () => []),
        getManagedConversationExecution: vi.fn(async () => execution),
        getManagedConversationRuntimeBinding: vi.fn(async () => binding),
        listLcmGraphThreads: vi.fn(async () => []),
        claimManagedConversationProjectMoves: vi.fn(
          async (claim: { runnerId: string }) => [
            { ...move, claimedByRunnerId: claim.runnerId }
          ]
        ),
        getManagedConversationProjectMove: vi.fn(async () => move),
        renewManagedConversationProjectMoveLease: vi.fn(async () => true),
        failManagedConversationProjectMove: vi.fn(async () => ({
          ...move,
          state: "failed" as const
        })),
        cancelManagedConversationRuntimeItems: vi.fn(async () => 0),
        releaseManagedConversationRunner: vi.fn(async () => true),
        completeManagedConversationProjectMove: completeMove,
        transitionManagedConversationProjectMoveRuntimeBinding: vi.fn(
          async (_actor: unknown, input: { projectPath: string }) => {
            binding = {
              ...binding,
              sourceProjectPath: input.projectPath,
              projectPath: input.projectPath,
              checkoutId: null,
              checkoutKind: "pending",
              checkoutLifecycle: "pending",
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
              managedHome: null
            };
            return binding;
          }
        ),
        bindManagedConversationExecutionCheckout: vi.fn(
          async (_actor: unknown, input: Record<string, unknown>) => {
            binding = {
              ...binding,
              ...input,
              checkoutLifecycle: "ready",
              cleanupState: "not_requested"
            } as ManagedConversationRuntimeBindingRecord;
            return binding;
          }
        ),
        bindManagedConversationLocalRuntime: vi.fn(
          async (_actor: unknown, input: Record<string, unknown>) => {
            binding = {
              ...binding,
              ...input
            } as ManagedConversationRuntimeBindingRecord;
            return binding;
          }
        ),
        upsertManagedConversationRuntimeBinding: vi.fn(),
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
        koedHome,
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        executionCheckoutDriver: checkoutDriver,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
      });
      try {
        const result = await service.processOnce();
        expect(result).toMatchObject({ completed: 1, failed: 0 });
        expect(completeMove).toHaveBeenCalledOnce();
        expect(binding.projectPath).toBe(await realpath(destinationPath));
        expect(repository.listLcmGraphThreads).not.toHaveBeenCalled();
        const retained = JSON.parse(
          await readFile(
            resolve(koedHome, "run", "retained-workspaces", `${moveId}.json`),
            "utf8"
          )
        );
        expect(retained).toMatchObject({
          schemaVersion: 2,
          moveId,
          executionId,
          sourcePath,
          destinationPath: await realpath(destinationPath),
          checkoutKind,
          checkoutIdentity: {
            ownership: checkoutKind,
            canonicalPath: sourcePath
          },
          reason: retentionReason
        });
        expect(retained.sourcePath).toBe(sourcePath);
        expect(retained.sourcePath).not.toBe(sourceProjectRootPath);
        expect(await readFile(resolve(sourcePath, "changed.txt"), "utf8")).toBe(
          "uncommitted source edit"
        );
        expect(checkoutDriver.remove).not.toHaveBeenCalled();
      } finally {
        await service.stop();
        start.mockRestore();
        close.mockRestore();
        restoreRegistry();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

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

      expect(environment.CODEX_HOME).toBe(await realpath(codexHome));
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
    checkoutId: null,
    checkoutKind: "pending",
    checkoutLifecycle: "pending",
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
  checkoutId: string;
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
    checkoutId: input.checkoutId,
    checkoutKind: "koed_managed_worktree",
    checkoutLifecycle: "cleanup_requested",
    cleanupState: "requested",
    vcsDriver: "git",
    localRepositoryCommonDirectory: "/source/.git",
    localGitDirectory: "/source/.git/worktrees/test",
    repositoryIdentityHash: "a".repeat(64),
    worktreeIdentityHash: "b".repeat(64),
    baseRef: "HEAD",
    baseObjectId: "c".repeat(40),
    branchRef: `refs/heads/koed/${input.executionId}/1/${input.checkoutId}`,
    headObjectId: "c".repeat(40),
    creationOperationId: input.checkoutId,
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

const configureLocalCodexInstanceRegistry = async (
  root: string,
  includeInstance = true
) => {
  const registryPath = resolve(root, "ai-client-instances.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      instances: includeInstance
        ? [
            {
              instanceId: "codex.default",
              driverId: "codex",
              displayName: "Codex",
              executablePath: process.execPath
            }
          ]
        : []
    })
  );
  const previous = process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY;
  process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY = registryPath;
  return () => {
    if (previous === undefined) {
      delete process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY;
    } else {
      process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY = previous;
    }
  };
};

const deferredStartRepository = (input: {
  execution: ManagedConversationExecutionRecord;
  currentExecution?: ManagedConversationExecutionRecord;
  projectPath?: string;
  instancesAvailable?: boolean;
  localBinding?: ManagedConversationRuntimeBindingRecord | null;
  initialExecutions?: ManagedConversationExecutionRecord[];
  failExecutionAfterCheckout?: boolean;
  startCommand?: unknown;
}) => {
  let currentBinding = input.localBinding ?? null;
  let currentExecution = input.currentExecution ?? input.execution;
  let assignedExecutions = input.initialExecutions ?? [input.execution];
  const capabilitySnapshot = {
    instanceId: "codex.default",
    installationIdentityHash: "identity",
    authenticationState: "authenticated",
    healthState: "healthy",
    expiresAt: "2099-01-01T00:00:00Z",
    models: [{ id: "gpt-test", supportedReasoningEfforts: ["low"] }],
    capabilities: {
      descriptors: {
        managed_conversation_send: {
          support: "supported",
          readiness: "ready"
        }
      }
    }
  };
  const repository = {
    listManagedConversationExecutionsForRunner: vi.fn(
      async () => assignedExecutions
    ),
    listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
      async () => []
    ),
    listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
    getManagedConversationExecution: vi.fn(async () => currentExecution),
    getManagedConversationRuntimeBinding: vi.fn(async () => currentBinding),
    listLcmGraphThreads: vi.fn(async () =>
      input.projectPath
        ? [{ id: input.execution.projectId, path: input.projectPath }]
        : []
    ),
    upsertManagedConversationRuntimeBinding: vi.fn(async (_actor, binding) => {
      currentBinding = pendingBindingFixture({
        ownerUserId: input.execution.ownerUserId,
        executionId: input.execution.id,
        deploymentId: binding.deploymentId,
        deviceId: binding.deviceId,
        sourceProjectPath: binding.projectPath
      });
      return currentBinding;
    }),
    bindManagedConversationExecutionCheckout: vi.fn(async (_actor, binding) => {
      currentBinding = {
        ...currentBinding!,
        ...binding,
        checkoutLifecycle: "ready" as const,
        cleanupState: "not_requested" as const
      };
      if (input.failExecutionAfterCheckout) {
        currentExecution = { ...currentExecution, state: "failed" };
      }
      return currentBinding;
    }),
    listAiClientInstances: vi.fn(async () =>
      input.instancesAvailable === false
        ? []
        : [
            {
              instanceId: "codex.default",
              driverId: "codex",
              enabled: true,
              configIdentityHash: "identity"
            }
          ]
    ),
    listCurrentAiClientCapabilitySnapshots: vi.fn(async () =>
      input.instancesAvailable === false ? [] : [capabilitySnapshot]
    ),
    releaseManagedConversationStartForRuntimeBinding: vi.fn(async () => true),
    acknowledgeManagedConversationRuntimeBinding: vi.fn(async () => true),
    failManagedConversationStartForRuntimeBinding: vi.fn(async () => {
      currentExecution = { ...currentExecution, state: "failed" };
      return true;
    }),
    releaseManagedConversationRunner: vi.fn(async () => true),
    clearManagedConversationRuntimeBinding: vi.fn(async () => {
      currentBinding = null;
      return true;
    }),
    reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
    claimManagedConversationCommands: vi.fn(async () =>
      input.startCommand ? [input.startCommand as never] : []
    ),
    renewManagedConversationCommandLease: vi.fn(async () => true),
    failManagedConversationCommand: vi.fn(async () => ({
      updated: true,
      reconciled: false,
      requeued: false
    })),
    cancelManagedConversationRuntimeItems: vi.fn(async () => 0),
    setManagedConversationExecutionState: vi.fn(async () => currentExecution)
  };
  const checkoutDriver = {
    select: vi.fn(async ({ path }: { path: string }) => ({
      checkoutId: randomUUID(),
      vcsDriver: null,
      ownership: "non_vcs_directory" as const,
      canonicalPath: path,
      localRepositoryCommonDirectory: null,
      localGitDirectory: null,
      repositoryIdentityHash: null,
      worktreeIdentityHash: null,
      baseRef: null,
      baseObjectId: null,
      branchRef: null,
      headObjectId: null
    }))
  } as unknown as GitExecutionCheckoutDriver;
  const repositoryType = repository as unknown as MemorySourceRepository;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    repository,
    logger,
    setAssignedExecutions: (
      executions: ManagedConversationExecutionRecord[]
    ) => {
      assignedExecutions = executions;
    },
    createService: (options: {
      deploymentId: string;
      deviceId: string;
      localOwnerUserId: string;
      koedHome: string;
    }) =>
      createManagedConversationService({
        repository: repositoryType,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: options.localOwnerUserId,
        appServerBinary: "codex",
        deviceId: options.deviceId,
        deploymentId: options.deploymentId,
        koedHome: options.koedHome,
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        executionCheckoutDriver: checkoutDriver,
        logger: logger as never
      })
  };
};

describe("deferred Managed Conversation runner starts", () => {
  it("discovers an assigned start, prepares its local binding, and is idempotent after reconnect", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-deferred-start-"));
    const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
    await mkdir(resolve(root, "project"), { recursive: true });
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
    const harness = deferredStartRepository({
      execution,
      projectPath: resolve(root, "project")
    });
    const serviceOptions = {
      deploymentId,
      deviceId,
      localOwnerUserId: ownerUserId,
      koedHome: resolve(root, "koed-home")
    };
    const service = harness.createService(serviceOptions);
    try {
      await service.processOnce();
      await vi.waitFor(() =>
        expect(
          harness.repository.listManagedConversationExecutionsForRunner
        ).toHaveBeenCalledOnce()
      );
      await vi.waitFor(() =>
        expect(
          harness.repository.getManagedConversationExecution
        ).toHaveBeenCalledOnce()
      );
      await vi.waitFor(() =>
        expect(
          harness.repository.upsertManagedConversationRuntimeBinding
        ).toHaveBeenCalledOnce()
      );
      await vi.waitFor(() =>
        expect(
          harness.repository.bindManagedConversationExecutionCheckout
        ).toHaveBeenCalledOnce()
      );
      await vi.waitFor(() =>
        expect(
          harness.repository.releaseManagedConversationStartForRuntimeBinding
        ).toHaveBeenCalledOnce()
      );
      expect(
        harness.repository.upsertManagedConversationRuntimeBinding
      ).toHaveBeenCalledWith(
        { userId: ownerUserId },
        expect.objectContaining({
          executionId,
          deploymentId,
          deviceId,
          executionGeneration: 1,
          projectPath: await realpath(resolve(root, "project"))
        })
      );
      expect(
        harness.repository.bindManagedConversationExecutionCheckout.mock
          .invocationCallOrder[0]
      ).toBeLessThan(
        harness.repository.releaseManagedConversationStartForRuntimeBinding.mock
          .invocationCallOrder[0]!
      );
      expect(
        harness.repository.acknowledgeManagedConversationRuntimeBinding
      ).toHaveBeenCalledWith({
        ownerUserId,
        executionId,
        executionGeneration: 1,
        deploymentId,
        deviceId
      });
      expect(
        harness.repository.failManagedConversationStartForRuntimeBinding
      ).not.toHaveBeenCalled();
      await service.stop();

      // A reconnect may see the same durable `starting` record before the
      // authority's next state projection, but the acknowledged local binding
      // prevents a second checkout preparation or readiness release.
      const reconnected = harness.createService(serviceOptions);
      await reconnected.processOnce();
      await vi.waitFor(() =>
        expect(
          harness.repository.listManagedConversationExecutionsForRunner
        ).toHaveBeenCalledTimes(4)
      );
      expect(
        harness.repository.upsertManagedConversationRuntimeBinding
      ).toHaveBeenCalledOnce();
      expect(
        harness.repository.releaseManagedConversationStartForRuntimeBinding
      ).toHaveBeenCalledOnce();
      await reconnected.stop();
    } finally {
      await service.stop();
      restoreRegistry();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares an independent hosted execution under KOED_HOME before acknowledgement", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-deferred-independent-"));
    const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const execution = {
      ...startingExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      }),
      projectId: null,
      contextKind: "independent" as const
    };
    const koedHome = resolve(root, "koed-home");
    await mkdir(koedHome, { recursive: true });
    const harness = deferredStartRepository({ execution });
    const service = harness.createService({
      deploymentId,
      deviceId,
      localOwnerUserId: ownerUserId,
      koedHome
    });
    try {
      await service.processOnce();
      await vi.waitFor(() =>
        expect(
          harness.repository.releaseManagedConversationStartForRuntimeBinding
        ).toHaveBeenCalledOnce()
      );
      const projectPath = resolve(
        await realpath(koedHome),
        "managed-conversations",
        "independent",
        executionId
      );
      expect(
        harness.repository.upsertManagedConversationRuntimeBinding
      ).toHaveBeenCalledWith(
        { userId: ownerUserId },
        expect.objectContaining({
          executionId,
          deploymentId,
          deviceId,
          executionGeneration: 1,
          projectPath
        })
      );
      expect(harness.repository.listLcmGraphThreads).not.toHaveBeenCalled();
      expect(
        harness.repository.acknowledgeManagedConversationRuntimeBinding
      ).toHaveBeenCalledWith({
        ownerUserId,
        executionId,
        executionGeneration: 1,
        deploymentId,
        deviceId
      });
      expect((await stat(projectPath)).mode & 0o777).toBe(0o700);
    } finally {
      await service.stop();
      restoreRegistry();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers a browser start on the next runner wake after startup", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-deferred-start-wake-"));
    const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
    await mkdir(resolve(root, "project"), { recursive: true });
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
    const harness = deferredStartRepository({
      execution,
      initialExecutions: [],
      projectPath: resolve(root, "project")
    });
    const service = harness.createService({
      deploymentId,
      deviceId,
      localOwnerUserId: ownerUserId,
      koedHome: resolve(root, "koed-home")
    });
    try {
      await service.processOnce();
      await vi.waitFor(() =>
        expect(
          harness.repository.listManagedConversationExecutionsForRunner
        ).toHaveBeenCalledTimes(2)
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      harness.setAssignedExecutions([execution]);

      await service.processOnce();
      await vi.waitFor(() =>
        expect(
          harness.repository.releaseManagedConversationStartForRuntimeBinding
        ).toHaveBeenCalledOnce()
      );
      expect(
        harness.repository.listManagedConversationExecutionsForRunner
      ).toHaveBeenCalledTimes(3);
    } finally {
      await service.stop();
      restoreRegistry();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips readiness when the execution becomes failed during local checkout preparation", async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), "koed-deferred-start-canceled-")
    );
    const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const execution = {
      ...startingExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      }),
      projectId: null,
      contextKind: "independent" as const
    };
    const harness = deferredStartRepository({
      execution,
      failExecutionAfterCheckout: true
    });
    const service = harness.createService({
      deploymentId,
      deviceId,
      localOwnerUserId: ownerUserId,
      koedHome: resolve(root, "koed-home")
    });
    try {
      await service.processOnce();
      await vi.waitFor(() =>
        expect(
          harness.repository.bindManagedConversationExecutionCheckout
        ).toHaveBeenCalledOnce()
      );
      await vi.waitFor(() =>
        expect(
          harness.repository.getManagedConversationExecution
        ).toHaveBeenCalledTimes(3)
      );
      expect(
        harness.repository.releaseManagedConversationStartForRuntimeBinding
      ).not.toHaveBeenCalled();
      expect(
        harness.repository.acknowledgeManagedConversationRuntimeBinding
      ).not.toHaveBeenCalled();
      expect(
        harness.repository.failManagedConversationStartForRuntimeBinding
      ).not.toHaveBeenCalled();
      expect(harness.repository.listLcmGraphThreads).not.toHaveBeenCalled();
      expect(
        harness.repository.acknowledgeManagedConversationRuntimeBinding
      ).not.toHaveBeenCalled();
    } finally {
      await service.stop();
      restoreRegistry();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      unavailable: "Project",
      instancesAvailable: true,
      projectPath: undefined
    },
    {
      unavailable: "AI Client",
      instancesAvailable: true,
      projectPath: "/local/project",
      localInstanceConfigured: false
    },
    {
      unavailable: "AI Client settings",
      instancesAvailable: false,
      projectPath: "/local/project"
    }
  ])(
    "fails closed when the local $unavailable is unavailable",
    async ({
      unavailable,
      instancesAvailable,
      projectPath,
      localInstanceConfigured
    }) => {
      const root = await mkdtemp(
        resolve(tmpdir(), "koed-deferred-start-invalid-")
      );
      const restoreRegistry = await configureLocalCodexInstanceRegistry(
        root,
        localInstanceConfigured !== false
      );
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
      const harness = deferredStartRepository({
        execution,
        projectPath,
        instancesAvailable
      });
      const service = harness.createService({
        deploymentId,
        deviceId,
        localOwnerUserId: ownerUserId,
        koedHome: resolve(root, "koed-home")
      });
      try {
        await service.processOnce();
        await vi.waitFor(() =>
          expect(
            harness.repository.failManagedConversationStartForRuntimeBinding
          ).toHaveBeenCalledOnce()
        );
        expect(
          harness.repository.failManagedConversationStartForRuntimeBinding
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            ownerUserId,
            executionId,
            executionGeneration: 1,
            deploymentId,
            deviceId,
            errorCode:
              unavailable === "Project"
                ? "ManagedConversationProjectUnavailableError"
                : unavailable === "AI Client"
                  ? "ManagedConversationProviderUnavailableError"
                  : "ManagedConversationSettingsUnavailableError"
          })
        );
        expect(
          harness.repository.releaseManagedConversationStartForRuntimeBinding
        ).not.toHaveBeenCalled();
        expect(
          harness.repository.acknowledgeManagedConversationRuntimeBinding
        ).not.toHaveBeenCalled();
        expect(
          harness.repository.upsertManagedConversationRuntimeBinding
        ).not.toHaveBeenCalled();
      } finally {
        await service.stop();
        restoreRegistry();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    {
      changed: "runner",
      current: (execution: ManagedConversationExecutionRecord) => ({
        ...execution,
        runnerDeviceId: randomUUID()
      })
    },
    {
      changed: "generation",
      current: (execution: ManagedConversationExecutionRecord) => ({
        ...execution,
        executionGeneration: execution.executionGeneration + 1
      })
    }
  ])(
    "ignores an assignment whose $changed fence changed before local preparation",
    async ({ current }) => {
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
      const harness = deferredStartRepository({
        execution,
        currentExecution: current(execution),
        projectPath: "/must-not-be-read"
      });
      const service = harness.createService({
        deploymentId,
        deviceId,
        localOwnerUserId: ownerUserId,
        koedHome: "/tmp/koed-deferred-start-fenced"
      });
      try {
        await service.processOnce();
        await vi.waitFor(() =>
          expect(
            harness.repository.listManagedConversationExecutionsForRunner
          ).toHaveBeenCalledOnce()
        );
        expect(harness.repository.listLcmGraphThreads).not.toHaveBeenCalled();
        expect(
          harness.repository.upsertManagedConversationRuntimeBinding
        ).not.toHaveBeenCalled();
        expect(
          harness.repository.releaseManagedConversationStartForRuntimeBinding
        ).not.toHaveBeenCalled();
        expect(
          harness.repository.failManagedConversationStartForRuntimeBinding
        ).not.toHaveBeenCalled();
      } finally {
        await service.stop();
      }
    }
  );
  it.each([
    {
      unavailable: "AI Client settings",
      instancesAvailable: false,
      projectPath: "/local/project",
      bindingPath: null,
      errorCode: "ManagedConversationSettingsUnavailableError"
    },
    {
      unavailable: "Project",
      instancesAvailable: true,
      projectPath: undefined,
      bindingPath: null,
      errorCode: "ManagedConversationProjectUnavailableError"
    },
    {
      unavailable: "changed Project path",
      instancesAvailable: true,
      projectPath: "current",
      bindingPath: "old",
      errorCode: "ManagedConversationProjectUnavailableError"
    }
  ])(
    "rechecks $unavailable immediately before starting a queued execution",
    async ({
      unavailable,
      instancesAvailable,
      projectPath,
      bindingPath,
      errorCode
    }) => {
      const root = await mkdtemp(resolve(tmpdir(), "koed-start-recheck-"));
      const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
      const currentProjectPath = resolve(root, "current-project");
      const oldProjectPath = resolve(root, "old-project");
      await mkdir(currentProjectPath);
      await mkdir(oldProjectPath);
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
      const startCommand = {
        id: randomUUID(),
        ownerUserId,
        executionId,
        executionGeneration: execution.executionGeneration,
        commandKind: "start" as const,
        sequence: 1,
        attempts: 1,
        leaseToken: randomUUID(),
        payload: {},
        execution
      };
      const harness = deferredStartRepository({
        execution,
        instancesAvailable,
        projectPath:
          projectPath === "current"
            ? currentProjectPath
            : projectPath === undefined
              ? undefined
              : currentProjectPath,
        localBinding:
          bindingPath === "old"
            ? pendingBindingFixture({
                ownerUserId,
                executionId,
                deploymentId,
                deviceId,
                sourceProjectPath: oldProjectPath
              })
            : null,
        initialExecutions: [],
        startCommand
      });
      const start = vi
        .spyOn(CodexManagedConversationSession.prototype, "start")
        .mockRejectedValue(new Error("provider must not start"));
      const service = harness.createService({
        deploymentId,
        deviceId,
        localOwnerUserId: ownerUserId,
        koedHome: resolve(root, "koed-home")
      });
      try {
        await expect(service.processOnce()).resolves.toEqual({
          completed: 0,
          failed: 1
        });
        expect(start).not.toHaveBeenCalled();
        expect(
          harness.repository.failManagedConversationCommand
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            commandId: startCommand.id,
            state: "failed",
            errorCode
          })
        );
        expect(
          harness.repository.setManagedConversationExecutionState
        ).toHaveBeenCalledWith(
          { userId: ownerUserId },
          expect.objectContaining({
            executionId,
            state: "failed",
            lastErrorCode: errorCode
          })
        );
      } finally {
        await service.stop();
        start.mockRestore();
        restoreRegistry();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe("Managed Conversation service lifecycle", () => {
  it("resolves a newly registered local Project for a queued native start", async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), "koed-registered-project-start-")
    );
    const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
    const ownerUserId = randomUUID();
    const localOwnerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const localProjectId = `lp_${randomUUID().replaceAll("-", "")}`;
    const projectPath = resolve(root, "registered-project");
    const koedHome = resolve(root, "koed-home");
    await mkdir(projectPath, { recursive: true });
    await mkdir(resolve(koedHome, "config"), { recursive: true });
    await writeFile(
      resolve(koedHome, "config", "projects.json"),
      JSON.stringify({
        schemaVersion: 3,
        projects: [
          {
            localProjectId,
            displayName: "New Project",
            path: { cwd: projectPath, projectRoot: projectPath }
          }
        ]
      })
    );
    const execution = {
      ...startingExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      }),
      projectId: localProjectId
    };
    const startCommand = {
      id: randomUUID(),
      ownerUserId,
      executionId,
      executionGeneration: execution.executionGeneration,
      commandKind: "start" as const,
      sequence: 1,
      attempts: 1,
      leaseToken: randomUUID(),
      payload: {},
      execution
    };
    const harness = deferredStartRepository({
      execution,
      initialExecutions: [],
      startCommand
    });
    const start = vi
      .spyOn(CodexManagedConversationSession.prototype, "start")
      .mockRejectedValue(new Error("stop after registered Project resolution"));
    const service = harness.createService({
      deploymentId,
      deviceId,
      localOwnerUserId,
      koedHome
    });
    try {
      await service.processOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(
        harness.repository.upsertManagedConversationRuntimeBinding
      ).toHaveBeenCalledWith(
        { userId: ownerUserId },
        expect.objectContaining({ projectPath: await realpath(projectPath) })
      );
    } finally {
      await service.stop();
      start.mockRestore();
      restoreRegistry();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["shutdown", "idle lease fence"] as const)(
    "preserves pending partial output during %s",
    async (lifecycleEvent) => {
      const root = await mkdtemp(resolve(tmpdir(), "koed-shutdown-output-"));
      const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const providerThreadId = randomUUID();
      const localSessionId = randomUUID();
      const logicalSessionId = randomUUID();
      const projectPath = resolve(root, "project");
      const transcriptPath = resolve(root, "transcript.jsonl");
      const managedHome = resolve(root, "managed-home");
      await mkdir(projectPath, { recursive: true });
      await mkdir(managedHome, { recursive: true });
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session_meta", payload: { id: providerThreadId } })}\n`
      );
      const execution: ManagedConversationExecutionRecord = {
        ...terminalExecutionFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId
        }),
        state: "running",
        logicalSessionId,
        providerThreadId,
        runnerId: randomUUID(),
        runnerLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      const binding: ManagedConversationRuntimeBindingRecord = {
        ...pendingBindingFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId,
          sourceProjectPath: projectPath
        }),
        projectPath,
        checkoutId: randomUUID(),
        checkoutKind: "user_managed_checkout",
        checkoutLifecycle: "ready",
        vcsDriver: "git",
        localRepositoryCommonDirectory: projectPath,
        localGitDirectory: resolve(projectPath, ".git"),
        repositoryIdentityHash: "a".repeat(64),
        worktreeIdentityHash: "b".repeat(64),
        baseRef: "refs/heads/main",
        baseObjectId: "c".repeat(40),
        branchRef: "refs/heads/main",
        headObjectId: "c".repeat(40),
        creationOperationId: randomUUID(),
        localSessionId,
        providerThreadId,
        transcriptPath,
        managedHome
      };
      const cancelRuntimeItems = vi.fn(async () => 0);
      const persistedOutputTexts: string[] = [];
      const lifecycleOrder: string[] = [];
      let emitDelta:
        | ((event: { turnId: string; delta: string }) => void)
        | undefined;
      const renewLease = vi.fn(
        async () => lifecycleEvent !== "idle lease fence"
      );
      const repository = {
        listManagedConversationExecutionsForRunner: vi.fn(async () => [
          execution
        ]),
        getManagedConversationExecution: vi.fn(async () => execution),
        setManagedConversationExecutionState: vi.fn(async () => execution),
        getManagedConversationRuntimeBinding: vi.fn(async () => binding),
        getCapturedSession: vi.fn(async () => ({
          id: localSessionId,
          logicalSessionId,
          externalSessionId: providerThreadId
        })),
        acquireManagedConversationExecutionLease: vi.fn(async () => true),
        renewManagedConversationExecutionLease: renewLease,
        releaseManagedConversationRunner: vi.fn(async () => true),
        listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
          async () => []
        ),
        listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
        reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
        claimManagedConversationCommands: vi.fn(async () => []),
        listManagedConversationExecutionCheckpoints: vi.fn(async () => []),
        cancelManagedConversationRuntimeItems: vi.fn(async (...args) => {
          lifecycleOrder.push("cancel");
          return cancelRuntimeItems(...args);
        }),
        putManagedConversationRuntimeItem: vi.fn(async (_actor, input) => {
          lifecycleOrder.push("persist");
          persistedOutputTexts.push(input.payload.text);
          return { id: randomUUID() };
        })
      };
      const start = vi
        .spyOn(CodexManagedConversationSession.prototype, "start")
        .mockImplementation(async function (
          this: CodexManagedConversationSession
        ) {
          const config = (
            this as unknown as {
              config: {
                appServer: {
                  onAgentMessageDelta?: (event: {
                    turnId: string;
                    delta: string;
                  }) => void;
                };
              };
            }
          ).config;
          emitDelta = config.appServer.onAgentMessageDelta;
          return {
            thread: {
              id: providerThreadId,
              path: transcriptPath,
              cwd: projectPath
            },
            sessionId: localSessionId,
            transcriptPath,
            codexHome: managedHome
          } as never;
        });
      const close = vi
        .spyOn(CodexManagedConversationSession.prototype, "closeAndWait")
        .mockImplementation(async () => {
          lifecycleOrder.push("close");
          emitDelta?.({ turnId: "partial-turn", delta: "-tail" });
        });
      const checkoutDriver = {
        verify: vi.fn(async () => ({
          checkoutId: binding.checkoutId,
          vcsDriver: "git" as const,
          ownership: "user_managed_checkout" as const,
          canonicalPath: projectPath,
          localRepositoryCommonDirectory:
            binding.localRepositoryCommonDirectory,
          localGitDirectory: binding.localGitDirectory,
          repositoryIdentityHash: binding.repositoryIdentityHash,
          worktreeIdentityHash: binding.worktreeIdentityHash,
          baseRef: binding.baseRef,
          baseObjectId: binding.baseObjectId,
          branchRef: binding.branchRef,
          headObjectId: binding.headObjectId
        }))
      } as unknown as GitExecutionCheckoutDriver;
      const service = createManagedConversationService({
        repository: repository as unknown as MemorySourceRepository,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: ownerUserId,
        appServerBinary: process.execPath,
        deviceId,
        deploymentId,
        koedHome: resolve(root, "koed-home"),
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        executionCheckoutDriver: checkoutDriver,
        commandWakePool: {
          connect: async () => ({
            query: async () => undefined,
            on: () => undefined,
            removeAllListeners: () => undefined,
            release: () => undefined
          })
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
      });
      try {
        await service.processOnce();
        await vi.waitFor(() => expect(start).toHaveBeenCalled());
        emitDelta?.({ turnId: "partial-turn", delta: "prefix" });
        await vi.waitFor(() =>
          expect(persistedOutputTexts).toContain("prefix")
        );

        if (lifecycleEvent === "shutdown") {
          await service.stop();
        } else {
          // No prompt is active in this recovered runtime, so the in-memory
          // activePromptProviderTurns map is empty when lease renewal fails.
          vi.useFakeTimers();
          service.start();
          await vi.advanceTimersByTimeAsync(45_000);
          await vi.waitFor(() =>
            expect(cancelRuntimeItems).toHaveBeenCalledOnce()
          );
        }

        expect(cancelRuntimeItems).toHaveBeenCalledWith(
          { userId: ownerUserId },
          {
            executionId,
            executionGeneration: execution.executionGeneration,
            preserveTransientOutput: true
          }
        );
        expect(close).toHaveBeenCalledOnce();
        expect(persistedOutputTexts.at(-1)).toBe("prefix-tail");
        expect(lifecycleOrder.lastIndexOf("close")).toBeLessThan(
          lifecycleOrder.lastIndexOf("cancel")
        );
      } finally {
        await service.stop();
        start.mockRestore();
        close.mockRestore();
        restoreRegistry();
        await rm(root, { recursive: true, force: true });
        vi.useRealTimers();
      }
    }
  );

  it.each([
    {
      terminalStatus: "interrupted",
      expectedCommandState: "failed",
      expectedErrorCode: "ManagedConversationTurnInterruptedError",
      failureUpdated: true
    },
    {
      terminalStatus: "failed",
      expectedCommandState: "indeterminate",
      expectedErrorCode: "ManagedConversationProviderTurnError",
      failureUpdated: true
    },
    {
      terminalStatus: "failed",
      expectedCommandState: "indeterminate",
      expectedErrorCode: "ManagedConversationProviderTurnError",
      failureUpdated: false
    }
  ] as const)(
    "Codex turn $terminalStatus is handled safely",
    async (scenario) => {
      const {
        terminalStatus,
        expectedCommandState,
        expectedErrorCode,
        failureUpdated
      } = scenario;
      const root = await mkdtemp(resolve(tmpdir(), "koed-hosted-recovery-"));
      const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
      const ownerUserId = randomUUID();
      const executionId = randomUUID();
      const deploymentId = randomUUID();
      const deviceId = randomUUID();
      const providerThreadId = randomUUID();
      const localSessionId = randomUUID();
      const logicalSessionId = randomUUID();
      const projectPath = resolve(root, "project");
      const transcriptPath = resolve(root, "transcript.jsonl");
      const managedHome = resolve(root, "managed-home");
      await mkdir(projectPath, { recursive: true });
      await mkdir(managedHome, { recursive: true });
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session_meta", payload: { id: providerThreadId } })}\n`
      );
      const execution: ManagedConversationExecutionRecord = {
        ...terminalExecutionFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId
        }),
        state: "running",
        logicalSessionId,
        providerThreadId,
        runnerId: randomUUID(),
        runnerLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      const binding: ManagedConversationRuntimeBindingRecord = {
        ...pendingBindingFixture({
          ownerUserId,
          executionId,
          deploymentId,
          deviceId,
          sourceProjectPath: projectPath
        }),
        projectPath,
        checkoutId: randomUUID(),
        checkoutKind: "user_managed_checkout",
        checkoutLifecycle: "ready",
        vcsDriver: "git",
        localRepositoryCommonDirectory: projectPath,
        localGitDirectory: resolve(projectPath, ".git"),
        repositoryIdentityHash: "a".repeat(64),
        worktreeIdentityHash: "b".repeat(64),
        baseRef: "refs/heads/main",
        baseObjectId: "c".repeat(40),
        branchRef: "refs/heads/main",
        headObjectId: "c".repeat(40),
        creationOperationId: randomUUID(),
        localSessionId,
        providerThreadId,
        transcriptPath,
        managedHome
      };
      const promptCommandId = randomUUID();
      const clientUserMessageId = randomUUID();
      const followUpMessageId = randomUUID();
      const promptCommand = {
        id: promptCommandId,
        ownerUserId,
        executionId,
        executionGeneration: 1,
        commandKind: "prompt" as const,
        sequence: 2,
        attempts: 1,
        leaseToken: randomUUID(),
        clientUserMessageId,
        payload: { prompt: "Continue from the hosted chat." },
        execution
      };
      const followUpCommand = {
        ...promptCommand,
        id: randomUUID(),
        sequence: 3,
        clientUserMessageId: followUpMessageId,
        payload: { prompt: "Follow up after the interrupted turn." }
      };
      const baselineCheckpoint: ManagedConversationExecutionCheckpointRecord = {
        id: randomUUID(),
        ownerUserId,
        executionId,
        executionGeneration: 1,
        commandId: promptCommandId,
        providerTurnId: null,
        sourceGenerationId: null,
        sequence: 2,
        checkpointKind: "baseline",
        checkpointStatus: "unsupported",
        failureCode: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        vcsDriver: null,
        checkpointRef: null,
        commitObjectId: null,
        capturedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const followUpBaselineCheckpoint = {
        ...baselineCheckpoint,
        id: randomUUID(),
        commandId: followUpCommand.id,
        sequence: 3
      };
      let claimCount = 0;
      const repository = {
        listManagedConversationExecutionsForRunner: vi.fn(async () => [
          execution
        ]),
        getManagedConversationExecution: vi.fn(async () => execution),
        setManagedConversationExecutionState: vi.fn(async () => execution),
        getManagedConversationRuntimeBinding: vi.fn(async () => binding),
        getCapturedSession: vi.fn(async () => ({
          id: localSessionId,
          logicalSessionId,
          externalSessionId: providerThreadId
        })),
        acquireManagedConversationExecutionLease: vi.fn(async () => true),
        releaseManagedConversationRunner: vi.fn(async () => true),
        listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
          async () => []
        ),
        listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
        reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
        claimManagedConversationCommands: vi.fn(async () => {
          claimCount += 1;
          return claimCount === 1
            ? []
            : terminalStatus === "interrupted"
              ? [promptCommand, followUpCommand]
              : [promptCommand];
        }),
        listManagedConversationExecutionCheckpoints: vi.fn(async () => [
          baselineCheckpoint,
          followUpBaselineCheckpoint
        ]),
        cancelManagedConversationRuntimeItems: vi.fn(async () => 0),
        renewManagedConversationCommandLease: vi.fn(async () => true),
        failManagedConversationCommand: vi.fn(async () => ({
          updated: failureUpdated,
          reconciled: false,
          requeued: false
        }))
        // Deliberately omit listPersonalAgentExecutionJobs and
        // getManagedConversationCommand: this is the hosted combined repository.
      };
      const start = vi
        .spyOn(CodexManagedConversationSession.prototype, "start")
        .mockResolvedValue({
          thread: {
            id: providerThreadId,
            path: transcriptPath,
            cwd: projectPath
          },
          sessionId: localSessionId,
          transcriptPath,
          codexHome: managedHome
        } as never);
      const turnId = randomUUID();
      const runTurn = vi
        .spyOn(CodexManagedConversationSession.prototype, "runTurn")
        .mockImplementationOnce(
          async (_prompt, _timeout, _clientMessageId, runOptions) => {
            runOptions?.onTurnStartAttempt?.();
            throw Object.assign(new Error("private turn detail"), {
              name: "CodexAppServerTurnError",
              threadId: providerThreadId,
              turnId,
              rawEvents: [
                {
                  method: "turn/completed",
                  params: {
                    threadId: providerThreadId,
                    turn: { id: turnId, status: terminalStatus }
                  },
                  observedAt: new Date().toISOString(),
                  sequence: 1
                }
              ]
            });
          }
        )
        .mockImplementationOnce(
          async (_prompt, _timeout, _clientMessageId, runOptions) => {
            runOptions?.onTurnStartAttempt?.();
            throw new Error("stop after follow-up dispatch");
          }
        );
      const close = vi
        .spyOn(CodexManagedConversationSession.prototype, "closeAndWait")
        .mockResolvedValue();
      const checkoutDriver = {
        verify: vi.fn(async () => ({
          checkoutId: binding.checkoutId,
          vcsDriver: "git" as const,
          ownership: "user_managed_checkout" as const,
          canonicalPath: projectPath,
          localRepositoryCommonDirectory:
            binding.localRepositoryCommonDirectory,
          localGitDirectory: binding.localGitDirectory,
          repositoryIdentityHash: binding.repositoryIdentityHash,
          worktreeIdentityHash: binding.worktreeIdentityHash,
          baseRef: binding.baseRef,
          baseObjectId: binding.baseObjectId,
          branchRef: binding.branchRef,
          headObjectId: binding.headObjectId
        }))
      } as unknown as GitExecutionCheckoutDriver;
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const service = createManagedConversationService({
        repository: repository as unknown as MemorySourceRepository,
        apiUrl: "http://127.0.0.1:3300",
        apiToken: "test-token",
        localOwnerUserId: ownerUserId,
        appServerBinary: process.execPath,
        deviceId,
        deploymentId,
        koedHome: resolve(root, "koed-home"),
        envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
        executionCheckoutDriver: checkoutDriver,
        logger: logger as never
      });
      try {
        await service.processOnce();
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        // Let startup recovery finish caching the newly resumed native session.
        await new Promise((resolveTurn) => setImmediate(resolveTurn));

        await expect(service.processOnce()).resolves.toEqual({
          completed: 0,
          failed: terminalStatus === "interrupted" ? 2 : 1
        });
        expect(
          runTurn.mock.calls.length,
          JSON.stringify(
            logger.warn.mock.calls.map(
              ([context]) => (context as { error_name?: string }).error_name
            )
          )
        ).toBe(terminalStatus === "interrupted" ? 2 : 1);
        expect(runTurn).toHaveBeenCalledWith(
          "Continue from the hosted chat.",
          expect.any(Number),
          `koed-user-message:${clientUserMessageId}`,
          expect.objectContaining({
            onTurnStartAttempt: expect.any(Function)
          })
        );
        expect(start).toHaveBeenCalledOnce();
        expect(repository.failManagedConversationCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            commandId: promptCommandId,
            state: expectedCommandState,
            errorCode: expectedErrorCode
          })
        );
        if (terminalStatus === "interrupted") {
          // The next queued prompt reaches the same recovered session without a
          // second start, proving the interrupted turn did not fence the chat.
          expect(
            repository.cancelManagedConversationRuntimeItems
          ).toHaveBeenCalledWith(
            { userId: ownerUserId },
            {
              executionId,
              executionGeneration: execution.executionGeneration
            }
          );
          expect(runTurn).toHaveBeenLastCalledWith(
            "Follow up after the interrupted turn.",
            expect.any(Number),
            `koed-user-message:${followUpMessageId}`,
            expect.objectContaining({
              onTurnStartAttempt: expect.any(Function)
            })
          );
          expect(start).toHaveBeenCalledOnce();
        } else {
          expect(
            repository.cancelManagedConversationRuntimeItems
          ).toHaveBeenCalledWith(
            { userId: ownerUserId },
            {
              executionId,
              executionGeneration: execution.executionGeneration,
              preserveTransientOutput: true
            }
          );
        }
        expect(close).toHaveBeenCalledOnce();
        expect(
          logger.warn.mock.calls.some(
            ([context]) =>
              (context as { event?: { name?: string } }).event?.name ===
              "worker.managed_conversation.runtime_recovery_deferred"
          )
        ).toBe(false);
      } finally {
        await service.stop();
        start.mockRestore();
        runTurn.mockRestore();
        close.mockRestore();
        restoreRegistry();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("evicts and closes a session cached before a later recovery error", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(resolve(tmpdir(), "koed-late-recovery-error-"));
    const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const providerThreadId = randomUUID();
    const localSessionId = randomUUID();
    const projectPath = resolve(root, "project");
    const transcriptPath = resolve(root, "transcript.jsonl");
    const managedHome = resolve(root, "managed-home");
    await mkdir(projectPath, { recursive: true });
    await mkdir(managedHome, { recursive: true });
    await writeFile(transcriptPath, "{}\n");
    const execution: ManagedConversationExecutionRecord = {
      ...terminalExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      }),
      state: "running",
      logicalSessionId: randomUUID(),
      providerThreadId,
      runnerId: randomUUID(),
      runnerLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const binding: ManagedConversationRuntimeBindingRecord = {
      ...pendingBindingFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId,
        sourceProjectPath: projectPath
      }),
      projectPath,
      checkoutId: randomUUID(),
      checkoutKind: "user_managed_checkout",
      checkoutLifecycle: "ready",
      vcsDriver: "git",
      localRepositoryCommonDirectory: projectPath,
      localGitDirectory: resolve(projectPath, ".git"),
      repositoryIdentityHash: "a".repeat(64),
      worktreeIdentityHash: "b".repeat(64),
      baseRef: "refs/heads/main",
      baseObjectId: "c".repeat(40),
      branchRef: "refs/heads/main",
      headObjectId: "c".repeat(40),
      creationOperationId: randomUUID(),
      localSessionId,
      providerThreadId,
      transcriptPath,
      managedHome
    };
    let recoveryLookupCount = 0;
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => [
        execution
      ]),
      getManagedConversationExecution: vi.fn(async () => execution),
      setManagedConversationExecutionState: vi.fn(async () => execution),
      getManagedConversationRuntimeBinding: vi.fn(async () => binding),
      getCapturedSession: vi.fn(async () => ({
        id: localSessionId,
        logicalSessionId: execution.logicalSessionId,
        externalSessionId: providerThreadId
      })),
      acquireManagedConversationExecutionLease: vi.fn(async () => true),
      releaseManagedConversationRunner: vi.fn(async () => true),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => []),
      getManagedConversationCommand: vi.fn(async () => null),
      listPersonalAgentExecutionJobs: vi.fn(async () => {
        recoveryLookupCount += 1;
        if (recoveryLookupCount === 1) {
          throw Object.assign(
            new TypeError("transient recovery lookup error"),
            {
              name: "TypeError"
            }
          );
        }
        return { jobs: [], nextCursor: null };
      }),
      cancelManagedConversationRuntimeItems: vi.fn(async () => 0)
    };
    const start = vi
      .spyOn(CodexManagedConversationSession.prototype, "start")
      .mockResolvedValue({
        thread: {
          id: providerThreadId,
          path: transcriptPath,
          cwd: projectPath
        },
        sessionId: localSessionId,
        transcriptPath,
        codexHome: managedHome
      } as never);
    const close = vi
      .spyOn(CodexManagedConversationSession.prototype, "closeAndWait")
      .mockResolvedValue();
    const checkoutDriver = {
      verify: vi.fn(async () => ({
        checkoutId: binding.checkoutId,
        vcsDriver: "git" as const,
        ownership: "user_managed_checkout" as const,
        canonicalPath: projectPath,
        localRepositoryCommonDirectory: binding.localRepositoryCommonDirectory,
        localGitDirectory: binding.localGitDirectory,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        worktreeIdentityHash: binding.worktreeIdentityHash,
        baseRef: binding.baseRef,
        baseObjectId: binding.baseObjectId,
        branchRef: binding.branchRef,
        headObjectId: binding.headObjectId
      }))
    } as unknown as GitExecutionCheckoutDriver;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = createManagedConversationService({
      repository: repository as unknown as MemorySourceRepository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: process.execPath,
      deviceId,
      deploymentId,
      koedHome: resolve(root, "koed-home"),
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionCheckoutDriver: checkoutDriver,
      logger: logger as never
    });
    try {
      await service.processOnce();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(start).toHaveBeenCalledOnce();
      expect(
        repository.releaseManagedConversationRunner
      ).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: {
            name: "worker.managed_conversation.runtime_recovery_deferred",
            category: "managed_conversation"
          },
          error_name: "ManagedConversationFailure"
        }),
        expect.any(String)
      );

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      expect(close).toHaveBeenCalledOnce();
      expect(recoveryLookupCount).toBeGreaterThanOrEqual(2);
    } finally {
      await service.stop();
      start.mockRestore();
      close.mockRestore();
      restoreRegistry();
      await rm(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("keeps a recovered accepted prompt pending when transcript reconciliation is unavailable", async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), "koed-checkpoint-prompt-recovery-")
    );
    const restoreRegistry = await configureLocalCodexInstanceRegistry(root);
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const providerThreadId = randomUUID();
    const localSessionId = randomUUID();
    const sourceGenerationId = randomUUID();
    const commandId = randomUUID();
    const leaseToken = randomUUID();
    const personalAgentJobId = randomUUID();
    const agentId = randomUUID();
    const agentIdentityVersionId = randomUUID();
    const projectPath = resolve(root, "destination");
    await mkdir(projectPath, { recursive: true });
    const execution: ManagedConversationExecutionRecord = {
      ...terminalExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      }),
      state: "running",
      stateVersion: 3,
      stoppedAt: null,
      logicalSessionId: localSessionId,
      providerThreadId,
      sourceGenerationId,
      runnerId: randomUUID(),
      runnerLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const checkoutId = randomUUID();
    const binding: ManagedConversationRuntimeBindingRecord = {
      ...pendingBindingFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId,
        sourceProjectPath: projectPath
      }),
      projectPath,
      checkoutId,
      checkoutKind: "user_managed_checkout",
      checkoutLifecycle: "ready",
      vcsDriver: "git",
      localRepositoryCommonDirectory: resolve(projectPath, ".git"),
      localGitDirectory: resolve(projectPath, ".git"),
      repositoryIdentityHash: "a".repeat(64),
      worktreeIdentityHash: "b".repeat(64),
      baseRef: "refs/heads/main",
      baseObjectId: "c".repeat(40),
      branchRef: "refs/heads/main",
      headObjectId: "c".repeat(40),
      creationOperationId: randomUUID(),
      localSessionId,
      providerThreadId,
      transcriptPath: resolve(root, "transcript.jsonl"),
      managedHome: resolve(root, "managed-home"),
      sourceGenerationId
    };
    const checkpoint = (
      sequence: number,
      kind: "baseline" | "terminal",
      repositoryIdentityHash: string
    ): ManagedConversationExecutionCheckpointRecord => ({
      id: randomUUID(),
      ownerUserId,
      executionId,
      executionGeneration: 1,
      commandId: randomUUID(),
      providerTurnId: null,
      sourceGenerationId,
      sequence,
      checkpointKind: kind,
      checkpointStatus: "ready",
      failureCode: null,
      repositoryIdentityHash,
      worktreeIdentityHash: "b".repeat(64),
      vcsDriver: "git",
      checkpointRef: `refs/koed/checkpoints/${executionId}/1/${sequence}/${kind}`,
      commitObjectId: "d".repeat(40),
      capturedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const command = {
      id: commandId,
      ownerUserId,
      executionId,
      executionGeneration: 1,
      commandKind: "prompt" as const,
      sequence: 2,
      attempts: 1,
      leaseToken,
      clientUserMessageId: randomUUID(),
      payload: {
        prompt: "Continue",
        personalAgent: {
          jobId: personalAgentJobId,
          agentId,
          agentVersion: 1
        },
        personalAgentContext: {
          schemaVersion: 1,
          identity: {
            agentId,
            version: 1,
            identityVersionId: agentIdentityVersionId,
            name: "Test Agent",
            role: null,
            soulInstructions: "Answer clearly."
          },
          project: { projectId: null, name: null },
          memory: { searchDomain: "global", evidence: [] }
        }
      },
      result: {
        phase: "checkpoint_pending",
        providerTurnId: "turn-2",
        sourceGenerationId
      },
      execution
    };
    const checkpoints = [
      checkpoint(1, "baseline", "c".repeat(64)),
      {
        ...checkpoint(2, "baseline", binding.repositoryIdentityHash!),
        commandId
      },
      {
        ...checkpoint(2, "terminal", binding.repositoryIdentityHash!),
        commandId
      }
    ];
    const complete = vi.fn(async () => true);
    const completeAttempt = vi.fn(async () => ({
      attempt: {},
      job: {},
      replayed: false
    }));
    const fail = vi.fn(async () => ({
      updated: true,
      reconciled: false,
      requeued: true
    }));
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [command]),
      getManagedConversationExecution: vi.fn(async () => ({
        ...execution,
        state: "running",
        stateVersion: 2
      })),
      setManagedConversationExecutionState: vi.fn(async () => true),
      getManagedConversationRuntimeBinding: vi.fn(async () => binding),
      listManagedConversationExecutionCheckpoints: vi.fn(
        async () => checkpoints
      ),
      renewManagedConversationCommandLease: vi.fn(async () => true),
      completeManagedConversationCommand: complete,
      completePersonalAgentExecutionAttempt: completeAttempt,
      failManagedConversationCommand: fail,
      cancelManagedConversationRuntimeItems: vi.fn(async () => 0),
      releaseManagedConversationRunner: vi.fn(async () => true)
    } as unknown as MemorySourceRepository;
    const start = vi
      .spyOn(CodexManagedConversationSession.prototype, "start")
      .mockRejectedValue(
        new Error("Transcript storage temporarily unavailable")
      );
    const close = vi
      .spyOn(CodexManagedConversationSession.prototype, "closeAndWait")
      .mockResolvedValue();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const checkoutDriver = {
      verify: vi.fn(async () => ({
        checkoutId,
        vcsDriver: "git" as const,
        ownership: "user_managed_checkout" as const,
        canonicalPath: projectPath,
        localRepositoryCommonDirectory: binding.localRepositoryCommonDirectory,
        localGitDirectory: binding.localGitDirectory,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        worktreeIdentityHash: binding.worktreeIdentityHash,
        baseRef: binding.baseRef,
        baseObjectId: binding.baseObjectId,
        branchRef: binding.branchRef,
        headObjectId: binding.headObjectId
      }))
    } as unknown as GitExecutionCheckoutDriver;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: process.execPath,
      deviceId,
      deploymentId,
      koedHome: resolve(root, "koed-home"),
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionCheckoutDriver: checkoutDriver,
      logger: logger as never
    });
    try {
      const processResult = await service.processOnce();
      expect(processResult).toEqual({ completed: 0, failed: 1 });
      expect(start).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
      expect(completeAttempt).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId,
          leaseToken,
          state: "indeterminate",
          errorCode: "ExecutionCheckpointRecoveryPendingError"
        })
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: {
            name: "worker.managed_conversation.checkpoint_transcript_reconciliation_deferred",
            category: "managed_conversation"
          }
        }),
        expect.any(String)
      );
    } finally {
      await service.stop();
      start.mockRestore();
      close.mockRestore();
      restoreRegistry();
      await rm(root, { recursive: true, force: true });
    }
  });

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
      const checkoutDriver = await createGitExecutionCheckoutDriver({
        managedRoot: resolve(root, ".managed")
      });
      const checkout = await checkoutDriver.select({
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
        sourceProjectPath: checkout.canonicalPath,
        projectPath: checkout.canonicalPath,
        checkoutId: checkout.checkoutId,
        checkoutKind: checkout.ownership,
        checkoutLifecycle: "ready",
        cleanupState: "not_requested",
        vcsDriver: checkout.vcsDriver,
        localRepositoryCommonDirectory: checkout.localRepositoryCommonDirectory,
        localGitDirectory: checkout.localGitDirectory,
        repositoryIdentityHash: checkout.repositoryIdentityHash,
        worktreeIdentityHash: checkout.worktreeIdentityHash,
        baseRef: checkout.baseRef,
        baseObjectId: checkout.baseObjectId,
        branchRef: checkout.branchRef,
        headObjectId: checkout.headObjectId,
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
        checkout,
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
        executionCheckoutDriver: checkoutDriver,
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
      const checkoutDriver = await createGitExecutionCheckoutDriver({
        managedRoot: resolve(root, ".managed")
      });
      const checkout = await checkoutDriver.select({
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
        sourceProjectPath: checkout.canonicalPath,
        projectPath: checkout.canonicalPath,
        checkoutId: checkout.checkoutId,
        checkoutKind: checkout.ownership,
        checkoutLifecycle: "ready",
        cleanupState: "not_requested",
        vcsDriver: checkout.vcsDriver,
        localRepositoryCommonDirectory: checkout.localRepositoryCommonDirectory,
        localGitDirectory: checkout.localGitDirectory,
        repositoryIdentityHash: checkout.repositoryIdentityHash,
        worktreeIdentityHash: checkout.worktreeIdentityHash,
        baseRef: checkout.baseRef,
        baseObjectId: checkout.baseObjectId,
        branchRef: checkout.branchRef,
        headObjectId: checkout.headObjectId,
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
        checkout,
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
        listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
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
        executionCheckoutDriver: checkoutDriver,
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

  it("rejects unavailable turn settings before opening a runtime and keeps the Conversation writable", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const execution = {
      ...startingExecutionFixture({
        ownerUserId,
        executionId,
        deploymentId,
        deviceId
      }),
      state: "running"
    };
    const command = {
      id: randomUUID(),
      ownerUserId,
      executionId,
      executionGeneration: 1,
      commandKind: "prompt",
      attempts: 1,
      leaseToken: randomUUID(),
      payload: {
        prompt: "Keep working",
        settings: {
          model: "retired-model",
          reasoningEffort: "high",
          permissionMode: "supervised"
        }
      },
      execution
    };
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [command]),
      listAiClientInstances: vi.fn(async () => []),
      listCurrentAiClientCapabilitySnapshots: vi.fn(async () => []),
      getManagedConversationRuntimeBinding: vi.fn(),
      setManagedConversationExecutionState: vi.fn(),
      failManagedConversationCommand: vi.fn(async () => ({
        updated: true,
        reconciled: false,
        requeued: false
      }))
    };
    const service = createManagedConversationService({
      repository: repository as unknown as MemorySourceRepository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: ownerUserId,
      appServerBinary: "must-not-start-provider",
      deviceId,
      deploymentId,
      koedHome: "/tmp/koed-managed-conversation-settings-test",
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });
    try {
      await expect(service.processOnce()).resolves.toEqual({
        completed: 0,
        failed: 1
      });
      expect(repository.failManagedConversationCommand).toHaveBeenCalledWith({
        commandId: command.id,
        leaseToken: command.leaseToken,
        state: "failed",
        errorCode: "ManagedConversationSettingsUnavailableError"
      });
      expect(
        repository.getManagedConversationRuntimeBinding
      ).not.toHaveBeenCalled();
      expect(
        repository.setManagedConversationExecutionState
      ).not.toHaveBeenCalled();
    } finally {
      await service.stop();
    }
  });

  it("does not block command processing on unrelated startup recovery", async () => {
    let finishRecovery!: (value: []) => void;
    const recovery = new Promise<[]>((resolve) => {
      finishRecovery = resolve;
    });
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(() => recovery),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
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
        listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
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
      await vi.waitFor(() => expect(listExecutions).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() =>
        expect(listExecutions.mock.calls.length).toBeGreaterThanOrEqual(2)
      );
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { unborn: false, retry: false },
    { unborn: true, retry: false },
    { unborn: false, retry: true },
    { unborn: false, retry: false, ackLost: true }
  ])(
    "releases a start against the selected Project (unborn: $unborn, retry: $retry, ack lost: $ackLost)",
    async ({ unborn, retry, ackLost }) => {
      const root = await mkdtemp(resolve(tmpdir(), "koed-checkout-prepare-"));
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
        if (!unborn)
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
        let currentBinding = binding;
        let acknowledged = false;
        const acknowledge = vi.fn(async () => {
          acknowledged = true;
          return true;
        });
        if (ackLost)
          acknowledge.mockRejectedValueOnce(
            new Error("Local acknowledgement unavailable")
          );
        const bindWorkspace = vi.fn(
          async (_actor, input) =>
            (currentBinding = {
              ...binding,
              ...input,
              checkoutLifecycle: "ready" as const,
              cleanupState: "not_requested" as const,
              createdAt: binding.createdAt,
              updatedAt: binding.updatedAt
            })
        );
        const releaseStart = vi.fn(async () => {
          if (ackLost) execution.state = "running";
          return true;
        });
        if (retry)
          releaseStart.mockRejectedValueOnce(new Error("Upstream unavailable"));
        const repository = {
          listManagedConversationExecutionsForRunner: vi.fn(async () => []),
          listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
            async () => []
          ),
          listPendingManagedConversationRuntimeBindings: vi.fn(async () => [
            ...(acknowledged ? [] : [currentBinding])
          ]),
          getManagedConversationExecution: vi.fn(async () => execution),
          bindManagedConversationExecutionCheckout: bindWorkspace,
          acknowledgeManagedConversationRuntimeBinding: acknowledge,
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
        if (retry || ackLost) {
          expect(acknowledged).toBe(false);
          expect(currentBinding.checkoutLifecycle).toBe("ready");
          await service.processOnce();
          expect(releaseStart).toHaveBeenCalledTimes(ackLost ? 1 : 2);
          expect(bindWorkspace).toHaveBeenCalledOnce();
        }
        expect(acknowledge).toHaveBeenCalledTimes(ackLost ? 2 : 1);
        expect(acknowledged).toBe(true);
        await service.stop();
        const canonicalProjectPath = await realpath(sourceProjectPath);
        expect(bindWorkspace).toHaveBeenCalledWith(
          { userId: ownerUserId },
          expect.objectContaining({
            executionId,
            sourceProjectPath,
            projectPath: canonicalProjectPath,
            checkoutKind: "user_managed_checkout",
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
    }
  );

  it("discards a stale pending assignment before touching its Project", async () => {
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
      sourceProjectPath: "/unused"
    });
    const clear = vi.fn(async () => true);
    const select = vi.fn();
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => [
        binding
      ]),
      getManagedConversationExecution: vi.fn(async () => ({
        ...execution,
        runnerDeviceId: randomUUID()
      })),
      clearManagedConversationRuntimeBinding: clear,
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
      executionCheckoutDriver: {
        select
      } as unknown as GitExecutionCheckoutDriver,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });
    await service.processOnce();
    expect(select).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith({ userId: ownerUserId }, executionId, {
      executionGeneration: 1,
      deploymentId,
      deviceId
    });
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
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => [
        binding
      ]),
      getManagedConversationExecution: vi.fn(async () => execution),
      failManagedConversationStartForRuntimeBinding: failStart,
      clearManagedConversationRuntimeBinding: vi.fn(async () => true),
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
      executionCheckoutDriver: {
        select: vi.fn(async () => {
          throw new Error("ExecutionCheckoutDirectoryError");
        })
      } as unknown as GitExecutionCheckoutDriver,
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
      errorCode: "ExecutionCheckoutDirectoryError"
    });
  });

  it("retries transient checkout preparation without failing the execution", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "koed-checkout-retry-"));
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
      .mockRejectedValueOnce(new Error("ExecutionCheckoutGitCommandError"))
      .mockResolvedValue({
        checkoutId: randomUUID(),
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
      checkoutLifecycle: "ready" as const,
      cleanupState: "not_requested" as const,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt
    }));
    const releaseStart = vi.fn(async () => true);
    const failStart = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => []
      ),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => [
        binding
      ]),
      getManagedConversationExecution: vi.fn(async () => execution),
      bindManagedConversationExecutionCheckout: bindWorkspace,
      acknowledgeManagedConversationRuntimeBinding: vi.fn(async () => true),
      releaseManagedConversationStartForRuntimeBinding: releaseStart,
      failManagedConversationStartForRuntimeBinding: failStart,
      clearManagedConversationRuntimeBinding: vi.fn(async () => true),
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
      executionCheckoutDriver: {
        select
      } as unknown as GitExecutionCheckoutDriver,
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

  it("removes an explicitly requested clean checkout only after execution is terminal", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const checkoutId = randomUUID();
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
      checkoutId
    });
    const remove = vi.fn(async () => undefined);
    const completeCleanup = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => [binding]
      ),
      listManagedConversationExecutionCheckpoints: vi.fn(async () => []),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      getManagedConversationExecution: vi.fn(async () => execution),
      completeManagedConversationExecutionCheckoutCleanup: completeCleanup,
      failManagedConversationExecutionCheckoutCleanup: vi.fn(async () => true),
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
      executionCheckoutDriver: {
        remove
      } as unknown as GitExecutionCheckoutDriver,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    });

    await service.processOnce();

    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutId,
        canonicalPath: binding.projectPath
      })
    );
    expect(completeCleanup).toHaveBeenCalledWith({
      ownerUserId,
      executionId,
      executionGeneration: 1,
      deploymentId,
      deviceId,
      checkoutId
    });
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      completeCleanup.mock.invocationCallOrder[0]!
    );
  });

  it("records a refused dirty cleanup without deleting or retrying the checkout", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const checkoutId = randomUUID();
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
      checkoutId
    });
    const failCleanup = vi.fn(async () => true);
    const completeCleanup = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => [binding]
      ),
      listManagedConversationExecutionCheckpoints: vi.fn(async () => []),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      getManagedConversationExecution: vi.fn(async () => execution),
      completeManagedConversationExecutionCheckoutCleanup: completeCleanup,
      failManagedConversationExecutionCheckoutCleanup: failCleanup,
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
      executionCheckoutDriver: {
        remove: vi.fn(async () => {
          throw new Error("ExecutionCheckoutCleanupDirtyError");
        })
      } as unknown as GitExecutionCheckoutDriver,
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
      checkoutId,
      lifecycle: "cleanup_failed"
    });
  });

  it("replays idempotent removal when cleanup persistence is temporarily unavailable", async () => {
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const checkoutId = randomUUID();
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
      checkoutId
    });
    const remove = vi.fn(async () => undefined);
    const completeCleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("DatabaseTemporarilyUnavailableError"))
      .mockResolvedValue(true);
    const failCleanup = vi.fn(async () => true);
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(async () => []),
      listManagedConversationExecutionCheckoutCleanupRequests: vi.fn(
        async () => [binding]
      ),
      listManagedConversationExecutionCheckpoints: vi.fn(async () => []),
      listPendingManagedConversationRuntimeBindings: vi.fn(async () => []),
      getManagedConversationExecution: vi.fn(async () => execution),
      completeManagedConversationExecutionCheckoutCleanup: completeCleanup,
      failManagedConversationExecutionCheckoutCleanup: failCleanup,
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
      executionCheckoutDriver: {
        remove
      } as unknown as GitExecutionCheckoutDriver,
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

  it("preserves the provider authentication code through worker failure handling", () => {
    expect(
      managedConversationFailureCode(
        Object.assign(new Error("private provider diagnostic"), {
          name: "ManagedConversationAuthenticationError"
        })
      )
    ).toBe("ManagedConversationAuthenticationError");
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

  it("retains API failure status without exposing private response details", () => {
    expect(
      managedConversationFailureCode(
        new MemoryApiError("private response", {
          status: 429,
          payload: { error: "private response" }
        })
      )
    ).toBe("ManagedConversationMemoryApi429Error");
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

  it("classifies only a matching Codex terminal interruption as known", () => {
    const threadId = randomUUID();
    const turnId = randomUUID();
    const makeError = (terminalTurnId: string) =>
      Object.assign(new Error("private provider detail"), {
        name: "CodexAppServerTurnError",
        threadId,
        turnId,
        rawEvents: [
          {
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: terminalTurnId, status: "interrupted" }
            },
            observedAt: new Date().toISOString(),
            sequence: 1
          }
        ]
      });

    expect(managedConversationFailureCode(makeError(turnId))).toBe(
      "ManagedConversationTurnInterruptedError"
    );
    expect(managedConversationFailureCode(makeError(randomUUID()))).toBe(
      "ManagedConversationProviderTurnError"
    );
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
