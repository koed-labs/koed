import { z } from "zod";

/** Project Threads are opt-in Team Chat v2 resources, never v1 thread DTOs. */
export const projectThreadV2Schema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    workspaceProjectId: z.uuid(),
    version: z.number().int().positive(),
    lifecycle: z.enum(["active", "archived"]),
    latestSequence: z.number().int().nonnegative().safe(),
    lastReadSequence: z.number().int().nonnegative().safe(),
    unreadCount: z.number().int().nonnegative().safe(),
    people: z
      .array(
        z
          .object({
            userId: z.uuid(),
            displayName: z.string().max(128).nullable()
          })
          .strict()
      )
      .max(1000)
  })
  .strict();

export const projectThreadV2ParamsSchema = z
  .object({ teamId: z.uuid(), workspaceProjectId: z.uuid() })
  .strict();

export const projectThreadV2ReadParamsSchema =
  projectThreadV2ParamsSchema.safeExtend({ threadId: z.uuid() });

export const projectThreadV2OpenResponseSchema = z
  .object({ thread: projectThreadV2Schema })
  .strict();

export type ProjectThreadV2 = z.infer<typeof projectThreadV2Schema>;
