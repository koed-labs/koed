import type { FastifyInstance } from "fastify";
import type { MemorySourceRepository } from "@koed/db";
import {
  managedProjectRecallContextSchema,
  verifyDesktopLocalCredentialAuthorization
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";

const unavailable = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 409 });
};

/** Only a live owner-managed command can bind its logical Session to a Project link. */
export const registerManagedRecallContextRoutes = (
  app: FastifyInstance,
  input: {
    repository: MemorySourceRepository | null;
    auth: ApiRouteContext["auth"];
    deploymentProfile: string;
    koedHome: string;
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
  }
) => {
  app.get(
    "/v1/managed-conversations/:executionId/recall-context",
    { preHandler: input.readRateLimit },
    async (request) => {
      const authorization = request.headers.authorization?.trim();
      if (!authorization?.startsWith("Koed-Desktop "))
        return unavailable("Managed recall requires a local owner credential");
      const actor = await authenticateProjectOperation(request, input, false);
      if (
        !verifyDesktopLocalCredentialAuthorization(
          input.koedHome,
          authorization,
          { ownerUserId: actor.id, operationFamily: "managed_execution" }
        )
      )
        return unavailable("Managed recall requires execution authority");
      const { executionId } = z
        .object({ executionId: z.uuid() })
        .strict()
        .parse(request.params);
      const { executionGeneration } = z
        .object({
          executionGeneration: z.coerce.number().int().positive()
        })
        .strict()
        .parse(request.query);
      const repo = input.repository;
      if (!repo) return unavailable("Managed recall is unavailable");
      const current = async () => {
        const [execution, command, context] = await Promise.all([
          repo.getManagedConversationExecution(
            { userId: actor.id },
            executionId
          ),
          repo.getLatestManagedConversationCommandForExecution(
            { userId: actor.id },
            executionId
          ),
          repo.getManagedConversationRecallContext(
            { userId: actor.id },
            { executionId, executionGeneration }
          )
        ]);
        if (
          !execution ||
          !command ||
          !context ||
          execution.ownerUserId !== actor.id ||
          execution.executionGeneration !== executionGeneration ||
          !["starting", "running", "reconciling"].includes(execution.state) ||
          command.executionId !== executionId ||
          command.executionGeneration !== executionGeneration ||
          command.state !== "dispatching" ||
          !command.leaseToken ||
          !command.leaseExpiresAt ||
          Date.parse(command.leaseExpiresAt) <= Date.now()
        )
          return unavailable("Managed recall command is no longer active");
        return {
          commandId: command.id,
          leaseToken: command.leaseToken,
          context
        };
      };
      const before = await current();
      const after = await current();
      if (JSON.stringify(after) !== JSON.stringify(before))
        return unavailable("Managed recall Project link changed");
      return managedProjectRecallContextSchema.parse(before.context);
    }
  );
};
