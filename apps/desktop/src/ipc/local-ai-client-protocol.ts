import { z } from "zod";
import { supportedAiClientDriverIds } from "@koed/shared";

export const localAiClientCommandChannel = "koed:local-ai-client:command";

export const localAiClientFlowKeys = [
  "mcp_memory_answer",
  "lcm_summary",
  "session_title",
  "curated_memory_review"
] as const;
export type LocalAiClientFlowKey = (typeof localAiClientFlowKeys)[number];

const flowKeySchema = z.enum(localAiClientFlowKeys);
const providerSchema = z.enum(supportedAiClientDriverIds);
export const localAiClientAssignmentSchema = z
  .object({
    provider: providerSchema,
    ai_client_instance_id: z.string().min(1).max(128),
    model: z.string().min(1).max(384),
    reasoning_effort: z.string().min(1).max(64),
    timeout_ms: z.number().int().min(1_000).max(600_000),
    max_attempts: z.number().int().min(1).max(25)
  })
  .strict();
export type LocalAiClientAssignment = z.infer<
  typeof localAiClientAssignmentSchema
>;

export const localAiClientCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("refresh") }).strict(),
  z
    .object({
      operation: z.literal("set"),
      flowKey: flowKeySchema,
      assignment: localAiClientAssignmentSchema
    })
    .strict(),
  z.object({ operation: z.literal("reset"), flowKey: flowKeySchema }).strict()
]);
export type LocalAiClientCommand = z.infer<typeof localAiClientCommandSchema>;

const modelSchema = z
  .object({
    displayName: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    fullId: z.string().min(1),
    reasoningEfforts: z.array(z.string())
  })
  .strict();

const instanceSchema = z
  .object({
    instanceId: z.string().min(1),
    driverId: providerSchema,
    displayName: z.string().min(1),
    enabled: z.boolean()
  })
  .strict();

const capabilityDescriptorSchema = z
  .object({
    support: z.enum(["supported", "unsupported", "unknown"]),
    readiness: z.enum(["ready", "not_ready", "unknown"])
  })
  .strict();

const snapshotSchema = z
  .object({
    instanceId: z.string().min(1),
    authenticationState: z.enum([
      "authenticated",
      "unauthenticated",
      "unknown"
    ]),
    healthState: z.enum(["healthy", "unavailable", "incompatible", "error"]),
    models: z.array(modelSchema),
    localSynthesis: capabilityDescriptorSchema,
    managedConversationStart: capabilityDescriptorSchema.optional(),
    managedConversationResume: capabilityDescriptorSchema.optional(),
    managedConversationSend: capabilityDescriptorSchema.optional(),
    managedConversationHandoff: capabilityDescriptorSchema.optional(),
    managedConversationFork: capabilityDescriptorSchema.optional(),
    observedAt: z.string(),
    expiresAt: z.string(),
    stale: z.boolean()
  })
  .strict();

const settingSchema = z
  .object({
    flowKey: flowKeySchema,
    provider: providerSchema,
    aiClientInstanceId: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
    timeoutMs: z.number().int(),
    maxAttempts: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const localAiClientRuntimeAssignmentSchema = z
  .object({
    provider: providerSchema,
    ai_client_instance_id: z.string().min(1).max(128),
    model: z.string().min(1).max(384),
    reasoning_effort: z.string().min(1).max(64),
    timeout_ms: z.number().finite().int().min(1),
    max_attempts: z.number().finite().int().min(1)
  })
  .strict();
export type LocalAiClientRuntimeAssignment = z.infer<
  typeof localAiClientRuntimeAssignmentSchema
>;

export const localAiClientDefaultSchema = z
  .object({
    source: z.enum(["environment", "code"]),
    available: z.boolean(),
    persistable: z.boolean().optional(),
    assignment: localAiClientRuntimeAssignmentSchema.nullable(),
    reason: z.string().nullable()
  })
  .strict();

export const localAiClientReadModelSchema = z
  .object({
    instances: z.array(instanceSchema),
    capabilitySnapshots: z.array(snapshotSchema),
    settings: z.array(settingSchema),
    defaults: z.record(flowKeySchema, localAiClientDefaultSchema)
  })
  .strict();
export type LocalAiClientDefault = z.infer<typeof localAiClientDefaultSchema>;
export type LocalAiClientReadModel = z.infer<
  typeof localAiClientReadModelSchema
>;

export const localAiClientResponseSchema = z
  .object({
    operation: z.enum(["list", "refresh", "set", "reset"]),
    readModel: localAiClientReadModelSchema,
    refreshed: z.boolean().optional(),
    refreshError: z.string().nullable().optional()
  })
  .strict();
export type LocalAiClientResponse = z.infer<typeof localAiClientResponseSchema>;

export const parseLocalAiClientResponse = (
  value: unknown
): LocalAiClientResponse => localAiClientResponseSchema.parse(value);
