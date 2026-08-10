import { randomUUID } from "node:crypto";
import {
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRepresentationBundleActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding
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
  getSharedMemoryPreviewAdmission: vi.fn(async (_actor, input) => ({
    source,
    ...destination,
    remoteReplicaId: input.remoteReplicaId,
    representation: input.representation,
    requestedAllowedRepresentations: input.allowedRepresentations,
    effectivePolicyIntersection: input.allowedRepresentations,
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
      representation: input.selectedRepresentation,
      sourceRevision: 4
    },
    effectivePolicyIntersection: input.allowedRepresentations,
    sourceOwnerPolicyWillActivate: false,
    sourceOwnerPolicyWillReplace: false
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
      activeRepresentation: "lcm_leaves" as const
    }
  })),
  getSharedMemoryRepresentationChangeReview: vi.fn(async (_actor, input) => ({
    source,
    ...destination,
    preview: {
      previewId: input.preview.previewId,
      previewHash: input.preview.previewHash,
      previewRevision: input.previewRevision,
      remoteReplicaId: ids.replica,
      representation: input.representation,
      sourceRevision: 4
    },
    effectivePolicyIntersection: input.allowedRepresentations,
    sourceOwnerPolicyWillActivate: false,
    sourceOwnerPolicyWillReplace: false,
    grant: {
      id: input.shareGrantId,
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      grantVersion: input.expectedGrantVersion,
      lifecycle: "active" as const,
      activeRepresentation: "lcm_leaves" as const
    },
    willReactivate: false
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
  selectedRepresentation: "lcm_rollups" | "lcm_leaves" | "memory_events"
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
    allowedRepresentations: [selectedRepresentation],
    selectedRepresentation,
    previewRevision: 1,
    previewHash: "a".repeat(64),
    expiresAt: null
  }) as const satisfies HighRiskActionGrantIntent;

const representationIntent = (
  representation: "lcm_rollups" | "lcm_leaves" | "memory_events"
) =>
  ({
    action: "shared_memory.change_representation",
    mutationId: ids.mutation,
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    shareGrantId: ids.shareGrant,
    consentId: ids.consent,
    previewId: ids.preview,
    representation,
    expectedGrantVersion: 7,
    mode: "continuous",
    allowedRepresentations: ["lcm_rollups", "lcm_leaves", "memory_events"],
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
      allowedRepresentations: ["lcm_rollups"]
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).resolves.toEqual({
      operation: sharedMemoryPreviewActionGrantBinding({
        referenceId: ids.request,
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        representation: "lcm_rollups",
        allowedRepresentations: ["lcm_rollups"]
      }),
      policy: { disposition: "direct", review: null }
    });
    expect(repo.getSharedMemoryPreviewAdmission).toHaveBeenCalledOnce();
  });

  it("keeps a preview direct when its policy proposal differs", async () => {
    const repo = repository();
    repo.getSharedMemoryPreviewAdmission.mockImplementationOnce(
      async (_actor, input) => ({
        source,
        ...destination,
        remoteReplicaId: input.remoteReplicaId,
        representation: input.representation,
        requestedAllowedRepresentations: input.allowedRepresentations,
        effectivePolicyIntersection: input.allowedRepresentations,
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
      allowedRepresentations: ["lcm_rollups"]
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).resolves.toEqual({
      operation: sharedMemoryPreviewActionGrantBinding({
        referenceId: ids.request,
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        representation: "lcm_rollups",
        allowedRepresentations: ["lcm_rollups"]
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
        allowedRepresentations: ["lcm_rollups"],
        selectedRepresentation: "lcm_rollups",
        expiresAt: null
      }),
      policy: { disposition: "native_review" }
    });
    expect(admittedRaw).toMatchObject({
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Representation", value: "Memory Events" },
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
            { label: "Representation", value: "LCM Leaves" },
            { label: "Share Grant", value: ids.shareGrant }
          ])
        }
      }
    });
  });

  it("uses exact current fidelity for decrease, increase, and revoked reactivation", async () => {
    const decrease = await admit(representationIntent("lcm_rollups"));
    const increase = await admit(representationIntent("memory_events"));
    const repo = repository();
    repo.getSharedMemoryRepresentationChangeReview.mockImplementationOnce(
      async (_actor, input) =>
        ({
          ...(await repository().getSharedMemoryRepresentationChangeReview(
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
            activeRepresentation: "lcm_leaves" as const
          },
          willReactivate: true
        }) as never
    );
    const reactivation = await admit(representationIntent("lcm_leaves"), repo);

    expect(decrease).toMatchObject({
      policy: { disposition: "native_review" }
    });
    expect(increase).toMatchObject({
      operation: sharedMemoryRepresentationBundleActionGrantBinding({
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
        allowedRepresentations: ["lcm_rollups", "lcm_leaves", "memory_events"],
        representation: "memory_events",
        expectedGrantVersion: 7,
        expiresAt: null
      }),
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Current representation", value: "LCM Leaves" },
            { label: "New representation", value: "Memory Events" }
          ])
        }
      }
    });
    expect(reactivation).toMatchObject({
      policy: {
        disposition: "native_review",
        review: { title: "Reactivate Shared Memory with this representation?" }
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
