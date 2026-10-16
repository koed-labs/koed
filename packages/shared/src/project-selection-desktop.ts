import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const checkout = {
  localProjectId: z.string().regex(/^lp_[0-9a-f]{32}$/),
  expectedCheckoutId: id
};
const association = { groupId: id, associationId: id, selectionId: id };
export const projectSelectionLookupResponseSchema = z
  .object({
    association: z
      .object({
        ...association,
        selection: z
          .discriminatedUnion("state", [
            z
              .object({
                state: z.literal("selected"),
                anchorFingerprint: z.string().min(1).max(512)
              })
              .strict(),
            z.object({ state: z.literal("conflict") }).strict()
          ])
          .nullable()
      })
      .strict()
      .nullable()
  })
  .strict();
const choice = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set"),
      anchorFingerprint: z.string().min(4).max(512).startsWith("gr_")
    })
    .strict(),
  z.object({ kind: z.literal("delete") }).strict()
]);
const state = z
  .object({
    state: z.enum(["absent", "deleted", "selected", "conflict", "incomplete"]),
    heads: z.array(id).max(1024),
    anchorFingerprint: z.string().max(512).optional(),
    missingRevisions: z.array(id).max(1024).optional(),
    revisions: z
      .array(
        z
          .object({
            revisionId: id,
            authorDeviceId: id,
            replaces: z.array(id).max(1024),
            operation: choice
          })
          .strip()
      )
      .max(100_000)
  })
  .strip();
export const projectSelectionCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("inspect"),
      localProjectId: checkout.localProjectId
    })
    .strict(),
  z
    .object({
      operation: z.literal("create"),
      ...checkout,
      remoteName: z.string().min(1).max(512)
    })
    .strict(),
  z
    .object({ operation: z.literal("accept"), ...checkout, ...association })
    .strict(),
  z.object({ operation: z.literal("forget"), ...checkout }).strict(),
  z
    .object({
      operation: z.literal("set"),
      ...checkout,
      ...association,
      remoteName: z.string().min(1).max(512).nullable(),
      reviewedHeads: z.array(id).max(1024)
    })
    .strict()
]);
export type ProjectSelectionCommand = z.infer<
  typeof projectSelectionCommandSchema
>;
export const projectSelectionCommandResultSchema = z
  .object({
    checkoutId: id,
    defaultRemote: z.string().max(512).nullable(),
    deviceLabels: z.record(id, z.string().max(80)).default({}),
    remotes: z
      .array(
        z
          .object({
            name: z.string().min(1).max(512),
            fingerprint: z.string().max(512),
            display: z.string().max(512).nullable()
          })
          .strict()
      )
      .max(100),
    groupId: id.nullable(),
    accepted: z
      .object({ ...association })
      .strict()
      .nullable(),
    associations: z
      .array(z.object({ associationId: id, selectionId: id, state }).strict())
      .max(1000)
  })
  .strict();
export type ProjectSelectionCommandResult = z.infer<
  typeof projectSelectionCommandResultSchema
>;
