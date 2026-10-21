import { contentPolicyReviewFixture } from "../shared-memory/test-fixtures/rule-content-policy-review.js";
import type { MemorySourceRepository } from "@koed/db";
import { randomUUID } from "node:crypto";
import {
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryFidelityBundleActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryConversationRuleCreationActionGrantBinding,
  sharedMemoryRepositoryRuleCreationActionGrantBinding,
  repositorySharingRuleCreationIntentSchema,
  repositorySharingRuleCreationReviewSchema,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryRuleControlActionGrantBinding,
  sharedMemoryRuleDetailActionGrantBinding,
  sharingRuleDetailReviewSchema,
  sharedMemoryRepositoryRuleControlActionGrantBinding,
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
  getSharingRuleContentPolicyReview: vi.fn<
    MemorySourceRepository["getSharingRuleContentPolicyReview"]
  >(async () => null),
  getSharingRuleDetailReview: vi.fn<
    MemorySourceRepository["getSharingRuleDetailReview"]
  >(async () => null),
  getRepositorySharingRuleControlReview: vi
    .fn<MemorySourceRepository["getRepositorySharingRuleControlReview"]>()
    .mockResolvedValue(null),
  getRepositorySharingRuleCreationReview: vi.fn<
    MemorySourceRepository["getRepositorySharingRuleCreationReview"]
  >(async () => null),
  getConversationSharingRuleCreationReview: vi.fn<
    MemorySourceRepository["getConversationSharingRuleCreationReview"]
  >(async () => null),
  getConversationSharingRuleControlReview: vi.fn<
    MemorySourceRepository["getConversationSharingRuleControlReview"]
  >(async (_actor, input) => ({
    ...destination,
    logicalMemoryId: ids.logicalMemory,
    sourceTitle: source.title,
    ruleId: input.ruleId,
    reasonId: input.reasonId,
    shareGrantId: input.shareGrantId,
    state:
      input.action === "resume" ? ("paused" as const) : ("active" as const),
    maximumFidelity: "lcm_rollups" as const,
    includeCuratedMemory: false,
    authorityVersion: input.expectedAuthorityVersion,
    grantVersion: input.expectedGrantVersion
  })),
  reviewGrantRepositorySnapshot: vi.fn().mockResolvedValue({
    shareGrantId: ids.shareGrant,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    grantVersion: 1,
    sourceRevision: 2,
    representationId: ids.preview,
    representationVersion: 1,
    assignmentVersion: 3,
    sourceContextHash: "a".repeat(64),
    currentSnapshot: {
      version: 1,
      classification: "portable_repository",
      fingerprint: "gr_reviewed",
      label: null,
      branchObservation: null
    }
  }),
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
  it("disables alpha content-policy approval admission before reviewing scope", async () => {
    const repo = repository();
    const intent = highRiskActionGrantIntentSchema.parse({
      action: "shared_memory.rule_content_policy",
      mutationId: ids.mutation,
      review: contentPolicyReviewFixture({
        ruleId: ids.shareGrant,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace
      })
    });
    expect(await admit(intent, repo)).toBeNull();
    expect(repo.getSharingRuleContentPolicyReview).not.toHaveBeenCalled();
  });

  it.each(
    (["captured_session", "repository", "folder", "project"] as const).flatMap(
      (selectorKind) =>
        (
          [
            {
              maximumFidelity: "memory_events",
              disclosureIncrease: true,
              disposition: "step_up"
            },
            {
              maximumFidelity: "lcm_leaves",
              disclosureIncrease: true,
              disposition: "native_review"
            },
            {
              maximumFidelity: "lcm_rollups",
              disclosureIncrease: false,
              disposition: "native_review"
            },
            {
              maximumFidelity: "lcm_rollups",
              disclosureIncrease: true,
              disposition: "native_review"
            }
          ] as const
        ).map((scenario) => ({ selectorKind, ...scenario }))
    )
  )(
    "binds $selectorKind detail review to current authority and requires $disposition for $maximumFidelity",
    async ({
      selectorKind,
      maximumFidelity,
      disclosureIncrease,
      disposition
    }) => {
      const review = sharingRuleDetailReviewSchema.parse({
        ruleId: randomUUID(),
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        selectorKind,
        state: "paused",
        maximumFidelity,
        includeCuratedMemory: false,
        previousMaximumFidelity: "lcm_leaves",
        previousIncludeCuratedMemory: false,
        expectedAuthorityVersion: 4,
        publisherFence: 2,
        teamPolicyVersion: 3,
        teamPolicyHash: "a".repeat(64),
        workspacePolicyVersion: 2,
        workspacePolicyHash: "b".repeat(64),
        effectivePrivacyPolicyHash: "c".repeat(64),
        policyBindingHash: "d".repeat(64),
        memberBindingHash: "e".repeat(64),
        memberCount: 7,
        ownerPolicyExpansionCount: disclosureIncrease ? 2 : 0,
        disclosureIncrease,
        teamName: "Koed Team",
        workspaceName: "Engineering",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reviewHash: "f".repeat(64)
      });
      const intent = {
        action: "shared_memory.rule_detail" as const,
        mutationId: ids.mutation,
        review
      };
      const repo = repository();
      repo.getSharingRuleDetailReview.mockResolvedValue(review);
      const admitted = await admit(intent, repo);
      const binding = sharedMemoryRuleDetailActionGrantBinding({
        ...intent,
        referenceId: ids.request
      });
      expect(admitted).toMatchObject({
        operation: binding,
        policy: { disposition }
      });
      expect(admitted?.policy.review?.details).toEqual(
        expect.arrayContaining([
          { label: "Rule", value: review.ruleId },
          { label: "Rule state", value: "paused" },
          { label: "Existing members", value: "7" },
          {
            label: "Owner permission expansions",
            value: disclosureIncrease ? "2" : "0"
          }
        ])
      );
      expect(repo.getSharingRuleDetailReview).toHaveBeenCalledExactlyOnceWith(
        { userId: ids.actor },
        {
          ruleId: review.ruleId,
          teamId: ids.team,
          teamWorkspaceId: ids.workspace,
          maximumFidelity,
          includeCuratedMemory: false
        },
        review.expiresAt
      );
      const changedBinding = sharedMemoryRuleDetailActionGrantBinding({
        ...intent,
        review: { ...review, memberBindingHash: "a".repeat(64) },
        referenceId: ids.request
      });
      expect(changedBinding.requestHash).not.toBe(binding.requestHash);
      repo.getSharingRuleDetailReview.mockResolvedValue({
        ...review,
        expectedAuthorityVersion: 5
      });
      await expect(admit(intent, repo)).rejects.toBeInstanceOf(
        ActionApprovalPolicyError
      );
      repo.getSharingRuleDetailReview.mockResolvedValue(null);
      await expect(admit(intent, repo)).rejects.toBeInstanceOf(
        ActionApprovalPolicyError
      );
    }
  );

  it.each(
    (["pause", "resume", "stop", "retry"] as const).flatMap((controlAction) =>
      (["repository", "folder", "project"] as const).map((selectorKind) => ({
        controlAction,
        selectorKind
      }))
    )
  )(
    "reviews the whole $selectorKind rule for $controlAction without inventing a source grant",
    async ({ controlAction, selectorKind }) => {
      const intent = highRiskActionGrantIntentSchema.parse({
        action: "shared_memory.repository_rule_control",
        selectorKind: "selection",
        controlAction,
        mutationId: ids.mutation,
        ruleId: randomUUID(),
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        expectedAuthorityVersion: 3,
        publisherFence: 5
      });
      if (intent.action !== "shared_memory.repository_rule_control")
        throw new Error("Expected Git Anchor group control");
      const repo = repository();
      repo.getRepositorySharingRuleControlReview.mockResolvedValue({
        ruleId: intent.ruleId,
        ...destination,
        selector:
          selectorKind === "folder"
            ? { kind: "folder", key: "f".repeat(64) }
            : selectorKind === "project"
              ? { kind: "project", key: "f".repeat(64) }
              : { kind: "portable_repository", key: "gr_control" },
        state: controlAction === "resume" ? "paused" : "active",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        authorityVersion: 3,
        publisherFence: 5
      });
      const admitted = await admit(intent, repo);
      const binding = sharedMemoryRepositoryRuleControlActionGrantBinding({
        ...intent,
        referenceId: ids.request
      });
      expect(admitted).toMatchObject({
        operation: binding,
        policy: { disposition: "native_review" }
      });
      expect(admitted?.policy.review?.description).toContain(
        "all of its Conversation memberships"
      );
      expect(binding.body).not.toHaveProperty("shareGrantId");
      expect(binding.body).not.toHaveProperty("reasonId");
      expect(repo.getRepositorySharingRuleControlReview).toHaveBeenCalledWith(
        { userId: ids.actor },
        intent
      );
      for (const changed of [
        { publisherFence: 6 },
        { expectedAuthorityVersion: 4 },
        { teamWorkspaceId: randomUUID() }
      ]) {
        const next = sharedMemoryRepositoryRuleControlActionGrantBinding({
          ...intent,
          ...changed,
          referenceId: ids.request
        });
        expect(next.requestHash).not.toBe(binding.requestHash);
        if ("teamWorkspaceId" in changed)
          expect(next.scopeHash).not.toBe(binding.scopeHash);
        else expect(next.scopeHash).toBe(binding.scopeHash);
      }
      repo.getRepositorySharingRuleControlReview.mockResolvedValue(null);
      await expect(admit(intent, repo)).rejects.toBeInstanceOf(
        ActionApprovalPolicyError
      );
    }
  );
  it.each(["repository", "folder", "project"] as const)(
    "requires explicit future-member consent bound to the exact %s and current policies",
    async (selectorKind) => {
      const intent = highRiskActionGrantIntentSchema.parse({
        action: "shared_memory.repository_rule_create",
        mutationId: randomUUID(),
        ruleId: randomUUID(),
        selector:
          selectorKind === "folder"
            ? { kind: "folder", key: "f".repeat(64) }
            : selectorKind === "project"
              ? { kind: "project", key: "f".repeat(64) }
              : {
                  kind: "portable_repository",
                  key: "gr_reviewed_future_members"
                },
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        includesFutureConversations: true,
        completedReviewHash: "a".repeat(64),
        selectionSnapshotVersion: randomUUID(),
        teamPolicyVersion: 2,
        teamPolicyHash: "b".repeat(64),
        workspacePolicyVersion: 3,
        workspacePolicyHash: "c".repeat(64),
        effectivePrivacyPolicyHash: "d".repeat(64)
      });
      if (intent.action !== "shared_memory.repository_rule_create")
        throw new Error("Unexpected intent");
      const scope = repositorySharingRuleCreationReviewSchema.shape.scope
        .strip()
        .parse(intent);
      const repo = repository();
      repo.getRepositorySharingRuleCreationReview.mockResolvedValue({
        scope,
        teamName: "Koed Team",
        workspaceName: "Engineering"
      });
      const admission = await admit(intent, repo);
      expect(admission?.policy.disposition).toBe("native_review");
      expect(JSON.stringify(admission?.policy.review)).toContain(
        "future Conversations"
      );
      const boundIntent = repositorySharingRuleCreationIntentSchema
        .strip()
        .parse(intent);
      const binding = sharedMemoryRepositoryRuleCreationActionGrantBinding({
        ...boundIntent,
        referenceId: ids.request
      });
      expect(admission?.operation).toEqual(binding);
      expect(binding.body).not.toHaveProperty("action");
      expect(binding.body).toMatchObject({
        includesFutureConversations: true,
        selector: scope.selector
      });
      for (const change of [
        { selector: { ...scope.selector, key: "a".repeat(64) } },
        { teamWorkspaceId: randomUUID() },
        { effectivePrivacyPolicyHash: "e".repeat(64) },
        { teamPolicyVersion: 4 },
        { maximumFidelity: "memory_events" as const },
        { includeCuratedMemory: true }
      ]) {
        await expect(
          admit({ ...intent, ...change }, repo)
        ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
        const changed = sharedMemoryRepositoryRuleCreationActionGrantBinding({
          ...boundIntent,
          ...change,
          referenceId: ids.request
        });
        expect(changed.requestHash).not.toBe(binding.requestHash);
      }
      expect(
        highRiskActionGrantIntentSchema.safeParse({
          ...intent,
          includesFutureConversations: false
        }).success
      ).toBe(false);
      expect(
        highRiskActionGrantIntentSchema.safeParse({
          ...intent,
          selector: { ...scope.selector, root: "/private/checkout" }
        }).success
      ).toBe(false);
      repo.getRepositorySharingRuleCreationReview.mockResolvedValue(null);
      await expect(admit(intent, repo)).rejects.toBeInstanceOf(
        ActionApprovalPolicyError
      );
    }
  );
  it("requires the exact current Project review before approving a device snapshot update", async () => {
    const repo = repository();
    const expected = await repo.reviewGrantRepositorySnapshot();
    const intent = highRiskActionGrantIntentSchema.parse({
      action: "shared_memory.update_repository_snapshot",
      mutationId: ids.mutation,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      shareGrantId: ids.shareGrant,
      expected
    });
    const allowed = await admit(intent, repo);
    expect(allowed?.operation.path).toBe(
      `/v1/shared-memory/share-grants/${ids.shareGrant}/repository-snapshot`
    );
    expect(allowed?.policy.disposition).toBe("native_review");
    expect(
      await admit(
        highRiskActionGrantIntentSchema.parse({
          ...intent,
          expected: { ...expected, assignmentVersion: 4 }
        }),
        repo
      )
    ).toBeNull();
    expect(
      await admit(
        highRiskActionGrantIntentSchema.parse({
          ...intent,
          teamWorkspaceId: randomUUID()
        }),
        repo
      )
    ).toBeNull();
  });

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

  it.each(["pause", "resume", "stop", "retry"] as const)(
    "reviews and binds the exact sharing rule %s action",
    async (controlAction) => {
      const intent = highRiskActionGrantIntentSchema.parse({
        action: "shared_memory.rule_control",
        controlAction,
        mutationId: ids.mutation,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        shareGrantId: ids.shareGrant,
        ruleId: randomUUID(),
        reasonId: randomUUID(),
        expectedAuthorityVersion: 3,
        expectedGrantVersion: 7
      });
      if (intent.action !== "shared_memory.rule_control")
        throw new Error("Expected rule control intent");
      const repo = repository();
      const admitted = await admit(intent, repo);
      const bound = intent;
      expect(admitted).toMatchObject({
        operation: sharedMemoryRuleControlActionGrantBinding({
          ...bound,
          referenceId: ids.request
        }),
        policy: {
          disposition: "native_review",
          review: {
            description:
              "Apply this action to one Conversation sharing rule in one Workspace."
          }
        }
      });
      expect(repo.getConversationSharingRuleControlReview).toHaveBeenCalledWith(
        { userId: ids.actor },
        expect.objectContaining({
          ruleId: intent.ruleId,
          reasonId: intent.reasonId,
          shareGrantId: ids.shareGrant,
          teamId: ids.team,
          teamWorkspaceId: ids.workspace,
          expectedAuthorityVersion: 3,
          expectedGrantVersion: 7,
          action: controlAction
        })
      );
      repo.getConversationSharingRuleControlReview.mockResolvedValueOnce(null);
      await expect(admit(intent, repo)).rejects.toBeInstanceOf(
        ActionApprovalPolicyError
      );
      const binding = sharedMemoryRuleControlActionGrantBinding({
        ...bound,
        referenceId: ids.request
      });
      for (const mutation of [
        { ruleId: randomUUID() },
        { reasonId: randomUUID() },
        { shareGrantId: randomUUID() },
        { teamId: randomUUID() },
        { teamWorkspaceId: randomUUID() },
        { expectedGrantVersion: 8 },
        { expectedAuthorityVersion: 4 },
        {
          controlAction:
            controlAction === "stop" ? ("pause" as const) : ("stop" as const)
        }
      ]) {
        expect(
          sharedMemoryRuleControlActionGrantBinding({
            ...bound,
            ...mutation,
            referenceId: ids.request
          }).requestHash
        ).not.toBe(binding.requestHash);
      }
    }
  );

  it("binds consent and Share Grant creation in one decision and steps up raw Memory", async () => {
    const derived = shareIntent("lcm_rollups");
    const raw = shareIntent("memory_events");
    const rawRepository = repository({ sourceOwnerPolicyWillReplace: true });

    const admittedDerived = await admit(derived);
    const admittedRaw = await admit(raw, rawRepository);

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
            { label: "Source policy", value: "Expand during this share" }
          ]),
          consequence: expect.stringContaining(
            "Existing sharing reasons retain their own consent limits"
          )
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
  it("reviews exact Conversation rule creation without converting an existing reason", async () => {
    const intent = highRiskActionGrantIntentSchema.parse({
      action: "shared_memory.conversation_rule_create",
      mutationId: ids.mutation,
      ruleId: randomUUID(),
      logicalGrantId: ids.logicalGrant,
      consentId: ids.consent,
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups"],
      activationRepresentation: "lcm_rollups",
      logicalMemoryId: ids.logicalMemory,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      previewId: ids.preview,
      previewHash: "a".repeat(64),
      previewRevision: 1,
      expectedGrantVersion: 3,
      effectivePrivacyPolicyHash: "b".repeat(64),
      mode: "continuous",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      expiresAt: null
    });
    if (intent.action !== "shared_memory.conversation_rule_create")
      throw new Error("Expected rule creation");
    const repo = repository();
    repo.getConversationSharingRuleCreationReview.mockResolvedValue({
      previewId: intent.previewId,
      previewHash: intent.previewHash,
      previewRevision: intent.previewRevision,
      logicalMemoryId: ids.logicalMemory,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      source: capturedSource,
      sourceTitle: source.title,
      teamName: destination.team.name,
      workspaceName: destination.workspace.name,
      logicalGrantId: intent.logicalGrantId,
      expectedGrantVersion: 3,
      effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash,
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      activationRepresentation: "lcm_rollups",
      sourceCapabilities: ["lcm_rollups"],
      expiresAt: null,
      reviewExpiresAt: "2099-01-01T00:00:00.000Z"
    });
    const admitted = await admit(intent, repo);
    expect(admitted).toMatchObject({
      operation: sharedMemoryConversationRuleCreationActionGrantBinding({
        ...intent,
        referenceId: ids.request
      }),
      policy: {
        disposition: "native_review",
        review: {
          title: "Share this Conversation continuously?",
          details: expect.arrayContaining([
            { label: "Conversation", value: source.title }
          ])
        }
      }
    });
    const bound = sharedMemoryConversationRuleCreationActionGrantBinding({
      ...intent,
      referenceId: ids.request
    });
    expect(
      sharedMemoryConversationRuleCreationActionGrantBinding({
        ...intent,
        ruleId: randomUUID(),
        referenceId: ids.request
      }).requestHash
    ).not.toBe(bound.requestHash);
    for (const change of [
      { expectedGrantVersion: 4 },
      { effectivePrivacyPolicyHash: "c".repeat(64) },
      { teamWorkspaceId: randomUUID() },
      { source: { ...capturedSource, sessionId: randomUUID() } },
      { maximumFidelity: "memory_events" as const },
      { includeCuratedMemory: true }
    ]) {
      await expect(
        admit({ ...intent, ...change }, repo)
      ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
    }
    repo.getConversationSharingRuleCreationReview.mockResolvedValue(null);
    await expect(admit(intent, repo)).rejects.toBeInstanceOf(
      ActionApprovalPolicyError
    );
  });
});
