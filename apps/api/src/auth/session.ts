import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {} from "@fastify/cookie";
import type {
  DeviceCredentialAuthContext,
  MemorySourceRepository,
  UserSessionContext
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
  resolveApiTokenUser(request: FastifyRequest): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    passwordHash?: string | null;
  } | null>;
  resolveDeviceCredentialContext(
    request: FastifyRequest
  ): Promise<DeviceCredentialAuthContext | null>;
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
  authenticateSessionContext(
    request: FastifyRequest
  ): Promise<UserSessionContext>;
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
      | "personal_collaboration_read"
      | "personal_collaboration_write"
      | "team_workspace_read"
      | "team_chat_read"
      | "team_chat_write"
      | "share_grant_management"
      | "capture_writes"
      | "sync"
      | "managed_execution"
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
  const apiTokenUsers = new WeakMap<
    FastifyRequest,
    Promise<{
      id: string;
      email: string;
      displayName: string | null;
      passwordHash?: string | null;
    } | null>
  >();
  const deviceCredentialContexts = new WeakMap<
    FastifyRequest,
    Promise<DeviceCredentialAuthContext | null>
  >();
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

  const resolveApiTokenUser = (request: FastifyRequest) => {
    const cached = apiTokenUsers.get(request);
    if (cached) {
      return cached;
    }
    const bearer = readAuthorizationCredential(request, "Bearer");
    const lookup = bearer
      ? requireRepository().getApiTokenUser(hashSecret(bearer))
      : Promise.resolve(null);
    apiTokenUsers.set(request, lookup);
    return lookup;
  };

  const readDeviceCredential = (
    request: FastifyRequest
  ): { credentialKeyId: string; secret: string } | null => {
    const credential = readAuthorizationCredential(request, "Koed-Device");
    const separatorIndex = credential?.indexOf(":") ?? -1;
    if (!credential || separatorIndex <= 0) {
      return null;
    }
    const credentialKeyId = credential.slice(0, separatorIndex);
    const secret = credential.slice(separatorIndex + 1);
    return credentialKeyId && secret ? { credentialKeyId, secret } : null;
  };

  const resolveDeviceCredentialContext = (request: FastifyRequest) => {
    const cached = deviceCredentialContexts.get(request);
    if (cached) {
      return cached;
    }
    const credential = readDeviceCredential(request);
    const lookup = credential
      ? requireRepository().getDeviceCredentialUser({
          credentialKeyId: credential.credentialKeyId,
          verifierHash: hashSecret(credential.secret)
        })
      : Promise.resolve(null);
    deviceCredentialContexts.set(request, lookup);
    return lookup;
  };

  const authenticate = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const apiTokenUser = await resolveApiTokenUser(request);
    if (apiTokenUser) {
      recordAuthContext(request, "api_token", apiTokenUser.id);
      return apiTokenUser;
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

  const authenticateSessionContext = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      const context = await repo.getSessionContext(hashSecret(sessionSecret));
      if (context) {
        recordAuthContext(request, "session", context.user.id);
        return context;
      }
    }

    throw Object.assign(new Error("Session cookie required"), {
      statusCode: 401
    });
  };

  const authenticateApiToken = async (request: FastifyRequest) => {
    const bearer = readAuthorizationCredential(request, "Bearer");
    if (!bearer) {
      throw Object.assign(new Error("Bearer API token required"), {
        statusCode: 401
      });
    }
    const user = await resolveApiTokenUser(request);
    if (!user) {
      throw Object.assign(new Error("Invalid API token"), { statusCode: 401 });
    }
    recordAuthContext(request, "api_token", user.id);
    return user;
  };

  const authenticateDeviceCredential = async (request: FastifyRequest) => {
    if (!readDeviceCredential(request)) {
      throw Object.assign(new Error("Device credential required"), {
        statusCode: 401
      });
    }
    const context = await resolveDeviceCredentialContext(request);
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
      | "personal_collaboration_read"
      | "personal_collaboration_write"
      | "team_workspace_read"
      | "team_chat_read"
      | "team_chat_write"
      | "share_grant_management"
      | "capture_writes"
      | "sync"
      | "managed_execution"
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
      if (!context.credential.operationFamilies.includes(operationFamily)) {
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
    resolveApiTokenUser,
    resolveDeviceCredentialContext,
    setSessionCookie,
    authenticate,
    authenticateSession,
    authenticateSessionContext,
    authenticateApiToken,
    authenticateDeviceCredential,
    authenticateSessionOrDeviceCredential
  };
};
