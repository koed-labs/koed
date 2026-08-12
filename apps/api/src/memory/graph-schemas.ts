import { z } from "zod";
import { queryBooleanSchema, visibilitySchema } from "./common-schemas.js";
import { searchDomainSchema } from "./retrieval-schemas.js";

export const sourceAiClientSchema = z.enum(["codex", "codex-cli"]);

export const graphThreadIndexResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string().nullable(),
      eventCount: z.number(),
      threads: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          sessionId: z.string().uuid().nullable(),
          sourceAiClient: sourceAiClientSchema.nullable(),
          projectId: z.string(),
          projectName: z.string(),
          projectPath: z.string().nullable(),
          projectAssignmentSource: z
            .enum(["detected", "user_override"])
            .nullable(),
          capturedProjectProvenance: z.record(z.string(), z.unknown()),
          eventCount: z.number(),
          invalidatedCount: z.number(),
          latestAt: z.string().datetime({ offset: true }),
          sample: z.string(),
          threadKind: z.enum(["conversation", "subagent"]),
          parentThreadId: z.string().nullable(),
          parentSessionId: z.string().nullable()
        })
      )
    })
  )
});

const rejectDeprecatedTeamScope = <T extends z.ZodRawShape>(
  schema: z.ZodObject<T>
) =>
  schema
    .passthrough()
    .superRefine((input, context) => {
      for (const key of ["teamWorkspaceId", "team_workspace_id"]) {
        if (input[key] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message:
              "Team Workspace scope is not supported on deprecated memory browser routes"
          });
        }
      }
    })
    .transform((input) => schema.parse(input));

const memoryBrowserQueryShape = {
  query: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  pinned: queryBooleanSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
} satisfies z.ZodRawShape;

export const memoryBrowserQuerySchema = rejectDeprecatedTeamScope(
  z.object(memoryBrowserQueryShape)
);

export const memoryClusterQuerySchema = rejectDeprecatedTeamScope(
  z.object({
    ...memoryBrowserQueryShape,
    itemsPerCluster: z.coerce.number().int().positive().max(10).default(4)
  })
);

export const clusterIdParamsSchema = z.object({ clusterId: z.string().min(1) });

export const clusterMemoriesQuerySchema = rejectDeprecatedTeamScope(
  z.object({
    limit: z.coerce.number().int().positive().max(100).default(100)
  })
);

export const updateMemorySchema = z.object({
  summaryText: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  visibility: visibilitySchema.optional()
});

export const graphQuerySchema = z.object({
  query: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  projectId: z.string().min(1).optional(),
  teamWorkspaceId: z.string().uuid().optional(),
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
  includeContent: queryBooleanSchema.default(false),
  includeRaw: queryBooleanSchema.default(false),
  teamWorkspaceId: z.string().uuid().optional()
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

const personalProjectReferenceSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1).max(4096).nullable().optional()
  })
  .strict()
  .transform((project) => ({ ...project, path: project.path ?? null }));

export const graphSessionProjectPatchSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("move"),
      project: personalProjectReferenceSchema
    })
    .strict(),
  z.object({ action: z.literal("reset") }).strict()
]);

export const nodeIdParamsSchema = z.object({ nodeId: z.string().uuid() });

export const expandMemoryNodeQuerySchema = z
  .object({
    search_domain: searchDomainSchema.default("global"),
    session_id: z.string().uuid().optional(),
    project_id: z.string().min(1).optional(),
    team_workspace_id: z.string().uuid().optional(),
    authorization_boundary: z.string().min(1).max(32768).optional(),
    recent_days: z.coerce.number().int().positive().max(36500).optional(),
    source_after: z.coerce.date().optional(),
    source_before: z.coerce.date().optional()
  })
  .superRefine((input, context) => {
    if (input.authorization_boundary && !input.team_workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorization_boundary"],
        message: "authorization_boundary requires team_workspace_id"
      });
    }
    if (input.search_domain === "session" && !input.session_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_id"],
        message: "session_id is required when search_domain is session"
      });
    }
    if (input.search_domain === "project" && !input.project_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project_id"],
        message: "project_id is required when search_domain is project"
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
