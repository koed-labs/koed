import { describe, expect, it, vi } from "vitest";
import { curatedWithdrawalManifestHash } from "@koed/shared";
import type {
  CuratedClassificationOperation,
  MemorySourceRepository
} from "@koed/db";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";
import { createCuratedClassificationCoordinator } from "./curated-classification-coordinator.js";

const id = (tail: string) =>
  `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const operation = (): CuratedClassificationOperation => ({
  id: id("1"),
  ownerUserId: id("2"),
  assertionId: id("3"),
  expectedVersion: 1,
  nextVersion: 2,
  scope: "me",
  projectId: null,
  manifest: ["a", "b"].map((letter, index) => ({
    backendId: letter,
    source: {
      kind: "captured_session",
      sessionId: id("4"),
      logicalMemoryId: id(String(index + 5))
    },
    items: []
  })),
  backendAcks: [],
  state: "pending"
});

describe("Curated classification coordinator", () => {
  it("waits for every exact backend ACK and retries after one is unavailable", async () => {
    const initial = operation();
    let current = initial;
    let unavailable = true;
    const commit = vi.fn(async () => ({
      ...current,
      state: "complete" as const
    }));
    const repository = {
      recordCuratedClassificationAck: vi.fn(
        async (
          _actor: unknown,
          _id: string,
          backendId: string,
          logicalMemoryId: string,
          receipt: { manifestHash: string }
        ) => {
          current = {
            ...current,
            backendAcks: [
              ...current.backendAcks,
              { backendId, logicalMemoryId, manifestHash: receipt.manifestHash }
            ]
          };
          return current;
        }
      ),
      commitCuratedClassification: commit
    } as unknown as MemorySourceRepository;
    const remote = vi.fn(
      async (request: {
        backendId: string;
        body?: Record<string, unknown>;
      }) => {
        if (request.backendId === "b" && unavailable)
          throw new Error("offline");
        const body = request.body!;
        expect(body.manifestHash).toBe(
          curatedWithdrawalManifestHash({
            source: body.source as never,
            sourceDeploymentProtocolId:
              body.sourceDeploymentProtocolId as string,
            sourceOwnerPrincipalId: body.sourceOwnerPrincipalId as string,
            assertionId: body.assertionId as string,
            mutationId: body.mutationId as string,
            classificationVersion: body.classificationVersion as number,
            items: []
          })
        );
        return {
          receipt: {
            mutationId: body.mutationId,
            manifestHash: body.manifestHash,
            appliedVersion: 1
          }
        };
      }
    );
    const coordinator = createCuratedClassificationCoordinator({
      repository,
      sharedMemoryControl: {
        projectSourceRequest: remote
      } as unknown as CollaborationSharedMemoryControl,
      resolveSourceIdentity: () => ({
        sourceDeploymentProtocolId: id("9"),
        sourceOwnerPrincipalId: id("2")
      })
    });
    await expect(coordinator.advance(initial)).rejects.toThrow("offline");
    expect(current.backendAcks).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
    unavailable = false;
    await coordinator.advance(current);
    expect(current.backendAcks).toHaveLength(2);
    expect(commit).toHaveBeenCalledOnce();
    expect(
      remote.mock.calls.filter(([request]) => request.backendId === "a")
    ).toHaveLength(1);
  });
});
