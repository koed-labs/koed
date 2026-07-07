import { z } from "zod";

const operationFamilySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_.:-]+$/i);

export const localEdgeOperationFamilySchema = z.enum([
  "personal_memory_read",
  "team_workspace_read",
  "share_grant_management",
  "capture_writes",
  "sync",
  "admin"
]);

export const localEdgeRouteModeSchema = z.enum([
  "local_only",
  "live_upstream_proxy",
  "queued_sync_handoff"
]);

export const createDeviceEnrollmentChallengeSchema = z.object({
  challenge_hash: z.string().min(32),
  upstream_backend_id: z.string().trim().min(1).max(160),
  device_instance_id: z.string().trim().min(1).max(160).optional(),
  device_label: z.string().trim().min(1).max(160).optional(),
  requested_operation_families: z
    .array(operationFamilySchema)
    .max(20)
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  ttl_seconds: z.number().int().min(60).max(3600).default(600)
});

export const redeemDeviceEnrollmentChallengeSchema = z
  .object({
    challenge_hash: z.string().min(32),
    credential_key_id: z.string().trim().min(16).max(160),
    verifier_kind: z.enum(["secret_hash", "public_key_jwk"]),
    verifier_hash: z.string().min(32).optional(),
    public_key_jwk: z.record(z.string(), z.unknown()).optional(),
    operation_families: z.array(operationFamilySchema).max(20).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    expires_at: z.coerce.date().optional()
  })
  .superRefine((input, context) => {
    if (input.verifier_kind === "secret_hash" && !input.verifier_hash) {
      context.addIssue({
        code: "custom",
        path: ["verifier_hash"],
        message: "verifier_hash is required for secret_hash credentials"
      });
    }
    if (input.verifier_kind === "public_key_jwk" && !input.public_key_jwk) {
      context.addIssue({
        code: "custom",
        path: ["public_key_jwk"],
        message: "public_key_jwk is required for public_key_jwk credentials"
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
      workspace_id: z.string().min(1).optional(),
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
