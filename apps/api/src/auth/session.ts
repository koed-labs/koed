import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {} from "@fastify/cookie";
import type {
  DeviceCredentialAuthContext,
  MemorySourceRepository,
  UserSessionContext
} from "@koed/db";
import type { AuthLogKind } from "../server/logging.js";
import {
  remoteMcpAccessTokenPrefix,
  type RemoteMcpDelegatedPrincipal
} from "./remote-mcp-oauth.js";
import { assertDelegatedRequestScope } from "./remote-mcp-scopes.js";

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
  authenticateMemoryAnswerTask(
    request: FastifyRequest,
    mode: "read" | "execution",
    requestedTeam?: boolean
  ): Promise<{
    user: { id: string };
    allowTeam: boolean;
    allowPersonal: boolean;
  }>;
  hashSecret: HashSecret;
  resolveDelegatedPrincipal(
    request: FastifyRequest
  ): Promise<RemoteMcpDelegatedPrincipal | null>;
  resolveApiTokenUser(request: FastifyRequest): Promise<{
    id: string;
    email: string;
    displayName: string | null;
    passwordHash?: string | null;
  } | null>;
  resolveDeviceCredentialContext(
    request: FastifyRequest,
    options?: { fresh?: boolean }
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
    request: FastifyRequest,
    options?: { fresh?: boolean }
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
      | "managed_file_read"
      | "managed_terminal"
      | "managed_preview"
      | "managed_source_control"
      | "admin",
    options?: { apiTokenError?: string; freshDeviceCredential?: boolean }
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
    resolveDelegatedPrincipal?: (
      token: string
    ) => Promise<RemoteMcpDelegatedPrincipal>;
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

  const resolveDelegatedPrincipal = async (
    request: FastifyRequest
  ): Promise<RemoteMcpDelegatedPrincipal | null> => {
    const bearer = readAuthorizationCredential(request, "Bearer");
    if (!bearer) return null;
    if (!options.resolveDelegatedPrincipal) {
      if (bearer.startsWith(remoteMcpAccessTokenPrefix)) {
        throw Object.assign(new Error("Delegated access is unavailable"), {
          statusCode: 401
        });
      }
      return null;
    }
    try {
      return await options.resolveDelegatedPrincipal(bearer);
    } catch {
      if (bearer.startsWith(remoteMcpAccessTokenPrefix)) {
        throw Object.assign(new Error("Delegated access is unavailable"), {
          statusCode: 401
        });
      }
      return null;
    }
  };
  const resolveDelegatedUser = async (
    request: FastifyRequest,
    requiredScope?: "koed:team:read"
  ) => {
    const principal = await resolveDelegatedPrincipal(request);
    if (!principal) return null;
    assertDelegatedRequestScope(principal, request);
    if (requiredScope && !principal.scopes.includes(requiredScope)) {
      throw Object.assign(
        new Error("Delegated credential is not allowed for this operation"),
        {
          statusCode: 403
        }
      );
    }
    const user = await requireRepository().getUser(principal.userId);
    if (!user) {
      throw Object.assign(new Error("Delegated access is unavailable"), {
        statusCode: 401
      });
    }
    recordAuthContext(request, "oauth_delegated", user.id);
    return user;
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

  const resolveDeviceCredentialContext = (
    request: FastifyRequest,
    options: { fresh?: boolean } = {}
  ) => {
    const cached = deviceCredentialContexts.get(request);
    if (cached && !options.fresh) {
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

    const delegatedUser = await resolveDelegatedUser(request);
    if (delegatedUser) return delegatedUser;

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
      const delegatedUser = await resolveDelegatedUser(request);
      if (delegatedUser) return delegatedUser;
      throw Object.assign(new Error("Invalid API token"), { statusCode: 401 });
    }
    recordAuthContext(request, "api_token", user.id);
    return user;
  };

  const authenticateDeviceCredential = async (
    request: FastifyRequest,
    options: { fresh?: boolean } = {}
  ) => {
    if (!readDeviceCredential(request)) {
      throw Object.assign(new Error("Device credential required"), {
        statusCode: 401
      });
    }
    const context = await resolveDeviceCredentialContext(request, options);
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
      | "managed_file_read"
      | "managed_terminal"
      | "managed_preview"
      | "managed_source_control"
      | "admin",
    options: { apiTokenError?: string; freshDeviceCredential?: boolean } = {}
  ) => {
    const authHeader = request.headers.authorization?.trim();
    const separatorIndex = authHeader?.indexOf(" ") ?? -1;
    const authScheme =
      authHeader && separatorIndex > 0
        ? authHeader.slice(0, separatorIndex).toLowerCase()
        : "";
    if (authScheme === "bearer") {
      if (operationFamily === "team_workspace_read") {
        const delegatedUser = await resolveDelegatedUser(
          request,
          "koed:team:read"
        );
        if (delegatedUser) return delegatedUser;
      }
      throw Object.assign(
        new Error(
          options.apiTokenError ??
            "Session cookie or scoped device credential required"
        ),
        { statusCode: 403 }
      );
    }
    if (authScheme === "koed-device") {
      const context = await authenticateDeviceCredential(request, {
        fresh: options.freshDeviceCredential
      });
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

  const authenticateMemoryAnswerTask = async (
    request: FastifyRequest,
    mode: "read" | "execution",
    requestedTeam?: boolean
  ) => {
    // Native upstream task proxies may only narrow freshly verified authority.
    const scope = request.headers["x-koed-memory-answer-task-scope"];
    if (scope !== undefined && scope !== "personal" && scope !== "team")
      throw Object.assign(new Error("Invalid Memory Answer task scope"), {
        statusCode: 400
      });
    const restrict = (allowTeam: boolean, allowPersonal: boolean) => {
      allowTeam = allowTeam && scope !== "personal";
      allowPersonal = allowPersonal && scope !== "team";
      if ((scope === "team" || requestedTeam === true) && !allowTeam)
        throw Object.assign(
          new Error("Team Memory Answer permission is required"),
          {
            statusCode: 403
          }
        );
      if ((scope === "personal" || requestedTeam === false) && !allowPersonal)
        throw Object.assign(
          new Error("Personal Memory Answer permission is required"),
          {
            statusCode: 403
          }
        );
      return { allowTeam, allowPersonal };
    };
    const device = readDeviceCredential(request);
    if (device) {
      const context = await authenticateDeviceCredential(request, {
        fresh: true
      });
      const families = context.credential.operationFamilies;
      const required = "memory_answer_execution";
      if (!families.includes(required))
        throw Object.assign(
          new Error("Device credential is not allowed for Memory Answer tasks"),
          { statusCode: 403 }
        );
      const allowTeam = families.includes("team_workspace_read");
      const allowPersonal = families.includes("personal_memory_read");
      if (requestedTeam && !allowTeam)
        throw Object.assign(
          new Error("Team Memory Answer permission is required"),
          { statusCode: 403 }
        );
      if (requestedTeam === false && !allowPersonal)
        throw Object.assign(
          new Error("Personal Memory Answer permission is required"),
          { statusCode: 403 }
        );
      return { user: context.user, ...restrict(allowTeam, allowPersonal) };
    }
    const principal = await resolveDelegatedPrincipal(request);
    const user = await authenticateApiToken(request);
    const allowTeam = Boolean(principal?.scopes.includes("koed:team:read"));
    if (principal) {
      const required =
        mode === "execution" ? "koed:local-execution" : "koed:memory:read";
      if (!principal.scopes.includes(required))
        throw Object.assign(
          new Error("Delegated Memory Answer scope is required"),
          { statusCode: 403 }
        );
    }
    if (requestedTeam && !allowTeam)
      throw Object.assign(
        new Error("Team Memory Answer permission is required"),
        { statusCode: 403 }
      );
    return { user, ...restrict(allowTeam, true) };
  };

  return {
    authenticateMemoryAnswerTask,
    hashSecret,
    resolveDelegatedPrincipal,
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
