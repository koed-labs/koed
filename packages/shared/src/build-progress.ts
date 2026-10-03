import { z } from "zod";

const boundedText = z.string().max(16_384);
const boundedPath = z.string().min(1).max(2_048);

export const buildProgressEventSchema = z
  .object({
    id: z.string().min(1).max(240),
    jobId: z.uuid(),
    attemptId: z.uuid(),
    executionId: z.uuid(),
    executionGeneration: z.number().int().positive(),
    at: z.iso.datetime(),
    kind: z.enum([
      "started",
      "phase",
      "input_required",
      "command",
      "workspace_observed",
      "completed",
      "blocked",
      "failed",
      "message"
    ]),
    phase: z.enum(["working", "checking"]).optional(),
    state: z.enum(["running", "completed", "blocked", "failed"]).optional(),
    story: z
      .object({
        title: z.string().min(1).max(240),
        detail: boundedText.optional(),
        outcome: z.string().max(500).optional()
      })
      .strict()
      .optional(),
    technical: z
      .object({
        branch: z.string().max(512).optional(),
        status: z.string().max(500).optional(),
        command: boundedText.optional(),
        result: boundedText.optional(),
        files: z
          .array(
            z
              .object({
                path: boundedPath,
                change: z.enum([
                  "added",
                  "modified",
                  "deleted",
                  "renamed",
                  "unknown"
                ]),
                additions: z.number().int().nonnegative().optional(),
                deletions: z.number().int().nonnegative().optional(),
                baseline: z.boolean().optional()
              })
              .strict()
          )
          .max(2_000)
          .optional(),
        diff: z
          .object({
            filesChanged: z.number().int().nonnegative().optional(),
            additions: z.number().int().nonnegative().optional(),
            deletions: z.number().int().nonnegative().optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    attention: z
      .object({
        runtimeItemId: z.uuid(),
        kind: z.enum(["user_input", "command_approval"])
      })
      .strict()
      .optional()
  })
  .strict();

export const buildProgressEventPageSchema = z
  .object({
    jobId: z.uuid(),
    events: z.array(buildProgressEventSchema).max(2_000),
    hasMore: z.boolean(),
    nextCursor: z.string().max(512).nullable(),
    availability: z.enum(["available", "unavailable", "no_project"])
  })
  .strict();

export type BuildProgressEvent = z.infer<typeof buildProgressEventSchema>;
export type BuildProgressEventPage = z.infer<
  typeof buildProgressEventPageSchema
>;
