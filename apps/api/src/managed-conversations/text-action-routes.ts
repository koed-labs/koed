import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ManagedTextActionRepository } from "@koed/db/managed-text-action-contract";
import {
  koedTextActionDeliverySchema,
  koedTextActionReviewSchema,
  parseKoedTextActionArguments,
  verifyDesktopLocalCredentialAuthorization
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";

const params = z.object({ executionId: z.uuid() }).strict();
const actionParams = params.extend({ actionId: z.uuid() }).strict();
const claimBody = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw Object.assign(new Error("Invalid Koed text action request"), {
      statusCode: 400
    });
  return result.data;
};

/** Owner-local entry point for leased AI Client proposals and Desktop review. */
export const registerManagedTextActionRoutes = (
  app: FastifyInstance,
  input: {
    repository: ManagedTextActionRepository | null;
    applyTeamTodoAdd?: (input: {
      ownerUserId: string;
      projectId: string;
      teamBackendId: string;
      workspaceProjectId: string;
      actionId: string;
      effectNonce: string;
      title: string;
      goal: string;
      dueOn: string | null;
      expectedProjectVersion: number;
      expectedMemberVersion: number;
    }) => Promise<void>;
    auth: ApiRouteContext["auth"];
    deploymentProfile: string;
    koedHome: string;
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) => {
  const repository = () => {
    if (!input.repository)
      throw Object.assign(new Error("Koed text actions are unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const authenticate = async (request: FastifyRequest, write: boolean) => {
    const authorization = request.headers.authorization?.trim();
    if (!authorization?.startsWith("Koed-Desktop "))
      throw Object.assign(new Error("Local Desktop credential required"), {
        statusCode: 403
      });
    const actor = await authenticateProjectOperation(request, input, write);
    if (
      !verifyDesktopLocalCredentialAuthorization(
        input.koedHome,
        authorization,
        {
          ownerUserId: actor.id,
          operationFamily: "managed_execution"
        }
      )
    )
      throw Object.assign(new Error("Managed execution credential required"), {
        statusCode: 403
      });
    return { userId: actor.id };
  };
  app.post(
    "/v1/managed-conversations/:executionId/text-actions",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { executionId } = parsed(params, request.params);
      const body = parsed(koedTextActionDeliverySchema, request.body);
      let argumentsValue: Record<string, unknown>;
      try {
        argumentsValue = parseKoedTextActionArguments(
          body.name,
          body.arguments
        );
      } catch {
        throw Object.assign(new Error("Invalid Koed action arguments"), {
          statusCode: 400
        });
      }
      const action = await repository().enqueueManagedTextAction(actor, {
        executionId,
        commandId: body.commandId,
        leaseToken: body.leaseToken,
        executionGeneration: body.executionGeneration,
        providerTurnId: body.providerTurnId,
        toolCallId: body.toolCallId,
        name: body.name,
        arguments: argumentsValue
      });
      if (!action)
        return reply.code(409).send({ message: "Managed User turn changed" });
      return reply.code(202).send({ status: "recorded", action });
    }
  );
  app.get(
    "/v1/managed-conversations/:executionId/text-actions",
    { preHandler: input.readRateLimit },
    async (request) => {
      const actor = await authenticate(request, false);
      const { executionId } = parsed(params, request.params);
      return {
        actions: await repository().listManagedTextActions(actor, executionId)
      };
    }
  );
  app.get(
    "/v1/managed-conversations/:executionId/text-actions/:actionId",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { executionId, actionId } = parsed(actionParams, request.params);
      const action = await repository().reconcileManagedTextAction(actor, {
        executionId,
        actionId
      });
      if (!action)
        return reply.code(404).send({ message: "Koed action not found" });
      return { action };
    }
  );
  app.post(
    "/v1/managed-conversations/:executionId/text-actions/:actionId/review",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { executionId, actionId } = parsed(actionParams, request.params);
      const body = parsed(
        koedTextActionReviewSchema.omit({ actionId: true }),
        request.body
      );
      const action = await repository().decideManagedTextAction(actor, {
        executionId,
        actionId,
        ...body
      });
      if (!action)
        return reply.code(409).send({ message: "Koed action review changed" });
      return { action };
    }
  );
  app.post(
    "/v1/managed-conversations/:executionId/text-actions/:actionId/claim",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { executionId, actionId } = parsed(actionParams, request.params);
      const body = parsed(claimBody, request.body);
      const action = await repository().claimManagedTextAction(actor, {
        executionId,
        actionId,
        expectedRevision: body.expectedRevision
      });
      if (!action)
        return reply
          .code(409)
          .send({ message: "Koed action authority changed" });
      return { action };
    }
  );
  app.post(
    "/v1/managed-conversations/:executionId/text-actions/:actionId/complete",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { executionId, actionId } = parsed(actionParams, request.params);
      const body = parsed(claimBody, request.body);
      const action = await repository().completeManagedTextAction(actor, {
        executionId,
        actionId,
        expectedRevision: body.expectedRevision
      });
      if (!action)
        return reply
          .code(409)
          .send({ message: "Koed action effect is not verified" });
      return { action };
    }
  );
  app.post(
    "/v1/managed-conversations/:executionId/text-actions/:actionId/apply-team-todo-add",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { executionId, actionId } = parsed(actionParams, request.params);
      const body = parsed(claimBody, request.body);
      if (!input.applyTeamTodoAdd)
        return reply
          .code(503)
          .send({ message: "Team text actions unavailable" });
      const prepared = await repository().prepareManagedTextTeamTodoAdd(actor, {
        executionId,
        actionId,
        expectedRevision: body.expectedRevision
      });
      if (!prepared)
        return reply
          .code(409)
          .send({ message: "Team text action authority changed" });
      await input.applyTeamTodoAdd({
        ownerUserId: actor.userId,
        projectId: String(prepared.action.arguments.projectId),
        teamBackendId: String(prepared.action.snapshot.teamBackendId),
        workspaceProjectId: String(prepared.action.snapshot.workspaceProjectId),
        actionId: prepared.action.id,
        effectNonce: prepared.effectNonce,
        title: String(prepared.action.arguments.title),
        goal: String(
          prepared.action.arguments.goal ?? prepared.action.arguments.title
        ),
        dueOn:
          typeof prepared.action.arguments.dueOn === "string"
            ? prepared.action.arguments.dueOn
            : null,
        expectedProjectVersion: Number(
          prepared.action.snapshot.teamProjectVersion
        ),
        expectedMemberVersion: Number(
          prepared.action.snapshot.teamMemberVersion
        )
      });
      return { action: prepared.action };
    }
  );
};
