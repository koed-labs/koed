import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  activationAnalyticsFunnelQuerySchema,
  activationAnalyticsEventBodySchema,
  type ActivationAnalyticsEventBody
} from "./schemas.js";

const forbidden = (message: string) =>
  Object.assign(new Error(message), { statusCode: 403 });

const analyticsAction = (event: ActivationAnalyticsEventBody["event"]) =>
  `analytics.activation.${event}`;

const targetFor = (
  input: ActivationAnalyticsEventBody,
  actorUserId: string
): { targetTable: string; targetId: string } => {
  if (input.teamWorkspaceId) {
    return { targetTable: "team_workspaces", targetId: input.teamWorkspaceId };
  }
  if (input.teamId) {
    return { targetTable: "teams", targetId: input.teamId };
  }
  if (input.sessionId) {
    return { targetTable: "sessions", targetId: input.sessionId };
  }
  return { targetTable: "users", targetId: actorUserId };
};

export const registerAnalyticsRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateSession },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  app.get(
    "/v1/analytics/activation-funnel",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const query = activationAnalyticsFunnelQuerySchema.parse(request.query);
      const funnel = await repo.getActivationAnalyticsFunnel(
        { userId: user.id },
        query
      );
      if (!funnel) {
        throw forbidden("Activation analytics funnel cannot be viewed");
      }
      return { funnel };
    }
  );

  app.post(
    "/v1/analytics/activation-events",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const input = activationAnalyticsEventBodySchema.parse(request.body);

      let resolvedTeamId = input.teamId ?? null;
      if (input.teamWorkspaceId) {
        const access = await repo.getTeamWorkspaceAccess(
          { userId: user.id },
          input.teamWorkspaceId
        );
        if (
          !access ||
          (!access.canRecall &&
            !access.canCreateShare &&
            !access.canManageWorkspace)
        ) {
          throw forbidden("Team Workspace analytics event is not authorized");
        }
        if (input.teamId && input.teamId !== access.teamId) {
          throw forbidden("Team Workspace does not belong to the Team");
        }
        resolvedTeamId = access.teamId;
      } else if (input.teamId) {
        const membership = await repo.getTeamMembership(
          { userId: user.id },
          input.teamId
        );
        if (!membership || membership.status !== "enabled") {
          throw forbidden("Team analytics event is not authorized");
        }
      } else if (input.sessionId) {
        const session = await repo.getCapturedSession(
          { userId: user.id },
          input.sessionId
        );
        if (!session) {
          throw forbidden("Session analytics event is not authorized");
        }
      }

      const target = targetFor(input, user.id);
      const event = await repo.recordAuditEvent({
        actorUserId: user.id,
        ownerUserId: user.id,
        visibility: null,
        action: analyticsAction(input.event),
        targetTable: target.targetTable,
        targetId: target.targetId,
        metadata: {
          event: input.event,
          surface: input.surface,
          ...(input.deploymentProfile
            ? { deploymentProfile: input.deploymentProfile }
            : {}),
          ...(resolvedTeamId ? { teamId: resolvedTeamId } : {}),
          ...(input.teamWorkspaceId
            ? { teamWorkspaceId: input.teamWorkspaceId }
            : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.metadata ? { attributes: input.metadata } : {})
        }
      });

      return { event };
    }
  );
};
