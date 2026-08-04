import { describe, expect, it } from "vitest";

import {
  ActionApprovalPolicyError,
  resolveActionApprovalPolicy,
  type ActionApprovalPolicyContext
} from "./approval-policy.js";
import {
  highRiskActionDefinitions,
  highRiskActionGrantIntentSchema,
  type HighRiskActionGrantIntent
} from "./action-grant-protocol.js";

const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const policy = (
  intent: HighRiskActionGrantIntent,
  context: ActionApprovalPolicyContext = {}
) => resolveActionApprovalPolicy(intent, context);

const matrixCases: Array<{
  intent: HighRiskActionGrantIntent;
  context?: ActionApprovalPolicyContext;
  expected: "direct" | "native_review" | "step_up";
}> = [
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
      logicalMemoryId: uuid(3),
      remoteReplicaId: uuid(4),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      representation: "lcm_rollups",
      allowedRepresentations: ["lcm_rollups"]
    },
    expected: "direct"
  },
  {
    intent: {
      action: "shared_memory.share",
      mutationId: uuid(6),
      logicalGrantId: uuid(7),
      logicalMemoryId: uuid(3),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      consentId: uuid(8),
      previewId: uuid(9),
      mode: "snapshot",
      allowedRepresentations: ["lcm_rollups"],
      selectedRepresentation: "lcm_rollups",
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
      action: "shared_memory.change_representation",
      mutationId: uuid(6),
      logicalMemoryId: uuid(3),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      shareGrantId: uuid(7),
      consentId: uuid(8),
      previewId: uuid(9),
      representation: "lcm_rollups",
      expectedGrantVersion: 1,
      mode: "continuous",
      allowedRepresentations: ["lcm_rollups", "memory_events"],
      previewRevision: 1,
      previewHash: "c".repeat(64),
      expiresAt: null
    },
    context: { currentRepresentation: "memory_events" },
    expected: "native_review"
  },
  {
    intent: {
      action: "conversation_source.discover",
      body: { cursor: null, limit: 50 }
    },
    context: { enrolledSyncRelationship: true },
    expected: "direct"
  },
  {
    intent: {
      action: "conversation_source.download",
      sourceGenerationId: uuid(10),
      targetDeploymentId: uuid(11),
      firstSegmentIndex: 0,
      recipientKey: {
        algorithm: "x25519-aes-256-gcm",
        keyId: uuid(12),
        keyVersion: 1,
        publicJwk: {
          kty: "OKP",
          crv: "X25519",
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
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
    context: { targetDeviceTrusted: true },
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
    context: { targetDeviceTrusted: false },
    expected: "step_up"
  }
];

describe("action approval policy", () => {
  it("defines one complete operation, context, and policy entry for every supported action", () => {
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
        (definition) =>
          definition.operationFamily.length > 0 &&
          Array.isArray(definition.context)
      )
    ).toBe(true);
  });

  it.each(matrixCases)(
    "resolves the cataloged operation family for $intent.action",
    async ({ intent, context, expected }) => {
      const definition = highRiskActionDefinitions[intent.action];
      const operation = await definition.resolveOperation({
        clientRequestId: uuid(99),
        intent,
        resolveWorkspaceTeamId: async () => uuid(1),
        resolveLegalHoldTeamId: async () => uuid(1)
      });
      expect(operation).not.toBeNull();
      expect(operation?.operationFamily).toBe(definition.operationFamily);
      expect(definition.resolvePolicy(intent, context).disposition).toBe(
        expected
      );
    }
  );

  it.each(matrixCases)(
    "covers the final matrix disposition for $intent.action",
    ({ intent, context, expected }) => {
      const resolved = policy(intent, context);
      expect(resolved.disposition).toBe(expected);
      expect(resolved.review === null).toBe(expected === "direct");
    }
  );

  it.each([
    { action: "team.create", body: { name: "Koed" } },
    {
      action: "team.workspace.create",
      teamId: uuid(1),
      body: { name: "Engineering", description: null }
    },
    {
      action: "team.workspace.restore",
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      body: { expectedVersion: 2 }
    },
    {
      action: "shared_memory.preview",
      logicalMemoryId: uuid(3),
      remoteReplicaId: uuid(4),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      representation: "lcm_rollups",
      allowedRepresentations: ["lcm_rollups"]
    }
  ] as HighRiskActionGrantIntent[])(
    "assigns $action to Direct without review copy",
    (intent) => {
      expect(policy(intent)).toEqual({ disposition: "direct", review: null });
    }
  );

  it("assigns invitation acceptance to Native review", () => {
    const resolved = policy(
      { action: "team.invite.accept", body: { inviteToken: "token" } },
      { display: { team: "Koed Labs", workspace: "Engineering" } }
    );
    expect(resolved.disposition).toBe("native_review");
    expect(resolved.review?.title).toContain("Koed Labs");
    expect(resolved.review?.details).toContainEqual({
      label: "Initial Workspace",
      value: "Engineering"
    });
  });

  it("uses Step-up for promotions and Native review for demotions", () => {
    const intent = {
      action: "team.member.role_update",
      teamId: uuid(1),
      userId: uuid(5),
      body: { role: "admin", expectedVersion: 1 }
    } satisfies HighRiskActionGrantIntent;
    expect(policy(intent, { currentMemberRole: "member" }).disposition).toBe(
      "step_up"
    );
    expect(
      policy(
        { ...intent, body: { ...intent.body, role: "member" } },
        { currentMemberRole: "admin" }
      ).disposition
    ).toBe("native_review");
    expect(policy(intent).disposition).toBe("step_up");
  });

  it("fails conditional Workspace Access toward Step-up", () => {
    const intent = {
      action: "team.workspace.access_update",
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      body: { userId: uuid(5), access: "read", expectedVersion: 1 }
    } satisfies HighRiskActionGrantIntent;
    expect(
      policy(intent, { currentWorkspaceAccess: "write" }).disposition
    ).toBe("native_review");
    expect(
      policy(
        { ...intent, body: { ...intent.body, access: "write" } },
        { currentWorkspaceAccess: "read" }
      ).disposition
    ).toBe("step_up");
    expect(policy(intent).disposition).toBe("step_up");
  });

  it("uses representation fidelity to choose Native review or Step-up", () => {
    const base = {
      action: "shared_memory.change_representation",
      mutationId: uuid(6),
      logicalMemoryId: uuid(3),
      teamId: uuid(1),
      teamWorkspaceId: uuid(2),
      shareGrantId: uuid(7),
      consentId: uuid(8),
      previewId: uuid(9),
      expectedGrantVersion: 1,
      mode: "continuous",
      allowedRepresentations: [
        "lcm_rollups",
        "lcm_leaves",
        "memory_events"
      ] as const,
      previewRevision: 1,
      previewHash: "d".repeat(64),
      expiresAt: null
    } as const;
    expect(
      policy(
        { ...base, representation: "lcm_rollups" },
        { currentRepresentation: "memory_events" }
      ).disposition
    ).toBe("native_review");
    expect(
      policy(
        { ...base, representation: "memory_events" },
        { currentRepresentation: "lcm_leaves" }
      ).disposition
    ).toBe("step_up");
  });

  it("keeps attached source downloads as Bundled stages", () => {
    expect(
      policy(
        {
          action: "conversation_source.download",
          sourceGenerationId: uuid(10),
          targetDeploymentId: uuid(11),
          firstSegmentIndex: 0,
          recipientKey: {
            algorithm: "x25519-aes-256-gcm",
            keyId: uuid(12),
            keyVersion: 1,
            publicJwk: {
              kty: "OKP",
              crv: "X25519",
              x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
          }
        },
        { bundledSourceTransfer: true }
      ).disposition
    ).toBe("bundled_stage");
  });

  it("fails source discovery closed outside an enrolled sync relationship", () => {
    expect(() =>
      policy({
        action: "conversation_source.discover",
        body: { cursor: null, limit: 50 }
      })
    ).toThrow(ActionApprovalPolicyError);
  });

  it("keeps governance and commercial actions on Step-up", () => {
    expect(
      policy({
        action: "team.entitlement.update",
        teamId: uuid(1),
        body: { expectedVersion: 1, status: "suspended", reason: "policy" }
      }).disposition
    ).toBe("step_up");
    expect(
      policy({
        action: "team.member.disable",
        teamId: uuid(1),
        userId: uuid(5),
        body: { expectedVersion: 1 }
      }).disposition
    ).toBe("step_up");
  });
});
