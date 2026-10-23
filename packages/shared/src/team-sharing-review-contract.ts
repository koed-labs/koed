import {
  workspaceConversationRestorationIntentSchema,
  workspaceConversationExclusionIntentSchema,
  workspaceConversationExclusionSchema
} from "./workspace-conversation-exclusion-contract.js";
import {
  sharingRuleContentPolicyIntentSchema,
  sharingRuleContentPolicyAppliedScopeSchema,
  sharingRuleApprovedAmendmentFields
} from "./sharing-rule-content-policy-contract.js";
import { z } from "zod";
import { sharingRulePublisherSchema } from "./sharing-rule-publisher-contract.js";
import { sharingRuleSourceIdentitySchema } from "./sharing-rule-source-identity.js";
import {
  canonicalJsonDeterministicUuid as crossIdentitySyncDeterministicUuid,
  canonicalJsonDigest as crossIdentitySyncDigest
} from "./canonical-json-digest.js";
import {
  personalGitContextSchema,
  personalFolderReferenceSchema,
  personalProjectReferenceSchema
} from "./personal-source-contract.js";
import { personalSelectionConsumerPageSchema } from "./personal-selection-consumer-contract.js";
import { sharedMemoryFidelityCeilings } from "./shared-memory-fidelity.js";
import {
  sharingRuleDetailAppliedScopeSchema,
  sharingRuleDetailIntentSchema
} from "./sharing-rule-detail-contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Owner-private rule identity. Local paths, branch names and Project names
 * are not needed to attest future selection membership. */
export const sharingSelectionSelectorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("portable_repository"),
      key: z.string().min(1).max(512)
    })
    .strict(),
  z
    .object({
      kind: z.literal("device_local_repository"),
      key: z.string().min(1).max(512),
      originatingDeviceId: z.string().min(1).max(128)
    })
    .strict(),
  z.object({ kind: z.literal("folder"), key: hash }).strict(),
  z.object({ kind: z.literal("project"), key: hash }).strict()
]);
export const sharingSelectionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository"),
      repository: personalGitContextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("folder"),
      folder: personalFolderReferenceSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("project"),
      project: personalProjectReferenceSchema
    })
    .strict()
]);
/** Folder paths and private provenance remain local. Ownership is enforced by
 * the authenticated rule owner; local owner IDs must not change portable scope.
 * Project callers resolve native view IDs to their verified portable identity.
 * Folder identity retains every original deployment/device/profile/incarnation. */
export const sharingSelectionDescriptor = (
  target: z.infer<typeof sharingSelectionTargetSchema>
): z.infer<typeof sharingSelectionSelectorSchema> => {
  if (target.kind === "project") {
    const identity = personalProjectReferenceSchema
      .omit({ ownerUserId: true })
      .strip()
      .parse(target.project);
    return { kind: "project", key: crossIdentitySyncDigest(identity) };
  }
  if (target.kind === "folder") {
    const identity = personalFolderReferenceSchema
      .omit({ ownerUserId: true })
      .strip()
      .parse(target.folder);
    return { kind: "folder", key: crossIdentitySyncDigest(identity) };
  }
  const git = target.repository;
  return git.kind === "portable_repository"
    ? { kind: git.kind, key: git.key }
    : {
        kind: git.kind,
        key: git.key,
        originatingDeviceId: git.originatingDeviceId
      };
};
export const repositorySharingRuleCreationReviewInputSchema = z
  .object({
    selector: sharingSelectionSelectorSchema,
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    includeCuratedMemory: z.boolean(),
    includesFutureConversations: z.literal(true),
    completedReviewHash: hash,
    selectionSnapshotVersion: z.uuid()
  })
  .strict();
export const repositorySharingRuleCreationPolicySchema = z
  .object({
    teamPolicyVersion: z.number().int().safe().positive(),
    teamPolicyHash: hash,
    workspacePolicyVersion: z.number().int().safe().positive(),
    workspacePolicyHash: hash,
    effectivePrivacyPolicyHash: hash
  })
  .strict();
export const repositorySharingRuleCreationIntentSchema =
  repositorySharingRuleCreationReviewInputSchema
    .extend({
      mutationId: z.uuid(),
      ruleId: z.uuid(),
      ...repositorySharingRuleCreationPolicySchema.shape
    })
    .strict();
export const repositorySharingRuleCreationReviewSchema = z
  .object({
    scope: repositorySharingRuleCreationReviewInputSchema
      .extend(repositorySharingRuleCreationPolicySchema.shape)
      .strict(),
    teamName: z.string().min(1).max(4096),
    workspaceName: z.string().min(1).max(4096)
  })
  .strict();
export const repositorySharingRuleCreationResultSchema = z
  .object({
    ruleId: z.uuid(),
    state: z.literal("active"),
    authorityVersion: z.literal(1),
    publisherFence: z.literal(1)
  })
  .strict();
export type RepositorySharingRuleCreationIntent = z.infer<
  typeof repositorySharingRuleCreationIntentSchema
>;
export type RepositorySharingRuleCreationReviewInput = z.infer<
  typeof repositorySharingRuleCreationReviewInputSchema
>;
export type RepositorySharingRuleCreationReview = z.infer<
  typeof repositorySharingRuleCreationReviewSchema
>;
export type RepositorySharingRuleCreationResult = z.infer<
  typeof repositorySharingRuleCreationResultSchema
>;
export const repositorySharingRuleMemberAdmissionSchema = z
  .object({
    ruleId: z.uuid(),
    sourceIdentity: sharingRuleSourceIdentitySchema.optional(),
    selectionSnapshotVersion: z.uuid(),
    sourceContextHash: hash,
    selectorBindingHash: hash,
    gitContextVersion: z.number().int().safe().positive(),
    folderContextVersion: z.number().int().safe().positive(),
    expectedAuthorityVersion: z.number().int().safe().positive(),
    expectedMembershipVersion: z.number().int().safe().nonnegative(),
    expectedGrantVersion: z.number().int().safe().positive().nullable(),
    publisherFence: z.number().int().safe().positive()
  })
  .strict();
/** A current publisher may re-admit only a previously native-bound source.
 * Source bytes, native identifiers and candidate previews are resolved by Team. */
export const repositorySharingRuleMemberReadmissionSchema = z
  .object({
    mutationId: z.uuid(),
    consentId: z.uuid(),
    logicalMemoryId: z.uuid(),
    membership: repositorySharingRuleMemberAdmissionSchema
      .omit({ ruleId: true })
      .extend({
        sourceIdentity: sharingRuleSourceIdentitySchema,
        expectedMembershipVersion: z.number().int().safe().positive(),
        expectedGrantVersion: z.number().int().safe().positive().nullable()
      })
  })
  .strict();
export const repositorySharingRuleMemberAcceptanceSchema = z
  .object({
    pendingShareId: z.uuid(),
    membershipId: z.uuid(),
    membershipVersion: z.number().int().safe().positive(),
    authorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    sourceRevision: z.number().int().safe().nonnegative()
  })
  .strict();
export const repositorySharingRuleMembersInspectSchema = z
  .object({
    logicalMemoryIds: z.array(z.uuid()).min(1).max(100)
  })
  .strict();
/** Discovery under the current publisher, including sources absent from its
 * current Personal selection. Opaque origins grant no source authority. */
export const repositorySharingRuleMemberInventoryInputSchema = z
  .object({
    expectedAuthorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    afterMembershipId: z.uuid().optional()
  })
  .strict();
export const repositorySharingRuleMemberInventorySchema = z
  .object({
    ruleId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    authorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    selectorBindingHash: hash,
    entries: z
      .array(
        z
          .object({
            membershipId: z.uuid(),
            logicalMemoryId: z.uuid(),
            membershipVersion: z.number().int().safe().positive(),
            state: z.enum(["present", "removed", "revoked", "unresolved"]),
            portableSourceHash: hash.nullable()
          })
          .strict()
      )
      .max(100),
    nextAfterMembershipId: z.uuid().nullable()
  })
  .strict();
export const repositorySharingRuleMembersStateSchema = z
  .object({
    ruleId: z.uuid(),
    state: z.enum(["active", "paused", "stopped"]),
    authorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    selectorBindingHash: hash,
    effectivePrivacyPolicyHash: hash,
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    includeCuratedMemory: z.boolean(),
    detailAmendment: sharingRuleDetailAppliedScopeSchema.optional(),
    contentPolicyAmendment:
      sharingRuleContentPolicyAppliedScopeSchema.optional(),
    entries: z
      .array(
        z
          .object({
            logicalMemoryId: z.uuid(),
            workspaceExcluded: z.boolean(),
            grant: z
              .object({
                id: z.uuid(),
                logicalGrantId: z.uuid(),
                version: z.number().int().safe().positive(),
                lifecycle: z.string().min(1).max(40)
              })
              .strict()
              .nullable(),
            member: z
              .object({
                id: z.uuid(),
                version: z.number().int().safe().positive(),
                state: z.enum(["present", "removed", "revoked", "unresolved"]),
                selectionSnapshotVersion: z.uuid().nullable(),
                sourceContextHash: hash.nullable(),
                gitContextVersion: z
                  .number()
                  .int()
                  .safe()
                  .positive()
                  .nullable(),
                folderContextVersion: z
                  .number()
                  .int()
                  .safe()
                  .positive()
                  .nullable(),
                pendingShare: z
                  .object({
                    id: z.uuid(),
                    requiresReadmission: z.boolean().optional(),
                    state: z.enum([
                      "preparing",
                      "needs_attention",
                      "failed",
                      "activated",
                      "revoked"
                    ])
                  })
                  .strict()
                  .nullable()
              })
              .strict()
              .nullable()
          })
          .strict()
      )
      .max(100)
  })
  .strict()
  .superRefine((state, context) => {
    for (const scope of [state.detailAmendment, state.contentPolicyAmendment]) {
      if (
        scope &&
        (scope.result.ruleId !== state.ruleId ||
          scope.review.teamId !== state.teamId ||
          scope.review.teamWorkspaceId !== state.teamWorkspaceId ||
          scope.result.authorityVersion > state.authorityVersion ||
          scope.result.publisherFence > state.publisherFence)
      )
        context.addIssue({
          code: "custom",
          message: "Inspected amendment does not match the current rule"
        });
    }
    if (
      state.detailAmendment &&
      state.contentPolicyAmendment &&
      state.detailAmendment.result.authorityVersion ===
        state.contentPolicyAmendment.result.authorityVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "Different amendments cannot share one authority version"
      });
      return;
    }
    const fields = sharingRuleApprovedAmendmentFields(state);
    if (
      (fields.maximumFidelity !== undefined &&
        fields.maximumFidelity !== state.maximumFidelity) ||
      (fields.includeCuratedMemory !== undefined &&
        fields.includeCuratedMemory !== state.includeCuratedMemory) ||
      (fields.effectivePrivacyPolicyHash !== undefined &&
        fields.effectivePrivacyPolicyHash !== state.effectivePrivacyPolicyHash)
    )
      context.addIssue({
        code: "custom",
        message: "Inspected disclosure does not match its latest approved scope"
      });
  });
export const repositorySharingRuleMemberContextSchema = z
  .object({
    mutationId: z.uuid(),
    selectionSnapshotVersion: z.uuid(),
    sourceContextHash: hash,
    gitContextVersion: z.number().int().safe().positive(),
    folderContextVersion: z.number().int().safe().positive(),
    selectorBindingHash: hash,
    expectedAuthorityVersion: z.number().int().safe().positive(),
    expectedMembershipVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive()
  })
  .strict();
export const repositorySharingRuleMemberContextResultSchema = z
  .object({
    ruleId: z.uuid(),
    membershipId: z.uuid(),
    membershipVersion: z.number().int().safe().positive(),
    authorityVersion: z.number().int().safe().positive()
  })
  .strict();
export const repositorySharingRuleMemberRemovalSchema =
  repositorySharingRuleMemberContextSchema.omit({
    gitContextVersion: true,
    folderContextVersion: true,
    selectorBindingHash: true
  });
export const repositorySharingRuleMemberRemovalResultSchema =
  repositorySharingRuleMemberContextResultSchema
    .extend({
      state: z.literal("removed"),
      shareGrantId: z.uuid().nullable()
    })
    .strict();
/** Cancels one exact ambiguous write, without changing other members or the
 * rule authority version. An already accepted write returns its receipt. */
export const repositorySharingRuleMutationCancellationSchema = z
  .object({
    mutationId: z.uuid(),
    kind: z.enum(["admit", "context", "remove"]),
    logicalMemoryId: z.uuid(),
    membershipId: z.uuid(),
    requestHash: hash
  })
  .strict();
const mutationSettlement =
  repositorySharingRuleMutationCancellationSchema.extend({ ruleId: z.uuid() });
export const repositorySharingRuleMutationSettlementSchema =
  z.discriminatedUnion("state", [
    mutationSettlement.extend({ state: z.literal("canceled") }).strict(),
    mutationSettlement
      .extend({
        state: z.literal("accepted"),
        receipt: z.union([
          repositorySharingRuleMemberAcceptanceSchema,
          repositorySharingRuleMemberContextResultSchema,
          repositorySharingRuleMemberRemovalResultSchema
        ])
      })
      .strict()
  ]);
export type RepositorySharingRuleMembersState = z.infer<
  typeof repositorySharingRuleMembersStateSchema
>;
export type RepositorySharingRuleMemberContext = z.infer<
  typeof repositorySharingRuleMemberContextSchema
>;
export type RepositorySharingRuleMemberContextResult = z.infer<
  typeof repositorySharingRuleMemberContextResultSchema
>;
export const sharingDestinationReviewSchema = z
  .object({
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    representation: z.enum(sharedMemoryFidelityCeilings),
    effectiveMaximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    effectiveIncludeCuratedMemory: z.boolean(),
    teamPolicyVersion: z.number().int().positive(),
    teamPolicyHash: hash,
    workspacePolicyVersion: z.number().int().positive(),
    workspacePolicyHash: hash
  })
  .strict();

export const gitAnchorSharingReviewInputSchema = z
  .object({
    target: sharingSelectionTargetSchema,
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    representation: z.enum(sharedMemoryFidelityCeilings),
    cursor: z.string().min(1).max(4096).nullable()
  })
  .strict();

export const repositorySharingRuleCreationReviewRequestSchema =
  gitAnchorSharingReviewInputSchema
    .omit({ cursor: true })
    .extend({ completionToken: z.string().min(1).max(4096) })
    .strict();
/** Encrypted local delivery retains the actual Personal selector for following
 * membership. Only the path-free Team intent crosses the Team boundary. */
export const repositorySharingRuleCreationLocalIntentSchema =
  repositorySharingRuleCreationIntentSchema
    .extend({ review: repositorySharingRuleCreationReviewRequestSchema })
    .strict();

export const gitAnchorSharingReviewPageSchema = z
  .object({
    target: gitAnchorSharingReviewInputSchema.shape.target,
    destination: sharingDestinationReviewSchema,
    snapshotVersion: z.uuid(),
    entries: z
      .array(
        personalSelectionConsumerPageSchema.shape.entries.element
          .extend({
            title: z.string().min(1).max(500),
            readiness: z.enum(["eligible", "unresolved"]),
            sourceRevision: z.number().int().nonnegative().nullable(),
            itemCount: z.number().int().nonnegative().nullable()
          })
          .strict()
      )
      .max(100),
    nextCursor: z.string().min(1).max(4096).nullable(),
    complete: z.boolean(),
    completionToken: z.string().min(1).max(4096).nullable(),
    includesFutureConversations: z.literal(true),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict()
  .superRefine((page, context) => {
    if (page.complete !== (page.nextCursor === null))
      context.addIssue({
        code: "custom",
        message: "A sharing review is complete only after its final page"
      });
    if (page.complete !== (page.completionToken !== null))
      context.addIssue({
        code: "custom",
        message:
          "Only a complete sharing review may carry its confirmation handoff"
      });
  });

export type GitAnchorSharingReviewInput = z.infer<
  typeof gitAnchorSharingReviewInputSchema
>;
export type GitAnchorSharingReviewPage = z.infer<
  typeof gitAnchorSharingReviewPageSchema
>;
export type SharingDestinationReview = z.infer<
  typeof sharingDestinationReviewSchema
>;

// The destination and both versions are part of the reviewed mutation intent.
export const repositorySharingRuleControlIntentSchema = z
  .object({
    selectorKind: z.literal("selection"),
    mutationId: z.uuid(),
    ruleId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    expectedAuthorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    controlAction: z.enum(["pause", "resume", "stop", "retry"])
  })
  .strict();
export const repositorySharingRuleControlResultSchema = z
  .object({
    selectorKind: z.literal("selection"),
    ruleId: z.uuid(),
    state: z.enum(["active", "paused", "stopped"]),
    authorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    catchUpState: z.enum(["idle", "queued"])
  })
  .strict();
export const repositorySharingRuleControlReviewSchema = z
  .object({
    ruleId: z.uuid(),
    team: z.object({ id: z.uuid(), name: z.string().min(1) }).strict(),
    workspace: z.object({ id: z.uuid(), name: z.string().min(1) }).strict(),
    selector: sharingSelectionSelectorSchema,
    state: z.enum(["active", "paused"]),
    maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    includeCuratedMemory: z.boolean(),
    authorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive()
  })
  .strict();
export type RepositorySharingRuleControlIntent = z.infer<
  typeof repositorySharingRuleControlIntentSchema
>;
export type RepositorySharingRuleControlResult = z.infer<
  typeof repositorySharingRuleControlResultSchema
>;
export type RepositorySharingRuleControlReview = z.infer<
  typeof repositorySharingRuleControlReviewSchema
>;
export const ownedRepositorySharingRulesInputSchema = z
  .object({
    selector: sharingSelectionSelectorSchema.optional(),
    afterRuleId: z.uuid().nullable(),
    limit: z.number().int().min(1).max(100)
  })
  .strict();
export const ownedRepositorySharingRuleSchema =
  repositorySharingRuleControlReviewSchema
    .omit({ state: true })
    .extend({
      state: z.enum(["active", "paused", "stopped"]),
      publisherAvailable: z.boolean(),
      publisher: sharingRulePublisherSchema.nullable().optional()
    })
    .strict();
export const ownedRepositorySharingRulesPageSchema = z
  .object({
    rules: z.array(ownedRepositorySharingRuleSchema).max(100),
    nextCursor: z.uuid().nullable()
  })
  .strict();
export type OwnedRepositorySharingRule = z.infer<
  typeof ownedRepositorySharingRuleSchema
>;
export type OwnedRepositorySharingRulesPage = z.infer<
  typeof ownedRepositorySharingRulesPageSchema
>;

export const conversationSharingRuleControlIntentSchema = z
  .object({
    mutationId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    shareGrantId: z.uuid(),
    ruleId: z.uuid(),
    reasonId: z.uuid(),
    expectedAuthorityVersion: z.number().int().safe().positive(),
    expectedGrantVersion: z.number().int().safe().positive(),
    controlAction: z.enum(["pause", "resume", "stop", "retry"])
  })
  .strict();

export const conversationSharingRuleControlResultSchema = z
  .object({
    ruleId: z.uuid(),
    reasonId: z.uuid(),
    shareGrantId: z.uuid(),
    state: z.enum(["active", "paused", "stopped"]),
    authorityVersion: z.number().int().safe().positive(),
    consentVersion: z.number().int().safe().positive(),
    grantVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    catchUpState: z.enum(["idle", "queued", "needs_attention"])
  })
  .strict();

export type ConversationSharingRuleControlIntent = z.infer<
  typeof conversationSharingRuleControlIntentSchema
>;

export const sharingRuleDeliveryPresentationSchema = z
  .object({
    sourceTitle: z.string().min(1).max(4096),
    teamName: z.string().min(1).max(4096),
    workspaceName: z.string().min(1).max(4096)
  })
  .strict();
export type ConversationSharingRuleControlResult = z.infer<
  typeof conversationSharingRuleControlResultSchema
>;

/** Exact fixed-snapshot authority selected for an explicit one-source conversion.
 * Destination identity and root version are bound by the enclosing rule review. */
export const snapshotConversionScopeSchema = z
  .object({
    reasonId: z.uuid(),
    consentId: z.uuid(),
    consentVersion: z.number().int().safe().positive(),
    sourceRevision: z.number().int().safe().positive(),
    maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    includeCuratedMemory: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true }).nullable()
  })
  .strict();
export type SnapshotConversionScope = z.infer<
  typeof snapshotConversionScopeSchema
>;

export const conversationSharingRuleCreationReviewInputSchema = z
  .object({
    snapshotReasonId: z.uuid().optional(),
    previewId: z.uuid(),
    previewHash: hash,
    previewRevision: z.number().int().safe().positive(),
    logicalMemoryId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid()
  })
  .strict();
export const conversationSharingRuleCreationReviewSchema =
  conversationSharingRuleCreationReviewInputSchema
    .extend({
      snapshotConversion: snapshotConversionScopeSchema.optional(),
      sourceIdentity: sharingRuleSourceIdentitySchema.optional(),
      source: z
        .object({
          kind: z.literal("captured_session"),
          sessionId: z.uuid(),
          logicalMemoryId: z.uuid()
        })
        .strict(),
      sourceTitle: z.string().min(1).max(4096),
      teamName: z.string().min(1).max(4096),
      workspaceName: z.string().min(1).max(4096),
      logicalGrantId: z.uuid(),
      expectedGrantVersion: z.number().int().safe().positive().nullable(),
      effectivePrivacyPolicyHash: hash,
      maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
      includeCuratedMemory: z.boolean(),
      activationRepresentation: z.enum([
        ...sharedMemoryFidelityCeilings,
        "curated_assertions"
      ]),
      sourceCapabilities: z
        .array(z.enum([...sharedMemoryFidelityCeilings, "curated_assertions"]))
        .min(1)
        .max(4),
      expiresAt: z.iso.datetime({ offset: true }).nullable(),
      reviewExpiresAt: z.iso.datetime({ offset: true })
    })
    .strict()
    .superRefine((review, context) => {
      if (
        (review.snapshotReasonId === undefined) !==
          (review.snapshotConversion === undefined) ||
        (review.snapshotConversion &&
          review.snapshotConversion.reasonId !== review.snapshotReasonId)
      )
        context.addIssue({
          code: "custom",
          message: "A conversion review must bind its selected snapshot reason"
        });
      if (review.source.logicalMemoryId !== review.logicalMemoryId)
        context.addIssue({
          code: "custom",
          message: "A rule review must name exactly one logical Conversation"
        });
    });
export type ConversationSharingRuleCreationReviewInput = z.infer<
  typeof conversationSharingRuleCreationReviewInputSchema
>;
export type ConversationSharingRuleCreationReview = z.infer<
  typeof conversationSharingRuleCreationReviewSchema
>;

export const conversationSharingRuleCreationIntentSchema =
  conversationSharingRuleCreationReviewInputSchema
    .omit({ snapshotReasonId: true })
    .extend({
      snapshotConversion: snapshotConversionScopeSchema.optional(),
      sourceIdentity: sharingRuleSourceIdentitySchema.optional(),
      mutationId: z.uuid(),
      ruleId: z.uuid(),
      logicalGrantId: z.uuid(),
      consentId: z.uuid(),
      expectedGrantVersion: z.number().int().safe().positive().nullable(),
      effectivePrivacyPolicyHash: hash,
      source: z
        .object({
          kind: z.literal("captured_session"),
          sessionId: z.uuid(),
          logicalMemoryId: z.uuid()
        })
        .strict(),
      sourceCapabilities: z
        .array(z.enum([...sharedMemoryFidelityCeilings, "curated_assertions"]))
        .min(1)
        .max(4),
      activationRepresentation: z.enum([
        ...sharedMemoryFidelityCeilings,
        "curated_assertions"
      ]),
      mode: z.literal("continuous"),
      maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
      includeCuratedMemory: z.boolean(),
      expiresAt: z.iso.datetime({ offset: true }).nullable()
    })
    .strict();
export type ConversationSharingRuleCreationIntent = z.infer<
  typeof conversationSharingRuleCreationIntentSchema
>;

export const sharingRulePublisherTakeoverReviewInputSchema = z
  .object({
    ruleId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    expectedAuthorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    sourceIdentity: sharingRuleSourceIdentitySchema
  })
  .strict();

export const sharingRulePublisherTakeoverReviewSchema =
  sharingRulePublisherTakeoverReviewInputSchema
    .extend({
      selectorKind: z.enum([
        "captured_session",
        "repository",
        "folder",
        "project"
      ]),
      state: z.enum(["active", "paused"]),
      maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
      includeCuratedMemory: z.boolean(),
      effectivePrivacyPolicyHash: hash,
      teamName: z.string().min(1).max(4096),
      workspaceName: z.string().min(1).max(4096),
      currentPublisher: sharingRulePublisherSchema,
      receivingPublisher: sharingRulePublisherSchema,
      logicalMemoryId: z.uuid(),
      membershipId: z.uuid(),
      shareGrantId: z.uuid(),
      membershipVersion: z.number().int().safe().positive(),
      selectionScope: repositorySharingRuleCreationIntentSchema.nullable(),
      expiresAt: z.iso.datetime({ offset: true })
    })
    .strict()
    .superRefine((review, context) => {
      const scope = review.selectionScope;
      if (
        !review.receivingPublisher.available ||
        review.currentPublisher.credentialId ===
          review.receivingPublisher.credentialId
      )
        context.addIssue({
          code: "custom",
          message:
            "Publisher takeover requires a different authorized receiving device"
        });
      if (
        (review.selectorKind === "captured_session") !== (scope === null) ||
        (scope &&
          (scope.ruleId !== review.ruleId ||
            scope.teamId !== review.teamId ||
            scope.teamWorkspaceId !== review.teamWorkspaceId ||
            scope.maximumFidelity !== review.maximumFidelity ||
            scope.includeCuratedMemory !== review.includeCuratedMemory ||
            scope.effectivePrivacyPolicyHash !==
              review.effectivePrivacyPolicyHash ||
            (scope.selector.kind === "folder" ||
            scope.selector.kind === "project"
              ? scope.selector.kind
              : "repository") !== review.selectorKind))
      )
        context.addIssue({
          code: "custom",
          message:
            "Publisher takeover must preserve the exact approved rule scope"
        });
    });

export const sharingRulePublisherTakeoverIntentSchema = z
  .object({
    mutationId: z.uuid(),
    review: sharingRulePublisherTakeoverReviewSchema
  })
  .strict();
export const sharingRulePublisherTakeoverResultSchema = z
  .object({
    mutationId: z.uuid(),
    ruleId: z.uuid(),
    state: z.enum(["active", "paused"]),
    authorityVersion: z.number().int().safe().positive(),
    publisherFence: z.number().int().safe().positive(),
    previousPublisherCredentialId: z.uuid(),
    publisherCredentialId: z.uuid(),
    catchUpState: z.enum(["idle", "queued"]),
    approvedAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type SharingRulePublisherTakeoverReviewInput = z.infer<
  typeof sharingRulePublisherTakeoverReviewInputSchema
>;
export type SharingRulePublisherTakeoverReview = z.infer<
  typeof sharingRulePublisherTakeoverReviewSchema
>;
export type SharingRulePublisherTakeoverIntent = z.infer<
  typeof sharingRulePublisherTakeoverIntentSchema
>;
export type SharingRulePublisherTakeoverResult = z.infer<
  typeof sharingRulePublisherTakeoverResultSchema
>;

/** Local source pointers and private selector references stay on the receiving
 * device. Only the nested backend review participates in the Team operation. */
const publisherTakeoverLocalReview = z
  .object({
    review: sharingRulePublisherTakeoverReviewSchema,
    localSource:
      personalSelectionConsumerPageSchema.shape.entries.element.shape.source,
    target: sharingSelectionTargetSchema.optional()
  })
  .strict();
const validatePublisherTakeoverLocalReview = (
  value: z.infer<typeof publisherTakeoverLocalReview>,
  context: z.RefinementCtx
) => {
  const portable = value.localSource.portable;
  if (
    !portable ||
    value.localSource.identityState !== "verified" ||
    crossIdentitySyncDigest(
      sharingRuleSourceIdentitySchema.strip().parse(portable)
    ) !== crossIdentitySyncDigest(value.review.sourceIdentity)
  )
    context.addIssue({
      code: "custom",
      message: "Publisher takeover requires the exact verified Personal source"
    });
  const scope = value.review.selectionScope;
  if (
    scope
      ? !value.target ||
        crossIdentitySyncDigest(sharingSelectionDescriptor(value.target)) !==
          crossIdentitySyncDigest(scope.selector)
      : value.target !== undefined
  )
    context.addIssue({
      code: "custom",
      message: "Publisher takeover requires its unchanged selector scope"
    });
  const targetOwner =
    value.target?.kind === "project"
      ? value.target.project.ownerUserId
      : value.target?.kind === "folder"
        ? value.target.folder.ownerUserId
        : portable?.ownerUserId;
  if (targetOwner !== portable?.ownerUserId)
    context.addIssue({
      code: "custom",
      message:
        "The receiving source and selection must belong to the same local owner"
    });
};
export const sharingRulePublisherTakeoverLocalReviewSchema =
  publisherTakeoverLocalReview.superRefine(
    validatePublisherTakeoverLocalReview
  );
export const sharingRulePublisherTakeoverLocalIntentSchema =
  publisherTakeoverLocalReview
    .extend({
      operationKind: z.literal("publisher_takeover"),
      mutationId: z.uuid(),
      ruleId: z.uuid(),
      teamId: z.uuid(),
      teamWorkspaceId: z.uuid()
    })
    .superRefine((value, context) => {
      validatePublisherTakeoverLocalReview(value, context);
      if (
        value.ruleId !== value.review.ruleId ||
        value.teamId !== value.review.teamId ||
        value.teamWorkspaceId !== value.review.teamWorkspaceId
      )
        context.addIssue({
          code: "custom",
          message:
            "Publisher takeover must preserve its reviewed rule and destination"
        });
    });
export const sharingRulePublisherTakeoverAppliedScopeSchema = z
  .object({
    review: sharingRulePublisherTakeoverReviewSchema,
    result: sharingRulePublisherTakeoverResultSchema
  })
  .strict()
  .superRefine(({ review, result }, context) => {
    if (
      result.ruleId !== review.ruleId ||
      result.previousPublisherCredentialId !==
        review.currentPublisher.credentialId ||
      result.publisherCredentialId !== review.receivingPublisher.credentialId ||
      result.authorityVersion !== review.expectedAuthorityVersion + 1 ||
      result.publisherFence !== review.publisherFence + 1 ||
      result.state !== review.state ||
      result.catchUpState !== (review.state === "active" ? "queued" : "idle")
    )
      context.addIssue({
        code: "custom",
        message:
          "Publisher takeover requires the exact accepted publisher transition"
      });
  });
export type SharingRulePublisherTakeoverLocalReview = z.infer<
  typeof sharingRulePublisherTakeoverLocalReviewSchema
>;
export type SharingRulePublisherTakeoverLocalIntent = z.infer<
  typeof sharingRulePublisherTakeoverLocalIntentSchema
>;
export type SharingRulePublisherTakeoverAppliedScope = z.infer<
  typeof sharingRulePublisherTakeoverAppliedScopeSchema
>;

export const conversationSharingRuleCreationResultSchema = z
  .object({
    pendingShareId: z.uuid(),
    sourceRevision: z.number().int().safe().nonnegative()
  })
  .strict();
export type ConversationSharingRuleCreationResult = z.infer<
  typeof conversationSharingRuleCreationResultSchema
>;
export const sharingRuleDetailLocalIntentSchema = sharingRuleDetailIntentSchema
  .extend({
    operationKind: z.literal("detail"),
    ruleId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid()
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.ruleId !== intent.review.ruleId ||
      intent.teamId !== intent.review.teamId ||
      intent.teamWorkspaceId !== intent.review.teamWorkspaceId
    )
      context.addIssue({
        code: "custom",
        message:
          "The detail delivery must match its reviewed rule and destination"
      });
  });
export const sharingRuleContentPolicyLocalIntentSchema =
  sharingRuleContentPolicyIntentSchema
    .extend({
      operationKind: z.literal("content_policy"),
      ruleId: z.uuid(),
      teamId: z.uuid(),
      teamWorkspaceId: z.uuid()
    })
    .strict()
    .superRefine((intent, context) => {
      if (
        intent.ruleId !== intent.review.ruleId ||
        intent.teamId !== intent.review.teamId ||
        intent.teamWorkspaceId !== intent.review.teamWorkspaceId
      )
        context.addIssue({
          code: "custom",
          message:
            "The content-policy delivery must match its reviewed rule and destination"
        });
    });
export const sharingRuleMutationIntentSchema = z.union([
  sharingRulePublisherTakeoverLocalIntentSchema,
  workspaceConversationRestorationIntentSchema,
  workspaceConversationExclusionIntentSchema,
  sharingRuleDetailLocalIntentSchema,
  sharingRuleContentPolicyLocalIntentSchema,
  repositorySharingRuleControlIntentSchema,
  conversationSharingRuleControlIntentSchema,
  conversationSharingRuleCreationIntentSchema,
  repositorySharingRuleCreationLocalIntentSchema
]);
export type SharingRuleMutationIntent = z.infer<
  typeof sharingRuleMutationIntentSchema
>;
export const sharingRuleDeliverySchema = z
  .object({
    intent: sharingRuleMutationIntentSchema,
    presentation: sharingRuleDeliveryPresentationSchema,
    state: z.enum(["queued", "acknowledged", "needs_review"]),
    control: z
      .union([
        conversationSharingRuleControlResultSchema,
        repositorySharingRuleControlResultSchema
      ])
      .nullable(),
    creation: z
      .union([
        conversationSharingRuleCreationResultSchema,
        repositorySharingRuleCreationResultSchema
      ])
      .nullable(),
    publisherTakeover:
      sharingRulePublisherTakeoverAppliedScopeSchema.optional(),
    detailAmendment: sharingRuleDetailAppliedScopeSchema.optional(),
    contentPolicyAmendment:
      sharingRuleContentPolicyAppliedScopeSchema.optional(),
    exclusion: workspaceConversationExclusionSchema.optional(),
    failureCode: z
      .enum([
        "offline",
        "remote_unavailable",
        "source_unavailable",
        "authority_unavailable",
        "conflict",
        "response_invalid"
      ])
      .nullable(),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict()
  .superRefine((delivery, context) => {
    const acknowledged = delivery.state === "acknowledged";
    const transferring =
      "operationKind" in delivery.intent &&
      delivery.intent.operationKind === "publisher_takeover";
    if (!transferring && delivery.publisherTakeover !== undefined)
      context.addIssue({
        code: "custom",
        message:
          "Only a publisher takeover delivery may contain a transfer receipt"
      });
    if ("scope" in delivery.intent) {
      const result = delivery.exclusion;
      if (
        acknowledged !== (result !== undefined) ||
        delivery.control !== null ||
        delivery.creation !== null ||
        delivery.detailAmendment !== undefined ||
        delivery.contentPolicyAmendment !== undefined ||
        (result &&
          (result.ownerUserId !== delivery.intent.scope.ownerUserId ||
            result.logicalMemoryId !== delivery.intent.scope.logicalMemoryId ||
            result.teamId !== delivery.intent.scope.teamId ||
            result.teamWorkspaceId !== delivery.intent.scope.teamWorkspaceId ||
            result.state !==
              ("restoration" in delivery.intent ? "restored" : "excluded") ||
            result.version !==
              delivery.intent.scope.expectedExclusionVersion + 1))
      )
        context.addIssue({
          code: "custom",
          message:
            "An exclusion delivery requires its exact Workspace acknowledgment"
        });
      return;
    }
    if (delivery.exclusion !== undefined)
      context.addIssue({
        code: "custom",
        path: ["exclusion"],
        message:
          "Only an exclusion delivery may contain an exclusion acknowledgment"
      });
    if (
      "operationKind" in delivery.intent &&
      delivery.intent.operationKind === "publisher_takeover"
    ) {
      const scope = delivery.publisherTakeover;
      if (
        delivery.control !== null ||
        delivery.creation !== null ||
        delivery.detailAmendment !== undefined ||
        delivery.contentPolicyAmendment !== undefined ||
        acknowledged !== (scope !== undefined) ||
        (scope &&
          (scope.result.mutationId !== delivery.intent.mutationId ||
            crossIdentitySyncDigest(scope.review) !==
              crossIdentitySyncDigest(delivery.intent.review)))
      )
        context.addIssue({
          code: "custom",
          message:
            "Publisher takeover delivery requires its exact accepted review and receipt"
        });
    } else if ("operationKind" in delivery.intent) {
      const scope =
        delivery.intent.operationKind === "detail"
          ? delivery.detailAmendment
          : delivery.contentPolicyAmendment;
      const otherScope =
        delivery.intent.operationKind === "detail"
          ? delivery.contentPolicyAmendment
          : delivery.detailAmendment;
      if (
        delivery.control !== null ||
        delivery.creation !== null ||
        otherScope !== undefined ||
        acknowledged !== (scope !== undefined) ||
        (scope &&
          (scope.result.mutationId !== delivery.intent.mutationId ||
            crossIdentitySyncDigest(scope.review) !==
              crossIdentitySyncDigest(delivery.intent.review)))
      )
        context.addIssue({
          code: "custom",
          message:
            "An amendment delivery requires its exact accepted review and receipt"
        });
    } else if ("controlAction" in delivery.intent) {
      if (
        delivery.creation !== null ||
        acknowledged !== (delivery.control !== null)
      )
        context.addIssue({
          code: "custom",
          message: "A control delivery requires only its Team control receipt"
        });
      const result = delivery.control;
      const intent = delivery.intent;
      if ("selectorKind" in intent) {
        if (
          result &&
          (!("selectorKind" in result) ||
            result.ruleId !== intent.ruleId ||
            result.authorityVersion !== intent.expectedAuthorityVersion + 1 ||
            result.publisherFence !==
              intent.publisherFence +
                (intent.controlAction === "stop" ? 1 : 0) ||
            result.state !==
              (intent.controlAction === "pause"
                ? "paused"
                : intent.controlAction === "stop"
                  ? "stopped"
                  : "active"))
        )
          context.addIssue({
            code: "custom",
            message:
              "The group control receipt must match the exact reviewed rule and versions"
          });
      } else if (
        result &&
        ("selectorKind" in result ||
          result.ruleId !== intent.ruleId ||
          result.reasonId !== intent.reasonId ||
          result.shareGrantId !== intent.shareGrantId ||
          result.authorityVersion <= intent.expectedAuthorityVersion ||
          result.grantVersion <= intent.expectedGrantVersion ||
          result.state !==
            (intent.controlAction === "pause"
              ? "paused"
              : intent.controlAction === "stop"
                ? "stopped"
                : "active"))
      )
        context.addIssue({
          code: "custom",
          message:
            "The receipt must match the exact control intent and advance its versions"
        });
    } else if (
      delivery.control !== null ||
      acknowledged !== (delivery.creation !== null)
    )
      context.addIssue({
        code: "custom",
        message: "A creation delivery requires only its Team acceptance receipt"
      });
    if (
      !("operationKind" in delivery.intent) &&
      (delivery.detailAmendment || delivery.contentPolicyAmendment)
    )
      context.addIssue({
        code: "custom",
        message: "Only an amendment delivery may contain an amendment receipt"
      });
    if (
      "includesFutureConversations" in delivery.intent &&
      delivery.creation &&
      (!("ruleId" in delivery.creation) ||
        delivery.creation.ruleId !== delivery.intent.ruleId)
    )
      context.addIssue({
        code: "custom",
        message:
          "The rule creation receipt must match its exact Git Anchor rule"
      });
    if (
      "source" in delivery.intent &&
      delivery.creation &&
      (!("pendingShareId" in delivery.creation) ||
        delivery.creation.pendingShareId !==
          crossIdentitySyncDeterministicUuid({
            kind: "pending_share",
            mutationId: delivery.intent.mutationId
          }))
    )
      context.addIssue({
        code: "custom",
        message:
          "The creation receipt must match its exact Pending Share mutation"
      });
  });
export type SharingRuleDelivery = z.infer<typeof sharingRuleDeliverySchema>;
