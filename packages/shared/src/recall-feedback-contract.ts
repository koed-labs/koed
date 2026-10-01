import { z } from "zod";

const uuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const recallFeedbackMessageIdSchema = z
  .string()
  .regex(new RegExp(`^(?:provider|agent):${uuidPattern}$`));

const commentSchema = z
  .string()
  .refine((value) => value.length <= 4_000, {
    message: "Comment must be at most 4,000 characters"
  })
  .refine((value) => new TextEncoder().encode(value).byteLength <= 16 * 1024, {
    message: "Comment must be at most 16 KiB when encoded as UTF-8"
  });

export const recallFeedbackRatingSchema = z.enum(["up", "down"]).nullable();

export const putRecallFeedbackInputSchema = z
  .object({
    rating: recallFeedbackRatingSchema.optional(),
    comment: commentSchema.nullable().optional()
  })
  .strict()
  .refine(
    (value) => value.rating !== undefined || value.comment !== undefined,
    { message: "At least one feedback field must be supplied" }
  );

export const recallFeedbackSchema = z
  .object({
    rating: recallFeedbackRatingSchema,
    comment: z.string().nullable(),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const recallFeedbackResponseSchema = z
  .object({ feedback: recallFeedbackSchema.nullable() })
  .strict();

export type RecallFeedbackRating = z.infer<typeof recallFeedbackRatingSchema>;
export type PutRecallFeedbackInput = z.infer<
  typeof putRecallFeedbackInputSchema
>;
export type RecallFeedback = z.infer<typeof recallFeedbackSchema>;
export type RecallFeedbackResponse = z.infer<
  typeof recallFeedbackResponseSchema
>;
