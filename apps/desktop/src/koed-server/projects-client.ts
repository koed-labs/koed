import {
  projectDeletePreviewSchema,
  projectDeleteStatusSchema,
  projectHqSchema,
  projectListSchema,
  projectSchema,
  type Project
} from "@koed/shared/project-contract";
import {
  projectsRequestSchema,
  projectsResultSchema,
  type ProjectsRequest,
  type ProjectsResult
} from "../ipc/projects-protocol.js";
import {
  projectActivityPageSchema,
  projectSeenSchema
} from "@koed/shared/project-activity-contract";
import { createProjectSourceClient } from "./project-source-client.js";
import { createProjectWorkItemClient } from "./project-work-item-client.js";

export type ProjectsAuthority = {
  key: string;
  ownerId: string;
  apiOrigin: string;
  authorization: string;
  canWrite: boolean;
};

type RequestJson = (
  path: string,
  init: RequestInit,
  authority: ProjectsAuthority
) => Promise<Record<string, unknown>>;

const projectPath = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;

export const createProjectsClient = (
  requestJson: RequestJson,
  authority: () => Promise<ProjectsAuthority>,
  discoverRepos: (
    folderPath: string
  ) => Promise<Array<{ name: string; uri: string }>> = async () => []
) => {
  const sourceClient = createProjectSourceClient(
    requestJson,
    authority,
    discoverRepos
  );
  return async (value: ProjectsRequest): Promise<ProjectsResult> => {
    const request = projectsRequestSchema.parse(value);
    if (
      request.operation === "sourceList" ||
      request.operation === "sourceDiscoverRepos" ||
      request.operation === "sourceCreate" ||
      request.operation === "sourceRemove" ||
      request.operation === "sourceRetry"
    )
      return sourceClient(request);
    if (request.operation === "pickFolder")
      throw new Error("Project folder selection is handled by Desktop IPC.");
    const bound = await authority();
    const send = async (
      path: string,
      init: RequestInit = { method: "GET" }
    ) => {
      if (init.method !== "GET" && !bound.canWrite)
        throw new Error("Projects write authority is unavailable.");
      if ((await authority()).key !== bound.key)
        throw new Error("Projects profile changed before request.");
      const payload = await requestJson(path, init, bound);
      if ((await authority()).key !== bound.key)
        throw new Error("Projects profile changed during request.");
      return payload;
    };
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (request.operation === "hq") {
      const parsed = projectHqSchema.parse(
        await send(`${projectPath(request.projectId)}/hq`)
      );
      if (parsed.project.id !== request.projectId)
        throw new Error("Project HQ identity mismatch.");
      return projectsResultSchema.parse({ operation: "hq", value: parsed });
    }
    if (request.operation === "activitySeen") {
      const parsed = projectSeenSchema.parse(
        await send(`${projectPath(request.projectId)}/activity/seen`)
      );
      return projectsResultSchema.parse({
        operation: "activitySeen",
        projectId: request.projectId,
        value: parsed
      });
    }
    if (request.operation === "activityPage") {
      const query = request.after
        ? `?after=${encodeURIComponent(request.after)}`
        : "";
      const parsed = projectActivityPageSchema.parse(
        await send(`${projectPath(request.projectId)}/activity${query}`)
      );
      return projectsResultSchema.parse({
        operation: "activityPage",
        projectId: request.projectId,
        value: parsed
      });
    }
    if (request.operation === "activityAcknowledge") {
      const parsed = projectSeenSchema.parse(
        await send(
          `${projectPath(request.projectId)}/activity/seen`,
          json("PUT", { cursor: request.cursor })
        )
      );
      return projectsResultSchema.parse({
        operation: "activityAcknowledge",
        projectId: request.projectId,
        value: parsed
      });
    }
    if (
      request.operation === "workItemList" ||
      request.operation === "workItemReconcile" ||
      request.operation === "workItemCreate" ||
      request.operation === "workItemPatch" ||
      request.operation === "workItemDispatch"
    )
      return createProjectWorkItemClient(send, json)(request);
    if (request.operation === "create") {
      const parsed = projectSchema.parse(
        await send("/v1/projects", json("POST", request.value))
      );
      if (parsed.lifecycle !== "active")
        throw new Error("Created Project is unavailable.");
      return projectsResultSchema.parse({ operation: "create", value: parsed });
    }
    if (request.operation === "deletePreview") {
      const parsed = projectDeletePreviewSchema.parse(
        await send(`${projectPath(request.projectId)}/delete-preview`)
      );
      if (parsed.project.id !== request.projectId)
        throw new Error("Project preview identity mismatch.");
      return projectsResultSchema.parse({
        operation: "deletePreview",
        value: parsed
      });
    }
    if (request.operation === "restore") {
      const parsed = projectSchema.parse(
        await send(
          `${projectPath(request.projectId)}/restore`,
          json("POST", request.value)
        )
      );
      if (
        parsed.id !== request.projectId ||
        parsed.lifecycle !== "active" ||
        parsed.deleteBatchId !== null
      )
        throw new Error("Project restore identity or lifecycle mismatch.");
      return projectsResultSchema.parse({
        operation: "restore",
        value: parsed
      });
    }
    if (request.operation === "restoreReconcile") {
      const payload = await send(
        `${projectPath(request.projectId)}/restore-reconcile`,
        json("POST", { batchId: request.batchId })
      );
      const parsed = projectsResultSchema.parse({
        operation: "restoreReconcile",
        value: payload
      });
      if (
        parsed.operation !== "restoreReconcile" ||
        parsed.value.project.id !== request.projectId ||
        (parsed.value.released &&
          (parsed.value.project.lifecycle !== "active" ||
            parsed.value.project.deletionPhase !== null ||
            parsed.value.project.deleteBatchId !== null))
      )
        throw new Error(
          "Project restore reconciliation identity or lifecycle mismatch."
        );
      return parsed;
    }
    if (
      request.operation === "delete" ||
      request.operation === "deleteProgress" ||
      request.operation === "deleteStatus" ||
      request.operation === "deleteCancel"
    ) {
      const path = `${projectPath(request.projectId)}`;
      const batchId =
        request.operation === "delete"
          ? request.value.batchId
          : request.batchId;
      const [url, init]: [string, RequestInit] =
        request.operation === "delete"
          ? [path, json("DELETE", request.value)]
          : request.operation === "deleteProgress"
            ? [`${path}/delete-progress`, json("POST", { batchId })]
            : request.operation === "deleteCancel"
              ? [`${path}/delete-cancel`, json("POST", { batchId })]
              : [
                  `${path}/delete-status?${new URLSearchParams({ batchId })}`,
                  { method: "GET" }
                ];
      let payload: Record<string, unknown>;
      try {
        payload = await send(url, init);
      } catch (error) {
        if (
          request.operation === "deleteStatus" &&
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "not_found"
        )
          return projectsResultSchema.parse({
            operation: "deleteStatus",
            value: null
          });
        throw error;
      }
      const parsed = projectDeleteStatusSchema.parse(payload);
      if (
        parsed.project.id !== request.projectId ||
        parsed.operation?.batchId !== batchId
      )
        throw new Error("Project delete batch identity mismatch.");
      return projectsResultSchema.parse({
        operation: request.operation,
        value: parsed
      });
    }
    const projects: Project[] = [];
    const seenCursors = new Set<string>();
    const seenProjects = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = projectListSchema.parse(await send(`/v1/projects?${query}`));
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
};
