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
  projectSourceReadSchema,
  projectSourceRemovalStatusSchema,
  projectSourceSchema,
  projectSourcesSchema
} from "@koed/shared/project-source-contract";
import { z } from "zod";
import {
  createWorkItemSchema,
  patchWorkItemSchema,
  workItemSchema
} from "@koed/shared/work-item-contract";

export const projectsCommandChannel = "koed:projects:command";

export const projectsRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("pickFolder") }).strict(),
  z.object({ operation: z.literal("hq"), projectId: z.uuid() }).strict(),
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
      replace: z.boolean().optional()
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
    replace?: boolean
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
