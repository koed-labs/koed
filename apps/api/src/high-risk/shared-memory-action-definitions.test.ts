import { randomUUID } from "node:crypto";
import {
  sharedMemoryFidelityBundleActionGrantBinding,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import { admitHighRiskActionGrant } from "./action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";
import {
  highRiskActionGrantIntentSchema,
  type HighRiskActionGrantIntent
} from "./action-grant-protocol.js";

const ids = {
  actor: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
  logicalMemory: randomUUID(),
  replica: randomUUID(),
  preview: randomUUID(),
  consent: randomUUID(),
  logicalGrant: randomUUID(),
  shareGrant: randomUUID(),
  mutation: randomUUID(),
  request: randomUUID()
};

const source = {
  logicalMemoryId: ids.logicalMemory,
  title: "Architecture review",
  ownerPrincipalId: ids.actor
};
const destination = {
  team: { id: ids.team, name: "Koed Team" },
  workspace: { id: ids.workspace, name: "Engineering" }
};

const repository = () => ({
  getSharedMemoryCandidatePreviewAdmission: vi.fn(async (_actor, input) => ({
    effectivePolicyIntersection: input.allowedRepresentations,
    teamPolicyVersion: 1,
    teamPolicyHash: "a".repeat(64),
    workspacePolicyVersion: 1,
    workspacePolicyHash: "a".repeat(64)
  })),
  getSharedMemoryPreviewAdmission: vi.fn(async (_actor, input) => ({
    source,
    ...destination,
    remoteReplicaId: input.remoteReplicaId,
    representation: input.representation,
    requestedMaximumFidelity: input.maximumFidelity,
    requestedIncludeCuratedMemory: input.includeCuratedMemory,
    effectiveMaximumFidelity: input.maximumFidelity,
    effectiveIncludeCuratedMemory: input.includeCuratedMemory,
    sourceOwnerPolicyWillChange: false
  })),
  getSharedMemoryShareReview: vi.fn(async (_actor, input) => ({
    source,
    ...destination,
    preview: {
      previewId: input.preview.previewId,
      previewHash: input.preview.previewHash,
      previewRevision: input.previewRevision,
      remoteReplicaId: ids.replica,
      representation: input.maximumFidelity,
      sourceRevision: 4
    },
    maximumFidelity: input.maximumFidelity,
    includeCuratedMemory: input.includeCuratedMemory,
    sourceOwnerPolicyWillActivate: false,
    sourceOwnerPolicyWillReplace: false
  })),
  getSharedMemoryPendingShareReview: vi.fn(async (_actor, input) => ({
    source,
    ...destination,
    preview: {
      previewId: input.preview.previewId,
      previewHash: input.preview.previewHash,
      previewRevision: input.previewRevision,
      representation: input.selectedRepresentation,
      sourceRevision: 4
    },
    effectivePolicyIntersection: input.allowedRepresentations,
    sourceOwnerPolicyWillActivate: true as const,
    sourceOwnerPolicyWillReplace: false as const
  })),
  getSharedMemoryRevokeReview: vi.fn(async (_actor, input) => ({
    source: {
      logicalMemoryId: ids.logicalMemory,
      title: source.title
    },
    ...destination,
    grant: {
      id: input.shareGrantId,
      grantVersion: input.expectedGrantVersion,
      lifecycle: "active" as const,
      maximumFidelity: "lcm_leaves" as const,
      includeCuratedMemory: false
    }
  })),
  getSharedMemoryFidelityChangeReview: vi.fn(async (_actor, input) => ({
    source,
    ...destination,
    preview: {
      previewId: input.preview.previewId,
      previewHash: input.preview.previewHash,
      previewRevision: input.previewRevision,
      remoteReplicaId: ids.replica,
      representation: input.maximumFidelity,
      sourceRevision: 4
    },
    maximumFidelity: input.maximumFidelity,
    includeCuratedMemory: input.includeCuratedMemory,
    sourceOwnerPolicyWillActivate: false,
    sourceOwnerPolicyWillReplace: false,
    grant: {
      id: input.shareGrantId,
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      grantVersion: input.expectedGrantVersion,
      lifecycle: "active" as const,
      maximumFidelity: "lcm_leaves" as const,
      includeCuratedMemory: false
    },
    willReactivate: false
  })),
  getTeamConversationSourceGrantReview: vi.fn(async (_actor, input) => ({
    shareGrantId: input.shareGrantId,
    logicalMemoryId: ids.logicalMemory,
    sourceTitle: source.title,
    teamId: ids.team,
    teamName: destination.team.name,
    teamWorkspaceId: ids.workspace,
    teamWorkspaceName: destination.workspace.name,
    currentVersion: input.expectedVersion,
    currentMode: input.expectedVersion === 0 ? null : "continuous",
    currentLifecycle: input.expectedVersion === 0 ? null : "active"
  }))
});

const admit = (intent: HighRiskActionGrantIntent, repo = repository()) =>
  admitHighRiskActionGrant({
    repository: repo as never,
    userId: ids.actor,
    clientRequestId: ids.request,
    hashSecret: (value) => value,
    intent
  });

const shareIntent = (
  maximumFidelity: "lcm_rollups" | "lcm_leaves" | "memory_events",
  includeCuratedMemory = false
) =>
  ({
    action: "shared_memory.share",
    mutationId: ids.mutation,
    logicalGrantId: ids.logicalGrant,
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    consentId: ids.consent,
    previewId: ids.preview,
    mode: "snapshot",
    maximumFidelity,
    includeCuratedMemory,
    previewRevision: 1,
    previewHash: "a".repeat(64),
    expiresAt: null
  }) as const satisfies HighRiskActionGrantIntent;

const fidelityIntent = (
  maximumFidelity: "lcm_rollups" | "lcm_leaves" | "memory_events",
  includeCuratedMemory = false
) =>
  ({
    action: "shared_memory.change_fidelity",
    mutationId: ids.mutation,
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    shareGrantId: ids.shareGrant,
    consentId: ids.consent,
    previewId: ids.preview,
    maximumFidelity,
    includeCuratedMemory,
    expectedGrantVersion: 7,
    mode: "continuous",
    previewRevision: 2,
    previewHash: "b".repeat(64),
    expiresAt: null
  }) as const satisfies HighRiskActionGrantIntent;

describe("Shared Memory action definitions", () => {
  it("admits an exact authoritative preview as Direct", async () => {
    const repo = repository();
    const intent = {
      action: "shared_memory.preview",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.replica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      representation: "lcm_rollups",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).resolves.toEqual({
      operation: sharedMemoryPreviewActionGrantBinding({
        referenceId: ids.request,
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        representation: "lcm_rollups",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false
      }),
      policy: { disposition: "direct", review: null }
    });
    expect(repo.getSharedMemoryPreviewAdmission).toHaveBeenCalledOnce();
  });

  it("binds Curated assertions as an explicit Shared Memory preview", async () => {
    const repo = repository();
    const intent = {
      action: "shared_memory.preview",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.replica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      representation: "curated_assertions",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: true
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent, repo);
    if (admitted === null) {
      throw new Error("Expected the Curated assertions preview to be admitted");
    }
    expect(admitted.operation).toEqual(
      sharedMemoryPreviewActionGrantBinding({
        referenceId: ids.request,
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        representation: "curated_assertions",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: true
      })
    );
  });

  it("keeps a preview direct when its policy proposal differs", async () => {
    const repo = repository();
    repo.getSharedMemoryPreviewAdmission.mockImplementationOnce(
      async (_actor, input) => ({
        source,
        ...destination,
        remoteReplicaId: input.remoteReplicaId,
        representation: input.representation,
        requestedMaximumFidelity: input.maximumFidelity,
        requestedIncludeCuratedMemory: input.includeCuratedMemory,
        effectiveMaximumFidelity: input.maximumFidelity,
        effectiveIncludeCuratedMemory: input.includeCuratedMemory,
        sourceOwnerPolicyWillChange: true
      })
    );
    const intent = {
      action: "shared_memory.preview",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.replica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      representation: "lcm_rollups",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).resolves.toEqual({
      operation: sharedMemoryPreviewActionGrantBinding({
        referenceId: ids.request,
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        representation: "lcm_rollups",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false
      }),
      policy: { disposition: "direct", review: null }
    });
  });

  it("binds consent and Share Grant creation in one decision and steps up raw Memory", async () => {
    const derived = shareIntent("lcm_rollups");
    const raw = shareIntent("memory_events");
    const rawRepository = repository();
    rawRepository.getSharedMemoryShareReview.mockImplementationOnce(
      async (actor, input) => ({
        ...(await repository().getSharedMemoryShareReview(actor, input)),
        sourceOwnerPolicyWillActivate: true,
        sourceOwnerPolicyWillReplace: true
      })
    );

    const admittedDerived = await admit(derived);
    const admittedRaw = await admit(raw, rawRepository);

    expect(admittedDerived).toMatchObject({
      operation: sharedMemoryShareBundleActionGrantBinding({
        referenceId: ids.request,
        mutationId: ids.mutation,
        logicalGrantId: ids.logicalGrant,
        consentId: ids.consent,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        previewId: ids.preview,
        previewRevision: 1,
        previewHash: "a".repeat(64),
        mode: "snapshot",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        expiresAt: null
      }),
      policy: { disposition: "native_review" }
    });
    expect(admittedRaw).toMatchObject({
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Maximum fidelity", value: "Memory Events" },
            { label: "Source policy", value: "Replace during this share" }
          ]),
          consequence: expect.stringContaining("invalidates other Share Grants")
        }
      }
    });
  });

  it("authorizes revocation from the exact source-owned grant without destination read state", async () => {
    const intent = {
      action: "shared_memory.revoke",
      mutationId: ids.mutation,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      shareGrantId: ids.shareGrant,
      expectedGrantVersion: 7,
      reasonCode: "owner_revoked"
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent);

    expect(admitted).toMatchObject({
      operation: sharedMemoryRevokeActionGrantBinding({
        referenceId: ids.request,
        mutationId: ids.mutation,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        shareGrantId: ids.shareGrant,
        expectedGrantVersion: 7,
        reasonCode: "owner_revoked"
      }),
      policy: {
        disposition: "native_review",
        review: {
          details: expect.arrayContaining([
            { label: "Personal Memory", value: source.title },
            { label: "Maximum fidelity", value: "LCM Leaves" },
            { label: "Share Grant", value: ids.shareGrant }
          ])
        }
      }
    });
  });

  it("steps up source sharing and uses Native review for source revocation", async () => {
    const grantIntent = {
      action: "shared_memory.conversation_source_grant",
      mutationId: ids.mutation,
      teamId: ids.team,
      shareGrantId: ids.shareGrant,
      expectedVersion: 0,
      mode: "continuous"
    } as const satisfies HighRiskActionGrantIntent;
    const revokeIntent = {
      action: "shared_memory.conversation_source_revoke",
      mutationId: ids.mutation,
      teamId: ids.team,
      shareGrantId: ids.shareGrant,
      expectedVersion: 1,
      reasonCode: "owner_revoked"
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(grantIntent)).resolves.toMatchObject({
      operation: sharedMemoryTranscriptAccessActionGrantBinding({
        referenceId: ids.request,
        mutationId: ids.mutation,
        teamId: ids.team,
        shareGrantId: ids.shareGrant,
        expectedVersion: 0,
        mode: "continuous"
      }),
      policy: { disposition: "step_up" }
    });
    await expect(admit(revokeIntent)).resolves.toMatchObject({
      operation: sharedMemoryTranscriptRevokeActionGrantBinding({
        referenceId: ids.request,
        mutationId: ids.mutation,
        teamId: ids.team,
        shareGrantId: ids.shareGrant,
        expectedVersion: 1,
        reasonCode: "owner_revoked"
      }),
      policy: { disposition: "native_review" }
    });
  });

  it("uses exact current fidelity for decrease, increase, and revoked reactivation", async () => {
    const decrease = await admit(fidelityIntent("lcm_rollups"));
    const increase = await admit(fidelityIntent("memory_events"));
    const curatedIncrease = await admit(fidelityIntent("lcm_leaves", true));
    const repo = repository();
    repo.getSharedMemoryFidelityChangeReview.mockImplementationOnce(
      async (_actor, input) =>
        ({
          ...(await repository().getSharedMemoryFidelityChangeReview(
            _actor,
            input
          ))!,
          grant: {
            id: input.shareGrantId,
            logicalMemoryId: input.logicalMemoryId,
            teamId: input.teamId,
            teamWorkspaceId: input.teamWorkspaceId,
            grantVersion: input.expectedGrantVersion,
            lifecycle: "revoked" as const,
            maximumFidelity: "lcm_leaves" as const,
            includeCuratedMemory: false
          },
          willReactivate: true
        }) as never
    );
    const reactivation = await admit(fidelityIntent("lcm_leaves"), repo);

    expect(decrease).toMatchObject({
      policy: { disposition: "native_review" }
    });
    expect(increase).toMatchObject({
      operation: sharedMemoryFidelityBundleActionGrantBinding({
        referenceId: ids.request,
        mutationId: ids.mutation,
        consentId: ids.consent,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        shareGrantId: ids.shareGrant,
        previewId: ids.preview,
        previewRevision: 2,
        previewHash: "b".repeat(64),
        mode: "continuous",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        expectedGrantVersion: 7,
        expiresAt: null
      }),
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Current maximum fidelity", value: "LCM Leaves" },
            { label: "New maximum fidelity", value: "Memory Events" }
          ])
        }
      }
    });
    expect(curatedIncrease).toMatchObject({
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Current Curated Memory", value: "Excluded" },
            { label: "New Curated Memory", value: "Included" }
          ])
        }
      }
    });
    expect(reactivation).toMatchObject({
      policy: {
        disposition: "native_review",
        review: { title: "Reactivate Shared Memory with this fidelity?" }
      }
    });
  });

  it("fails closed on missing review state and exposes no standalone consent action", async () => {
    const repo = repository();
    repo.getSharedMemoryShareReview.mockResolvedValueOnce(null as never);

    await expect(
      admit(shareIntent("lcm_rollups"), repo)
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
    expect(
      highRiskActionGrantIntentSchema.safeParse({
        action: "shared_memory.consent"
      }).success
    ).toBe(false);
  });
});
