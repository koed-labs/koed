import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "@koed/shared";
import {
  defaultFreshAuthenticationMaxAgeMs,
  type DeviceCredentialAuthContext,
  type MemorySourceRepository,
  type TeamAccessRepository
} from "@koed/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createOpaqueSecret, publicUser } from "../auth/index.js";
import { enforceCollaborationAdmission } from "../collaboration/admission.js";
import {
  openOpaqueCursor,
  sealOpaqueCursor
} from "../local-edge/opaque-cursor.js";
import { authProvidersForDeployment } from "../server/capabilities.js";
import type { ApiRouteContext } from "../server/context.js";
import {
  acceptTeamInviteSchema,
  createTeamInviteSchema,
  createTeamSchema,
  createTeamWorkspaceSchema,
  expectedVersionSchema,
  listTeamInvitesQuerySchema,
  listTeamWorkspacesQuerySchema,
  setTeamBillingSeatPolicySchema,
  setTeamEntitlementStateSchema,
  setTeamWorkspaceAccessSchema,
  teamAuditEventsQuerySchema,
  teamIdParamsSchema,
  teamInviteIdParamsSchema,
  teamMemberParamsSchema,
  teamWorkspaceIdParamsSchema,
  updateTeamMemberRoleSchema
} from "./schemas.js";

const forbidden = (message: string) =>
  Object.assign(new Error(message), { statusCode: 403 });

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

const conflict = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409 });

const isStaleVersionError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "STALE_VERSION"
  );

export const teamAdminScopeHash = (input: {
  action: string;
  teamId: string | null;
  targetId: string | null;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
    {
      operationFamily: "admin",
      action: input.action,
      teamId: input.teamId,
      targetId: input.targetId
    }
  );

export const teamAdminRequestHash = (input: {
  method: string;
  path: string;
  body: unknown;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
    input
  );

const backendOriginHash = (protocolDeploymentId: string): string =>
  createHash("sha256")
    .update(`koed:backend-origin:v1\n${protocolDeploymentId}`)
    .digest("hex");

const teamInviteCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("team_invites"),
    actorUserId: z.uuid(),
    backendOriginHash: z.string().regex(/^[a-f0-9]{64}$/),
    teamId: z.uuid(),
    includeRevoked: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    id: z.uuid()
  })
  .strict();

const decodeTeamInviteCursor = (
  context: ApiRouteContext,
  cursor: string
): z.infer<typeof teamInviteCursorSchema> | null => {
  const secret = context.config.collaborationRealtime.cursorSecret;
  if (!secret) return null;
  const payload = openOpaqueCursor({
    secret,
    prefix: "ktic1",
    domain: "team-invites",
    cursor
  });
  const parsed = teamInviteCursorSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

const encodeTeamInviteCursor = (
  context: ApiRouteContext,
  payload: z.infer<typeof teamInviteCursorSchema>
): string => {
  const secret = context.config.collaborationRealtime.cursorSecret;
  if (!secret) {
    throw Object.assign(new Error("Invitation pagination is unavailable"), {
      statusCode: 503
    });
  }
  return sealOpaqueCursor({
    secret,
    prefix: "ktic1",
    domain: "team-invites",
    payload: teamInviteCursorSchema.parse(payload)
  });
};

const requestPath = (request: FastifyRequest): string =>
  new URL(request.url, "http://koed.local").pathname;

const actionGrantHeader = (request: FastifyRequest): string | null => {
  const value = request.headers["x-koed-action-grant"];
  const token = Array.isArray(value) ? value[0] : value;
  return token?.trim() || null;
};

const requestIdempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim()
    )
  ) {
    throw badRequest("A UUID Idempotency-Key header is required");
  }
  return value.trim().toLowerCase();
};

type TeamAdminActor =
  | {
      kind: "browser";
      user: { id: string; email: string; displayName: string | null };
    }
  | {
      kind: "device";
      user: { id: string; email: string; displayName: string | null };
      auth: DeviceCredentialAuthContext;
      actionGrant: string;
    };

export const registerTeamRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: {
      authenticateSessionContext,
      authenticateDeviceCredential,
      authenticateSessionOrDeviceCredential,
      hashSecret
    },
    rateLimit: {
      auth: authRateLimit,
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  const rejectApiToken = (request: FastifyRequest): void => {
    if (/^Bearer(?:\s|$)/i.test(request.headers.authorization?.trim() ?? "")) {
      throw forbidden("Personal API Tokens cannot access Team operations");
    }
  };

  const verifiedLocalDeploymentId = (): string => {
    const identity = context.deploymentIdentity.inspect();
    if (
      identity.health !== "healthy" ||
      !identity.remoteOperationsAllowed ||
      !identity.deploymentId
    ) {
      throw Object.assign(
        new Error("Local deployment identity is not verified"),
        { statusCode: 424 }
      );
    }
    return identity.deploymentId;
  };

  const authenticateTeamRead = async (request: FastifyRequest) => {
    rejectApiToken(request);
    return authenticateSessionOrDeviceCredential(
      request,
      "team_workspace_read"
    );
  };

  const authenticateTeamNavigationRead = async (request: FastifyRequest) => {
    const workspaceUser = await authenticateTeamRead(request);
    const chatUser = await authenticateSessionOrDeviceCredential(
      request,
      "team_chat_read"
    );
    if (workspaceUser.id !== chatUser.id) {
      throw forbidden("Team navigation identity is inconsistent");
    }
    return workspaceUser;
  };

  const requireFreshSession = async (request: FastifyRequest) => {
    rejectApiToken(request);
    const session = await authenticateSessionContext(request);
    const ageMs = Date.now() - session.createdAt.getTime();
    if (
      !Number.isFinite(ageMs) ||
      ageMs < 0 ||
      ageMs > defaultFreshAuthenticationMaxAgeMs
    ) {
      throw forbidden("Fresh browser authentication is required");
    }
    return session.user;
  };

  const requireVerifiedTeamIdentity = async (
    repository: Pick<
      MemorySourceRepository,
      "getVerifiedExternalAuthIdentityForUser"
    >,
    user: TeamAdminActor["user"]
  ): Promise<void> => {
    if (context.config.deploymentProfile === "developer") return;

    const authProviders = authProvidersForDeployment({
      deploymentProfile: context.config.deploymentProfile,
      workosAuthKitEnabled: context.config.workos.authkitEnabled
    });
    if (!authProviders.includes("workos")) {
      throw forbidden(
        "Verified Team identity is unavailable for this deployment"
      );
    }
    const identity = await repository.getVerifiedExternalAuthIdentityForUser(
      user.id
    );
    if (
      !identity ||
      identity.provider !== "workos_authkit" ||
      identity.providerEnvironment !==
        context.config.workos.providerEnvironment ||
      identity.email.toLowerCase() !== user.email.toLowerCase()
    ) {
      throw forbidden(
        "A current verified WorkOS/AuthKit identity is required for Team administration"
      );
    }
  };

  const authenticateAdminActor = async (
    request: FastifyRequest
  ): Promise<TeamAdminActor> => {
    rejectApiToken(request);
    const authorization = request.headers.authorization?.trim() ?? "";
    if (!/^Koed-Device(?:\s|$)/i.test(authorization)) {
      return { kind: "browser", user: await requireFreshSession(request) };
    }

    const auth: DeviceCredentialAuthContext =
      await authenticateDeviceCredential(request);
    if (!auth.credential.operationFamilies.includes("action_grant")) {
      throw forbidden(
        "Device credential is not allowed for Team administration"
      );
    }
    const actionGrant = actionGrantHeader(request);
    if (!actionGrant) {
      throw forbidden("One-time action grant required");
    }
    return { kind: "device", user: auth.user, auth, actionGrant };
  };

  const runHighRiskTeamWrite = async <TBody>(
    request: FastifyRequest,
    actor: TeamAdminActor,
    input: {
      action: string;
      teamId: string | null;
      targetId: string | null;
      body: unknown;
    },
    execute: (
      repository: TeamAccessRepository &
        Pick<
          MemorySourceRepository,
          "ensureLocalSyncDeployment" | "getVerifiedExternalAuthIdentityForUser"
        >
    ) => Promise<{ statusCode: number; body: TBody } | null>
  ): Promise<{ statusCode: number; body: TBody }> => {
    if (actor.kind === "browser") {
      const repository = requireRepository();
      await requireVerifiedTeamIdentity(repository, actor.user);
      const result = await execute(repository);
      if (!result) {
        throw forbidden("Team administration action is not authorized");
      }
      return result;
    }
    const result = await requireRepository().executeActionGrant({
      actionGrant: actor.actionGrant,
      ownerUserId: actor.user.id,
      deviceCredentialId: actor.auth.credential.id,
      upstreamBackendId: actor.auth.credential.upstreamBackendId,
      teamId: input.teamId,
      operationFamily: "admin",
      action: input.action,
      targetId: input.targetId,
      scopeHash: teamAdminScopeHash(input),
      requestHash: teamAdminRequestHash({
        method: request.method.toUpperCase(),
        path: requestPath(request),
        body: input.body
      }),
      execute: async ({ team, sync, externalAuth }) => {
        const repository = { ...team, ...sync, ...externalAuth };
        await requireVerifiedTeamIdentity(repository, actor.user);
        return execute(repository);
      }
    });
    if (!result) {
      throw forbidden("Action grant is invalid or has already been consumed");
    }
    return result;
  };

  const runVersioned = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (isStaleVersionError(error)) throw conflict("Stale version");
      throw error;
    }
  };

  app.get("/v1/teams", { preHandler: memoryReadRateLimit }, async (request) => {
    const user = await authenticateTeamRead(request);
    return { teams: await requireRepository().listTeams({ userId: user.id }) };
  });

  app.get(
    "/v1/teams/navigation",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamNavigationRead(request);
      const repository = requireRepository();
      const actor = { userId: user.id };
      const teams = (await repository.listTeams(actor)).slice(0, 50);
      const navigationTeams = await Promise.all(
        teams.map(async (team) => {
          const [membership, members, teamWorkspaces, snapshot] =
            await Promise.all([
              repository.getTeamMembership(actor, team.id),
              repository.listTeamRoster(actor, team.id),
              repository.listTeamWorkspaces(actor, {
                teamId: team.id,
                includeArchived: true,
                limit: 20
              }),
              repository.getAuthorizedSnapshot(actor, {
                scope: "team",
                teamId: team.id,
                includeArchived: true
              })
            ]);
          if (
            !membership ||
            membership.teamId !== team.id ||
            membership.userId !== user.id ||
            membership.status !== "enabled" ||
            !members ||
            !members.some((member) => member.userId === user.id) ||
            !teamWorkspaces ||
            !snapshot ||
            snapshot.scope !== "team" ||
            snapshot.teamId !== team.id ||
            snapshot.personalOwnerUserId !== null
          ) {
            throw forbidden("Team navigation cannot be viewed");
          }
          const workspaces = await Promise.all(
            teamWorkspaces.map(async (teamWorkspace) => {
              const [access, grants] = await Promise.all([
                repository.getTeamWorkspaceAccess(actor, teamWorkspace.id),
                repository.listWorkspaceGrants(actor, {
                  teamId: team.id,
                  teamWorkspaceId: teamWorkspace.id,
                  limit: 100,
                  offset: 0
                })
              ]);
              if (
                !access ||
                access.teamId !== team.id ||
                access.teamWorkspaceId !== teamWorkspace.id ||
                access.userId !== user.id ||
                access.access === "disabled" ||
                grants.offset !== 0 ||
                grants.limit !== 100 ||
                grants.hasMore ||
                grants.entries.some(
                  (grant) =>
                    grant.lifecycle !== "active" ||
                    (grant.representationState !== "available" &&
                      grant.representationState !== "stale") ||
                    grant.companionScope.teamId !== team.id ||
                    grant.companionScope.teamWorkspaceId !== teamWorkspace.id ||
                    grant.companionScope.logicalMemoryId !==
                      grant.logicalMemoryId ||
                    grant.companionScope.shareGrantId !== grant.shareGrantId
                )
              ) {
                throw forbidden("Team Workspace navigation cannot be viewed");
              }
              return {
                teamWorkspace,
                access,
                shareGrants: grants.entries.map((grant) => ({
                  id: grant.shareGrantId,
                  logicalMemoryId: grant.logicalMemoryId,
                  ownerUserId: grant.ownerUserId,
                  activeRepresentation: grant.activeRepresentation,
                  representationState: grant.representationState,
                  representationSourceRevision:
                    grant.representationSourceRevision,
                  representationUpdatedAt: grant.representationUpdatedAt,
                  freshness: grant.freshness,
                  lifecycle: grant.lifecycle,
                  createdAt: grant.createdAt,
                  updatedAt: grant.updatedAt,
                  companionScope: grant.companionScope
                }))
              };
            })
          );
          return {
            team,
            membership,
            members,
            threads: snapshot.threads,
            highWaterCursor: snapshot.highWaterCursor,
            workspaces
          };
        })
      );
      return {
        principal: publicUser(user),
        teams: navigationTeams
      };
    }
  );

  app.get(
    "/v1/team-context",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      return {
        workspaces: await requireRepository().listTeamWorkspaceContexts({
          userId: user.id
        })
      };
    }
  );

  app.post(
    "/v1/teams",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const input = createTeamSchema.parse(request.body);
      const actor = await authenticateAdminActor(request);
      return (
        await runHighRiskTeamWrite(
          request,
          actor,
          {
            action: "team.create",
            teamId: null,
            targetId: null,
            body: request.body
          },
          async (repo) => {
            const team = await repo.createTeam(
              { userId: actor.user.id },
              { ...input, idempotencyKey: requestIdempotencyKey(request) }
            );
            const defaultWorkspace = await repo.getTeamDefaultWorkspace(
              { userId: actor.user.id },
              team.id
            );
            return {
              statusCode: 200,
              body: { team, defaultWorkspace }
            };
          }
        )
      ).body;
    }
  );

  app.get(
    "/v1/teams/:teamId/membership",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const membership = await requireRepository().getTeamMembership(
        { userId: user.id },
        teamId
      );
      if (!membership) throw forbidden("Team membership cannot be viewed");
      return { membership };
    }
  );

  app.get(
    "/v1/teams/:teamId/members",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const members = await requireRepository().listTeamRoster(
        { userId: user.id },
        teamId
      );
      if (!members) throw forbidden("Team roster cannot be viewed");
      return { members };
    }
  );

  app.get(
    "/v1/teams/:teamId/members/manage",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const members = await requireRepository().listTeamManagementMembers(
        { userId: user.id },
        teamId
      );
      if (!members) throw forbidden("Team member details cannot be viewed");
      return { members };
    }
  );

  app.patch(
    "/v1/teams/:teamId/members/:userId/role",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const params = teamMemberParamsSchema.parse(request.params);
      const input = updateTeamMemberRoleSchema.parse(request.body);
      const actor = await authenticateAdminActor(request);
      return (
        await runVersioned(() =>
          runHighRiskTeamWrite(
            request,
            actor,
            {
              action: "team.member.role_update",
              teamId: params.teamId,
              targetId: params.userId,
              body: request.body
            },
            async (repo) => {
              const membership = await repo.updateTeamMemberRole(
                { userId: actor.user.id },
                { ...params, ...input }
              );
              return membership
                ? { statusCode: 200, body: { membership } }
                : null;
            }
          )
        )
      ).body;
    }
  );

  app.post(
    "/v1/teams/:teamId/members/:userId/disable",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const params = teamMemberParamsSchema.parse(request.params);
      const input = expectedVersionSchema.parse(request.body);
      const actor = await authenticateAdminActor(request);
      return (
        await runVersioned(() =>
          runHighRiskTeamWrite(
            request,
            actor,
            {
              action: "team.member.disable",
              teamId: params.teamId,
              targetId: params.userId,
              body: request.body
            },
            async (repo) => {
              const membership = await repo.disableTeamMember(
                { userId: actor.user.id },
                { ...params, expectedVersion: input.expectedVersion }
              );
              return membership
                ? { statusCode: 200, body: { membership } }
                : null;
            }
          )
        )
      ).body;
    }
  );

  app.post(
    "/v1/teams/:teamId/leave",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const user = await requireFreshSession(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const input = expectedVersionSchema.parse(request.body);
      const membership = await runVersioned(() =>
        requireRepository().leaveTeam(
          { userId: user.id },
          { teamId, expectedVersion: input.expectedVersion }
        )
      );
      if (!membership) throw forbidden("Team cannot be left");
      return { membership };
    }
  );

  app.get(
    "/v1/teams/:teamId/invites",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const query = listTeamInvitesQuerySchema.parse(request.query);
      const includeRevoked = query.includeRevoked ?? false;
      const deployment = await requireRepository().ensureLocalSyncDeployment({
        profile: context.config.deploymentProfile,
        protocolDeploymentId: verifiedLocalDeploymentId()
      });
      const expectedBackendOriginHash = backendOriginHash(
        deployment.protocolDeploymentId
      );
      const cursor = query.cursor
        ? decodeTeamInviteCursor(context, query.cursor)
        : null;
      if (
        query.cursor &&
        (!cursor ||
          cursor.actorUserId !== user.id ||
          cursor.backendOriginHash !== expectedBackendOriginHash ||
          cursor.teamId !== teamId ||
          cursor.includeRevoked !== includeRevoked)
      ) {
        throw forbidden("Invitation cursor is not valid for this request");
      }
      const page = await requireRepository().listTeamInvites(
        { userId: user.id },
        {
          teamId,
          includeRevoked,
          limit: query.limit,
          ...(cursor
            ? { cursor: { createdAt: cursor.createdAt, id: cursor.id } }
            : {})
        }
      );
      if (!page) throw forbidden("Team invites cannot be viewed");
      return {
        invites: page.invites,
        nextCursor: page.nextCursor
          ? encodeTeamInviteCursor(context, {
              version: 1,
              kind: "team_invites",
              actorUserId: user.id,
              backendOriginHash: expectedBackendOriginHash,
              teamId,
              includeRevoked,
              ...page.nextCursor
            })
          : null
      };
    }
  );

  app.post(
    "/v1/teams/:teamId/invites",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      rejectApiToken(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const input = createTeamInviteSchema.parse(request.body);
      const actor = await authenticateAdminActor(request);
      return (
        await runHighRiskTeamWrite(
          request,
          actor,
          {
            action: "team.invite.create",
            teamId,
            targetId: input.defaultTeamWorkspaceId,
            body: request.body
          },
          async (repo) => {
            await enforceCollaborationAdmission(
              reply,
              context.collaboration.admission.admitInviteCreation({
                userId: actor.user.id,
                teamId
              })
            );
            const inviteToken = createOpaqueSecret("kti");
            const deployment = await repo.ensureLocalSyncDeployment({
              profile: context.config.deploymentProfile,
              protocolDeploymentId: verifiedLocalDeploymentId()
            });
            const invite = await repo.createTeamInvite(
              { userId: actor.user.id },
              {
                teamId,
                defaultTeamWorkspaceId: input.defaultTeamWorkspaceId,
                defaultWorkspaceAccess: input.defaultWorkspaceAccess,
                email: input.email,
                role: input.role,
                backendOriginHash: backendOriginHash(
                  deployment.protocolDeploymentId
                ),
                tokenHash: hashSecret(inviteToken),
                expiresAt: new Date(
                  Date.now() + input.ttlHours * 60 * 60 * 1000
                )
              }
            );
            return invite
              ? { statusCode: 200, body: { invite, inviteToken } }
              : null;
          }
        )
      ).body;
    }
  );

  app.delete(
    "/v1/teams/:teamId/invites/:inviteId",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const params = teamInviteIdParamsSchema.parse(request.params);
      const input = expectedVersionSchema.parse(request.body ?? {});
      const actor = await authenticateAdminActor(request);
      return (
        await runVersioned(() =>
          runHighRiskTeamWrite(
            request,
            actor,
            {
              action: "team.invite.revoke",
              teamId: params.teamId,
              targetId: params.inviteId,
              body: request.body ?? {}
            },
            async (repo) => {
              const invite = await repo.revokeTeamInvite(
                { userId: actor.user.id },
                {
                  teamId: params.teamId,
                  inviteId: params.inviteId,
                  expectedVersion: input.expectedVersion
                }
              );
              return invite ? { statusCode: 200, body: { invite } } : null;
            }
          )
        )
      ).body;
    }
  );

  app.post(
    "/v1/team-invites/accept",
    { preHandler: authRateLimit },
    async (request) => {
      const actor = await authenticateAdminActor(request);
      const input = acceptTeamInviteSchema.parse(request.body);
      const tokenHash = hashSecret(input.inviteToken);
      return (
        await runHighRiskTeamWrite(
          request,
          actor,
          {
            action: "team.invite.accept",
            teamId: null,
            targetId: null,
            body: request.body
          },
          async (repo) => {
            const pendingInvite =
              await repo.getPendingTeamInviteByTokenHash(tokenHash);
            if (!pendingInvite) {
              throw badRequest("Invalid or expired team invite");
            }
            if (
              actor.user.email.toLowerCase() !== pendingInvite.normalizedEmail
            ) {
              throw badRequest(
                "Invite email does not match authenticated user"
              );
            }
            const deployment = await repo.ensureLocalSyncDeployment({
              profile: context.config.deploymentProfile,
              protocolDeploymentId: verifiedLocalDeploymentId()
            });
            const accepted = await repo.acceptTeamInvite({
              tokenHash,
              userId: actor.user.id,
              expectedVersion: pendingInvite.version,
              expectedBackendOriginHash: backendOriginHash(
                deployment.protocolDeploymentId
              )
            });
            if (!accepted) {
              throw badRequest("Invalid or expired team invite");
            }
            return {
              statusCode: 200,
              body: {
                invite: accepted.invite,
                membership: accepted.membership,
                user: publicUser(accepted.user),
                createdUser: accepted.createdUser
              }
            };
          }
        )
      ).body;
    }
  );

  app.get(
    "/v1/teams/:teamId/audit-events",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const query = teamAuditEventsQuerySchema.parse(request.query);
      const auditEvents = await requireRepository().listTeamAuditEvents(
        { userId: user.id },
        { teamId, ...query }
      );
      if (!auditEvents) throw forbidden("Team audit events cannot be viewed");
      return { auditEvents };
    }
  );

  app.get(
    "/v1/teams/:teamId/entitlement",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const entitlement = await requireRepository().getTeamEntitlementGate(
        { userId: user.id },
        teamId
      );
      if (!entitlement) throw forbidden("Team entitlement cannot be viewed");
      return { entitlement };
    }
  );

  app.put(
    "/v1/teams/:teamId/entitlement",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const input = setTeamEntitlementStateSchema.parse(request.body);
      const actor = await authenticateAdminActor(request);
      return (
        await runVersioned(() =>
          runHighRiskTeamWrite(
            request,
            actor,
            {
              action: "team.entitlement.update",
              teamId,
              targetId: teamId,
              body: request.body
            },
            async (repo) => {
              const entitlement = await repo.setTeamEntitlementState(
                { userId: actor.user.id },
                { teamId, ...input }
              );
              return entitlement
                ? { statusCode: 200, body: { entitlement } }
                : null;
            }
          )
        )
      ).body;
    }
  );

  app.get(
    "/v1/teams/:teamId/billing-seats",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const billingSeats = await requireRepository().getTeamBillingSeatState(
        { userId: user.id },
        teamId
      );
      if (!billingSeats) throw forbidden("Team billing seats cannot be viewed");
      return { billingSeats };
    }
  );

  app.get(
    "/v1/teams/:teamId/support/overview",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const supportOverview = await requireRepository().getTeamSupportOverview(
        { userId: user.id },
        teamId
      );
      if (!supportOverview)
        throw forbidden("Team support overview cannot be viewed");
      return { supportOverview };
    }
  );

  app.put(
    "/v1/teams/:teamId/billing-seats/policy",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const input = setTeamBillingSeatPolicySchema.parse(request.body);
      const actor = await authenticateAdminActor(request);
      return (
        await runVersioned(() =>
          runHighRiskTeamWrite(
            request,
            actor,
            {
              action: "team.billing_seats.update",
              teamId,
              targetId: teamId,
              body: request.body
            },
            async (repo) => {
              const billingSeats = await repo.setTeamBillingSeatPolicy(
                { userId: actor.user.id },
                {
                  teamId,
                  expectedVersion: input.expectedVersion,
                  seatLimit: input.seatLimit
                }
              );
              return billingSeats
                ? { statusCode: 200, body: { billingSeats } }
                : null;
            }
          )
        )
      ).body;
    }
  );

  app.get(
    "/v1/teams/:teamId/workspaces",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const query = listTeamWorkspacesQuerySchema.parse(request.query);
      const teamWorkspaces = await requireRepository().listTeamWorkspaces(
        { userId: user.id },
        { teamId, ...query }
      );
      if (!teamWorkspaces) throw forbidden("Team Workspaces cannot be viewed");
      return { teamWorkspaces };
    }
  );

  app.post(
    "/v1/teams/:teamId/workspaces",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const { teamId } = teamIdParamsSchema.parse(request.params);
      const body = createTeamWorkspaceSchema.parse({
        ...(request.body as object),
        teamId
      });
      const actor = await authenticateAdminActor(request);
      return (
        await runHighRiskTeamWrite(
          request,
          actor,
          {
            action: "team.workspace.create",
            teamId,
            targetId: null,
            body: request.body
          },
          async (repo) => {
            const teamWorkspace = await repo.createTeamWorkspace(
              { userId: actor.user.id },
              body
            );
            return teamWorkspace
              ? { statusCode: 200, body: { teamWorkspace } }
              : null;
          }
        )
      ).body;
    }
  );

  app.post(
    "/v1/team-workspaces",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const input = createTeamWorkspaceSchema.parse(request.body);
      const actor = await authenticateAdminActor(request);
      return (
        await runHighRiskTeamWrite(
          request,
          actor,
          {
            action: "team.workspace.create",
            teamId: input.teamId,
            targetId: null,
            body: request.body
          },
          async (repo) => {
            const teamWorkspace = await repo.createTeamWorkspace(
              { userId: actor.user.id },
              input
            );
            return teamWorkspace
              ? { statusCode: 200, body: { teamWorkspace } }
              : null;
          }
        )
      ).body;
    }
  );

  app.get(
    "/v1/team-workspaces/:teamWorkspaceId/context",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamWorkspaceId } = teamWorkspaceIdParamsSchema.parse(
        request.params
      );
      const workspaceContext =
        await requireRepository().getTeamWorkspaceContext(
          { userId: user.id },
          teamWorkspaceId
        );
      if (!workspaceContext) throw forbidden("Team Workspace cannot be viewed");
      return workspaceContext;
    }
  );

  app.get(
    "/v1/team-workspaces/:teamWorkspaceId/access",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const user = await authenticateTeamRead(request);
      const { teamWorkspaceId } = teamWorkspaceIdParamsSchema.parse(
        request.params
      );
      const access = await requireRepository().getTeamWorkspaceAccess(
        { userId: user.id },
        teamWorkspaceId
      );
      if (!access) throw forbidden("Team Workspace access cannot be viewed");
      return { access };
    }
  );

  for (const [suffix, action, operation] of [
    ["archive", "team.workspace.archive", "archiveTeamWorkspace"],
    ["restore", "team.workspace.restore", "restoreTeamWorkspace"]
  ] as const) {
    app.post(
      `/v1/team-workspaces/:teamWorkspaceId/${suffix}`,
      { preHandler: memoryWriteRateLimit },
      async (request) => {
        rejectApiToken(request);
        const { teamWorkspaceId } = teamWorkspaceIdParamsSchema.parse(
          request.params
        );
        const input = expectedVersionSchema.parse(request.body);
        const current = await requireRepository().getTeamWorkspaceAccess(
          { userId: (await authenticateTeamRead(request)).id },
          teamWorkspaceId
        );
        if (!current) throw forbidden("Team Workspace cannot be changed");
        const actor = await authenticateAdminActor(request);
        return (
          await runVersioned(() =>
            runHighRiskTeamWrite(
              request,
              actor,
              {
                action,
                teamId: current.teamId,
                targetId: teamWorkspaceId,
                body: request.body
              },
              async (repo) => {
                const teamWorkspace = await repo[operation](
                  { userId: actor.user.id },
                  { teamWorkspaceId, expectedVersion: input.expectedVersion }
                );
                return teamWorkspace
                  ? { statusCode: 200, body: { teamWorkspace } }
                  : null;
              }
            )
          )
        ).body;
      }
    );
  }

  app.put(
    "/v1/team-workspaces/:teamWorkspaceId/access",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      rejectApiToken(request);
      const { teamWorkspaceId } = teamWorkspaceIdParamsSchema.parse(
        request.params
      );
      const input = setTeamWorkspaceAccessSchema.parse(request.body);
      const current = await requireRepository().getTeamWorkspaceAccess(
        { userId: (await authenticateTeamRead(request)).id },
        teamWorkspaceId
      );
      if (!current) throw forbidden("Team Workspace access cannot be changed");
      const actor = await authenticateAdminActor(request);
      return (
        await runVersioned(() =>
          runHighRiskTeamWrite(
            request,
            actor,
            {
              action: "team.workspace.access_update",
              teamId: current.teamId,
              targetId: teamWorkspaceId,
              body: request.body
            },
            async (repo) => {
              const access = await repo.setTeamWorkspaceAccess(
                { userId: actor.user.id },
                { teamWorkspaceId, ...input }
              );
              return access ? { statusCode: 200, body: { access } } : null;
            }
          )
        )
      ).body;
    }
  );
};
