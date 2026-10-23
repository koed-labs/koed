import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  crossIdentitySyncDigest,
  sharingSelectionDescriptor,
  crossIdentitySyncDeterministicUuid,
  sharedMemoryCandidatePreviewSchema,
  repositorySharingRuleCreationLocalIntentSchema
} from "@koed/shared";
import type { SelectionSharingSourceLease } from "@koed/db";
import {
  deliverSelectionSharingSources,
  type SelectionSharingDeliveryTransport
} from "./selection-sharing-delivery.js";

const fixture = (
  desired: "present" | "removed" = "removed",
  selectorKind: "repository" | "folder" | "project" = "repository"
) => {
  const ruleId = randomUUID(),
    logicalMemoryId = randomUUID(),
    sessionId = randomUUID(),
    mutationId = randomUUID();
  const identity = {
    backendId: "team-local",
    localOwnerUserId: randomUUID(),
    upstreamUserId: randomUUID()
  };
  const intent = repositorySharingRuleCreationLocalIntentSchema.parse({
    mutationId: randomUUID(),
    ruleId,
    teamId: randomUUID(),
    teamWorkspaceId: randomUUID(),
    selector: { kind: "portable_repository", key: "gr_delivery" },
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    includesFutureConversations: true,
    selectionSnapshotVersion: randomUUID(),
    completedReviewHash: "a".repeat(64),
    teamPolicyVersion: 1,
    teamPolicyHash: "b".repeat(64),
    workspacePolicyVersion: 1,
    workspacePolicyHash: "c".repeat(64),
    effectivePrivacyPolicyHash: "d".repeat(64),
    review: {
      teamId: randomUUID(),
      workspaceId: randomUUID(),
      representation: "memory_events",
      completionToken: "gsc1_delivery",
      target: {
        kind: "repository",
        repository: {
          kind: "portable_repository",
          key: "gr_delivery",
          root: "/private/anchor",
          branch: null,
          reason: "origin",
          checkoutId: null,
          originatingDeviceId: "capture",
          selectedRemote: "origin",
          anchorDisplay: "Private anchor"
        }
      }
    }
  });
  intent.review.teamId = intent.teamId;
  intent.review.workspaceId = intent.teamWorkspaceId;
  if (selectorKind === "folder") {
    intent.review.target = {
      kind: "folder",
      folder: {
        ownerUserId: identity.localOwnerUserId,
        folderId: "exact-folder",
        originatingDeploymentId: "capture",
        originatingDeviceId: "capture",
        originatingProfileId: "profile",
        directoryIncarnationId: "directory-incarnation"
      }
    };
    intent.selector = sharingSelectionDescriptor(intent.review.target);
  }
  if (selectorKind === "project") {
    intent.review.target = {
      kind: "project",
      project: {
        ownerUserId: identity.localOwnerUserId,
        projectId: randomUUID()
      }
    };
    intent.selector = sharingSelectionDescriptor(intent.review.target);
  }
  const source = {
    localSessionId: sessionId,
    localLogicalSessionId: randomUUID(),
    portable: null,
    identityState: "local_only" as const,
    contextVersion: { git: 1, folder: 1 }
  };
  const originalGoal = {
    source,
    desired: "present" as const,
    snapshotVersion: randomUUID(),
    contextHash: "e".repeat(64)
  };
  const goal = { ...originalGoal, desired };
  const membershipId = crossIdentitySyncDeterministicUuid({
    kind: "sharing_rule_member",
    ruleId,
    logicalMemoryId
  });
  const body = {
    mutationId,
    logicalGrantId: randomUUID(),
    consentId: randomUUID(),
    logicalMemoryId,
    source: { kind: "captured_session", sessionId, logicalMemoryId },
    sourceCapabilities: ["memory_events"],
    activationRepresentation: "memory_events",
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    mode: "continuous",
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    expiresAt: null,
    preview: { previewId: randomUUID(), previewHash: "f".repeat(64) },
    previewRevision: 1,
    membership: {
      selectionSnapshotVersion: originalGoal.snapshotVersion,
      sourceContextHash: originalGoal.contextHash,
      selectorBindingHash: crossIdentitySyncDigest(intent.selector),
      gitContextVersion: 1,
      folderContextVersion: 1,
      expectedAuthorityVersion: 1,
      expectedMembershipVersion: 0,
      expectedGrantVersion: null,
      publisherFence: 1
    }
  };
  const request = {
    kind: "admit" as const,
    logicalMemoryId,
    membershipId,
    body
  };
  const attempt = {
    deliveryEpoch: 0,
    ...request,
    mutationId,
    goalHash: crossIdentitySyncDigest({
      source,
      desired: "present",
      contextHash: originalGoal.contextHash
    }),
    requestHash: crossIdentitySyncDigest(request)
  };
  const generation = randomUUID();
  const progress = {
    version: 1 as const,
    identity,
    remoteDeviceId: randomUUID(),
    intent,
    currentGeneration: generation,
    changeCursor: randomUUID(),
    proposal: null
  };
  const lease: SelectionSharingSourceLease = {
    deliveryEpoch: 0,
    progressId: randomUUID(),
    sourceId: randomUUID(),
    leaseVersion: 1,
    identity,
    remoteDeviceId: progress.remoteDeviceId,
    progress,
    goal,
    goalHash: crossIdentitySyncDigest({
      source,
      desired,
      contextHash: goal.contextHash
    }),
    data: {
      sourceKey: crossIdentitySyncDigest({
        localSessionId: sessionId,
        localLogicalSessionId: source.localLogicalSessionId
      }),
      current: goal,
      proposed: null,
      currentGeneration: generation,
      proposedGeneration: null,
      attempt,
      remote: null
    }
  };
  const receipt = {
    pendingShareId: randomUUID(),
    membershipId,
    membershipVersion: 1,
    authorityVersion: 1,
    publisherFence: 1,
    sourceRevision: 3
  };
  const journal = {
    recordDetailScope: vi.fn().mockResolvedValue(false),
    recordContentPolicyScope: vi.fn().mockResolvedValue(false),
    claimSources: vi.fn().mockResolvedValue([lease]),
    resolveNativeSource: vi
      .fn()
      .mockResolvedValue({ logicalMemoryId, sessionId }),
    resolveExistingSource: vi.fn().mockResolvedValue(null),
    persistAttempt: vi.fn().mockResolvedValue(attempt),
    acknowledgeSource: vi.fn().mockResolvedValue(undefined),
    cancelAttempt: vi.fn().mockResolvedValue(undefined),
    deferSource: vi.fn().mockResolvedValue(undefined)
  };
  const transport: SelectionSharingDeliveryTransport = {
    deploymentProtocolId: randomUUID(),
    inspect: vi.fn(),
    prepareAdmission: vi.fn(),
    send: vi.fn().mockResolvedValue({ admission: receipt }),
    cancel: vi.fn(),
    queueSource: vi.fn().mockResolvedValue(undefined)
  };
  const run = () =>
    deliverSelectionSharingSources({
      journal,
      localOwnerUserId: identity.localOwnerUserId,
      resolveTransport: async () => transport
    });
  return { lease, attempt, receipt, journal, transport, run };
};

describe.each(["repository", "folder", "project"] as const)(
  "selection sharing exact delivery" + ": %s",
  (selectorKind) => {
    it.each([
      "present",
      "missing_mapping",
      "unready",
      "removed_member",
      "absent_member"
    ] as const)(
      "keeps a receiving checkpoint within its existing source authority: %s",
      async (availability) => {
        const f = fixture("present", selectorKind);
        f.lease.data.attempt = null;
        const sourceIdentity = {
          originatingDeploymentId: "signed-original-deployment",
          originatingDeviceId: "signed-original-device",
          logicalSessionId: "signed-original-conversation"
        };
        f.lease.goal.source.portable = {
          ...sourceIdentity,
          ownerUserId: f.lease.identity.localOwnerUserId
        };
        f.lease.goal.source.identityState = "verified";
        f.journal.resolveNativeSource.mockResolvedValue(null);
        f.journal.resolveExistingSource.mockResolvedValue(
          availability === "unready" ? null : sourceIdentity
        );
        f.transport.resolvePortableSource = vi
          .fn()
          .mockResolvedValue(
            availability === "missing_mapping"
              ? null
              : f.attempt.logicalMemoryId
          );
        const intent = f.lease.progress.intent;
        vi.mocked(f.transport.inspect).mockResolvedValue({
          ruleId: intent.ruleId,
          state: "active",
          authorityVersion: 3,
          publisherFence: 2,
          selectorBindingHash: crossIdentitySyncDigest(intent.selector),
          effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash,
          teamId: intent.teamId,
          teamWorkspaceId: intent.teamWorkspaceId,
          maximumFidelity: intent.maximumFidelity,
          includeCuratedMemory: false,
          entries: [
            {
              logicalMemoryId: f.attempt.logicalMemoryId,
              workspaceExcluded: false,
              grant: null,
              member:
                availability === "absent_member"
                  ? null
                  : {
                      id: f.attempt.membershipId,
                      version: 1,
                      state:
                        availability === "removed_member"
                          ? "removed"
                          : "present",
                      selectionSnapshotVersion: randomUUID(),
                      sourceContextHash: f.lease.goal.contextHash,
                      gitContextVersion: 1,
                      folderContextVersion: 1,
                      pendingShare: null
                    }
            }
          ]
        });
        const result = await f.run();
        expect(result.acknowledged).toBe(availability === "present" ? 1 : 0);
        expect(f.transport.prepareAdmission).not.toHaveBeenCalled();
        expect(f.transport.queueSource).not.toHaveBeenCalled();
        expect(f.transport.send).not.toHaveBeenCalled();
        expect(f.journal.persistAttempt).not.toHaveBeenCalled();
        if (availability !== "present")
          expect(f.journal.deferSource).toHaveBeenCalledOnce();
        if (availability === "unready")
          expect(f.transport.resolvePortableSource).not.toHaveBeenCalled();
      }
    );
    it.each([
      "accepted",
      "lost_response",
      "canceled",
      "replay",
      "pending_recovery",
      "native_pending",
      "healthy_pending",
      "context_recovery"
    ] as const)(
      "delivers retained-source re-entry without a native upload: %s",
      async (outcome) => {
        const f = fixture("present", selectorKind);
        f.lease.data.attempt = null;
        const sourceIdentity = {
          originatingDeploymentId: "native-A",
          originatingDeviceId: "device-A",
          logicalSessionId: "conversation-A"
        };
        f.journal.resolveNativeSource.mockResolvedValue(null);
        f.journal.resolveExistingSource.mockResolvedValue(sourceIdentity);
        f.transport.resolvePortableSource = vi
          .fn()
          .mockResolvedValue(f.attempt.logicalMemoryId);
        const intent = f.lease.progress.intent;
        vi.mocked(f.transport.inspect).mockResolvedValue({
          ruleId: intent.ruleId,
          state: "active",
          authorityVersion: 3,
          publisherFence: 2,
          selectorBindingHash: crossIdentitySyncDigest(intent.selector),
          effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash,
          teamId: intent.teamId,
          teamWorkspaceId: intent.teamWorkspaceId,
          maximumFidelity: intent.maximumFidelity,
          includeCuratedMemory: false,
          entries: [
            {
              logicalMemoryId: f.attempt.logicalMemoryId,
              workspaceExcluded: false,
              grant:
                outcome === "native_pending"
                  ? null
                  : {
                      id: randomUUID(),
                      logicalGrantId: randomUUID(),
                      version: 5,
                      lifecycle: "active"
                    },
              member: {
                id: f.attempt.membershipId,
                version: 1,
                state: [
                  "pending_recovery",
                  "native_pending",
                  "healthy_pending",
                  "context_recovery"
                ].includes(outcome)
                  ? "unresolved"
                  : "removed",
                selectionSnapshotVersion: randomUUID(),
                sourceContextHash:
                  outcome === "context_recovery"
                    ? "a".repeat(64)
                    : f.lease.goal.contextHash,
                gitContextVersion: 1,
                folderContextVersion: 1,
                pendingShare: [
                  "pending_recovery",
                  "native_pending",
                  "healthy_pending",
                  "context_recovery"
                ].includes(outcome)
                  ? {
                      id: randomUUID(),
                      state: "preparing",
                      requiresReadmission:
                        outcome === "pending_recovery" ||
                        outcome === "native_pending"
                    }
                  : null
              }
            }
          ]
        });
        const receipt = {
          ...f.receipt,
          membershipVersion: 2,
          authorityVersion: 3,
          publisherFence: 2
        };
        f.journal.persistAttempt.mockImplementation(
          async (_lease, request) => request
        );
        vi.mocked(f.transport.send).mockResolvedValue({ admission: receipt });
        if (outcome === "lost_response") {
          vi.mocked(f.transport.send).mockRejectedValue(
            new Error("response lost")
          );
          vi.mocked(f.transport.cancel).mockImplementation(async (attempt) => ({
            ruleId: intent.ruleId,
            mutationId: attempt.mutationId,
            kind: attempt.kind,
            logicalMemoryId: attempt.logicalMemoryId,
            membershipId: attempt.membershipId,
            requestHash: attempt.requestHash,
            state: "accepted",
            receipt
          }));
        }
        if (outcome === "canceled") {
          vi.mocked(f.transport.send).mockRejectedValue(
            new Error("Source cache unavailable")
          );
          vi.mocked(f.transport.cancel).mockImplementation(async (attempt) => ({
            ruleId: intent.ruleId,
            mutationId: attempt.mutationId,
            kind: attempt.kind,
            logicalMemoryId: attempt.logicalMemoryId,
            membershipId: attempt.membershipId,
            requestHash: attempt.requestHash,
            state: "canceled"
          }));
          expect((await f.run()).acknowledged).toBe(0);
          const request = f.journal.persistAttempt.mock.calls[0]![1];
          expect(f.journal.cancelAttempt).toHaveBeenCalledExactlyOnceWith(
            f.lease,
            {
              mutationId: request.mutationId,
              requestHash: request.requestHash,
              retrySeconds: 30
            }
          );
          expect(f.transport.prepareAdmission).not.toHaveBeenCalled();
          expect(f.transport.queueSource).not.toHaveBeenCalled();
          return;
        }
        if (outcome === "healthy_pending") {
          expect((await f.run()).acknowledged).toBe(0);
          expect(f.journal.persistAttempt).not.toHaveBeenCalled();
          expect(f.transport.send).not.toHaveBeenCalled();
          expect(f.transport.prepareAdmission).not.toHaveBeenCalled();
          expect(f.transport.queueSource).not.toHaveBeenCalled();
          return;
        }
        expect((await f.run()).acknowledged).toBe(1);
        const request = f.journal.persistAttempt.mock.calls[0]![1];
        expect(request.sourceWorkMode).toBe("retained");
        expect(request.body).not.toHaveProperty("source");
        expect(request.body).not.toHaveProperty("preview");
        expect(request.body.membership).toMatchObject({
          sourceIdentity,
          expectedGrantVersion: outcome === "native_pending" ? null : 5
        });
        expect(
          f.journal.persistAttempt.mock.invocationCallOrder[0]
        ).toBeLessThan(
          vi.mocked(f.transport.send).mock.invocationCallOrder[0]!
        );
        if (outcome === "replay") {
          f.lease.data.attempt = request;
          f.lease.goal.desired = "removed";
          f.journal.resolveExistingSource.mockResolvedValue(null);
          expect((await f.run()).acknowledged).toBe(1);
          expect(f.journal.persistAttempt).toHaveBeenCalledTimes(1);
        }
        expect(f.transport.prepareAdmission).not.toHaveBeenCalled();
        expect(f.transport.queueSource).not.toHaveBeenCalled();
        expect(f.journal.acknowledgeSource).toHaveBeenCalledWith(
          f.lease,
          expect.objectContaining({ observePending: true })
        );
      }
    );
    it("journals a new eligible admission before sending its strict Pending Share request", async () => {
      const f = fixture("present", selectorKind);
      f.lease.data.attempt = null;
      const intent = f.lease.progress.intent;
      vi.mocked(f.transport.inspect).mockResolvedValue({
        ruleId: intent.ruleId,
        state: "active",
        authorityVersion: 1,
        publisherFence: 1,
        selectorBindingHash: crossIdentitySyncDigest(intent.selector),
        effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash,
        teamId: intent.teamId,
        teamWorkspaceId: intent.teamWorkspaceId,
        maximumFidelity: intent.maximumFidelity,
        includeCuratedMemory: false,
        entries: [
          {
            logicalMemoryId: f.attempt.logicalMemoryId,
            workspaceExcluded: false,
            grant: null,
            member: null
          }
        ]
      });
      const itemId = randomUUID();
      const candidate = sharedMemoryCandidatePreviewSchema.parse({
        source: f.attempt.body.source,
        logicalMemoryId: f.attempt.logicalMemoryId,
        sourceCapabilities: ["memory_events"],
        activationRepresentation: "memory_events",
        mode: "continuous",
        expiresAt: null,
        sourceRevision: 3,
        candidateHash: "b".repeat(64),
        itemCount: 1,
        excludedItemCount: 0,
        manifest: [{ sourceId: itemId, revisionHash: "c".repeat(64) }],
        byteCount: 100,
        items: [
          {
            id: itemId,
            representation: "memory_events",
            sequence: 1,
            occurredAt: "2026-10-20T12:00:00.000Z",
            sourceItems: [
              {
                id: itemId,
                sourceKind: "agent_message",
                occurredAt: "2026-10-20T12:00:00.000Z",
                body: "Shared evidence",
                actorName: null,
                toolName: null,
                toolCallId: null
              }
            ]
          }
        ]
      });
      vi.mocked(f.transport.prepareAdmission).mockResolvedValue({
        candidate,
        previewId: randomUUID(),
        previewHash: "d".repeat(64),
        previewRevision: 1
      });
      f.journal.persistAttempt.mockImplementation(
        async (_lease, attempt) => attempt
      );
      expect((await f.run()).acknowledged).toBe(1);
      expect(f.journal.resolveNativeSource).toHaveBeenCalledExactlyOnceWith(
        f.lease,
        f.transport.deploymentProtocolId
      );
      const request = f.journal.persistAttempt.mock.calls[0]![1];
      expect(request.body.membership).not.toHaveProperty("mutationId");
      expect(request.body.membership).not.toHaveProperty("ruleId");
      expect(request.body).not.toHaveProperty("authority");
      expect(f.transport.send).toHaveBeenCalledExactlyOnceWith(request);
      expect(f.journal.persistAttempt.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(f.transport.send).mock.invocationCallOrder[0]!
      );
    });
    it("retains an excluded admission goal without previewing or sending it", async () => {
      const f = fixture("present", selectorKind);
      f.lease.data.attempt = null;
      const intent = f.lease.progress.intent;
      vi.mocked(f.transport.inspect).mockResolvedValue({
        ruleId: intent.ruleId,
        state: "active",
        authorityVersion: 1,
        publisherFence: 1,
        selectorBindingHash: crossIdentitySyncDigest(intent.selector),
        effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash,
        teamId: intent.teamId,
        teamWorkspaceId: intent.teamWorkspaceId,
        maximumFidelity: intent.maximumFidelity,
        includeCuratedMemory: false,
        entries: [
          {
            logicalMemoryId: f.attempt.logicalMemoryId,
            workspaceExcluded: true,
            grant: null,
            member: null
          }
        ]
      });
      expect((await f.run()).acknowledged).toBe(0);
      expect(f.journal.deferSource).toHaveBeenCalledExactlyOnceWith(
        f.lease,
        60
      );
      expect(f.journal.acknowledgeSource).not.toHaveBeenCalled();
      expect(f.transport.prepareAdmission).not.toHaveBeenCalled();
      expect(f.transport.send).not.toHaveBeenCalled();
    });
    it("does not preview or admit an unavailable native source", async () => {
      const f = fixture("present", selectorKind);
      f.lease.data.attempt = null;
      f.journal.resolveNativeSource.mockResolvedValue(null);
      expect((await f.run()).acknowledged).toBe(0);
      expect(f.transport.inspect).not.toHaveBeenCalled();
      expect(f.transport.prepareAdmission).not.toHaveBeenCalled();
      expect(f.transport.send).not.toHaveBeenCalled();
      expect(f.journal.deferSource).toHaveBeenCalledExactlyOnceWith(f.lease);
    });
    it("settles an older accepted admission before handling a newer removal goal", async () => {
      const f = fixture("removed", selectorKind);
      expect(await f.run()).toEqual({ processed: 1, acknowledged: 1 });
      expect(f.transport.send).toHaveBeenCalledExactlyOnceWith(f.attempt);
      expect(f.journal.resolveNativeSource).not.toHaveBeenCalled();
      expect(f.transport.prepareAdmission).not.toHaveBeenCalled();
      expect(f.transport.queueSource).toHaveBeenCalledExactlyOnceWith({
        pendingShareId: f.receipt.pendingShareId,
        mutationId: f.attempt.mutationId,
        source: f.attempt.body.source,
        sourceRevision: 3
      });
      expect(f.journal.acknowledgeSource).toHaveBeenCalledWith(
        f.lease,
        expect.objectContaining({ mutationId: f.attempt.mutationId })
      );
      expect(f.journal.cancelAttempt).not.toHaveBeenCalled();
    });
    it("recovers an accepted receipt after an unknown remote outcome", async () => {
      const f = fixture("removed", selectorKind);
      vi.mocked(f.transport.send).mockRejectedValue(new Error("response lost"));
      // Settlement is a strict wire DTO, without local attempt fields.
      vi.mocked(f.transport.cancel).mockResolvedValue({
        mutationId: f.attempt.mutationId,
        kind: f.attempt.kind,
        logicalMemoryId: f.attempt.logicalMemoryId,
        membershipId: f.attempt.membershipId,
        requestHash: f.attempt.requestHash,
        ruleId: f.lease.progress.intent.ruleId,
        state: "accepted",
        receipt: f.receipt
      });
      expect((await f.run()).acknowledged).toBe(1);
      expect(f.transport.cancel).toHaveBeenCalledExactlyOnceWith(f.attempt);
      expect(f.journal.cancelAttempt).not.toHaveBeenCalled();
    });
    it("clears only a proven canceled attempt and leaves the newer goal unacknowledged", async () => {
      const f = fixture("removed", selectorKind);
      vi.mocked(f.transport.send).mockRejectedValue(
        new Error("candidate expired")
      );
      vi.mocked(f.transport.cancel).mockResolvedValue({
        mutationId: f.attempt.mutationId,
        kind: f.attempt.kind,
        logicalMemoryId: f.attempt.logicalMemoryId,
        membershipId: f.attempt.membershipId,
        requestHash: f.attempt.requestHash,
        ruleId: f.lease.progress.intent.ruleId,
        state: "canceled"
      });
      expect((await f.run()).acknowledged).toBe(0);
      expect(f.journal.cancelAttempt).toHaveBeenCalledExactlyOnceWith(f.lease, {
        mutationId: f.attempt.mutationId,
        requestHash: f.attempt.requestHash
      });
      expect(f.journal.acknowledgeSource).not.toHaveBeenCalled();
      expect(f.transport.queueSource).not.toHaveBeenCalled();
    });
    it("retains the original request when settlement is unavailable", async () => {
      const f = fixture("removed", selectorKind);
      vi.mocked(f.transport.send).mockRejectedValue(new Error("offline"));
      vi.mocked(f.transport.cancel).mockRejectedValue(new Error("offline"));
      expect((await f.run()).acknowledged).toBe(0);
      expect(f.journal.cancelAttempt).not.toHaveBeenCalled();
      expect(f.journal.acknowledgeSource).not.toHaveBeenCalled();
      expect(f.journal.deferSource).toHaveBeenCalledExactlyOnceWith(f.lease);
    });
  }
);
