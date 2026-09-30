import { z } from "zod";

export const personalMemoryTurnContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    // `skipped` records an explicit one-request Continue without Memory choice.
    status: z.enum(["available", "unavailable", "skipped"]),
    attributionNonce: z.uuid(),
    searchDomain: z.enum(["project", "global"]),
    projectId: z.string().trim().min(1).max(2_048).nullable(),
    evidence: z
      .array(
        z
          .object({
            nodeId: z.string().trim().min(1).max(512),
            sourceType: z
              .enum([
                "memory_node",
                "memory_event",
                "message",
                "curated_memory"
              ])
              .optional(),
            sourceId: z.string().trim().min(1).max(512).optional(),
            summaryText: z.string().max(8_000),
            visibility: z.enum(["personal", "team"]).default("personal"),
            teamWorkspaceId: z.uuid().optional(),
            citation: z.record(z.string(), z.unknown()),
            sourceTime: z.string().max(64).optional()
          })
          .strict()
      )
      .max(5)
  })
  .strict()
  .superRefine((context, issueContext) => {
    if (context.status !== "available" && context.evidence.length > 0) {
      issueContext.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Skipped or unavailable Memory cannot include evidence"
      });
    }
    for (const [index, evidence] of context.evidence.entries()) {
      if (
        evidence.visibility === "team" &&
        evidence.teamWorkspaceId === undefined
      ) {
        issueContext.addIssue({
          code: "custom",
          path: ["evidence", index, "teamWorkspaceId"],
          message: "Team evidence requires its authorized Workspace"
        });
      }
    }
  });

export type PersonalMemoryTurnContext = z.infer<
  typeof personalMemoryTurnContextSchema
>;
