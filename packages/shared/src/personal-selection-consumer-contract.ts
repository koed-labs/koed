import { z } from "zod";
import { personalRecallTargetSchema } from "./personal-selection-contract.js";
import {
  personalOwnerIdSchema,
  personalSourceReferenceSchema
} from "./personal-source-contract.js";
import { personalMembershipReasonSchema } from "./personal-membership-contract.js";

/** Native IDs describe local evidence only; they never assert a portable origin. */
export const personalSelectionConsumerTargetSchema = z.union([
  personalRecallTargetSchema.refine(
    (target) => target.kind !== "global",
    "Choose a Project, Git Anchor, exact Folder or Conversation"
  ),
  z.object({ kind: z.literal("local_session"), sessionId: z.uuid() }).strict()
]);
export const personalSelectionConsumerSelectionSchema = z
  .object({
    version: z.literal(1),
    ownerUserId: personalOwnerIdSchema,
    target: personalSelectionConsumerTargetSchema
  })
  .strict()
  .superRefine((selection, ctx) => {
    const target = selection.target;
    const owner =
      target.kind === "project"
        ? target.project.ownerUserId
        : target.kind === "folder"
          ? target.folder.ownerUserId
          : target.kind === "session"
            ? target.source.ownerUserId
            : selection.ownerUserId;
    if (owner !== selection.ownerUserId)
      ctx.addIssue({
        code: "custom",
        message: "Selection target belongs to another owner"
      });
  });
export const personalSelectionConsumerStartSchema = z
  .object({ target: personalSelectionConsumerTargetSchema })
  .strict();
export const personalSelectionConsumerContinueSchema = z
  .object({ cursor: z.uuid() })
  .strict();
const source = z
  .object({
    localSessionId: z.uuid(),
    localLogicalSessionId: z.uuid(),
    portable: personalSourceReferenceSchema.nullable(),
    identityState: z.enum(["verified", "local_only"]),
    contextVersion: z
      .object({
        git: z.number().int().positive(),
        folder: z.number().int().positive()
      })
      .strict()
  })
  .strict()
  .superRefine((source, ctx) => {
    if ((source.identityState === "verified") !== (source.portable !== null))
      ctx.addIssue({
        code: "custom",
        message: "Source identity state does not match its evidence"
      });
  });
const reason = z.union([
  personalMembershipReasonSchema,
  z
    .object({
      kind: z.literal("selection"),
      targetKind: z.enum(["repository", "folder", "session", "local_session"])
    })
    .strict()
]);
/** One source/reason pair per entry keeps all overlapping reasons paginable.
 * A consumer combines entries using actual local source ID and inclusion ID. */
export const personalSelectionConsumerPageSchema = z
  .object({
    version: z.literal(1),
    snapshotVersion: z.uuid(),
    selection: personalSelectionConsumerSelectionSchema,
    entries: z
      .array(
        z
          .object({
            source,
            reason,
            projectVersion: z.number().int().positive().nullable()
          })
          .strict()
      )
      .max(100),
    nextCursor: z.uuid().nullable(),
    changeCursor: z.uuid().nullable(),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict();
export const personalSelectionConsumerChangesSchema = z
  .object({
    version: z.literal(1),
    selection: personalSelectionConsumerSelectionSchema,
    events: z
      .array(
        z
          .object({
            eventId: z.string().regex(/^[1-9][0-9]*$/),
            kind: z.enum([
              "source",
              "membership",
              "source_context",
              "availability"
            ])
          })
          .strict()
      )
      .max(100),
    nextCursor: z.uuid().nullable(),
    changeCursor: z.uuid().nullable(),
    reconciliationRequired: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type PersonalSelectionConsumerSelection = z.infer<
  typeof personalSelectionConsumerSelectionSchema
>;
export type PersonalSelectionConsumerPage = z.infer<
  typeof personalSelectionConsumerPageSchema
>;
