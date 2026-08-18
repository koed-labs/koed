import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationSourceArtifactRecord,
  ConversationSourceSegmentRecord,
  MemorySourceRepository
} from "@koed/db";
import {
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  createLocalTestKeyEnvelopeEncryptionProvider,
  generateConversationSourceReplicationOriginKeyPair,
  signConversationSourceReplicationManifest
} from "@koed/shared";
import { createConversationSourceReplicationService } from "./conversation-source-replication-service.js";

const digest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const buildClaudeSourceSetFixture = async (options?: {
  failAuxiliaryOnce?: boolean;
  mutateAuxiliaryPayload?: boolean;
}) => {
  const ownerUserId = randomUUID();
  const sessionId = randomUUID();
  const logicalSourceId = randomUUID();
  const sourceGenerationId = randomUUID();
  const keys = generateConversationSourceReplicationOriginKeyPair();
  const timestamp = "2026-08-11T12:00:00.000Z";
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 9).toString("base64")
  );
  const componentInputs = [
    {
      id: "main",
      role: "primary" as const,
      parent: null,
      actor: "user",
      text: "Delegate this investigation."
    },
    {
      id: "subagent.researcher",
      role: "auxiliary" as const,
      parent: "main",
      actor: "assistant",
      text: "Auxiliary result."
    }
  ];
  const artifacts: ConversationSourceArtifactRecord[] = [];
  const segments = new Map<string, ConversationSourceSegmentRecord>();
  for (const [index, component] of componentInputs.entries()) {
    const record = {
      uuid: randomUUID(),
      timestamp,
      type: component.actor,
      ...(component.id === "main" ? {} : { isSidechain: true }),
      message: {
        role: component.actor,
        content: [{ type: "text", text: component.text }]
      }
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    const signedManifest = signConversationSourceReplicationManifest(
      {
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        sourceComponentSchemaVersion: 1,
        sourceComponentId: component.id,
        sourceComponentRole: component.role,
        parentSourceComponentId: component.parent,
        contentFraming: "jsonl",
        logicalSourceId,
        sourceGenerationId,
        originKeyId: keys.originKeyId,
        segmentIndex: 0,
        startByteCursor: 0,
        endByteCursor: bytes.byteLength,
        startItemCursor: 0,
        endItemCursor: 1,
        previousContentDigest: null,
        plaintextDigest: digest(bytes),
        sourceFormat: "claude_session_jsonl",
        adapterVersion: "claude-code-transcript-v1",
        sourceCreatedAt: timestamp,
        priorGenerationClosure: null
      },
      keys.privateKey
    );
    const payloadBytes =
      options?.mutateAuxiliaryPayload && component.role === "auxiliary"
        ? Buffer.from(`${JSON.stringify({ ...record, uuid: randomUUID() })}\n`)
        : bytes;
    const artifact = {
      id: randomUUID(),
      ownerUserId,
      sessionId,
      logicalSourceId,
      sourceGenerationId,
      sourceComponentId: component.id,
      sourceComponentRole: component.role,
      parentSourceComponentId: component.parent,
      contentFraming: "jsonl",
      replicaRole: "hosted_personal",
      sourceKind: "claude-code",
      sourceRuntime: "claude-code",
      externalSessionId: "claude-replicated-thread",
      sourceFingerprint: digest(Buffer.from(component.id)),
      artifactFormat: "claude_session_jsonl",
      artifactFormatVersion: 1,
      sourceAdapterVersion: "claude-code-transcript-v1",
      journalStartOffset: 0,
      journalStartLine: 0,
      lifecycle: "active"
    } as ConversationSourceArtifactRecord;
    artifacts.push(artifact);
    const encryptionEnvelope = await provider.encrypt({
      plaintext: JSON.stringify({
        signedManifest,
        plaintextBytes: payloadBytes.toString("base64url")
      }),
      scope: { tenantId: ownerUserId },
      provenance: {
        rowFamily: "conversation_source_segments",
        sourceId: `${sourceGenerationId}:${component.id}`
      },
      ciphertextLocation: "conversation_source_segments.encryption_envelope",
      aad: { ownerUserId, sourceGenerationId, component: component.id }
    });
    segments.set(artifact.id, {
      id: randomUUID(),
      artifactId: artifact.id,
      segmentIndex: 0,
      sourceStartOffset: 0,
      sourceEndOffset: bytes.byteLength,
      sourceStartLine: 0,
      sourceEndLine: 1,
      plaintextDigest: digest(bytes),
      ciphertextDigest: null,
      plaintextSize: bytes.byteLength,
      storedSize: Buffer.byteLength(JSON.stringify(encryptionEnvelope), "utf8"),
      storageKey: `${logicalSourceId}/${sourceGenerationId}/${component.id}/0`,
      storageProvider: "envelope_db",
      contentDigest:
        calculateConversationSourceReplicationContentDigest(signedManifest),
      encryptionEnvelope: encryptionEnvelope as unknown as Record<
        string,
        unknown
      >,
      signedManifest: { ...signedManifest.manifest },
      originSignature: signedManifest.signature,
      manifestDigest: calculateConversationSourceReplicationManifestDigest(
        signedManifest.manifest
      ),
      previousContentDigest: null,
      createdAt: timestamp,
      sealedAt: timestamp
    });
    void index;
  }
  const cursors = new Map<
    string,
    { sourceOffset: number; sourceLine: number; retryCount: number }
  >();
  let auxiliaryFailures = 0;
  const createConversationItems = vi.fn(async (_actor, input) => {
    const componentId = input.items[0]?.metadata?.sourceComponentId;
    if (
      options?.failAuxiliaryOnce &&
      componentId === "subagent.researcher" &&
      auxiliaryFailures++ === 0
    ) {
      throw new Error("transient materialization failure");
    }
    return [];
  });
  const recordConversationSourceConsumerFailure = vi.fn(
    async (_actor, input) => {
      const prior = cursors.get(input.artifactId);
      cursors.set(input.artifactId, {
        sourceOffset: prior?.sourceOffset ?? 0,
        sourceLine: prior?.sourceLine ?? 0,
        retryCount: (prior?.retryCount ?? 0) + 1
      });
    }
  );
  const repository = {
    claimConversationSourceRestoreJobs: vi.fn().mockResolvedValue([]),
    listConversationSourceReplicationActors: vi
      .fn()
      .mockImplementation(({ direction }) =>
        Promise.resolve(
          direction === "materialize" ? [{ userId: ownerUserId }] : []
        )
      ),
    listConversationSourceArtifactsForDownload: vi
      .fn()
      .mockResolvedValue(artifacts),
    getConversationSourceConsumerCursor: vi.fn(
      async (_actor, input) => cursors.get(input.artifactId) ?? null
    ),
    listConversationSourceSegments: vi.fn(async (_actor, input) => {
      const segment = segments.get(input.artifactId);
      return segment && input.afterOffset < segment.sourceEndOffset
        ? [segment]
        : [];
    }),
    getCapturedSession: vi.fn().mockResolvedValue({
      id: sessionId,
      logicalSessionId: randomUUID(),
      externalSessionId: "claude-replicated-thread",
      project: null
    }),
    createCapturedSession: vi.fn().mockResolvedValue({ id: sessionId }),
    createConversationItems,
    advanceConversationSourceConsumerCursor: vi.fn(async (_actor, input) => {
      cursors.set(input.artifactId, {
        sourceOffset: input.sourceOffset,
        sourceLine: input.sourceLine,
        retryCount: 0
      });
      return {};
    }),
    recordConversationSourceConsumerFailure
  } as unknown as MemorySourceRepository;
  const service = createConversationSourceReplicationService({
    repository,
    koedHome: "/unused",
    envelopeEncryptionProvider: provider,
    wakePool: {} as never,
    logger: { info: vi.fn(), warn: vi.fn() }
  });
  return {
    service,
    repository,
    createConversationItems,
    recordConversationSourceConsumerFailure
  };
};

describe("conversation source replication materialization", () => {
  it("materializes the complete Claude primary and auxiliary source set", async () => {
    const fixture = await buildClaudeSourceSetFixture();

    await expect(fixture.service.processOnce()).resolves.toMatchObject({
      materialized: 2
    });
    expect(fixture.createConversationItems).toHaveBeenCalledTimes(2);
    expect(
      fixture.createConversationItems.mock.calls.map(
        (call) => call[1].items[0]?.metadata?.sourceComponentId
      )
    ).toEqual(["main", "subagent.researcher"]);
  });

  it("retries only the failed Claude auxiliary component", async () => {
    const fixture = await buildClaudeSourceSetFixture({
      failAuxiliaryOnce: true
    });

    await expect(fixture.service.processOnce()).resolves.toMatchObject({
      materialized: 1
    });
    await expect(fixture.service.processOnce()).resolves.toMatchObject({
      materialized: 1
    });
    expect(fixture.createConversationItems).toHaveBeenCalledTimes(3);
    expect(
      fixture.recordConversationSourceConsumerFailure
    ).toHaveBeenCalledOnce();
  });

  it("rejects a mutated Claude auxiliary payload without advancing it", async () => {
    const fixture = await buildClaudeSourceSetFixture({
      mutateAuxiliaryPayload: true
    });

    await expect(fixture.service.processOnce()).resolves.toMatchObject({
      materialized: 1
    });
    expect(
      fixture.recordConversationSourceConsumerFailure
    ).toHaveBeenCalledOnce();
    expect(
      fixture.repository.advanceConversationSourceConsumerCursor
    ).toHaveBeenCalledOnce();
  });

  it("advances the replica cursor with the verified plaintext digest", async () => {
    const ownerUserId = randomUUID();
    const sessionId = randomUUID();
    const logicalSourceId = randomUUID();
    const sourceGenerationId = randomUUID();
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const timestamp = "2026-07-27T03:00:00.000Z";
    const records = [
      {
        timestamp,
        type: "session_meta",
        payload: {
          id: "replicated-thread",
          cwd: "/workspace/project",
          originator: "sensitive-source-originator",
          agent_nickname: "sensitive-agent-name"
        }
      },
      {
        timestamp,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" }
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Replicate this turn." }]
        }
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          id: "assistant-message-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Replicated." }]
        }
      },
      {
        timestamp,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" }
      }
    ];
    const bytes = Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    );
    const plaintextDigest = digest(bytes);
    const signedManifest = signConversationSourceReplicationManifest(
      {
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        sourceComponentSchemaVersion: 1,
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        parentSourceComponentId: null,
        contentFraming: "jsonl",
        logicalSourceId,
        sourceGenerationId,
        originKeyId: keys.originKeyId,
        segmentIndex: 0,
        startByteCursor: 0,
        endByteCursor: bytes.byteLength,
        startItemCursor: 0,
        endItemCursor: records.length,
        previousContentDigest: null,
        plaintextDigest,
        sourceFormat: "codex_rollout_jsonl",
        adapterVersion: "codex-transcript-v1",
        sourceCreatedAt: timestamp,
        priorGenerationClosure: null
      },
      keys.privateKey
    );
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 7).toString("base64")
    );
    const encryptionEnvelope = await provider.encrypt({
      plaintext: JSON.stringify({
        signedManifest,
        plaintextBytes: bytes.toString("base64url")
      }),
      scope: { tenantId: ownerUserId },
      provenance: {
        rowFamily: "conversation_source_segments",
        sourceId: sourceGenerationId
      },
      ciphertextLocation: "conversation_source_segments.encryption_envelope",
      aad: {
        ownerUserId,
        logicalSourceId,
        sourceGenerationId,
        segmentIndex: 0
      }
    });
    const artifact = {
      id: randomUUID(),
      ownerUserId,
      sessionId,
      logicalSourceId,
      sourceGenerationId,
      replicaRole: "hosted_personal",
      externalSessionId: "replicated-thread",
      sourceFingerprint: digest(Buffer.from("replicated-thread")),
      journalStartOffset: 0,
      journalStartLine: 0,
      lifecycle: "active"
    } as ConversationSourceArtifactRecord;
    const segment = {
      id: randomUUID(),
      artifactId: artifact.id,
      segmentIndex: 0,
      sourceStartOffset: 0,
      sourceEndOffset: bytes.byteLength,
      sourceStartLine: 0,
      sourceEndLine: records.length,
      plaintextDigest,
      ciphertextDigest: null,
      plaintextSize: bytes.byteLength,
      storedSize: Buffer.byteLength(JSON.stringify(encryptionEnvelope), "utf8"),
      storageKey: `${logicalSourceId}/${sourceGenerationId}/0`,
      storageProvider: "envelope_db",
      contentDigest:
        calculateConversationSourceReplicationContentDigest(signedManifest),
      encryptionEnvelope: encryptionEnvelope as unknown as Record<
        string,
        unknown
      >,
      signedManifest: { ...signedManifest.manifest },
      originSignature: signedManifest.signature,
      manifestDigest: calculateConversationSourceReplicationManifestDigest(
        signedManifest.manifest
      ),
      previousContentDigest: null,
      createdAt: timestamp,
      sealedAt: timestamp
    } satisfies ConversationSourceSegmentRecord;
    const createConversationItems = vi.fn().mockResolvedValue([]);
    const createCapturedSession = vi.fn().mockResolvedValue({
      id: sessionId
    });
    const advanceConversationSourceConsumerCursor = vi
      .fn()
      .mockResolvedValue({});
    const repository = {
      claimConversationSourceRestoreJobs: vi.fn().mockResolvedValue([]),
      listConversationSourceReplicationActors: vi
        .fn()
        .mockImplementation(({ direction }) =>
          Promise.resolve(
            direction === "materialize" ? [{ userId: ownerUserId }] : []
          )
        ),
      listConversationSourceArtifactsForDownload: vi
        .fn()
        .mockResolvedValue([artifact]),
      getConversationSourceConsumerCursor: vi.fn().mockResolvedValue(null),
      listConversationSourceSegments: vi.fn().mockResolvedValue([segment]),
      getCapturedSession: vi.fn().mockResolvedValue({
        id: sessionId,
        logicalSessionId: randomUUID(),
        externalSessionId: "replicated-thread",
        project: {
          id: "lp_0123456789abcdef0123456789abcdef",
          name: "Project",
          path: null
        }
      }),
      createCapturedSession,
      createConversationItems,
      advanceConversationSourceConsumerCursor
    } as unknown as MemorySourceRepository;
    const service = createConversationSourceReplicationService({
      repository,
      koedHome: "/unused",
      envelopeEncryptionProvider: provider,
      wakePool: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn()
      }
    });

    await expect(service.processOnce()).resolves.toEqual({
      uploaded: 0,
      restored: 0,
      materialized: 1
    });
    expect(createConversationItems).toHaveBeenCalledOnce();
    expect(createCapturedSession).toHaveBeenCalledWith(
      { userId: ownerUserId },
      expect.objectContaining({
        externalSessionId: "replicated-thread",
        model: undefined,
        metadata: expect.objectContaining({
          sourceDeviceCwdObserved: true,
          sourceTransport: "replicated_transcript"
        })
      })
    );
    expect(
      createCapturedSession.mock.calls[0]?.[1]?.metadata
    ).not.toHaveProperty("cwd");
    expect(
      createCapturedSession.mock.calls[0]?.[1]?.metadata
    ).not.toHaveProperty("id");
    expect(
      createCapturedSession.mock.calls[0]?.[1]?.metadata
    ).not.toHaveProperty("originator");
    expect(
      createCapturedSession.mock.calls[0]?.[1]?.metadata
    ).not.toHaveProperty("agent_nickname");
    expect(advanceConversationSourceConsumerCursor).toHaveBeenCalledWith(
      { userId: ownerUserId },
      expect.objectContaining({
        artifactId: artifact.id,
        consumerKind: "remote_processing",
        expectedSourceOffset: 0,
        sourceOffset: bytes.byteLength,
        sourceLine: records.length,
        segmentIndex: 0,
        lastVerifiedDigest: plaintextDigest
      })
    );
  });
});
