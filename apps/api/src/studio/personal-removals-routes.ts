import type { MemorySourceRepository } from "@koed/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[-A-Za-z0-9._:%!~*'()]+$/);
const removalSchema = z
  .object({
    kind: z.enum(["project", "conversation"]),
    id: identifier,
    aliases: z.array(identifier).max(32).default([]),
    removed: z.boolean()
  })
  .strict();

type PersonalStudioRemovalsRepository = Pick<
  MemorySourceRepository,
  "listPersonalStudioRemovals" | "setPersonalStudioRemoval"
>;

export const registerPersonalStudioRemovalRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  repository: () => PersonalStudioRemovalsRepository = () =>
    context.requireRepository()
) => {
  app.get("/v1/studio/personal-removals", async (request, reply) => {
    try {
      const user = await context.auth.authenticate(request);
      const removals = await repository().listPersonalStudioRemovals({
        userId: user.id
      });
      return reply.send({ removals });
    } catch (error) {
      return reply
        .code(Number((error as { statusCode?: number })?.statusCode) || 500)
        .send({ error: "personal_removals_unavailable" });
    }
  });

  app.put("/v1/studio/personal-removals", async (request, reply) => {
    const parsed = removalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      const user = await context.auth.authenticate(request);
      await repository().setPersonalStudioRemoval(
        { userId: user.id },
        parsed.data
      );
      return reply.send({ ok: true });
    } catch (error) {
      return reply
        .code(Number((error as { statusCode?: number })?.statusCode) || 500)
        .send({ error: "personal_removals_unavailable" });
    }
  });
};
