import { describe, expect, it, vi } from "vitest";
import {
  awaitExperienceReplayProductState,
  createProductionNormalizedImportClient
} from "./product-state.js";

const actor = { userId: "user-a" };
const session = {
  id: "session-a",
  ownerUserId: "user-a",
  visibility: "personal",
  project: { id: "/project-a", name: "project-a", path: "/project-a" }
};
const item = {
  id: "item-a",
  sessionId: "session-a",
  canonicalStableItemId: "stable-a",
  sourceKind: "codex",
  sourceAdapterVersion: "koed-normalized-import-v1",
  sourceTransport: "normalized_import",
  sourceRecordType: "normalized_import_item",
  sourceEventType: "user_message",
  sourceSequence: 0
};
const event = {
  id: "event-a",
  ownerUserId: "user-a",
  sessionId: "session-a",
  projectId: "/project-a",
  visibility: "personal",
  metadata: {
    includeInEmbedding: true,
    includeInLcm: true,
    projectionPolicyKey: "normalized-user-message",
    projectionPolicyRevision: 1
  }
};
const node = {
  id: "node-a",
  sessionId: "session-a",
  summaryStatus: "summarized",
  summaryModel: "lcm-model"
};

const repository = (overrides: Record<string, unknown> = {}) =>
  ({
    getCapturedSession: vi.fn(async () => session),
    findConversationItemByStableIdentity: vi.fn(async () => item),
    getLcmGraphEvent: vi.fn(async () => event),
    getEmbeddableSource: vi.fn(async () => ({
      sourceType: "memory_event",
      sourceId: "event-a",
      ownerUserId: "user-a",
      visibility: "personal",
      text: "semantic source",
      sourceHash: "hash"
    })),
    getCurrentSourceEmbeddingChunkCount: vi.fn(async () => 2),
    listLcmGraphNodes: vi.fn(async () => [node]),
    getLcmGraphNode: vi.fn(async () => ({
      ...node,
      sources: [{ id: "event-a" }]
    })),
    searchMemoryNodes: vi.fn(async () => ({
      results: [
        {
          nodeId: "node-a",
          visibility: "personal",
          summaryText: "semantic source",
          score: 0.9,
          citation: { nodeId: "node-a", visibility: "personal" }
        }
      ],
      metadata: {
        retrievalMode: "semantic_vector",
        vectorHitsCount: 1,
        textHitsCount: 0,
        embeddingModel: "embed-model",
        embeddingDimensions: 384,
        semanticRetrievalComplete: true
      }
    })),
    ...overrides
  }) as any;

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
    const createTrustedNormalizedImport = vi.fn(async () => [{ id: "item-a" }]);
    const client = createProductionNormalizedImportClient({
      api: { request },
      repository: { createTrustedNormalizedImport } as any,
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
    expect(createTrustedNormalizedImport).toHaveBeenCalledWith(actor, {
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
      summarizedLcmNodeIds: ["node-a"],
      recall: { resolvedSourceIds: expect.arrayContaining(["event-a"]) }
    });
  });

  it("polls boundedly until embedding and semantic source Recall are ready", async () => {
    let attempt = 0;
    let clock = 0;
    const repo = repository({
      getCurrentSourceEmbeddingChunkCount: vi.fn(async () =>
        attempt === 0 ? null : 1
      ),
      searchMemoryNodes: vi.fn(async () => ({
        results:
          attempt === 0
            ? []
            : [
                {
                  nodeId: "node-a",
                  visibility: "personal",
                  summaryText: "semantic source",
                  score: 0.9,
                  citation: { nodeId: "node-a", visibility: "personal" }
                }
              ],
        metadata: {
          retrievalMode: "semantic_vector",
          vectorHitsCount: attempt,
          textHitsCount: 0,
          embeddingModel: "embed-model",
          embeddingDimensions: 384,
          semanticRetrievalComplete: true
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
    const repo = repository({
      searchMemoryNodes: vi.fn(async () => ({
        results: [],
        metadata: {
          retrievalMode: "embedding_unavailable",
          vectorHitsCount: 0,
          textHitsCount: 1,
          embeddingModel: null,
          embeddingDimensions: null
        }
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
          retrievalMode: "semantic_vector",
          vectorHitsCount: 0,
          textHitsCount: 0,
          embeddingModel: "embed-model",
          embeddingDimensions: 384,
          semanticRetrievalComplete: true
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
