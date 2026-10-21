import { z } from "zod";

export const projectActivityKindSchema = z.enum([
  "work_item_created",
  "work_item_status",
  "work_item_done",
  "source_added",
  "source_ready",
  "source_failed",
  "pr_opened",
  "pr_merged",
  "assertion_created"
]);
export const projectActivityCursorSchema = z.string().min(1).max(500);
export const projectActivityPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          cursor: projectActivityCursorSchema,
          actorUserId: z.uuid(),
          kind: projectActivityKindSchema,
          ref: z.string().min(1),
          sourceOutcome: z
            .object({
              sourceId: z.uuid(),
              name: z.string().min(1),
              status: z.enum(["ready", "failed"])
            })
            .strict()
            .optional(),
          at: z.iso.datetime({ offset: true })
        })
        .strict()
    ),
    hasMore: z.boolean(),
    nextCursor: projectActivityCursorSchema.nullable()
  })
  .strict();
export const projectSeenSchema = z
  .object({
    cursor: projectActivityCursorSchema,
    at: z.iso.datetime({ offset: true }).nullable()
  })
  .strict();
export type ProjectActivityKind = z.infer<typeof projectActivityKindSchema>;
