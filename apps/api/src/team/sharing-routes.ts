import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import { readTeamSharing } from "./sharing-read.js";

export const registerTeamSharingRoutes = (
  app: FastifyInstance,
  input: {
    pool: pg.Pool | null;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
  }
) => {
  app.get(
    "/v1/me/sharing",
    { preHandler: input.readRateLimit },
    async (request) => {
      if (Object.keys(request.query as object).length !== 0) {
        throw Object.assign(new Error("Sharing read accepts no filters"), {
          statusCode: 400
        });
      }
      const actor = await input.auth.authenticateSessionOrDeviceCredential(
        request,
        "team_workspace_read",
        {
          apiTokenError: "Personal API Tokens cannot access Team sharing"
        }
      );
      if (!input.pool)
        throw Object.assign(new Error("Team sharing is unavailable"), {
          statusCode: 503
        });
      return readTeamSharing(input.pool, actor.id);
    }
  );
};
