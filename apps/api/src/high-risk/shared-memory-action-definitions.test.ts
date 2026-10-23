import { randomUUID } from "node:crypto";
import {
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryFidelityBundleActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import { admitHighRiskActionGrant } from "./action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";
import {
  highRiskActionGrantIntentFromCollaborationIntent,
  highRiskActionGrantIntentSchema,
  resolveHighRiskActionGrantOperation,
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
const sourceDeploymentProtocolId = randomUUID();

const source = {
  logicalMemoryId: ids.logicalMemory,
  title: "Architecture review",
  ownerPrincipalId: ids.actor
};
const capturedSource = {
  kind: "captured_session" as const,
  sessionId: ids.replica,
  logicalMemoryId: ids.logicalMemory
};
const destination = {
  team: { id: ids.team, name: "Koed Team" },
  workspace: { id: ids.workspace, name: "Engineering" }
};

const repository = (options?: { sourceOwnerPolicyWillReplace?: boolean }) => ({
  getSharedMemoryCandidatePreviewAdmission: vi.fn(async (_actor, input) => ({
    effectiveMaximumFidelity: input.maximumFidelity,
    effectiveIncludeCuratedMemory: input.includeCuratedMemory,
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
  getSharedMemoryPendingShareReview: vi.fn(async (_actor, input) => ({
    source,
    ...destination,
    preview: {
      previewId: input.preview.previewId,
      previewHash: input.preview.previewHash,
      previewRevision: input.previewRevision,
      representation: input.activationRepresentation,
      sourceRevision: 4
    },
    maximumFidelity: input.maximumFidelity,
    includeCuratedMemory: input.includeCuratedMemory,
    sourceOwnerPolicyWillActivate: true as const,
    sourceOwnerPolicyWillReplace: options?.sourceOwnerPolicyWillReplace === true
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
      sourceRevision: 3,
      maximumFidelity: "lcm_leaves" as const,
      includeCuratedMemory: false
    },
    willReactivate: false,
    sourceRevisionChanged: true
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
  })),
  getTeamConversationSourceRevokeReview: vi.fn(async (_actor, input) => ({
    shareGrantId: input.shareGrantId,
    logicalMemoryId: ids.logicalMemory,
    sourceTitle: source.title,
    teamId: ids.team,
    teamName: destination.team.name,
    teamWorkspaceId: ids.workspace,
    teamWorkspaceName: destination.workspace.name,
    currentVersion: input.expectedVersion,
    currentMode: "continuous" as const,
    currentLifecycle: "active" as const
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

describe("source-admission authority", () => {
  it("does not mint Direct authority when exact source provenance is denied", async () => {
    const repo = {
      inspectSourceAdmissionProvenance: vi.fn(async () => false),
      getSourceAdmission: vi.fn(async () => ({
        generation: 0,
        holdVersion: 0,
        heldBatchId: null,
        sealed: false,
        activeUnfrozenGrants: 0
      }))
    };
    const intent = {
      action: "shared_memory.source_admission.prepare",
      source: capturedSource,
      sourceDeploymentProtocolId,
      sourceOwnerPrincipalId: ids.actor,
      logicalMemoryId: ids.logicalMemory,
      batchId: randomUUID(),
      expectedGeneration: 0,
      expectedHoldVersion: 0
    } as const satisfies HighRiskActionGrantIntent;
    const result = await admitHighRiskActionGrant({
      repository: repo as never,
      userId: ids.actor,
      deviceCredentialId: randomUUID(),
      clientRequestId: ids.request,
      hashSecret: (value) => value,
      intent
    });
    expect(result).toBeNull();
    expect(repo.inspectSourceAdmissionProvenance).toHaveBeenCalledOnce();
    expect(repo.getSourceAdmission).not.toHaveBeenCalled();
  });
});

const shareIntent = (
  maximumFidelity: "lcm_rollups" | "lcm_leaves" | "memory_events",
  includeCuratedMemory = false
) =>
  ({
    action: "shared_memory.pending_share",
    source: capturedSource,
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: maximumFidelity,
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
    source: capturedSource,
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: maximumFidelity,
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
  it("uses the public admission reference for candidate-preview execution", async () => {
    const intent = {
      action: "shared_memory.candidate_preview",
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "lcm_leaves",
      logicalMemoryId: ids.logicalMemory,
      candidateHash: "c".repeat(64),
      sourceRevision: 4,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: ids.preview, revisionHash: "d".repeat(64) }],
      byteCount: 256,
      sourceDeploymentProtocolId,
      sourceOwnerPrincipalId: ids.actor,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: false,
      mode: "snapshot",
      expiresAt: null
    } as const satisfies HighRiskActionGrantIntent;

    const admitted = await admit(intent);

    expect(admitted).toMatchObject({
      operation: sharedMemoryCandidatePreviewActionGrantBinding({
        referenceId: ids.request,
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "lcm_leaves",
        logicalMemoryId: ids.logicalMemory,
        candidateHash: "c".repeat(64),
        sourceRevision: 4,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: [{ sourceId: ids.preview, revisionHash: "d".repeat(64) }],
        byteCount: 256,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId: ids.actor,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false,
        mode: "snapshot",
        expiresAt: null
      })
    });
  });

  it("binds exact Curated candidate commitment and rejects a substituted commitment hash", async () => {
    const intent = {
      action: "shared_memory.candidate_preview",
      source: capturedSource,
      sourceCapabilities: ["lcm_leaves"],
      activationRepresentation: "lcm_leaves",
      logicalMemoryId: ids.logicalMemory,
      candidateHash: "c".repeat(64),
      curatedMaterialCommitmentHash: "e".repeat(64),
      sourceRevision: 4,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: ids.preview, revisionHash: "d".repeat(64) }],
      byteCount: 256,
      sourceDeploymentProtocolId,
      sourceOwnerPrincipalId: ids.actor,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: true,
      mode: "continuous",
      expiresAt: null
    } as const satisfies HighRiskActionGrantIntent;
    const { action, ...candidate } = intent;
    expect(action).toBe("shared_memory.candidate_preview");
    const approved = sharedMemoryCandidatePreviewActionGrantBinding({
      ...candidate,
      referenceId: ids.request
    });
    const substituted = sharedMemoryCandidatePreviewActionGrantBinding({
      ...candidate,
      referenceId: ids.request,
      curatedMaterialCommitmentHash: "f".repeat(64)
    });

    expect(await admit(intent)).toMatchObject({ operation: approved });
    expect(approved.requestHash).not.toBe(substituted.requestHash);
  });

  it("preserves Curated commitment from Collaboration intent through Team execution binding", async () => {
    const commitmentHash = "e".repeat(64);
    const candidate = {
      source: capturedSource,
      sourceCapabilities: ["lcm_leaves" as const],
      activationRepresentation: "lcm_leaves" as const,
      candidateHash: "c".repeat(64),
      sourceRevision: 4,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: ids.preview, revisionHash: "d".repeat(64) }],
      byteCount: 256,
      mode: "continuous" as const,
      expiresAt: null,
      curatedMaterialCommitmentHash: commitmentHash,
      curatedSourceAttestationKeyId: ids.actor,
      curatedSourceAttestationFingerprint: "a".repeat(64)
    };
    const collaborationIntent = {
      intent: "collaboration.preview_shared_memory" as const,
      commandRequestId: randomUUID(),
      source: capturedSource,
      logicalMemoryId: ids.logicalMemory,
      teamId: ids.team,
      workspaceId: ids.workspace,
      sourceCapabilities: candidate.sourceCapabilities,
      activationRepresentation: candidate.activationRepresentation,
      maximumFidelity: "lcm_leaves" as const,
      includeCuratedMemory: true,
      curatedMaterialCommitmentHash: commitmentHash,
      mode: candidate.mode,
      candidate
    };
    const sourceIdentity = {
      sourceDeploymentProtocolId,
      sourceOwnerPrincipalId: ids.actor
    };
    const translated = highRiskActionGrantIntentFromCollaborationIntent(
      "https://team.example.test",
      collaborationIntent,
      undefined,
      sourceIdentity
    );
    expect(translated).toMatchObject({
      action: "shared_memory.candidate_preview",
      curatedMaterialCommitmentHash: commitmentHash
    });
    expect(translated).not.toBeNull();
    const resolved = await resolveHighRiskActionGrantOperation({
      clientRequestId: ids.request,
      intent: translated!
    });
    const dispatch = sharedMemoryCandidatePreviewActionGrantBinding({
      referenceId: ids.request,
      source: capturedSource,
      ...sourceIdentity,
      sourceCapabilities: candidate.sourceCapabilities,
      logicalMemoryId: ids.logicalMemory,
      candidateHash: candidate.candidateHash,
      curatedMaterialCommitmentHash: commitmentHash,
      sourceRevision: candidate.sourceRevision,
      itemCount: candidate.itemCount,
      excludedItemCount: candidate.excludedItemCount,
      manifest: candidate.manifest,
      byteCount: candidate.byteCount,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      activationRepresentation: candidate.activationRepresentation,
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: true,
      mode: candidate.mode,
      expiresAt: candidate.expiresAt
    });
    expect(resolved).toEqual(dispatch);
    const changed = highRiskActionGrantIntentFromCollaborationIntent(
      "https://team.example.test",
      {
        ...collaborationIntent,
        curatedMaterialCommitmentHash: "f".repeat(64),
        candidate: {
          ...candidate,
          curatedMaterialCommitmentHash: "f".repeat(64)
        }
      },
      undefined,
      sourceIdentity
    );
    expect(changed).not.toBeNull();
    expect(
      (
        await resolveHighRiskActionGrantOperation({
          clientRequestId: ids.request,
          intent: changed!
        })
      )?.requestHash
    ).not.toBe(dispatch.requestHash);
  });

  it("admits an exact authoritative preview as Direct", async () => {
    const repo = repository();
    const intent = {
      action: "shared_memory.preview",
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "lcm_rollups",
      mode: "continuous",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.replica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).resolves.toEqual({
      operation: sharedMemoryPreviewActionGrantBinding({
        referenceId: ids.request,
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "lcm_rollups",
        mode: "continuous",
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
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
      source: capturedSource,
      sourceCapabilities: [
        "lcm_rollups",
        "lcm_leaves",
        "memory_events",
        "curated_assertions"
      ],
      activationRepresentation: "curated_assertions",
      mode: "continuous",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.replica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
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
        source: capturedSource,
        sourceCapabilities: [
          "lcm_rollups",
          "lcm_leaves",
          "memory_events",
          "curated_assertions"
        ],
        activationRepresentation: "curated_assertions",
        mode: "continuous",
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
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
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "lcm_rollups",
      mode: "continuous",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.replica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).resolves.toEqual({
      operation: sharedMemoryPreviewActionGrantBinding({
        referenceId: ids.request,
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "lcm_rollups",
        mode: "continuous",
        logicalMemoryId: ids.logicalMemory,
        remoteReplicaId: ids.replica,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false
      }),
      policy: { disposition: "direct", review: null }
    });
  });

  it("binds consent and Share Grant creation in one decision and steps up raw Memory", async () => {
    const derived = shareIntent("lcm_rollups");
    const raw = shareIntent("memory_events");
    const rawRepository = repository({ sourceOwnerPolicyWillReplace: true });

    const admittedDerived = await admit(derived);
    const admittedRaw = await admit(raw, rawRepository);
    const admittedCurated = await admit(shareIntent("lcm_rollups", true));

    expect(admittedDerived).toMatchObject({
      operation: sharedMemoryPendingShareActionGrantBinding({
        referenceId: ids.request,
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "lcm_rollups",
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
    expect(admittedCurated).toMatchObject({
      operation: sharedMemoryPendingShareActionGrantBinding({
        referenceId: ids.request,
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "lcm_rollups",
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
        includeCuratedMemory: true,
        expiresAt: null
      }),
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Maximum fidelity", value: "LCM Rollups" },
            { label: "Curated Memory", value: "Included" }
          ])
        }
      }
    });
  });

  it("keeps the source-policy replacement warning in an exact Project summary review", async () => {
    const workspaceProjectId = randomUUID();
    const intent = {
      ...shareIntent("lcm_leaves"),
      workspaceProjectId,
      mode: "continuous" as const
    };
    const admitted = await admit(
      intent,
      repository({ sourceOwnerPolicyWillReplace: true })
    );
    if (!admitted) throw new Error("Project summary review was not admitted");
    expect(admitted.policy).toMatchObject({
      disposition: "native_review",
      review: {
        title: `Share a summary of this chat with ${destination.team.name}?`,
        consequence: expect.stringContaining("invalidates other Share Grants"),
        details: expect.arrayContaining([
          { label: "Project", value: workspaceProjectId },
          { label: "Curated Memory", value: "Excluded" }
        ])
      }
    });
    const otherProject = await admit(
      { ...intent, workspaceProjectId: randomUUID() },
      repository({ sourceOwnerPolicyWillReplace: true })
    );
    if (!otherProject)
      throw new Error("Second Project review was not admitted");
    expect(otherProject.operation.requestHash).not.toBe(
      admitted.operation.requestHash
    );
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
    const revokeRepository = repository();
    await expect(admit(revokeIntent, revokeRepository)).resolves.toMatchObject({
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
    expect(
      revokeRepository.getTeamConversationSourceRevokeReview
    ).toHaveBeenCalledOnce();
    expect(
      revokeRepository.getTeamConversationSourceGrantReview
    ).not.toHaveBeenCalled();
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
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "memory_events",
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

  it("reviews a newer source revision without pretending fidelity changed", async () => {
    await expect(admit(fidelityIntent("lcm_leaves"))).resolves.toMatchObject({
      policy: {
        disposition: "native_review",
        review: {
          title: "Share this newer Memory revision?",
          confirmLabel: "Share newer revision",
          details: expect.arrayContaining([
            { label: "Current source revision", value: "3" },
            { label: "New source revision", value: "4" }
          ])
        }
      }
    });
  });

  it("fails closed on missing review state and exposes no standalone consent action", async () => {
    const repo = repository();
    repo.getSharedMemoryPendingShareReview.mockResolvedValueOnce(null as never);

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
