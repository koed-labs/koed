import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const projectName = z.string().trim().min(1).max(200);
const folderPath = z.string().trim().min(1).max(2_048).nullable();

export const projectSchema = z
  .object({
    id: z.uuid(),
    name: projectName,
    key: z.string().min(1).max(32),
    folderPath,
    lifecycle: z.enum(["active", "deleted"]),
    deletionPhase: z
      .enum(["preparing", "freezing", "stopping", "ready", "complete"])
      .nullable(),
    deleteBatchId: z.uuid().nullable(),
    deletedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: z.number().int().positive(),
    teamBackendId: z.string().nullable().optional(),
    teamWorkspaceId: z.uuid().nullable().optional(),
    workspaceProjectId: z.uuid().nullable().optional()
  })
  .strict();

export const createProjectSchema = z
  .object({
    name: projectName,
    folderPath: folderPath.optional(),
    idempotencyKey: z.string().min(1).max(200),
    textActionId: z.uuid().optional()
  })
  .strict();

export const patchProjectSchema = z
  .object({
    version: z.number().int().positive(),
    name: projectName.optional(),
    folderPath: folderPath.optional()
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.folderPath !== undefined,
    {
      message: "At least one Project field must change"
    }
  );

export const projectListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(500).optional(),
    includeDeleted: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default(false)
  })
  .strict();

export const projectListSchema = z
  .object({
    projects: z.array(projectSchema),
    nextCursor: z.string().nullable()
  })
  .strict();

export const projectSectionCountSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      count: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ availability: z.literal("not_implemented") }).strict()
]);

export const projectHqSchema = z
  .object({
    project: projectSchema,
    activity: z
      .object({
        lastSevenDays: z
          .object({
            days: z
              .array(
                z
                  .object({
                    date: z.iso.date(),
                    count: z.number().int().nonnegative()
                  })
                  .strict()
              )
              .length(7),
            total: z.number().int().nonnegative(),
            outcomes: z
              .object({
                days: z
                  .array(
                    z
                      .object({
                        date: z.iso.date(),
                        count: z.number().int().nonnegative()
                      })
                      .strict()
                  )
                  .length(7),
                done: z.number().int().nonnegative(),
                merged: z.number().int().nonnegative()
              })
              .strict()
              .optional()
          })
          .strict()
      })
      .strict()
      .optional(),
    sections: z
      .object({
        conversations: projectSectionCountSchema,
        workItems: projectSectionCountSchema,
        sources: projectSectionCountSchema,
        decks: projectSectionCountSchema,
        scheduledJobs: projectSectionCountSchema
      })
      .strict()
  })
  .strict();

export const projectHqConversationSchema = z
  .object({
    projectId: z.uuid(),
    executionId: z.uuid().nullable(),
    createdAt: timestamp
  })
  .strict();

export type ProjectHqConversation = z.infer<typeof projectHqConversationSchema>;

export const projectHqConversationReadSchema = z
  .object({
    conversation: projectHqConversationSchema.nullable(),
    execution: z
      .object({
        state: z.string(),
        capturedSessionId: z.uuid().nullable(),
        threadId: z.string().nullable(),
        graphProjectId: z.string().nullable(),
        graphThreadId: z.string().nullable(),
        provider: z.string(),
        aiClientInstanceId: z.string()
      })
      .strict()
      .nullable()
  })
  .strict();

export const projectDeleteStatusSchema = z
  .object({
    project: projectSchema,
    operation: z
      .object({
        batchId: z.uuid(),
        state: z.enum([
          "preparing",
          "freezing",
          "stopping",
          "ready",
          "complete",
          "cancelled",
          "needs_attention",
          "restore_releasing",
          "restored"
        ])
      })
      .strict()
      .nullable(),
    complete: z.boolean(),
    retryable: z.boolean(),
    pendingFreezeCount: z.number().int().nonnegative(),
    pendingExecutionCount: z.number().int().nonnegative(),
    pendingReviews: z.array(
      z
        .object({
          backendId: z.string().min(1),
          shareGrantId: z.uuid(),
          actionGrantId: z.uuid()
        })
        .strict()
    ),
    cancellationPending: z.boolean()
  })
  .strict();

export const projectDeleteSchema = z
  .object({
    version: z.number().int().positive(),
    batchId: z.uuid(),
    executionSetHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export const projectDeletePreviewSchema = z
  .object({
    project: projectSchema,
    executionSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    activeExecutions: z.array(
      z
        .object({
          id: z.uuid(),
          executionGeneration: z.number().int().positive(),
          state: z.string(),
          stateVersion: z.number().int().positive()
        })
        .strict()
    )
  })
  .strict();
export const projectRestoreSchema = z
  .object({ version: z.number().int().positive(), batchId: z.uuid() })
  .strict();

export type Project = z.infer<typeof projectSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type PatchProject = z.infer<typeof patchProjectSchema>;
