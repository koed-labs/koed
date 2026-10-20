import { AsyncLocalStorage } from "node:async_hooks";
import {
  fetchBoundedJson,
  readLocalEdgeClientCredentialAuthorization
} from "@koed/shared";
import type { ProjectsAuthority } from "./projects-client.js";
import { WorkspaceProjectRemoteError } from "./workspace-project-service.js";

export const createWorkspaceProjectTransport = (input: {
  identity: AsyncLocalStorage<string>;
  authority(): Promise<ProjectsAuthority>;
  fetch: typeof globalThis.fetch;
  koedHome: string;
}) => {
  const boundAuthority = async () => {
    const bound = await input.authority();
    if (input.identity.getStore() !== bound.key)
      throw new Error("Projects profile changed before shared Project request");
    return bound;
  };
  const verifyAuthority = async (key: string) => {
    if ((await input.authority()).key !== key)
      throw new Error("Projects profile changed during shared Project request");
  };
  const teamCredential = (
    teamBackendId: string,
    family:
      | "team_workspace_read"
      | "team_workspace_write" = "team_workspace_read"
  ) => {
    const credential = readLocalEdgeClientCredentialAuthorization(
      input.koedHome,
      teamBackendId
    );
    if (!credential?.operationFamilies.includes(family))
      throw new Error("Team Project authority is unavailable");
    return credential.authorization;
  };
  return {
    teamCredential,
    async sendPersonal(path: string, init: RequestInit = { method: "GET" }) {
      const bound = await boundAuthority();
      const remote = await fetchBoundedJson(
        input.fetch,
        new URL(path, bound.apiOrigin),
        {
          ...init,
          redirect: "error",
          headers: {
            accept: "application/json",
            ...init.headers,
            authorization: bound.authorization
          }
        },
        {
          timeoutMs: 30_000,
          maxBytes: path.includes("/content?") ? 160_000_000 : 8_000_000,
          readErrorBody: true
        }
      );
      await verifyAuthority(bound.key);
      if (!remote.response.ok)
        throw new WorkspaceProjectRemoteError(
          remote.response.status,
          "Personal Workspace Project request failed"
        );
      return remote.payload;
    },
    async sendTeam(
      teamBackendId: string,
      path: string,
      init: RequestInit = { method: "GET" }
    ) {
      const bound = await boundAuthority();
      const family =
        init.method === "GET" ? "team_workspace_read" : "team_workspace_write";
      const authorization = teamCredential(teamBackendId, family);
      const remote = await fetchBoundedJson(
        input.fetch,
        new URL("/v1/local-edge/upstream-operations", bound.apiOrigin),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization
          },
          body: JSON.stringify({
            operation_family: family,
            upstream_backend_id: teamBackendId,
            requested_mode: "live_upstream_proxy",
            method: init.method ?? "GET",
            path,
            ...(init.method === "GET"
              ? {}
              : { body: JSON.parse(String(init.body ?? "{}")) })
          })
        },
        { timeoutMs: 30_000, maxBytes: 8_000_000, readErrorBody: true }
      );
      await verifyAuthority(bound.key);
      if (!remote.response.ok)
        throw new WorkspaceProjectRemoteError(
          remote.response.status,
          remote.response.status === 409
            ? "Shared Project changed"
            : "Team Project request failed"
        );
      return remote.payload;
    }
  };
};
