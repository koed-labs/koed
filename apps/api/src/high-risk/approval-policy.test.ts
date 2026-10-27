import { publisherTakeoverReviewFixture } from "../shared-memory/test-fixtures/publisher-takeover-review.js";
import {
  noPrivacyLabelsPolicy,
  sharingRuleDetailReviewSchema,
  unresolvedTeamRepositorySnapshot
} from "@koed/shared";
import { describe, expect, it } from "vitest";

import { highRiskActionDefinitions } from "./action-definitions.js";
import {
  highRiskActionGrantIntentSchema,
  resolveHighRiskActionGrantOperation,
  type HighRiskActionGrantIntent
} from "./action-grant-protocol.js";

const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const capturedSource = {
  kind: "captured_session" as const,
  sessionId: uuid(4),
  logicalMemoryId: uuid(3)
};

const policyHash = "a".repeat(64);
const reviewedRule = {
  ruleId: uuid(30),
  teamId: uuid(1),
  teamWorkspaceId: uuid(2),
  maximumFidelity: "lcm_rollups",
  includeCuratedMemory: false,
  selectorKind: "captured_session",
  state: "active",
  previousMaximumFidelity: "lcm_rollups",
  previousIncludeCuratedMemory: false,
  expectedAuthorityVersion: 1,
  publisherFence: 1,
  teamPolicyVersion: 1,
  teamPolicyHash: policyHash,
  workspacePolicyVersion: 1,
  workspacePolicyHash: policyHash,
  effectivePrivacyPolicyHash: policyHash,
  policyBindingHash: policyHash,
  memberBindingHash: policyHash,
  memberCount: 1,
  ownerPolicyExpansionCount: 0,
  disclosureIncrease: false,
  teamName: "Team",
  workspaceName: "Workspace",
  expiresAt: "2099-01-01T00:00:00.000Z",
  reviewHash: policyHash
} as const;
const exclusionScope = {
  ownerUserId: uuid(5),
  logicalMemoryId: uuid(3),
  teamId: uuid(1),
  teamWorkspaceId: uuid(2),
  expectedExclusionVersion: 1,
  shareGrantId: uuid(8),
  expectedGrantVersion: 1
};
const labels = noPrivacyLabelsPolicy();
const contentReview = sharingRuleDetailReviewSchema
  .omit({
    previousMaximumFidelity: true,
    previousIncludeCuratedMemory: true,
    ownerPolicyExpansionCount: true
  })
  .strip()
  .parse(reviewedRule);

const matrixCases: Array<{
  intent: HighRiskActionGrantIntent;
  expected: "direct" | "native_review" | "step_up";
}> = [
  {
    intent: {
      action: "shared_memory.publisher_takeover",
      mutationId: uuid(31),
      review: publisherTakeoverReviewFixture({
        ruleId: uuid(30),
        teamId: uuid(1),
        teamWorkspaceId: uuid(2),
        receivingCredentialId: uuid(32)
      })
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.rule_detail",
      mutationId: uuid(31),
      review: reviewedRule
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.rule_content_policy",
      mutationId: uuid(31),
      review: {
        ...contentReview,
        labels,
        previousLabels: labels,
        previousEffectiveLabels: labels,
        requiredLabels: labels,
        effectiveLabels: labels,
        globalPolicyHash: policyHash,
        previousGlobalPolicyHash: policyHash,
        expectedContentPolicyVersion: 1
      }
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.rule_control",
      mutationId: uuid(31),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      ruleId: uuid(30),
      reasonId: uuid(32),
      shareGrantId: uuid(8),
      expectedAuthorityVersion: 1,
      expectedGrantVersion: 1,
      controlAction: "pause"
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.repository_rule_control",
      mutationId: uuid(31),
      selectorKind: "selection",
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      ruleId: uuid(30),
      expectedAuthorityVersion: 1,
      publisherFence: 1,
      controlAction: "pause"
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.repository_rule_create",
      mutationId: uuid(31),
      ruleId: uuid(30),
      selector: {
        kind: "portable_repository",
        key: "github.com/example/catalog"
      },
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      includesFutureConversations: true,
      completedReviewHash: policyHash,
      selectionSnapshotVersion: uuid(33),
      teamPolicyVersion: 1,
      teamPolicyHash: policyHash,
      workspacePolicyVersion: 1,
      workspacePolicyHash: policyHash,
      effectivePrivacyPolicyHash: policyHash
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.conversation_rule_create",
      mutationId: uuid(31),
      ruleId: uuid(30),
      logicalGrantId: uuid(8),
      consentId: uuid(34),
      expectedGrantVersion: null,
      effectivePrivacyPolicyHash: policyHash,
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups"],
      activationRepresentation: "lcm_rollups",
      previewId: uuid(35),
      previewHash: policyHash,
      previewRevision: 1,
      logicalMemoryId: uuid(3),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      mode: "continuous",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      expiresAt: null
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.workspace_exclude",
      mutationId: uuid(31),
      scope: exclusionScope
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.workspace_restore",
      mutationId: uuid(31),
      scope: exclusionScope,
      restoration: {
        scope: exclusionScope,
        source: { logicalMemoryId: uuid(3), title: "Source" },
        team: { id: uuid(1), name: "Team" },
        workspace: { id: uuid(2), name: "Workspace" },
        exclusion: {
          id: uuid(36),
          ownerUserId: uuid(5),
          logicalMemoryId: uuid(3),
          teamId: uuid(1),
          teamWorkspaceId: uuid(2),
          version: 1,
          state: "excluded",
          excludedAt: "2026-10-21T00:00:00.000Z",
          restoredAt: null,
          updatedAt: "2026-10-21T00:00:00.000Z"
        },
        rules: [],
        authorityHash: policyHash,
        expiresAt: "2099-01-01T00:00:00.000Z",
        reviewHash: policyHash
      }
    },
    expected: "native_review"
  },
  {
    intent: { action: "team.create", body: { name: "Koed" } },
    expected: "direct"
  },
  {
    intent: { action: "team.invite.accept", body: { inviteToken: "token" } },
    expected: "native_review"
  },
  {
    intent: {
      action: "team.member.role_update",
      teamId: uuid(1),
      userId: uuid(5),
      body: { role: "admin", expectedVersion: 1 }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.member.disable",
      teamId: uuid(1),
      userId: uuid(5),
      body: { expectedVersion: 1 }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.leave",
      teamId: uuid(1),
      body: { expectedVersion: 1 }
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "team.invite.create",
      teamId: uuid(1),
      body: {
        defaultTeamWorkspaceId: uuid(2),
        defaultWorkspaceAccess: "write",
        email: "invitee@example.test",
        role: "member",
        ttlHours: 24
      }
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "team.invite.revoke",
      teamId: uuid(1),
      inviteId: uuid(3),
      body: { expectedVersion: 1 }
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "team.entitlement.update",
      teamId: uuid(1),
      body: { expectedVersion: 1, status: "suspended", reason: "policy" }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.billing_seats.update",
      teamId: uuid(1),
      body: { expectedVersion: 1, seatLimit: 12 }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.workspace.create",
      teamId: uuid(1),
      body: { name: "Engineering", description: null }
    },
    expected: "direct"
  },
  {
    intent: {
      action: "team.workspace.archive",
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      body: { expectedVersion: 1 }
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "team.workspace.restore",
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      body: { expectedVersion: 1 }
    },
    expected: "direct"
  },
  {
    intent: {
      action: "team.workspace.access_update",
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      body: { userId: uuid(5), access: "write", expectedVersion: 1 }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.retention.delete_request",
      teamId: uuid(1),
      body: { expectedVersion: 1 }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.legal_hold.place",
      body: {
        target: { scope: "team", teamId: uuid(1) },
        reasonCode: "litigation",
        reasonHash: "a".repeat(64)
      }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.legal_hold.release_request",
      holdId: uuid(9),
      body: {}
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "team.legal_hold.release_confirm",
      holdId: uuid(9),
      body: { singleHolderReleaseException: false }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "shared_memory.preview",
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "lcm_rollups",
      mode: "continuous",
      logicalMemoryId: uuid(3),
      remoteReplicaId: uuid(4),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false
    },
    expected: "direct"
  },
  {
    intent: {
      action: "shared_memory.candidate_preview",
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "lcm_rollups",
      logicalMemoryId: uuid(3),
      candidateHash: "a".repeat(64),
      sourceRevision: 1,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: uuid(4), revisionHash: "b".repeat(64) }],
      byteCount: 128,
      sourceDeploymentProtocolId: uuid(5),
      sourceOwnerPrincipalId: uuid(6),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      mode: "snapshot",
      expiresAt: null
    },
    expected: "direct"
  },
  {
    intent: {
      action: "shared_memory.pending_share",
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "lcm_rollups",
      mutationId: uuid(6),
      logicalGrantId: uuid(7),
      expectedGrantVersion: null,
      logicalMemoryId: uuid(3),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      consentId: uuid(8),
      previewId: uuid(9),
      mode: "snapshot",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      previewRevision: 1,
      previewHash: "b".repeat(64),
      expiresAt: null
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.revoke",
      mutationId: uuid(6),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      shareGrantId: uuid(7),
      expectedGrantVersion: 1,
      reasonCode: "owner_revoked"
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.update_repository_snapshot",
      mutationId: uuid(6),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      shareGrantId: uuid(7),
      expected: {
        shareGrantId: uuid(7),
        teamId: uuid(1),
        teamWorkspaceId: uuid(2),
        grantVersion: 1,
        sourceRevision: 0,
        representationId: uuid(10),
        representationVersion: 1,
        assignmentVersion: 1,
        sourceContextHash: "d".repeat(64),
        currentSnapshot: unresolvedTeamRepositorySnapshot()
      }
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.conversation_source_grant",
      mutationId: uuid(6),
      teamId: uuid(1),
      shareGrantId: uuid(7),
      expectedVersion: 0,
      mode: "continuous"
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "shared_memory.conversation_source_revoke",
      mutationId: uuid(6),
      teamId: uuid(1),
      shareGrantId: uuid(7),
      expectedVersion: 1,
      reasonCode: "owner_revoked"
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "shared_memory.change_fidelity",
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "lcm_rollups",
      mutationId: uuid(6),
      logicalMemoryId: uuid(3),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      shareGrantId: uuid(7),
      consentId: uuid(8),
      previewId: uuid(9),
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: true,
      expectedGrantVersion: 1,
      mode: "continuous",
      previewRevision: 1,
      previewHash: "c".repeat(64),
      expiresAt: null
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "conversation_source.discover",
      body: { cursor: null, limit: 50 }
    },
    expected: "direct"
  },
  {
    intent: {
      action: "conversation_source.download",
      sourceGenerationId: uuid(10),
      sourceComponentId: "agent.researcher",
      targetDeploymentId: uuid(11),
      firstSegmentIndex: 0,
      recipientKey: {
        algorithm: "RSA-OAEP-SHA256",
        keyId: uuid(12),
        keyVersion: 1,
        publicJwk: {
          kty: "RSA",
          n: "test-modulus",
          e: "AQAB",
          alg: "RSA-OAEP-256",
          key_ops: ["encrypt"],
          ext: true,
          kid: uuid(12),
          use: "enc"
        }
      }
    },
    expected: "step_up"
  },
  {
    intent: {
      action: "managed_conversation.handoff",
      executionId: uuid(13),
      body: { operationId: uuid(14), targetDeviceId: uuid(15) }
    },
    expected: "native_review"
  },
  {
    intent: {
      action: "managed_conversation.fork",
      executionId: uuid(13),
      body: {
        operationId: uuid(14),
        targetDeviceId: uuid(15),
        reason: "user_requested"
      }
    },
    expected: "step_up"
  }
];

describe("action approval policy", () => {
  it("defines one exhaustive action entry for every supported action", () => {
    const schemaActions = highRiskActionGrantIntentSchema.options.map(
      (option) => option.shape.action.value
    );
    const policyActions = matrixCases.map(({ intent }) => intent.action);
    expect(Object.keys(highRiskActionDefinitions).sort()).toEqual(
      [...schemaActions].sort()
    );
    expect([...new Set(policyActions)].sort()).toEqual(
      [...schemaActions].sort()
    );
    expect(
      Object.values(highRiskActionDefinitions).every(
        (definition) => definition.operationFamily.length > 0
      )
    ).toBe(true);
  });

  it.each(matrixCases)(
    "resolves the cataloged operation family for $intent.action",
    async ({ intent }) => {
      expect(highRiskActionGrantIntentSchema.safeParse(intent).success).toBe(
        true
      );
      const definition = highRiskActionDefinitions[intent.action];
      const operation = await resolveHighRiskActionGrantOperation({
        clientRequestId: uuid(99),
        intent,
        resolveWorkspaceTeamId: async () => uuid(1),
        resolveLegalHoldTeamId: async () => uuid(1),
        resolveConversationSourceArtifactId: async () => uuid(20)
      });
      expect(operation).not.toBeNull();
      expect(operation?.operationFamily).toBe(definition.operationFamily);
    }
  );
});
