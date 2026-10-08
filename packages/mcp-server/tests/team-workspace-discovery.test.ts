import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeLocalEdgeClientCredential } from "@koed/shared";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import { MemoryToolExecutor } from "../src/memory-tool-executor.js";
import { memoryAnswerInputSchema } from "../src/memory-tool-schemas.js";
import {
  backendForDiscoveredWorkspace,
  discoverTeamWorkspaces
} from "../src/team-workspace-discovery.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const homes: string[] = [];
const context = {
  teamId,
  teamName: "Team",
  teamWorkspaceId: workspaceId,
  teamWorkspaceName: "Development",
  access: "read"
};
function enrollment(ids = ["team-backend"]): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-workspace-discovery-")
  );
  homes.push(home);
  fs.mkdirSync(path.join(home, "config"));
  fs.writeFileSync(
    path.join(home, "config", "upstream-backends.json"),
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: ids[0],
      backends: ids.map((id) => ({
        id,
        baseUrl: "https://team.example.test",
        routePolicy: { teamWorkspaceRead: "enabled" }
      }))
    })
  );
  for (const backendId of ids)
    storeLocalEdgeClientCredential(home, {
      backendId,
      secret: "test-local-edge-secret",
      operationFamilies: ["team_workspace_read"]
    });
  return { KOED_HOME: home };
}
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

describe("authorized Team Workspace discovery", () => {
  it("uses headless enrollment and returns only Workspace metadata", async () => {
    const env = enrollment();
    const teamWorkspaceContexts = vi.fn(async () => ({
      workspaces: [{ ...context, credential: "upstream-secret" }],
      authorization: "upstream-secret"
    }));
    const executor = new MemoryToolExecutor(
      { teamWorkspaceContexts } as unknown as MemoryApiClient,
      env
    );
    const result = await executor.execute(
      "memory_workspaces",
      {},
      { cwd: "/repo" }
    );
    expect(result).toMatchObject({
      workspaces: [
        {
          team_backend_id: "team-backend",
          team_workspace_id: workspaceId,
          team_workspace_name: "Development"
        }
      ],
      unavailable_backends: []
    });
    expect(teamWorkspaceContexts).toHaveBeenCalledWith(
      "team-backend",
      expect.stringContaining("Koed-Device koed_local_"),
      undefined
    );
    expect(JSON.stringify(result)).not.toMatch(
      /upstream-secret|test-local-edge-secret|authorization|credential/
    );
  });

  it("returns no Team context without enrollment and never uses a Personal API Token", async () => {
    const env = enrollment([]);
    const teamWorkspaceContexts = vi.fn();
    expect(
      await discoverTeamWorkspaces({ teamWorkspaceContexts }, env)
    ).toEqual({ workspaces: [], unavailable_backends: [] });
    expect(teamWorkspaceContexts).not.toHaveBeenCalled();
  });

  it("denies discovery without a scoped local-edge credential", async () => {
    const env = enrollment();
    fs.unlinkSync(
      path.join(env.KOED_HOME!, "secrets", "upstream-credentials.json")
    );
    const teamWorkspaceContexts = vi.fn();
    const result = await discoverTeamWorkspaces({ teamWorkspaceContexts }, env);
    expect(result).toEqual({
      workspaces: [],
      unavailable_backends: [
        {
          team_backend_id: "team-backend",
          reason: "local_credential_unavailable"
        }
      ]
    });
    expect(teamWorkspaceContexts).not.toHaveBeenCalled();
  });

  it("does not leak upstream errors or invalid response fields", async () => {
    const env = enrollment();
    for (const teamWorkspaceContexts of [
      vi.fn(async () => {
        throw new Error("upstream-secret 403 revoked");
      }),
      vi.fn(async () => ({ workspaces: [{ ...context, access: "disabled" }] }))
    ]) {
      const result = await discoverTeamWorkspaces(
        { teamWorkspaceContexts },
        env
      );
      expect(result.workspaces).toEqual([]);
      expect(result.unavailable_backends[0]?.reason).toBe(
        "team_context_unavailable"
      );
      expect(JSON.stringify(result)).not.toContain("upstream-secret");
    }
  });

  it("requires unique live discovery and refuses ambiguous or incomplete routes", async () => {
    const env = enrollment(["first", "second"]);
    const discovery = await discoverTeamWorkspaces(
      { teamWorkspaceContexts: vi.fn(async () => ({ workspaces: [context] })) },
      env
    );
    expect(
      backendForDiscoveredWorkspace(discovery, workspaceId)
    ).toBeUndefined();
    const filtered = await discoverTeamWorkspaces(
      { teamWorkspaceContexts: vi.fn(async () => ({ workspaces: [context] })) },
      env,
      "second"
    );
    expect(backendForDiscoveredWorkspace(filtered, workspaceId)).toBe("second");
    expect(
      backendForDiscoveredWorkspace(
        {
          ...filtered,
          unavailable_backends: [
            { team_backend_id: "first", reason: "team_context_unavailable" }
          ]
        },
        workspaceId
      )
    ).toBeUndefined();
    expect(backendForDiscoveredWorkspace(filtered, teamId)).toBeUndefined();
  });

  it("reports an expired capability cache without copying arbitrary error payloads", async () => {
    const env = enrollment();
    const result = await discoverTeamWorkspaces(
      {
        teamWorkspaceContexts: vi.fn(async () => {
          throw new MemoryApiError("capabilities_not_validated", {
            status: 424,
            payload: {
              error: "capabilities_not_validated",
              secret: "upstream-secret"
            }
          });
        })
      },
      env
    );
    expect(result.unavailable_backends).toEqual([
      { team_backend_id: "team-backend", reason: "capabilities_not_validated" }
    ]);
    expect(JSON.stringify(result)).not.toContain("upstream-secret");
  });

  it("resolves explicit global Team recall without a Project link or backend env", async () => {
    const env = enrollment();
    const teamMemoryAnswer = vi.fn(async () => ({
      authorizationBoundary: "frozen-boundary"
    }));
    const client = {
      accessCheck: vi.fn(async () => ({})),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      teamWorkspaceContexts: vi.fn(async () => ({ workspaces: [context] })),
      teamMemoryAnswer
    } as unknown as MemoryApiClient;
    const executor = new MemoryToolExecutor(client, env, {
      answerWithMemoryWorker: async (_payload, options) => {
        expect(options?.teamWorkspaceId).toBe(workspaceId);
        expect(options?.searchDomain).toBe("global");
        throw new Error("authorized worker reached");
      }
    });
    await expect(
      executor.execute(
        "memory_answer",
        {
          query: "Dinner?",
          search_domain: "global",
          team_workspace_id: workspaceId
        },
        { cwd: "/repo" }
      )
    ).rejects.toThrow("authorized worker reached");
    expect(teamMemoryAnswer).toHaveBeenCalledWith(
      "team-backend",
      expect.objectContaining({
        team_workspace_id: workspaceId,
        search_domain: "global"
      }),
      expect.stringContaining("Koed-Device koed_local_")
    );
  });

  it("honors an explicit backend and never forwards backend routing input upstream", async () => {
    const env = enrollment();
    env.KOED_TEAM_UPSTREAM_BACKEND_ID = "other-backend";
    const teamWorkspaceContexts = vi.fn();
    const teamMemoryAnswer = vi.fn(async () => ({}));
    const client = {
      accessCheck: vi.fn(async () => ({})),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      teamWorkspaceContexts,
      teamMemoryAnswer
    } as unknown as MemoryApiClient;
    const executor = new MemoryToolExecutor(client, env, {
      answerWithMemoryWorker: async () => {
        throw new Error("worker reached");
      }
    });
    await expect(
      executor.execute(
        "memory_answer",
        {
          query: "Dinner?",
          search_domain: "global",
          team_workspace_id: workspaceId,
          team_backend_id: "team-backend"
        },
        { cwd: "/repo" }
      )
    ).rejects.toThrow("worker reached");
    expect(teamWorkspaceContexts).not.toHaveBeenCalled();
    expect(teamMemoryAnswer).toHaveBeenCalledWith(
      "team-backend",
      expect.not.objectContaining({ team_backend_id: "team-backend" }),
      expect.any(String)
    );
  });

  it("keeps Personal Memory as the default and rejects backend-only selection", async () => {
    const env = enrollment();
    const teamWorkspaceContexts = vi.fn();
    const teamMemoryAnswer = vi.fn();
    const client = {
      accessCheck: vi.fn(async () => ({})),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      teamWorkspaceContexts,
      teamMemoryAnswer
    } as unknown as MemoryApiClient;
    const executor = new MemoryToolExecutor(client, env, {
      answerWithMemoryWorker: async () => {
        throw new Error("personal worker reached");
      }
    });
    await expect(
      executor.execute(
        "memory_answer",
        { query: "Dinner?", search_domain: "global" },
        { cwd: "/repo" }
      )
    ).rejects.toThrow("personal worker reached");
    expect(teamWorkspaceContexts).not.toHaveBeenCalled();
    expect(teamMemoryAnswer).not.toHaveBeenCalled();
    expect(
      memoryAnswerInputSchema.safeParse({
        query: "Dinner?",
        team_backend_id: "team-backend"
      }).success
    ).toBe(false);
  });
});
