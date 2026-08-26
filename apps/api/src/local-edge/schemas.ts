import { z } from "zod";
import { expandMemoryNodeQuerySchema } from "../memory/graph-schemas.js";
import { finalMemoryQuestionSchema } from "../memory/questions-schemas.js";
import { searchMemorySchema } from "../memory/recall-schemas.js";

const operationFamilySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_.:-]+$/i);

const credentialKeyIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(160)
  .regex(/^[a-z0-9_.-]+$/i);

const localEdgeBackendIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);

const localCollaborationDeliveryIdSchema = z
  .string()
  .min(32)
  .max(86)
  .regex(/^[A-Za-z0-9_-]+$/);

const localPersonalCollaborationBindingSchema = z
  .object({
    scope: z.literal("personal")
  })
  .strict();

const localTeamCollaborationBindingSchema = z
  .object({
    scope: z.literal("team"),
    upstream_backend_id: localEdgeBackendIdSchema,
    team_id: z.uuid()
  })
  .strict();

const localCollaborationBindingSchema = z.discriminatedUnion("scope", [
  localPersonalCollaborationBindingSchema,
  localTeamCollaborationBindingSchema
]);

export const localEdgeOperationFamilySchema = z.enum([
  "personal_memory_read",
  "personal_collaboration_read",
  "personal_collaboration_write",
  "team_workspace_read",
  "team_chat_read",
  "team_chat_write",
  "share_grant_management",
  "action_grant",
  "capture_writes",
  "sync",
  "managed_execution",
  "admin"
]);

export const localEdgeRouteModeSchema = z.enum([
  "local_only",
  "live_upstream_proxy",
  "queued_sync_handoff"
]);

export const createDeviceEnrollmentChallengeSchema = z
  .object({
    challenge_hash: z.string().min(32),
    upstream_backend_id: z.string().trim().min(1).max(160),
    device_instance_id: z.string().trim().min(1).max(160).optional(),
    protocol_deployment_id: z.uuid(),
    source_owner_principal_id: z.uuid().optional(),
    rotate_credential_id: z.uuid().optional(),
    device_label: z.string().trim().min(1).max(160).optional(),
    requested_operation_families: z
      .array(operationFamilySchema)
      .min(1)
      .max(20)
      .optional(),
    pending_credential: z
      .object({
        credential_key_id: credentialKeyIdSchema,
        verifier_kind: z.literal("secret_hash"),
        verifier_secret: z.string().min(32),
        operation_families: z
          .array(operationFamilySchema)
          .min(1)
          .max(20)
          .optional(),
        expires_at: z.coerce.date().optional()
      })
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    ttl_seconds: z.number().int().min(60).max(3600).default(600)
  })
  .superRefine((input, context) => {
    if (
      input.requested_operation_families === undefined &&
      input.pending_credential?.operation_families === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["requested_operation_families"],
        message: "at least one requested operation family is required"
      });
    }
    if (input.requested_operation_families?.includes("admin")) {
      context.addIssue({
        code: "custom",
        path: ["requested_operation_families"],
        message:
          "admin operation family cannot be requested through browser-mediated device enrollment"
      });
    }
    if (input.pending_credential?.operation_families?.includes("admin")) {
      context.addIssue({
        code: "custom",
        path: ["pending_credential", "operation_families"],
        message:
          "admin operation family cannot be granted through browser-mediated device enrollment"
      });
    }
    const families =
      input.requested_operation_families ??
      input.pending_credential?.operation_families ??
      [];
    if (
      families.includes("share_grant_management") &&
      !input.source_owner_principal_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_owner_principal_id"],
        message:
          "Share Grant enrollment requires a source owner principal binding"
      });
    }
  });

export const deviceEnrollmentChallengeParamsSchema = z.object({
  challengeId: z.uuid()
});

export const approveDeviceEnrollmentChallengeSchema = z.object({
  decision: z.enum(["approve", "deny"])
});

export const publicDeviceEnrollmentChallengeSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(["pending", "approved", "denied", "expired"]),
    upstreamBackendId: z.string(),
    deviceInstanceId: z.string().nullable(),
    deviceLabel: z.string().nullable(),
    requestedOperationFamilies: z.array(operationFamilySchema),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    deniedAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict();

export type PublicDeviceEnrollmentChallenge = z.infer<
  typeof publicDeviceEnrollmentChallengeSchema
>;

export const redeemDeviceEnrollmentChallengeSchema = z
  .object({
    challenge_hash: z.string().min(32),
    credential_key_id: credentialKeyIdSchema,
    verifier_kind: z.literal("secret_hash"),
    verifier_secret: z.string().min(32).optional(),
    operation_families: z
      .array(operationFamilySchema)
      .min(1)
      .max(20)
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    expires_at: z.coerce.date().optional()
  })
  .superRefine((input, context) => {
    if (input.verifier_kind === "secret_hash" && !input.verifier_secret) {
      context.addIssue({
        code: "custom",
        path: ["verifier_secret"],
        message: "verifier_secret is required for secret_hash credentials"
      });
    }
    if (input.operation_families?.includes("admin")) {
      context.addIssue({
        code: "custom",
        path: ["operation_families"],
        message:
          "admin operation family cannot be granted through browser-mediated device enrollment"
      });
    }
  });

export const listDeviceCredentialsQuerySchema = z.object({
  upstream_backend_id: z.string().trim().min(1).max(160).optional()
});

export const deviceCredentialParamsSchema = z.object({
  credentialId: z.uuid()
});

export const revokeDeviceCredentialSchema = z.object({
  reason: z.string().trim().min(1).max(280).optional()
});

export const localEdgeRouteDecisionSchema = z.object({
  operation_family: localEdgeOperationFamilySchema,
  upstream_backend_id: z.string().trim().min(1).max(160).optional(),
  requested_mode: localEdgeRouteModeSchema.optional(),
  capture_context: z
    .object({
      project_id: z.string().min(1).optional(),
      session_id: z.uuid().optional(),
      thread_id: z.string().min(1).optional()
    })
    .optional()
});

export const localEdgeUpstreamOperationSchema =
  localEdgeRouteDecisionSchema.extend({
    upstream_backend_id: z.string().trim().min(1).max(160),
    requested_mode: z
      .literal("live_upstream_proxy")
      .default("live_upstream_proxy"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1).max(2048),
    body: z.unknown().optional()
  });

const localEdgeTeamMemoryBaseSchema = z
  .object({
    upstream_backend_id: localEdgeBackendIdSchema
  })
  .strict();

const localEdgeTeamMemoryRecallSchema = z
  .object({
    upstream_backend_id: localEdgeBackendIdSchema,
    input: searchMemorySchema
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.input.team_workspace_id) {
      context.addIssue({
        code: "custom",
        path: ["input", "team_workspace_id"],
        message: "team_workspace_id is required for Team Memory recall"
      });
    }
  });

export const localEdgeTeamMemorySearchSchema = localEdgeTeamMemoryRecallSchema;

export const localEdgeTeamMemoryAnswerSchema = localEdgeTeamMemoryRecallSchema;

export const localEdgeTeamMemoryQuestionSchema = localEdgeTeamMemoryBaseSchema
  .extend({ input: finalMemoryQuestionSchema })
  .strict()
  .superRefine((value, context) => {
    if (!value.input.team_workspace_id) {
      context.addIssue({
        code: "custom",
        path: ["input", "team_workspace_id"],
        message: "team_workspace_id is required for Team Memory questions"
      });
    }
  });

export const localEdgeTeamMemoryExpandSchema = localEdgeTeamMemoryBaseSchema
  .extend({
    node_id: z.uuid(),
    input: expandMemoryNodeQuerySchema
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.input.team_workspace_id) {
      context.addIssue({
        code: "custom",
        path: ["input", "team_workspace_id"],
        message: "team_workspace_id is required for Team Memory expansion"
      });
    }
  });

export const createLocalEdgeCollaborationSubscriptionSchema =
  localCollaborationBindingSchema;

export const localEdgeCollaborationSubscriptionParamsSchema = z
  .object({ subscriptionId: z.uuid() })
  .strict();

export const localEdgeCollaborationBackendParamsSchema = z
  .object({ backendId: localEdgeBackendIdSchema })
  .strict();

export const localEdgeCollaborationStreamQuerySchema =
  localCollaborationBindingSchema;

export const acknowledgeLocalEdgeCollaborationDeliverySchema =
  z.discriminatedUnion("scope", [
    localPersonalCollaborationBindingSchema.extend({
      delivery_id: localCollaborationDeliveryIdSchema,
      event_id: z.uuid().nullable(),
      expected_version: z.number().int().safe().min(0)
    }),
    localTeamCollaborationBindingSchema.extend({
      delivery_id: localCollaborationDeliveryIdSchema,
      event_id: z.uuid().nullable(),
      expected_version: z.number().int().safe().min(0)
    })
  ]);

export const unsubscribeLocalEdgeCollaborationSchema = z.discriminatedUnion(
  "scope",
  [
    localPersonalCollaborationBindingSchema.extend({
      expected_version: z.number().int().safe().positive()
    }),
    localTeamCollaborationBindingSchema.extend({
      expected_version: z.number().int().safe().positive()
    })
  ]
);
