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
import {
  personalNamedProjectSchema,
  personalProjectMembershipExplanationSchema
} from "./personal-project-contract.js";

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

/** A reviewed organization edit changes membership and both source axes together.
 * Source corrections require the complete active Project catalog so a new or
 * changed source rule cannot silently change the impact the User reviewed. */
export const personalConversationOrganizationInputSchema = z
  .object({
    expectedContext: personalSourceContextStateSchema,
    reviewedProjects: z
      .array(
        z
          .object({
            projectId: z.uuid(),
            expectedVersion
          })
          .strict()
      )
      .max(5000),
    memberships: z
      .array(
        z
          .object({
            projectId: z.uuid(),
            direct: z.boolean(),
            excluded: z.boolean(),
            restoreExclusion: z
              .object({
                exclusionId: z.uuid(),
                expectedExclusionRevisionId: z.uuid()
              })
              .strict()
              .optional()
          })
          .strict()
      )
      .max(100),
    corrections: z.array(personalSourceCorrectionInputSchema).max(2)
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = input.reviewedProjects.map((p) => p.projectId);
    if (
      new Set(ids).size !== ids.length ||
      new Set(input.memberships.map((p) => p.projectId)).size !==
        input.memberships.length ||
      new Set(input.corrections.map((c) => c.axis)).size !==
        input.corrections.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each Project and source axis must appear once"
      });
    if (input.memberships.some((p) => !ids.includes(p.projectId)))
      ctx.addIssue({
        code: "custom",
        message: "Every membership change requires a reviewed Project"
      });
    if (
      input.corrections.some(
        (c) => c.expectedVersion !== input.expectedContext[c.axis].revision
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Corrections must bind the reviewed source versions"
      });
    if (!input.memberships.length && !input.corrections.length)
      ctx.addIssue({
        code: "custom",
        message: "At least one organization change is required"
      });
  });
export const personalConversationOrganizationSnapshotSchema = z
  .object({
    context: personalSourceContextStateSchema,
    projects: z
      .array(
        z
          .object({
            project: personalNamedProjectSchema,
            explanation: personalProjectMembershipExplanationSchema
          })
          .strict()
      )
      .max(5000)
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      new Set(snapshot.projects.map((p) => p.project.projectId)).size !==
        snapshot.projects.length ||
      snapshot.projects.some(
        ({ project, explanation }) =>
          explanation.sessionId !== snapshot.context.sessionId ||
          explanation.logicalSessionId !== snapshot.context.logicalSessionId ||
          (explanation.exclusion &&
            explanation.exclusion.projectId !== project.projectId)
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Organization snapshot must bind one Conversation and unique Projects"
      });
  });
export const personalConversationOrganizationResultSchema = z
  .object({
    before: personalConversationOrganizationSnapshotSchema,
    after: personalConversationOrganizationSnapshotSchema
  })
  .strict()
  .superRefine(({ before, after }, ctx) => {
    if (
      before.context.sessionId !== after.context.sessionId ||
      before.context.logicalSessionId !== after.context.logicalSessionId ||
      before.projects.length !== after.projects.length ||
      before.projects.some(
        (p) =>
          !after.projects.some(
            (next) =>
              next.project.projectId === p.project.projectId &&
              next.project.version >= p.project.version
          )
      ) ||
      (["git", "folder"] as const).some(
        (axis) =>
          JSON.stringify(before.context[axis].original) !==
          JSON.stringify(after.context[axis].original)
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Organization result must retain the reviewed Conversation, Projects and original source evidence"
      });
  });
export type PersonalConversationOrganizationInput = z.infer<
  typeof personalConversationOrganizationInputSchema
>;
export type PersonalConversationOrganizationSnapshot = z.infer<
  typeof personalConversationOrganizationSnapshotSchema
>;
export type PersonalConversationOrganizationResult = z.infer<
  typeof personalConversationOrganizationResultSchema
>;

export const personalSourceContextCommandSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("get"), sessionId: z.uuid() }).strict(),
    z
      .object({
        action: z.literal("organize"),
        sessionId: z.uuid(),
        edit: personalConversationOrganizationInputSchema
      })
      .strict(),
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
  ])
  .refine(
    (input) =>
      input.action !== "organize" ||
      input.sessionId === input.edit.expectedContext.sessionId,
    {
      message: "Organization edit must bind the requested Conversation"
    }
  );
export type PersonalSourceContextCommandResult = {
  context: PersonalSourceContextState;
  preview?: PersonalSourceCorrectionPreview;
  organization?: PersonalConversationOrganizationResult;
};
export const personalSourceContextCommandResultSchema: z.ZodType<PersonalSourceContextCommandResult> =
  z
    .object({
      context: personalSourceContextStateSchema,
      preview: personalSourceCorrectionPreviewSchema.optional(),
      organization: personalConversationOrganizationResultSchema.optional()
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
