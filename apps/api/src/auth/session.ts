import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  DeviceCredentialAuthContext,
  MemorySourceRepository
} from "@koed/db";
import type { AuthLogKind } from "../server/logging.js";

export const sessionCookieName = "cm_session";
export const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

export type HashSecret = (secret: string) => string;

export const createHashSecret =
  (apiTokenPepper: string): HashSecret =>
  (secret: string): string =>
    createHash("sha256").update(`${apiTokenPepper}${secret}`).digest("hex");

export const createOpaqueSecret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

export const publicUser = (user: {
  id: string;
  email: string;
  displayName: string | null;
}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName
});

export interface AuthHelpers {
  hashSecret: HashSecret;
  setSessionCookie(reply: FastifyReply, secret: string): void;
  authenticate(request: FastifyRequest): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    passwordHash?: string | null;
  }>;
  authenticateSession(request: FastifyRequest): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    passwordHash?: string | null;
  }>;
  authenticateApiToken(request: FastifyRequest): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    passwordHash?: string | null;
  }>;
  authenticateDeviceCredential(
    request: FastifyRequest
  ): Promise<DeviceCredentialAuthContext>;
  authenticateSessionOrDeviceCredential(
    request: FastifyRequest,
    operationFamily:
      | "team_workspace_read"
      | "share_grant_management"
      | "capture_writes"
      | "sync"
      | "admin",
    options?: { apiTokenError?: string }
  ): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    passwordHash?: string | null;
  }>;
}

export const createAuthHelpers = (
  requireRepository: () => MemorySourceRepository,
  options: {
    hashSecret: HashSecret;
    cookieSecure: boolean;
    recordAuthContext?: (
      request: FastifyRequest,
      context: {
        kind: Exclude<AuthLogKind, "anonymous">;
        userId: string;
      }
    ) => void;
  }
): AuthHelpers => {
  const { hashSecret } = options;
  const readAuthorizationCredential = (
    request: FastifyRequest,
    expectedScheme: string
  ): string | null => {
    const authHeader = request.headers.authorization?.trim();
    const separatorIndex = authHeader?.indexOf(" ") ?? -1;
    if (!authHeader || separatorIndex <= 0) {
      return null;
    }
    const scheme = authHeader.slice(0, separatorIndex);
    if (scheme.toLowerCase() !== expectedScheme.toLowerCase()) {
      return null;
    }
    return authHeader.slice(separatorIndex + 1).trim() || null;
  };
  const recordAuthContext = (
    request: FastifyRequest,
    kind: Exclude<AuthLogKind, "anonymous">,
    userId: string
  ): void => {
    options.recordAuthContext?.(request, { kind, userId });
  };
  const setSessionCookie = (reply: FastifyReply, secret: string): void => {
    reply.setCookie(sessionCookieName, secret, {
      httpOnly: true,
      sameSite: "lax",
      secure: options.cookieSecure,
      path: "/",
      maxAge: Math.floor(sessionTtlMs / 1000)
    });
  };

  const authenticate = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const bearer = readAuthorizationCredential(request, "Bearer");

    if (bearer) {
      const user = await repo.getApiTokenUser(hashSecret(bearer));
      if (user) {
        recordAuthContext(request, "api_token", user.id);
        return user;
      }
    }

    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      const user = await repo.getSessionUser(hashSecret(sessionSecret));
      if (user) {
        recordAuthContext(request, "session", user.id);
        return user;
      }
    }

    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  };

  const authenticateSession = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      const user = await repo.getSessionUser(hashSecret(sessionSecret));
      if (user) {
        recordAuthContext(request, "session", user.id);
        return user;
      }
    }

    throw Object.assign(new Error("Session cookie required"), {
      statusCode: 401
    });
  };

  const authenticateApiToken = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const bearer = readAuthorizationCredential(request, "Bearer");
    if (!bearer) {
      throw Object.assign(new Error("Bearer API token required"), {
        statusCode: 401
      });
    }
    const user = await repo.getApiTokenUser(hashSecret(bearer));
    if (!user) {
      throw Object.assign(new Error("Invalid API token"), { statusCode: 401 });
    }
    recordAuthContext(request, "api_token", user.id);
    return user;
  };

  const authenticateDeviceCredential = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const credential = readAuthorizationCredential(request, "Koed-Device");
    const separatorIndex = credential?.indexOf(":") ?? -1;
    const credentialKeyId =
      credential && separatorIndex > 0
        ? credential.slice(0, separatorIndex)
        : null;
    const secret =
      credential && separatorIndex > 0
        ? credential.slice(separatorIndex + 1)
        : null;
    if (!credentialKeyId || !secret) {
      throw Object.assign(new Error("Device credential required"), {
        statusCode: 401
      });
    }

    const context = await repo.getDeviceCredentialUser({
      credentialKeyId,
      verifierHash: hashSecret(secret)
    });
    if (!context) {
      throw Object.assign(new Error("Invalid device credential"), {
        statusCode: 401
      });
    }
    recordAuthContext(request, "device_credential", context.user.id);
    return context;
  };

  const authenticateSessionOrDeviceCredential = async (
    request: FastifyRequest,
    operationFamily:
      | "team_workspace_read"
      | "share_grant_management"
      | "capture_writes"
      | "sync"
      | "admin",
    options: { apiTokenError?: string } = {}
  ) => {
    const authHeader = request.headers.authorization?.trim();
    const separatorIndex = authHeader?.indexOf(" ") ?? -1;
    const authScheme =
      authHeader && separatorIndex > 0
        ? authHeader.slice(0, separatorIndex).toLowerCase()
        : "";
    if (authScheme === "bearer") {
      throw Object.assign(
        new Error(
          options.apiTokenError ??
            "Session cookie or scoped device credential required"
        ),
        { statusCode: 403 }
      );
    }
    if (authScheme === "koed-device") {
      const context = await authenticateDeviceCredential(request);
      if (
        !context.credential.operationFamilies.includes(operationFamily) &&
        !context.credential.operationFamilies.includes("*")
      ) {
        throw Object.assign(
          new Error("Device credential is not allowed for this operation"),
          { statusCode: 403 }
        );
      }
      return context.user;
    }
    return await authenticateSession(request);
  };

  return {
    hashSecret,
    setSessionCookie,
    authenticate,
    authenticateSession,
    authenticateApiToken,
    authenticateDeviceCredential,
    authenticateSessionOrDeviceCredential
  };
};
