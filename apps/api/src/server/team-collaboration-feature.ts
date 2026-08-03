import type { FastifyInstance, FastifyRequest } from "fastify";

import { decryptCollaborationRealtimeCursor } from "../collaboration/realtime.js";
import {
  collaborationRealtimeAckSchema,
  collaborationRealtimeSnapshotSchema,
  collaborationRealtimeStreamQuerySchema
} from "../collaboration/schemas.js";
import { collaborationCommandRequestSchema } from "../local-edge/collaboration-command.js";
import {
  acknowledgeLocalEdgeCollaborationDeliverySchema,
  createLocalEdgeCollaborationSubscriptionSchema,
  localEdgeCollaborationStreamQuerySchema,
  localEdgeRouteDecisionSchema,
  unsubscribeLocalEdgeCollaborationSchema
} from "../local-edge/schemas.js";

export {
  resolveTeamCollaborationEnabled,
  teamCollaborationFeatureEnvironmentName
} from "@koed/shared";

const disabledPathPrefixes = [
  "/ops/support/teams",
  "/v1/collaboration/teams",
  "/v1/cross-identity-sync",
  "/v1/high-risk",
  "/v1/local-edge/device-enrollments",
  "/v1/local-edge/device-credentials",
  "/v1/local-edge/team-memory",
  "/v1/local-edge/collaboration/realtime/backends",
  "/v1/retention",
  "/v1/shared-memory",
  "/v1/team-context",
  "/v1/team-invites",
  "/v1/team-workspaces",
  "/v1/teams"
] as const;

const requestPathname = (request: FastifyRequest): string => {
  try {
    return new URL(request.url, "http://koed.local").pathname;
  } catch {
    return request.url.split("?")[0] ?? request.url;
  }
};

const hasPathPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const containsTeamWorkspaceSelector = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.team_workspace_id === "string" ||
    typeof record.teamWorkspaceId === "string"
  );
};

const isTeamCollaborationPath = (request: FastifyRequest): boolean => {
  const pathname = requestPathname(request);
  return disabledPathPrefixes.some((prefix) => hasPathPrefix(pathname, prefix));
};

const isTeamScopedMemoryRequest = (request: FastifyRequest): boolean => {
  const pathname = requestPathname(request);
  return (
    pathname.startsWith("/v1/memory/") &&
    (containsTeamWorkspaceSelector(request.query) ||
      containsTeamWorkspaceSelector(request.body))
  );
};

const isExactPath = (request: FastifyRequest, path: string): boolean =>
  requestPathname(request) === path;

const isTeamRealtimeRequest = (
  request: FastifyRequest,
  cursorSecret: string | undefined
): boolean => {
  if (
    request.method === "POST" &&
    isExactPath(request, "/v1/collaboration/realtime/snapshot")
  ) {
    return (
      collaborationRealtimeSnapshotSchema.parse(request.body).scope === "team"
    );
  }
  if (
    request.method === "GET" &&
    isExactPath(request, "/v1/collaboration/realtime/stream")
  ) {
    return (
      collaborationRealtimeStreamQuerySchema.parse(request.query).scope ===
      "team"
    );
  }
  if (
    request.method === "POST" &&
    isExactPath(request, "/v1/collaboration/realtime/ack")
  ) {
    const input = collaborationRealtimeAckSchema.parse(request.body);
    return cursorSecret
      ? decryptCollaborationRealtimeCursor(cursorSecret, input.cursor).scope ===
          "team"
      : false;
  }
  return false;
};

const isTeamLocalEdgeRequest = (request: FastifyRequest): boolean => {
  const pathname = requestPathname(request);
  if (
    request.method === "POST" &&
    pathname === "/v1/local-edge/route-decisions"
  ) {
    const input = localEdgeRouteDecisionSchema.parse(request.body);
    return (
      input.upstream_backend_id !== undefined ||
      !["personal_memory_read", "capture_writes"].includes(
        input.operation_family
      )
    );
  }
  if (
    request.method === "POST" &&
    pathname === "/v1/local-edge/collaboration/command"
  ) {
    const input = collaborationCommandRequestSchema.parse(request.body);
    return "upstream_backend_id" in input;
  }
  if (
    request.method === "POST" &&
    pathname === "/v1/local-edge/collaboration/realtime/subscriptions"
  ) {
    return (
      createLocalEdgeCollaborationSubscriptionSchema.parse(request.body)
        .scope === "team"
    );
  }
  if (
    request.method === "POST" &&
    pathname.endsWith("/ack") &&
    pathname.startsWith("/v1/local-edge/collaboration/realtime/subscriptions/")
  ) {
    return (
      acknowledgeLocalEdgeCollaborationDeliverySchema.parse(request.body)
        .scope === "team"
    );
  }
  if (
    request.method === "GET" &&
    pathname.endsWith("/stream") &&
    pathname.startsWith("/v1/local-edge/collaboration/realtime/subscriptions/")
  ) {
    return (
      localEdgeCollaborationStreamQuerySchema.parse(request.query).scope ===
      "team"
    );
  }
  if (
    request.method === "DELETE" &&
    pathname.startsWith("/v1/local-edge/collaboration/realtime/subscriptions/")
  ) {
    return (
      unsubscribeLocalEdgeCollaborationSchema.parse(request.body).scope ===
      "team"
    );
  }
  return false;
};

export const registerTeamCollaborationFeatureGate = (
  app: FastifyInstance,
  options: { enabled: boolean; realtimeCursorSecret?: string }
): void => {
  if (options.enabled) return;
  app.addHook("onRequest", async (request, reply) => {
    if (isTeamCollaborationPath(request)) {
      await reply.status(404).send();
    }
  });
  app.addHook("preValidation", async (request, reply) => {
    if (
      isTeamScopedMemoryRequest(request) ||
      isTeamRealtimeRequest(request, options.realtimeCursorSecret) ||
      isTeamLocalEdgeRequest(request)
    ) {
      await reply.status(404).send();
    }
  });
};
