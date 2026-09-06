import { describe, expect, it, vi } from "vitest";

import {
  combineManagedConversationRepositories,
  createManagedConversationAuthorityClient
} from "./managed-conversation-authority-client.js";

describe("Managed Conversation authority client", () => {
  const ids = {
    handoff: "00000000-0000-4000-8000-000000000010",
    fork: "00000000-0000-4000-8000-000000000011",
    source: "00000000-0000-4000-8000-000000000012",
    generation: "00000000-0000-4000-8000-000000000013",
    snapshot: "00000000-0000-4000-8000-000000000014",
    session: "00000000-0000-4000-8000-000000000015"
  };

  it("keeps provider usage on the execution device while authority stays remote", async () => {
    const localOwnerUserId = ids.session;
    const recordWorkflowTokenUsage = vi.fn(async () => ({ id: "usage-1" }));
    const remoteClaim = vi.fn(async () => []);
    const repository = combineManagedConversationRepositories(
      { recordWorkflowTokenUsage } as never,
      { claimManagedConversationCommands: remoteClaim } as never,
      localOwnerUserId
    );

    await repository.recordWorkflowTokenUsage(
      { userId: "remote-owner-is-not-local" },
      {
        workflowType: "managed_conversation",
        workflowId: "execution-1",
        totalTokens: 42
      }
    );
    await repository.claimManagedConversationCommands({
      runnerId: "runner-1",
      deviceId: "00000000-0000-4000-8000-000000000020",
      deploymentId: "00000000-0000-4000-8000-000000000021",
      limit: 1,
      leaseMs: 30_000
    });

    expect(recordWorkflowTokenUsage).toHaveBeenCalledWith(
      { userId: localOwnerUserId },
      expect.objectContaining({ workflowId: "execution-1" })
    );
    expect(remoteClaim).toHaveBeenCalledOnce();
  });

  it("binds the first durable source generation through runner authority", async () => {
    const execution = {
      id: "00000000-0000-4000-8000-000000000001",
      state: "running",
      sourceGenerationId: "00000000-0000-4000-8000-000000000002"
    };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ execution }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.bindManagedConversationSourceGeneration(
        { userId: "local-owner-is-not-forwarded" },
        {
          executionId: execution.id,
          executionGeneration: 1,
          runnerId: "runner-1",
          expectedSourceGenerationId: "source-generation-before",
          sourceGenerationId: execution.sourceGenerationId
        }
      )
    ).resolves.toEqual(execution);
    const request = fetch.mock.calls[0]!;
    expect(new URL(String(request[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${execution.id}/source-generation`
    );
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      executionGeneration: 1,
      runnerId: "runner-1",
      expectedSourceGenerationId: "source-generation-before",
      sourceGenerationId: execution.sourceGenerationId
    });
  });

  it("persists checkpoint-only recovery through runner authority", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("checkpoint-pending")
            ? { marked: true }
            : { updated: true, reconciled: false, requeued: true }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const commandId = "00000000-0000-4000-8000-000000000030";
    const leaseToken = "00000000-0000-4000-8000-000000000031";

    await expect(
      client.markManagedConversationCheckpointPending({
        commandId,
        leaseToken,
        sourceGenerationId: ids.generation,
        providerTurnId: "provider-turn-1"
      })
    ).resolves.toBe(true);
    await expect(
      client.failManagedConversationCommand({
        commandId,
        leaseToken,
        state: "indeterminate",
        errorCode: "ExecutionCheckpointConcurrentMutationError"
      })
    ).resolves.toEqual({
      updated: true,
      reconciled: false,
      requeued: true
    });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/commands/${commandId}/checkpoint-pending`
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      leaseToken,
      sourceGenerationId: ids.generation,
      providerTurnId: "provider-turn-1"
    });
  });

  it("lists and records checkpoints through runner authority", async () => {
    const executionId = "00000000-0000-4000-8000-000000000040";
    const checkpoint = {
      id: "00000000-0000-4000-8000-000000000041",
      executionId,
      executionGeneration: 3,
      commandId: "00000000-0000-4000-8000-000000000042",
      providerTurnId: null,
      sourceGenerationId: null,
      sequence: 0,
      checkpointKind: "baseline" as const,
      checkpointStatus: "unsupported" as const,
      failureCode: null,
      repositoryIdentityHash: null,
      worktreeIdentityHash: null,
      vcsDriver: null,
      checkpointRef: null,
      commitObjectId: null,
      capturedAt: "2026-08-18T00:00:00.000Z"
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      const method = init?.method ?? "GET";
      return new Response(
        JSON.stringify(
          method === "GET"
            ? { checkpoints: [{ ...checkpoint, ownerUserId: ids.session }] }
            : {
                checkpoint: {
                  ...checkpoint,
                  ownerUserId: ids.session,
                  createdAt: checkpoint.capturedAt
                }
              }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.listManagedConversationExecutionCheckpoints(
        { userId: "local-owner-is-not-forwarded" },
        { executionId, executionGeneration: 3 }
      )
    ).resolves.toEqual([{ ...checkpoint, ownerUserId: ids.session }]);
    await expect(
      client.recordManagedConversationExecutionCheckpoint(
        { userId: "local-owner-is-not-forwarded" },
        { checkpoint, diffs: [] }
      )
    ).resolves.toEqual({
      ...checkpoint,
      ownerUserId: ids.session,
      createdAt: checkpoint.capturedAt
    });

    const listUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/checkpoints`
    );
    expect(listUrl.searchParams.get("executionGeneration")).toBe("3");
    expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/checkpoints`
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      checkpoint,
      diffs: []
    });
  });

  it("claims and settles file operations through runner authority", async () => {
    const commandId = "00000000-0000-4000-8000-000000000050";
    const leaseToken = "00000000-0000-4000-8000-000000000051";
    const checkpointId = "00000000-0000-4000-8000-000000000052";
    const command = {
      id: commandId,
      commandKind: "file_read",
      executionId: "00000000-0000-4000-8000-000000000053"
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("claim-files")
            ? { commands: [command] }
            : path.endsWith("file-complete")
              ? { completed: true }
              : { updated: true }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const result = {
      protocolVersion: 1 as const,
      checkpointId,
      checkpointSequence: 1,
      revision: { checkpointId, revisionDigest: "a".repeat(64) },
      kind: "read" as const,
      path: "src/example.ts",
      content: "export {};\n",
      contentDigest: "b".repeat(64),
      totalBytes: 11,
      offset: 0,
      nextOffset: null,
      lineCount: 2
    };

    await expect(
      client.claimManagedConversationFileOperations({
        runnerId: "runner",
        deploymentId: ids.generation,
        deviceId: ids.session,
        limit: 2,
        leaseMs: 30_000
      })
    ).resolves.toEqual([command]);
    await expect(
      client.completeManagedConversationFileOperation({
        commandId,
        leaseToken,
        result
      })
    ).resolves.toBe(true);
    await expect(
      client.failManagedConversationFileOperation({
        commandId,
        leaseToken,
        state: "queued",
        errorCode: "ManagedConversationAuthorityUnavailableError"
      })
    ).resolves.toBe(true);
    expect(
      fetch.mock.calls.map((call) => new URL(String(call[0])).pathname)
    ).toEqual([
      "/v1/managed-conversation-runner/commands/claim-files",
      `/v1/managed-conversation-runner/commands/${commandId}/file-complete`,
      `/v1/managed-conversation-runner/commands/${commandId}/file-fail`
    ]);
  });

  it("publishes verified workspace readiness and bounded rejection through runner authority", async () => {
    const executionId = "00000000-0000-4000-8000-000000000001";
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("runtime-binding-ready")
            ? { ready: true }
            : { failed: true }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const binding = {
      ownerUserId: ids.session,
      executionId,
      executionGeneration: 2,
      deploymentId: "00000000-0000-4000-8000-000000000020",
      deviceId: "00000000-0000-4000-8000-000000000021"
    };

    await expect(
      client.releaseManagedConversationStartForRuntimeBinding(binding)
    ).resolves.toBe(true);
    await expect(
      client.failManagedConversationStartForRuntimeBinding({
        ...binding,
        errorCode: "ExecutionWorkspaceSourceDirtyError"
      })
    ).resolves.toBe(true);

    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-ready`
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      executionGeneration: 2
    });
    expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-failed`
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      executionGeneration: 2,
      errorCode: "ExecutionWorkspaceSourceDirtyError"
    });
  });

  it("loads only executions assigned by the remote runner authority", async () => {
    const execution = { id: "execution-1", state: "running" };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ executions: [execution] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.listManagedConversationExecutionsForRunner({
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        deviceId: "00000000-0000-4000-8000-000000000002",
        deploymentId: "00000000-0000-4000-8000-000000000003"
      })
    ).resolves.toEqual([execution]);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      "/v1/managed-conversation-runner/executions"
    );
  });

  it("acquires a recovered execution lease without forwarding local identity", async () => {
    const executionId = "00000000-0000-4000-8000-000000000001";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ acquired: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.acquireManagedConversationExecutionLease({
        executionId,
        executionGeneration: 2,
        deploymentId: "local-deployment-is-not-forwarded",
        deviceId: "local-device-is-not-forwarded",
        runnerId: "recovered-runner",
        leaseMs: 30_000
      })
    ).resolves.toBe(true);
    const request = fetch.mock.calls[0]!;
    expect(new URL(String(request[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/acquire`
    );
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      executionGeneration: 2,
      runnerId: "recovered-runner",
      leaseMs: 30_000
    });
  });

  it("checks exact source readiness at the execution authority", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ ready: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.isManagedConversationSourceGenerationReady({
        ownerUserId: "local-owner-is-not-forwarded",
        sourceGenerationId: ids.generation
      })
    ).resolves.toBe(true);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/source-replicas/${ids.generation}/status`
    );
    expect(
      new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("readiness")
    ).toBe("finalized");
  });

  it("derives claim authority from the credential instead of sending local identity fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ commands: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.claimManagedConversationCommands({
        runnerId: "runner-1",
        deviceId: "00000000-0000-4000-8000-000000000001",
        deploymentId: "00000000-0000-4000-8000-000000000002",
        limit: 8,
        leaseMs: 30_000
      })
    ).resolves.toEqual([]);

    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]!;
    expect(new URL(String(request[0])).pathname).toBe(
      "/v1/managed-conversation-runner/commands/claim"
    );
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      runnerId: "runner-1",
      limit: 8,
      leaseMs: 30_000
    });
  });

  it("keeps handoff path identity out of strict request bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/prepare")
            ? {
                handoff: { id: ids.handoff },
                manifest: { protocol: "test" },
                sourceOriginKeyId: "source-key"
              }
            : { handoff: { id: ids.handoff } }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.prepareManagedConversationHandoff(
      { userId: "local-owner-is-not-forwarded" },
      {
        handoffId: ids.handoff,
        expectedStateVersion: 1,
        runnerId: "runner-1",
        providerArtifactRelativePath: "sessions/source.jsonl",
        logicalSourceId: ids.source,
        sourceGenerationId: ids.generation,
        sourceClosureHash: "a".repeat(64),
        sourceEndByteCursor: 123,
        sourceEndItemCursor: 4,
        workspaceSnapshotId: ids.snapshot
      }
    );
    await client.attestManagedConversationHandoffSource(
      { userId: "local-owner-is-not-forwarded" },
      {
        handoffId: ids.handoff,
        expectedStateVersion: 3,
        sourceKeyId: "source-key",
        sourceSignature: "signature"
      }
    );

    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    ).not.toHaveProperty("handoffId");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedStateVersion: 1,
      runnerId: "runner-1",
      providerArtifactRelativePath: "sessions/source.jsonl",
      logicalSourceId: ids.source,
      sourceGenerationId: ids.generation,
      sourceClosureHash: "a".repeat(64),
      sourceEndByteCursor: 123,
      sourceEndItemCursor: 4,
      workspaceSnapshotId: ids.snapshot
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedStateVersion: 3,
      sourceKeyId: "source-key",
      sourceSignature: "signature"
    });
  });

  it("preserves bounded authority conflict codes for deterministic recovery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "Managed Conversation source closure is not exact",
            code: "managed_conversation_handoff_source_closure_conflict"
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" }
          }
        )
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.prepareManagedConversationHandoff(
        { userId: "local-owner-is-not-forwarded" },
        {
          handoffId: ids.handoff,
          expectedStateVersion: 1,
          runnerId: "runner-1",
          providerArtifactRelativePath: "sessions/source.jsonl",
          logicalSourceId: ids.source,
          sourceGenerationId: ids.generation,
          sourceClosureHash: "a".repeat(64),
          sourceEndByteCursor: 123,
          sourceEndItemCursor: 4,
          workspaceSnapshotId: ids.snapshot
        }
      )
    ).rejects.toMatchObject({
      name: "ManagedConversationAuthorityConflictError",
      code: "managed_conversation_handoff_source_closure_conflict"
    });
  });

  it("keeps fork path identity out of strict request bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/prepare-source")
            ? {
                fork: { id: ids.fork },
                manifest: { protocol: "test" },
                sourceOriginKeyId: "source-key"
              }
            : { fork: { id: ids.fork } }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.prepareManagedConversationForkSource(
      { userId: "local-owner-is-not-forwarded" },
      {
        forkId: ids.fork,
        expectedStateVersion: 1,
        runnerId: "runner-1",
        providerArtifactRelativePath: "sessions/source.jsonl",
        logicalSourceId: ids.source,
        sourceGenerationId: ids.generation,
        sourceClosureHash: "b".repeat(64),
        sourceEndByteCursor: 456,
        sourceEndItemCursor: 7,
        workspaceSnapshotId: ids.snapshot,
        parentLogicalSessionId: ids.session
      }
    );
    await client.attestManagedConversationForkSource(
      { userId: "local-owner-is-not-forwarded" },
      {
        forkId: ids.fork,
        expectedStateVersion: 2,
        sourceKeyId: "source-key",
        sourceSignature: "signature"
      }
    );

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedStateVersion: 1,
      runnerId: "runner-1",
      providerArtifactRelativePath: "sessions/source.jsonl",
      logicalSourceId: ids.source,
      sourceGenerationId: ids.generation,
      sourceClosureHash: "b".repeat(64),
      sourceEndByteCursor: 456,
      sourceEndItemCursor: 7,
      workspaceSnapshotId: ids.snapshot,
      parentLogicalSessionId: ids.session
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedStateVersion: 2,
      sourceKeyId: "source-key",
      sourceSignature: "signature"
    });
  });
});
