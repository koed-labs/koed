import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createOpaqueSecret } from "../auth/session.js";
import type { ApiRouteContext } from "../server/context.js";
import { createApiTokenSchema } from "./schemas.js";

export const registerApiTokenRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateSession, hashSecret },
    rateLimit: { auth: authRateLimit }
  } = context;

  app.post("/api-tokens", { preHandler: authRateLimit }, async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);
    const input = createApiTokenSchema.parse(request.body);
    const token = createOpaqueSecret("cmt");
    const record = await repo.createApiToken({
      ownerUserId: user.id,
      name: input.name,
      tokenHash: hashSecret(token),
      tokenPrefix: token.slice(0, 12),
      scopes: []
    });

    return { token, apiToken: record };
  });

  app.get("/api-tokens", async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);

    return { apiTokens: await repo.listApiTokens(user.id) };
  });

  app.delete("/api-tokens/:id", async (request, reply) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await repo.revokeApiToken(user.id, params.id);

    return reply.status(deleted ? 200 : 404).send({ ok: deleted });
  });
};
