import { projectHqSchema, projectSchema } from "@koed/shared/project-contract";
import { z } from "zod";

export const projectsCommandChannel = "koed:projects:command";

export const projectsRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("hq"), projectId: z.uuid() }).strict()
]);

export const projectsResultSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("list"), projects: z.array(projectSchema) })
    .strict(),
  z.object({ operation: z.literal("hq"), value: projectHqSchema }).strict()
]);

export type ProjectsRequest = z.infer<typeof projectsRequestSchema>;
export type ProjectsResult = z.infer<typeof projectsResultSchema>;

export interface ProjectsDesktopApi {
  list(): Promise<z.infer<typeof projectSchema>[]>;
  hq(projectId: string): Promise<z.infer<typeof projectHqSchema>>;
}
