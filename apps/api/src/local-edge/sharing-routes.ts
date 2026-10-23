import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fetchBoundedJsonObject,
  readDesktopLocalCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization,
  personalSharingReadSchema,
  sharingOverviewSchema,
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
  app.get(
    "/v1/local-edge/sharing",
    { preHandler: context.rateLimit.memoryRead },
    async (request: FastifyRequest): Promise<SharingOverview> => {
      if (Object.keys(request.query as object).length !== 0)
        throw Object.assign(new Error("Sharing overview accepts no filters"), {
          statusCode: 400
        });
      if (
        !localEdgeDeploymentModes.some(
          (profile) => profile === context.config.deploymentProfile
        ) ||
        !request.headers.authorization?.trim().startsWith("Koed-Desktop ")
      )
        throw Object.assign(
          new Error("Current Personal local profile required"),
          { statusCode: 403 }
        );
      const actor = await authenticate(request, {
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
        desktop.authorization !== request.headers.authorization?.trim() ||
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
              if (!statusResponse.response.ok)
                return unavailable("unauthorized");
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
    }
  );
};
