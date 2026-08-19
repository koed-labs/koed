import {
  aiClientCapabilityIds,
  aiClientDriverIdMaxLength,
  aiClientIdentifierPattern,
  aiClientInstanceIdMaxLength,
  supportedAiClientDriverIds,
  type AiClientCapabilityId
} from "@koed/shared";
import { z } from "zod";

const aiClientDriverIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(aiClientDriverIdMaxLength)
  .regex(aiClientIdentifierPattern);
const aiClientInstanceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(aiClientInstanceIdMaxLength)
  .regex(aiClientIdentifierPattern);
const supportedAiClientDriverSchema = z.enum(supportedAiClientDriverIds);
const aiClientCapabilityIdValues = Object.values(aiClientCapabilityIds) as [
  AiClientCapabilityId,
  ...AiClientCapabilityId[]
];

export const aiClientInstanceParamsSchema = z
  .object({ instanceId: aiClientInstanceIdSchema })
  .strict();

export const aiClientInstanceSchema = z
  .object({
    driver_id: aiClientDriverIdSchema,
    display_name: z.string().trim().min(1).max(160),
    config_identity_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    enabled: z.boolean().optional()
  })
  .strict();

const aiClientDiagnosticDetailsSchema = z
  .record(z.string().trim().min(1).max(96), z.unknown())
  .superRefine((details, context) => {
    if (JSON.stringify(details).length > 8_192) {
      context.addIssue({
        code: "custom",
        message: "AI Client diagnostic details exceed bounded size."
      });
    }
  });

export const aiClientDiagnosticSchema = z
  .object({
    code: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(2000),
    severity: z.enum(["info", "warning", "error"]),
    details: aiClientDiagnosticDetailsSchema.optional()
  })
  .strict();

export const aiClientRecoveryActionSchema = z
  .object({
    id: z.enum(["setup", "check", "repair", "remove"]),
    label: z.string().trim().min(1).max(160),
    available: z.boolean()
  })
  .strict();

export const aiClientModelDescriptorSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(256).optional(),
    provider: z.string().trim().min(1).max(96).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    fullId: z.string().trim().min(1).max(384).optional(),
    provenance: z.enum([
      "reported",
      "configured",
      "known-compatible",
      "last-known-good"
    ]),
    supportedReasoningEfforts: z
      .array(z.string().trim().min(1).max(64))
      .max(32)
      .optional(),
    options: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const aiClientCapabilityDescriptorSchema = z
  .object({
    id: z.enum(aiClientCapabilityIdValues),
    support: z.enum(["supported", "unsupported"]),
    readiness: z.enum([
      "ready",
      "not_ready",
      "unauthenticated",
      "unavailable",
      "stale",
      "unknown"
    ]),
    diagnostics: z.array(aiClientDiagnosticSchema).max(100),
    recoveryAction: aiClientRecoveryActionSchema.optional()
  })
  .strict();

export const aiClientCapabilitySnapshotSchema = z
  .object({
    installation_identity_hash: z.string().regex(/^[0-9a-f]{64}$/),
    client_version: z.string().trim().min(1).max(160).nullable().optional(),
    authentication_state: z.enum([
      "authenticated",
      "unauthenticated",
      "unknown"
    ]),
    health_state: z.enum(["healthy", "unavailable", "incompatible", "error"]),
    models: z.array(aiClientModelDescriptorSchema).max(500),
    capabilities: z
      .object({
        descriptors: z.record(z.string(), aiClientCapabilityDescriptorSchema),
        diagnostics: z.array(aiClientDiagnosticSchema).max(100).optional()
      })
      .strict(),
    observed_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true })
  })
  .strict()
  .superRefine((input, context) => {
    for (const [key, descriptor] of Object.entries(
      input.capabilities.descriptors
    )) {
      if (key !== descriptor.id) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", "descriptors", key, "id"],
          message: "Capability descriptor map key must equal descriptor.id"
        });
      }
    }
  })
  .refine(
    (input) => Date.parse(input.expires_at) > Date.parse(input.observed_at),
    { message: "expires_at must be later than observed_at" }
  );

export const localMemoryAgentFlowKeySchema = z.enum([
  "mcp_memory_answer",
  "manual_memory_answer",
  "lcm_summary",
  "curated_memory_review",
  "session_title"
]);

export const localMemoryAgentSettingsParamsSchema = z.object({
  flowKey: localMemoryAgentFlowKeySchema
});

export const localMemoryAgentSettingsSchema = z
  .object({
    provider: supportedAiClientDriverSchema,
    ai_client_instance_id: aiClientInstanceIdSchema.optional(),
    model: z.string().trim().min(1),
    reasoning_effort: z.string().trim().min(1),
    timeout_ms: z.coerce.number().int().min(1000).max(600000),
    max_attempts: z.coerce.number().int().min(1).max(25)
  })
  .strict()
  .transform((input) => ({
    ...input,
    ai_client_instance_id:
      input.ai_client_instance_id ?? `${input.provider}.default`
  }));
