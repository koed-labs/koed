import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  storeLocalEdgeClientCredential,
  repositoryScopeId,
  requirePortableTeamRepositoryContext
} from "@koed/shared";
import { MemoryApiError, MemoryApiClient } from "../src/index.js";
import { createMemoryAnswerTaskCoordinator } from "../src/memory-answer-task-coordinator.js";
import { MemoryToolExecutor } from "../src/memory-tool-executor.js";
import { memoryAnswerInputSchema } from "../src/memory-tool-schemas.js";
import { resolveProjectTeamWorkspaceRoute } from "../src/project-team-workspace-links.js";
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
function enrollment(
  ids = ["team-backend"],
  execution = false
): NodeJS.ProcessEnv {
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
        routePolicy: {
          teamWorkspaceRead: "enabled",
          ...(execution ? { memoryAnswerExecution: "enabled" } : {})
        },
        ...(execution
          ? {
              capabilities: {
                state: "validated",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                payload: {
                  capabilities: {
                    "memory.answerTasks": {
                      availability: "available",
                      version: 2,
                      supportedScopes: ["personal", "team"]
                    }
                  }
                }
              }
            }
          : {})
      }))
    })
  );
  for (const backendId of ids)
    storeLocalEdgeClientCredential(home, {
      backendId,
      secret: "test-local-edge-secret",
      operationFamilies: [
        "team_workspace_read",
        ...(execution ? ["memory_answer_execution"] : [])
      ]
    });
  return { KOED_HOME: home };
}
afterEach(() => {
  vi.restoreAllMocks();
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

  it("matches equivalent UUIDs regardless of hexadecimal letter case", () => {
    const lower = "abcdef01-2345-4678-9abc-def012345678";
    const upper = lower.toUpperCase();
    for (const stored of [lower, upper]) {
      const discovery = {
        workspaces: [
          {
            team_backend_id: "case-sensitive-backend",
            team_id: teamId,
            team_name: "Team",
            team_workspace_id: stored,
            team_workspace_name: "Development",
            access: "read" as const
          }
        ],
        unavailable_backends: []
      };
      for (const requested of [lower, upper])
        expect(backendForDiscoveredWorkspace(discovery, requested)).toBe(
          "case-sensitive-backend"
        );
    }
    expect(
      memoryAnswerInputSchema.parse({ query: "Test", team_workspace_id: upper })
        .team_workspace_id
    ).toBe(lower);
  });

  it("selects an explicit Project backend when mapped and requested UUID case differs", () => {
    const env = enrollment();
    const lower = "abcdef01-2345-4678-9abc-def012345678";
    fs.writeFileSync(
      path.join(env.KOED_HOME!, "config", "project-team-workspaces.json"),
      JSON.stringify({
        links: [
          {
            projectRoot: "/repo",
            teamWorkspaceId: lower.toUpperCase(),
            backendId: "mapped-backend"
          }
        ]
      })
    );
    env.KOED_TEAM_UPSTREAM_BACKEND_ID = "fallback-backend";
    for (const requestedTeamWorkspaceId of [lower, lower.toUpperCase()])
      expect(
        resolveProjectTeamWorkspaceRoute({
          projectRoot: "/repo",
          requestedTeamWorkspaceId,
          env
        })
      ).toEqual({ teamWorkspaceId: lower, backendId: "mapped-backend" });
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

  it.each([
    { explicitBackend: false, searchDomain: "global" },
    { explicitBackend: true, searchDomain: "global" },
    { explicitBackend: false, searchDomain: "project" },
    { explicitBackend: true, searchDomain: "project" }
  ] as const)(
    "accepts $searchDomain Team recall through fresh discovery with explicit backend=$explicitBackend",
    async ({ explicitBackend, searchDomain }) => {
      const env = enrollment(["team-backend"], true);
      const cwd = path.join(env.KOED_HOME!, "checkout");
      fs.mkdirSync(cwd);
      if (searchDomain === "project") {
        execFileSync("git", ["-C", cwd, "init"], { stdio: "pipe" });
        execFileSync("git", [
          "-C",
          cwd,
          "remote",
          "add",
          "origin",
          "https://example.test/team/task-project.git"
        ]);
      }
      if (explicitBackend) env.KOED_TEAM_UPSTREAM_BACKEND_ID = "other-backend";
      const client = new MemoryApiClient({
        apiUrl: "http://127.0.0.1:3001",
        apiToken: "personal-token"
      });
      const teamWorkspaceContexts = vi
        .spyOn(client, "teamWorkspaceContexts")
        .mockResolvedValue({ workspaces: [context] });
      const now = new Date().toISOString();
      const task = {
        id: randomUUID(),
        teamWorkspaceId: workspaceId,
        origin: "mcp",
        invocationKey: null,
        questionId: null,
        status: "accepted",
        statusMessage: null,
        attemptCount: 0,
        maxAttempts: 3,
        fenceGeneration: 0,
        cancelRequestedAt: null,
        startedAt: null,
        lastProgressAt: null,
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        result: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString()
      };
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ task })));
      const coordinator = createMemoryAnswerTaskCoordinator(client, env);
      expect(
        await coordinator.acceptMemoryAnswerTask({
          origin: "mcp",
          max_queued: 16,
          request: {
            input: {
              query: "Dinner?",
              search_domain: searchDomain,
              ...(searchDomain === "project" ? { project_id: cwd } : {}),
              team_workspace_id: workspaceId,
              ...(explicitBackend ? { team_backend_id: "team-backend" } : {})
            },
            caller: {
              cwd:
                searchDomain === "project"
                  ? path.join(env.KOED_HOME!, "runtime")
                  : "/repo"
            }
          }
        })
      ).toMatchObject({ task: { id: task.id, teamWorkspaceId: workspaceId } });
      expect(teamWorkspaceContexts).toHaveBeenCalledWith(
        "team-backend",
        expect.stringContaining("Koed-Device koed_local_"),
        undefined
      );
      const [url, options] = fetch.mock.calls[0]!;
      expect(String(url)).toContain(
        "/v1/local-edge/memory-answer-tasks/accept"
      );
      expect(new Headers(options?.headers).get("authorization")).toMatch(
        /^Koed-Device koed_local_/
      );
      const payload = JSON.parse(String(options?.body)) as {
        upstream_backend_id: string;
        input: { request: { input: Record<string, unknown> } };
      };
      expect(payload).toMatchObject({
        upstream_backend_id: "team-backend",
        input: {
          request: {
            input: {
              query: "Dinner?",
              search_domain: searchDomain,
              team_workspace_id: workspaceId
            }
          }
        }
      });
      const pinned = payload.input.request.input.repository_context;
      const project =
        searchDomain === "project"
          ? requirePortableTeamRepositoryContext(pinned)
          : null;
      if (project) expect(project.root).toBe(fs.realpathSync(cwd));
      expect(payload.input.request.input).toEqual(
        memoryAnswerInputSchema.parse({
          query: "Dinner?",
          search_domain: searchDomain,
          team_workspace_id: workspaceId,
          repository_context: project ?? null,
          ...(project ? { project_id: repositoryScopeId(project) } : {})
        })
      );
    }
  );

  it("rejects a nonportable Team Project before sending it to the task queue", async () => {
    const env = enrollment(["team-backend"], true);
    const cwd = path.join(env.KOED_HOME!, "local-folder");
    fs.mkdirSync(cwd);
    const client = new MemoryApiClient({ apiUrl: "http://127.0.0.1:3001" });
    vi.spyOn(client, "teamWorkspaceContexts").mockResolvedValue({
      workspaces: [context]
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const coordinator = createMemoryAnswerTaskCoordinator(client, env);
    await expect(
      coordinator.acceptMemoryAnswerTask({
        origin: "mcp",
        max_queued: 16,
        request: {
          input: {
            query: "Local decision",
            search_domain: "project",
            team_workspace_id: workspaceId
          },
          caller: { cwd }
        }
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      memoryAnswerTaskErrorCode: "invalid_project_scope"
    });
    expect(fetch).not.toHaveBeenCalled();
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
