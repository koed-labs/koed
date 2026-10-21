import type { FastifyInstance } from "fastify";
import type {
  ProjectActivityRepository,
  ProjectSourceRepository
} from "@koed/db";
import {
  ProjectActivityCursorError,
  ProjectActivityUnavailableError
} from "@koed/db";
import { z } from "zod";
import { projectActivityPageSchema, projectSeenSchema } from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectRead } from "./desktop-read-auth.js";

const params = z.object({ id: z.uuid() }).strict();
const page = z
  .object({
    after: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100)
  })
  .strict();
const acknowledgement = z
  .object({ cursor: z.string().min(1).max(500) })
  .strict();

export const registerProjectActivityRoutes = (
  app: FastifyInstance,
  input: {
    repository: ProjectActivityRepository | null;
    sourceRepository?: ProjectSourceRepository | null;
    deploymentProfile: string;
    koedHome?: string;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) => {
  const repository = () => {
    if (
      input.deploymentProfile !== "local_personal" &&
      input.deploymentProfile !== "developer"
    )
      throw Object.assign(
        new Error("Personal Projects require a local deployment"),
        { statusCode: 403 }
      );
    if (!input.repository)
      throw Object.assign(new Error("Project activity is unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const handle = (
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    error: unknown
  ) => {
    if (error instanceof ProjectActivityUnavailableError)
      return reply.code(404).send({ message: error.message });
    if (error instanceof ProjectActivityCursorError)
      return reply.code(400).send({ message: error.message });
    throw error;
  };
  app.get(
    "/v1/projects/:id/activity",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectRead(request, input);
      const { id } = params.parse(request.params);
      const query = page.safeParse(request.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ message: "Invalid Project activity page" });
      try {
        const listed = await repository().list(user.id, id, query.data);
        const attempts = listed.items
          .filter(
            (item) =>
              item.kind === "source_ready" || item.kind === "source_failed"
          )
          .map((item) => item.ref);
        const outcomes = input.sourceRepository
          ? await input.sourceRepository.resolveActivityOutcomes(
              user.id,
              id,
              attempts
            )
          : [];
        const byAttempt = new Map(
          outcomes.map((item) => [item.attemptId, item])
        );
        return projectActivityPageSchema.parse({
          ...listed,
          items: listed.items.map((item) => {
            const source = byAttempt.get(item.ref);
            return source &&
              ((item.kind === "source_ready" && source.status === "ready") ||
                (item.kind === "source_failed" && source.status === "failed"))
              ? {
                  ...item,
                  sourceOutcome: {
                    sourceId: source.sourceId,
                    name: source.name,
                    status: source.status
                  }
                }
              : item;
          })
        });
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/projects/:id/activity/seen",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectRead(request, input);
      const { id } = params.parse(request.params);
      try {
        return projectSeenSchema.parse(await repository().seen(user.id, id));
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.put(
    "/v1/projects/:id/activity/seen",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await input.auth.authenticateSessionOrDeviceCredential(
        request,
        "personal_collaboration_write",
        { apiTokenError: "API Tokens cannot authorize Project operations" }
      );
      const { id } = params.parse(request.params);
      const body = acknowledgement.safeParse(request.body);
      if (!body.success)
        return reply
          .code(400)
          .send({ message: "Invalid Project activity acknowledgement" });
      try {
        return projectSeenSchema.parse(
          await repository().acknowledge(user.id, id, body.data.cursor)
        );
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
};
