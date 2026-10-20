import {
  createProjectSchema,
  projectDeletePreviewSchema,
  projectDeleteSchema,
  projectDeleteStatusSchema,
  projectHqSchema,
  projectRestoreSchema,
  projectSchema
} from "@koed/shared/project-contract";
import { z } from "zod";

export const projectsCommandChannel = "koed:projects:command";

export const projectsRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("pickFolder") }).strict(),
  z.object({ operation: z.literal("hq"), projectId: z.uuid() }).strict(),
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
