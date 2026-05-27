import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { MemorySourceRepository } from "@koed/db";

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
}

export const createAuthHelpers = (
  requireRepository: () => MemorySourceRepository,
  options: {
    hashSecret: HashSecret;
    cookieSecure: boolean;
  }
): AuthHelpers => {
  const { hashSecret } = options;
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
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (bearer) {
      const user = await repo.getApiTokenUser(hashSecret(bearer));
      if (user) {
        return user;
      }
    }

    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      const user = await repo.getSessionUser(hashSecret(sessionSecret));
      if (user) {
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
        return user;
      }
    }

    throw Object.assign(new Error("Console session required"), {
      statusCode: 401
    });
  };

  const authenticateApiToken = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;
    if (!bearer) {
      throw Object.assign(new Error("Bearer API token required"), {
        statusCode: 401
      });
    }
    const user = await repo.getApiTokenUser(hashSecret(bearer));
    if (!user) {
      throw Object.assign(new Error("Invalid API token"), { statusCode: 401 });
    }
    return user;
  };

  return {
    hashSecret,
    setSessionCookie,
    authenticate,
    authenticateSession,
    authenticateApiToken
  };
};
