import {
  COLLABORATION_SOURCE_PAGE_MAX_ITEMS,
  collaborationNameSchema
} from "@koed/shared";
import { z } from "zod";
import { SHARED_MEMORY_AUTHORITY } from "@koed/db";

export const SHARED_MEMORY_WORKSPACE_INDEX_DEFAULT_LIMIT = 50;
export const SHARED_MEMORY_WORKSPACE_INDEX_MAX_LIMIT = 100;
export const SHARED_MEMORY_WORKSPACE_INDEX_MAX_OFFSET = 10_000;

const uuidSchema = z.uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeVersionSchema = z.number().int().safe().min(0);
const positiveVersionSchema = z.number().int().safe().positive();

export const sharedMemoryRepresentationSchema = z.enum([
  "memory_events",
  "lcm_leaves",
  "lcm_rollups",
  "curated_assertions"
]);

const distinctRepresentationsSchema = z
  .array(sharedMemoryRepresentationSchema)
  .min(1)
  .max(4)
  .refine((values) => new Set(values).size === values.length, {
    message: "Representations must be distinct"
  });

export const sharedMemoryAuthoritySchema = z.discriminatedUnion("source", [
  z
    .object({
      action: z.literal(SHARED_MEMORY_AUTHORITY),
      source: z.literal("browser_session")
    })
    .strict(),
  z
    .object({
      action: z.literal(SHARED_MEMORY_AUTHORITY),
      source: z.literal("device_action_grant"),
      referenceId: uuidSchema
    })
    .strict()
]);

export const sourceOwnerPolicyParamsSchema = z
  .object({ logicalMemoryId: uuidSchema })
  .strict();

export const teamPolicyParamsSchema = z.object({ teamId: uuidSchema }).strict();

export const workspacePolicyParamsSchema = z
  .object({ teamId: uuidSchema, teamWorkspaceId: uuidSchema })
  .strict();

export const listWorkspaceSharedMemoryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(SHARED_MEMORY_WORKSPACE_INDEX_MAX_LIMIT)
      .default(SHARED_MEMORY_WORKSPACE_INDEX_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .safe()
      .min(0)
      .max(SHARED_MEMORY_WORKSPACE_INDEX_MAX_OFFSET)
      .default(0)
  })
  .strict();

export const listOwnedSharesQuerySchema = listWorkspaceSharedMemoryQuerySchema
  .omit({ offset: true })
  .extend({
    history: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default(false),
    snapshotAt: z.iso.datetime().optional(),
    afterCreatedAt: z.iso.datetime().optional(),
    afterKind: z.enum(["grant", "pending"]).optional(),
    afterId: uuidSchema.optional()
  })
  .superRefine((input, context) => {
    const keyset = [input.afterCreatedAt, input.afterKind, input.afterId];
    if (
      keyset.some((value) => value !== undefined) &&
      keyset.some((value) => value === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Owned-share keyset fields must be supplied together"
      });
    }
  })
  .transform(({ afterCreatedAt, afterKind, afterId, ...input }) => ({
    ...input,
    ...(afterCreatedAt && afterKind && afterId
      ? {
          after: {
            createdAt: afterCreatedAt,
            recordKind: afterKind,
            id: afterId
          }
        }
      : {})
  }));

export const ownedShareParamsSchema = z
  .object({ kind: z.enum(["pending", "grant"]), id: uuidSchema })
  .strict();

export const renameOwnedShareSchema = z
  .object({ title: collaborationNameSchema })
  .strict();

export const controlPendingShareSchema = z
  .object({
    mutationId: uuidSchema,
    expectedOperationVersion: z.number().int().safe().positive(),
    action: z.enum(["retry", "pause", "resume", "revoke"])
  })
  .strict();

export const putSharedMemoryPolicySchema = z
  .object({
    mutationId: uuidSchema,
    policyId: uuidSchema.optional(),
    expectedCurrentVersion: nonNegativeVersionSchema,
    allowedRepresentations: distinctRepresentationsSchema
  })
  .strict();

export const createSharedMemoryPreviewSchema = z
  .object({
    logicalMemoryId: uuidSchema,
    remoteReplicaId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    representation: sharedMemoryRepresentationSchema,
    allowedRepresentations: distinctRepresentationsSchema,
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .refine(
    (input) => input.allowedRepresentations.includes(input.representation),
    { message: "Preview representation is outside the approved allowlist" }
  );

export const createSharedMemoryCandidatePreviewSchema = z
  .object({
    logicalMemoryId: uuidSchema,
    candidateHash: sha256Schema,
    sourceRevision: nonNegativeVersionSchema,
    itemCount: z.number().int().safe().positive().max(100),
    excludedItemCount: z.number().int().safe().nonnegative(),
    manifest: z
      .array(
        z.object({ sourceId: uuidSchema, revisionHash: sha256Schema }).strict()
      )
      .min(1)
      .max(100),
    byteCount: z
      .number()
      .int()
      .safe()
      .positive()
      .max(256 * 1_024),
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    representation: sharedMemoryRepresentationSchema,
    allowedRepresentations: distinctRepresentationsSchema,
    mode: z.enum(["snapshot", "continuous"]),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .refine(
    (input) => input.allowedRepresentations.includes(input.representation),
    { message: "Preview representation is outside the approved allowlist" }
  );

export const sharedSourcePreviewReferenceSchema = z
  .object({
    previewId: uuidSchema,
    previewHash: sha256Schema
  })
  .strict();

export const createSourceOwnerConsentSchema = z
  .object({
    consentId: uuidSchema,
    logicalMemoryId: uuidSchema,
    preview: sharedSourcePreviewReferenceSchema,
    previewRevision: positiveVersionSchema,
    mode: z.enum(["snapshot", "continuous"]),
    allowedRepresentations: distinctRepresentationsSchema,
    selectedRepresentation: sharedMemoryRepresentationSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .refine(
    (input) =>
      input.allowedRepresentations.includes(input.selectedRepresentation),
    { message: "Selected representation is not owner-authorized" }
  );

export const createShareGrantSchema = z
  .object({
    mutationId: uuidSchema,
    logicalGrantId: uuidSchema,
    logicalMemoryId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    consentId: uuidSchema,
    authority: sharedMemoryAuthoritySchema
  })
  .strict();

export const createSharedMemoryShareBundleSchema = z
  .object({
    mutationId: uuidSchema,
    logicalGrantId: uuidSchema,
    consentId: uuidSchema,
    logicalMemoryId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    preview: sharedSourcePreviewReferenceSchema,
    previewRevision: positiveVersionSchema,
    mode: z.enum(["snapshot", "continuous"]),
    allowedRepresentations: distinctRepresentationsSchema,
    selectedRepresentation: sharedMemoryRepresentationSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    title: collaborationNameSchema.optional(),
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .refine(
    (input) =>
      input.allowedRepresentations.includes(input.selectedRepresentation),
    { message: "Selected representation is not owner-authorized" }
  );

export const createPendingShareSchema = createSharedMemoryShareBundleSchema;

export const changeSharedMemoryRepresentationBundleSchema = z
  .object({
    mutationId: uuidSchema,
    consentId: uuidSchema,
    logicalMemoryId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    preview: sharedSourcePreviewReferenceSchema,
    previewRevision: positiveVersionSchema,
    mode: z.enum(["snapshot", "continuous"]),
    allowedRepresentations: distinctRepresentationsSchema,
    representation: sharedMemoryRepresentationSchema,
    expectedGrantVersion: positiveVersionSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .refine(
    (input) => input.allowedRepresentations.includes(input.representation),
    { message: "Selected representation is not owner-authorized" }
  );

export const shareGrantParamsSchema = z
  .object({ shareGrantId: uuidSchema })
  .strict();

export const putTeamConversationSourceGrantSchema = z
  .object({
    mutationId: uuidSchema,
    teamId: uuidSchema,
    expectedVersion: nonNegativeVersionSchema,
    mode: z.enum(["snapshot", "continuous"]),
    authority: sharedMemoryAuthoritySchema
  })
  .strict();

export const revokeTeamConversationSourceGrantSchema = z
  .object({
    mutationId: uuidSchema,
    teamId: uuidSchema,
    expectedVersion: positiveVersionSchema,
    reasonCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/),
    authority: sharedMemoryAuthoritySchema
  })
  .strict();

export const scopedShareGrantParamsSchema = z
  .object({
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    shareGrantId: uuidSchema
  })
  .strict();

export const sharedMemoryItemDetailParamsSchema = scopedShareGrantParamsSchema
  .extend({ sourceId: uuidSchema })
  .strict();

export const selectGrantRepresentationSchema = z
  .object({
    mutationId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    consentId: uuidSchema,
    representation: sharedMemoryRepresentationSchema,
    expectedGrantVersion: positiveVersionSchema,
    authority: sharedMemoryAuthoritySchema
  })
  .strict();

export const representationParamsSchema = shareGrantParamsSchema
  .extend({ representation: sharedMemoryRepresentationSchema })
  .strict();

export const materializeGrantRepresentationSchema = z
  .object({
    mutationId: uuidSchema,
    consentId: uuidSchema,
    expectedGrantVersion: positiveVersionSchema,
    expectedRepresentationVersion: positiveVersionSchema.optional(),
    preview: sharedSourcePreviewReferenceSchema
  })
  .strict();

export const readGrantRepresentationQuerySchema = z
  .object({ representation: sharedMemoryRepresentationSchema.optional() })
  .strict();

export const readGrantRepresentationPageQuerySchema =
  readGrantRepresentationQuerySchema
    .extend({
      direction: z.enum(["older", "newer"]).default("older"),
      boundary: z.coerce.number().int().safe().min(0).optional(),
      limit: z.coerce
        .number()
        .int()
        .safe()
        .min(1)
        .max(COLLABORATION_SOURCE_PAGE_MAX_ITEMS)
        .default(COLLABORATION_SOURCE_PAGE_MAX_ITEMS)
    })
    .strict();

export const revokeShareGrantSchema = z
  .object({
    mutationId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    expectedGrantVersion: positiveVersionSchema,
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    authority: sharedMemoryAuthoritySchema
  })
  .strict();
