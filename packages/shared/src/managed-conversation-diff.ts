import { z } from "zod";

import { managedConversationFilePathSchema } from "./managed-conversation-files.js";

export const managedConversationDiffPayloadSchema = z
  .object({
    fromCommitObjectId: z.string().regex(/^[0-9a-f]{40,64}$/),
    toCommitObjectId: z.string().regex(/^[0-9a-f]{40,64}$/),
    complete: z.boolean(),
    files: z
      .array(
        z
          .object({
            path: managedConversationFilePathSchema,
            previousPath: managedConversationFilePathSchema.optional(),
            status: z.enum([
              "added",
              "copied",
              "deleted",
              "modified",
              "renamed",
              "type_changed",
              "unknown"
            ]),
            binary: z.boolean(),
            patch: z
              .string()
              .max(512 * 1_024)
              .nullable(),
            patchTruncated: z.boolean()
          })
          .strict()
      )
      .max(25_000),
    fileCount: z.number().int().safe().nonnegative(),
    returnedFileCount: z.number().int().safe().nonnegative(),
    byteCount: z.number().int().safe().nonnegative(),
    truncated: z.boolean(),
    continuation: z
      .object({
        nextFileIndex: z.number().int().safe().nonnegative(),
        revisionDigest: z.string().regex(/^[0-9a-f]{64}$/)
      })
      .strict()
      .nullable(),
    revisionDigest: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

export const managedConversationDiffSchema = z
  .object({
    executionId: z.uuid(),
    executionGeneration: z.number().int().safe().positive(),
    scope: z.enum(["turn", "full"]),
    scopeKey: z.string().trim().min(1).max(256),
    fromCheckpointId: z.uuid(),
    toCheckpointId: z.uuid(),
    revisionDigest: z.string().regex(/^[0-9a-f]{64}$/),
    complete: z.boolean(),
    truncated: z.boolean(),
    fileCount: z.number().int().safe().nonnegative(),
    byteCount: z.number().int().safe().nonnegative(),
    diff: managedConversationDiffPayloadSchema
  })
  .strict();

export type ManagedConversationDiff = z.infer<
  typeof managedConversationDiffSchema
>;
