import { z } from "zod";

export const MANAGED_DEVELOPMENT_PREVIEW_POLICY_VERSION = 1 as const;
export const MANAGED_DEVELOPMENT_PREVIEW_MAX_RECORDS = 16;

export const managedDevelopmentPreviewStateSchema = z.enum([
  "available",
  "closed"
]);

export const managedDevelopmentPreviewSourceSchema = z.enum([
  "terminal_output",
  "user_port"
]);

export const managedDevelopmentPreviewRecordSchema = z
  .object({
    id: z.uuid(),
    executionId: z.uuid(),
    executionGeneration: z.number().int().safe().positive(),
    lifecycleGeneration: z.number().int().safe().positive(),
    terminalId: z.uuid(),
    state: managedDevelopmentPreviewStateSchema,
    source: managedDevelopmentPreviewSourceSchema,
    policyVersion: z.literal(MANAGED_DEVELOPMENT_PREVIEW_POLICY_VERSION),
    discoveredAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict();

export const managedDevelopmentPreviewCandidateSchema = z
  .object({
    executionGeneration: z.number().int().safe().positive(),
    terminalId: z.uuid(),
    scheme: z.enum(["http", "https"]),
    port: z.number().int().safe().min(1).max(65_535)
  })
  .strict();

export const managedDevelopmentPreviewAccessSchema = z
  .object({
    preview: managedDevelopmentPreviewRecordSchema,
    navigationUrl: z.url().max(2_048)
  })
  .strict();

export type ManagedDevelopmentPreviewRecord = z.infer<
  typeof managedDevelopmentPreviewRecordSchema
>;
export type ManagedDevelopmentPreviewCandidate = z.infer<
  typeof managedDevelopmentPreviewCandidateSchema
>;
export type ManagedDevelopmentPreviewAccess = z.infer<
  typeof managedDevelopmentPreviewAccessSchema
>;
