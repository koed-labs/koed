import type { FastifyRequest } from "fastify";
import {
  readDesktopLocalCredentialAuthorization,
  verifyDesktopLocalCredentialAuthorization
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";

const localProfiles = new Set(["developer", "local_personal"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** HQ launch requires both owner Project write and Managed Conversation authority. */
export async function authenticateHqManagedWrite(
  request: FastifyRequest,
  context: ApiRouteContext
): Promise<{ id: string }> {
  const authorization = request.headers.authorization?.trim();
  if (authorization?.startsWith("Koed-Desktop")) {
    if (
      !localProfiles.has(context.config.deploymentProfile) ||
      !loopbackAddresses.has(request.raw.socket?.remoteAddress ?? "")
    )
      throw Object.assign(new Error("Desktop HQ launch requires loopback"), {
        statusCode: 403
      });
    const stored = readDesktopLocalCredentialAuthorization(
      context.config.koedHome
    );
    const ownerUserId = stored?.ownerUserId;
    const project = ownerUserId
      ? verifyDesktopLocalCredentialAuthorization(
          context.config.koedHome,
          authorization,
          { ownerUserId, operationFamily: "personal_collaboration_write" }
        )
      : null;
    const managed = ownerUserId
      ? verifyDesktopLocalCredentialAuthorization(
          context.config.koedHome,
          authorization,
          { ownerUserId, operationFamily: "managed_execution" }
        )
      : null;
    if (!project || !managed)
      throw Object.assign(new Error("Invalid Desktop HQ credential"), {
        statusCode: 403
      });
    return { id: ownerUserId! };
  }
  const project = await context.auth.authenticateSessionOrDeviceCredential(
    request,
    "personal_collaboration_write",
    { apiTokenError: "API Tokens cannot authorize Project HQ launch" }
  );
  const managed = await context.auth.authenticateSessionOrDeviceCredential(
    request,
    "managed_execution",
    { apiTokenError: "API Tokens cannot authorize Project HQ launch" }
  );
  if (project.id !== managed.id)
    throw Object.assign(new Error("HQ authority owner mismatch"), {
      statusCode: 403
    });
  return { id: project.id };
}
