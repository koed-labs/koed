import {
  projectsCommandChannel,
  projectsRequestSchema,
  projectsResultSchema,
  type ProjectsDesktopApi,
  type ProjectsRequest,
  type ProjectsResult
} from "./projects-protocol.js";

export const createProjectsPreloadApi = (
  invoke: (channel: string, request: ProjectsRequest) => Promise<unknown>
): ProjectsDesktopApi => {
  const command = async (request: ProjectsRequest): Promise<ProjectsResult> => {
    const result = projectsResultSchema.parse(
      await invoke(projectsCommandChannel, projectsRequestSchema.parse(request))
    );
    if (result.operation !== request.operation)
      throw new Error("Invalid Projects operation correlation.");
    return result;
  };
  return Object.freeze({
    list: async () => {
      const result = await command({ operation: "list" });
      if (result.operation !== "list")
        throw new Error("Invalid Projects result.");
      return result.projects;
    },
    hq: async (projectId: string) => {
      const result = await command({ operation: "hq", projectId });
      if (result.operation !== "hq" || result.value.project.id !== projectId)
        throw new Error("Invalid Project HQ result.");
      return result.value;
    }
  });
};
