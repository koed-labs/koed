import { z } from "zod";

const aiClientIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/);

export const aiClientInstanceParamsSchema = z
  .object({ instanceId: aiClientIdentifierSchema })
  .strict();

export const aiClientInstanceSchema = z
  .object({
    driver_id: aiClientIdentifierSchema,
    display_name: z.string().trim().min(1).max(160),
    config_identity_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    enabled: z.boolean().optional()
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
    models: z.array(z.record(z.string(), z.unknown())).max(500),
    capabilities: z.record(z.string(), z.unknown()),
    observed_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true })
  })
  .strict()
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
    provider: aiClientIdentifierSchema.default("codex"),
    ai_client_instance_id: aiClientIdentifierSchema.optional(),
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
