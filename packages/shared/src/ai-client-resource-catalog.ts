import { z } from "zod";
import { supportedAiClientDriverIds } from "./ai-client-contract.js";

export const aiClientResourceCatalogVersion = 1 as const;

export const aiClientResourceIdSchema = z.string().regex(/^res_[0-9a-f]{64}$/);

export const aiClientResourceKindSchema = z.enum([
  "skill",
  "plugin",
  "mcp_server",
  "extension"
]);

export const aiClientResourceSourceSchema = z.enum([
  "user",
  "project",
  "plugin",
  "builtin",
  "configured"
]);

export const aiClientResourceStatusSchema = z.enum([
  "ready",
  "disabled",
  "unavailable"
]);

export const aiClientResourceInvocationSchema = z.literal("native_skill");

export const aiClientResourceSchema = z
  .object({
    resourceId: aiClientResourceIdSchema,
    kind: aiClientResourceKindSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().max(1_000).optional(),
    status: aiClientResourceStatusSchema,
    source: aiClientResourceSourceSchema,
    invocation: aiClientResourceInvocationSchema.nullable()
  })
  .strict();

export const aiClientResourceCatalogSchema = z
  .object({
    version: z.literal(aiClientResourceCatalogVersion),
    provider: z.enum(supportedAiClientDriverIds),
    aiClientInstanceId: z.string().trim().min(1).max(128),
    hostedInstanceId: z.string().trim().min(1).max(160),
    computerLabel: z.string().trim().min(1).max(80).nullable(),
    projectId: z.string().trim().min(1).max(2_048).nullable(),
    observedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    resources: z.array(aiClientResourceSchema).max(500)
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    for (const [index, resource] of catalog.resources.entries()) {
      if (ids.has(resource.resourceId)) {
        context.addIssue({
          code: "custom",
          path: ["resources", index, "resourceId"],
          message: "AI Client resource IDs must be unique within a catalog."
        });
      }
      ids.add(resource.resourceId);
      if (
        (resource.kind === "skill") !==
        (resource.invocation === "native_skill")
      ) {
        context.addIssue({
          code: "custom",
          path: ["resources", index, "invocation"],
          message: "Only Skills can have a native skill invocation."
        });
      }
    }
    if (Date.parse(catalog.expiresAt) <= Date.parse(catalog.observedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "AI Client resource catalogs must expire after observation."
      });
    }
    if (JSON.stringify(catalog.resources).length > 256 * 1_024) {
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "AI Client resource catalog exceeds its size limit."
      });
    }
  });

export const aiClientResourceDiscoveryRequestSchema = z
  .object({
    hostedInstanceId: z.string().trim().min(1).max(160),
    projectId: z.string().trim().min(1).max(2_048).nullable(),
    requestId: z.uuid()
  })
  .strict();

export const aiClientResourceDiscoveryOperationStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed"
]);

export const aiClientResourceDiscoveryOperationSchema = z
  .object({
    operationId: z.uuid(),
    requestId: z.uuid(),
    hostedInstanceId: z.string().trim().min(1).max(160),
    projectId: z.string().trim().min(1).max(2_048).nullable(),
    state: aiClientResourceDiscoveryOperationStateSchema,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    catalog: aiClientResourceCatalogSchema.optional(),
    errorCode: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/)
      .optional()
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.state === "completed" && !operation.catalog) {
      context.addIssue({
        code: "custom",
        path: ["catalog"],
        message: "Completed discovery operations require a catalog."
      });
    }
    if (operation.catalog) {
      if (
        operation.catalog.hostedInstanceId !== operation.hostedInstanceId ||
        operation.catalog.projectId !== operation.projectId
      ) {
        context.addIssue({
          code: "custom",
          path: ["catalog"],
          message: "Catalog scope must match its discovery operation."
        });
      }
    }
    if (operation.state !== "failed" && operation.errorCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Only failed discovery operations include an error code."
      });
    }
  });

export const aiClientResourceDiscoveryRunnerClaimSchema = z
  .object({
    operationId: z.uuid(),
    ownerUserId: z.uuid(),
    requestId: z.uuid(),
    hostedInstanceId: z.string().trim().min(1).max(160),
    aiClientInstanceId: z.string().trim().min(1).max(128),
    provider: z.enum(supportedAiClientDriverIds),
    computerLabel: z.string().trim().min(1).max(80).nullable(),
    projectId: z.string().trim().min(1).max(2_048).nullable(),
    targetDeviceId: z.string().trim().min(1).max(160),
    targetDeploymentId: z.uuid(),
    state: z.literal("running"),
    revision: z.number().int().positive(),
    attempt: z.number().int().positive(),
    leaseToken: z.uuid(),
    createdAt: z.iso.datetime({ offset: true })
  })
  .strict();

export const aiClientResourceDiscoveryRunnerClaimPageSchema = z
  .object({
    operations: z.array(aiClientResourceDiscoveryRunnerClaimSchema).max(32)
  })
  .strict();

export const aiClientResourceDiscoveryRunnerCompleteSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(160),
    leaseToken: z.uuid(),
    revision: z.number().int().positive(),
    catalog: aiClientResourceCatalogSchema
  })
  .strict();

export const aiClientResourceDiscoveryRunnerFailSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(160),
    leaseToken: z.uuid(),
    revision: z.number().int().positive(),
    errorCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/)
  })
  .strict();

export const managedConversationSelectedResourceIdsSchema = z
  .array(aiClientResourceIdSchema)
  .max(8)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Selected AI Client resource IDs must be unique."
  });

export type AiClientResource = z.infer<typeof aiClientResourceSchema>;
export type AiClientResourceCatalog = z.infer<
  typeof aiClientResourceCatalogSchema
>;
export type AiClientResourceDiscoveryRequest = z.infer<
  typeof aiClientResourceDiscoveryRequestSchema
>;
export type AiClientResourceDiscoveryOperation = z.infer<
  typeof aiClientResourceDiscoveryOperationSchema
>;
export type AiClientResourceDiscoveryRunnerClaim = z.infer<
  typeof aiClientResourceDiscoveryRunnerClaimSchema
>;
export type ManagedConversationSelectedResourceIds = z.infer<
  typeof managedConversationSelectedResourceIdsSchema
>;
