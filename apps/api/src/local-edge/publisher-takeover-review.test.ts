import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  sharingSelectionDescriptor,
  sharingRulePublisherTakeoverReviewSchema,
  sharingRulePublisherTakeoverLocalIntentSchema,
  sharingRulePublisherTakeoverAppliedScopeSchema,
  sharedMemoryPublisherTakeoverActionGrantBinding,
  type SharingRulePublisherTakeoverLocalReview
} from "@koed/shared";
import { publisherTakeoverReviewFixture } from "../shared-memory/test-fixtures/publisher-takeover-review.js";
import {
  resolvePublisherTakeoverReview,
  verifyPublisherTakeoverLocalEvidence
} from "./publisher-takeover-review.js";

type Options = Parameters<typeof resolvePublisherTakeoverReview>[0];
const fixture = (
  kind:
    | "captured_session"
    | "repository"
    | "folder"
    | "project" = "captured_session"
) => {
  const owner = randomUUID(),
    session = randomUUID(),
    receiver = randomUUID();
  const review = publisherTakeoverReviewFixture({
    ruleId: randomUUID(),
    teamId: randomUUID(),
    teamWorkspaceId: randomUUID(),
    receivingCredentialId: receiver
  });
  const target: SharingRulePublisherTakeoverLocalReview["target"] =
    kind === "captured_session"
      ? undefined
      : kind === "project"
        ? {
            kind: "project",
            project: { ownerUserId: owner, projectId: randomUUID() }
          }
        : kind === "folder"
          ? {
              kind: "folder",
              folder: {
                ownerUserId: owner,
                folderId: "original-folder",
                originatingDeploymentId: "original-deployment",
                originatingDeviceId: "original-device",
                originatingProfileId: "original-profile",
                directoryIncarnationId: "original-incarnation"
              }
            }
          : {
              kind: "repository",
              repository: {
                kind: "portable_repository",
                key: "github.com/example/anchor",
                root: null,
                branch: null,
                reason: "origin",
                checkoutId: null,
                originatingDeviceId: "original-device",
                selectedRemote: null,
                anchorDisplay: null
              }
            };
  const backend = sharingRulePublisherTakeoverReviewSchema.parse({
    ...review,
    selectorKind: kind,
    selectionScope: target
      ? {
          ruleId: review.ruleId,
          teamId: review.teamId,
          teamWorkspaceId: review.teamWorkspaceId,
          mutationId: randomUUID(),
          selector: sharingSelectionDescriptor(target),
          maximumFidelity: review.maximumFidelity,
          includeCuratedMemory: review.includeCuratedMemory,
          effectivePrivacyPolicyHash: review.effectivePrivacyPolicyHash,
          includesFutureConversations: true,
          completedReviewHash: "b".repeat(64),
          selectionSnapshotVersion: randomUUID(),
          teamPolicyVersion: 1,
          teamPolicyHash: "c".repeat(64),
          workspacePolicyVersion: 1,
          workspacePolicyHash: "d".repeat(64)
        }
      : null
  });
  const available = {
    sourceIdentity: backend.sourceIdentity,
    source: {
      localSessionId: session,
      localLogicalSessionId: randomUUID(),
      identityState: "verified" as const,
      portable: { ownerUserId: owner, ...backend.sourceIdentity },
      contextVersion: { git: 1, folder: 1 }
    },
    ...(target ? { target } : {})
  };
  const options: Options = {
    input: {
      ruleId: backend.ruleId,
      teamId: backend.teamId,
      workspaceId: backend.teamWorkspaceId,
      expectedAuthorityVersion: backend.expectedAuthorityVersion,
      publisherFence: backend.publisherFence,
      localSessionId: session,
      ...(target ? { target } : {})
    },
    localOwnerUserId: owner,
    receivingCredentialId: receiver,
    readSource: vi.fn<Options["readSource"]>().mockResolvedValue(available),
    requestReview: vi.fn<Options["requestReview"]>().mockResolvedValue(backend)
  };
  return { options, available, backend };
};

describe("local publisher takeover review", () => {
  it.each(["captured_session", "repository", "folder", "project"] as const)(
    "binds verified %s evidence without sending local pointers or selector references",
    async (kind) => {
      const { options, available, backend } = fixture(kind);
      const result = await resolvePublisherTakeoverReview(options);
      expect(result).toEqual({
        review: backend,
        localSource: available.source,
        ...(available.target ? { target: available.target } : {})
      });
      expect(options.requestReview).toHaveBeenCalledWith({
        ruleId: backend.ruleId,
        teamId: backend.teamId,
        teamWorkspaceId: backend.teamWorkspaceId,
        expectedAuthorityVersion: backend.expectedAuthorityVersion,
        publisherFence: backend.publisherFence,
        sourceIdentity: backend.sourceIdentity
      });
      const localIntent = sharingRulePublisherTakeoverLocalIntentSchema.parse({
        ...result,
        operationKind: "publisher_takeover",
        mutationId: randomUUID(),
        ruleId: backend.ruleId,
        teamId: backend.teamId,
        teamWorkspaceId: backend.teamWorkspaceId
      });
      const bound = sharedMemoryPublisherTakeoverActionGrantBinding({
        ...localIntent,
        referenceId: randomUUID()
      });
      expect(bound.body).not.toHaveProperty("localSource");
      expect(bound.body).not.toHaveProperty("target");
      expect(
        await verifyPublisherTakeoverLocalEvidence({
          ...options,
          review: result
        })
      ).toBe(true);
      vi.mocked(options.readSource).mockResolvedValue({
        ...available,
        source: { ...available.source, contextVersion: { git: 2, folder: 2 } }
      });
      expect(
        await verifyPublisherTakeoverLocalEvidence({
          ...options,
          review: result
        })
      ).toBe(true);
      vi.mocked(options.readSource).mockResolvedValue(null);
      expect(
        await verifyPublisherTakeoverLocalEvidence({
          ...options,
          review: result
        })
      ).toBe(false);
    }
  );
  it("rejects missing receiving authority or unavailable/local-only source before a Team request", async () => {
    const { options, available } = fixture();
    await expect(
      resolvePublisherTakeoverReview({
        ...options,
        receivingCredentialId: null
      })
    ).rejects.toMatchObject({ code: "permission_denied" });
    vi.mocked(options.readSource)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...available,
        source: {
          ...available.source,
          identityState: "local_only",
          portable: null
        }
      });
    await expect(resolvePublisherTakeoverReview(options)).rejects.toMatchObject(
      { code: "not_available" }
    );
    await expect(resolvePublisherTakeoverReview(options)).rejects.toMatchObject(
      { code: "permission_denied" }
    );
    expect(options.requestReview).not.toHaveBeenCalled();
  });
  it.each([
    "owner",
    "source",
    "receiver",
    "destination",
    "version",
    "scope"
  ] as const)("rejects changed %s evidence", async (change) => {
    const { options, backend, available } = fixture(
      change === "scope" ? "folder" : "captured_session"
    );
    if (change === "owner")
      vi.mocked(options.readSource).mockResolvedValue({
        ...available,
        source: {
          ...available.source,
          portable: { ...available.source.portable, ownerUserId: randomUUID() }
        }
      });
    else
      vi.mocked(options.requestReview).mockResolvedValue({
        ...backend,
        ...(change === "source"
          ? {
              sourceIdentity: {
                ...backend.sourceIdentity,
                logicalSessionId: "different-origin"
              }
            }
          : change === "receiver"
            ? {
                receivingPublisher: {
                  ...backend.receivingPublisher,
                  credentialId: randomUUID()
                }
              }
            : change === "destination"
              ? { teamWorkspaceId: randomUUID() }
              : change === "version"
                ? {
                    expectedAuthorityVersion:
                      backend.expectedAuthorityVersion + 1
                  }
                : {
                    selectionScope: {
                      ...backend.selectionScope,
                      selector: { kind: "folder", key: "f".repeat(64) }
                    }
                  })
      });
    await expect(resolvePublisherTakeoverReview(options)).rejects.toMatchObject(
      { code: "permission_denied" }
    );
  });
  it.each(["active", "paused"] as const)(
    "requires the exact accepted %s transition",
    (state) => {
      const { backend } = fixture();
      backend.state = state;
      const result = {
        mutationId: randomUUID(),
        ruleId: backend.ruleId,
        state: backend.state,
        authorityVersion: backend.expectedAuthorityVersion + 1,
        publisherFence: backend.publisherFence + 1,
        previousPublisherCredentialId: backend.currentPublisher.credentialId,
        publisherCredentialId: backend.receivingPublisher.credentialId,
        catchUpState: state === "active" ? "queued" : "idle",
        approvedAt: new Date().toISOString()
      };
      expect(
        sharingRulePublisherTakeoverAppliedScopeSchema.safeParse({
          review: backend,
          result
        }).success
      ).toBe(true);
      for (const patch of [
        { publisherFence: backend.publisherFence },
        { publisherCredentialId: backend.currentPublisher.credentialId },
        { state: state === "active" ? "paused" : "active" },
        { catchUpState: state === "active" ? "idle" : "queued" }
      ])
        expect(
          sharingRulePublisherTakeoverAppliedScopeSchema.safeParse({
            review: backend,
            result: { ...result, ...patch }
          }).success
        ).toBe(false);
    }
  );
});
