import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatMoveOperation, ChatMoveRepository } from "@koed/db";
import type { CollaborationActionGrantControl } from "../local-edge/collaboration-action-grant-control.js";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";
import { createChatMoveCoordinator } from "./chat-move-coordinator.js";

const owner = randomUUID();
const sessionId = randomUUID();
const logicalMemoryId = randomUUID();
const teamId = randomUUID();
const workspaceId = randomUUID();
const grantId = randomUUID();
const unrelatedGrantId = randomUUID();
const bindingId = randomUUID();
const batchId = randomUUID();
const backendId = "old-team";

type DispatchResult =
  | {
      ok: true;
      data: {
        status: {
          actionGrant: { id: string };
          approvalTier: string;
          state: string;
        };
      };
    }
  | {
      ok: false;
      error: { code: "not_available" | "temporarily_unavailable" };
    };

const operation = (): ChatMoveOperation => ({
  batchId,
  ownerUserId: owner,
  sessionId,
  oldProjectId: randomUUID(),
  oldWorkspaceProjectId: randomUUID(),
  oldProjectVersion: 1,
  targetProjectId: null,
  sourceMappingVersion: 1,
  bindings: [
    {
      id: bindingId,
      ownerUserId: owner,
      sessionId,
      projectId: randomUUID(),
      backendId,
      logicalMemoryId,
      teamId,
      teamWorkspaceId: workspaceId,
      shareGrantId: grantId,
      policyGeneration: 1,
      mappingVersion: 1,
      grantVersion: 1
    }
  ],
  manifestHash: "a".repeat(64),
  acks: [],
  state: "freezing"
});

describe("HQ-107 exact grant freeze coordinator", () => {
  const fixture = (
    lifecycle: "active" | "unavailable" | "revoked",
    reviewState = "approved"
  ) => {
    const move = operation();
    let frozenAt: string | null = null;
    const grant = () => ({
      id: grantId,
      logicalMemoryId,
      teamId,
      teamWorkspaceId: workspaceId,
      grantVersion: frozenAt ? 8 : 7,
      lifecycle,
      revokedAt: lifecycle === "revoked" ? new Date().toISOString() : null,
      frozenAt,
      freezeSourceAccessExpected: Boolean(frozenAt),
      source: { kind: "captured_session", sessionId }
    });
    const remote = vi.fn(async (input: { method: string; path: string }) => {
      if (input.method === "GET")
        return {
          shareGrants: [{ ...grant(), id: unrelatedGrantId }, grant()],
          pagination: { hasMore: false, nextOffset: null }
        };
      if (
        input.method === "POST" &&
        input.path === `/v1/shared-memory/share-grants/${grantId}/freeze`
      ) {
        frozenAt = new Date().toISOString();
        return { grant: grant() };
      }
      throw new Error("unexpected remote request");
    });
    const shared = {
      resolveProjectSourceAuthority: vi.fn(async () => ({
        backend: { id: backendId, baseUrl: "https://team.example.test" },
        principalUserId: randomUUID(),
        upstreamDeviceCredentialId: randomUUID(),
        upstreamDeviceAuthorization: "device",
        localOwnerUserId: owner
      })),
      projectSourceRequest: remote
    } as unknown as CollaborationSharedMemoryControl;
    const dispatch = vi.fn(
      async (
        command: Parameters<CollaborationActionGrantControl["dispatch"]>[0]
      ): Promise<DispatchResult> => {
        void command;
        return {
          ok: true,
          data: {
            status: {
              actionGrant: { id: randomUUID() },
              approvalTier: "native_review",
              state: reviewState
            }
          }
        };
      }
    );
    const action = {
      dispatch,
      resolveSecret: vi.fn(async () => "approved-secret")
    } as unknown as CollaborationActionGrantControl;
    const reserve = vi.fn(
      async (
        _owner: string,
        _session: string,
        _batch: string,
        _binding: string,
        reviewedGrantVersion: number
      ) => {
        const previous = move.acks.find((item) => item.bindingId === bindingId);
        if (previous?.reviewedGrantVersion === reviewedGrantVersion)
          return previous;
        const ack = {
          bindingId,
          commandRequestId: randomUUID(),
          actionGrantId: null,
          reviewedGrantVersion,
          state: "reserved" as const
        };
        move.acks = [ack];
        return ack;
      }
    );
    const ack = vi.fn(
      async (
        _owner: string,
        _session: string,
        _batch: string,
        value: ChatMoveOperation["acks"][number]
      ) => {
        move.acks = [value];
      }
    );
    const cancel = vi.fn(async () => undefined);
    const resetReviewReservation = vi.fn(async () => {
      move.acks = move.acks.map((item) => ({
        ...item,
        commandRequestId: randomUUID(),
        actionGrantId: null,
        state: "reserved" as const
      }));
    });
    const repository = {
      assertPending: vi.fn(async () => move),
      reserve,
      ack,
      cancel,
      resetReviewReservation,
      get: vi.fn(async () => move)
    } as unknown as ChatMoveRepository;
    return {
      move,
      remote,
      dispatch,
      action,
      reserve,
      ack,
      cancel,
      resetReviewReservation,
      coordinator: createChatMoveCoordinator({
        repository,
        sharedMemoryControl: shared,
        actionGrantControl: action
      })
    };
  };

  it("freezes only the bound grant after Native approval at its current version", async () => {
    const f = fixture("active");
    const result = await f.coordinator.advance(f.move);
    expect(f.reserve).toHaveBeenCalledWith(
      owner,
      sessionId,
      batchId,
      bindingId,
      7
    );
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(
      f.remote.mock.calls.filter(([request]) => request.method === "POST")
    ).toHaveLength(1);
    expect(
      f.remote.mock.calls.some(([request]) =>
        request.path.includes(unrelatedGrantId)
      )
    ).toBe(false);
    expect(result.acks[0]?.state).toBe("frozen");
  });

  it("keeps an unavailable grant pending even when the owner list contains it", async () => {
    const f = fixture("unavailable");
    await expect(f.coordinator.advance(f.move)).rejects.toThrow(
      "may advance again"
    );
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(
      f.remote.mock.calls.filter(([request]) => request.method === "POST")
    ).toHaveLength(0);
  });

  it("reconciles a terminal revoked grant without a new review or freeze", async () => {
    const f = fixture("revoked");
    const result = await f.coordinator.advance(f.move);
    expect(result.acks[0]?.state).toBe("resolved");
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("cancels a terminal denied review without dispatching a freeze", async () => {
    const f = fixture("active", "denied");
    await expect(f.coordinator.advance(f.move)).rejects.toThrow(
      "ended without approval"
    );
    expect(f.cancel).toHaveBeenCalledWith(owner, sessionId, batchId);
    expect(
      f.remote.mock.calls.filter(([request]) => request.method === "POST")
    ).toHaveLength(0);
  });

  it("replans an expired reservation without replaying its command", async () => {
    const f = fixture("active", "expired");
    await expect(f.coordinator.advance(f.move)).rejects.toThrow(
      "retry to request fresh review"
    );
    expect(f.resetReviewReservation).toHaveBeenCalledWith(
      owner,
      sessionId,
      batchId,
      bindingId,
      null
    );
    expect(
      f.remote.mock.calls.filter(([request]) => request.method === "POST")
    ).toHaveLength(0);
  });

  it("restarts a definitively missing un-dispatched review with a fresh command", async () => {
    const f = fixture("active");
    const oldCommandRequestId = randomUUID();
    const missingActionGrantId = randomUUID();
    f.move.acks = [
      {
        bindingId,
        commandRequestId: oldCommandRequestId,
        actionGrantId: missingActionGrantId,
        reviewedGrantVersion: 7,
        state: "review_required"
      }
    ];
    f.dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "not_available" }
    });

    await expect(f.coordinator.advance(f.move)).rejects.toThrow(
      "retry to request fresh review"
    );
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
      command: "collaboration.await_action_grant",
      input: { actionGrant: { id: missingActionGrantId } }
    });
    expect(f.resetReviewReservation).toHaveBeenCalledWith(
      owner,
      sessionId,
      batchId,
      bindingId,
      missingActionGrantId
    );
    expect(f.move.acks[0]?.commandRequestId).not.toBe(oldCommandRequestId);
    expect(
      f.remote.mock.calls.filter(([request]) => request.method === "POST")
    ).toHaveLength(0);

    await f.coordinator.advance(f.move);
    expect(f.dispatch.mock.calls[1]?.[0]).toMatchObject({
      command: "collaboration.request_action_grant",
      input: {
        intent: { commandRequestId: f.move.acks[0]?.commandRequestId }
      }
    });
    expect(
      f.remote.mock.calls.filter(([request]) => request.method === "POST")
    ).toHaveLength(1);
  });

  it("does not reset an unavailable review for an ambiguous error", async () => {
    const f = fixture("active");
    f.move.acks = [
      {
        bindingId,
        commandRequestId: randomUUID(),
        actionGrantId: randomUUID(),
        reviewedGrantVersion: 7,
        state: "review_required"
      }
    ];
    f.dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "temporarily_unavailable" }
    });
    await expect(f.coordinator.advance(f.move)).rejects.toThrow("unresolved");
    expect(f.resetReviewReservation).not.toHaveBeenCalled();
  });

  it("keeps a dispatched freeze read-only after restart", async () => {
    const f = fixture("active");
    f.move.acks = [
      {
        bindingId,
        commandRequestId: randomUUID(),
        actionGrantId: randomUUID(),
        reviewedGrantVersion: 7,
        state: "dispatched"
      }
    ];
    await expect(f.coordinator.advance(f.move)).rejects.toThrow(
      "read-only reconciliation"
    );
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.resetReviewReservation).not.toHaveBeenCalled();
    expect(
      f.remote.mock.calls.filter(([request]) => request.method === "POST")
    ).toHaveLength(0);
  });
});
