import { z } from "zod";
import { queryBooleanSchema, visibilitySchema } from "./common-schemas.js";

export const memoryBrowserQuerySchema = z.object({
  query: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  pinned: queryBooleanSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
});

export const memoryClusterQuerySchema = memoryBrowserQuerySchema.extend({
  itemsPerCluster: z.coerce.number().int().positive().max(10).default(4)
});

export const clusterIdParamsSchema = z.object({ clusterId: z.string().min(1) });

export const clusterMemoriesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(100)
});

export const updateMemorySchema = z.object({
  summaryText: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  visibility: visibilitySchema.optional()
});

export const graphQuerySchema = z.object({
  query: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  includeInvalidated: queryBooleanSchema.default(false),
  limit: z.coerce.number().int().positive().max(500).default(100)
});

export const graphNodesQuerySchema = graphQuerySchema.extend({
  ids: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().uuid()).max(100).optional())
});

export const graphEventsQuerySchema = graphQuerySchema
  .extend({
    cursorTimestamp: z.string().datetime({ offset: true }).optional(),
    cursorId: z.string().uuid().optional(),
    includeContent: queryBooleanSchema.default(false),
    includeRaw: queryBooleanSchema.default(false)
  })
  .superRefine((input, context) => {
    if (Boolean(input.cursorTimestamp) !== Boolean(input.cursorId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursorId"],
        message: "cursorTimestamp and cursorId must be provided together"
      });
    }
  });

export const graphEventParamsSchema = z.object({ eventId: z.string().uuid() });

export const graphEventDetailQuerySchema = z.object({
  includeInvalidated: queryBooleanSchema.default(false),
  includeRaw: queryBooleanSchema.default(false)
});

export const graphEventPatchSchema = z.object({
  visibility: visibilitySchema.optional(),
  invalidated: z.boolean().optional()
});

export const nodeIdParamsSchema = z.object({ nodeId: z.string().uuid() });
