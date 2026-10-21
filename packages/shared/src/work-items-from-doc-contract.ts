import { z } from "zod";

export const workItemsFromDocParamsSchema = z
  .object({ executionId: z.uuid() })
  .strict();

// Core selectors are strict. Only the HTTP route converts query strings to numbers.
export const workItemsFromDocReadSchema = z
  .object({
    sourceId: z.uuid().optional(),
    cursor: z.number().int().nonnegative().default(0),
    executionGeneration: z.number().int().positive()
  })
  .strict();
export const workItemsFromDocListSchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    executionGeneration: z.number().int().positive()
  })
  .strict();

export const workItemsFromDocProposalSchema = z
  .object({
    lineNumber: z.number().int().positive(),
    sourceLine: z.string().min(1).max(4_000),
    title: z.string().trim().min(1).max(500),
    goal: z.string().trim().min(1).max(20_000),
    dueText: z.string().trim().min(1).max(100).nullable()
  })
  .strict();
export const workItemsFromDocApplySchema = z
  .object({
    commandId: z.uuid(),
    leaseToken: z.uuid(),
    executionGeneration: z.number().int().positive(),
    sourceId: z.uuid(),
    sourceRevisionId: z.uuid(),
    noteRevisionId: z.uuid(),
    proposals: z.array(workItemsFromDocProposalSchema).min(1).max(30),
    timeZone: z.string().min(3).max(100)
  })
  .strict();

export const workItemsFromDocPreviewSchema = z
  .object({
    executionGeneration: z.number().int().positive(),
    sourceId: z.uuid(),
    sourceRevisionId: z.uuid(),
    noteRevisionId: z.uuid(),
    proposals: z.array(workItemsFromDocProposalSchema).min(1).max(30)
  })
  .strict();
export const workItemsFromDocPreviewResultSchema = z
  .object({
    newCount: z.number().int().nonnegative(),
    alreadyExistingCount: z.number().int().nonnegative(),
    removedCount: z.number().int().nonnegative(),
    candidates: z
      .array(
        z
          .object({
            lineNumber: z.number().int().positive(),
            title: z.string().max(500),
            status: z.enum(["new", "already_existing", "removed"])
          })
          .strict()
      )
      .max(30)
  })
  .strict();

export const workItemsFromDocReadPageSchema = z
  .object({
    sourceId: z.uuid(),
    sourceRevisionId: z.uuid(),
    noteRevisionId: z.uuid(),
    name: z.string().max(200),
    lines: z
      .array(
        z
          .object({
            lineNumber: z.number().int().positive(),
            text: z.string().max(32_000)
          })
          .strict()
      )
      .max(200),
    nextCursor: z.number().int().nonnegative().nullable(),
    remaining: z.boolean()
  })
  .strict();
export const workItemsFromDocListPageSchema = z
  .object({
    documents: z
      .array(
        z
          .object({
            sourceId: z.uuid(),
            name: z.string().max(200),
            noteRevisionId: z.uuid()
          })
          .strict()
      )
      .max(30),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();

export const workItemsFromDocToolProposalSchema = z
  .object({
    line_number: z.number().int().positive(),
    source_line: z.string().min(1).max(4_000),
    title: z.string().trim().min(1).max(500),
    goal: z.string().trim().min(1).max(20_000),
    due_text: z.string().trim().min(1).max(100).nullable()
  })
  .strict();
export const workItemsFromDocToolReadSchema = z
  .object({
    mode: z.literal("read"),
    source_id: z.uuid().optional(),
    cursor: z.number().int().nonnegative().optional()
  })
  .strict();
export const workItemsFromDocToolListSchema = z
  .object({
    mode: z.literal("list"),
    cursor: z.number().int().nonnegative().optional()
  })
  .strict();
export const workItemsFromDocToolApplySchema = z
  .object({
    mode: z.literal("apply"),
    source_id: z.uuid(),
    source_revision_id: z.uuid(),
    note_revision_id: z.uuid(),
    proposals: z.array(workItemsFromDocToolProposalSchema).min(1).max(30)
  })
  .strict();
export const workItemsFromDocToolPreviewSchema = z
  .object({
    mode: z.literal("preview"),
    source_id: z.uuid(),
    source_revision_id: z.uuid(),
    note_revision_id: z.uuid(),
    proposals: z.array(workItemsFromDocToolProposalSchema).min(1).max(30)
  })
  .strict();
export const workItemsFromDocToolInputSchema = z.discriminatedUnion("mode", [
  workItemsFromDocToolListSchema,
  workItemsFromDocToolReadSchema,
  workItemsFromDocToolPreviewSchema,
  workItemsFromDocToolApplySchema
]);

export type WorkItemsFromDocToolApply = z.infer<
  typeof workItemsFromDocToolApplySchema
>;
