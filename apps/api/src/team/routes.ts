import argon2 from "argon2";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createOpaqueSecret, publicUser, sessionTtlMs } from "../auth/index.js";
import type { ApiRouteContext } from "../server/context.js";
import {
  acceptTeamInviteSchema,
  createTeamInviteSchema,
  createTeamSchema,
  createTeamWorkspaceSchema,
  setTeamWorkspaceAccessSchema,
  teamAuditEventsQuerySchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  teamWorkspaceIdParamsSchema,
  upsertTeamMemberSchema
} from "./schemas.js";

const forbidden = (message: string) =>
  Object.assign(new Error(message), { statusCode: 403 });

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

export const registerTeamRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateSession, hashSecret, setSessionCookie },
    rateLimit: {
      auth: authRateLimit,
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  const authenticateOptionalSession = async (request: FastifyRequest) =>
    authenticateSession(request).catch(() => null);

  app.post(
    "/v1/teams",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const input = createTeamSchema.parse(request.body);
      const team = await repo.createTeam({ userId: user.id }, input);
      return { team };
    }
  );

  app.get(
    "/v1/teams/:teamId/membership",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = teamIdParamsSchema.parse(request.params);
      const membership = await repo.getTeamMembership(
        { userId: user.id },
        params.teamId
      );
      if (!membership) {
        throw Object.assign(new Error("Team membership not found"), {
          statusCode: 404
        });
      }
      return { membership };
    }
  );

  app.get(
    "/v1/teams/:teamId/audit-events",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = teamIdParamsSchema.parse(request.params);
      const query = teamAuditEventsQuerySchema.parse(request.query);
      const auditEvents = await repo.listTeamAuditEvents(
        { userId: user.id },
        {
          teamId: params.teamId,
          action: query.action,
          limit: query.limit
        }
      );
      if (!auditEvents) {
        throw forbidden("Team audit events cannot be viewed");
      }
      return { auditEvents };
    }
  );

  app.post(
    "/v1/teams/:teamId/members",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = teamIdParamsSchema.parse(request.params);
      const input = upsertTeamMemberSchema.parse(request.body);
      const membership = await repo.upsertTeamMember(
        { userId: user.id },
        {
          teamId: params.teamId,
          userId: input.userId,
          role: input.role,
          status: input.status
        }
      );
      if (!membership) {
        throw forbidden("Team membership cannot be changed");
      }
      return { membership };
    }
  );

  app.post(
    "/v1/teams/:teamId/invites",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = teamIdParamsSchema.parse(request.params);
      const input = createTeamInviteSchema.parse(request.body);
      const inviteToken = createOpaqueSecret("kti");
      const invite = await repo.createTeamInvite(
        { userId: user.id },
        {
          teamId: params.teamId,
          email: input.email,
          role: input.role,
          tokenHash: hashSecret(inviteToken),
          expiresAt: new Date(Date.now() + input.ttlHours * 60 * 60 * 1000)
        }
      );
      if (!invite) {
        throw forbidden("Team invite cannot be created");
      }
      return { invite, inviteToken };
    }
  );

  app.post(
    "/v1/team-invites/accept",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const input = acceptTeamInviteSchema.parse(request.body);
      const sessionUser = await authenticateOptionalSession(request);
      const inviteTokenHash = hashSecret(input.inviteToken);
      const pendingInvite =
        await repo.getPendingTeamInviteByTokenHash(inviteTokenHash);
      if (!pendingInvite) {
        throw badRequest("Invalid or expired team invite");
      }
      let passwordHash: string | undefined;

      if (!sessionUser) {
        if (!input.email || !input.password) {
          throw badRequest(
            "Email and password are required when accepting an invite without a session"
          );
        }
        if (input.email.toLowerCase() !== pendingInvite.email.toLowerCase()) {
          throw badRequest("Invite email does not match");
        }
        const existingUser = await repo.findUserByEmail(pendingInvite.email);
        if (
          existingUser?.passwordHash &&
          !(await argon2.verify(existingUser.passwordHash, input.password))
        ) {
          throw Object.assign(new Error("Invalid email or password"), {
            statusCode: 401
          });
        }
        if (!existingUser) {
          passwordHash = await argon2.hash(input.password, {
            type: argon2.argon2id
          });
        }
      }

      const accepted = await repo.acceptTeamInvite({
        tokenHash: inviteTokenHash,
        userId: sessionUser?.id,
        email: sessionUser ? undefined : input.email,
        displayName: input.displayName,
        passwordHash
      });
      if (!accepted) {
        throw badRequest("Invalid or expired team invite");
      }

      if (!sessionUser) {
        const sessionSecret = createOpaqueSecret("cms");
        await repo.createSession(
          accepted.user.id,
          hashSecret(sessionSecret),
          new Date(Date.now() + sessionTtlMs)
        );
        setSessionCookie(reply, sessionSecret);
      }

      return {
        invite: accepted.invite,
        membership: accepted.membership,
        user: publicUser(accepted.user),
        createdUser: accepted.createdUser
      };
    }
  );

  app.post(
    "/v1/teams/:teamId/members/:userId/disable",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = teamMemberParamsSchema.parse(request.params);
      const membership = await repo.disableTeamMember(
        { userId: user.id },
        params
      );
      if (!membership) {
        throw forbidden("Team member cannot be disabled");
      }
      return { membership };
    }
  );

  app.post(
    "/v1/team-workspaces",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const input = createTeamWorkspaceSchema.parse(request.body);
      const teamWorkspace = await repo.createTeamWorkspace(
        { userId: user.id },
        input
      );
      if (!teamWorkspace) {
        throw forbidden("Team workspace cannot be created");
      }
      return { teamWorkspace };
    }
  );

  app.get(
    "/v1/team-workspaces/:teamWorkspaceId/access",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = teamWorkspaceIdParamsSchema.parse(request.params);
      const access = await repo.getTeamWorkspaceAccess(
        { userId: user.id },
        params.teamWorkspaceId
      );
      if (!access) {
        throw Object.assign(new Error("Team workspace access not found"), {
          statusCode: 404
        });
      }
      return { access };
    }
  );

  app.put(
    "/v1/team-workspaces/:teamWorkspaceId/access",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = teamWorkspaceIdParamsSchema.parse(request.params);
      const input = setTeamWorkspaceAccessSchema.parse(request.body);
      const access = await repo.setTeamWorkspaceAccess(
        { userId: user.id },
        {
          teamWorkspaceId: params.teamWorkspaceId,
          userId: input.userId,
          access: input.access
        }
      );
      if (!access) {
        throw forbidden("Team workspace access cannot be changed");
      }
      return { access };
    }
  );
};
