import { z } from "zod";
import {
  personalFolderAssignmentSchema,
  personalSourceReferenceSchema,
  personalIdentifierSchema,
  personalFolderReferenceSchema,
  personalGitAssignmentSchema,
  personalGitContextSchema
} from "./personal-source-contract.js";
import { personalMembershipReasonSchema } from "./personal-membership-contract.js";

const syncAxis = <T extends z.ZodType>(assignment: T) =>
  z
    .object({
      state: z.enum(["pending", "available", "conflict"]),
      frontier: z.array(personalIdentifierSchema).max(1024),
      heads: z
        .array(
          z
            .object({ revisionId: personalIdentifierSchema, assignment })
            .strict()
        )
        .max(1024)
    })
    .strict();
export const personalSourceContextSyncSchema = z
  .object({
    source: personalSourceReferenceSchema,
    availability: z.enum(["pending", "available"]),
    git: syncAxis(personalGitAssignmentSchema),
    folder: syncAxis(personalFolderAssignmentSchema)
  })
  .strict();
export type PersonalSourceContextSync = z.infer<
  typeof personalSourceContextSyncSchema
>;

export const personalSourceContextStateSchema = z
  .object({
    sync: personalSourceContextSyncSchema.optional(),
    sessionId: z.uuid(),
    logicalSessionId: z.uuid(),
    git: personalGitAssignmentSchema,
    folder: personalFolderAssignmentSchema
  })
  .strict();
const expectedVersion = z.number().int().positive().safe();
export const personalSourceCorrectionApplySchema = z
  .object({ expectedVersion })
  .strict();
export const personalSourceCorrectionInputSchema = z.union([
  z
    .object({
      axis: z.literal("git"),
      action: z.literal("set"),
      repository: personalGitContextSchema,
      expectedVersion
    })
    .strict(),
  z
    .object({
      axis: z.literal("folder"),
      action: z.literal("set"),
      folder: personalFolderReferenceSchema,
      expectedVersion
    })
    .strict(),
  z
    .object({
      axis: z.enum(["git", "folder"]),
      action: z.enum(["unresolved", "reset"]),
      expectedVersion
    })
    .strict()
]);
export const personalSourceCorrectionPreviewSchema = z
  .object({
    reviewId: z.uuid(),
    axis: z.enum(["git", "folder"]),
    expectedVersion,
    before: personalSourceContextStateSchema,
    after: personalSourceContextStateSchema,
    projects: z
      .array(
        z
          .object({
            projectId: z.uuid(),
            name: z.string().min(1).max(160),
            version: expectedVersion,
            beforeReasons: z.array(personalMembershipReasonSchema),
            afterReasons: z.array(personalMembershipReasonSchema),
            beforeIncluded: z.boolean(),
            afterIncluded: z.boolean()
          })
          .strict()
      )
      .max(5000)
  })
  .strict();
export const personalSourceContextCommandSchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("get"), sessionId: z.uuid() }).strict(),
    z
      .object({
        action: z.literal("preview"),
        sessionId: z.uuid(),
        correction: personalSourceCorrectionInputSchema
      })
      .strict(),
    z
      .object({
        action: z.literal("apply"),
        sessionId: z.uuid(),
        reviewId: z.uuid(),
        expectedVersion
      })
      .strict()
  ]
);
export type PersonalSourceContextCommandResult = {
  context: PersonalSourceContextState;
  preview?: PersonalSourceCorrectionPreview;
};
export const personalSourceContextCommandResultSchema: z.ZodType<PersonalSourceContextCommandResult> =
  z
    .object({
      context: personalSourceContextStateSchema,
      preview: personalSourceCorrectionPreviewSchema.optional()
    })
    .strict();
export type PersonalSourceContextState = z.infer<
  typeof personalSourceContextStateSchema
>;
export type PersonalSourceCorrectionInput = z.infer<
  typeof personalSourceCorrectionInputSchema
>;
export type PersonalSourceCorrectionPreview = z.infer<
  typeof personalSourceCorrectionPreviewSchema
>;
