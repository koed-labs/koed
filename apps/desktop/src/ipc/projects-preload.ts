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
    if (
      request.operation === "sourceCreate" ||
      request.operation === "sourceRemove" ||
      request.operation === "sourceRetry"
    ) {
      if (
        result.operation !== request.operation ||
        result.value.projectId !== request.projectId ||
        ("sourceId" in request && result.value.id !== request.sourceId)
      )
        throw new Error("Invalid Project Source identity correlation.");
      return result;
    }
    if (
      "projectId" in request &&
      "value" in result &&
      result.value !== null &&
      !request.operation.startsWith("workItem")
    ) {
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
    workItemList: async (projectId) => {
      const result = await command({ operation: "workItemList", projectId });
      if (
        result.operation !== "workItemList" ||
        result.projectId !== projectId ||
        result.items.some((item) => item.projectId !== projectId)
      )
        throw new Error("Invalid Work Item list identity.");
      return result.items;
    },
    workItemReconcile: async (projectId, itemId) => {
      const result = await command({
        operation: "workItemReconcile",
        projectId,
        itemId
      });
      if (
        result.operation !== "workItemReconcile" ||
        result.value.projectId !== projectId ||
        result.value.id !== itemId
      )
        throw new Error("Invalid Work Item reconciliation identity.");
      return result.value;
    },
    workItemCreate: async (projectId, value) => {
      const result = await command({
        operation: "workItemCreate",
        projectId,
        value
      });
      if (
        result.operation !== "workItemCreate" ||
        result.value.projectId !== projectId
      )
        throw new Error("Invalid Work Item creation identity.");
      return result.value;
    },
    workItemPatch: async (projectId, itemId, value) => {
      const result = await command({
        operation: "workItemPatch",
        projectId,
        itemId,
        value
      });
      if (
        result.operation !== "workItemPatch" ||
        result.value.projectId !== projectId ||
        result.value.id !== itemId
      )
        throw new Error("Invalid Work Item patch identity.");
      return result.value;
    },
    workItemDispatch: async (projectId, itemId, agentId, version, replace) => {
      const result = await command({
        operation: "workItemDispatch",
        projectId,
        itemId,
        agentId,
        version,
        replace
      });
      if (
        result.operation !== "workItemDispatch" ||
        result.value.item.projectId !== projectId ||
        result.value.item.id !== itemId ||
        result.value.item.executionId !== result.value.executionId
      )
        throw new Error("Invalid Work Item dispatch identity.");
      return result.value;
    },
    sourceUpload: async (projectId) => {
      const result = await command({ operation: "sourceUpload", projectId });
      if (result.operation !== "sourceUpload")
        throw new Error("Invalid Project Source upload.");
      if (!result.value.canceled && result.value.source.projectId !== projectId)
        throw new Error("Invalid Project Source upload identity.");
      return result.value.source;
    },
    sourceRead: async (projectId, sourceId, noteRevisionId) => {
      const result = await command({
        operation: "sourceRead",
        projectId,
        sourceId,
        noteRevisionId
      });
      if (
        result.operation !== "sourceRead" ||
        result.value.sourceId !== sourceId ||
        result.value.noteRevisionId !== noteRevisionId
      )
        throw new Error("Invalid Project Source read.");
      return result.value;
    },
    sourceRemoval: async (projectId, sourceId) => {
      const result = await command({
        operation: "sourceRemoval",
        projectId,
        sourceId
      });
      if (result.operation !== "sourceRemoval")
        throw new Error("Invalid Project Source removal.");
      return result.value;
    },
    sourceReview: async (projectId, sourceId, batchId, actionGrantId) => {
      const result = await command({
        operation: "sourceReview",
        projectId,
        sourceId,
        batchId,
        actionGrantId
      });
      if (
        result.operation !== "sourceReview" ||
        result.value.batchId !== batchId
      )
        throw new Error("Invalid Project Source review.");
      return result.value;
    },
    sourceList: async (projectId) => {
      const result = await command({ operation: "sourceList", projectId });
      if (
        result.operation !== "sourceList" ||
        result.value.sources.some((source) => source.projectId !== projectId)
      )
        throw new Error("Invalid Project Source list.");
      return result.value.sources;
    },
    sourceDiscoverRepos: async (projectId) => {
      const result = await command({
        operation: "sourceDiscoverRepos",
        projectId
      });
      if (result.operation !== "sourceDiscoverRepos")
        throw new Error("Invalid Project remote discovery.");
      return result.value.repos;
    },
    sourceCreate: async (projectId, value) => {
      const result = await command({
        operation: "sourceCreate",
        projectId,
        value
      });
      if (result.operation !== "sourceCreate")
        throw new Error("Invalid Project Source create.");
      return result.value;
    },
    sourceRemove: async (projectId, sourceId) => {
      const result = await command({
        operation: "sourceRemove",
        projectId,
        sourceId
      });
      if (result.operation !== "sourceRemove")
        throw new Error("Invalid Project Source remove.");
      return result.value;
    },
    sourceRetry: async (projectId, sourceId) => {
      const result = await command({
        operation: "sourceRetry",
        projectId,
        sourceId
      });
      if (result.operation !== "sourceRetry")
        throw new Error("Invalid Project Source retry.");
      return result.value;
    },
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
