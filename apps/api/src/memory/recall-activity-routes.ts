import {
  recallActivityOverviewInputSchema,
  recallActivityOverviewSchema
} from "@koed/shared";
import {
  recallActivityDetailInputSchema,
  recallActivityDetailSchema
} from "@koed/shared";
import type { FastifyInstance } from "fastify";
import {
  recallActivityCursorSchema,
  recallActivityListInputSchema,
  recallActivityPageSchema
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";

export const registerRecallActivityRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  app.get(
    "/v1/memory/recall-activity/overview",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      const user = await context.auth.authenticateApiToken(request);
      if (context.auth.authenticatedCredentialKind(request) !== "api_token")
        return reply.code(403).send({ error: "Personal API Token required" });
      const input = recallActivityOverviewInputSchema.parse(request.query);
      reply.header("cache-control", "no-store");
      return recallActivityOverviewSchema.parse(
        await context
          .requireRepository()
          .getRecallActivityOverview({ userId: user.id }, input)
      );
    }
  );
  app.get(
    "/v1/memory/recall-activity/questions/:questionId",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      const user = await context.auth.authenticateApiToken(request);
      if (context.auth.authenticatedCredentialKind(request) !== "api_token")
        return reply.code(403).send({ error: "Personal API Token required" });
      const { questionId } = recallActivityDetailInputSchema.parse(
        request.params
      );
      const detail = await context
        .requireRepository()
        .getRecallActivity({ userId: user.id }, questionId);
      reply.header("cache-control", "no-store");
      if (!detail)
        return reply
          .code(404)
          .send({ error: "Recorded Memory Answer not found" });
      return recallActivityDetailSchema.parse(detail);
    }
  );
  app.get(
    "/v1/memory/recall-activity/questions",
    {
      preHandler: context.rateLimit.memoryRead
    },
    async (request, reply) => {
      const user = await context.auth.authenticateApiToken(request);
      // This Desktop surface uses Personal API Tokens. Delegated Team grants do
      // not implicitly authorize Personal history inspection.
      if (context.auth.authenticatedCredentialKind(request) !== "api_token") {
        return reply.code(403).send({ error: "Personal API Token required" });
      }
      const query = request.query as Record<string, unknown>;
      let cursor;
      if (query.cursor !== undefined) {
        try {
          if (typeof query.cursor !== "string" || query.cursor.length > 512)
            throw new Error();
          cursor = recallActivityCursorSchema.parse(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))
          );
        } catch {
          return reply
            .code(400)
            .send({ error: "Invalid Recall activity cursor" });
        }
      }
      const input = recallActivityListInputSchema.parse({
        ...query,
        cursor,
        hydrate:
          query.hydrate === undefined
            ? undefined
            : query.hydrate === "true"
              ? true
              : query.hydrate === "false"
                ? false
                : query.hydrate,
        contentIds:
          typeof query.contentIds === "string"
            ? query.contentIds.split(",")
            : query.contentIds,
        limit: query.limit === undefined ? 50 : Number(query.limit)
      });
      reply.header("cache-control", "no-store");
      return recallActivityPageSchema.parse(
        await context
          .requireRepository()
          .listRecallActivity({ userId: user.id }, input)
      );
    }
  );
};
