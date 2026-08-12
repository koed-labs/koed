import { z } from "zod";

export const teamConversationSourceParamsSchema = z
  .object({ shareGrantId: z.uuid() })
  .strict();

export const teamConversationSourceSegmentParamsSchema =
  teamConversationSourceParamsSchema.extend({ segmentId: z.uuid() }).strict();

export const teamConversationSourceManifestQuerySchema = z
  .object({
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
    throughSegmentIndex: z.number().int().min(0)
  })
  .strict();
