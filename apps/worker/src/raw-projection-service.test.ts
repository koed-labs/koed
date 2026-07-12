import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import { createRawProjectionService } from "./raw-projection-service.js";

const projectionResult = (
  memoryEventScopes: Array<{
    eventId: string;
    visibility: "personal";
    includeInEmbedding: boolean;
    includeInLcm: boolean;
  }>
) => ({
  rawItemsScanned: memoryEventScopes.length,
  rawItemsProjected: memoryEventScopes.length,
  rawItemsWaitingForAgentSeal: 0,
  messagesCreated: 0,
  toolEventsCreated: 0,
  memoryEventsCreated: memoryEventScopes.length,
  tokenUsageRowsCreated: 0,
  memoryEventIds: memoryEventScopes.map((scope) => scope.eventId),
  memoryEventScopes
});

const semanticRebuildResult = (
  memoryEventScopes: Array<{
    eventId: string;
    visibility: "personal";
    includeInEmbedding: boolean;
    includeInLcm: boolean;
  }>
) => ({
  jobsClaimed: 1,
  jobsCompleted: 1,
  jobsFailed: 0,
  memoryEventsCreated: memoryEventScopes.length,
  memoryEventIds: memoryEventScopes.map((scope) => scope.eventId),
  memoryEventScopes
});

const logger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
});

describe("raw projection service", () => {
  it("enqueues independent jobs according to projection flags", async () => {
    const repository = {
      listConversationProjectionActors: vi
        .fn()
        .mockResolvedValue([{ userId: "user-1" }]),
      projectPendingConversationItems: vi.fn().mockResolvedValue(
        projectionResult([
          {
            eventId: "embed-only",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: false
          },
          {
            eventId: "lcm-only",
            visibility: "personal",
            includeInEmbedding: false,
            includeInLcm: true
          },
          {
            eventId: "both",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true
          },
          {
            eventId: "stored-only",
            visibility: "personal",
            includeInEmbedding: false,
            includeInLcm: false
          }
        ])
      ),
      listSemanticMemoryRebuildActors: vi.fn().mockResolvedValue([]),
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
        {
          ownerUserId: "user-1",
          visibility: "personal",
          pendingMemoryEventIds: ["both", "lcm-only"],
          dispatchKey: "lcm-dispatch-user-1-v1"
        }
      ]),
      listSourcesNeedingEmbeddings: vi.fn().mockResolvedValue([
        {
          sourceType: "memory_event",
          sourceId: "embed-only",
          ownerUserId: "user-1",
          visibility: "personal",
          text: "embed only",
          sourceHash: "hash-1"
        },
        {
          sourceType: "memory_event",
          sourceId: "both",
          ownerUserId: "user-1",
          visibility: "personal",
          text: "both",
          sourceHash: "hash-2"
        }
      ])
    } as unknown as MemorySourceRepository;
    const enqueueSourceEmbedding = vi.fn().mockResolvedValue({ id: 1 });
    const enqueueLcmCompaction = vi.fn().mockResolvedValue({ id: 2 });
    const service = createRawProjectionService({
      actorLimit: 10,
      batchLimit: 100,
      embeddingDispatchKey: "qwen-v1-1024",
      enqueueLcmCompaction,
      enqueueSourceEmbedding,
      intervalMs: 1_000,
      logger: logger() as never,
      repository
    });

    await service.run();

    expect(enqueueSourceEmbedding).toHaveBeenCalledTimes(2);
    expect(enqueueSourceEmbedding).toHaveBeenNthCalledWith(
      1,
      "memory_event",
      "embed-only",
      "qwen-v1-1024"
    );
    expect(enqueueSourceEmbedding).toHaveBeenNthCalledWith(
      2,
      "memory_event",
      "both",
      "qwen-v1-1024"
    );
    expect(enqueueLcmCompaction).toHaveBeenCalledOnce();
    expect(enqueueLcmCompaction).toHaveBeenCalledWith(
      { userId: "user-1" },
      "personal",
      "lcm-dispatch-user-1-v1"
    );
  });

  it("rediscovers an embedding after queue admission fails", async () => {
    const repository = {
      listConversationProjectionActors: vi
        .fn()
        .mockResolvedValue([{ userId: "user-1" }]),
      projectPendingConversationItems: vi.fn().mockResolvedValue(
        projectionResult([
          {
            eventId: "event-1",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true
          }
        ])
      ),
      listSemanticMemoryRebuildActors: vi.fn().mockResolvedValue([]),
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
        {
          ownerUserId: "user-1",
          visibility: "personal",
          pendingMemoryEventIds: ["event-1"],
          dispatchKey: "lcm-dispatch-user-1-v1"
        }
      ]),
      listSourcesNeedingEmbeddings: vi.fn().mockResolvedValue([
        {
          sourceType: "memory_event",
          sourceId: "event-1",
          ownerUserId: "user-1",
          visibility: "personal",
          text: "retry me",
          sourceHash: "hash-1"
        }
      ])
    } as unknown as MemorySourceRepository;
    const enqueueSourceEmbedding = vi
      .fn()
      .mockRejectedValueOnce(new Error("embedding queue unavailable"))
      .mockResolvedValueOnce({ id: 1 });
    const enqueueLcmCompaction = vi.fn().mockResolvedValue({ id: 2 });
    const log = logger();
    const service = createRawProjectionService({
      actorLimit: 10,
      batchLimit: 100,
      embeddingDispatchKey: "qwen-v1-1024",
      enqueueLcmCompaction,
      enqueueSourceEmbedding,
      intervalMs: 1_000,
      logger: log as never,
      repository
    });

    await service.run();
    await service.run();

    expect(enqueueSourceEmbedding).toHaveBeenCalledTimes(2);
    expect(enqueueSourceEmbedding).toHaveBeenCalledWith(
      "memory_event",
      "event-1",
      "qwen-v1-1024"
    );
    expect(enqueueLcmCompaction).toHaveBeenCalledWith(
      { userId: "user-1" },
      "personal",
      "lcm-dispatch-user-1-v1"
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { name: "memory-embed" },
        resource: { type: "memory_event", id: "event-1" }
      }),
      "could not enqueue pending embedding source"
    );
  });

  it("rediscovers LCM compaction after queue admission fails", async () => {
    const repository = {
      listConversationProjectionActors: vi.fn().mockResolvedValue([]),
      listSemanticMemoryRebuildActors: vi
        .fn()
        .mockResolvedValue([{ userId: "user-2" }]),
      processDueSemanticMemoryRebuilds: vi.fn().mockResolvedValue(
        semanticRebuildResult([
          {
            eventId: "rebuilt-event-1",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true
          }
        ])
      ),
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
        {
          ownerUserId: "user-2",
          visibility: "personal",
          pendingMemoryEventIds: ["rebuilt-event-1"],
          dispatchKey: "lcm-dispatch-user-2-v1"
        }
      ]),
      listSourcesNeedingEmbeddings: vi.fn().mockResolvedValue([
        {
          sourceType: "memory_event",
          sourceId: "rebuilt-event-1",
          ownerUserId: "user-2",
          visibility: "personal",
          text: "rebuilt",
          sourceHash: "hash-rebuilt"
        }
      ])
    } as unknown as MemorySourceRepository;
    const enqueueSourceEmbedding = vi.fn().mockResolvedValue({ id: 1 });
    const enqueueLcmCompaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("compaction queue unavailable"))
      .mockResolvedValueOnce({ id: 2 });
    const log = logger();
    const service = createRawProjectionService({
      actorLimit: 10,
      batchLimit: 100,
      embeddingDispatchKey: "qwen-v1-1024",
      enqueueLcmCompaction,
      enqueueSourceEmbedding,
      intervalMs: 1_000,
      logger: log as never,
      repository
    });

    await service.run();
    await service.run();

    expect(enqueueSourceEmbedding).toHaveBeenCalledWith(
      "memory_event",
      "rebuilt-event-1",
      "qwen-v1-1024"
    );
    expect(enqueueLcmCompaction).toHaveBeenCalledWith(
      { userId: "user-2" },
      "personal",
      "lcm-dispatch-user-2-v1"
    );
    expect(enqueueLcmCompaction).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { name: "lcm-compact" },
        actor: { user_id: "user-2" }
      }),
      "could not enqueue pending LCM compaction scope"
    );
  });
});
