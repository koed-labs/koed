import os from "node:os";
import path from "node:path";
import {
  readLocalEdgeClientCredentialAuthorization,
  readLocalEdgeUpstreamRegistry
} from "@koed/shared";
import { z } from "zod";
import { MemoryApiError, type MemoryApiClient } from "./index.js";

const teamContextSchema = z.object({
  workspaces: z
    .array(
      z.object({
        teamId: z.string().uuid(),
        teamName: z.string(),
        teamWorkspaceId: z.string().uuid(),
        teamWorkspaceName: z.string(),
        access: z.enum(["read", "write"])
      })
    )
    .max(2000)
});

export interface DiscoveredTeamWorkspace {
  team_backend_id: string;
  team_id: string;
  team_name: string;
  team_workspace_id: string;
  team_workspace_name: string;
  access: "read" | "write";
}

export interface TeamWorkspaceDiscovery {
  workspaces: DiscoveredTeamWorkspace[];
  unavailable_backends: Array<{ team_backend_id: string; reason: string }>;
}

/** Discovery uses the same enrolled local-edge custody and authority as Desktop.
 * Never forward the upstream credential or arbitrary upstream response fields.
 */
export const discoverTeamWorkspaces = async (
  client: Pick<MemoryApiClient, "teamWorkspaceContexts">,
  environment: NodeJS.ProcessEnv,
  backendId?: string,
  signal?: AbortSignal
): Promise<TeamWorkspaceDiscovery> => {
  const koedHome = path.resolve(
    environment.KOED_HOME?.trim() || path.join(os.homedir(), ".koed")
  );
  const registry = readLocalEdgeUpstreamRegistry(
    path.join(koedHome, "config", "upstream-backends.json")
  );
  const backends = registry.backends.filter((backend) =>
    backendId
      ? backend.id === backendId
      : backend.routePolicy.teamWorkspaceRead === "enabled"
  );
  if (backendId && backends.length === 0) {
    return {
      workspaces: [],
      unavailable_backends: [
        { team_backend_id: backendId, reason: "backend_not_registered" }
      ]
    };
  }
  const results = await Promise.all(
    backends.map(async (backend): Promise<TeamWorkspaceDiscovery> => {
      if (signal?.aborted) throw new Error("Koed memory request was cancelled");
      const credential = readLocalEdgeClientCredentialAuthorization(
        koedHome,
        backend.id
      );
      if (!credential?.operationFamilies.includes("team_workspace_read")) {
        return {
          workspaces: [],
          unavailable_backends: [
            {
              team_backend_id: backend.id,
              reason: "local_credential_unavailable"
            }
          ]
        };
      }
      try {
        const contexts = teamContextSchema.parse(
          await client.teamWorkspaceContexts(
            backend.id,
            credential.authorization,
            signal
          )
        );
        return {
          workspaces: contexts.workspaces.map((workspace) => ({
            team_backend_id: backend.id,
            team_id: workspace.teamId,
            team_name: workspace.teamName,
            team_workspace_id: workspace.teamWorkspaceId,
            team_workspace_name: workspace.teamWorkspaceName,
            access: workspace.access
          })),
          unavailable_backends: []
        };
      } catch (error) {
        if (signal?.aborted)
          throw new Error("Koed memory request was cancelled", {
            cause: error
          });
        return {
          workspaces: [],
          unavailable_backends: [
            {
              team_backend_id: backend.id,
              reason:
                error instanceof MemoryApiError &&
                error.status === 424 &&
                (error.payload as { error?: unknown } | undefined)?.error ===
                  "capabilities_not_validated"
                  ? "capabilities_not_validated"
                  : "team_context_unavailable"
            }
          ]
        };
      }
    })
  );
  return {
    workspaces: results.flatMap((result) => result.workspaces),
    unavailable_backends: results.flatMap(
      (result) => result.unavailable_backends
    )
  };
};

export const backendForDiscoveredWorkspace = (
  discovery: TeamWorkspaceDiscovery,
  workspaceId: string
): string | undefined => {
  // A failed discovery cannot prove a unique route across enrolled backends.
  if (discovery.unavailable_backends.length > 0) return undefined;
  const matches = new Set(
    discovery.workspaces
      .filter(
        (workspace) =>
          workspace.team_workspace_id.toLowerCase() ===
          workspaceId.toLowerCase()
      )
      .map((workspace) => workspace.team_backend_id)
  );
  return matches.size === 1 ? [...matches][0] : undefined;
};
