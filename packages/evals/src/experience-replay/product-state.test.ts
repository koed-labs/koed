import { describe, expect, it, vi } from "vitest";
import type {
  CapturedSessionRecord,
  ConversationItemRecord,
  EmbeddableSourceRecord,
  LcmGraphEvent,
  LcmGraphNode,
  LcmGraphNodeDetail,
  MemorySourceRepository
} from "@koed/db";
import type { MemorySearchResult, RetrievalMetadata } from "@koed/core";
import {
  awaitExperienceReplayProductState,
  createProductionNormalizedImportClient,
  type ProductStateReadinessOptions
} from "./product-state.js";

type ProductStateRepository = ProductStateReadinessOptions["repository"];

const actor = { userId: "user-a" };
const session: CapturedSessionRecord = {
  id: "session-a",
  logicalSessionId: "logical-session-a",
  ownerUserId: "user-a",
  visibility: "personal",
  externalSessionId: null,
  forkedFromExternalThreadId: null,
  sourceRuntime: "codex",
  captureMethod: "api",
  model: null,
  cwd: "/project-a",
  sourceKind: "codex",
  sourceAdapterVersion: "koed-normalized-import-v1",
  sourceFingerprint: null,
  capturedProject: {},
  importObservedAt: null,
  metadata: {},
  capturedProjectProvenance: {},
  automaticProject: null,
  projectOverride: null,
  project: { id: "/project-a", name: "project-a", path: "/project-a" },
  projectAssignmentSource: "detected",
  projectAssignmentUpdatedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z"
};
const item: ConversationItemRecord = {
  id: "item-a",
  canonicalItemKey: "item-key-a",
  sessionId: "session-a",
  turnId: null,
  canonicalStableItemId: "stable-a",
  sourceKind: "codex",
  sourceAdapterVersion: "koed-normalized-import-v1",
  sourceTransport: "normalized_import",
  externalSessionId: null,
  externalThreadId: null,
  externalTurnId: null,
  externalItemId: null,
  sourceRecordType: "normalized_import_item",
  sourceEventType: "user_message",
  sourceSequence: 0,
  idempotencyKey: "item-idempotency-a",
  observedAt: "2026-08-12T00:00:00.000Z",
  importObservedAt: "2026-08-12T00:00:00.000Z",
  sourceFingerprint: null,
  capturedProject: {},
  createdAt: "2026-08-12T00:00:00.000Z"
};
const event: LcmGraphEvent = {
  id: "event-a",
  actor: "user",
  eventType: "user_message",
  sourceRuntime: "codex",
  captureMethod: "api",
  model: null,
  sessionId: "session-a",
  projectId: "/project-a",
  projectName: "project-a",
  projectPath: "/project-a",
  threadId: null,
  threadName: null,
  timestamp: "2026-08-12T00:00:00.000Z",
  sourceEventTime: null,
  sourceSequence: 0,
  capturedAt: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-12T00:00:00.000Z",
  visibility: "personal",
  invalidatedAt: null,
  invalidationReason: null,
  contentPreview: "semantic source",
  metadata: {
    includeInEmbedding: true,
    includeInLcm: true,
    projectionPolicyKey: "normalized-user-message",
    projectionPolicyRevision: 1
  },
  linkedNodeIds: ["node-a"]
};
const node: LcmGraphNode = {
  id: "node-a",
  kind: "leaf",
  depth: 0,
  summaryText: "semantic source",
  sessionId: "session-a",
  summaryStatus: "summarized",
  summaryModel: "lcm-model",
  visibility: "personal",
  ownerUserId: "user-a",
  projectId: "/project-a",
  projectName: "project-a",
  projectPath: "/project-a",
  threadId: null,
  threadName: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  invalidatedAt: null,
  invalidationReason: null,
  sourceEventCount: 1,
  sourceTokenEstimate: 2,
  summaryTokenEstimate: 2,
  summaryPromptVersion: "v1",
  summaryStructuredJson: null,
  summaryStructuredSchemaVersion: null,
  lcmAlgorithmVersion: "v1",
  embeddingCount: 1
};

const nodeDetail: LcmGraphNodeDetail = {
  ...node,
  sourceItems: [],
  sources: [event],
  childNodes: [],
  parentNodes: []
};

const embeddableSource: EmbeddableSourceRecord = {
  sourceType: "memory_event",
  sourceId: "event-a",
  ownerUserId: "user-a",
  visibility: "personal",
  text: "semantic source",
  sourceHash: "hash"
};

const searchResult: MemorySearchResult = {
  nodeId: "node-a",
  visibility: "personal",
  summaryText: "semantic source",
  score: 0.9,
  citation: { nodeId: "node-a", visibility: "personal" }
};

const semanticMetadata: RetrievalMetadata = {
  retrievalMode: "semantic_vector",
  vectorHitsCount: 1,
  textHitsCount: 0,
  embeddingModel: "embed-model",
  embeddingDimensions: 384,
  semanticRetrievalComplete: true
};

const repository = (
  overrides: Partial<ProductStateRepository> = {}
): ProductStateRepository => ({
  createTrustedNormalizedImport: vi.fn(async () => [item]),
  getCapturedSession: vi.fn(async () => session),
  findConversationItemByStableIdentity: vi.fn(async () => item),
  getLcmGraphEvent: vi.fn(async () => event),
  getEmbeddableSource: vi.fn(async () => embeddableSource),
  getCurrentSourceEmbeddingChunkCount: vi.fn(async () => 2),
  listLcmGraphNodes: vi.fn(async () => [node]),
  getLcmGraphNode: vi.fn(async () => nodeDetail),
  searchMemoryNodes: vi.fn(async () => ({
    results: [searchResult],
    metadata: semanticMetadata
  })),
  ...overrides
});

const expectation = {
  condition: "relevant" as const,
  actor,
  projectId: "/project-a",
  sessionId: "session-a",
  conversationItems: [
    {
      id: "item-a",
      canonicalStableItemId: "stable-a",
      sourceSequence: 0,
      sourceEventType: "user_message"
    }
  ],
  projectionDispositions: [
    { eventId: "event-a", includeInEmbedding: true, includeInLcm: true }
  ],
  scheduledLcmEventIds: ["event-a"],
  embedding: { model: "embed-model", dimensions: 384, version: "v1" },
  recall: { query: "semantic probe", expectedSourceIds: ["event-a"] }
};

describe("Experience Replay product state", () => {
  it("uses API admission/Projection and the authenticated repository actor", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { id: "session-a" } })
      .mockResolvedValueOnce({ projection: { memoryEventIds: ["event-a"] } });
    const normalizedImportRepository: Pick<
      MemorySourceRepository,
      "createTrustedNormalizedImport"
    > = {
      createTrustedNormalizedImport: vi.fn(async () => [item])
    };
    const client = createProductionNormalizedImportClient({
      api: { request },
      repository: normalizedImportRepository,
      actor,
      authorization: "Bearer token-a"
    });
    await expect(
      client.createSession({ projectId: "/project-a" })
    ).resolves.toEqual({
      session: { id: "session-a" }
    });
    await expect(
      client.createTrustedNormalizedImport({ attestation: {}, items: [] })
    ).resolves.toEqual({ items: [{ id: "item-a" }] });
    await client.projectConversationItems({ conversationItemIds: ["item-a"] });
    expect(
      normalizedImportRepository.createTrustedNormalizedImport
    ).toHaveBeenCalledWith(actor, {
      attestation: {},
      items: []
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: "/v1/memory/conversation-items/project",
        headers: { authorization: "Bearer token-a" }
      })
    );
  });

  it("attests exact source state, chunks, completed LCM, and semantic Recall", async () => {
    const result = await awaitExperienceReplayProductState({
      repository: repository(),
      expectation,
      timeoutMs: 0
    });
    expect(result).toMatchObject({
      ready: true,
      conversationItemIds: ["item-a"],
      projectedEventIds: ["event-a"],
      embeddedChunkCounts: { "event-a": 2 },
      summarizedLcmNodeIds: ["node-a"]
    });
    expect(result.recall.resolvedSourceIds).toContain("event-a");
  });

  it("polls boundedly until embedding and semantic source Recall are ready", async () => {
    let attempt = 0;
    let clock = 0;
    const repo = repository({
      getCurrentSourceEmbeddingChunkCount: vi.fn(async () =>
        attempt === 0 ? null : 1
      ),
      searchMemoryNodes: vi.fn(async () => ({
        results: attempt === 0 ? [] : [searchResult],
        metadata: {
          ...semanticMetadata,
          vectorHitsCount: attempt
        }
      }))
    });
    const result = await awaitExperienceReplayProductState({
      repository: repo,
      expectation,
      timeoutMs: 10,
      intervalMs: 1,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
        attempt += 1;
      }
    });
    expect(result.attempts).toBe(2);
  });

  it("fails closed on lexical fallback and reports the bounded attestation failure", async () => {
    const lexicalMetadata: RetrievalMetadata = {
      retrievalMode: "embedding_unavailable",
      vectorHitsCount: 0,
      textHitsCount: 1,
      embeddingModel: null,
      embeddingDimensions: null
    };
    const repo = repository({
      searchMemoryNodes: vi.fn(async () => ({
        results: [],
        metadata: lexicalMetadata
      }))
    });
    await expect(
      awaitExperienceReplayProductState({
        repository: repo,
        expectation,
        timeoutMs: 0
      })
    ).rejects.toThrow("semantic-only retrieval");
  });

  it("requires an empty condition to semantically miss", async () => {
    const repo = repository({
      searchMemoryNodes: vi.fn(async () => ({
        results: [],
        metadata: {
          ...semanticMetadata,
          vectorHitsCount: 0
        }
      }))
    });
    await expect(
      awaitExperienceReplayProductState({
        repository: repo,
        expectation: {
          condition: "empty",
          actor,
          projectId: "/project-a",
          embedding: expectation.embedding,
          recall: { query: "semantic probe", expectedSourceIds: [] }
        },
        timeoutMs: 0
      })
    ).resolves.toMatchObject({ ready: true, sessionId: null });
  });

  it("does not require a summary merely because an event is LCM-eligible", async () => {
    const repo = repository({
      listLcmGraphNodes: vi.fn(async () => [])
    });
    await expect(
      awaitExperienceReplayProductState({
        repository: repo,
        expectation: { ...expectation, scheduledLcmEventIds: [] },
        timeoutMs: 0
      })
    ).resolves.toMatchObject({ ready: true, summarizedLcmNodeIds: [] });
  });
});
