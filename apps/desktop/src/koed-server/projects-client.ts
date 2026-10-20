import { projectHqSchema, projectListSchema, type Project } from "@koed/shared";
import {
  projectsRequestSchema,
  projectsResultSchema,
  type ProjectsRequest,
  type ProjectsResult
} from "../ipc/projects-protocol.js";

type ReadJson = (path: string) => Promise<Record<string, unknown>>;

export const createProjectsClient =
  (readJson: ReadJson, authority: () => Promise<string>) =>
  async (value: ProjectsRequest): Promise<ProjectsResult> => {
    const request = projectsRequestSchema.parse(value);
    const initialAuthority = await authority();
    if (request.operation === "hq") {
      const parsed = projectHqSchema.parse(
        await readJson(
          `/v1/projects/${encodeURIComponent(request.projectId)}/hq`
        )
      );
      if (parsed.project.id !== request.projectId)
        throw new Error("Project HQ identity mismatch.");
      if ((await authority()) !== initialAuthority)
        throw new Error("Projects profile changed during read.");
      return projectsResultSchema.parse({ operation: "hq", value: parsed });
    }
    const projects: Project[] = [];
    const seenCursors = new Set<string>();
    const seenProjects = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = projectListSchema.parse(
        await readJson(`/v1/projects?${query}`)
      );
      if ((await authority()) !== initialAuthority)
        throw new Error("Projects profile changed during list.");
      for (const project of page.projects) {
        if (seenProjects.has(project.id))
          throw new Error("Duplicate Project in list.");
        seenProjects.add(project.id);
        if (project.lifecycle === "active") projects.push(project);
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor))
        throw new Error("Repeated Project list cursor.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return projectsResultSchema.parse({ operation: "list", projects });
  };
