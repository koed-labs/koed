import {
  COLLABORATION_SOURCE_PAGE_MAX_ITEMS,
  personalNoteSourceSelectionIssues,
  sharedMemoryCandidatePreviewSchema,
  sharedMemoryCeilingAuthorizes,
  sharedMemoryFidelityCeilings,
  sharedMemorySourceCapabilitiesSchema,
  sharedMemorySourceRefSchema
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

export const personalNoteSourceArtifactUploadSchema = z
  .object({
    pendingShareId: uuidSchema,
    sourceDeploymentProtocolId: uuidSchema,
    sourceOwnerPrincipalId: uuidSchema,
    candidate: sharedMemoryCandidatePreviewSchema
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.candidate.source.kind !== "personal_note" ||
      input.candidate.activationRepresentation !== "memory_events" ||
      input.candidate.sourceRevision !== input.candidate.source.noteRevision ||
      input.candidate.itemCount !== 1 ||
      input.candidate.items.length !== 1 ||
      input.candidate.manifest.length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "A source upload must contain one Personal Note Memory Event"
      });
    }
  });

export const advanceContinuousPersonalNoteRevisionSchema = z
  .object({
    mutationId: uuidSchema,
    sourceDeploymentProtocolId: uuidSchema,
    sourceOwnerPrincipalId: uuidSchema,
    afterShareGrantId: uuidSchema.optional(),
    candidate: sharedMemoryCandidatePreviewSchema
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.candidate.source.kind !== "personal_note" ||
      input.candidate.mode !== "continuous" ||
      input.candidate.sourceRevision !== input.candidate.source.noteRevision ||
      input.candidate.itemCount !== 1 ||
      input.candidate.items.length !== 1 ||
      input.candidate.manifest.length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message:
          "Continuous Personal Note advancement requires one exact selected revision"
      });
    }
  });

export const sharedMemoryRepresentationSchema = z.enum([
  ...sharedMemoryFidelityCeilings,
  "curated_assertions"
]);

export const sharedMemoryFidelityCeilingSchema = z.enum(
  sharedMemoryFidelityCeilings
);

const fidelityConsentShape = {
  maximumFidelity: sharedMemoryFidelityCeilingSchema,
  includeCuratedMemory: z.boolean()
};

const validateSourceLogicalMemory = (
  input: { logicalMemoryId: string; source?: { logicalMemoryId: string } },
  context: z.RefinementCtx
) => {
  if (input.source && input.source.logicalMemoryId !== input.logicalMemoryId) {
    context.addIssue({
      code: "custom",
      path: ["source", "logicalMemoryId"],
      message: "Shared Memory source must match the logical Memory"
    });
  }
};

const validatePersonalNoteSelection = (
  input: {
    logicalMemoryId: string;
    source: z.infer<typeof sharedMemorySourceRefSchema>;
    mode: "snapshot" | "continuous";
    activationRepresentation: z.infer<typeof sharedMemoryRepresentationSchema>;
    sourceCapabilities: Array<z.infer<typeof sharedMemoryRepresentationSchema>>;
    maximumFidelity: z.infer<typeof sharedMemoryFidelityCeilingSchema>;
    includeCuratedMemory: boolean;
    sourceRevision: number;
    manifest: Array<{ sourceId: string; revisionHash: string }>;
  },
  context: z.RefinementCtx
) => {
  validateSourceLogicalMemory(input, context);
  for (const message of personalNoteSourceSelectionIssues({
    ...input,
    source: input.source
  })) {
    context.addIssue({ code: "custom", path: ["source"], message });
  }
};

const validatePersonalNoteConsent = (
  input: {
    logicalMemoryId: string;
    source: z.infer<typeof sharedMemorySourceRefSchema>;
    mode: "snapshot" | "continuous";
    activationRepresentation: z.infer<typeof sharedMemoryRepresentationSchema>;
    sourceCapabilities: Array<z.infer<typeof sharedMemoryRepresentationSchema>>;
    maximumFidelity: z.infer<typeof sharedMemoryFidelityCeilingSchema>;
    includeCuratedMemory: boolean;
  },
  context: z.RefinementCtx
) => {
  validateSourceLogicalMemory(input, context);
  if (input.source.kind !== "personal_note") return;
  if (
    input.activationRepresentation !== "memory_events" ||
    input.sourceCapabilities.length !== 1 ||
    input.sourceCapabilities[0] !== "memory_events" ||
    input.maximumFidelity !== "memory_events" ||
    input.includeCuratedMemory
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceCapabilities"],
      message:
        "Personal Note sharing requires Memory Event source capability, activation, and consent"
    });
  }
};

const validateEffectiveSelection = (
  input: {
    sourceCapabilities: Array<z.infer<typeof sharedMemoryRepresentationSchema>>;
    activationRepresentation: z.infer<typeof sharedMemoryRepresentationSchema>;
    maximumFidelity: z.infer<typeof sharedMemoryFidelityCeilingSchema>;
    includeCuratedMemory: boolean;
  },
  context: z.RefinementCtx
) => {
  if (
    !input.sourceCapabilities.includes(input.activationRepresentation) ||
    !sharedMemoryCeilingAuthorizes(
      input.maximumFidelity,
      input.activationRepresentation,
      input.includeCuratedMemory
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["activationRepresentation"],
      message:
        "Activation representation must be supported by the source and consent"
    });
  }
};

const browserSharedMemoryAuthoritySchema = z
  .object({
    action: z.literal(SHARED_MEMORY_AUTHORITY),
    source: z.literal("browser_session")
  })
  .strict();

const deviceSharedMemoryAuthoritySchema = z
  .object({
    action: z.literal(SHARED_MEMORY_AUTHORITY),
    source: z.literal("device_action_grant"),
    referenceId: uuidSchema
  })
  .strict();

export const sharedMemoryAuthoritySchema = z.discriminatedUnion("source", [
  browserSharedMemoryAuthoritySchema,
  deviceSharedMemoryAuthoritySchema
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
    ...fidelityConsentShape
  })
  .strict();

export const createSharedMemoryPreviewSchema = z
  .object({
    source: sharedMemorySourceRefSchema,
    sourceCapabilities: sharedMemorySourceCapabilitiesSchema,
    logicalMemoryId: uuidSchema,
    remoteReplicaId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    activationRepresentation: sharedMemoryRepresentationSchema,
    ...fidelityConsentShape,
    mode: z.enum(["snapshot", "continuous"]),
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .superRefine((input, context) => {
    validateSourceLogicalMemory(input, context);
    validateEffectiveSelection(input, context);
    validatePersonalNoteConsent(input, context);
  });

export const createSharedMemoryCandidatePreviewSchema = z
  .object({
    source: sharedMemorySourceRefSchema,
    sourceDeploymentProtocolId: uuidSchema,
    sourceOwnerPrincipalId: uuidSchema,
    sourceCapabilities: sharedMemorySourceCapabilitiesSchema,
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
    activationRepresentation: sharedMemoryRepresentationSchema,
    ...fidelityConsentShape,
    mode: z.enum(["snapshot", "continuous"]),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    authority: deviceSharedMemoryAuthoritySchema
  })
  .strict()
  .superRefine((input, context) => {
    validateEffectiveSelection(input, context);
    validatePersonalNoteSelection(input, context);
  });

export const sharedSourcePreviewReferenceSchema = z
  .object({
    previewId: uuidSchema,
    previewHash: sha256Schema
  })
  .strict();

export const createPendingShareSchema = z
  .object({
    source: sharedMemorySourceRefSchema,
    sourceCapabilities: sharedMemorySourceCapabilitiesSchema,
    activationRepresentation: sharedMemoryRepresentationSchema,
    mutationId: uuidSchema,
    logicalGrantId: uuidSchema,
    consentId: uuidSchema,
    logicalMemoryId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    preview: sharedSourcePreviewReferenceSchema,
    previewRevision: positiveVersionSchema,
    mode: z.enum(["snapshot", "continuous"]),
    ...fidelityConsentShape,
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .superRefine((input, context) => {
    validateEffectiveSelection(input, context);
    validatePersonalNoteConsent(input, context);
  });

export const changeSharedMemoryFidelityBundleSchema = z
  .object({
    source: sharedMemorySourceRefSchema,
    sourceCapabilities: sharedMemorySourceCapabilitiesSchema,
    activationRepresentation: sharedMemoryRepresentationSchema,
    mutationId: uuidSchema,
    consentId: uuidSchema,
    logicalMemoryId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    preview: sharedSourcePreviewReferenceSchema,
    previewRevision: positiveVersionSchema,
    mode: z.enum(["snapshot", "continuous"]),
    ...fidelityConsentShape,
    expectedGrantVersion: positiveVersionSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    authority: sharedMemoryAuthoritySchema
  })
  .strict()
  .superRefine((input, context) => {
    validateEffectiveSelection(input, context);
    validatePersonalNoteConsent(input, context);
  });

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

export const readGrantRepresentationQuerySchema = z
  .object({ representation: sharedMemoryRepresentationSchema })
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
