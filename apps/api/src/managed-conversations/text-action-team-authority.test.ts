import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedTextActionTeamAdapter } from "./text-action-team-authority.js";

const ownerUserId = randomUUID();
const projectId = randomUUID();
const workspaceProjectId = randomUUID();
const workItemId = randomUUID();
const sourceOwnerTeamMemberId = randomUUID();
const backendId = "team-vps";
const scope = {
  ownerUserId,
  projectId,
  teamBackendId: backendId,
  workspaceProjectId
};
const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "koed-hq504-team-"));
  directories.push(directory);
  const path = join(directory, "backends.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: backendId,
      backends: [
        {
          id: backendId,
          baseUrl: "https://team.example.test/",
          routePolicy: { teamWorkspaceRead: "enabled" }
        }
      ]
    })
  );
  let linked = true;
  let principal: string = randomUUID();
  let version = 7;
  let offline = false;
  const item = {
    id: workItemId,
    sourceOwnerTeamMemberId,
    sourceWorkItemId: null,
    kind: "todo",
    key: null,
    title: "Write plan",
    goal: "Write plan",
    status: "todo",
    dueOn: null,
    doneAt: null,
    assigneeDisplayName: null,
    stepLabel: null,
    dispatchKey: null,
    prUrl: null,
    prState: null,
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new Error("Team unavailable");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: "Koed-Device sealed:secret"
    });
    const url = new URL(String(input));
    if (url.pathname.endsWith("/proposal-proof"))
      return Response.json({
        projectId: workspaceProjectId,
        itemId: workItemId,
        projectVersion: version,
        memberVersion: 3,
        workItemVersion: 2,
        workItemTitle: "Team to-do"
      });
    if (url.pathname.endsWith(`/text-action-effects/${workItemId}`))
      return Response.json({ item, effectNonceHash: "a".repeat(64) });
    if (
      url.pathname.endsWith(
        `/workspace-projects/${workspaceProjectId}/work-items`
      ) &&
      init?.method === "POST"
    )
      return Response.json(item, { status: 201 });
    if (url.pathname.endsWith("/dispatch-status"))
      return Response.json({
        id: workItemId,
        version: 3,
        status: "doing",
        stepLabel: "Working now",
        dispatchKey: url.searchParams.get("dispatchKey"),
        prUrl: null,
        prState: null
      });
    return Response.json({}, { status: 404 });
  });
  const personal = {
    getLink: vi.fn(async () =>
      linked
        ? { ownerUserId, teamBackendId: backendId, workspaceProjectId }
        : null
    ),
    principalBinding: vi.fn(async () => principal)
  };
  const lifecycle = vi.fn(async () => ({
    projectVersion: version,
    memberVersion: 3
  }));
  const adapter = createManagedTextActionTeamAdapter(
    {
      localEdge: {
        upstreamBackendsPath: path,
        remoteOperationsAllowed: () => true,
        resolveUpstreamAuthorization: () => "Koed-Device sealed:secret",
        fetch
      },
      requireRepository: () => ({
        getSharedWorkItemDispatch: async () => ({
          textActionId: workItemId,
          workspaceProjectId,
          teamBackendId: backendId,
          teamWorkItemId: workItemId,
          teamWorkItemVersion: 2,
          agentId: sourceOwnerTeamMemberId
        })
      })
    } as never,
    personal as never,
    lifecycle
  );
  return {
    ...adapter,
    fetch,
    personal,
    lifecycle,
    item,
    setLinked: (next: boolean) => {
      linked = next;
    },
    setPrincipal: (next: string) => {
      principal = next;
    },
    setVersion: (next: number) => {
      version = next;
    },
    setOffline: (next: boolean) => {
      offline = next;
    }
  };
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
describe("Managed text action Team authority", () => {
  it("sends the exact effect request only after current bound Team CAS proof", async () => {
    const f = fixture();
    const input = {
      ...scope,
      actionId: workItemId,
      effectNonce: "a".repeat(43),
      title: "Write plan",
      goal: "Write plan",
      dueOn: null,
      expectedProjectVersion: 7,
      expectedMemberVersion: 3
    };
    await expect(f.applyTodoAdd(input)).resolves.toBeUndefined();
    const posted = f.fetch.mock.calls.find(
      ([, init]) => init?.method === "POST"
    );
    expect(posted?.[1]?.body).toContain(`"textActionId":"${workItemId}"`);
    expect(posted?.[1]?.body).toContain(
      `"textActionNonce":"${input.effectNonce}"`
    );
    f.fetch.mockClear();
    await expect(
      f.applyTodoAdd({ ...input, expectedProjectVersion: 6 })
    ).rejects.toThrow("authority changed");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("pins current Team Project, member and Work Item versions", async () => {
    const f = fixture();
    await expect(f.authority({ ...scope, workItemId })).resolves.toEqual({
      teamProjectVersion: 7,
      teamMemberVersion: 3,
      workItemId,
      workItemVersion: 2,
      workItemTitle: "Team to-do"
    });
    expect(f.lifecycle).toHaveBeenCalled();
  });
  it("fails closed on a changed link, principal, stale Team version or offline read", async () => {
    const f = fixture();
    f.setLinked(false);
    await expect(f.authority({ ...scope, workItemId })).rejects.toThrow();
    f.setLinked(true);
    f.personal.getLink.mockImplementationOnce(async () => ({
      ownerUserId,
      teamBackendId: backendId,
      workspaceProjectId
    }));
    f.personal.principalBinding.mockImplementationOnce(async () =>
      randomUUID()
    );
    await expect(f.authority({ ...scope, workItemId })).rejects.toThrow();
    f.setVersion(8);
    f.lifecycle.mockResolvedValueOnce({ projectVersion: 7, memberVersion: 3 });
    await expect(f.authority({ ...scope, workItemId })).rejects.toThrow();
    f.setOffline(true);
    await expect(f.authority({ ...scope, workItemId })).rejects.toThrow();
  });
  it("proves only the exact Team create or dispatch receipt", async () => {
    const f = fixture();
    await expect(
      f.receipt({
        ...scope,
        name: "koed_todo_add",
        effectKey: workItemId,
        arguments: { title: "Write plan" },
        snapshot: {}
      })
    ).resolves.toEqual({ confirmed: true, effectNonceHash: "a".repeat(64) });
    await expect(
      f.receipt({
        ...scope,
        name: "koed_todo_add",
        effectKey: workItemId,
        arguments: { title: "Other" },
        snapshot: {}
      })
    ).resolves.toEqual({ confirmed: false, effectNonceHash: "a".repeat(64) });
    await expect(
      f.receipt({
        ...scope,
        name: "koed_todo_send",
        effectKey: workItemId,
        arguments: { workItemId, agentId: sourceOwnerTeamMemberId },
        snapshot: { workItemVersion: 2 }
      })
    ).resolves.toEqual({ confirmed: true, effectNonceHash: null });
    await expect(
      f.receipt({
        ...scope,
        name: "koed_todo_send",
        effectKey: randomUUID(),
        arguments: { workItemId, agentId: sourceOwnerTeamMemberId },
        snapshot: { workItemVersion: 2 }
      })
    ).resolves.toEqual({ confirmed: false, effectNonceHash: null });
    f.setLinked(false);
    await expect(
      f.receipt({
        ...scope,
        name: "koed_todo_send",
        effectKey: workItemId,
        arguments: { workItemId, agentId: sourceOwnerTeamMemberId },
        snapshot: { workItemVersion: 2 }
      })
    ).rejects.toThrow();
  });
});
