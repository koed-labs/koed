import { z } from "zod";
// Kept renderer/preload-safe; the private supervisor validates again before save.
export const performanceChannel = "koed:performance";
export const performanceRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect") }).strict(),
  z
    .object({
      operation: z.literal("apply"),
      choice: z
        .object({
          profile: z.enum(["low", "balanced", "full"]),
          overrides: z
            .object({
              backgroundNice: z.number().int().min(0).max(19).optional(),
              embeddingThreads: z
                .number()
                .int()
                .positive()
                .max(65536)
                .optional(),
              transcriptPollMs: z.number().int().min(1).max(60_000).optional()
            })
            .strict(),
          expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
        })
        .strict()
    })
    .strict()
]);
