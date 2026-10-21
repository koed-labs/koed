import { randomUUID } from "node:crypto";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationRendererCommandSchema
} from "@koed/shared/collaboration";
import type { CollaborationLocalTransport } from "../collaboration/local-transport.js";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import type { LocalEdgeUpstreamRegistry } from "@koed/shared";
import {
  workspaceProjectShareContextSchema,
  type WorkspaceProjectShareContext
} from "@koed/shared/workspace-project-contract";

const publicAuthIsVerifiedWorkos = (payload: unknown): boolean => {
  if (!payload || typeof payload !== "object") return false;
  const auth = (payload as { auth?: unknown }).auth;
  if (!auth || typeof auth !== "object") return false;
  const providers = (auth as { providers?: unknown }).providers;
  return Array.isArray(providers) && providers.includes("workos");
};

/** Public capability cache only establishes deployment eligibility. The live
 * broker snapshot supplies the authenticated Team principal and current roster.
 */
export const projectShareBackendEligible = (
  registry: LocalEdgeUpstreamRegistry,
  backendId: string,
  now = Date.now()
): "koed_managed_cloud" | "team_self_hosted" | null => {
  if (registry.activeBackendId !== backendId) return null;
  const backend = registry.backends.find((entry) => entry.id === backendId);
  if (!backend || !backend.profile || backend.profile === "private_vps")
    return null;
  if (
    backend.profile !== "koed_managed_cloud" &&
    backend.profile !== "team_self_hosted"
  )
    return null;
  const capabilities = backend.capabilities;
  if (
    capabilities?.state !== "validated" ||
    !capabilities.expiresAt ||
    Date.parse(capabilities.expiresAt) <= now ||
    !publicAuthIsVerifiedWorkos(capabilities.payload) ||
    capabilities.teamCollaborationV2?.state !== "validated" ||
    !capabilities.teamCollaborationV2.expiresAt ||
    Date.parse(capabilities.teamCollaborationV2.expiresAt) <= now ||
    backend.credential?.status !== "configured" ||
    backend.routePolicy.teamWorkspaceRead !== "enabled" ||
    backend.routePolicy.admin !== "enabled"
  )
    return null;
  return backend.profile;
};

export const projectShareContextFromAuthority = (
  registry: LocalEdgeUpstreamRegistry,
  snapshot: CollaborationSnapshot | null,
  now = Date.now()
): WorkspaceProjectShareContext => {
  const backendId = registry.activeBackendId;
  const profile = backendId
    ? projectShareBackendEligible(registry, backendId, now)
    : null;
  if (
    !backendId ||
    !profile ||
    !snapshot ||
    snapshot.connection.backendId !== backendId ||
    snapshot.connection.state !== "live" ||
    !snapshot.navigation.teamPrincipal ||
    snapshot.navigation.teamPrincipal.membershipState !== "enabled"
  )
    return {
      state: !backendId ? "needs_cloud_enrollment" : "unavailable",
      backendId: null,
      profile: null,
      principalId: null,
      teams: []
    };
  const principalId = snapshot.navigation.teamPrincipal.id;
  return workspaceProjectShareContextSchema.parse({
    state: "ready",
    backendId,
    profile,
    principalId,
    teams: snapshot.navigation.teams
      .filter(
        (team) =>
          team.lifecycle === "active" &&
          team.people.some(
            (person) =>
              person.id === principalId && person.membershipState === "enabled"
          )
      )
      .map((team) => ({
        id: team.id,
        name: team.name,
        role: team.role,
        people: team.people
          .filter((person) => person.membershipState === "enabled")
          .map((person) => ({
            id: person.id,
            displayName: person.displayName
          })),
        workspaces: team.workspaces
          .filter((workspace) => workspace.lifecycle === "active")
          .map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            access: workspace.access
          }))
      }))
  });
};

/** Bind every context refresh to one Personal profile before reading Team data. */
export const createWorkspaceProjectShareContextLoader = (input: {
  authority: () => Promise<{ key: string; ownerId: string }>;
  registryReader: () => LocalEdgeUpstreamRegistry;
  collaborationLoader: (
    ownerId: string
  ) => Promise<CollaborationSnapshot | null>;
}): (() => Promise<WorkspaceProjectShareContext>) => {
  return async () => {
    const bound = await input.authority();
    const registry = input.registryReader();
    const snapshot = registry.activeBackendId
      ? await input.collaborationLoader(bound.ownerId)
      : null;
    if ((await input.authority()).key !== bound.key)
      throw new Error("Projects profile changed during Share context load");
    return projectShareContextFromAuthority(
      registry,
      snapshot?.navigation.personalOwner.id === bound.ownerId ? snapshot : null
    );
  };
};

export const createWorkspaceProjectCollaborationLoader = (
  transport: CollaborationLocalTransport
): ((ownerId: string) => Promise<CollaborationSnapshot | null>) => {
  return async (ownerId) => {
    const result = await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: { forceRemoteNavigation: true }
      }),
      {
        ownerId,
        signal: new AbortController().signal,
        emitCollaborationEvent: () => undefined
      }
    );
    return result.ok && result.command === "collaboration.load"
      ? result.data.snapshot
      : null;
  };
};
