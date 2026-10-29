import { z } from "zod";

/**
 * Creation key prefix of the Solo Chief of Staff home Project. Desktop creates
 * that Project with `${chiefOfStaffHomeProjectKeyPrefix}${ownerUserId}`.
 */
export const chiefOfStaffHomeProjectKeyPrefix = "koed-solo-chief-home:";

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
        projectVersion: z.number().int().positive(),
        /**
         * "all_personal": this Project is the owner's Chief of Staff home, which
         * recalls across all of their Personal Memory like any of their own AI
         * Clients, not only what was filed under this Project.
         */
        recallScope: z.literal("all_personal").optional()
      })
      .strict()
  ]
);

export type ManagedProjectRecallContext = z.infer<
  typeof managedProjectRecallContextSchema
>;
