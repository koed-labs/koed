import type { MemorySourceRepository } from "@koed/db";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalSharedMemoryCandidatePreparation,
  prepareLocalLcmCandidateRepresentation
} from "./shared-memory-candidate-preparation.js";

describe("prepareLocalLcmCandidateRepresentation", () => {
  it("prepares LCM nodes until the selected representation is exhausted", async () => {
    const createLcmNodes = vi
      .fn()
      .mockResolvedValueOnce({
        leafNodeIds: ["leaf-1"],
        rollupNodeId: null
      })
      .mockResolvedValueOnce({ leafNodeIds: [], rollupNodeId: null });

    await prepareLocalLcmCandidateRepresentation({
      repository: { createLcmNodes },
      ownerUserId: "owner-1",
      sessionId: "session-1",
      representation: "lcm_leaves"
    });

    expect(createLcmNodes).toHaveBeenCalledTimes(2);
    expect(createLcmNodes).toHaveBeenNthCalledWith(
      1,
      { userId: "owner-1" },
      {
        visibility: "personal",
        sessionId: "session-1",
        force: true,
        requestedRepresentation: "lcm_leaves"
      }
    );
  });

  it("fails closed when bounded compaction cannot reach an exhausted state", async () => {
    const createLcmNodes = vi.fn(async () => ({
      leafNodeIds: ["leaf-1"],
      rollupNodeId: null
    }));

    await expect(
      prepareLocalLcmCandidateRepresentation({
        repository: { createLcmNodes },
        ownerUserId: "owner-1",
        sessionId: "session-1",
        representation: "lcm_leaves"
      })
    ).rejects.toThrow("bounded work limit");
    expect(createLcmNodes).toHaveBeenCalledTimes(1_000);
  });
});

describe("createLocalSharedMemoryCandidatePreparation", () => {
  const repository = () => ({
    createLcmNodes: vi.fn(async () => ({
      leafNodeIds: [],
      rollupNodeId: null
    })),
    getSharedMemoryLcmSyncState: vi.fn(
      async (): Promise<"pending" | "ready"> => "ready"
    ),
    getLocalSyncDeployment: vi.fn(async () => ({
      protocolDeploymentId: "deployment-1"
    })),
    getPersonalNoteRevisionMemoryEvent: vi.fn<
      MemorySourceRepository["getPersonalNoteRevisionMemoryEvent"]
    >(async () => null),
    listCuratedMemoryAssertions: vi.fn(
      async (): Promise<Array<Record<string, unknown>>> => []
    ),
    listLcmGraphEvents: vi.fn(
      async (): Promise<Array<Record<string, unknown>>> => []
    ),
    listLcmGraphNodes: vi.fn(
      async (): Promise<Array<Record<string, unknown>>> => []
    ),
    listCapturedSessionSyncEligibleLcmNodeIds: vi.fn(
      async (): Promise<string[]> => []
    ),
    listLcmGraphThreads: vi.fn(async () => [
      {
        threads: [
          { id: "thread-1", projectId: "project-1", sessionId: "session-1" }
        ]
      }
    ]),
    prepareCapturedSessionSyncCandidateRevision: vi.fn(async () => 7)
  });

  it("builds deterministic event candidates and excludes trusted Approval Activity", async () => {
    const candidateRepository = repository();
    candidateRepository.listLcmGraphEvents.mockResolvedValue([
      {
        id: "event-1",
        eventType: "message",
        actor: "user",
        content: "Keep this",
        metadata: {},
        timestamp: "2026-08-14T10:00:00.000Z"
      },
      {
        id: "event-2",
        eventType: "message",
        actor: "assistant",
        content: "Do not share this approval record",
        metadata: { providerApprovalKind: "approval_decision" },
        timestamp: "2026-08-14T10:01:00.000Z"
      }
    ]);
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });

    const input = {
      localOwnerUserId: "owner-1",
      sessionId: "session-1",
      representation: "memory_events" as const,
      mode: "continuous" as const
    };
    const first = await preparation.loadCandidatePreview(input);
    const second = await preparation.loadCandidatePreview(input);

    expect(first).toMatchObject({
      sourceRevision: 7,
      itemCount: 1,
      excludedItemCount: 1,
      items: [{ id: "event-1", sequence: 2 }]
    });
    expect(second?.candidateHash).toBe(first?.candidateHash);
    expect(candidateRepository.listLcmGraphEvents).toHaveBeenCalledWith(
      { userId: "owner-1" },
      expect.objectContaining({ canonicalCapturedSessionEventsOnly: true })
    );
  });

  it("builds one owner-bound immutable Personal Note candidate", async () => {
    const candidateRepository = repository();
    const noteId = "00000000-0000-4000-8000-000000000011";
    const eventId = "00000000-0000-4000-8000-000000000012";
    candidateRepository.getPersonalNoteRevisionMemoryEvent.mockResolvedValue({
      id: eventId,
      actor: "user",
      eventType: "message",
      sourceRuntime: "codex",
      captureMethod: "api",
      model: null,
      projectId: null,
      projectName: null,
      projectPath: null,
      sessionId: null,
      threadId: null,
      threadName: null,
      content: "Immutable Note body",
      contentPreview: "Immutable Note body",
      rawContent: undefined,
      metadata: {},
      linkedNodeIds: [],
      timestamp: "2026-08-18T12:00:00.000Z",
      sourceEventTime: "2026-08-18T12:00:00.000Z",
      sourceSequence: 7,
      capturedAt: "2026-08-18T12:00:00.000Z",
      createdAt: "2026-08-18T12:00:00.000Z",
      visibility: "personal",
      invalidatedAt: null,
      invalidationReason: null
    });
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });
    const input = {
      localOwnerUserId: "00000000-0000-4000-8000-000000000010",
      noteId,
      noteRevision: 4,
      mode: "snapshot" as const
    };
    const first = await preparation.loadPersonalNoteCandidatePreview(input);
    const reloaded = await preparation.loadPersonalNoteCandidatePreview(input);

    expect(first).toMatchObject({
      source: {
        kind: "personal_note",
        noteId,
        noteRevision: 4,
        memoryEventId: eventId
      },
      sourceCapabilities: ["memory_events"],
      activationRepresentation: "memory_events",
      mode: "snapshot",
      sourceRevision: 4,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: eventId }],
      items: [{ id: eventId, sequence: 1 }]
    });
    expect(reloaded?.candidateHash).toBe(first?.candidateHash);
    expect(
      candidateRepository.getPersonalNoteRevisionMemoryEvent
    ).toHaveBeenCalledWith(
      { userId: input.localOwnerUserId },
      { noteId, revision: 4 }
    );
  });

  it("maps current curated assertions with eligible evidence", async () => {
    const candidateRepository = repository();
    candidateRepository.listCuratedMemoryAssertions.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000001",
        assertionText: "Projection excludes Approval Activity.",
        topicTitle: "Projection",
        tags: ["projection"],
        observedAt: "2026-08-14T10:00:00.000Z",
        sources: [
          { sourceRole: "primary_evidence" },
          { sourceRole: "provenance_only" }
        ]
      }
    ]);
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });

    await expect(
      preparation.loadCandidatePreview({
        localOwnerUserId: "owner-1",
        sessionId: "session-1",
        representation: "curated_assertions",
        mode: "continuous"
      })
    ).resolves.toMatchObject({
      itemCount: 1,
      excludedItemCount: 0,
      items: [
        {
          representation: "curated_assertions",
          assertionText: "Projection excludes Approval Activity.",
          sourceCount: 1
        }
      ]
    });
    expect(
      candidateRepository.listCuratedMemoryAssertions
    ).toHaveBeenCalledWith(
      { userId: "owner-1" },
      {
        status: "current",
        sessionId: "session-1",
        includeSources: true,
        limit: 101
      }
    );
  });

  it("fails closed instead of truncating a candidate above the consent boundary", async () => {
    const candidateRepository = repository();
    candidateRepository.listLcmGraphEvents.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        eventType: "message",
        actor: "user",
        content: `candidate item ${index + 1}`,
        metadata: {},
        timestamp: "2026-08-14T10:00:00.000Z"
      }))
    );
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });

    await expect(
      preparation.loadCandidatePreview({
        localOwnerUserId: "owner-1",
        sessionId: "session-1",
        representation: "memory_events",
        mode: "continuous"
      })
    ).resolves.toBeNull();
  });

  it("prepares the largest accepted candidate within the bounded work budget", async () => {
    const candidateRepository = repository();
    candidateRepository.listLcmGraphEvents.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        eventType: "message",
        actor: "user",
        content: `bounded candidate item ${index + 1}`,
        metadata: {},
        timestamp: "2026-08-14T10:00:00.000Z"
      }))
    );
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });

    const startedAt = performance.now();
    const candidate = await preparation.loadCandidatePreview({
      localOwnerUserId: "owner-1",
      sessionId: "session-1",
      representation: "memory_events",
      mode: "continuous"
    });

    expect(candidate).toMatchObject({
      itemCount: 100,
      excludedItemCount: 0
    });
    expect(performance.now() - startedAt).toBeLessThan(30_000);
    expect(candidateRepository.listLcmGraphEvents).toHaveBeenCalledTimes(1);
  });

  it("fails closed before returning a candidate above the byte boundary", async () => {
    const candidateRepository = repository();
    candidateRepository.listLcmGraphEvents.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000001",
        eventType: "message",
        actor: "user",
        content: "x".repeat(256 * 1_024),
        metadata: {},
        timestamp: "2026-08-14T10:00:00.000Z"
      }
    ]);
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });

    await expect(
      preparation.loadCandidatePreview({
        localOwnerUserId: "owner-1",
        sessionId: "session-1",
        representation: "memory_events",
        mode: "continuous"
      })
    ).resolves.toBeNull();
  });

  it("preserves structured lexical anchors in LCM candidates", async () => {
    const candidateRepository = repository();
    candidateRepository.listLcmGraphNodes.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000002",
        kind: "leaf",
        updatedAt: "2026-08-14T10:00:00.000Z",
        summaryText: "Projection excludes Approval Activity.",
        sourceEventCount: 2,
        summaryStructuredJson: {
          schema_version: "lcm-semantic-summary-v1",
          title: "Projection",
          summary_text: "Projection excludes Approval Activity.",
          lexical_anchors: ["Approval Activity"]
        }
      }
    ]);
    candidateRepository.listCapturedSessionSyncEligibleLcmNodeIds.mockResolvedValue(
      ["00000000-0000-4000-8000-000000000002"]
    );
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });

    await expect(
      preparation.loadCandidatePreview({
        localOwnerUserId: "owner-1",
        sessionId: "session-1",
        representation: "lcm_leaves",
        mode: "continuous"
      })
    ).resolves.toMatchObject({
      items: [{ lexicalAnchors: ["Approval Activity"] }]
    });
  });

  it("excludes LCM nodes whose provenance cannot cross the sync boundary", async () => {
    const candidateRepository = repository();
    candidateRepository.listLcmGraphNodes.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "leaf",
        updatedAt: "2026-08-14T10:00:00.000Z",
        summaryText: "This leaf includes excluded Approval Activity.",
        sourceEventCount: 2,
        summaryStructuredJson: {}
      }
    ]);
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork: vi.fn()
    });

    await expect(
      preparation.loadCandidatePreview({
        localOwnerUserId: "owner-1",
        sessionId: "session-1",
        representation: "lcm_leaves",
        mode: "snapshot"
      })
    ).resolves.toMatchObject({ items: [], itemCount: 0 });
  });

  it("wakes LCM work only while the prepared representation is pending", async () => {
    const candidateRepository = repository();
    candidateRepository.getSharedMemoryLcmSyncState.mockResolvedValue(
      "pending"
    );
    const requestLcmSummaryWork = vi.fn(async () => undefined);
    const preparation = createLocalSharedMemoryCandidatePreparation({
      repository: candidateRepository as never,
      resolveDeploymentId: () => "deployment-1",
      requestLcmSummaryWork
    });

    await expect(
      preparation.prepareLcmRepresentation({
        localOwnerUserId: "owner-1",
        localSessionId: "session-1",
        syncRelationshipId: "relationship-1",
        representation: "lcm_rollups"
      })
    ).resolves.toBe("pending");
    expect(requestLcmSummaryWork).toHaveBeenCalledOnce();
  });
});
