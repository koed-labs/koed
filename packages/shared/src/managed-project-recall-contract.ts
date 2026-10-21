import { z } from "zod";

/** Current owner Project link returned only for a live managed execution. */
export const managedProjectRecallContextSchema = z.discriminatedUnion(
  "linked",
  [
    z
      .object({
        linked: z.literal(true),
        personalProjectId: z.uuid(),
        teamBackendId: z.string().min(1).max(160),
        teamWorkspaceId: z.uuid(),
        workspaceProjectId: z.uuid(),
        projectVersion: z.number().int().positive()
      })
      .strict(),
    z
      .object({
        linked: z.literal(false),
        personalProjectId: z.uuid(),
        projectVersion: z.number().int().positive()
      })
      .strict()
  ]
);

export type ManagedProjectRecallContext = z.infer<
  typeof managedProjectRecallContextSchema
>;
