import { z } from "zod";

const cursor = z.number().int().safe().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Control metadata only. This contract never admits a pre-cutover package body. */
export const syncProfileTransitionRequestSchema = z
  .object({
    protocol: z.literal("koed.captured-session-sync/profile-transition/v1"),
    relationshipId: z.uuid(),
    packageId: z.uuid(),
    sourceSequence: cursor.positive(),
    fromCursor: cursor,
    toCursor: cursor,
    requestHash: digest,
    manifestHash: digest,
    packageChecksum: digest
  })
  .strict()
  .refine((value) => value.toCursor >= value.fromCursor, {
    message: "Transition cursor range is invalid",
    path: ["toCursor"]
  });

export const syncProfileTransitionReceiptSchema = z
  .object({
    request: syncProfileTransitionRequestSchema,
    outcome: z.enum(["applied", "superseded"]),
    sourceCursor: cursor,
    targetProcessingCursor: cursor,
    packageSequence: cursor.positive(),
    issuedAt: z.iso.datetime()
  })
  .strict()
  .refine(
    (value) =>
      value.packageSequence === value.request.sourceSequence &&
      value.sourceCursor >= value.targetProcessingCursor &&
      (value.outcome === "applied"
        ? value.targetProcessingCursor === value.request.toCursor
        : value.targetProcessingCursor === value.request.fromCursor),
    {
      message: "Transition receipt does not bind its sequence and outcome"
    }
  );

export type SyncProfileTransitionRequest = z.infer<
  typeof syncProfileTransitionRequestSchema
>;
export type SyncProfileTransitionReceipt = z.infer<
  typeof syncProfileTransitionReceiptSchema
>;
