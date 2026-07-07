import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  createOpaqueSecret,
  publicUser,
  sessionCookieName,
  sessionTtlMs
} from "./session.js";
import { loginSchema, registerSchema } from "./schemas.js";
import { workosDisplayName } from "./workos.js";
import { supportsWorkos } from "../server/capabilities.js";

const workosStateCookieName = "koed_workos_state";
const workosReturnToCookieName = "koed_workos_return_to";
const workosStateTtlSeconds = 10 * 60;

const safeReturnTo = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/";
  }
  return value;
};

const firstForwardedForAddress = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.split(",")[0]?.trim() || undefined;
};

export const registerAuthRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    config,
    requireRepository,
    auth: { authenticateSession, hashSecret, setSessionCookie },
    rateLimit: { auth: authRateLimit }
  } = context;
  const workosAuthKitAvailable = () =>
    config.workos.authkitEnabled && supportsWorkos(config.deploymentProfile);

  app.get("/auth/setup-status", async () => {
    const repo = requireRepository();
    const userCount = await repo.countUsers();
    return {
      configured: userCount > 0,
      authMode: "local_operator_token_bootstrap"
    };
  });

  app.post(
    "/auth/setup",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      if (!config.publicRegistrationEnabled && !config.test) {
        return reply.status(410).send({
          error:
            "Browser session bootstrap is disabled. Use pnpm api-token:create from the deployment checkout."
        });
      }
      if ((await repo.countUsers()) > 0) {
        return reply
          .status(409)
          .send({ error: "Initial admin already exists" });
      }
      const input = registerSchema.parse(request.body);
      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id
      });
      const created = await repo.createUser({
        email: input.email,
        displayName: input.displayName,
        passwordHash
      });
      const user = await repo.getUser(created.id);

      const sessionSecret = createOpaqueSecret("cms");
      await repo.createSession(
        created.id,
        hashSecret(sessionSecret),
        new Date(Date.now() + sessionTtlMs)
      );
      setSessionCookie(reply, sessionSecret);

      return { user: publicUser(user!) };
    }
  );

  app.post(
    "/auth/register",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      if (!config.publicRegistrationEnabled && !config.test) {
        return reply.status(410).send({
          error:
            "Browser session registration is disabled in the self-hosted distribution. Use pnpm api-token:create from the deployment checkout."
        });
      }

      const input = registerSchema.parse(request.body);
      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id
      });
      const created = await repo.createUser({
        email: input.email,
        displayName: input.displayName,
        passwordHash
      });
      const user = await repo.getUser(created.id);

      const sessionSecret = createOpaqueSecret("cms");
      await repo.createSession(
        created.id,
        hashSecret(sessionSecret),
        new Date(Date.now() + sessionTtlMs)
      );
      setSessionCookie(reply, sessionSecret);

      return { user: publicUser(user!) };
    }
  );

  app.post(
    "/auth/login",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const input = loginSchema.parse(request.body);
      const user = await repo.findUserByEmail(input.email);

      if (
        !user?.passwordHash ||
        !(await argon2.verify(user.passwordHash, input.password))
      ) {
        return reply.status(401).send({ error: "Invalid email or password" });
      }

      const sessionSecret = createOpaqueSecret("cms");
      await repo.createSession(
        user.id,
        hashSecret(sessionSecret),
        new Date(Date.now() + sessionTtlMs)
      );
      setSessionCookie(reply, sessionSecret);

      return { user: publicUser(user) };
    }
  );

  app.get("/auth/workos/login", async (request, reply) => {
    if (!workosAuthKitAvailable()) {
      return reply.status(404).send({ error: "WorkOS AuthKit is unavailable" });
    }
    const state = createOpaqueSecret("wos");
    const returnTo = safeReturnTo(
      (request.query as { return_to?: string } | undefined)?.return_to
    );
    reply.setCookie(workosStateCookieName, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/auth/workos/callback",
      maxAge: workosStateTtlSeconds
    });
    reply.setCookie(workosReturnToCookieName, returnTo, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/auth/workos/callback",
      maxAge: workosStateTtlSeconds
    });
    return reply.redirect(context.workos.client.getAuthorizationUrl({ state }));
  });

  app.get("/auth/workos/callback", async (request, reply) => {
    if (!workosAuthKitAvailable()) {
      return reply.status(404).send({ error: "WorkOS AuthKit is unavailable" });
    }
    const query = request.query as { code?: string; state?: string };
    if (!query.code || !query.state) {
      return reply
        .status(400)
        .send({ error: "Missing WorkOS callback code or state" });
    }
    if (request.cookies[workosStateCookieName] !== query.state) {
      return reply.status(400).send({ error: "Invalid WorkOS callback state" });
    }

    const repo = requireRepository();
    const authentication = await context.workos.client.authenticateWithCode({
      code: query.code,
      ipAddress:
        firstForwardedForAddress(request.headers["x-forwarded-for"]) ??
        request.ip,
      userAgent: request.headers["user-agent"]
    });
    if (!authentication.user.emailVerified) {
      reply.clearCookie(workosStateCookieName, {
        path: "/auth/workos/callback"
      });
      reply.clearCookie(workosReturnToCookieName, {
        path: "/auth/workos/callback"
      });
      return reply
        .status(403)
        .send({ error: "Verified WorkOS email required" });
    }
    const displayName = workosDisplayName(authentication.user);
    const result = await repo.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerEnvironment: config.workos.providerEnvironment,
      providerUserId: authentication.user.id,
      email: authentication.user.email,
      emailVerified: authentication.user.emailVerified,
      displayName,
      profile: authentication.user.profile,
      organization: authentication.organizationId
        ? {
            providerOrganizationId: authentication.organizationId,
            name: authentication.organizationId,
            metadata: { source: "workos_authkit" }
          }
        : null
    });

    const sessionSecret = createOpaqueSecret("cms");
    await repo.createSession(
      result.user.id,
      hashSecret(sessionSecret),
      new Date(Date.now() + sessionTtlMs)
    );
    setSessionCookie(reply, sessionSecret);
    reply.clearCookie(workosStateCookieName, {
      path: "/auth/workos/callback"
    });
    reply.clearCookie(workosReturnToCookieName, {
      path: "/auth/workos/callback"
    });

    return reply.redirect(
      safeReturnTo(request.cookies[workosReturnToCookieName])
    );
  });

  app.post("/auth/logout", async (request, reply) => {
    const repo = requireRepository();
    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      await repo.revokeSession(hashSecret(sessionSecret));
    }

    reply.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (request) => {
    const user = await authenticateSession(request);

    return {
      user: publicUser(user)
    };
  });
};
