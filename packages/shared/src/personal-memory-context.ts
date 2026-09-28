import { z } from "zod";

export const personalMemoryTurnContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["available", "unavailable"]),
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
            citation: z.record(z.string(), z.unknown()),
            sourceTime: z.string().max(64).optional()
          })
          .strict()
      )
      .max(5)
  })
  .strict()
  .superRefine((context, issueContext) => {
    if (context.status === "unavailable" && context.evidence.length > 0) {
      issueContext.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Unavailable Personal Memory cannot include evidence"
      });
    }
  });

export type PersonalMemoryTurnContext = z.infer<
  typeof personalMemoryTurnContextSchema
>;
