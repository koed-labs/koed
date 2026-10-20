import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  personalSelectionConsumerStartSchema,
  personalSelectionConsumerContinueSchema
} from "@koed/shared";

/** Owner configuration APIs expose metadata only. A selection/cursor is never
 * a Team grant, source-read token, Workspace publication or capture permission. */
export const registerPersonalSelectionConsumerRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit: { memoryRead: read }
  } = context;
  app.post(
    "/v1/personal/selections/enumerate",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request);
      return requireRepository().startPersonalSelectionEnumeration(
        { userId: user.id },
        personalSelectionConsumerStartSchema.parse(request.body)
      );
    }
  );
  app.post(
    "/v1/personal/selections/continue",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request);
      return requireRepository().continuePersonalSelectionEnumeration(
        { userId: user.id },
        personalSelectionConsumerContinueSchema.parse(request.body)
      );
    }
  );
  app.post(
    "/v1/personal/selections/changes",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request);
      return requireRepository().reconcilePersonalSelectionChanges(
        { userId: user.id },
        personalSelectionConsumerContinueSchema.parse(request.body)
      );
    }
  );
};
