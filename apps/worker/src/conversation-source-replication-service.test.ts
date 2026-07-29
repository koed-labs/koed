import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationSourceArtifactRecord,
  ConversationSourceSegmentRecord,
  MemorySourceRepository
} from "@koed/db";
import {
  calculateConversationSourceReplicationContentDigest,
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  createLocalTestKeyEnvelopeEncryptionProvider,
  generateConversationSourceReplicationOriginKeyPair,
  signConversationSourceReplicationManifest
} from "@koed/shared";
import { createConversationSourceReplicationService } from "./conversation-source-replication-service.js";

const digest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

describe("conversation source replication materialization", () => {
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
        payload: { id: "replicated-thread", cwd: "/workspace/project" }
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
      contentDigest:
        calculateConversationSourceReplicationContentDigest(signedManifest),
      encryptionEnvelope
    } as ConversationSourceSegmentRecord;
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
