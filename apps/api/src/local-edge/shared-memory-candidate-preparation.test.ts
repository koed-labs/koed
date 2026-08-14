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
    listLcmGraphEvents: vi.fn(
      async (): Promise<Array<Record<string, unknown>>> => []
    ),
    listLcmGraphNodes: vi.fn(
      async (): Promise<Array<Record<string, unknown>>> => []
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
      representation: "memory_events" as const
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
