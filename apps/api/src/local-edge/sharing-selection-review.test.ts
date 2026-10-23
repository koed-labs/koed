import { describe, expect, it, vi } from "vitest";
import {
  sharingSelectionDescriptor,
  repositorySharingRuleCreationLocalIntentSchema,
  repositorySharingRuleCreationIntentSchema,
  sharedMemoryRepositoryRuleCreationActionGrantBinding,
  type GitAnchorSharingReviewInput,
  type PersonalSelectionConsumerPage,
  type SharedMemoryCandidatePreview,
  type SharingDestinationReview
} from "@koed/shared";
import {
  reviewGitAnchorSharing,
  resolveCompletedGitAnchorSharingReview,
  validateCompletedGitAnchorRuleCreationIntent,
  SharingReviewConflict,
  type SharingSelectionReviewDependencies
} from "./sharing-selection-review.js";

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const input = {
  target: {
    kind: "repository",
    repository: {
      kind: "portable_repository",
      key: "github.com/example/anchor",
      root: null,
      branch: null,
      reason: "origin",
      checkoutId: null,
      originatingDeviceId: "device-a",
      selectedRemote: "origin",
      anchorDisplay: "example/anchor"
    }
  },
  teamId: id(1),
  workspaceId: id(2),
  representation: "memory_events",
  cursor: null
} satisfies GitAnchorSharingReviewInput;
const destination: SharingDestinationReview = {
  teamId: id(1),
  workspaceId: id(2),
  representation: "memory_events",
  effectiveMaximumFidelity: "memory_events",
  effectiveIncludeCuratedMemory: false,
  teamPolicyVersion: 1,
  teamPolicyHash: "a".repeat(64),
  workspacePolicyVersion: 1,
  workspacePolicyHash: "b".repeat(64)
};
const entry = (sessionId = id(3)) => ({
  source: {
    localSessionId: sessionId,
    localLogicalSessionId: id(4),
    identityState: "local_only" as const,
    portable: null,
    contextVersion: { git: 1, folder: 1 }
  },
  reason: { kind: "selection" as const, targetKind: "repository" as const },
  projectVersion: null
});
const page = (more = false): PersonalSelectionConsumerPage => ({
  version: 1,
  snapshotVersion: id(5),
  selection: { version: 1, ownerUserId: id(6), target: input.target },
  entries: [entry()],
  nextCursor: more ? id(7) : null,
  changeCursor: more ? null : id(8),
  expiresAt: "2099-01-01T00:00:00.000Z"
});
const candidate = (sessionId = id(3)): SharedMemoryCandidatePreview => ({
  source: { kind: "captured_session", sessionId, logicalMemoryId: id(9) },
  logicalMemoryId: id(9),
  sourceCapabilities: ["memory_events"],
  activationRepresentation: "memory_events",
  mode: "continuous",
  expiresAt: null,
  sourceRevision: 4,
  candidateHash: "c".repeat(64),
  itemCount: 1,
  excludedItemCount: 0,
  byteCount: 100,
  manifest: [{ sourceId: id(10), revisionHash: "d".repeat(64) }],
  items: [
    {
      id: id(10),
      representation: "memory_events",
      sequence: 1,
      occurredAt: "2026-10-20T00:00:00.000Z",
      sourceItems: [
        {
          id: id(10),
          sourceKind: "user_message",
          occurredAt: "2026-10-20T00:00:00.000Z",
          body: "OWNER_PRIVATE_REVIEW_CONTENT",
          actorName: null,
          toolName: null,
          toolCallId: null
        }
      ]
    }
  ]
});
const fixture = () =>
  ({
    backendId: "team-test",
    ownerUserId: id(6),
    upstreamUserId: id(11),
    cursorSecret: "local-review-credential-secret",
    enumerate: vi.fn(async () => page()),
    hasChanges: vi.fn(async () => false),
    headers: vi.fn(
      async () =>
        new Map([[id(3), { title: "Reviewed Conversation", eventCount: 1 }]])
    ),
    candidate: vi.fn(async () => candidate()),
    destination: vi.fn(async () => destination)
  }) satisfies SharingSelectionReviewDependencies;

describe("Git Anchor sharing review", () => {
  it("binds an exact Folder review to device and directory incarnation without Team path metadata", async () => {
    const deps = fixture();
    const target = {
      kind: "folder" as const,
      folder: {
        ownerUserId: id(6),
        folderId: "exact-folder",
        originatingDeploymentId: "origin-deployment",
        originatingDeviceId: "origin-device",
        originatingProfileId: "origin-profile",
        directoryIncarnationId: "origin-incarnation"
      }
    };
    deps.enumerate.mockResolvedValue({
      ...page(),
      selection: { ...page().selection, target },
      entries: [
        { ...entry(), reason: { kind: "selection", targetKind: "folder" } }
      ]
    });
    const final = await reviewGitAnchorSharing({ ...input, target }, deps);
    const review = {
      target,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      representation: input.representation,
      completionToken: final.completionToken!
    };
    const completed = await resolveCompletedGitAnchorSharingReview(
      review,
      deps
    );
    const intent = repositorySharingRuleCreationLocalIntentSchema.parse({
      mutationId: id(20),
      ruleId: id(21),
      teamId: input.teamId,
      teamWorkspaceId: input.workspaceId,
      selector: sharingSelectionDescriptor(target),
      maximumFidelity: input.representation,
      includeCuratedMemory: false,
      includesFutureConversations: true,
      completedReviewHash: completed.reviewHash,
      selectionSnapshotVersion: completed.snapshotVersion,
      teamPolicyVersion: destination.teamPolicyVersion,
      teamPolicyHash: destination.teamPolicyHash,
      workspacePolicyVersion: destination.workspacePolicyVersion,
      workspacePolicyHash: destination.workspacePolicyHash,
      effectivePrivacyPolicyHash: "e".repeat(64),
      review
    });
    expect(() =>
      validateCompletedGitAnchorRuleCreationIntent(intent, deps)
    ).not.toThrow();
    const binding = sharedMemoryRepositoryRuleCreationActionGrantBinding({
      ...repositorySharingRuleCreationIntentSchema.strip().parse(intent),
      referenceId: id(22)
    });
    const teamBody = JSON.stringify(binding.body);
    for (const privateValue of Object.values(target.folder))
      expect(teamBody).not.toContain(privateValue);
    expect(binding.body).not.toHaveProperty("review");
    for (const change of [
      { originatingDeviceId: "different-device" },
      { originatingDeploymentId: "different-deployment" },
      { originatingProfileId: "different-profile" },
      { directoryIncarnationId: "replacement-directory" },
      { folderId: "other-folder" }
    ])
      expect(() =>
        validateCompletedGitAnchorRuleCreationIntent(
          {
            ...intent,
            review: {
              ...review,
              target: { ...target, folder: { ...target.folder, ...change } }
            }
          },
          deps
        )
      ).toThrow(SharingReviewConflict);
  });
  it("keeps a private Project reference in the local review and binds its opaque Team descriptor", async () => {
    const deps = fixture();
    const target = {
      kind: "project" as const,
      project: { ownerUserId: id(6), projectId: id(60) }
    };
    deps.enumerate.mockResolvedValue({
      ...page(),
      selection: { ...page().selection, target },
      entries: [
        {
          ...entry(),
          reason: { kind: "session", inclusionId: id(61), revisionId: id(62) },
          projectVersion: 7
        }
      ]
    });
    const final = await reviewGitAnchorSharing({ ...input, target }, deps);
    const review = {
      target,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      representation: input.representation,
      completionToken: final.completionToken!
    };
    const completed = await resolveCompletedGitAnchorSharingReview(
      review,
      deps
    );
    const intent = repositorySharingRuleCreationLocalIntentSchema.parse({
      mutationId: id(20),
      ruleId: id(21),
      teamId: input.teamId,
      teamWorkspaceId: input.workspaceId,
      selector: sharingSelectionDescriptor(target),
      maximumFidelity: input.representation,
      includeCuratedMemory: false,
      includesFutureConversations: true,
      completedReviewHash: completed.reviewHash,
      selectionSnapshotVersion: completed.snapshotVersion,
      teamPolicyVersion: destination.teamPolicyVersion,
      teamPolicyHash: destination.teamPolicyHash,
      workspacePolicyVersion: destination.workspacePolicyVersion,
      workspacePolicyHash: destination.workspacePolicyHash,
      effectivePrivacyPolicyHash: "e".repeat(64),
      review
    });
    expect(() =>
      validateCompletedGitAnchorRuleCreationIntent(intent, deps)
    ).not.toThrow();
    const portableTarget = {
      ...target,
      project: { ...target.project, projectId: id(64) }
    };
    const portableIntent = {
      ...intent,
      selector: sharingSelectionDescriptor(portableTarget)
    };
    expect(() =>
      validateCompletedGitAnchorRuleCreationIntent(portableIntent, {
        ...deps,
        resolvedTarget: portableTarget
      })
    ).not.toThrow();
    expect(() =>
      validateCompletedGitAnchorRuleCreationIntent(portableIntent, deps)
    ).toThrow(SharingReviewConflict);
    expect(() =>
      validateCompletedGitAnchorRuleCreationIntent(
        { ...portableIntent, review: { ...review, target: portableTarget } },
        { ...deps, resolvedTarget: portableTarget }
      )
    ).toThrow(SharingReviewConflict);
    const binding = sharedMemoryRepositoryRuleCreationActionGrantBinding({
      ...repositorySharingRuleCreationIntentSchema.strip().parse(intent),
      referenceId: id(22)
    });
    expect(JSON.stringify(binding.body)).not.toContain(
      target.project.projectId
    );
    expect(binding.body).not.toHaveProperty("review");
    expect(() =>
      validateCompletedGitAnchorRuleCreationIntent(
        {
          ...intent,
          review: {
            ...review,
            target: {
              ...target,
              project: { ...target.project, projectId: id(63) }
            }
          }
        },
        deps
      )
    ).toThrow(SharingReviewConflict);
  });
  it("binds private delivery to its complete review after approval without publishing local paths", async () => {
    const deps = fixture();
    const privateInput = {
      ...input,
      target: {
        ...input.target,
        repository: {
          ...input.target.repository,
          root: "/private/approved-checkout"
        }
      }
    };
    deps.enumerate.mockResolvedValue({
      ...page(),
      selection: { ...page().selection, target: privateInput.target }
    });
    const final = await reviewGitAnchorSharing(privateInput, deps);
    const review = {
      target: privateInput.target,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      representation: input.representation,
      completionToken: final.completionToken!
    };
    const completed = await resolveCompletedGitAnchorSharingReview(
      review,
      deps
    );
    const intent = repositorySharingRuleCreationLocalIntentSchema.parse({
      mutationId: id(20),
      ruleId: id(21),
      teamId: input.teamId,
      teamWorkspaceId: input.workspaceId,
      selector: {
        kind: privateInput.target.repository.kind,
        key: privateInput.target.repository.key
      },
      maximumFidelity: input.representation,
      includeCuratedMemory: false,
      includesFutureConversations: true,
      completedReviewHash: completed.reviewHash,
      selectionSnapshotVersion: completed.snapshotVersion,
      teamPolicyVersion: destination.teamPolicyVersion,
      teamPolicyHash: destination.teamPolicyHash,
      workspacePolicyVersion: destination.workspacePolicyVersion,
      workspacePolicyHash: destination.workspacePolicyHash,
      effectivePrivacyPolicyHash: "e".repeat(64),
      review
    });
    expect(() =>
      validateCompletedGitAnchorRuleCreationIntent(intent, deps)
    ).not.toThrow();
    const binding = sharedMemoryRepositoryRuleCreationActionGrantBinding({
      ...repositorySharingRuleCreationIntentSchema.strip().parse(intent),
      referenceId: id(22)
    });
    expect(JSON.stringify(binding.body)).not.toContain(
      "/private/approved-checkout"
    );
    expect(binding.body).not.toHaveProperty("review");
    for (const changed of [
      { ...intent, selectionSnapshotVersion: id(23) },
      { ...intent, selector: { ...intent.selector, key: "other-anchor" } },
      { ...intent, completedReviewHash: "f".repeat(64) },
      {
        ...intent,
        review: {
          ...review,
          target: {
            ...review.target,
            repository: {
              ...review.target.repository,
              root: "/private/substituted"
            }
          }
        }
      }
    ])
      expect(() =>
        validateCompletedGitAnchorRuleCreationIntent(changed, deps)
      ).toThrow(SharingReviewConflict);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
      // A committed, approved queue entry retains its binding after observation
      // expiry. A new native approval still needs a fresh complete review.
      expect(() =>
        validateCompletedGitAnchorRuleCreationIntent(intent, deps)
      ).not.toThrow();
      await expect(
        resolveCompletedGitAnchorSharingReview(review, deps)
      ).rejects.toBeInstanceOf(SharingReviewConflict);
    } finally {
      vi.useRealTimers();
    }
  });
  it("completes every bounded page and retains local-only identity without publishing content", async () => {
    const deps = fixture();
    deps.enumerate
      .mockResolvedValueOnce(page(true))
      .mockResolvedValueOnce({ ...page(), entries: [entry(), entry(id(12))] });
    deps.candidate.mockImplementation(async (sessionId?: string) =>
      candidate(sessionId)
    );
    const first = await reviewGitAnchorSharing(input, deps);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    expect(deps.hasChanges).not.toHaveBeenCalled();
    const last = await reviewGitAnchorSharing(
      { ...input, cursor: first.nextCursor },
      deps
    );
    expect(last.complete).toBe(true);
    expect(last.nextCursor).toBeNull();
    expect(last.entries).toHaveLength(2);
    expect(last.entries[0]?.source).toMatchObject({
      identityState: "local_only",
      portable: null
    });
    expect(deps.enumerate).toHaveBeenLastCalledWith({
      target: input.target,
      cursor: id(7)
    });
    expect(deps.hasChanges).toHaveBeenCalledWith(id(8));
    expect(JSON.stringify(last)).not.toContain("OWNER_PRIVATE_REVIEW_CONTENT");
    expect(last.includesFutureConversations).toBe(true);
  });

  it("keeps an unresolved source visible instead of presenting a smaller complete scope", async () => {
    const deps: SharingSelectionReviewDependencies = {
      ...fixture(),
      candidate: async () => null
    };
    const result = await reviewGitAnchorSharing(input, deps);
    expect(result.entries).toMatchObject([
      { readiness: "unresolved", sourceRevision: null, itemCount: null }
    ]);
  });

  it("binds a continuation to its owner, backend, selector, destination and detail", async () => {
    const deps = fixture();
    deps.enumerate.mockResolvedValue(page(true));
    const first = await reviewGitAnchorSharing(input, deps);
    for (const changed of [
      { ...input, workspaceId: id(20) },
      { ...input, representation: "lcm_rollups" as const },
      {
        ...input,
        target: {
          ...input.target,
          repository: { ...input.target.repository, key: "another-anchor" }
        }
      }
    ]) {
      await expect(
        reviewGitAnchorSharing({ ...changed, cursor: first.nextCursor }, deps)
      ).rejects.toBeInstanceOf(SharingReviewConflict);
    }
    for (const changes of [
      { ownerUserId: id(21) },
      { upstreamUserId: id(22) },
      { backendId: "another-backend" },
      { cursorSecret: "different-secret" }
    ]) {
      await expect(
        reviewGitAnchorSharing(
          { ...input, cursor: first.nextCursor },
          { ...deps, ...changes }
        )
      ).rejects.toBeInstanceOf(SharingReviewConflict);
    }
    expect(deps.enumerate).toHaveBeenCalledTimes(1);
  });

  it("requires refresh when destination policy changes between pages or while inspecting sources", async () => {
    const deps = fixture();
    deps.enumerate.mockResolvedValue(page(true));
    const first = await reviewGitAnchorSharing(input, deps);
    deps.destination.mockResolvedValue({
      ...destination,
      workspacePolicyVersion: 2
    });
    await expect(
      reviewGitAnchorSharing({ ...input, cursor: first.nextCursor }, deps)
    ).rejects.toBeInstanceOf(SharingReviewConflict);
    const during = fixture();
    during.destination
      .mockResolvedValueOnce(destination)
      .mockResolvedValueOnce({ ...destination, teamPolicyVersion: 2 });
    await expect(reviewGitAnchorSharing(input, during)).rejects.toBeInstanceOf(
      SharingReviewConflict
    );
  });

  it("discards a baseline that changed after its last enumeration page", async () => {
    const deps = fixture();
    deps.hasChanges.mockResolvedValue(true);
    await expect(reviewGitAnchorSharing(input, deps)).rejects.toBeInstanceOf(
      SharingReviewConflict
    );
  });

  it("rejects source substitution and a falsely complete or expired enumeration", async () => {
    const deps = fixture();
    deps.candidate.mockResolvedValue(candidate(id(99)));
    await expect(reviewGitAnchorSharing(input, deps)).rejects.toBeInstanceOf(
      SharingReviewConflict
    );
    const incomplete = fixture();
    incomplete.enumerate.mockResolvedValue({ ...page(), changeCursor: null });
    await expect(
      reviewGitAnchorSharing(input, incomplete)
    ).rejects.toBeInstanceOf(SharingReviewConflict);
    const expired = fixture();
    expired.enumerate.mockResolvedValue({
      ...page(),
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    await expect(reviewGitAnchorSharing(input, expired)).rejects.toBeInstanceOf(
      SharingReviewConflict
    );
  });
});

describe("portable sharing selector identity", () => {
  it("normalizes only the local Folder owner and retains original Folder provenance", () => {
    const folder = {
      ownerUserId: id(6),
      folderId: "folder-a",
      originatingDeploymentId: "origin-deployment",
      originatingDeviceId: "origin-device",
      originatingProfileId: "origin-profile",
      directoryIncarnationId: "original-directory"
    };
    const original = sharingSelectionDescriptor({ kind: "folder", folder });
    expect(
      sharingSelectionDescriptor({
        kind: "folder",
        folder: { ...folder, ownerUserId: id(7) }
      })
    ).toEqual(original);
    for (const change of [
      { folderId: "folder-b" },
      { originatingDeploymentId: "other-deployment" },
      { originatingDeviceId: "other-device" },
      { originatingProfileId: "other-profile" },
      { directoryIncarnationId: "replacement-directory" }
    ])
      expect(
        sharingSelectionDescriptor({
          kind: "folder",
          folder: { ...folder, ...change }
        })
      ).not.toEqual(original);
  });
  it("retains the verified portable Project identity across local owner translation", () => {
    const original = sharingSelectionDescriptor({
      kind: "project",
      project: { ownerUserId: id(6), projectId: "verified-portable-project" }
    });
    expect(
      sharingSelectionDescriptor({
        kind: "project",
        project: { ownerUserId: id(7), projectId: "verified-portable-project" }
      })
    ).toEqual(original);
    expect(
      sharingSelectionDescriptor({
        kind: "project",
        project: { ownerUserId: id(7), projectId: "local-view-lookalike" }
      })
    ).not.toEqual(original);
  });
});
