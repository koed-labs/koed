import { z } from "zod";
import { queryBooleanSchema, visibilitySchema } from "./common-schemas.js";
import { searchDomainSchema } from "./retrieval-schemas.js";

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
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0)
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
    cursorSourceSequence: z.coerce.number().int().nonnegative().optional(),
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

export const graphSessionParamsSchema = z.object({
  sessionId: z.string().uuid()
});

export const graphSessionTitlePatchSchema = z.object({
  title: z.string().trim().min(1).max(120)
});

export const nodeIdParamsSchema = z.object({ nodeId: z.string().uuid() });

export const expandMemoryNodeQuerySchema = z
  .object({
    search_domain: searchDomainSchema.default("global"),
    session_id: z.string().uuid().optional(),
    workspace_id: z.string().min(1).optional(),
    recent_days: z.coerce.number().int().positive().max(36500).optional(),
    source_after: z.coerce.date().optional(),
    source_before: z.coerce.date().optional()
  })
  .superRefine((input, context) => {
    if (input.search_domain === "session" && !input.session_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_id"],
        message: "session_id is required when search_domain is session"
      });
    }
    if (input.search_domain === "project" && !input.workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_id"],
        message: "workspace_id is required when search_domain is project"
      });
    }
    if (
      input.recent_days !== undefined &&
      (input.source_after !== undefined || input.source_before !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recent_days"],
        message:
          "recent_days cannot be combined with explicit source_after/source_before bounds"
      });
    }
    if (
      input.source_after !== undefined &&
      input.source_before !== undefined &&
      input.source_after.getTime() >= input.source_before.getTime()
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_after"],
        message: "source_after must be earlier than source_before"
      });
    }
  });
