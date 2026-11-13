import { z } from "zod";

export const resourceOverridesSchema = z
  .object({
    backgroundNice: z.number().int().min(0).max(19).optional(),
    embeddingThreads: z.number().int().positive().max(65536).optional(),
    transcriptPollMs: z.number().int().min(1).max(60_000).optional()
  })
  .strict();
export const performanceChoiceSchema = z
  .object({
    profile: z.enum(["low", "balanced", "full"]),
    overrides: resourceOverridesSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
