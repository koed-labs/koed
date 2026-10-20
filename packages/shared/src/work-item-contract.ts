import { z } from "zod";

export const workItemKindSchema = z.enum(["todo", "ticket"]);
export const workItemStatusSchema = z.enum([
  "todo",
  "doing",
  "review",
  "blocked",
  "done"
]);
export const workItemDateSchema = z.iso.date();

export const workItemSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    kind: workItemKindSchema,
    key: z.string().nullable(),
    title: z.string(),
    goal: z.string(),
    origin: z.string(),
    originRef: z.string().nullable(),
    idempotencyKey: z.string().nullable(),
    status: workItemStatusSchema,
    blockedReason: z.string().nullable(),
    assigneeAgentId: z.uuid().nullable(),
    executionId: z.uuid().nullable(),
    dispatchKey: z.string().nullable(),
    prProvider: z.string().nullable(),
    prNumber: z.number().int().positive().nullable(),
    prUrl: z.url().nullable(),
    prState: z.string().nullable(),
    dueOn: workItemDateSchema.nullable(),
    doneAt: z.iso.datetime({ offset: true }).nullable(),
    doneBy: z.uuid().nullable(),
    createdBy: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    version: z.number().int().positive()
  })
  .strict();

export const createWorkItemSchema = z
  .object({
    kind: workItemKindSchema,
    key: z.string().trim().min(1).max(120).nullable().optional(),
    title: z.string().trim().min(1).max(500),
    goal: z.string().trim().min(1).max(20_000),
    origin: z.string().trim().min(1).max(120),
    originRef: z.string().trim().min(1).max(500).nullable().optional(),
    idempotencyKey: z.string().trim().min(1).max(500).nullable().optional(),
    dueOn: workItemDateSchema.nullable().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "todo" && value.key != null)
      context.addIssue({
        code: "custom",
        path: ["key"],
        message: "Only tickets have a key"
      });
  });

export const patchWorkItemSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(500).optional(),
    goal: z.string().trim().min(1).max(20_000).optional(),
    dueOn: workItemDateSchema.nullable().optional(),
    action: z.enum(["mark_done", "untick", "back_to_todo"]).optional()
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.goal !== undefined ||
      value.dueOn !== undefined ||
      value.action !== undefined,
    "At least one change is required"
  );

export type WorkItem = z.infer<typeof workItemSchema>;
export type CreateWorkItem = z.infer<typeof createWorkItemSchema>;
export type PatchWorkItem = z.infer<typeof patchWorkItemSchema>;
