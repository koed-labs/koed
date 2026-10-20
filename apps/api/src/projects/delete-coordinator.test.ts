import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectApiRepository,
  ProjectSourceRemovalRepository
} from "@koed/db";
import type { CollaborationActionGrantControl } from "../local-edge/collaboration-action-grant-control.js";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";
import { createProjectSourceCoordinator } from "./delete-coordinator.js";

const owner = randomUUID();
const projectId = randomUUID();
const batchId = randomUUID();
const sessionId = randomUUID();
const logicalMemoryId = randomUUID();
const backendId = "team-a";
const sourceDeploymentProtocolId = randomUUID();
const operation = {
  batchId,
  projectId,
  ownerUserId: owner,
  sources: [
    {
      sessionId,
      logicalMemoryId,
      backends: [{ backendId, relationshipIds: [] }]
    }
  ],
  executions: [],
  backendAcks: [],
  grantFreezeAcks: [],
  runtimeAcks: [],
  state: "preparing",
  sourceManifestHash: "a".repeat(64),
  executionSetHash: "b".repeat(64)
};

describe("Project source deletion coordinator", () => {
  const fixture = (
    grant:
      | {
          id: string;
          teamId: string;
          teamWorkspaceId: string;
          grantVersion: number;
        }
      | Array<{
          id: string;
          teamId: string;
          teamWorkspaceId: string;
          grantVersion: number;
        }>
      | null,
    options: {
      review?: "required" | "approved";
      loseFreezeResponse?: boolean;
      loseReviewAck?: boolean;
      sourceRemoval?: boolean;
    } = {}
  ) => {
    let prepared = false;
    let sealed = false;
    const grants = grant ? (Array.isArray(grant) ? grant : [grant]) : [];
    const frozen = new Set<string>();
    const activeGrants = () => grants.filter((item) => !frozen.has(item.id));
    let released = false;
    let lostFreezeResponse = false;
    const remote = vi.fn(
      async (input: {
        method: string;
        path: string;
        body?: Record<string, unknown>;
      }) => {
        if (input.method === "GET" && input.path.endsWith("/admission")) {
          if (!prepared) throw new Error("source not materialized");
          return {
            admission: {
              generation: 1,
              holdVersion: released ? 3 : sealed ? 2 : 1,
              heldBatchId: released ? null : batchId,
              sealed: released ? false : sealed,
              activeUnfrozenGrants: activeGrants().length
            }
          };
        }
        if (input.method === "GET" && input.path.endsWith("/admission/grants"))
          return { grants: activeGrants() };
        if (input.method === "POST" && input.path.endsWith("/admission")) {
          if (input.body?.operation === "prepare") prepared = true;
          if (input.body?.operation === "seal") sealed = true;
          if (input.body?.operation === "cancel") released = true;
          return {
            admission: {
              generation: 1,
              holdVersion: released ? 3 : sealed ? 2 : 1,
              heldBatchId: released ? null : batchId,
              sealed: released ? false : sealed,
              activeUnfrozenGrants: activeGrants().length
            }
          };
        }
        if (input.method === "POST" && input.path.endsWith("/freeze")) {
          const grantId = input.path.split("/").at(-2);
          if (!grantId || !grants.some((item) => item.id === grantId))
            throw new Error("unexpected grant freeze");
          frozen.add(grantId);
          if (options.loseFreezeResponse && !lostFreezeResponse) {
            lostFreezeResponse = true;
            throw new Error("freeze response lost");
          }
          return { grant: { id: grantId } };
        }
        throw new Error("unexpected request");
      }
    );
    const shared = {
      resolveProjectSourceAuthority: vi.fn(async () => ({
        backend: { id: backendId, baseUrl: "https://team.example.test" },
        principalUserId: randomUUID(),
        upstreamDeviceCredentialId: randomUUID(),
        upstreamDeviceAuthorization: "Koed-Device key:secret",
        localOwnerUserId: owner
      })),
      projectSourceRequest: remote
    } as unknown as CollaborationSharedMemoryControl;
    let actionCount = 0;
    const reviewedCommands = new Map<string, string>();
    const actionDispatch = vi.fn(
      async (command: {
        command: string;
        input: {
          intent?: { intent: string; commandRequestId: string };
          actionGrant?: { id: string };
        };
      }) => {
        const freeze =
          command.input.intent?.intent ===
          "collaboration.freeze_shared_memory_grant";
        actionCount++;
        const reviewId =
          command.input.actionGrant?.id ??
          reviewedCommands.get(command.input.intent?.commandRequestId ?? "") ??
          randomUUID();
        if (command.input.intent)
          reviewedCommands.set(command.input.intent.commandRequestId, reviewId);
        return {
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: reviewId },
              approvalTier:
                freeze || command.input.actionGrant
                  ? "native_review"
                  : "direct",
              review: freeze || command.input.actionGrant ? {} : null,
              state:
                (freeze || command.input.actionGrant) &&
                options.review !== "approved"
                  ? "review_required"
                  : "approved",
              activationUrl: null,
              expiresAt: new Date(Date.now() + 300000).toISOString()
            }
          }
        };
      }
    );
    const action = {
      dispatch: actionDispatch,
      resolveSecret: vi.fn(async () => "approved-secret")
    } as unknown as CollaborationActionGrantControl;
    const backendAck = vi.fn(async () => undefined);
    const durableReviews: Array<
      Parameters<ProjectApiRepository["recordGrantFreezeAck"]>[3]
    > = [];
    let lostReviewAck = false;
    const reserveReview = vi.fn(
      async (
        ...args: Parameters<ProjectApiRepository["reserveGrantFreezeReview"]>
      ) => {
        const input = args[3];
        const existing = durableReviews.find(
          (ack) =>
            ack.backendId === input.backendId &&
            ack.shareGrantId === input.shareGrantId
        );
        if (existing?.reviewedGrantVersion === input.reviewedGrantVersion)
          return existing;
        const reserved = {
          ...input,
          grantVersion: input.reviewedGrantVersion,
          state: "reserved" as const,
          actionGrantId: null,
          commandRequestId: randomUUID()
        };
        const index = existing ? durableReviews.indexOf(existing) : -1;
        if (index >= 0) durableReviews[index] = reserved;
        else durableReviews.push(reserved);
        return reserved;
      }
    );
    const freezeAck = vi.fn(
      async (
        ...args: Parameters<ProjectApiRepository["recordGrantFreezeAck"]>
      ) => {
        const ack = args[3];
        if (
          options.loseReviewAck &&
          !lostReviewAck &&
          ack.state === "review_required"
        ) {
          lostReviewAck = true;
          throw new Error("review ack interrupted");
        }
        const index = durableReviews.findIndex(
          (item) =>
            item.backendId === ack.backendId &&
            item.shareGrantId === ack.shareGrantId
        );
        if (index >= 0) durableReviews[index] = ack;
        else durableReviews.push(ack);
        return ack;
      }
    );
    const repository = {
      recordBackendAck: backendAck,
      reserveGrantFreezeReview: reserveReview,
      recordGrantFreezeAck: freezeAck,
      getDeleteOperationByBatch: vi.fn(async () => ({
        ...operation,
        grantFreezeAcks: [...durableReviews]
      })),
      get: vi.fn(async () => ({
        ...operation,
        grantFreezeAcks: [...durableReviews]
      }))
    } as unknown as ProjectApiRepository;
    const coordinator = createProjectSourceCoordinator({
      repository,
      sourceRemovalRepository: options.sourceRemoval
        ? (repository as unknown as ProjectSourceRemovalRepository)
        : null,
      sharedMemoryControl: shared,
      actionGrantControl: action,
      resolveSourceIdentity: () => ({
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId: owner
      })
    });
    return {
      coordinator,
      remote,
      backendAck,
      freezeAck,
      action,
      actionDispatch,
      repository,
      get actionCount() {
        return actionCount;
      }
    };
  };

  it("reserves a never-materialized exact source and seals only after proving zero grants", async () => {
    const { coordinator, remote, backendAck, freezeAck } = fixture(null);
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation
    });
    expect(
      remote.mock.calls.some(
        ([request]) =>
          request.method === "POST" && request.body?.operation === "prepare"
      )
    ).toBe(true);
    expect(
      remote.mock.calls.some(
        ([request]) =>
          request.method === "POST" && request.body?.operation === "seal"
      )
    ).toBe(true);
    expect(backendAck).toHaveBeenLastCalledWith(
      owner,
      projectId,
      batchId,
      expect.objectContaining({
        logicalMemoryId,
        backendId,
        generation: 1,
        sealed: true
      })
    );
    expect(freezeAck).not.toHaveBeenCalled();
  });

  it("leaves each active grant pending for its own Native review", async () => {
    const grant = {
      id: randomUUID(),
      teamId: randomUUID(),
      teamWorkspaceId: randomUUID(),
      grantVersion: 2
    };
    const { coordinator, remote, freezeAck } = fixture(grant);
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation
    });
    expect(freezeAck).toHaveBeenCalledWith(
      owner,
      projectId,
      batchId,
      expect.objectContaining({
        shareGrantId: grant.id,
        state: "review_required"
      })
    );
    expect(
      remote.mock.calls.some(
        ([request]) =>
          request.method === "POST" && request.path.endsWith("/freeze")
      )
    ).toBe(false);
    expect(
      remote.mock.calls.some(
        ([request]) =>
          request.method === "POST" && request.body?.operation === "seal"
      )
    ).toBe(false);
  });
  it("freezes two grants on one Source Note root with distinct Native reviews", async () => {
    const grants = [
      {
        id: randomUUID(),
        teamId: randomUUID(),
        teamWorkspaceId: randomUUID(),
        grantVersion: 2
      },
      {
        id: randomUUID(),
        teamId: randomUUID(),
        teamWorkspaceId: randomUUID(),
        grantVersion: 5
      }
    ];
    const { coordinator, remote, freezeAck, actionDispatch } = fixture(grants, {
      review: "approved",
      sourceRemoval: true
    });
    const sourceOperation = {
      sourceRemoval: true as const,
      batchId,
      projectId,
      ownerUserId: owner,
      sourceId: randomUUID(),
      state: "preparing",
      sourceManifestHash: "a".repeat(64),
      sources: [
        {
          kind: "personal_note" as const,
          noteId: randomUUID(),
          noteRevision: 2,
          memoryEventId: randomUUID(),
          logicalMemoryId,
          backends: [{ backendId, relationshipIds: [] }]
        }
      ],
      backendAcks: [],
      grantFreezeAcks: []
    };
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation: sourceOperation
    });
    const frozenIds = freezeAck.mock.calls
      .map((call) => call[3])
      .filter((ack) => ack.state === "frozen")
      .map((ack) => ack.shareGrantId);
    expect(frozenIds.sort()).toEqual(grants.map((grant) => grant.id).sort());
    const nativeCommands = actionDispatch.mock.calls
      .map((call) => call[0].input.intent)
      .filter(
        (intent) =>
          intent?.intent === "collaboration.freeze_shared_memory_grant"
      );
    expect(
      new Set(nativeCommands.map((intent) => intent?.commandRequestId)).size
    ).toBe(2);
    expect(
      remote.mock.calls.filter(
        ([request]) =>
          request.method === "POST" && request.path.endsWith("/freeze")
      )
    ).toHaveLength(2);
  });
  it("releases only the old sealed admission hold after restore", async () => {
    const { coordinator, remote, backendAck } = fixture(null);
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation
    });
    expect(
      await coordinator.cancel({
        ownerUserId: owner,
        projectId,
        batchId,
        operation
      })
    ).toBe(true);
    expect(
      remote.mock.calls.some(
        ([request]) =>
          request.method === "POST" && request.body?.operation === "cancel"
      )
    ).toBe(true);
    expect(backendAck).toHaveBeenLastCalledWith(
      owner,
      projectId,
      batchId,
      expect.objectContaining({ cancelled: true, generation: 1, sealed: false })
    );
  });
  it("freezes an independently approved exact grant, re-reads zero active grants, then seals", async () => {
    const grant = {
      id: randomUUID(),
      teamId: randomUUID(),
      teamWorkspaceId: randomUUID(),
      grantVersion: 2
    };
    const { coordinator, remote, backendAck, freezeAck } = fixture(grant, {
      review: "approved"
    });
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation
    });
    const paths = remote.mock.calls.map(
      ([request]) => `${request.method} ${request.path}`
    );
    const freezeIndex = paths.findIndex((path) => path.endsWith("/freeze"));
    const sealIndex = remote.mock.calls.findIndex(
      ([request]) => request.body?.operation === "seal"
    );
    expect(freezeIndex).toBeGreaterThan(-1);
    expect(sealIndex).toBeGreaterThan(freezeIndex);
    expect(
      paths
        .slice(freezeIndex + 1, sealIndex)
        .some((path) => path.endsWith("/admission/grants"))
    ).toBe(true);
    expect(freezeAck).toHaveBeenCalledWith(
      owner,
      projectId,
      batchId,
      expect.objectContaining({ shareGrantId: grant.id, state: "frozen" })
    );
    expect(backendAck).toHaveBeenLastCalledWith(
      owner,
      projectId,
      batchId,
      expect.objectContaining({ sealed: true })
    );
  });
  it("reconciles a lost freeze response from read-only grant status before sealing", async () => {
    const grant = {
      id: randomUUID(),
      teamId: randomUUID(),
      teamWorkspaceId: randomUUID(),
      grantVersion: 2
    };
    const { coordinator, remote, backendAck } = fixture(grant, {
      review: "approved",
      loseFreezeResponse: true
    });
    await expect(
      coordinator.advance({ ownerUserId: owner, projectId, batchId, operation })
    ).rejects.toThrow("freeze response lost");
    expect(
      remote.mock.calls.some(([request]) => request.body?.operation === "seal")
    ).toBe(false);
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation
    });
    expect(
      remote.mock.calls.filter(([request]) => request.path.endsWith("/freeze"))
    ).toHaveLength(1);
    expect(backendAck).toHaveBeenLastCalledWith(
      owner,
      projectId,
      batchId,
      expect.objectContaining({ sealed: true })
    );
  });
  it("requests a new Native decision when the exact grant version changes", async () => {
    const grant = {
      id: randomUUID(),
      teamId: randomUUID(),
      teamWorkspaceId: randomUUID(),
      grantVersion: 2
    };
    const { coordinator, freezeAck, action } = fixture(grant);
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation
    });
    const first = freezeAck.mock.calls[0]![3];
    const changed = { ...operation, grantFreezeAcks: [first] };
    grant.grantVersion = 3;
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation: changed
    });
    const second = freezeAck.mock.calls.at(-1)![3];
    expect(second).toMatchObject({ grantVersion: 3, state: "review_required" });
    expect(second.commandRequestId).not.toBe(first.commandRequestId);
    expect(second.actionGrantId).not.toBe(first.actionGrantId);
    expect(action.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "collaboration.request_action_grant"
      }),
      expect.anything()
    );
  });
  it("reuses a reserved Native command after remote creation but before local acknowledgment", async () => {
    const grant = {
      id: randomUUID(),
      teamId: randomUUID(),
      teamWorkspaceId: randomUUID(),
      grantVersion: 2
    };
    const { coordinator, actionDispatch, freezeAck, repository } = fixture(
      grant,
      {
        loseReviewAck: true
      }
    );
    await expect(
      coordinator.advance({ ownerUserId: owner, projectId, batchId, operation })
    ).rejects.toThrow("review ack interrupted");
    const firstCommand = actionDispatch.mock.calls.find(
      ([command]) =>
        command.input.intent?.intent ===
        "collaboration.freeze_shared_memory_grant"
    )?.[0].input.intent?.commandRequestId;
    expect(firstCommand).toBeTruthy();
    const retained = await repository.getDeleteOperationByBatch(
      owner,
      projectId,
      batchId
    );
    expect(retained?.grantFreezeAcks[0]).toMatchObject({
      commandRequestId: firstCommand,
      state: "reserved",
      actionGrantId: null
    });
    await coordinator.advance({
      ownerUserId: owner,
      projectId,
      batchId,
      operation
    });
    const freezeRequests = actionDispatch.mock.calls.filter(
      ([command]) =>
        command.input.intent?.intent ===
        "collaboration.freeze_shared_memory_grant"
    );
    expect(freezeRequests).toHaveLength(2);
    expect(
      new Set(
        freezeRequests.map(
          ([command]) => command.input.intent?.commandRequestId
        )
      ).size
    ).toBe(1);
    expect(freezeAck).toHaveBeenLastCalledWith(
      owner,
      projectId,
      batchId,
      expect.objectContaining({
        commandRequestId: firstCommand,
        state: "review_required"
      })
    );
  });
});
