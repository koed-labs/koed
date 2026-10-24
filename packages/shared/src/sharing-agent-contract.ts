import { z } from "zod";
import { sharingOverviewSchema } from "./sharing-contract.js";

const id = z.uuid();
export const sharingAgentOverviewSchema = z
  .object({
    version: z.literal(1),
    overview: sharingOverviewSchema,
    teams: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            backendId: z.string(),
            status: z.literal("unavailable"),
            reason: z.string()
          })
          .strict(),
        z
          .object({
            backendId: z.string(),
            status: z.literal("available"),
            teams: z.array(
              z
                .object({
                  teamId: id,
                  name: z.string(),
                  role: z.enum(["owner", "admin", "member"]),
                  people: z.array(
                    z
                      .object({
                        id,
                        name: z.string(),
                        role: z.enum(["owner", "admin", "member"]),
                        status: z.string(),
                        version: z.number().int().positive(),
                        canRemove: z.boolean()
                      })
                      .strict()
                  )
                })
                .strict()
            )
          })
          .strict()
      ])
    )
  })
  .strict();

export type SharingAgentOverview = z.infer<typeof sharingAgentOverviewSchema>;
