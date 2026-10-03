import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  fetchBoundedJsonObject,
  upstreamApiUrl,
  upstreamAdvertisesCapability
} from "@koed/shared";
import { z } from "zod";
import {
  aiClientResourceDiscoveryOperationSchema,
  aiClientResourceDiscoveryRequestSchema
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import {
  assertUpstreamOperationPathAllowed,
  readLocalEdgeUpstreamRegistry,
  upstreamBackendById
} from "../local-edge/upstream-routing.js";

const localProfiles = new Set(["developer", "local_personal"]);
const uuid = z.uuid();

export const registerAiClientResourceRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const remoteAuthority = () => {
    if (!localProfiles.has(context.config.deploymentProfile)) return null;
    const registry = readLocalEdgeUpstreamRegistry(
      context.localEdge.upstreamBackendsPath
    );
    const backend = registry.activeBackendId
      ? upstreamBackendById(registry, registry.activeBackendId)
      : null;
    if (!backend) return null;
    if (
      backend.routePolicy.managedExecution !== "enabled" ||
      !context.localEdge.remoteOperationsAllowed() ||
      backend.capabilities?.state !== "validated" ||
      (backend.capabilities.expiresAt &&
        Date.parse(backend.capabilities.expiresAt) <= Date.now()) ||
      !upstreamAdvertisesCapability(backend, "memory.managedConversations")
    )
      throw Object.assign(
        new Error("AI Client resource authority is unavailable"),
        { statusCode: 503 }
      );
    const authorization =
      context.localEdge.resolveUpstreamAuthorization(backend);
    if (!authorization)
      throw Object.assign(
        new Error("AI Client resource authority is not enrolled"),
        { statusCode: 503 }
      );
    return { backend, authorization };
  };
  const proxy = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown> | null> => {
    const authority = remoteAuthority();
    if (!authority) return null;
    assertUpstreamOperationPathAllowed("managed_execution", method, path);
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamApiUrl(authority.backend.baseUrl, path),
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization,
          ...(method === "POST" ? { "content-type": "application/json" } : {})
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
      },
      { timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024, readErrorBody: true }
    );
    if (!response.ok)
      throw Object.assign(
        new Error(
          typeof payload.error === "string"
            ? payload.error
            : "AI Client resource authority failed"
        ),
        { statusCode: response.status >= 500 ? 502 : response.status }
      );
    return payload;
  };
  const authenticate = async (request: FastifyRequest) =>
    context.auth.authenticateSessionOrDeviceCredential(
      request,
      "managed_execution",
      {
        apiTokenError:
          "A User session or managed execution credential is required"
      }
    );
  const repository = () => context.requireRepository();

  app.post("/v1/ai-client-resources/discover", async (request) => {
    const auth = await authenticate(request);
    const body = aiClientResourceDiscoveryRequestSchema.parse(request.body);
    const identity = localProfiles.has(context.config.deploymentProfile)
      ? context.deploymentIdentity.inspect()
      : null;
    if (
      identity &&
      (identity.health !== "healthy" ||
        !identity.deploymentId ||
        !identity.deviceInstanceId)
    )
      throw Object.assign(
        new Error("Local AI Client resource runner is unavailable"),
        { statusCode: 503 }
      );
    const target = await repository().resolveAiClientResourceDiscoveryTarget(
      { userId: auth.id },
      {
        hostedInstanceId: body.hostedInstanceId,
        localDeviceId: identity?.deviceInstanceId ?? null,
        localDeploymentId: identity?.deploymentId ?? null
      }
    );
    const localSentinel = "00000000-0000-0000-0000-000000000000";
    const targetIsLocal = target?.sourceDeviceCredentialId === localSentinel;
    if (localProfiles.has(context.config.deploymentProfile) && !targetIsLocal) {
      const remote = await proxy(
        "POST",
        "/v1/ai-client-resources/discover",
        body
      );
      if (remote) return aiClientResourceDiscoveryOperationSchema.parse(remote);
      if (target)
        throw Object.assign(
          new Error("Remote AI Client resource authority is unavailable"),
          { statusCode: 503 }
        );
    }
    if (!target)
      throw Object.assign(
        new Error("AI Client resource instance is unavailable"),
        { statusCode: 404 }
      );
    const operation =
      await repository().createAiClientResourceDiscoveryOperation(
        { userId: auth.id },
        { target, projectId: body.projectId, requestId: body.requestId }
      );
    return aiClientResourceDiscoveryOperationSchema.parse(operation);
  });

  app.get("/v1/ai-client-resources/discover/:operationId", async (request) => {
    const auth = await authenticate(request);
    const params = z
      .object({ operationId: uuid })
      .strict()
      .parse(request.params);
    const operation = await repository().getAiClientResourceDiscoveryOperation(
      { userId: auth.id },
      { operationId: params.operationId }
    );
    if (operation)
      return aiClientResourceDiscoveryOperationSchema.parse(operation);
    const remote = await proxy(
      "GET",
      `/v1/ai-client-resources/discover/${encodeURIComponent(params.operationId)}`
    );
    if (remote) return aiClientResourceDiscoveryOperationSchema.parse(remote);
    if (!operation)
      throw Object.assign(
        new Error("AI Client resource operation was not found"),
        { statusCode: 404 }
      );
    return operation;
  });
};
