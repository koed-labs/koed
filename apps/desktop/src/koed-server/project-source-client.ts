import {
  projectHqSchema,
  projectSourceSchema,
  projectSourcesSchema
} from "@koed/shared";
import {
  projectsResultSchema,
  type ProjectsRequest,
  type ProjectsResult
} from "../ipc/projects-protocol.js";
import type { ProjectsAuthority } from "./projects-client.js";

type SourceRequest = Extract<
  ProjectsRequest,
  {
    operation:
      | "sourceList"
      | "sourceDiscoverRepos"
      | "sourceCreate"
      | "sourceRemove"
      | "sourceRetry";
  }
>;
const path = (id: string) => `/v1/projects/${encodeURIComponent(id)}/sources`;

export const createProjectSourceClient =
  (
    requestJson: (
      path: string,
      init: RequestInit,
      authority: ProjectsAuthority
    ) => Promise<Record<string, unknown>>,
    authority: () => Promise<ProjectsAuthority>,
    discoverRepos: (
      folderPath: string
    ) => Promise<Array<{ name: string; uri: string }>>
  ) =>
  async (request: SourceRequest): Promise<ProjectsResult> => {
    const bound = await authority();
    const send = async (url: string, init: RequestInit = { method: "GET" }) => {
      if (init.method !== "GET" && !bound.canWrite)
        throw new Error("Project Sources write authority is unavailable.");
      if ((await authority()).key !== bound.key)
        throw new Error("Projects profile changed before request.");
      const result = await requestJson(url, init, bound);
      if ((await authority()).key !== bound.key)
        throw new Error("Projects profile changed during request.");
      return result;
    };
    const base = path(request.projectId);
    if (request.operation === "sourceDiscoverRepos") {
      const hq = projectHqSchema.parse(
        await send(`/v1/projects/${encodeURIComponent(request.projectId)}/hq`)
      );
      if (hq.project.id !== request.projectId)
        throw new Error("Project identity mismatch.");
      const repos = hq.project.folderPath
        ? await discoverRepos(hq.project.folderPath)
        : [];
      if ((await authority()).key !== bound.key)
        throw new Error("Projects profile changed during discovery.");
      return projectsResultSchema.parse({
        operation: request.operation,
        value: { repos }
      });
    }
    if (request.operation === "sourceList") {
      const parsed = projectSourcesSchema.parse(await send(base));
      if (
        parsed.sources.some((source) => source.projectId !== request.projectId)
      )
        throw new Error("Project Source list identity mismatch.");
      return projectsResultSchema.parse({
        operation: request.operation,
        value: parsed
      });
    }
    if (request.operation === "sourceCreate" && request.value.kind === "repo") {
      const hq = projectHqSchema.parse(
        await send(`/v1/projects/${encodeURIComponent(request.projectId)}/hq`)
      );
      if (hq.project.id !== request.projectId || !hq.project.folderPath)
        throw new Error(
          "Project folder is unavailable for repository discovery."
        );
      const repos = await discoverRepos(hq.project.folderPath);
      if (
        !repos.some(
          (repo) =>
            repo.name === request.value.name && repo.uri === request.value.uri
        )
      )
        throw new Error(
          "Repository is not a discovered remote of this Project folder."
        );
    }
    const init: RequestInit =
      request.operation === "sourceCreate"
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.value)
          }
        : request.operation === "sourceRemove"
          ? { method: "DELETE" }
          : { method: "POST" };
    const url =
      request.operation === "sourceCreate"
        ? base
        : `${base}/${encodeURIComponent(request.sourceId)}${request.operation === "sourceRetry" ? "/retry" : ""}`;
    const parsed = projectSourceSchema.parse(await send(url, init));
    if (
      parsed.projectId !== request.projectId ||
      ("sourceId" in request && parsed.id !== request.sourceId)
    )
      throw new Error("Project Source identity mismatch.");
    return projectsResultSchema.parse({
      operation: request.operation,
      value: parsed
    });
  };
