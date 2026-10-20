import { z } from "zod";
import {
  fetchBoundedJson,
  readLocalEdgeUpstreamRegistry,
  upstreamBackendById
} from "@koed/shared";
import type {
  PersonalWorkspaceProjectRepository,
  ScheduledJobTeamAuthority
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { safeUpstreamProxyUrl } from "../local-edge/upstream-routing.js";

const principalSchema = z
  .object({
    ok: z.literal(true),
    auth: z.literal("device_credential"),
    user: z.object({ id: z.uuid() }).passthrough()
  })
  .passthrough();
const lifecycleSchema = z
  .object({
    id: z.uuid(),
    active: z.literal(true),
    canWrite: z.literal(true),
    version: z.number().int().positive(),
    memberVersion: z.number().int().positive()
  })
  .strict();

/** A current Team read under the enrolled principal, never a renderer cache. */
export function createScheduledJobTeamAuthority(
  context: ApiRouteContext,
  personal: PersonalWorkspaceProjectRepository
): ScheduledJobTeamAuthority {
  return async ({
    ownerUserId,
    projectId,
    teamBackendId,
    workspaceProjectId
  }) => {
    if (!context.localEdge.remoteOperationsAllowed())
      throw new Error("Team authority unavailable");
    const link = await personal.getLink(ownerUserId, projectId);
    if (
      !link ||
      link.teamBackendId !== teamBackendId ||
      link.workspaceProjectId !== workspaceProjectId
    )
      throw new Error("Personal Project Team link changed");
    const expectedPrincipal = await personal.principalBinding(
      ownerUserId,
      teamBackendId
    );
    if (!expectedPrincipal)
      throw new Error("Team principal binding unavailable");
    const backend = upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      teamBackendId
    );
    if (!backend) throw new Error("Team backend unavailable");
    const authorization =
      context.localEdge.resolveUpstreamAuthorization(backend);
    if (!authorization) throw new Error("Team credential unavailable");
    const base = new URL(backend.baseUrl.replace(/\/+$/, "/"));
    if (base.username || base.password || base.search || base.hash)
      throw new Error("Unsafe Team backend");
    const get = async (url: URL) => {
      const response = await fetchBoundedJson(
        context.localEdge.fetch,
        url,
        {
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json", authorization }
        },
        { timeoutMs: 15_000, maxBytes: 64_000 }
      );
      if (!response.response.ok) throw new Error("Team authority denied");
      return response.payload;
    };
    const principal = principalSchema.parse(
      await get(new URL("v1/local-edge/device-credentials/status", base))
    );
    if (principal.user.id !== expectedPrincipal)
      throw new Error("Team principal changed");
    const lifecycle = lifecycleSchema.parse(
      await get(
        safeUpstreamProxyUrl(
          backend,
          `/v1/workspace-projects/${workspaceProjectId}/lifecycle`
        )
      )
    );
    if (lifecycle.id !== workspaceProjectId)
      throw new Error("Team Project changed");
    const currentLink = await personal.getLink(ownerUserId, projectId);
    if (
      !currentLink ||
      currentLink.teamBackendId !== teamBackendId ||
      currentLink.workspaceProjectId !== workspaceProjectId ||
      (await personal.principalBinding(ownerUserId, teamBackendId)) !==
        expectedPrincipal
    )
      throw new Error("Team authority changed during read");
    return {
      projectVersion: lifecycle.version,
      memberVersion: lifecycle.memberVersion
    };
  };
}
