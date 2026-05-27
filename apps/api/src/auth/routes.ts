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

  app.get("/auth/setup-status", async () => {
    const repo = requireRepository();
    const userCount = await repo.countUsers();
    return {
      configured: userCount > 0,
      authMode: "first_run_local_admin"
    };
  });

  app.post(
    "/auth/setup",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
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
      const userCount = await repo.countUsers();
      if (userCount > 0 && !config.publicRegistrationEnabled) {
        return reply.status(410).send({
          error:
            "Public registration is disabled in the self-hosted distribution. Use /auth/setup for the first local admin."
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
