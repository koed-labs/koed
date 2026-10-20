import type { FastifyRequest } from "fastify";
import {
  readDesktopLocalCredentialAuthorization,
  verifyDesktopLocalCredentialAuthorization
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";

const localProfiles = new Set(["developer", "local_personal"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** An existing local Desktop credential is scoped to one owner's Personal Projects. */
export async function authenticateProjectOperation(
  request: FastifyRequest,
  input: {
    deploymentProfile: string;
    koedHome?: string;
    auth: ApiRouteContext["auth"];
  },
  write: boolean
): Promise<{ id: string }> {
  const authorization = request.headers.authorization?.trim();
  if (authorization?.startsWith("Koed-Desktop")) {
    if (!localProfiles.has(input.deploymentProfile) || !input.koedHome)
      throw Object.assign(
        new Error("Desktop Project operations require a local profile"),
        { statusCode: 403 }
      );
    const address = request.raw.socket?.remoteAddress ?? "";
    if (!loopbackAddresses.has(address))
      throw Object.assign(
        new Error("Desktop local credential requires loopback"),
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
  return await input.auth.authenticateSessionOrDeviceCredential(
    request,
    write ? "personal_collaboration_write" : "personal_collaboration_read",
    { apiTokenError: "API Tokens cannot authorize Project operations" }
  );
}

export const authenticateProjectRead = (
  request: FastifyRequest,
  input: Parameters<typeof authenticateProjectOperation>[1]
) => authenticateProjectOperation(request, input, false);
