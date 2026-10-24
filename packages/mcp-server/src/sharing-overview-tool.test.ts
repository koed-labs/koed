import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  storeDesktopLocalCredential,
  type SharingAgentOverview
} from "@koed/shared";
import {
  filterSharingOverview,
  readManagedSharingOverview,
  registerSharingOverviewTool
} from "./sharing-overview-tool.js";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-24T10:00:00.000Z";
const payload: SharingAgentOverview = {
  version: 1,
  overview: {
    backends: [
      {
        backendId: "alpha",
        status: "available",
        reachedAt: at,
        incomingInvitations: [
          {
            id: other,
            team: { id, name: "Shared group" },
            workspace: { id, name: "Research" },
            project: { id, name: "Shared with you" },
            inviter: { displayName: "Sender", agentDisplayName: null },
            access: "view",
            expiresAt: at
          }
        ],
        data: {
          invitations: [],
          workspaceAccess: [],
          projects: [
            {
              id,
              teamId: id,
              teamWorkspaceId: id,
              name: "Investor deck",
              owner: { id, displayName: "Owner" },
              group: { id, name: "Koed team" },
              ownedByMe: true,
              joinedByMe: true,
              counts: { members: 2, invitations: 0 },
              invitations: [],
              members: ["Mark", "Zoe"].map((displayName) => ({
                kind: "workspace_access" as const,
                teamId: id,
                teamWorkspaceId: id,
                workspaceProjectId: id,
                person: {
                  id: displayName === "Mark" ? other : id,
                  displayName
                },
                how: "direct" as const,
                access: "edit" as const,
                status: "joined" as const,
                since: at,
                version: 1,
                canRemove: true,
                origin: {
                  actorKind: "agent_on_behalf" as const,
                  accessMode: "full_access" as const,
                  agentDisplayName: "Cooper",
                  source: { kind: "not_recorded" as const }
                }
              }))
            }
          ]
        }
      },
      {
        backendId: "beta",
        status: "unavailable",
        reason: "unreachable",
        lastReachedAt: null
      }
    ]
  },
  teams: [
    {
      backendId: "alpha",
      status: "available",
      teams: [
        {
          teamId: id,
          name: "Koed team",
          role: "owner",
          people: [
            {
              id: other,
              name: "Mark",
              role: "member",
              status: "enabled",
              version: 1,
              canRemove: true
            }
          ]
        }
      ]
    },
    { backendId: "beta", status: "unavailable", reason: "unreachable" }
  ]
};
const homes: string[] = [];
const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "koed-sharing-tool-"));
  homes.push(home);
  const credential = storeDesktopLocalCredential(home, {
    ownerUserId: id,
    operationFamilies: ["personal_collaboration_read", "managed_execution"]
  });
  const environment = {
    KOED_HOME: home,
    KOED_MANAGED_TEXT_ACTIONS: "1",
    KOED_MANAGED_RECALL_EXECUTION_ID: id,
    KOED_MANAGED_RECALL_EXECUTION_GENERATION: "3",
    KOED_MANAGED_RECALL_API_URL: "http://127.0.0.1:7777"
  };
  return { credential, environment };
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("sharing_overview data tool", () => {
  it("returns authenticated Sharing data rather than a text-action receipt without exposing credentials", async () => {
    const { credential, environment } = setup();
    const send = vi.fn<typeof fetch>(async () => Response.json(payload));
    const result = await readManagedSharingOverview({}, environment, send);
    expect(result).toEqual(payload);
    const [url, options] = send.mock.calls[0]!;
    expect(String(url)).toBe(
      `http://127.0.0.1:7777/v1/managed-conversations/${id}/sharing-overview?executionGeneration=3`
    );
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { authorization: credential.authorization }
    });
    expect(options?.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(credential.authorization);
  });
  it("filters live person and backend-qualified Project data while retaining every unavailable backend", async () => {
    const { environment } = setup();
    const send = vi.fn<typeof fetch>(async () => Response.json(payload));
    const result = await readManagedSharingOverview(
      { person: "mark", projectId: id, backendId: "alpha" },
      environment,
      send
    );
    const backend = result.overview.backends[0]!;
    expect(backend.status).toBe("available");
    if (backend.status !== "available")
      throw new Error("Expected live backend");
    expect(
      backend.data.projects[0]?.members.map((x) => x.person.displayName)
    ).toEqual(["Mark"]);
    expect(backend.data.projects[0]?.members[0]?.origin.agentDisplayName).toBe(
      "Cooper"
    );
    expect(result.overview.backends[1]).toEqual(payload.overview.backends[1]);
    expect(result.teams[1]).toEqual(payload.teams[1]);
    expect(
      filterSharingOverview(payload.overview, { backendId: "missing" })
        .backends[1]
    ).toEqual(payload.overview.backends[1]);
  });
  it("rejects invalid arguments and nonlocal or missing managed authority before any read", async () => {
    const { environment } = setup();
    const send = vi.fn<typeof fetch>();
    await expect(
      readManagedSharingOverview({ projectId: "not-a-uuid" }, environment, send)
    ).rejects.toThrow();
    await expect(
      readManagedSharingOverview(
        {},
        {
          ...environment,
          KOED_MANAGED_RECALL_API_URL: "https://other.example"
        },
        send
      )
    ).rejects.toThrow(/current local managed/);
    await expect(readManagedSharingOverview({}, {}, send)).rejects.toThrow(
      /current local managed/
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("registers a read-only data tool only for managed clients and reports a failed read as an error", async () => {
    const { environment } = setup();
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;
    registerSharingOverviewTool(server, {});
    expect(registerTool).not.toHaveBeenCalled();
    registerSharingOverviewTool(server, environment);
    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config, handler] = registerTool.mock.calls[0] as [
      string,
      { annotations: unknown },
      (input: unknown) => Promise<{
        structuredContent?: unknown;
        isError?: boolean;
        content: unknown;
      }>
    ];
    expect(name).toBe("sharing_overview");
    expect(config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json(payload))
    );
    expect((await handler({})).structuredContent).toEqual(payload);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("offline", { status: 503 }))
    );
    const failed = await handler({});
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toBeUndefined();
    expect(JSON.stringify(failed.content)).toContain("503");
  });
});
