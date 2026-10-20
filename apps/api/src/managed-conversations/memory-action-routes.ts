import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { managedMemoryActionSchema } from "@koed/shared";
import type { ManagedMemoryActionRecord } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";

const executionParams = z.object({ executionId: z.uuid() }).strict();
const undoParams = executionParams.extend({ actionId: z.uuid() }).strict();
const present = (record: ManagedMemoryActionRecord) =>
  managedMemoryActionSchema.parse({
    id: record.id,
    executionId: record.executionId,
    actionKind: record.actionKind,
    state: record.state,
    outcome: record.result?.outcome ?? null,
    message: record.result?.message ?? "Memory action pending.",
    ...(record.result?.assertionId
      ? { assertionId: record.result.assertionId }
      : {}),
    ...(record.result?.sourceSessionId
      ? { sourceSessionId: record.result.sourceSessionId }
      : {}),
    ...(record.result?.proposalId
      ? { proposalId: record.result.proposalId }
      : {}),
    createdAt: record.createdAt,
    completedAt: record.completedAt
  });

export const registerManagedMemoryActionRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  // Match the existing Curated Undo boundary: local Desktop or owner session,
  // never a Personal API Token or a scoped device write credential.
  const owner = (request: FastifyRequest, write: boolean) =>
    request.headers.authorization?.trim().startsWith("Koed-Desktop ")
      ? authenticateProjectOperation(
          request,
          {
            deploymentProfile: context.config.deploymentProfile,
            koedHome: context.config.koedHome,
            auth: context.auth
          },
          write
        )
      : context.auth.authenticateSession(request);
  const execution = async (
    request: FastifyRequest,
    executionId: string,
    write: boolean
  ) => {
    const user = await owner(request, write);
    const repository = context.requireRepository();
    const current = await repository.getManagedConversationExecution(
      { userId: user.id },
      executionId
    );
    if (!current || current.ownerUserId !== user.id)
      throw Object.assign(new Error("Conversation unavailable."), {
        statusCode: 404
      });
    return { actor: { userId: user.id }, repository };
  };
  app.get(
    "/v1/managed-conversations/:executionId/memory-actions",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { executionId } = executionParams.parse(request.params);
      const { actor, repository } = await execution(
        request,
        executionId,
        false
      );
      return {
        operation: "list",
        executionId,
        actions: (
          await repository.listManagedMemoryActionResults(actor, executionId)
        ).map(present)
      };
    }
  );
  app.post(
    "/v1/managed-conversations/:executionId/memory-actions/:actionId/undo",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { executionId, actionId } = undoParams.parse(request.params);
      if (request.body !== undefined) z.object({}).strict().parse(request.body);
      const { actor, repository } = await execution(request, executionId, true);
      const action = await repository.undoManagedMemoryAction(
        actor,
        { actionId, executionId },
        (assertionId, suppressionToken) =>
          repository.unsuppressCuratedMemoryAssertion(actor, assertionId, {
            suppressionToken
          })
      );
      if (
        !action ||
        action.executionId !== executionId ||
        action.id !== actionId
      )
        throw Object.assign(new Error("Memory action Undo unavailable."), {
          statusCode: 409
        });
      return { operation: "undo", executionId, action: present(action) };
    }
  );
};
