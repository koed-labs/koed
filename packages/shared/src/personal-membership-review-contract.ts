import { z } from "zod";
import {
  personalIdentifierSchema,
  personalSourceReferenceSchema
} from "./personal-source-contract.js";
import { personalMembershipRevisionSchema } from "./personal-membership-contract.js";
import { personalNamedProjectSchema } from "./personal-project-contract.js";

export const personalMembershipSyncEntitySchema = z
  .object({
    entityId: personalIdentifierSchema,
    entityKind: z.enum(["project", "direct", "rule", "exclusion"]),
    state: z.enum(["pending", "available", "conflict"]),
    heads: z.array(personalMembershipRevisionSchema).max(1024),
    ruleCandidates: z
      .array(personalMembershipRevisionSchema)
      .max(4096)
      .optional(),
    source: z
      .object({
        reference: personalSourceReferenceSchema,
        ready: z.boolean(),
        localSessionId: z.uuid().nullable()
      })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((entity, ctx) => {
    if (
      (entity.state === "available" && entity.heads.length !== 1) ||
      (entity.state === "conflict" && entity.heads.length < 2) ||
      new Set(entity.heads.map((head) => head.revisionId)).size !==
        entity.heads.length ||
      entity.heads.some((head) => head.entityId !== entity.entityId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Membership heads do not match the entity frontier"
      });
    if (
      entity.ruleCandidates?.some(
        (revision) =>
          entity.entityKind !== "rule" ||
          revision.entityId !== entity.entityId ||
          revision.operation.kind !== "include" ||
          revision.operation.selector.kind === "session"
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid rule candidates" });
    const needsSource =
      entity.entityKind === "direct" || entity.entityKind === "exclusion";
    if (
      needsSource !== Boolean(entity.source) ||
      (entity.source &&
        entity.source.ready !== Boolean(entity.source.localSessionId))
    )
      ctx.addIssue({
        code: "custom",
        message: "Membership source state is inconsistent"
      });
  });
export const personalMembershipSyncStateSchema = z
  .object({
    project: personalNamedProjectSchema,
    projectIdentity: personalIdentifierSchema,
    catalog: personalMembershipSyncEntitySchema.nullable(),
    memberships: z.array(personalMembershipSyncEntitySchema).max(100),
    nextEntityId: personalIdentifierSchema.nullable()
  })
  .strict()
  .superRefine((state, ctx) => {
    const entities = [
      ...(state.catalog ? [state.catalog] : []),
      ...state.memberships
    ];
    const heads = entities.flatMap((entity) => entity.heads);
    if (
      (state.catalog &&
        (state.catalog.entityKind !== "project" ||
          state.catalog.entityId !== state.projectIdentity)) ||
      state.memberships.some((entity) => entity.entityKind === "project") ||
      new Set(entities.map((entity) => entity.entityId)).size !==
        entities.length ||
      heads.some((head) => head.project.projectId !== state.projectIdentity) ||
      new Set(heads.map((head) => head.project.ownerUserId)).size > 1
    )
      ctx.addIssue({
        code: "custom",
        message: "Membership state addresses different Projects or owners"
      });
  });
const expectedVersion = z.number().int().safe().positive();
export const personalMembershipReviewInputSchema = z
  .object({
    entityId: personalIdentifierSchema,
    expectedVersion,
    expectedHeads: z.array(personalIdentifierSchema).min(1).max(1024),
    change: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("set_project"),
          name: z.string().trim().min(1).max(160)
        })
        .strict(),
      z.object({ kind: z.literal("delete_project") }).strict(),
      z
        .object({
          kind: z.literal("include"),
          candidateRevisionId: personalIdentifierSchema.optional()
        })
        .strict(),
      z.object({ kind: z.literal("remove_inclusion") }).strict(),
      z.object({ kind: z.literal("exclude") }).strict(),
      z.object({ kind: z.literal("clear_exclusion") }).strict()
    ])
  })
  .strict()
  .refine(
    (value) => new Set(value.expectedHeads).size === value.expectedHeads.length,
    "Reviewed revisions must be distinct"
  );
export const personalMembershipReviewApplySchema = z
  .object({ expectedVersion })
  .strict();
export const personalMembershipReviewPreviewSchema = z
  .object({
    reviewId: z.uuid(),
    expectedVersion,
    projectIdentity: personalIdentifierSchema,
    entityId: personalIdentifierSchema,
    before: personalMembershipSyncEntitySchema,
    after: personalMembershipRevisionSchema,
    effect: z
      .object({
        catalogActive: z.boolean(),
        blockedByExclusion: z.boolean().optional(),
        sourceReady: z.boolean().nullable(),
        included: z.boolean()
      })
      .strict()
  })
  .strict()
  .superRefine((preview, ctx) => {
    const heads = preview.before.heads.map((head) => head.revisionId).sort();
    if (
      !heads.length ||
      preview.before.entityId !== preview.entityId ||
      preview.after.entityId !== preview.entityId ||
      preview.after.project.projectId !== preview.projectIdentity ||
      preview.before.heads.some(
        (head) =>
          head.project.projectId !== preview.projectIdentity ||
          head.project.ownerUserId !== preview.after.project.ownerUserId
      ) ||
      JSON.stringify([...preview.after.replaces].sort()) !==
        JSON.stringify(heads)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Membership review does not replace its exact reviewed frontier"
      });
    if (
      preview.effect.sourceReady !== (preview.before.source?.ready ?? null) ||
      preview.effect.included !==
        (preview.before.entityKind === "direct" &&
          preview.after.operation.kind === "include" &&
          preview.effect.catalogActive &&
          preview.effect.sourceReady === true &&
          !preview.effect.blockedByExclusion)
    )
      ctx.addIssue({
        code: "custom",
        message: "Membership review effect is inconsistent"
      });
  });
export const personalMembershipSyncCommandSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("list"),
        projectId: z.uuid(),
        afterEntityId: personalIdentifierSchema.optional()
      })
      .strict(),
    z
      .object({
        action: z.literal("preview"),
        projectId: z.uuid(),
        review: personalMembershipReviewInputSchema
      })
      .strict(),
    z
      .object({
        action: z.literal("apply"),
        projectId: z.uuid(),
        reviewId: z.uuid(),
        expectedVersion
      })
      .strict()
  ]
);
export const personalMembershipSyncCommandResultSchema = z
  .object({
    state: personalMembershipSyncStateSchema,
    preview: personalMembershipReviewPreviewSchema.optional()
  })
  .strict();
export type PersonalMembershipSyncEntity = z.infer<
  typeof personalMembershipSyncEntitySchema
>;
export type PersonalMembershipSyncState = z.infer<
  typeof personalMembershipSyncStateSchema
>;
export type PersonalMembershipReviewInput = z.infer<
  typeof personalMembershipReviewInputSchema
>;
export type PersonalMembershipReviewPreview = z.infer<
  typeof personalMembershipReviewPreviewSchema
>;
