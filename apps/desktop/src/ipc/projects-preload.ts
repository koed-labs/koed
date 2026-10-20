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
    if ("projectId" in request && "value" in result && result.value !== null) {
      const project =
        "project" in result.value ? result.value.project : result.value;
      if ("id" in project && project.id !== request.projectId)
        throw new Error("Invalid Projects identity correlation.");
      if (
        "batchId" in request &&
        "operation" in result.value &&
        result.value.operation?.batchId !== request.batchId
      )
        throw new Error("Invalid Projects batch correlation.");
    }
    return result;
  };
  const api: ProjectsDesktopApi = {
    list: async () => {
      const result = await command({ operation: "list" });
      if (result.operation !== "list")
        throw new Error("Invalid Projects result.");
      return result.projects;
    },
    pickFolder: async () => {
      const result = await command({ operation: "pickFolder" });
      if (result.operation !== "pickFolder")
        throw new Error("Invalid Project folder result.");
      return result.path;
    },
    hq: async (projectId) => {
      const result = await command({ operation: "hq", projectId });
      if (result.operation !== "hq" || result.value.project.id !== projectId)
        throw new Error("Invalid Project HQ result.");
      return result.value;
    },
    create: async (value) => {
      const result = await command({ operation: "create", value });
      if (result.operation !== "create")
        throw new Error("Invalid Project create result.");
      return result.value;
    },
    deletePreview: async (projectId) => {
      const result = await command({ operation: "deletePreview", projectId });
      if (result.operation !== "deletePreview")
        throw new Error("Invalid Project preview result.");
      return result.value;
    },
    delete: async (projectId, value) => {
      const result = await command({ operation: "delete", projectId, value });
      if (result.operation !== "delete")
        throw new Error("Invalid Project delete result.");
      return result.value;
    },
    deleteProgress: async (projectId, batchId) => {
      const result = await command({
        operation: "deleteProgress",
        projectId,
        batchId
      });
      if (result.operation !== "deleteProgress")
        throw new Error("Invalid Project progress result.");
      return result.value;
    },
    deleteStatus: async (projectId, batchId) => {
      const result = await command({
        operation: "deleteStatus",
        projectId,
        batchId
      });
      if (result.operation !== "deleteStatus")
        throw new Error("Invalid Project status result.");
      return result.value;
    },
    deleteCancel: async (projectId, batchId) => {
      const result = await command({
        operation: "deleteCancel",
        projectId,
        batchId
      });
      if (result.operation !== "deleteCancel")
        throw new Error("Invalid Project cancel result.");
      return result.value;
    },
    restore: async (projectId, value) => {
      const result = await command({ operation: "restore", projectId, value });
      if (result.operation !== "restore")
        throw new Error("Invalid Project restore result.");
      return result.value;
    },
    restoreReconcile: async (projectId, batchId) => {
      const result = await command({
        operation: "restoreReconcile",
        projectId,
        batchId
      });
      if (result.operation !== "restoreReconcile")
        throw new Error("Invalid Project restore reconciliation result.");
      return result.value;
    }
  };
  return Object.freeze(api);
};
