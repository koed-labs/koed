import { z } from "zod";
import {
  personalSourceReferenceSchema,
  personalGitContextSchema,
  personalFolderReferenceSchema,
  personalFolderContextSchema,
  personalFolderScopeId
} from "./personal-source-contract.js";
import {
  personalMembershipReasonSchema,
  personalMembershipExclusionSyncSchema
} from "./personal-membership-contract.js";

export const personalNamedProjectSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(160),
    version: z.number().int().positive().safe(),
    headRevisionId: z.uuid(),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const personalDirectMembershipSchema = z
  .object({
    inclusionId: z.uuid(),
    projectId: z.uuid(),
    logicalSessionId: z.uuid(),
    sourceReference: personalSourceReferenceSchema.nullable(),
    version: z.number().int().positive().safe(),
    headRevisionId: z.uuid(),
    removedAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict();

export const personalProjectExclusionSchema = z
  .object({
    exclusionId: z.uuid(),
    projectId: z.uuid(),
    logicalSessionId: z.uuid(),
    sourceReference: personalSourceReferenceSchema.nullable(),
    version: z.number().int().positive().safe(),
    headRevisionId: z.uuid(),
    clearedAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict();
export type PersonalProjectExclusion = z.infer<
  typeof personalProjectExclusionSchema
>;
export const personalProjectMembershipExplanationSchema = z
  .object({
    sessionId: z.uuid(),
    logicalSessionId: z.uuid(),
    reasons: z.array(personalMembershipReasonSchema),
    exclusion: personalProjectExclusionSchema.nullable(),
    syncExclusion: personalMembershipExclusionSyncSchema.optional(),
    included: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.included !==
      (value.reasons.length > 0 &&
        (!value.exclusion || value.exclusion.clearedAt !== null) &&
        !value.syncExclusion?.blocked)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Membership status must reflect the current reasons and exclusion"
      });
    if (
      value.exclusion &&
      value.exclusion.logicalSessionId !== value.logicalSessionId
    )
      ctx.addIssue({
        code: "custom",
        message: "Exclusion belongs to another Conversation"
      });
  });
export type PersonalProjectMembershipExplanation = z.infer<
  typeof personalProjectMembershipExplanationSchema
>;

export const personalProjectCreateSchema = z
  .object({ name: z.string().trim().min(1).max(160) })
  .strict();
export const personalProjectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    expectedVersion: z.number().int().positive().safe()
  })
  .strict();
export const personalProjectVersionSchema = z
  .object({ expectedVersion: z.number().int().positive().safe() })
  .strict();
export const personalProjectAddSessionSchema = personalProjectVersionSchema
  .extend({ sessionId: z.uuid() })
  .strict();
export const personalProjectAddBackSchema = personalProjectAddSessionSchema
  .extend({
    exclusionId: z.uuid(),
    expectedExclusionRevisionId: z.uuid()
  })
  .strict();

export const personalProjectRuleTargetSchema = z.discriminatedUnion("kind", [
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
    .strict()
]);
export const personalProjectRuleSchema = z
  .object({
    inclusionId: z.uuid(),
    projectId: z.uuid(),
    target: personalProjectRuleTargetSchema,
    folderContext: personalFolderContextSchema.optional(),
    version: z.number().int().positive().safe(),
    headRevisionId: z.uuid(),
    removedAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (
      rule.folderContext &&
      (rule.target.kind !== "folder" ||
        personalFolderScopeId(rule.folderContext.reference) !==
          personalFolderScopeId(rule.target.folder))
    )
      ctx.addIssue({
        code: "custom",
        message: "Folder display context must describe the selected Folder"
      });
  });
export const personalProjectRepositoryRuleInputSchema =
  personalProjectVersionSchema
    .extend({
      repository: personalGitContextSchema
    })
    .strict();
export const personalProjectRulePreviewSchema = z
  .object({
    target: personalProjectRuleTargetSchema,
    folderContext: personalFolderContextSchema.optional(),
    conversations: z
      .array(
        z
          .object({
            logicalSessionId: z.uuid(),
            sessionId: z.uuid(),
            name: z.string().min(1).max(160)
          })
          .strict()
      )
      .max(5000)
  })
  .strict();
export type PersonalProjectRule = z.infer<typeof personalProjectRuleSchema>;
export const personalProjectFolderRuleInputSchema = personalProjectVersionSchema
  .extend({ folder: personalFolderReferenceSchema })
  .strict();
export const personalProjectRuleInputSchema = z.union([
  personalProjectRepositoryRuleInputSchema,
  personalProjectFolderRuleInputSchema
]);

export type PersonalNamedProject = z.infer<typeof personalNamedProjectSchema>;
export type PersonalDirectMembership = z.infer<
  typeof personalDirectMembershipSchema
>;

const projectCommandBase = {
  projectId: z.uuid(),
  expectedVersion: z.number().int().positive().safe()
};
export const personalProjectCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...projectCommandBase,
      action: z.literal("explain_session"),
      sessionId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("exclude_session"),
      sessionId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("add_back"),
      sessionId: z.uuid(),
      exclusionId: z.uuid(),
      expectedExclusionRevisionId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("preview_folder"),
      folder: personalFolderReferenceSchema
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("add_folder"),
      folder: personalFolderReferenceSchema
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("preview_repository"),
      repository: personalGitContextSchema
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("add_repository"),
      repository: personalGitContextSchema
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("remove_rule"),
      inclusionId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("rename"),
      name: z.string().trim().min(1).max(160)
    })
    .strict(),
  z.object({ ...projectCommandBase, action: z.literal("delete") }).strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("add_session"),
      sessionId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...projectCommandBase,
      action: z.literal("remove_inclusion"),
      inclusionId: z.uuid()
    })
    .strict()
]);
export const personalProjectCommandResultSchema = z
  .object({
    project: personalNamedProjectSchema,
    membership: personalDirectMembershipSchema.optional(),
    rule: personalProjectRuleSchema.optional(),
    preview: personalProjectRulePreviewSchema.optional(),
    explanation: personalProjectMembershipExplanationSchema.optional()
  })
  .strict();
export type PersonalProjectCommand = z.infer<
  typeof personalProjectCommandSchema
>;
