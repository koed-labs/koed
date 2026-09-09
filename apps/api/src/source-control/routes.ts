import type { FastifyInstance, FastifyRequest } from "fastify";
import { defaultFreshAuthenticationMaxAgeMs } from "@koed/db";
import { z } from "zod";
import {
  readDesktopLocalCredentialAuthorization,
  sourceControlOperationSchema,
  sourceControlResultSchema,
  verifyDesktopLocalCredentialAuthorization
} from "@koed/shared";

import type { ApiRouteContext } from "../server/context.js";

const executionParamsSchema = z.object({ executionId: z.uuid() }).strict();
const localProfiles = new Set(["developer", "local_personal"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const isLoopbackRequest = (request: FastifyRequest): boolean =>
  loopbackAddresses.has(
    request.socket?.remoteAddress ?? request.raw.socket?.remoteAddress ?? ""
  );

export const registerSourceControlRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const authenticate = async (request: FastifyRequest, mutation: boolean) => {
    const authorization = request.headers.authorization?.trim();
    if (
      localProfiles.has(context.config.deploymentProfile) &&
      authorization?.startsWith("Koed-Desktop ")
    ) {
      if (!isLoopbackRequest(request)) {
        throw Object.assign(
          new Error("Desktop source-control access requires loopback"),
          { statusCode: 403 }
        );
      }
      const stored = readDesktopLocalCredentialAuthorization(
        context.config.koedHome
      );
      const verified = stored
        ? verifyDesktopLocalCredentialAuthorization(
            context.config.koedHome,
            authorization,
            {
              ownerUserId: stored.ownerUserId,
              operationFamily: "managed_source_control"
            }
          )
        : null;
      if (!verified) {
        throw Object.assign(new Error("Invalid Desktop local credential"), {
          statusCode: 401
        });
      }
      if (
        mutation &&
        request.headers["x-koed-desktop-source-control-approval"] !== "1"
      ) {
        throw Object.assign(
          new Error("Native source-control approval is required"),
          { statusCode: 403 }
        );
      }
      return { id: verified.ownerUserId };
    }
    if (mutation) {
      const value = request.headers.authorization?.trim() ?? "";
      if (/^(?:Bearer|Koed-Device)(?:\s|$)/i.test(value)) {
        throw Object.assign(
          new Error(
            "Source-control mutations require a fresh browser or native approval"
          ),
          { statusCode: 403 }
        );
      }
      const session = await context.auth.authenticateSessionContext(request);
      const ageMs = Date.now() - session.createdAt.getTime();
      if (
        !Number.isFinite(ageMs) ||
        ageMs < 0 ||
        ageMs > defaultFreshAuthenticationMaxAgeMs
      ) {
        throw Object.assign(
          new Error("Fresh browser authentication is required"),
          { statusCode: 403 }
        );
      }
      return session.user;
    }
    return await context.auth.authenticateSessionOrDeviceCredential(
      request,
      "managed_source_control",
      {
        apiTokenError:
          "Session cookie or scoped device credential required for source control"
      }
    );
  };

  app.post(
    "/v1/managed-conversations/:executionId/source-control",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { executionId } = executionParamsSchema.parse(request.params);
      const operation = sourceControlOperationSchema.parse(request.body);
      const user = await authenticate(request, "idempotencyKey" in operation);
      if (operation.executionId !== executionId) {
        throw Object.assign(
          new Error("Source-control execution identity conflicted"),
          { statusCode: 409 }
        );
      }
      return sourceControlResultSchema.parse(
        await context.sourceControl.runtime.execute(user.id, operation)
      );
    }
  );
};
