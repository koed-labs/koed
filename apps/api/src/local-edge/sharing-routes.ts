import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fetchBoundedJsonObject,
  readDesktopLocalCredentialAuthorization,
  verifyDesktopLocalCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization,
  personalSharingReadSchema,
  sharingOverviewSchema,
  sharingAgentOverviewSchema,
  teamSharingReadSchema,
  type SharingOverview
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectRead } from "../projects/desktop-read-auth.js";
import { localEdgeDeploymentModes } from "../server/route-identity.js";
import { workspaceProjectAuthorityUrl } from "./workspace-project-authority-url.js";
import {
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  safeUpstreamProxyUrl
} from "./upstream-routing.js";

const inviteInboxSchema = z
  .object({
    invites: z.array(
      z
        .object({
          id: z.uuid(),
          team: z.object({ id: z.uuid(), name: z.string() }).passthrough(),
          workspace: z.object({ id: z.uuid(), name: z.string() }).passthrough(),
          project: z
            .object({ id: z.uuid(), name: z.string() })
            .passthrough()
            .nullable(),
          inviter: z
            .object({
              displayName: z.string().nullable(),
              agentDisplayName: z.string().nullable()
            })
            .passthrough(),
          workspaceAccess: z.enum(["read", "write"]),
          expiresAt: z.string().datetime({ offset: true })
        })
        .passthrough()
    )
  })
  .passthrough();

type OriginRow = {
  team_backend_id: string;
  target_kind: "invitation" | "workspace_access";
  invite_id: string | null;
  team_workspace_id: string | null;
  team_user_id: string | null;
  access_grant_version: number | null;
  origin_kind: "share_window" | "conversation";
  conversation_id: string | null;
};

const applyOrigins = (
  data: z.infer<typeof teamSharingReadSchema>,
  rows: OriginRow[]
) => {
  const byInvite = new Map(
    rows
      .filter((row) => row.target_kind === "invitation")
      .map((row) => [row.invite_id, row])
  );
  const byAccess = new Map(
    rows
      .filter((row) => row.target_kind === "workspace_access")
      .map((row) => [
        `${row.team_workspace_id}:${row.team_user_id}:${row.access_grant_version}`,
        row
      ])
  );
  const source = (row: OriginRow | undefined) =>
    row?.origin_kind === "conversation" && row.conversation_id
      ? { kind: "conversation" as const, conversationId: row.conversation_id }
      : row?.origin_kind === "share_window"
        ? { kind: "share_window" as const }
        : { kind: "not_recorded" as const };
  const invitation = (item: (typeof data.invitations)[number]) => ({
    ...item,
    origin: { ...item.origin, source: source(byInvite.get(item.id)) }
  });
  const member = (item: (typeof data.workspaceAccess)[number]) => ({
    ...item,
    origin: {
      ...item.origin,
      source: source(
        byAccess.get(
          `${item.teamWorkspaceId}:${item.person.id}:${item.version}`
        )
      )
    }
  });
  return personalSharingReadSchema.parse({
    invitations: data.invitations.map(invitation),
    workspaceAccess: data.workspaceAccess.map(member),
    projects: data.projects.map((project) => ({
      ...project,
      invitations: project.invitations.map(invitation),
      members: project.members.map(member)
    }))
  });
};

export const registerSharingOverviewRoute = (
  app: FastifyInstance,
  context: ApiRouteContext,
  pool: pg.Pool | null,
  dependencies: {
    readRegistry?: typeof readLocalEdgeUpstreamRegistry;
    readTeamCredential?: typeof readLocalEdgeClientCredentialAuthorization;
    readDesktopCredential?: typeof readDesktopLocalCredentialAuthorization;
    verifyManagedCredential?: typeof verifyDesktopLocalCredentialAuthorization;
    authenticate?: typeof authenticateProjectRead;
    routeDecision?: typeof resolveLocalEdgeRouteDecision;
  } = {}
) => {
  const readRegistry =
    dependencies.readRegistry ?? readLocalEdgeUpstreamRegistry;
  const readTeamCredential =
    dependencies.readTeamCredential ??
    readLocalEdgeClientCredentialAuthorization;
  const readDesktopCredential =
    dependencies.readDesktopCredential ??
    readDesktopLocalCredentialAuthorization;
  const verifyManagedCredential =
    dependencies.verifyManagedCredential ??
    verifyDesktopLocalCredentialAuthorization;
  const authenticate = dependencies.authenticate ?? authenticateProjectRead;
  const routeDecision =
    dependencies.routeDecision ?? resolveLocalEdgeRouteDecision;
  const lastReached = new Map<string, string>();
  const readUpstream = async (
    backend: Parameters<typeof safeUpstreamProxyUrl>[0],
    authorization: string,
    path: string
  ) => {
    const result = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(backend, path),
      {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", authorization }
      },
      { timeoutMs: 10_000, maxBytes: 512_000 }
    );
    if (!result.response.ok) {
      throw Object.assign(new Error("Team metadata unavailable"), {
        statusCode: result.response.status
      });
    }
    return result.payload;
  };
  const readSharing = async (
    request: FastifyRequest | null,
    managed = false,
    ownerUserId?: string
  ): Promise<SharingOverview> => {
    if (
      !managed &&
      request &&
      Object.keys(request.query as object).length !== 0
    )
      throw Object.assign(new Error("Sharing overview accepts no filters"), {
        statusCode: 400
      });
    if (
      !localEdgeDeploymentModes.some(
        (profile) => profile === context.config.deploymentProfile
      ) ||
      !(
        request?.headers.authorization?.trim() ??
        readDesktopCredential(context.config.koedHome)?.authorization
      )?.startsWith("Koed-Desktop ")
    )
      throw Object.assign(
        new Error("Current Personal local profile required"),
        { statusCode: 403 }
      );
    const actor = ownerUserId
      ? { id: ownerUserId }
      : await authenticate(request!, {
          auth: context.auth,
          deploymentProfile: context.config.deploymentProfile,
          koedHome: context.config.koedHome
        });
    if (!pool)
      throw Object.assign(new Error("Personal sharing state unavailable"), {
        statusCode: 503
      });
    const desktop = readDesktopCredential(context.config.koedHome);
    if (
      !desktop ||
      desktop.authorization !==
        (request?.headers.authorization?.trim() ?? desktop.authorization) ||
      desktop.ownerUserId !== actor.id ||
      !desktop.operationFamilies.includes("personal_collaboration_read") ||
      !(await context.requireRepository().getUser(actor.id))
    )
      throw Object.assign(new Error("Current Personal owner unavailable"), {
        statusCode: 403
      });
    const registry = readRegistry(context.localEdge.upstreamBackendsPath);
    const profileKey = JSON.stringify({
      ownerId: actor.id,
      credentialKeyId: desktop.credentialKeyId,
      profile: context.config.deploymentProfile,
      registry
    });
    const bindingKeys = new Map(
      registry.backends.map((backend) => [
        backend.id,
        JSON.stringify(
          context.localEdge.resolveUpstreamEnrollmentBinding(backend.id)
        )
      ])
    );
    const backends = await Promise.all(
      registry.backends.map(
        async (backend): Promise<SharingOverview["backends"][number]> => {
          const unavailable = (
            reason:
              | "unenrolled"
              | "route_disabled"
              | "unreachable"
              | "unauthorized"
              | "invalid_response"
          ) => ({
            backendId: backend.id,
            status: "unavailable" as const,
            lastReachedAt:
              lastReached.get(
                `${profileKey}:${bindingKeys.get(backend.id)}:${backend.id}`
              ) ?? null,
            reason
          });
          const binding = context.localEdge.resolveUpstreamEnrollmentBinding(
            backend.id
          );
          const sourceOwnerPrincipalId =
            binding && "sourceOwnerPrincipalId" in binding
              ? binding.sourceOwnerPrincipalId
              : null;
          if (binding && sourceOwnerPrincipalId !== actor.id)
            return unavailable("unauthorized");
          const credential = readTeamCredential(
            context.config.koedHome,
            backend.id
          );
          const authorization =
            context.localEdge.resolveUpstreamAuthorization(backend);
          if (
            !binding ||
            !credential?.operationFamilies.includes("team_workspace_read") ||
            !authorization
          )
            return unavailable("unenrolled");
          const decision = routeDecision({
            operationFamily: "team_workspace_read",
            requestedMode: "live_upstream_proxy",
            upstreamBackend: backend,
            upstreamBackendId: backend.id,
            deviceCredential: {
              upstreamBackendId: backend.id,
              operationFamilies: credential.operationFamilies
            },
            upstreamCredentialAvailable: true,
            identityRemoteOperationsAllowed:
              context.localEdge.remoteOperationsAllowed()
          });
          if (decision.action !== "live_upstream_proxy")
            return unavailable("route_disabled");
          try {
            const statusResponse = await fetchBoundedJsonObject(
              context.localEdge.fetch,
              workspaceProjectAuthorityUrl(
                backend,
                "/v1/local-edge/device-credentials/status"
              ),
              {
                method: "GET",
                redirect: "error",
                headers: { accept: "application/json", authorization }
              },
              { timeoutMs: 10_000, maxBytes: 16_000 }
            );
            if (!statusResponse.response.ok) return unavailable("unauthorized");
            const status = z
              .object({
                ok: z.literal(true),
                auth: z.literal("device_credential"),
                user: z.object({ id: z.uuid() }).passthrough(),
                credential: z.object({ id: z.uuid() }).passthrough()
              })
              .passthrough()
              .parse(statusResponse.payload);
            if (
              status.user.id !== binding.principalUserId ||
              status.credential.id !== binding.deviceCredentialId
            )
              return unavailable("unauthorized");
            const [sharingPayload, inboxPayload] = await Promise.all([
              readUpstream(backend, authorization, "/v1/me/sharing"),
              readUpstream(backend, authorization, "/v1/team-invites/mine")
            ]);
            const data = teamSharingReadSchema.parse(sharingPayload);
            const inbox = inviteInboxSchema.parse(inboxPayload);
            const origins = await pool.query<OriginRow>(
              `
          select team_backend_id,target_kind,invite_id,team_workspace_id,team_user_id,access_grant_version,origin_kind,conversation_id
          from share_origins where owner_user_id=$1 and team_backend_id=$2`,
              [actor.id, backend.id]
            );
            const reachedAt = new Date().toISOString();
            return {
              backendId: backend.id,
              status: "available",
              reachedAt,
              data: applyOrigins(data, origins.rows),
              incomingInvitations: inbox.invites.map((invite) => ({
                id: invite.id,
                team: { id: invite.team.id, name: invite.team.name },
                workspace: {
                  id: invite.workspace.id,
                  name: invite.workspace.name
                },
                project: invite.project
                  ? { id: invite.project.id, name: invite.project.name }
                  : null,
                inviter: {
                  displayName: invite.inviter.displayName,
                  agentDisplayName: null
                },
                access:
                  invite.workspaceAccess === "write"
                    ? ("edit" as const)
                    : ("view" as const),
                expiresAt: invite.expiresAt
              }))
            };
          } catch (error) {
            const status =
              error && typeof error === "object" && "statusCode" in error
                ? Number(error.statusCode)
                : null;
            return unavailable(
              status === 401 || status === 403
                ? "unauthorized"
                : error instanceof z.ZodError
                  ? "invalid_response"
                  : "unreachable"
            );
          }
        }
      )
    );
    const currentDesktop = readDesktopCredential(context.config.koedHome);
    const currentRegistry = readRegistry(
      context.localEdge.upstreamBackendsPath
    );
    const currentProfileKey = JSON.stringify({
      ownerId: actor.id,
      credentialKeyId: currentDesktop?.credentialKeyId,
      profile: context.config.deploymentProfile,
      registry: currentRegistry
    });
    if (
      !currentDesktop ||
      currentDesktop.authorization !== desktop.authorization ||
      currentDesktop.ownerUserId !== actor.id ||
      currentProfileKey !== profileKey ||
      !(await context.requireRepository().getUser(actor.id)) ||
      [...bindingKeys].some(
        ([backendId, binding]) =>
          JSON.stringify(
            context.localEdge.resolveUpstreamEnrollmentBinding(backendId)
          ) !== binding
      )
    )
      throw Object.assign(
        new Error("Personal profile changed during sharing read"),
        { statusCode: 409 }
      );
    for (const backend of backends) {
      if (backend.status === "available")
        lastReached.set(
          `${profileKey}:${bindingKeys.get(backend.backendId)}:${backend.backendId}`,
          backend.reachedAt
        );
    }
    return sharingOverviewSchema.parse({ backends });
  };
  app.get(
    "/v1/local-edge/sharing",
    { preHandler: context.rateLimit.memoryRead },
    (request: FastifyRequest) => readSharing(request)
  );
  const managedQuery = z
    .object({ executionGeneration: z.coerce.number().int().positive() })
    .strict();
  const managedParams = z.object({ executionId: z.uuid() }).strict();
  const managementNavigation = z
    .object({
      principal: z.object({ id: z.uuid() }).passthrough(),
      teams: z.array(
        z
          .object({
            team: z.object({ id: z.uuid(), name: z.string() }).passthrough(),
            membership: z
              .object({ role: z.enum(["owner", "admin", "member"]) })
              .passthrough()
          })
          .passthrough()
      )
    })
    .passthrough();
  const managementMembers = z
    .object({
      members: z.array(
        z
          .object({
            userId: z.uuid(),
            displayName: z.string().nullable(),
            email: z.email(),
            role: z.enum(["owner", "admin", "member"]),
            status: z.enum(["invited", "enabled", "disabled"]),
            version: z.number().int().positive()
          })
          .passthrough()
      )
    })
    .passthrough();
  const readManagedTeams = async (
    ownerId: string,
    overview: SharingOverview
  ) => {
    const registry = readRegistry(context.localEdge.upstreamBackendsPath);
    return Promise.all(
      overview.backends.map(async (entry) => {
        if (entry.status === "unavailable")
          return {
            backendId: entry.backendId,
            status: "unavailable" as const,
            reason: entry.reason
          };
        const backend = registry.backends.find(
          (item) => item.id === entry.backendId
        );
        const binding = context.localEdge.resolveUpstreamEnrollmentBinding(
          entry.backendId
        );
        const credential = readTeamCredential(
          context.config.koedHome,
          entry.backendId
        );
        const authorization = backend
          ? context.localEdge.resolveUpstreamAuthorization(backend)
          : null;
        if (
          !backend ||
          !binding ||
          ("sourceOwnerPrincipalId" in binding &&
            binding.sourceOwnerPrincipalId !== ownerId) ||
          !credential?.operationFamilies.includes("team_workspace_read") ||
          !authorization
        )
          return {
            backendId: entry.backendId,
            status: "unavailable" as const,
            reason: "unauthorized"
          };
        try {
          const navigation = managementNavigation.parse(
            await readUpstream(backend, authorization, "/v1/teams/navigation")
          );
          if (navigation.principal.id !== binding.principalUserId)
            throw new Error("Team principal changed");
          const teams = await Promise.all(
            navigation.teams.map(async (item) => {
              const roster =
                item.membership.role === "owner" ||
                item.membership.role === "admin"
                  ? managementMembers.parse(
                      await readUpstream(
                        backend,
                        authorization,
                        `/v1/teams/${item.team.id}/members/manage`
                      )
                    ).members
                  : [];
              const owners = roster.filter(
                (person) =>
                  person.role === "owner" && person.status === "enabled"
              ).length;
              return {
                teamId: item.team.id,
                name: item.team.name,
                role: item.membership.role,
                people: roster.map((person) => ({
                  id: person.userId,
                  name: person.displayName ?? person.email,
                  role: person.role,
                  status: person.status,
                  version: person.version,
                  canRemove:
                    person.status === "enabled" &&
                    person.userId !== binding.principalUserId &&
                    (person.role !== "owner" ||
                      (item.membership.role === "owner" && owners > 1))
                }))
              };
            })
          );
          return {
            backendId: entry.backendId,
            status: "available" as const,
            teams
          };
        } catch {
          return {
            backendId: entry.backendId,
            status: "unavailable" as const,
            reason: "unreachable"
          };
        }
      })
    );
  };
  const currentSharingProfile = () => {
    const registry = readRegistry(context.localEdge.upstreamBackendsPath);
    return JSON.stringify({
      desktop: readDesktopCredential(context.config.koedHome),
      deploymentProfile: context.config.deploymentProfile,
      registry,
      backends: registry.backends.map((backend) => [
        backend.id,
        context.localEdge.resolveUpstreamEnrollmentBinding(backend.id),
        readTeamCredential(context.config.koedHome, backend.id)
          ?.credentialKeyId,
        context.localEdge.resolveUpstreamAuthorization(backend)
      ])
    });
  };
  const readForOwner = async (ownerUserId: string) => {
    const before = currentSharingProfile();
    const overview = await readSharing(null, true, ownerUserId);
    const teams = await readManagedTeams(ownerUserId, overview);
    if (currentSharingProfile() !== before)
      throw Object.assign(
        new Error("Personal profile changed during sharing read"),
        { statusCode: 409 }
      );
    return sharingAgentOverviewSchema.parse({ version: 1, overview, teams });
  };
  const inviteLifecyclePage = z
    .object({
      invites: z.array(
        z
          .object({
            id: z.uuid(),
            lifecycle: z.enum([
              "pending",
              "accepted",
              "declined",
              "revoked",
              "expired"
            ])
          })
          .passthrough()
      ),
      nextCursor: z.string().nullable()
    })
    .passthrough();
  const readInvitationLifecycle = async (
    ownerUserId: string,
    backendId: string,
    teamId: string,
    invitationId: string
  ) => {
    const before = currentSharingProfile();
    const read = await readForOwner(ownerUserId);
    const backendState = read.overview.backends.find(
      (item) => item.backendId === backendId
    );
    const roster = read.teams.find((item) => item.backendId === backendId);
    const team =
      roster?.status === "available"
        ? roster.teams.find((item) => item.teamId === teamId)
        : null;
    if (
      backendState?.status !== "available" ||
      !team ||
      (team.role !== "owner" && team.role !== "admin")
    )
      return null;
    const backend = readRegistry(
      context.localEdge.upstreamBackendsPath
    ).backends.find((item) => item.id === backendId);
    const binding =
      context.localEdge.resolveUpstreamEnrollmentBinding(backendId);
    const credential = readTeamCredential(context.config.koedHome, backendId);
    const authorization = backend
      ? context.localEdge.resolveUpstreamAuthorization(backend)
      : null;
    if (
      !backend ||
      !binding ||
      ("sourceOwnerPrincipalId" in binding &&
        binding.sourceOwnerPrincipalId !== ownerUserId) ||
      !credential?.operationFamilies.includes("team_workspace_read") ||
      !authorization
    )
      return null;
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = new URLSearchParams({
        includeRevoked: "true",
        limit: "200"
      });
      if (cursor) query.set("cursor", cursor);
      const page = inviteLifecyclePage.parse(
        await readUpstream(
          backend,
          authorization,
          `/v1/teams/${teamId}/invites?${query}`
        )
      );
      if (currentSharingProfile() !== before) return null;
      const invite = page.invites.find((item) => item.id === invitationId);
      if (invite) return invite.lifecycle;
      if (!page.nextCursor) return null;
      cursor = page.nextCursor;
    }
    return null;
  };
  const currentManaged = async (
    request: FastifyRequest,
    executionId: string,
    generation: number
  ) => {
    const authorization = request.headers.authorization?.trim();
    const actor = await authenticate(request, {
      auth: context.auth,
      deploymentProfile: context.config.deploymentProfile,
      koedHome: context.config.koedHome
    });
    if (
      !authorization?.startsWith("Koed-Desktop ") ||
      !verifyManagedCredential(context.config.koedHome, authorization, {
        ownerUserId: actor.id,
        operationFamily: "managed_execution"
      })
    )
      throw Object.assign(new Error("Managed owner credential required"), {
        statusCode: 403
      });
    const repository = context.requireRepository();
    const scope = { userId: actor.id };
    const [execution, command] = await Promise.all([
      repository.getManagedConversationExecution(scope, executionId),
      repository.getLatestManagedConversationCommandForExecution(
        scope,
        executionId
      )
    ]);
    if (
      !execution ||
      !command ||
      execution.ownerUserId !== actor.id ||
      command.ownerUserId !== actor.id ||
      command.executionId !== executionId ||
      execution.executionGeneration !== generation ||
      command.executionGeneration !== generation ||
      command.state !== "dispatching" ||
      !command.leaseToken ||
      !command.leaseExpiresAt ||
      Date.parse(command.leaseExpiresAt) <= Date.now() ||
      !["starting", "running", "reconciling"].includes(execution.state)
    )
      throw Object.assign(
        new Error("Managed Agent command is no longer active"),
        { statusCode: 409 }
      );
    const desktop = readDesktopCredential(context.config.koedHome);
    const registry = readRegistry(context.localEdge.upstreamBackendsPath);
    return {
      actorId: actor.id,
      commandId: command.id,
      leaseToken: command.leaseToken,
      profileKey: JSON.stringify({
        credentialKeyId: desktop?.credentialKeyId,
        profile: context.config.deploymentProfile,
        registry,
        bindings: registry.backends.map((backend) => [
          backend.id,
          context.localEdge.resolveUpstreamEnrollmentBinding(backend.id),
          readTeamCredential(context.config.koedHome, backend.id)
            ?.credentialKeyId,
          context.localEdge.resolveUpstreamAuthorization(backend)
        ])
      })
    };
  };
  app.get(
    "/v1/managed-conversations/:executionId/sharing-overview",
    { preHandler: context.rateLimit.memoryRead },
    async (request: FastifyRequest) => {
      const { executionId } = managedParams.parse(request.params);
      const { executionGeneration } = managedQuery.parse(request.query);
      const before = await currentManaged(
        request,
        executionId,
        executionGeneration
      );
      const overview = await readSharing(request, true);
      const teams = await readManagedTeams(before.actorId, overview);
      const after = await currentManaged(
        request,
        executionId,
        executionGeneration
      );
      if (
        after.actorId !== before.actorId ||
        after.commandId !== before.commandId ||
        after.leaseToken !== before.leaseToken ||
        after.profileKey !== before.profileKey
      )
        throw Object.assign(
          new Error("Managed sharing read changed during request"),
          { statusCode: 409 }
        );
      return sharingAgentOverviewSchema.parse({ version: 1, overview, teams });
    }
  );
  return { readForOwner, readInvitationLifecycle };
};
