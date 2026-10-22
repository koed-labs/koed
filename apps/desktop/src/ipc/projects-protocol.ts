import {
  createProjectSchema,
  projectDeletePreviewSchema,
  projectDeleteSchema,
  projectDeleteStatusSchema,
  projectHqSchema,
  projectRestoreSchema,
  projectSchema
} from "@koed/shared/project-contract";
import {
  createProjectSourceSchema,
  projectSourceUploadSchema,
  projectSourceReadSchema,
  projectSourceRemovalStatusSchema,
  projectSourceSchema,
  projectSourcesSchema
} from "@koed/shared/project-source-contract";
import { z } from "zod";
import {
  projectActivityPageSchema,
  projectSeenSchema
} from "@koed/shared/project-activity-contract";
import {
  workspaceProjectShareContextSchema,
  workspaceProjectPendingShareSchema,
  workspaceProjectMembersSchema,
  type WorkspaceProjectShareContext,
  workspaceProjectStateSchema,
  workspaceProjectCreateSchema,
  workspaceProjectRecordSchema,
  workspaceProjectSourceSchema,
  workspaceProjectSourceMetadataPatchSchema,
  workspaceProjectHumanWorkItemCreateSchema,
  workspaceProjectHumanWorkItemPatchSchema,
  workspaceProjectWorkItemSchema
} from "@koed/shared/workspace-project-contract";
import {
  createWorkItemSchema,
  patchWorkItemSchema,
  workItemSchema
} from "@koed/shared/work-item-contract";

export const projectsCommandChannel = "koed:projects:command";
export type { WorkspaceProjectShareContext } from "@koed/shared/workspace-project-contract";

/** The full policy receipt stays in main. Renderer status contains review copy
 * only; captured Session IDs and Team authority IDs never cross this IPC. */
export const projectPolicyRendererStatusSchema = z
  .object({
    status: z.enum(["absent", "active", "revoked"]),
    pendingAction: z.enum(["enable", "revoke"]).nullable(),
    reviewRequired: z.boolean(),
    eligibleCount: z.number().int().nonnegative().max(100),
    reviewSources: z
      .array(
        z
          .object({
            reviewLabel: z.string().min(1).max(160),
            eligible: z.boolean()
          })
          .strict()
      )
      .max(100)
  })
  .strict();

const projectPolicyInitialStageSchema = z
  .object({
    stagedCount: z.number().int().nonnegative().max(100),
    skippedCount: z.number().int().nonnegative().max(100),
    pendingCount: z.number().int().nonnegative().max(100),
    needsReviewCount: z.number().int().nonnegative().max(100),
    items: z
      .array(
        z
          .object({
            label: z.string().min(1).max(160),
            state: z.enum(["pending", "skipped", "needs_review"]),
            reason: z
              .enum([
                "occupied",
                "already_issued",
                "ineligible",
                "source_changed",
                "result_unknown"
              ])
              .optional()
          })
          .strict()
      )
      .max(100)
  })
  .strict()
  .superRefine((summary, context) => {
    const staged = summary.items.filter(
      (item) => item.state === "pending" && !item.reason
    ).length;
    const pending = summary.items.filter(
      (item) => item.state === "pending"
    ).length;
    const skipped = summary.items.filter(
      (item) => item.state === "skipped"
    ).length;
    const needsReview = summary.items.filter(
      (item) => item.state === "needs_review"
    ).length;
    if (
      summary.stagedCount !== staged ||
      summary.pendingCount !== pending ||
      summary.skippedCount !== skipped ||
      summary.needsReviewCount !== needsReview ||
      summary.items.some(
        (item) =>
          (item.state === "pending" &&
            item.reason !== undefined &&
            item.reason !== "result_unknown") ||
          (item.state === "skipped" &&
            item.reason !== "occupied" &&
            item.reason !== "already_issued" &&
            item.reason !== "ineligible") ||
          (item.state === "needs_review" && item.reason !== "source_changed")
      )
    )
      context.addIssue({
        code: "custom",
        message: "Invalid Project policy stage summary"
      });
  });

export const projectsRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("sharedPolicyStatus"),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPolicyEnable"),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPolicyRevoke"),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPolicyStageInitial"),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedChatMakePrivate"),
      personalProjectId: z.uuid(),
      sessionId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedChatStatus"),
      personalProjectId: z.uuid(),
      sessionId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedChatOffer"),
      personalProjectId: z.uuid(),
      sessionId: z.uuid(),
      reason: z.enum(["moved_in", "share_again"])
    })
    .strict(),
  z.object({ operation: z.literal("sharedShareContext") }).strict(),
  z
    .object({
      operation: z.literal("sharedPendingShare"),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedCancelPendingShare"),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedMembers"),
      workspaceProjectId: z.uuid(),
      teamBackendId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedFirstShare"),
      personalProjectId: z.uuid(),
      teamBackendId: z.string().min(1),
      value: workspaceProjectCreateSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedJoinProject"),
      workspaceProjectId: z.uuid(),
      teamBackendId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedTeamLeaveStage"),
      teamBackendId: z.string().min(1),
      teamId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedTeamLeaveFinish"),
      teamBackendId: z.string().min(1),
      stageIds: z.array(z.uuid()).max(100)
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedAttachSource"),
      teamBackendId: z.string().min(1),
      workspaceProjectId: z.uuid(),
      personalProjectId: z.uuid(),
      sourceId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPatchSource"),
      teamBackendId: z.string().min(1),
      workspaceProjectId: z.uuid(),
      sourceId: z.uuid(),
      value: workspaceProjectSourceMetadataPatchSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedUploadSource"),
      teamBackendId: z.string().min(1),
      workspaceProjectId: z.uuid(),
      personalProjectId: z.uuid(),
      upload: projectSourceUploadSchema,
      expectedProfileKey: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedSourcePick"),
      teamBackendId: z.string().min(1),
      workspaceProjectId: z.uuid(),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedReadSource"),
      teamBackendId: z.string().min(1),
      workspaceProjectId: z.uuid(),
      personalProjectId: z.uuid(),
      sourceId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedDispatchWorkItem"),
      personalProjectId: z.uuid(),
      itemId: z.uuid(),
      agentId: z.uuid(),
      expectedProjectVersion: z.number().int().positive(),
      expectedMemberVersion: z.number().int().positive(),
      expectedWorkItemVersion: z.number().int().positive(),
      textActionId: z.uuid().optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedDispatches"),
      personalProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedRefresh"),
      workspaceProjectId: z.uuid(),
      teamBackendId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedCreateWorkItem"),
      workspaceProjectId: z.uuid(),
      teamBackendId: z.string().min(1),
      value: workspaceProjectHumanWorkItemCreateSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPatchWorkItem"),
      workspaceProjectId: z.uuid(),
      teamBackendId: z.string().min(1),
      itemId: z.uuid(),
      value: workspaceProjectHumanWorkItemPatchSchema
    })
    .strict(),
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("pickFolder") }).strict(),
  z.object({ operation: z.literal("hq"), projectId: z.uuid() }).strict(),
  z
    .object({ operation: z.literal("activitySeen"), projectId: z.uuid() })
    .strict(),
  z
    .object({
      operation: z.literal("activityPage"),
      projectId: z.uuid(),
      after: z.string().min(1).max(500).optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal("activityAcknowledge"),
      projectId: z.uuid(),
      cursor: z.string().min(1).max(500)
    })
    .strict(),
  z
    .object({ operation: z.literal("workItemList"), projectId: z.uuid() })
    .strict(),
  z
    .object({
      operation: z.literal("workItemReconcile"),
      projectId: z.uuid(),
      itemId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("workItemCreate"),
      projectId: z.uuid(),
      value: createWorkItemSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("workItemPatch"),
      projectId: z.uuid(),
      itemId: z.uuid(),
      value: patchWorkItemSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("workItemDispatch"),
      projectId: z.uuid(),
      itemId: z.uuid(),
      agentId: z.uuid(),
      version: z.number().int().positive(),
      replace: z.boolean().optional(),
      textActionId: z.uuid().optional()
    })
    .strict(),
  z
    .object({ operation: z.literal("sourceList"), projectId: z.uuid() })
    .strict(),
  z
    .object({ operation: z.literal("sourceUpload"), projectId: z.uuid() })
    .strict(),
  z
    .object({
      operation: z.literal("sourceRead"),
      projectId: z.uuid(),
      sourceId: z.uuid(),
      noteRevisionId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceRemoval"),
      projectId: z.uuid(),
      sourceId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceReview"),
      projectId: z.uuid(),
      sourceId: z.uuid(),
      batchId: z.uuid(),
      actionGrantId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceDiscoverRepos"),
      projectId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceCreate"),
      projectId: z.uuid(),
      value: createProjectSourceSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceRemove"),
      projectId: z.uuid(),
      sourceId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceRetry"),
      projectId: z.uuid(),
      sourceId: z.uuid()
    })
    .strict(),
  z
    .object({ operation: z.literal("create"), value: createProjectSchema })
    .strict(),
  z
    .object({ operation: z.literal("deletePreview"), projectId: z.uuid() })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      projectId: z.uuid(),
      value: projectDeleteSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("deleteProgress"),
      projectId: z.uuid(),
      batchId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("deleteStatus"),
      projectId: z.uuid(),
      batchId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("deleteCancel"),
      projectId: z.uuid(),
      batchId: z.uuid()
    })
    .strict(),
  z
    .object({
      operation: z.literal("restore"),
      projectId: z.uuid(),
      value: projectRestoreSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("restoreReconcile"),
      projectId: z.uuid(),
      batchId: z.uuid()
    })
    .strict()
]);

export const projectsResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("sharedPolicyStatus"),
      policy: projectPolicyRendererStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPolicyEnable"),
      policy: projectPolicyRendererStatusSchema,
      initialStage: projectPolicyInitialStageSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPolicyRevoke"),
      policy: projectPolicyRendererStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPolicyStageInitial"),
      policy: projectPolicyRendererStatusSchema,
      initialStage: projectPolicyInitialStageSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedChatMakePrivate"),
      state: z.literal("private")
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedChatStatus"),
      state: z.enum(["private", "pending", "shared", "unshared", "ineligible"])
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedChatOffer"),
      state: z.enum(["pending", "activated", "canceled"])
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedShareContext"),
      context: workspaceProjectShareContextSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPendingShare"),
      attempt: workspaceProjectPendingShareSchema.nullable()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedCancelPendingShare"),
      canceled: z.literal(true)
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedMembers"),
      members: workspaceProjectMembersSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedFirstShare"),
      project: workspaceProjectRecordSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedJoinProject"),
      project: projectSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedTeamLeaveStage"),
      review: z
        .object({
          teamId: z.uuid(),
          expectedTeamVersion: z.number().int().positive(),
          expectedMembershipVersion: z.number().int().positive(),
          expectedOwnedWorkspaceProjects: z.array(
            z
              .object({ id: z.uuid(), version: z.number().int().positive() })
              .strict()
          ),
          ownedSetHash: z.string().regex(/^[a-f0-9]{64}$/),
          copyManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
          pendingLeaveOperationId: z.uuid().nullable().optional(),
          stages: z.array(
            z
              .object({
                workspaceProjectId: z.uuid(),
                payloadHash: z.string().regex(/^[a-f0-9]{64}$/)
              })
              .strict()
          )
        })
        .strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedTeamLeaveFinish"),
      completed: z.array(
        z
          .object({
            stageId: z.uuid(),
            projectId: z.uuid().optional(),
            copied: z.number().int().nonnegative().optional(),
            alreadyApplied: z.boolean().optional()
          })
          .strict()
      )
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedAttachSource"),
      source: workspaceProjectSourceSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPatchSource"),
      source: workspaceProjectSourceSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedUploadSource"),
      source: workspaceProjectSourceSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedSourcePick"),
      value: z.discriminatedUnion("canceled", [
        z.object({ canceled: z.literal(true), source: z.null() }).strict(),
        z
          .object({
            canceled: z.literal(false),
            source: workspaceProjectSourceSchema
          })
          .strict()
      ])
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedReadSource"),
      content: projectSourceReadSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedDispatchWorkItem"),
      executionId: z.uuid(),
      reused: z.boolean(),
      dispatchKey: z.string().min(1),
      progress: z
        .object({ state: z.literal("dispatching"), stepLabel: z.string() })
        .strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedDispatches"),
      items: z
        .array(
          z
            .object({
              teamWorkItemId: z.uuid(),
              executionId: z.uuid(),
              agentId: z.uuid()
            })
            .strict()
        )
        .max(500)
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedRefresh"),
      state: workspaceProjectStateSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedCreateWorkItem"),
      outcome: z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("ok"),
            item: workspaceProjectWorkItemSchema
          })
          .strict(),
        z
          .object({
            status: z.literal("conflict"),
            state: workspaceProjectStateSchema
          })
          .strict()
      ])
    })
    .strict(),
  z
    .object({
      operation: z.literal("sharedPatchWorkItem"),
      outcome: z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("ok"),
            item: workspaceProjectWorkItemSchema
          })
          .strict(),
        z
          .object({
            status: z.literal("conflict"),
            state: workspaceProjectStateSchema
          })
          .strict()
      ])
    })
    .strict(),
  z
    .object({ operation: z.literal("list"), projects: z.array(projectSchema) })
    .strict(),
  z
    .object({
      operation: z.literal("pickFolder"),
      path: z.string().trim().min(1).max(2_048).nullable()
    })
    .strict(),
  z.object({ operation: z.literal("hq"), value: projectHqSchema }).strict(),
  z
    .object({
      operation: z.literal("activitySeen"),
      projectId: z.uuid(),
      value: projectSeenSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("activityPage"),
      projectId: z.uuid(),
      value: projectActivityPageSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("activityAcknowledge"),
      projectId: z.uuid(),
      value: projectSeenSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("workItemList"),
      projectId: z.uuid(),
      items: z.array(workItemSchema)
    })
    .strict(),
  z
    .object({
      operation: z.literal("workItemReconcile"),
      value: workItemSchema
    })
    .strict(),
  z
    .object({ operation: z.literal("workItemCreate"), value: workItemSchema })
    .strict(),
  z
    .object({ operation: z.literal("workItemPatch"), value: workItemSchema })
    .strict(),
  z
    .object({
      operation: z.literal("workItemDispatch"),
      value: z
        .object({
          item: workItemSchema,
          executionId: z.uuid(),
          reused: z.boolean(),
          stopPending: z.boolean().optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({ operation: z.literal("sourceList"), value: projectSourcesSchema })
    .strict(),
  z
    .object({
      operation: z.literal("sourceUpload"),
      value: z.discriminatedUnion("canceled", [
        z.object({ canceled: z.literal(true), source: z.null() }).strict(),
        z
          .object({ canceled: z.literal(false), source: projectSourceSchema })
          .strict()
      ])
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceRead"),
      value: projectSourceReadSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceRemoval"),
      value: projectSourceRemovalStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceReview"),
      value: projectSourceRemovalStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceDiscoverRepos"),
      value: z
        .object({
          repos: z.array(
            z
              .object({ name: z.string().min(1), uri: z.string().min(1) })
              .strict()
          )
        })
        .strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceCreate"),
      value: projectSourceSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("sourceRemove"),
      value: projectSourceSchema
    })
    .strict(),
  z
    .object({ operation: z.literal("sourceRetry"), value: projectSourceSchema })
    .strict(),
  z.object({ operation: z.literal("create"), value: projectSchema }).strict(),
  z
    .object({
      operation: z.literal("deletePreview"),
      value: projectDeletePreviewSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      value: projectDeleteStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("deleteProgress"),
      value: projectDeleteStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("deleteStatus"),
      value: projectDeleteStatusSchema.nullable()
    })
    .strict(),
  z
    .object({
      operation: z.literal("deleteCancel"),
      value: projectDeleteStatusSchema
    })
    .strict(),
  z.object({ operation: z.literal("restore"), value: projectSchema }).strict(),
  z
    .object({
      operation: z.literal("restoreReconcile"),
      value: z
        .object({ project: projectSchema, released: z.boolean() })
        .strict()
    })
    .strict()
]);

export type ProjectsRequest = z.infer<typeof projectsRequestSchema>;
export type ProjectsResult = z.infer<typeof projectsResultSchema>;

export interface ProjectsDesktopApi {
  sharedPolicyStatus?(
    personalProjectId: string
  ): Promise<z.infer<typeof projectPolicyRendererStatusSchema>>;
  sharedPolicyEnable?(personalProjectId: string): Promise<{
    policy: z.infer<typeof projectPolicyRendererStatusSchema>;
    initialStage: z.infer<typeof projectPolicyInitialStageSchema>;
  }>;
  sharedPolicyRevoke?(
    personalProjectId: string
  ): Promise<z.infer<typeof projectPolicyRendererStatusSchema>>;
  sharedPolicyStageInitial?(personalProjectId: string): Promise<{
    policy: z.infer<typeof projectPolicyRendererStatusSchema>;
    initialStage: z.infer<typeof projectPolicyInitialStageSchema>;
  }>;
  sharedChatMakePrivate?(
    personalProjectId: string,
    sessionId: string
  ): Promise<{ state: "private" }>;
  sharedChatStatus?(
    personalProjectId: string,
    sessionId: string
  ): Promise<"private" | "pending" | "shared" | "unshared" | "ineligible">;
  sharedChatOffer?(
    personalProjectId: string,
    sessionId: string,
    reason: "moved_in" | "share_again"
  ): Promise<{ state: "pending" | "activated" | "canceled" }>;
  sharedShareContext?(): Promise<WorkspaceProjectShareContext>;
  sharedPendingShare?(
    personalProjectId: string
  ): Promise<z.infer<typeof workspaceProjectPendingShareSchema> | null>;
  sharedCancelPendingShare?(
    personalProjectId: string
  ): Promise<{ canceled: true }>;
  sharedMembers?(
    workspaceProjectId: string,
    teamBackendId: string
  ): Promise<z.infer<typeof workspaceProjectMembersSchema>>;
  sharedFirstShare?(
    personalProjectId: string,
    teamBackendId: string,
    value: z.infer<typeof workspaceProjectCreateSchema>
  ): Promise<z.infer<typeof workspaceProjectRecordSchema>>;
  sharedJoinProject?(
    workspaceProjectId: string,
    teamBackendId: string
  ): Promise<z.infer<typeof projectSchema>>;
  sharedTeamLeaveStage?(
    teamBackendId: string,
    teamId: string
  ): Promise<{
    teamId: string;
    expectedTeamVersion: number;
    expectedMembershipVersion: number;
    expectedOwnedWorkspaceProjects: Array<{ id: string; version: number }>;
    ownedSetHash: string;
    copyManifestHash: string;
    pendingLeaveOperationId?: string | null;
    stages: Array<{ workspaceProjectId: string; payloadHash: string }>;
  }>;
  sharedTeamLeaveFinish?(
    teamBackendId: string,
    stageIds: string[]
  ): Promise<{
    completed: Array<{
      stageId: string;
      projectId?: string;
      copied?: number;
      alreadyApplied?: boolean;
    }>;
  }>;
  sharedAttachSource?(
    workspaceProjectId: string,
    teamBackendId: string,
    personalProjectId: string,
    sourceId: string
  ): Promise<z.infer<typeof workspaceProjectSourceSchema>>;
  sharedPatchSource?(
    workspaceProjectId: string,
    teamBackendId: string,
    sourceId: string,
    value: z.infer<typeof workspaceProjectSourceMetadataPatchSchema>
  ): Promise<z.infer<typeof workspaceProjectSourceSchema>>;
  sharedUploadSource?(
    workspaceProjectId: string,
    teamBackendId: string,
    personalProjectId: string,
    upload: z.infer<typeof projectSourceUploadSchema>
  ): Promise<z.infer<typeof workspaceProjectSourceSchema>>;
  sharedSourcePick?(
    workspaceProjectId: string,
    teamBackendId: string,
    personalProjectId: string
  ): Promise<
    | { canceled: true; source: null }
    | { canceled: false; source: z.infer<typeof workspaceProjectSourceSchema> }
  >;
  sharedReadSource?(
    workspaceProjectId: string,
    teamBackendId: string,
    personalProjectId: string,
    sourceId: string
  ): Promise<z.infer<typeof projectSourceReadSchema>>;
  sharedDispatchWorkItem?(
    personalProjectId: string,
    itemId: string,
    agentId: string,
    expectedProjectVersion: number,
    expectedMemberVersion: number,
    expectedWorkItemVersion: number,
    textActionId?: string
  ): Promise<{
    executionId: string;
    reused: boolean;
    dispatchKey: string;
    progress: { state: "dispatching"; stepLabel: string };
  }>;
  sharedDispatches?(personalProjectId: string): Promise<
    Array<{
      teamWorkItemId: string;
      executionId: string;
      agentId: string;
    }>
  >;
  sharedRefresh?(
    workspaceProjectId: string,
    teamBackendId: string
  ): Promise<z.infer<typeof workspaceProjectStateSchema>>;
  sharedCreateWorkItem?(
    workspaceProjectId: string,
    teamBackendId: string,
    value: z.infer<typeof workspaceProjectHumanWorkItemCreateSchema>
  ): Promise<
    | { status: "ok"; item: z.infer<typeof workspaceProjectWorkItemSchema> }
    | { status: "conflict"; state: z.infer<typeof workspaceProjectStateSchema> }
  >;
  sharedPatchWorkItem?(
    workspaceProjectId: string,
    teamBackendId: string,
    itemId: string,
    value: z.infer<typeof workspaceProjectHumanWorkItemPatchSchema>
  ): Promise<
    | { status: "ok"; item: z.infer<typeof workspaceProjectWorkItemSchema> }
    | { status: "conflict"; state: z.infer<typeof workspaceProjectStateSchema> }
  >;
  workItemList?(projectId: string): Promise<z.infer<typeof workItemSchema>[]>;
  workItemReconcile?(
    projectId: string,
    itemId: string
  ): Promise<z.infer<typeof workItemSchema>>;
  workItemCreate?(
    projectId: string,
    value: z.infer<typeof createWorkItemSchema>
  ): Promise<z.infer<typeof workItemSchema>>;
  workItemPatch?(
    projectId: string,
    itemId: string,
    value: z.infer<typeof patchWorkItemSchema>
  ): Promise<z.infer<typeof workItemSchema>>;
  workItemDispatch?(
    projectId: string,
    itemId: string,
    agentId: string,
    version: number,
    replace?: boolean,
    textActionId?: string
  ): Promise<{
    item: z.infer<typeof workItemSchema>;
    executionId: string;
    reused: boolean;
    stopPending?: boolean;
  }>;
  sourceUpload?(
    projectId: string
  ): Promise<z.infer<typeof projectSourceSchema> | null>;
  sourceRead?(
    projectId: string,
    sourceId: string,
    noteRevisionId: string
  ): Promise<z.infer<typeof projectSourceReadSchema>>;
  sourceRemoval?(
    projectId: string,
    sourceId: string
  ): Promise<z.infer<typeof projectSourceRemovalStatusSchema>>;
  sourceReview?(
    projectId: string,
    sourceId: string,
    batchId: string,
    actionGrantId: string
  ): Promise<z.infer<typeof projectSourceRemovalStatusSchema>>;
  sourceList(projectId: string): Promise<z.infer<typeof projectSourceSchema>[]>;
  sourceDiscoverRepos(
    projectId: string
  ): Promise<Array<{ name: string; uri: string }>>;
  sourceCreate(
    projectId: string,
    value: z.infer<typeof createProjectSourceSchema>
  ): Promise<z.infer<typeof projectSourceSchema>>;
  sourceRemove(
    projectId: string,
    sourceId: string
  ): Promise<z.infer<typeof projectSourceSchema>>;
  sourceRetry(
    projectId: string,
    sourceId: string
  ): Promise<z.infer<typeof projectSourceSchema>>;
  list(): Promise<z.infer<typeof projectSchema>[]>;
  pickFolder(): Promise<string | null>;
  hq(projectId: string): Promise<z.infer<typeof projectHqSchema>>;
  activitySeen?(projectId: string): Promise<z.infer<typeof projectSeenSchema>>;
  activityPage?(
    projectId: string,
    after?: string
  ): Promise<z.infer<typeof projectActivityPageSchema>>;
  activityAcknowledge?(
    projectId: string,
    cursor: string
  ): Promise<z.infer<typeof projectSeenSchema>>;
  create(
    value: z.infer<typeof createProjectSchema>
  ): Promise<z.infer<typeof projectSchema>>;
  deletePreview(
    projectId: string
  ): Promise<z.infer<typeof projectDeletePreviewSchema>>;
  delete(
    projectId: string,
    value: z.infer<typeof projectDeleteSchema>
  ): Promise<z.infer<typeof projectDeleteStatusSchema>>;
  deleteProgress(
    projectId: string,
    batchId: string
  ): Promise<z.infer<typeof projectDeleteStatusSchema>>;
  deleteStatus(
    projectId: string,
    batchId: string
  ): Promise<z.infer<typeof projectDeleteStatusSchema> | null>;
  deleteCancel(
    projectId: string,
    batchId: string
  ): Promise<z.infer<typeof projectDeleteStatusSchema>>;
  restore(
    projectId: string,
    value: z.infer<typeof projectRestoreSchema>
  ): Promise<z.infer<typeof projectSchema>>;
  restoreReconcile(
    projectId: string,
    batchId: string
  ): Promise<{ project: z.infer<typeof projectSchema>; released: boolean }>;
}
