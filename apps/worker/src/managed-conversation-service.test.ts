import { randomUUID } from "node:crypto";

import type { MemorySourceRepository } from "@koed/db";
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
  managedClaudeRuntimeHome,
  managedConversationFailureCode,
  managedConversationOriginSourceGeneration,
  reconcileBlockedManagedConversationSource,
  shouldPublishManagedConversationSource,
  shouldRequestManagedConversationSourceRestore,
  shouldRecoverForkPreparationFailure
} from "./managed-conversation-service.js";

describe("Managed Conversation execution owner", () => {
  it.each([
    ["codex", "codex.work"],
    ["claude", "claude.work"]
  ])("accepts exact supported owner %s", (provider, instanceId) => {
    expect(() =>
      assertManagedConversationExecutionOwner({
        provider,
        aiClientInstanceId: instanceId
      })
    ).not.toThrow();
  });

  it("fails closed for missing owner and Pi", () => {
    expect(() =>
      assertManagedConversationExecutionOwner({ provider: "codex" })
    ).toThrow("ManagedConversationProviderUnavailableError");
    expect(() =>
      assertManagedConversationExecutionOwner({
        provider: "pi",
        aiClientInstanceId: "pi.default"
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

describe("Managed Conversation service lifecycle", () => {
  it("waits for startup recovery before completing shutdown", async () => {
    let finishRecovery!: (value: []) => void;
    const recovery = new Promise<[]>((resolve) => {
      finishRecovery = resolve;
    });
    const repository = {
      listManagedConversationExecutionsForRunner: vi.fn(() => recovery),
      reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
      claimManagedConversationCommands: vi.fn(async () => [])
    } as unknown as MemorySourceRepository;
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token",
      localOwnerUserId: randomUUID(),
      appServerBinary: "codex",
      model: "test-model",
      claudeModel: "claude-haiku-4-5-20251001",
      reasoningEffort: "low",
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

    const processing = service.processOnce();
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
    await Promise.all([processing, stopping]);
    expect(stopped).toBe(true);
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
