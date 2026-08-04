import {
  calculateConversationSourceDownloadRequestHash,
  calculateConversationSourceDownloadScopeHash,
  calculateConversationSourceDiscoveryRequestHash,
  calculateConversationSourceDiscoveryScopeHash,
  collaborationActionGrantIntentSchema,
  collaborationApprovalReviewSchema,
  collaborationApprovalTierSchema,
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRepresentationBundleActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding,
  type CollaborationActionGrantIntent
} from "@koed/shared";
import { z } from "zod";

import {
  resolveActionApprovalPolicy,
  type ActionApprovalPolicy,
  type ActionApprovalPolicyContext
} from "./approval-policy.js";

import {
  confirmLegalHoldReleaseSchema,
  placeLegalHoldSchema,
  rootTeamDeletionRequestSchema
} from "../retention/schemas.js";
import {
  createSourceOwnerConsentSchema,
  createSharedMemoryPreviewSchema,
  revokeShareGrantSchema,
  selectGrantRepresentationSchema
} from "../shared-memory/schemas.js";
import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import {
  acceptTeamInviteSchema,
  createTeamInviteSchema,
  createTeamSchema,
  createTeamWorkspaceSchema,
  expectedVersionSchema,
  setTeamBillingSeatPolicySchema,
  setTeamEntitlementStateSchema,
  setTeamWorkspaceAccessSchema,
  updateTeamMemberRoleSchema
} from "../team/schemas.js";
import {
  retentionAdminRequestHash,
  retentionAdminScopeHash
} from "../retention/routes.js";
import {
  sourceDiscoverySchema,
  sourceReplicationRecipientKeySchema
} from "../source-replication/schemas.js";

const uuidSchema = z.uuid();
const activationPathSchema = z
  .string()
  .regex(
    /^\/v1\/high-risk\/browser-activations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
const grantCommitmentSchema = z.string().regex(/^v1:[0-9A-Fa-f]{64}$/);

const createTeamWorkspaceProtectedBodySchema = createTeamWorkspaceSchema.omit({
  teamId: true
});

export const highRiskActionGrantIntentSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("team.create"), body: createTeamSchema })
    .strict(),
  z
    .object({
      action: z.literal("team.invite.accept"),
      body: acceptTeamInviteSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.member.role_update"),
      teamId: uuidSchema,
      userId: uuidSchema,
      body: updateTeamMemberRoleSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.member.disable"),
      teamId: uuidSchema,
      userId: uuidSchema,
      body: expectedVersionSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.leave"),
      teamId: uuidSchema,
      body: expectedVersionSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.invite.create"),
      teamId: uuidSchema,
      body: createTeamInviteSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.invite.revoke"),
      teamId: uuidSchema,
      inviteId: uuidSchema,
      body: expectedVersionSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.entitlement.update"),
      teamId: uuidSchema,
      body: setTeamEntitlementStateSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.billing_seats.update"),
      teamId: uuidSchema,
      body: setTeamBillingSeatPolicySchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.workspace.create"),
      teamId: uuidSchema.optional(),
      body: z.union([
        createTeamWorkspaceSchema,
        createTeamWorkspaceProtectedBodySchema
      ])
    })
    .strict(),
  z
    .object({
      action: z.literal("team.workspace.archive"),
      teamId: uuidSchema.optional(),
      teamWorkspaceId: uuidSchema,
      body: expectedVersionSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.workspace.restore"),
      teamId: uuidSchema.optional(),
      teamWorkspaceId: uuidSchema,
      body: expectedVersionSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.workspace.access_update"),
      teamId: uuidSchema.optional(),
      teamWorkspaceId: uuidSchema,
      body: setTeamWorkspaceAccessSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.retention.delete_request"),
      teamId: uuidSchema,
      body: rootTeamDeletionRequestSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.legal_hold.place"),
      body: placeLegalHoldSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("team.legal_hold.release_request"),
      holdId: uuidSchema,
      body: z.object({}).strict()
    })
    .strict(),
  z
    .object({
      action: z.literal("team.legal_hold.release_confirm"),
      holdId: uuidSchema,
      body: confirmLegalHoldReleaseSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("shared_memory.preview"),
      logicalMemoryId: uuidSchema,
      remoteReplicaId: uuidSchema,
      teamId: uuidSchema,
      teamWorkspaceId: uuidSchema,
      representation: createSharedMemoryPreviewSchema.shape.representation,
      allowedRepresentations:
        createSourceOwnerConsentSchema.shape.allowedRepresentations
    })
    .strict(),
  z
    .object({
      action: z.literal("shared_memory.share"),
      mutationId: uuidSchema,
      logicalGrantId: uuidSchema,
      logicalMemoryId: uuidSchema,
      teamId: uuidSchema,
      teamWorkspaceId: uuidSchema,
      consentId: uuidSchema,
      previewId: uuidSchema,
      mode: createSourceOwnerConsentSchema.shape.mode,
      allowedRepresentations:
        createSourceOwnerConsentSchema.shape.allowedRepresentations,
      selectedRepresentation:
        createSourceOwnerConsentSchema.shape.selectedRepresentation,
      previewRevision: z.number().int().safe().positive(),
      previewHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.string().datetime({ offset: true }).nullable()
    })
    .strict(),
  z
    .object({
      action: z.literal("shared_memory.revoke"),
      mutationId: uuidSchema,
      teamId: uuidSchema,
      teamWorkspaceId: uuidSchema,
      shareGrantId: uuidSchema,
      expectedGrantVersion: revokeShareGrantSchema.shape.expectedGrantVersion,
      reasonCode: revokeShareGrantSchema.shape.reasonCode
    })
    .strict(),
  z
    .object({
      action: z.literal("shared_memory.change_representation"),
      mutationId: uuidSchema,
      logicalMemoryId: uuidSchema,
      teamId: uuidSchema,
      teamWorkspaceId: uuidSchema,
      shareGrantId: uuidSchema,
      consentId: uuidSchema,
      previewId: uuidSchema,
      representation: createSharedMemoryPreviewSchema.shape.representation,
      expectedGrantVersion:
        selectGrantRepresentationSchema.shape.expectedGrantVersion,
      mode: createSourceOwnerConsentSchema.shape.mode,
      allowedRepresentations:
        createSourceOwnerConsentSchema.shape.allowedRepresentations,
      previewRevision: z.number().int().safe().positive(),
      previewHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.string().datetime({ offset: true }).nullable()
    })
    .strict(),
  z
    .object({
      action: z.literal("conversation_source.discover"),
      body: sourceDiscoverySchema
    })
    .strict(),
  z
    .object({
      action: z.literal("conversation_source.download"),
      sourceGenerationId: uuidSchema,
      targetDeploymentId: uuidSchema,
      firstSegmentIndex: z.number().int().safe().nonnegative(),
      recipientKey: sourceReplicationRecipientKeySchema
    })
    .strict(),
  z
    .object({
      action: z.literal("managed_conversation.handoff"),
      executionId: uuidSchema,
      body: z
        .object({
          operationId: uuidSchema,
          targetDeviceId: uuidSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      action: z.literal("managed_conversation.fork"),
      executionId: uuidSchema,
      body: z
        .object({
          operationId: uuidSchema,
          targetDeviceId: uuidSchema,
          reason: z.enum([
            "user_requested",
            "incompatible_provider",
            "origin_unavailable",
            "independent_work"
          ])
        })
        .strict()
    })
    .strict()
]);

export const highRiskActionGrantCreateRequestSchema = z
  .object({
    version: z.literal(1),
    clientRequestId: uuidSchema,
    grantCommitment: grantCommitmentSchema,
    intent: highRiskActionGrantIntentSchema
  })
  .strict();

export const highRiskActionGrantStatusStateSchema = z.enum([
  "pending",
  "review_required",
  "approved",
  "consumed",
  "denied",
  "revoked",
  "expired",
  "canceled"
]);

export const highRiskActionGrantRemoteStatusSchema = z
  .object({
    version: z.literal(1),
    actionGrant: z.object({ id: uuidSchema }).strict(),
    selector: uuidSchema,
    approvalTier: collaborationApprovalTierSchema,
    review: collaborationApprovalReviewSchema.nullable(),
    state: highRiskActionGrantStatusStateSchema,
    activationPath: activationPathSchema.nullable(),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((status, context) => {
    if ((status.approvalTier === "direct") !== (status.review === null)) {
      context.addIssue({
        code: "custom",
        path: ["review"],
        message:
          status.approvalTier === "direct"
            ? "Direct Action Grants must not carry confirmation copy"
            : "Reviewed Action Grants require authoritative confirmation copy"
      });
    }
    const browserPending = status.state === "pending";
    if (browserPending !== (status.activationPath !== null)) {
      context.addIssue({
        code: "custom",
        path: ["activationPath"],
        message: browserPending
          ? "Pending Action Grants require an activation path"
          : "Approved or terminal Action Grants must not expose an activation path"
      });
      return;
    }
    if (browserPending && status.approvalTier !== "step_up") {
      context.addIssue({
        code: "custom",
        path: ["approvalTier"],
        message: "Only Step-up grants may expose browser activation"
      });
    }
    if (
      status.state === "review_required" &&
      status.approvalTier !== "native_review"
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvalTier"],
        message: "Native review is required for review_required state"
      });
    }
    if (
      status.activationPath !== null &&
      status.activationPath !==
        `/v1/high-risk/browser-activations/${status.selector}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["activationPath"],
        message: "Activation path must match the browser activation selector"
      });
    }
  });

export const highRiskActionGrantRemoteEnvelopeSchema = z
  .object({ status: highRiskActionGrantRemoteStatusSchema })
  .strict();

export type HighRiskActionGrantIntent = z.infer<
  typeof highRiskActionGrantIntentSchema
>;

export type HighRiskActionName = HighRiskActionGrantIntent["action"];
export type HighRiskApprovalContextKind =
  | "invitation_acceptance"
  | "team"
  | "workspace"
  | "members"
  | "revoked_invitation"
  | "managed_conversation"
  | "entitlement"
  | "billing_seats"
  | "representation_grant"
  | "revoked_grant"
  | "shared_memory_source";

const highRiskActionDefinitionMetadata = {
  "team.create": { operationFamily: "admin", context: [] },
  "team.invite.accept": {
    operationFamily: "admin",
    context: ["invitation_acceptance", "team", "workspace"]
  },
  "team.member.role_update": {
    operationFamily: "admin",
    context: ["team", "members"]
  },
  "team.member.disable": {
    operationFamily: "admin",
    context: ["team", "members"]
  },
  "team.leave": { operationFamily: "admin", context: ["team"] },
  "team.invite.create": {
    operationFamily: "admin",
    context: ["team", "workspace"]
  },
  "team.invite.revoke": {
    operationFamily: "admin",
    context: ["team", "revoked_invitation"]
  },
  "team.entitlement.update": {
    operationFamily: "admin",
    context: ["team", "entitlement"]
  },
  "team.billing_seats.update": {
    operationFamily: "admin",
    context: ["team", "billing_seats"]
  },
  "team.workspace.create": {
    operationFamily: "admin",
    context: ["team"]
  },
  "team.workspace.archive": {
    operationFamily: "admin",
    context: ["team", "workspace"]
  },
  "team.workspace.restore": {
    operationFamily: "admin",
    context: ["team", "workspace"]
  },
  "team.workspace.access_update": {
    operationFamily: "admin",
    context: ["team", "workspace", "members"]
  },
  "team.retention.delete_request": {
    operationFamily: "admin",
    context: ["team"]
  },
  "team.legal_hold.place": {
    operationFamily: "admin",
    context: ["team"]
  },
  "team.legal_hold.release_request": {
    operationFamily: "admin",
    context: ["team"]
  },
  "team.legal_hold.release_confirm": {
    operationFamily: "admin",
    context: ["team"]
  },
  "shared_memory.preview": {
    operationFamily: "share_grant_management",
    context: []
  },
  "shared_memory.share": {
    operationFamily: "share_grant_management",
    context: ["team", "workspace", "shared_memory_source"]
  },
  "shared_memory.revoke": {
    operationFamily: "share_grant_management",
    context: ["team", "workspace", "revoked_grant", "shared_memory_source"]
  },
  "shared_memory.change_representation": {
    operationFamily: "share_grant_management",
    context: [
      "team",
      "workspace",
      "representation_grant",
      "shared_memory_source"
    ]
  },
  "conversation_source.discover": {
    operationFamily: "source_download",
    context: []
  },
  "conversation_source.download": {
    operationFamily: "source_download",
    context: []
  },
  "managed_conversation.handoff": {
    operationFamily: "managed_execution",
    context: ["managed_conversation"]
  },
  "managed_conversation.fork": {
    operationFamily: "managed_execution",
    context: ["managed_conversation"]
  }
} as const satisfies Record<
  HighRiskActionName,
  {
    operationFamily:
      | "admin"
      | "share_grant_management"
      | "source_download"
      | "managed_execution";
    context: readonly HighRiskApprovalContextKind[];
  }
>;

type HighRiskActionDefinitionCatalog = {
  [TAction in HighRiskActionName]: (typeof highRiskActionDefinitionMetadata)[TAction] & {
    resolveOperation(input: {
      clientRequestId: string;
      intent: HighRiskActionGrantIntent;
      resolveWorkspaceTeamId?: (
        teamWorkspaceId: string
      ) => Promise<string | null>;
      resolveLegalHoldTeamId?: (holdId: string) => Promise<string | null>;
    }): ReturnType<typeof resolveHighRiskActionGrantOperation>;
    resolvePolicy(
      intent: HighRiskActionGrantIntent,
      context?: ActionApprovalPolicyContext
    ): ActionApprovalPolicy;
  };
};

export const highRiskActionDefinitions = Object.fromEntries(
  Object.entries(highRiskActionDefinitionMetadata).map(([action, metadata]) => [
    action,
    {
      ...metadata,
      resolveOperation: (
        input: Parameters<typeof resolveHighRiskActionGrantOperation>[0]
      ) => {
        if (input.intent.action !== action) return null;
        return resolveHighRiskActionGrantOperation(input);
      },
      resolvePolicy: (
        intent: HighRiskActionGrantIntent,
        context?: ActionApprovalPolicyContext
      ) => {
        if (intent.action !== action) {
          throw new Error("Approval action definition mismatch");
        }
        return resolveActionApprovalPolicy(intent, context);
      }
    }
  ])
) as HighRiskActionDefinitionCatalog;

export interface HighRiskActionGrantOperation {
  operationFamily:
    | "admin"
    | "share_grant_management"
    | "source_download"
    | "managed_execution";
  action: string;
  teamId: string | null;
  targetId: string | null;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body: Record<string, unknown>;
}

export interface HighRiskResolvedActionGrantOperation extends HighRiskActionGrantOperation {
  scopeHash: string;
  requestHash: string;
}

export const managedConversationTransferScopeHash = (input: {
  action: "managed_conversation.handoff" | "managed_conversation.fork";
  executionId: string;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.managedConversationTransferScope,
    {
      operationFamily: "managed_execution",
      action: input.action,
      executionId: input.executionId
    }
  );

export const managedConversationTransferRequestHash = (input: {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.managedConversationTransferRequest,
    input
  );

const invitationTokenFromUrl = (
  backendBaseUrl: string,
  invitation: string
): string | null => {
  try {
    const parsed = new URL(invitation);
    const backendUrl = new URL(backendBaseUrl);
    const token = parsed.searchParams.get("token");
    const keys = [...parsed.searchParams.keys()];
    const invitationPath =
      `${backendUrl.pathname.replace(/\/+$/, "")}/invitations/accept`.replace(
        /\/{2,}/g,
        "/"
      );
    if (
      parsed.origin !== backendUrl.origin ||
      parsed.pathname !== invitationPath ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      keys.length !== 1 ||
      keys[0] !== "token" ||
      !token ||
      !/^kti_[A-Za-z0-9_-]{20,508}$/.test(token)
    ) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
};

export const highRiskActionGrantOperationFamilyForIntent = (
  intent: HighRiskActionGrantIntent
):
  | "admin"
  | "share_grant_management"
  | "source_download"
  | "managed_execution" =>
  highRiskActionDefinitions[intent.action].operationFamily;

export const highRiskActionGrantIntentFromCollaborationIntent = (
  backendBaseUrl: string,
  intent: CollaborationActionGrantIntent,
  resolved?: {
    sharedMemoryRemoteReplicaId?: string;
    sharedMemoryPreviewId?: string;
  }
): HighRiskActionGrantIntent | null => {
  collaborationActionGrantIntentSchema.parse(intent);
  switch (intent.intent) {
    case "collaboration.create_team":
      return { action: "team.create", body: { name: intent.name } };
    case "collaboration.join_team": {
      const inviteToken = invitationTokenFromUrl(
        backendBaseUrl,
        intent.invitation
      );
      return inviteToken
        ? { action: "team.invite.accept", body: { inviteToken } }
        : null;
    }
    case "collaboration.create_workspace":
      return {
        action: "team.workspace.create",
        teamId: intent.teamId,
        body: {
          name: intent.name,
          description: intent.description
        }
      };
    case "collaboration.create_invitation":
      return {
        action: "team.invite.create",
        teamId: intent.teamId,
        body: {
          email: intent.email,
          role: intent.role,
          defaultTeamWorkspaceId: intent.defaultWorkspaceId,
          defaultWorkspaceAccess: intent.defaultWorkspaceAccess,
          ttlHours: intent.ttlHours
        }
      };
    case "collaboration.revoke_invitation":
      return {
        action: "team.invite.revoke",
        teamId: intent.teamId,
        inviteId: intent.invitationId,
        body: { expectedVersion: intent.expectedVersion }
      };
    case "collaboration.update_member_role":
      return {
        action: "team.member.role_update",
        teamId: intent.teamId,
        userId: intent.userId,
        body: {
          role: intent.role,
          expectedVersion: intent.expectedVersion
        }
      };
    case "collaboration.disable_member":
      return {
        action: "team.member.disable",
        teamId: intent.teamId,
        userId: intent.userId,
        body: { expectedVersion: intent.expectedVersion }
      };
    case "collaboration.leave_team":
      return {
        action: "team.leave",
        teamId: intent.teamId,
        body: { expectedVersion: intent.expectedVersion }
      };
    case "collaboration.archive_workspace":
      return {
        action: "team.workspace.archive",
        teamId: intent.teamId,
        teamWorkspaceId: intent.workspaceId,
        body: { expectedVersion: intent.expectedVersion }
      };
    case "collaboration.restore_workspace":
      return {
        action: "team.workspace.restore",
        teamId: intent.teamId,
        teamWorkspaceId: intent.workspaceId,
        body: { expectedVersion: intent.expectedVersion }
      };
    case "collaboration.set_workspace_access":
      return {
        action: "team.workspace.access_update",
        teamId: intent.teamId,
        teamWorkspaceId: intent.workspaceId,
        body: {
          userId: intent.userId,
          access: intent.access,
          expectedVersion: intent.expectedVersion
        }
      };
    case "collaboration.preview_shared_memory":
      return resolved?.sharedMemoryRemoteReplicaId
        ? {
            action: "shared_memory.preview",
            logicalMemoryId: intent.logicalMemoryId,
            remoteReplicaId: resolved.sharedMemoryRemoteReplicaId,
            teamId: intent.teamId,
            teamWorkspaceId: intent.workspaceId,
            representation: intent.representation,
            allowedRepresentations: intent.allowedRepresentations
          }
        : null;
    case "collaboration.share_memory":
      return resolved?.sharedMemoryPreviewId
        ? {
            action: "shared_memory.share",
            mutationId: intent.mutationId,
            logicalGrantId: intent.logicalGrantId,
            logicalMemoryId: intent.logicalMemoryId,
            teamId: intent.teamId,
            teamWorkspaceId: intent.workspaceId,
            consentId: intent.consentId,
            previewId: resolved.sharedMemoryPreviewId,
            mode: intent.mode,
            allowedRepresentations: intent.allowedRepresentations,
            selectedRepresentation: intent.selectedRepresentation,
            previewRevision: intent.previewRevision,
            previewHash: intent.previewHash,
            expiresAt: intent.expiresAt
          }
        : null;
    case "collaboration.revoke_shared_memory":
      return {
        action: "shared_memory.revoke",
        mutationId: intent.mutationId,
        teamId: intent.teamId,
        teamWorkspaceId: intent.workspaceId,
        shareGrantId: intent.shareGrantId,
        expectedGrantVersion: intent.expectedGrantVersion,
        reasonCode: intent.reasonCode
      };
    case "collaboration.change_shared_memory_representation":
      return resolved?.sharedMemoryPreviewId
        ? {
            action: "shared_memory.change_representation",
            mutationId: intent.mutationId,
            logicalMemoryId: intent.logicalMemoryId,
            teamId: intent.teamId,
            teamWorkspaceId: intent.workspaceId,
            shareGrantId: intent.shareGrantId,
            consentId: intent.consentId,
            previewId: resolved.sharedMemoryPreviewId,
            representation: intent.representation,
            expectedGrantVersion: intent.expectedGrantVersion,
            mode: intent.mode,
            allowedRepresentations: intent.allowedRepresentations,
            previewRevision: intent.previewRevision,
            previewHash: intent.previewHash,
            expiresAt: intent.expiresAt
          }
        : null;
    case "collaboration.managed_conversation_handoff":
      return {
        action: "managed_conversation.handoff",
        executionId: intent.executionId,
        body: {
          operationId: intent.operationId,
          targetDeviceId: intent.targetDeviceId
        }
      };
    case "collaboration.managed_conversation_fork":
      return {
        action: "managed_conversation.fork",
        executionId: intent.executionId,
        body: {
          operationId: intent.operationId,
          targetDeviceId: intent.targetDeviceId,
          reason: intent.reason
        }
      };
    default:
      return null;
  }
};

const actionGrantOperation = (
  input: Omit<HighRiskResolvedActionGrantOperation, "scopeHash" | "requestHash">
): HighRiskActionGrantOperation => input;

const withTeamHashes = (
  input: HighRiskActionGrantOperation
): HighRiskResolvedActionGrantOperation => ({
  ...input,
  scopeHash: teamAdminScopeHash({
    action: input.action,
    teamId: input.teamId,
    targetId: input.targetId
  }),
  requestHash: teamAdminRequestHash({
    method: input.method,
    path: input.path,
    body: input.body
  })
});

const withRetentionHashes = (
  input: HighRiskActionGrantOperation
): HighRiskResolvedActionGrantOperation => ({
  ...input,
  scopeHash: retentionAdminScopeHash({
    action: input.action,
    teamId: input.teamId,
    targetId: input.targetId
  }),
  requestHash: retentionAdminRequestHash({
    method: input.method,
    path: input.path,
    body: input.body
  })
});

export const resolveHighRiskActionGrantOperation = (input: {
  clientRequestId: string;
  intent: HighRiskActionGrantIntent;
  resolveWorkspaceTeamId?: (teamWorkspaceId: string) => Promise<string | null>;
  resolveLegalHoldTeamId?: (holdId: string) => Promise<string | null>;
}):
  | HighRiskResolvedActionGrantOperation
  | null
  | Promise<HighRiskResolvedActionGrantOperation | null> => {
  const { clientRequestId, intent } = input;
  switch (intent.action) {
    case "team.create":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: null,
          targetId: null,
          method: "POST",
          path: "/v1/teams",
          body: intent.body
        })
      );
    case "team.invite.accept":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: null,
          targetId: null,
          method: "POST",
          path: "/v1/team-invites/accept",
          body: intent.body
        })
      );
    case "team.member.role_update":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.userId,
          method: "PATCH",
          path: `/v1/teams/${intent.teamId}/members/${intent.userId}/role`,
          body: intent.body
        })
      );
    case "team.member.disable":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.userId,
          method: "POST",
          path: `/v1/teams/${intent.teamId}/members/${intent.userId}/disable`,
          body: intent.body
        })
      );
    case "team.leave":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.teamId,
          method: "POST",
          path: `/v1/teams/${intent.teamId}/leave`,
          body: intent.body
        })
      );
    case "team.invite.create":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.body.defaultTeamWorkspaceId,
          method: "POST",
          path: `/v1/teams/${intent.teamId}/invites`,
          body: intent.body
        })
      );
    case "team.invite.revoke":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.inviteId,
          method: "DELETE",
          path: `/v1/teams/${intent.teamId}/invites/${intent.inviteId}`,
          body: intent.body
        })
      );
    case "team.entitlement.update":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.teamId,
          method: "PUT",
          path: `/v1/teams/${intent.teamId}/entitlement`,
          body: intent.body
        })
      );
    case "team.billing_seats.update":
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.teamId,
          method: "PUT",
          path: `/v1/teams/${intent.teamId}/billing-seats/policy`,
          body: intent.body
        })
      );
    case "team.workspace.create": {
      const teamId =
        intent.teamId ??
        ("teamId" in intent.body ? String(intent.body.teamId) : null);
      if (!teamId) {
        return null;
      }
      return withTeamHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId,
          targetId: null,
          method: "POST",
          path:
            intent.teamId === undefined
              ? "/v1/team-workspaces"
              : `/v1/teams/${teamId}/workspaces`,
          body: intent.body
        })
      );
    }
    case "team.workspace.archive":
    case "team.workspace.restore": {
      const build = (teamId: string) =>
        withTeamHashes(
          actionGrantOperation({
            operationFamily: "admin",
            action: intent.action,
            teamId,
            targetId: intent.teamWorkspaceId,
            method: "POST",
            path: `/v1/team-workspaces/${intent.teamWorkspaceId}/${
              intent.action === "team.workspace.archive" ? "archive" : "restore"
            }`,
            body: intent.body
          })
        );
      if (!input.resolveWorkspaceTeamId) {
        return intent.teamId ? build(intent.teamId) : null;
      }
      return input
        .resolveWorkspaceTeamId(intent.teamWorkspaceId)
        .then((resolvedTeamId) =>
          resolvedTeamId &&
          (intent.teamId === undefined || intent.teamId === resolvedTeamId)
            ? build(resolvedTeamId)
            : null
        );
    }
    case "team.workspace.access_update": {
      const build = (teamId: string) =>
        withTeamHashes(
          actionGrantOperation({
            operationFamily: "admin",
            action: intent.action,
            teamId,
            targetId: intent.teamWorkspaceId,
            method: "PUT",
            path: `/v1/team-workspaces/${intent.teamWorkspaceId}/access`,
            body: intent.body
          })
        );
      if (!input.resolveWorkspaceTeamId) {
        return intent.teamId ? build(intent.teamId) : null;
      }
      return input
        .resolveWorkspaceTeamId(intent.teamWorkspaceId)
        .then((teamId) =>
          teamId && (intent.teamId === undefined || intent.teamId === teamId)
            ? build(teamId)
            : null
        );
    }
    case "team.retention.delete_request":
      return withRetentionHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId: intent.teamId,
          targetId: intent.teamId,
          method: "POST",
          path: `/v1/retention/teams/${intent.teamId}/deletion-request`,
          body: intent.body
        })
      );
    case "team.legal_hold.place": {
      const teamId = intent.body.target.teamId;
      const targetId =
        "teamId" in intent.body.target ? intent.body.target.teamId : null;
      return withRetentionHashes(
        actionGrantOperation({
          operationFamily: "admin",
          action: intent.action,
          teamId,
          targetId,
          method: "POST",
          path: "/v1/retention/legal-holds",
          body: intent.body
        })
      );
    }
    case "team.legal_hold.release_request":
    case "team.legal_hold.release_confirm": {
      if (!input.resolveLegalHoldTeamId) {
        return null;
      }
      return input.resolveLegalHoldTeamId(intent.holdId).then((teamId) =>
        teamId
          ? withRetentionHashes(
              actionGrantOperation({
                operationFamily: "admin",
                action: intent.action,
                teamId,
                targetId: intent.holdId,
                method: "POST",
                path:
                  intent.action === "team.legal_hold.release_request"
                    ? `/v1/retention/legal-holds/${intent.holdId}/release-request`
                    : `/v1/retention/legal-holds/${intent.holdId}/release-confirmation`,
                body: intent.body
              })
            )
          : null
      );
    }
    case "shared_memory.preview":
      return sharedMemoryPreviewActionGrantBinding({
        referenceId: clientRequestId,
        logicalMemoryId: intent.logicalMemoryId,
        remoteReplicaId: intent.remoteReplicaId,
        teamId: intent.teamId,
        teamWorkspaceId: intent.teamWorkspaceId,
        representation: intent.representation,
        allowedRepresentations: intent.allowedRepresentations
      });
    case "shared_memory.share":
      return sharedMemoryShareBundleActionGrantBinding({
        referenceId: clientRequestId,
        mutationId: intent.mutationId,
        logicalGrantId: intent.logicalGrantId,
        logicalMemoryId: intent.logicalMemoryId,
        teamId: intent.teamId,
        teamWorkspaceId: intent.teamWorkspaceId,
        consentId: intent.consentId,
        previewId: intent.previewId,
        mode: intent.mode,
        allowedRepresentations: intent.allowedRepresentations,
        selectedRepresentation: intent.selectedRepresentation,
        previewRevision: intent.previewRevision,
        previewHash: intent.previewHash,
        expiresAt: intent.expiresAt
      });
    case "shared_memory.revoke":
      return sharedMemoryRevokeActionGrantBinding({
        referenceId: clientRequestId,
        mutationId: intent.mutationId,
        teamId: intent.teamId,
        teamWorkspaceId: intent.teamWorkspaceId,
        shareGrantId: intent.shareGrantId,
        expectedGrantVersion: intent.expectedGrantVersion,
        reasonCode: intent.reasonCode
      });
    case "shared_memory.change_representation":
      return sharedMemoryRepresentationBundleActionGrantBinding({
        referenceId: clientRequestId,
        mutationId: intent.mutationId,
        logicalMemoryId: intent.logicalMemoryId,
        teamId: intent.teamId,
        teamWorkspaceId: intent.teamWorkspaceId,
        shareGrantId: intent.shareGrantId,
        consentId: intent.consentId,
        previewId: intent.previewId,
        representation: intent.representation,
        expectedGrantVersion: intent.expectedGrantVersion,
        mode: intent.mode,
        allowedRepresentations: intent.allowedRepresentations,
        previewRevision: intent.previewRevision,
        previewHash: intent.previewHash,
        expiresAt: intent.expiresAt
      });
    case "conversation_source.discover":
      return {
        operationFamily: "source_download",
        action: intent.action,
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/conversation-source-replication/sources/discover",
        body: intent.body,
        scopeHash: calculateConversationSourceDiscoveryScopeHash(),
        requestHash: calculateConversationSourceDiscoveryRequestHash(
          intent.body
        )
      };
    case "conversation_source.download":
      return {
        operationFamily: "source_download",
        action: intent.action,
        teamId: null,
        targetId: intent.sourceGenerationId,
        method: "POST",
        path: "/v1/conversation-source-replication/download-authorizations",
        body: {
          sourceGenerationId: intent.sourceGenerationId,
          targetDeploymentId: intent.targetDeploymentId,
          firstSegmentIndex: intent.firstSegmentIndex,
          recipientKey: intent.recipientKey
        },
        scopeHash: calculateConversationSourceDownloadScopeHash({
          sourceGenerationId: intent.sourceGenerationId,
          targetDeploymentId: intent.targetDeploymentId,
          recipientKey: intent.recipientKey
        }),
        requestHash: calculateConversationSourceDownloadRequestHash({
          sourceGenerationId: intent.sourceGenerationId,
          targetDeploymentId: intent.targetDeploymentId,
          firstSegmentIndex: intent.firstSegmentIndex,
          recipientKey: intent.recipientKey
        })
      };
    case "managed_conversation.handoff":
    case "managed_conversation.fork": {
      const path = `/v1/managed-conversations/${intent.executionId}/${
        intent.action === "managed_conversation.handoff" ? "handoffs" : "forks"
      }`;
      return {
        operationFamily: "managed_execution",
        action: intent.action,
        teamId: null,
        targetId: intent.executionId,
        method: "POST",
        path,
        body: intent.body,
        scopeHash: managedConversationTransferScopeHash({
          action: intent.action,
          executionId: intent.executionId
        }),
        requestHash: managedConversationTransferRequestHash({
          method: "POST",
          path,
          body: intent.body
        })
      };
    }
  }
};
