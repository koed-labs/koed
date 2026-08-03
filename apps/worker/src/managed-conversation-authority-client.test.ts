import { describe, expect, it, vi } from "vitest";

import { createManagedConversationAuthorityClient } from "./managed-conversation-authority-client.js";

describe("Managed Conversation authority client", () => {
  const ids = {
    handoff: "00000000-0000-4000-8000-000000000010",
    fork: "00000000-0000-4000-8000-000000000011",
    source: "00000000-0000-4000-8000-000000000012",
    generation: "00000000-0000-4000-8000-000000000013",
    snapshot: "00000000-0000-4000-8000-000000000014",
    session: "00000000-0000-4000-8000-000000000015"
  };

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
