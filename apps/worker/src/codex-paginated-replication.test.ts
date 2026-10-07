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
  conversationSourceRewriteGenerationId,
  createLocalTestKeyEnvelopeEncryptionProvider,
  generateConversationSourceReplicationOriginKeyPair,
  signConversationSourceReplicationManifest
} from "@koed/shared";
import { createConversationSourceReplicationService } from "./conversation-source-replication-service.js";

const timestamp = "2026-10-07T00:00:00.000Z";
const nativeId = "00000000-0000-4000-8000-000000000001";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (rows: unknown[]) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const event = (payload: unknown, ordinal: number) => ({
  timestamp,
  type: "event_msg",
  payload,
  ordinal
});
const completed = (
  id: string,
  type: "UserMessage" | "AgentMessage",
  text: string,
  ordinal: number,
  turn = "turn-1"
) =>
  event(
    {
      type: "item_completed",
      thread_id: nativeId,
      turn_id: turn,
      started_at_ms: null,
      completed_at_ms: Date.parse(timestamp),
      item: {
        id,
        type,
        content: [
          {
            type: type === "UserMessage" ? "text" : "Text",
            text,
            ...(type === "UserMessage" ? { text_elements: [] } : {})
          }
        ]
      }
    },
    ordinal
  );
const header = {
  timestamp,
  type: "session_meta",
  ordinal: 0,
  payload: { id: nativeId, history_mode: "paginated" }
};
const previous = [
  { timestamp, type: "session_meta", payload: { id: nativeId } },
  {
    timestamp,
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" }
  },
  {
    timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message: "Original prompt",
      text_elements: []
    }
  },
  {
    timestamp,
    type: "event_msg",
    payload: { type: "agent_message", message: "Original answer", phase: null }
  },
  {
    timestamp,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1" }
  }
];
const migrated = [
  header,
  event({ type: "task_started", turn_id: "turn-1" }, 1),
  completed("item-1", "UserMessage", "Original prompt", 2),
  completed("item-2", "AgentMessage", "Original answer", 3),
  event({ type: "task_complete", turn_id: "turn-1" }, 4)
];
const continuationHeader = {
  ...header,
  ordinal: 2,
  payload: {
    ...header.payload,
    history_base: {
      thread_id: nativeId,
      end_ordinal_exclusive: 2,
      end_byte_offset: encode(migrated.slice(0, 2)).length
    }
  }
};

const normalizedHistory = (crossLogical: boolean) => {
  const ancestorId = crossLogical
    ? "00000000-0000-4000-8000-000000000004"
    : nativeId;
  const ancestorRows = migrated.map((row, index) =>
    index === 0
      ? { ...row, payload: { ...header.payload, id: ancestorId } }
      : (row.payload as Record<string, unknown>).type === "item_completed"
        ? {
            ...row,
            payload: {
              ...(row.payload as Record<string, unknown>),
              thread_id: ancestorId
            }
          }
        : row
  );
  const parentHeader = {
    ...header,
    ordinal: 3,
    payload: {
      ...header.payload,
      ...(crossLogical
        ? { forked_from_id: ancestorId, forked_from_ordinal_exclusive: 3 }
        : {}),
      history_base: {
        thread_id: ancestorId,
        end_ordinal_exclusive: 3,
        end_byte_offset: encode(ancestorRows.slice(0, 3)).length
      }
    }
  };
  const replacement = {
    ...parentHeader,
    ordinal: 2,
    payload: {
      ...parentHeader.payload,
      ...(crossLogical ? { forked_from_ordinal_exclusive: 2 } : {}),
      history_base: {
        thread_id: ancestorId,
        end_ordinal_exclusive: 2,
        end_byte_offset: encode(ancestorRows.slice(0, 2)).length
      }
    }
  };
  return {
    ancestorId,
    ancestorRows,
    parentRows: [
      parentHeader,
      event({ type: "task_started", turn_id: "retained-turn" }, 4)
    ],
    replacement
  };
};

const fixture = async (input: {
  rows: unknown[];
  journalStart?: number;
  ownBoundary?: number;
  migration?: boolean;
  continuation?: boolean;
  pendingParent?: boolean;
  normalized?: "same" | "fork";
  pendingAncestor?: boolean;
}) => {
  const ownerUserId = randomUUID();
  const sessionId = randomUUID();
  const logicalSourceId = randomUUID();
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 13).toString("base64")
  );
  const parentGeneration = randomUUID();
  const normalized = input.normalized
    ? normalizedHistory(input.normalized === "fork")
    : null;
  const ancestorGeneration = randomUUID();
  const parentRows =
    normalized?.parentRows ?? (input.continuation ? migrated : previous);
  const prefixRows = normalized
    ? [normalized.replacement]
    : input.continuation
      ? [continuationHeader]
      : migrated;
  const prefix = encode(prefixRows);
  const transformed = input.migration || input.continuation || input.normalized;
  const generation = transformed
    ? conversationSourceRewriteGenerationId(parentGeneration, sha(prefix))
    : randomUUID();
  const keys = generateConversationSourceReplicationOriginKeyPair();
  const prior = transformed
    ? {
        sourceGenerationId: parentGeneration,
        contentDigest: "1".repeat(64),
        closedAt: timestamp
      }
    : null;
  const bytes = encode(input.rows);
  const artifact = {
    id: randomUUID(),
    ownerUserId,
    sessionId,
    logicalSourceId,
    sourceGenerationId: generation,
    sourceComponentId: "main",
    sourceComponentRole: "primary",
    parentSourceComponentId: null,
    contentFraming: "jsonl",
    replicaRole: "hosted_personal",
    sourceKind: "codex",
    sourceRuntime: "codex-cli",
    externalSessionId: logicalSourceId,
    sourceFingerprint: sha(Buffer.from(nativeId)),
    sourceAdapterVersion: "codex-transcript-v2",
    artifactFormat: "codex_rollout_jsonl",
    artifactFormatVersion: 1,
    journalStartOffset: input.journalStart ?? 0,
    journalStartLine: input.journalStart ? 1 : 0,
    liveStartOffset: transformed ? prefix.length : (input.journalStart ?? 0),
    liveStartLine: transformed ? prefixRows.length : input.journalStart ? 1 : 0,
    providerCursorOffset: (input.journalStart ?? 0) + bytes.length,
    providerCursorLine: input.rows.length + (input.journalStart ? 1 : 0),
    priorGenerationClosure: prior,
    redactedSourceLabel: input.normalized
      ? `rollout-fixture-${nativeId}_00000000-0000-4000-8000-000000000003.jsonl`
      : input.continuation
        ? `rollout-fixture-${nativeId}_00000000-0000-4000-8000-000000000002.jsonl`
        : "rollout.jsonl",
    originDeploymentId: randomUUID(),
    originDeviceId: randomUUID(),
    originKeyId: keys.originKeyId,
    originPublicKey: keys.publicKeyBase64url,
    sourceCreatedAt: timestamp,
    lifecycle: "active"
  } as ConversationSourceArtifactRecord;
  const parent = {
    ...artifact,
    id: randomUUID(),
    sourceGenerationId: parentGeneration,
    sourceAdapterVersion:
      input.continuation || input.normalized
        ? "codex-transcript-v2"
        : "codex-transcript-v1",
    journalStartOffset: 0,
    journalStartLine: 0,
    priorGenerationClosure:
      input.normalized === "same"
        ? {
            sourceGenerationId: ancestorGeneration,
            contentDigest: "2".repeat(64),
            closedAt: timestamp
          }
        : null,
    providerCursorOffset: encode(parentRows).length,
    providerCursorLine: parentRows.length,
    redactedSourceLabel: input.normalized
      ? `rollout-fixture-${nativeId}_00000000-0000-4000-8000-000000000002.jsonl`
      : input.continuation
        ? `rollout-fixture-${nativeId}.jsonl`
        : "rollout.jsonl",
    closureHash: "1".repeat(64),
    lifecycle: "finalized"
  } as ConversationSourceArtifactRecord;
  const ancestor = normalized
    ? ({
        ...parent,
        id: randomUUID(),
        sourceGenerationId: ancestorGeneration,
        logicalSourceId:
          input.normalized === "fork" ? randomUUID() : logicalSourceId,
        sessionId: input.normalized === "fork" ? randomUUID() : sessionId,
        externalSessionId: normalized.ancestorId,
        priorGenerationClosure: null,
        redactedSourceLabel: `rollout-fixture-${normalized.ancestorId}.jsonl`,
        providerCursorOffset: encode(normalized.ancestorRows).length,
        providerCursorLine: normalized.ancestorRows.length,
        closureHash: "2".repeat(64)
      } as ConversationSourceArtifactRecord)
    : null;
  const makeSegment = async (
    source: ConversationSourceArtifactRecord,
    contents: Buffer
  ) => {
    const signed = signConversationSourceReplicationManifest(
      {
        protocol: "koed.conversation-source-replication/v1",
        sourceComponentSchemaVersion: 1,
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        parentSourceComponentId: null,
        contentFraming: "jsonl",
        logicalSourceId: source.logicalSourceId,
        sourceGenerationId: source.sourceGenerationId,
        originKeyId: keys.originKeyId,
        segmentIndex: 0,
        startByteCursor: source.journalStartOffset,
        endByteCursor: source.journalStartOffset + contents.length,
        startItemCursor: source.journalStartLine,
        endItemCursor: source.providerCursorLine,
        previousContentDigest: null,
        plaintextDigest: sha(contents),
        sourceFormat: "codex_rollout_jsonl",
        adapterVersion: source.sourceAdapterVersion,
        sourceCreatedAt: timestamp,
        priorGenerationClosure: source.priorGenerationClosure as typeof prior
      },
      keys.privateKey
    );
    const encryptionEnvelope = await provider.encrypt({
      plaintext: JSON.stringify({
        signedManifest: signed,
        plaintextBytes: contents.toString("base64url")
      }),
      scope: { tenantId: ownerUserId },
      provenance: {
        rowFamily: "conversation_source_segments",
        sourceId: source.sourceGenerationId
      },
      ciphertextLocation: "conversation_source_segments.encryption_envelope",
      aad: { ownerUserId }
    });
    return {
      id: randomUUID(),
      artifactId: source.id,
      segmentIndex: 0,
      sourceStartOffset: source.journalStartOffset,
      sourceEndOffset: source.journalStartOffset + contents.length,
      sourceStartLine: source.journalStartLine,
      sourceEndLine: source.providerCursorLine,
      plaintextDigest: sha(contents),
      plaintextSize: contents.length,
      ciphertextDigest: null,
      storedSize: JSON.stringify(encryptionEnvelope).length,
      storageKey: "unused",
      storageProvider: "envelope_db",
      contentDigest:
        calculateConversationSourceReplicationContentDigest(signed),
      encryptionEnvelope,
      signedManifest: { ...signed.manifest },
      originSignature: signed.signature,
      manifestDigest: calculateConversationSourceReplicationManifestDigest(
        signed.manifest
      ),
      previousContentDigest: null,
      createdAt: timestamp,
      sealedAt: timestamp
    } as unknown as ConversationSourceSegmentRecord;
  };
  const segments = new Map([
    [artifact.id, await makeSegment(artifact, bytes)],
    [parent.id, await makeSegment(parent, encode(parentRows))]
  ]);
  if (ancestor && normalized)
    segments.set(
      ancestor.id,
      await makeSegment(ancestor, encode(normalized.ancestorRows))
    );
  let cursor: {
    sourceOffset: number;
    sourceLine: number;
    parserState: Record<string, unknown>;
  } | null = null;
  const createConversationItems = vi.fn().mockResolvedValue([]);
  const advance = vi.fn().mockImplementation(async (_actor, value) => {
    cursor = { ...value };
    return cursor;
  });
  const failure = vi.fn().mockResolvedValue({});
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
    getConversationSourceConsumerCursor: vi
      .fn()
      .mockImplementation(async (_actor, { artifactId }) =>
        ancestor && artifactId === ancestor.id
          ? input.pendingAncestor
            ? null
            : { sourceOffset: ancestor.providerCursorOffset }
          : artifactId === parent.id
            ? input.pendingParent
              ? null
              : { sourceOffset: parent.providerCursorOffset }
            : cursor
      ),
    getConversationSourceArtifactByGeneration: vi
      .fn()
      .mockImplementation(async (_actor, generationId) =>
        generationId === parent.sourceGenerationId
          ? parent
          : generationId === ancestor?.sourceGenerationId
            ? ancestor
            : null
      ),
    getConversationSourceArtifactByCodexThreadIdentity: vi
      .fn()
      .mockResolvedValue(ancestor),
    listConversationSourceSegments: vi
      .fn()
      .mockImplementation(async (_actor, { artifactId, afterOffset }) => {
        const segment = segments.get(artifactId)!;
        return segment.sourceEndOffset > afterOffset ? [segment] : [];
      }),
    getCapturedSession: vi.fn().mockResolvedValue({
      id: sessionId,
      logicalSessionId: randomUUID(),
      metadata: {
        codexHistory: {
          historyMode: "paginated",
          externalThreadId: nativeId,
          threadKind:
            input.ownBoundary !== undefined ? "subagent" : "conversation",
          subagentHistoryStartOrdinal: input.ownBoundary ?? null
        }
      }
    }),
    createCapturedSession: vi.fn().mockResolvedValue({ id: sessionId }),
    createConversationItems,
    advanceConversationSourceConsumerCursor: advance,
    recordConversationSourceConsumerFailure: failure
  } as unknown as MemorySourceRepository;
  const service = createConversationSourceReplicationService({
    repository,
    koedHome: "/unused",
    envelopeEncryptionProvider: provider,
    wakePool: {} as never,
    logger: { info: vi.fn(), warn: vi.fn() }
  });
  return { service, artifact, createConversationItems, advance, failure };
};

describe("paginated Codex device materialization", () => {
  it.each(["same", "fork"] as const)(
    "materializes only new activity after a normalized %s ancestry revert",
    async (kind) => {
      const history = normalizedHistory(kind === "fork");
      const f = await fixture({
        normalized: kind,
        rows: [
          history.replacement,
          completed(
            "future-user",
            "UserMessage",
            "After normalized revert",
            3,
            "future-turn"
          )
        ]
      });
      await f.service.processOnce();
      expect(f.failure).not.toHaveBeenCalled();
      expect(f.createConversationItems).not.toHaveBeenCalled();
      expect(f.advance.mock.calls[0]![1].parserState.lastRecordOrdinal).toBe(2);
      await f.service.processOnce();
      expect(f.createConversationItems.mock.calls[0]![1].items).toHaveLength(1);
      expect(f.createConversationItems.mock.calls[0]![1].items[0].rawText).toBe(
        "After normalized revert"
      );
    }
  );
  it("leaves normalized ancestry pending without a fully materialized signed ancestor", async () => {
    const f = await fixture({
      normalized: "fork",
      pendingAncestor: true,
      rows: [normalizedHistory(true).replacement]
    });
    await f.service.processOnce();
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.createConversationItems).not.toHaveBeenCalled();
    expect(f.failure).toHaveBeenCalled();
  });
  it("retains the signed predecessor and captures only new activity after a native revert", async () => {
    const f = await fixture({
      continuation: true,
      rows: [
        continuationHeader,
        completed(
          "future-user",
          "UserMessage",
          "After revert",
          3,
          "future-turn"
        )
      ]
    });
    await f.service.processOnce();
    expect(f.createConversationItems).not.toHaveBeenCalled();
    expect(f.advance.mock.calls[0]![1].parserState.lastRecordOrdinal).toBe(2);
    await f.service.processOnce();
    const items = f.createConversationItems.mock.calls[0]![1].items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      rawText: "After revert",
      externalThreadId: nativeId,
      canonicalStableItemId: "future-user"
    });
    expect(f.failure).not.toHaveBeenCalled();
  });
  it("uses native thread identity on a hosted device and keeps model context raw-only", async () => {
    const f = await fixture({
      rows: [
        ...migrated,
        {
          timestamp,
          type: "response_item",
          ordinal: 5,
          payload: {
            type: "message",
            role: "assistant",
            id: "different-response-id",
            content: [{ type: "output_text", text: "Original answer" }]
          }
        }
      ]
    });
    expect((await f.service.processOnce()).materialized).toBe(1);
    const items = f.createConversationItems.mock.calls[0]![1].items;
    expect(
      items.filter(
        (item: { rawText?: string; projectionStatus: string }) =>
          item.projectionStatus === "pending" &&
          ["Original prompt", "Original answer"].includes(item.rawText ?? "")
      )
    ).toHaveLength(2);
    expect(f.advance.mock.calls[0]![1].parserState.historyMode).toBe(
      "paginated"
    );
    expect(f.failure).not.toHaveBeenCalled();
  });
  it("honors inherited subagent boundaries even when capture does not include the header", async () => {
    const f = await fixture({
      journalStart: 100,
      ownBoundary: 3,
      rows: [
        completed("ancestor", "UserMessage", "Inherited", 2),
        completed("own", "AgentMessage", "Own result", 3)
      ]
    });
    expect((await f.service.processOnce()).materialized).toBe(1);
    const items = f.createConversationItems.mock.calls[0]![1].items;
    expect(
      items.filter(
        (item: { rawText?: string; projectionStatus: string }) =>
          item.projectionStatus === "pending" && item.rawText === "Own result"
      )
    ).toHaveLength(1);
    expect(
      items.some(
        (item: { rawText?: string; projectionStatus: string }) =>
          item.projectionStatus === "pending" && item.rawText === "Inherited"
      )
    ).toBe(false);
    expect(
      f.advance.mock.calls[0]![1].parserState.subagentHistoryStartOrdinal
    ).toBe(3);
  });
  it("retains a migrated prefix as evidence and projects only subsequent activity", async () => {
    const f = await fixture({
      migration: true,
      rows: [
        ...migrated,
        event({ type: "task_started", turn_id: "turn-2" }, 5),
        completed("new-answer", "AgentMessage", "New answer", 6, "turn-2"),
        event({ type: "task_complete", turn_id: "turn-2" }, 7)
      ]
    });
    expect((await f.service.processOnce()).materialized).toBe(1);
    expect(f.createConversationItems).not.toHaveBeenCalled();
    expect((await f.service.processOnce()).materialized).toBe(1);
    expect(
      f.createConversationItems.mock.calls[0]![1].items.filter(
        (item: { rawText?: string; projectionStatus: string }) =>
          item.projectionStatus === "pending" && item.rawText === "New answer"
      )
    ).toHaveLength(1);
    expect(f.failure).not.toHaveBeenCalled();
  });
  it("waits for the predecessor instead of losing or duplicating prior Memory", async () => {
    const f = await fixture({
      migration: true,
      pendingParent: true,
      rows: migrated
    });
    expect((await f.service.processOnce()).materialized).toBe(0);
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.failure.mock.calls[0]![1].errorCode).toBe(
      "SourceReplicationPredecessorPendingError"
    );
  });
  it("refuses altered migration evidence without advancing its cursor", async () => {
    const f = await fixture({
      migration: true,
      rows: [
        header,
        migrated[1],
        completed("item-1", "UserMessage", "Altered prompt", 2),
        ...migrated.slice(3)
      ]
    });
    expect((await f.service.processOnce()).materialized).toBe(0);
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.createConversationItems).not.toHaveBeenCalled();
    expect(f.failure).toHaveBeenCalledOnce();
  });
});
