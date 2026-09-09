import type { ManagedTerminalExecutionAuthority } from "@koed/db";
import {
  fetchBoundedJsonObject,
  readLocalEdgeUpstreamRegistry,
  upstreamAdvertisesCapability,
  upstreamApiUrl,
  upstreamBackendById
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { assertUpstreamOperationPathAllowed } from "../local-edge/upstream-routing.js";

const authoritySchema = z.object({
  id: z.uuid(),
  executionGeneration: z.number().int().positive(),
  runnerDeploymentId: z.uuid(),
  runnerDeviceId: z.uuid(),
  state: z.string()
});
const unavailable = () =>
  Object.assign(new Error("Terminal execution authority is unavailable"), {
    statusCode: 503
  });

/** Resolve current assignment at its authority; PTYs and bindings stay local. */
export const resolveTerminalExecutionAuthority = async (
  context: ApiRouteContext,
  ownerUserId: string,
  executionId: string
): Promise<ManagedTerminalExecutionAuthority | null> => {
  if (
    ["developer", "local_personal"].includes(context.config.deploymentProfile)
  ) {
    const registry = readLocalEdgeUpstreamRegistry(
      context.localEdge.upstreamBackendsPath
    );
    const backend = registry.activeBackendId
      ? upstreamBackendById(registry, registry.activeBackendId)
      : null;
    if (backend?.routePolicy.managedExecution === "enabled") {
      if (
        !context.localEdge.remoteOperationsAllowed() ||
        backend.capabilities?.state !== "validated" ||
        (backend.capabilities.expiresAt &&
          Date.parse(backend.capabilities.expiresAt) <= Date.now()) ||
        !upstreamAdvertisesCapability(backend, "memory.managedConversations")
      )
        throw unavailable();
      const authorization =
        context.localEdge.resolveUpstreamAuthorization(backend);
      if (!authorization) throw unavailable();
      // This runner endpoint checks the enrolled device's current assignment.
      const path = `/v1/managed-conversation-runner/executions/${encodeURIComponent(executionId)}`;
      assertUpstreamOperationPathAllowed("managed_execution", "GET", path);
      const { response, payload } = await fetchBoundedJsonObject(
        context.localEdge.fetch,
        upstreamApiUrl(backend.baseUrl, path),
        {
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json", authorization }
        },
        { timeoutMs: 15_000, maxBytes: 64 * 1024, readErrorBody: false }
      );
      if (!response.ok)
        throw Object.assign(unavailable(), {
          statusCode: response.status >= 500 ? 502 : response.status
        });
      return authoritySchema.parse(payload.execution);
    }
  }
  return context
    .requireRepository()
    .getManagedConversationExecution({ userId: ownerUserId }, executionId);
};
