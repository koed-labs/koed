import { z } from "zod";

export const workspaceProjectIdSchema = z.uuid();
// Leaves headroom for the authenticated local-edge envelope around the copy.
// Both proxy and Team copy routes accept at most 8 MiB request bodies.
export const workspaceProjectCopyMaxBytes = 7_000_000;
export const workspaceProjectCopyFitsTransport = (value: unknown): boolean =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <=
  workspaceProjectCopyMaxBytes;
export const workspaceProjectCreateSchema = z
  .object({
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    key: z.string().trim().min(1).max(120),
    shareAttemptKey: z.string().trim().min(8).max(200)
  })
  .strict();

export const workspaceProjectCopySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    personalProjectVersion: z.number().int().positive(),
    workItems: z
      .array(
        z
          .object({
            id: z.uuid(),
            kind: z.enum(["todo", "ticket"]),
            key: z.string().nullable().optional(),
            title: z.string().min(1).max(500),
            goal: z.string().min(1).max(20_000),
            status: z.enum(["todo", "doing", "review", "blocked", "done"]),
            dueOn: z.iso.date().nullable().optional(),
            doneAt: z.iso.datetime({ offset: true }).nullable().optional()
          })
          .strict()
      )
      .max(500),
    sources: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().min(1).max(500),
            kind: z.string().min(1).max(80),
            status: z.string().min(1).max(80),
            personalNoteId: z.uuid().nullable().optional(),
            personalNoteRevisionId: z.uuid().nullable().optional()
          })
          .strict()
      )
      .max(500)
  })
  .strict();

// Only safe progress reaches the Team backend. The renderer and runtime have
// no field for Conversation identity, transcript, tool output or file content.
export const workspaceProjectWorkItemPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(500).optional(),
    goal: z.string().trim().min(1).max(20_000).optional(),
    status: z.enum(["todo", "doing", "review", "blocked", "done"]).optional(),
    dueOn: z.iso.date().nullable().optional(),
    assigneeDisplayName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .nullable()
      .optional(),
    stepLabel: z.string().trim().min(1).max(500).nullable().optional(),
    dispatchKey: z.string().trim().min(1).max(240).optional(),
    prUrl: z.url().nullable().optional(),
    prState: z.string().trim().min(1).max(80).nullable().optional()
  })
  .strict();
export const workspaceProjectHumanWorkItemPatchSchema =
  workspaceProjectWorkItemPatchSchema.omit({
    assigneeDisplayName: true,
    stepLabel: true,
    dispatchKey: true,
    prUrl: true,
    prState: true
  });
export const workspaceProjectDispatchReceiptSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    dispatchKey: z.string().trim().min(1).max(240)
  })
  .strict();
const dispatchProgressBase = workspaceProjectDispatchReceiptSchema.shape;
export const workspaceProjectDispatchProgressSchema = z.union([
  z
    .object({
      ...dispatchProgressBase,
      status: z.literal("doing"),
      stepLabel: z.enum(["Working now", "Agent finished this turn"])
    })
    .strict(),
  z
    .object({
      ...dispatchProgressBase,
      status: z.literal("blocked"),
      stepLabel: z.enum(["Needs you", "Execution stopped"])
    })
    .strict(),
  z
    .object({
      ...dispatchProgressBase,
      status: z.literal("review"),
      stepLabel: z.literal("In review")
    })
    .strict(),
  z
    .object({
      ...dispatchProgressBase,
      status: z.literal("done"),
      stepLabel: z.literal("Done")
    })
    .strict(),
  z
    .object({
      ...dispatchProgressBase,
      status: z.literal("review"),
      stepLabel: z.literal("Pull request open"),
      prUrl: z.url(),
      prState: z.literal("open")
    })
    .strict(),
  z
    .object({
      ...dispatchProgressBase,
      status: z.literal("done"),
      stepLabel: z.literal("Pull request merged"),
      prState: z.literal("merged")
    })
    .strict(),
  z
    .object({
      ...dispatchProgressBase,
      status: z.literal("blocked"),
      stepLabel: z.literal("Pull request closed"),
      prState: z.literal("closed")
    })
    .strict()
]);

export const workspaceProjectWorkItemCreateSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    kind: z.enum(["todo", "ticket"]),
    key: z.string().trim().min(1).max(120).nullable().optional(),
    title: z.string().trim().min(1).max(500),
    goal: z.string().trim().min(1).max(20_000),
    status: z
      .enum(["todo", "doing", "review", "blocked", "done"])
      .default("todo"),
    dueOn: z.iso.date().nullable().optional()
  })
  .strict();

export const workspaceProjectWorkItemSchema = z
  .object({
    id: z.uuid(),
    sourceOwnerTeamMemberId: z.uuid(),
    sourceWorkItemId: z.uuid().nullable(),
    kind: z.enum(["todo", "ticket"]),
    key: z.string().nullable(),
    title: z.string(),
    goal: z.string(),
    status: z.enum(["todo", "doing", "review", "blocked", "done"]),
    dueOn: z.string().nullable(),
    doneAt: z.iso.datetime({ offset: true }).nullable(),
    assigneeDisplayName: z.string().nullable(),
    stepLabel: z.string().nullable(),
    dispatchKey: z.string().nullable(),
    prUrl: z.string().nullable(),
    prState: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict();

export const workspaceProjectSourceSchema = z
  .object({
    id: z.uuid(),
    uploaderTeamMemberId: z.uuid(),
    sourceProjectSourceId: z.uuid(),
    name: z.string(),
    kind: z.string(),
    status: z.string(),
    personalNoteId: z.uuid().nullable(),
    personalNoteRevisionId: z.uuid().nullable(),
    version: z.number().int().positive()
  })
  .strict();
export const workspaceProjectSourceCreateSchema = z
  .object({
    sourceProjectSourceId: z.uuid(),
    name: z.string().trim().min(1).max(500),
    kind: z.string().trim().min(1).max(80),
    status: z.string().trim().min(1).max(80),
    personalNoteId: z.uuid().nullable(),
    personalNoteRevisionId: z.uuid().nullable()
  })
  .strict();
export const workspaceProjectSourcePatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(500).optional(),
    status: z.string().trim().min(1).max(80).optional(),
    personalNoteId: z.uuid().nullable().optional(),
    personalNoteRevisionId: z.uuid().nullable().optional(),
    deleted: z.boolean().optional()
  })
  .strict();
export const workspaceProjectSourceMetadataPatchSchema =
  workspaceProjectSourcePatchSchema.omit({
    personalNoteId: true,
    personalNoteRevisionId: true
  });

export const workspaceProjectRecordSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    ownerTeamMemberId: z.uuid(),
    name: z.string(),
    key: z.string(),
    lifecycle: z.enum(["active", "deleted"]),
    version: z.number().int().positive(),
    copiedAt: z.unknown().nullable()
  })
  .strict();
export const workspaceProjectActivitySummarySchema = z
  .object({
    days: z
      .array(
        z
          .object({ date: z.iso.date(), count: z.number().int().nonnegative() })
          .strict()
      )
      .length(7),
    done: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative()
  })
  .strict();
export const workspaceProjectStateSchema = z
  .object({
    project: workspaceProjectRecordSchema.nullable(),
    memberVersion: z.number().int().positive().nullable(),
    workItems: z.array(workspaceProjectWorkItemSchema),
    sources: z.array(workspaceProjectSourceSchema),
    activity: workspaceProjectActivitySummarySchema.nullable(),
    readOnly: z.boolean(),
    notice: z.string().nullable()
  })
  .strict();

export type WorkspaceProjectCreate = z.infer<
  typeof workspaceProjectCreateSchema
>;
export type WorkspaceProjectCopy = z.infer<typeof workspaceProjectCopySchema>;
export type WorkspaceProjectWorkItemPatch = z.infer<
  typeof workspaceProjectWorkItemPatchSchema
>;
export type WorkspaceProjectDispatchProgress = z.infer<
  typeof workspaceProjectDispatchProgressSchema
>;
export type WorkspaceProjectWorkItemCreate = z.infer<
  typeof workspaceProjectWorkItemCreateSchema
>;
export type WorkspaceProjectWorkItem = z.infer<
  typeof workspaceProjectWorkItemSchema
>;
export type WorkspaceProjectSource = z.infer<
  typeof workspaceProjectSourceSchema
>;
export type WorkspaceProjectState = z.infer<typeof workspaceProjectStateSchema>;
