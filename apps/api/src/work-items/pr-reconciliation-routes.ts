import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  readDesktopLocalCredentialAuthorization,
  verifyDesktopLocalCredentialAuthorization,
  workItemSchema
} from "@koed/shared";
import {
  WorkItemConflictError,
  WorkItemTransitionError,
  WorkItemUnavailableError
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";
import type { WorkItemPrReconciler } from "./pr-reconciliation.js";

const paramsSchema = z
  .object({ projectId: z.uuid(), itemId: z.uuid() })
  .strict();
export const authenticateWorkItemSourceControl = async (
  request: FastifyRequest,
  context: ApiRouteContext
) => {
  if (
    !["developer", "local_personal"].includes(context.config.deploymentProfile)
  )
    throw Object.assign(
      new Error("Local Project source control is unavailable"),
      {
        statusCode: 403
      }
    );
  const user = await authenticateProjectOperation(
    request,
    {
      deploymentProfile: context.config.deploymentProfile,
      koedHome: context.config.koedHome,
      auth: context.auth
    },
    true
  );
  const authorization = request.headers.authorization?.trim();
  if (authorization?.startsWith("Koed-Desktop ")) {
    const stored = readDesktopLocalCredentialAuthorization(
      context.config.koedHome
    );
    const verified = stored
      ? verifyDesktopLocalCredentialAuthorization(
          context.config.koedHome,
          authorization,
          { ownerUserId: user.id, operationFamily: "managed_source_control" }
        )
      : null;
    if (!verified)
      throw Object.assign(new Error("Source-control authority is required"), {
        statusCode: 403
      });
  } else {
    const sourceControlUser =
      await context.auth.authenticateSessionOrDeviceCredential(
        request,
        "managed_source_control",
        { apiTokenError: "API Tokens cannot reconcile Work Item PRs" }
      );
    if (sourceControlUser.id !== user.id)
      throw Object.assign(new Error("Work Item owner changed"), {
        statusCode: 403
      });
  }
  return user;
};

export const registerWorkItemPrReconciliationRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  reconcile: WorkItemPrReconciler | null
) => {
  app.post(
    "/v1/projects/:projectId/work-items/:itemId/reconcile-pr",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateWorkItemSourceControl(request, context);
      const { projectId, itemId } = paramsSchema.parse(request.params);
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if (!reconcile)
        return reply
          .code(503)
          .send({ message: "PR reconciliation is unavailable" });
      try {
        return {
          workItem: workItemSchema.parse(
            await reconcile(user.id, projectId, itemId)
          )
        };
      } catch (error) {
        if (error instanceof WorkItemConflictError)
          return reply
            .code(409)
            .send({ message: error.message, current: error.current });
        if (error instanceof WorkItemTransitionError)
          return reply.code(409).send({ message: error.message });
        if (error instanceof WorkItemUnavailableError)
          return reply.code(404).send({ message: error.message });
        throw error;
      }
    }
  );
};
