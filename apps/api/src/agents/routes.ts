import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentsRepository } from "@koed/db";
import { AgentInstanceUnavailableError, AgentNotFoundError } from "@koed/db";
import {
  agentBootstrapContextSchema,
  agentCreateSchema,
  agentPatchSchema,
  agentSchema
} from "@koed/shared/agent-contract";
import {
  readDesktopLocalCredentialAuthorization,
  verifyDesktopLocalCredentialAuthorization
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";

const localProfiles = new Set(["developer", "local_personal"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const idParams = z.object({ id: z.uuid() }).strict();
const chiefBody = z
  .object({ aiClientInstanceId: agentSchema.shape.aiClientInstanceId })
  .strict();

export function registerAgentRoutes(
  app: FastifyInstance,
  input: {
    repository: AgentsRepository | null;
    auth: ApiRouteContext["auth"];
    deploymentProfile: string;
    koedHome?: string;
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) {
  const repository = () => {
    if (!localProfiles.has(input.deploymentProfile))
      throw Object.assign(new Error("Agents require a local profile"), {
        statusCode: 403
      });
    if (!input.repository)
      throw Object.assign(new Error("Agents are unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const authenticate = async (request: FastifyRequest, write: boolean) => {
    const authorization = request.headers.authorization?.trim();
    if (authorization?.startsWith("Koed-Desktop")) {
      if (
        !input.koedHome ||
        !loopbackAddresses.has(request.raw.socket?.remoteAddress ?? "")
      )
        throw Object.assign(
          new Error("Desktop Agent access requires local loopback"),
          { statusCode: 403 }
        );
      const stored = readDesktopLocalCredentialAuthorization(input.koedHome);
      const verified = stored
        ? verifyDesktopLocalCredentialAuthorization(
            input.koedHome,
            authorization,
            {
              ownerUserId: stored.ownerUserId,
              operationFamily: write
                ? "personal_collaboration_write"
                : "personal_collaboration_read"
            }
          )
        : null;
      if (!verified)
        throw Object.assign(new Error("Invalid Desktop local credential"), {
          statusCode: 401
        });
      return { id: verified.ownerUserId };
    }
    return input.auth.authenticateSessionOrDeviceCredential(
      request,
      write ? "personal_collaboration_write" : "personal_collaboration_read",
      { apiTokenError: "API Tokens cannot authorize Agent operations" }
    );
  };
  const handle = (error: unknown) => {
    if (error instanceof AgentInstanceUnavailableError)
      throw Object.assign(error, { statusCode: 409 });
    if (error instanceof AgentNotFoundError)
      throw Object.assign(error, { statusCode: 404 });
    throw error;
  };
  app.get(
    "/v1/agents/bootstrap-context",
    { preHandler: input.readRateLimit },
    async (request) => {
      const repo = repository();
      const owner = await authenticate(request, false);
      return agentBootstrapContextSchema.parse(
        await repo.bootstrapContext(owner.id)
      );
    }
  );
  app.get(
    "/v1/agents",
    { preHandler: input.readRateLimit },
    async (request) => {
      const repo = repository();
      const owner = await authenticate(request, false);
      return {
        agents: (await repo.list(owner.id)).map((item) =>
          agentSchema.parse(item)
        )
      };
    }
  );
  app.post(
    "/v1/agents/chief:ensure",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const repo = repository();
      const owner = await authenticate(request, true);
      const parsed = chiefBody.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ message: "Invalid Chief of Staff request" });
      const body = parsed.data;
      try {
        return {
          agent: agentSchema.parse(
            await repo.ensureChief(owner.id, body.aiClientInstanceId)
          )
        };
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/agents/helpers:ensure",
    { preHandler: input.writeRateLimit },
    async (request) => {
      const repo = repository();
      const owner = await authenticate(request, true);
      try {
        return {
          agents: (await repo.ensureHelpers(owner.id)).map((agent) =>
            agentSchema.parse(agent)
          )
        };
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/agents",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const repo = repository();
      const owner = await authenticate(request, true);
      const parsed = agentCreateSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ message: "Invalid Agent creation request" });
      const body = parsed.data;
      try {
        return reply.code(201).send({
          agent: agentSchema.parse(await repo.create(owner.id, body))
        });
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.patch(
    "/v1/agents/:id",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const repo = repository();
      const owner = await authenticate(request, true);
      const params = idParams.safeParse(request.params);
      const parsed = agentPatchSchema.safeParse(request.body);
      if (!params.success || !parsed.success)
        return reply
          .code(400)
          .send({ message: "Invalid Agent update request" });
      const { id } = params.data;
      const body = parsed.data;
      try {
        return {
          agent: agentSchema.parse(await repo.patch(owner.id, id, body))
        };
      } catch (error) {
        return handle(error);
      }
    }
  );
}
