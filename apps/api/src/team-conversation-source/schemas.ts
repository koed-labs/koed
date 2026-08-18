import { z } from "zod";

export const teamConversationSourceParamsSchema = z
  .object({ shareGrantId: z.uuid() })
  .strict();

export const teamConversationSourceSegmentParamsSchema =
  teamConversationSourceParamsSchema.extend({ segmentId: z.uuid() }).strict();

export const teamConversationSourceManifestQuerySchema = z
  .object({
    sourceComponentId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/)
      .max(96)
      .optional(),
    afterSegmentIndex: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(100).default(100)
  })
  .strict();

export const teamConversationSourceStreamQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(8192).optional()
  })
  .strict();

export const teamConversationSourceForkSnapshotBodySchema = z
  .object({
    expectedSourceGenerationId: z.uuid()
  })
  .strict();
