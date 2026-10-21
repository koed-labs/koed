import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { teamDeckTextActionHash, teamDeckCreateFromTextAction } from "@koed/db";
import { createManagedTextActionTeamAdapter } from "./text-action-team-authority.js";

const ownerUserId = randomUUID();
const projectId = randomUUID();
const workspaceProjectId = randomUUID();
const workItemId = randomUUID();
const sourceOwnerTeamMemberId = randomUUID();
const backendId = "team-vps";
const teamId = randomUUID();
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
    if (
      url.pathname.endsWith(`/teams/${teamId}/workspace-project-leave-review`)
    )
      return Response.json({
        team: { id: teamId, version: 4 },
        membership: { userId: principal, status: "enabled", version: 3 }
      });
    if (url.pathname.endsWith(`/teams/${teamId}/text-action-lifecycle-proof`))
      return Response.json({
        confirmed: JSON.parse(String(init?.body)).effectKey === workItemId
      });
    if (
      url.pathname.endsWith(
        `/workspace-projects/${workspaceProjectId}/lifecycle-review`
      )
    )
      return Response.json({
        project: { id: workspaceProjectId, teamId, version },
        actorUserId: principal,
        actorMemberVersion: 3
      });
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
  it("binds group and Project leave proposals to the current enrolled Team principal", async () => {
    const f = fixture();
    await expect(
      f.teamLeaveAuthority({ ownerUserId, teamId })
    ).resolves.toEqual({
      teamBackendId: backendId,
      teamPrincipalUserId: await f.personal.principalBinding(),
      expectedMembershipVersion: 3,
      expectedTeamVersion: 4
    });
    await expect(
      f.authority({ ...scope, name: "koed_project_leave" })
    ).resolves.toMatchObject({
      teamId,
      teamProjectVersion: 7,
      teamMemberVersion: 3
    });
    const principal = await f.personal.principalBinding();
    await expect(
      f.lifecycleReceipt({
        ownerUserId,
        teamBackendId: backendId,
        teamPrincipalUserId: principal,
        teamId,
        targetId: teamId,
        effectKey: workItemId,
        name: "koed_workspace_leave",
        expectedMembershipVersion: 3,
        expectedTeamVersion: 4
      })
    ).resolves.toBe(true);
    expect(f.fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        body: JSON.stringify({
          effectKey: workItemId,
          targetId: teamId,
          action: "team.leave",
          expectedMembershipVersion: 3,
          expectedTeamVersion: 4
        })
      })
    );
    f.setPrincipal(randomUUID());
    await expect(
      f.lifecycleReceipt({
        ownerUserId,
        teamBackendId: backendId,
        teamPrincipalUserId: principal,
        teamId,
        targetId: teamId,
        effectKey: workItemId,
        name: "koed_workspace_leave",
        expectedMembershipVersion: 3,
        expectedTeamVersion: 4
      })
    ).resolves.toBe(false);
  });
  it("sends strict Team cards and verifies a same-device salted receipt", async () => {
    const f = fixture();
    const actionId = randomUUID();
    const runnerDeviceId = randomUUID();
    const nonce = "A".repeat(43);
    const args = {
      projectId,
      title: "Chapter 7",
      scope: "Midterm only",
      madeFrom: "Notes",
      cards: [{ question: "Q?", answer: "A." }]
    };
    const payload = teamDeckCreateFromTextAction(actionId, args);
    const createdAt = new Date().toISOString();
    const deckId = randomUUID();
    const deck = {
      id: deckId,
      projectId: workspaceProjectId,
      title: args.title,
      scope: args.scope,
      madeFrom: args.madeFrom,
      createdByAgentId: null,
      uses: 0,
      version: 1,
      createdAt,
      updatedAt: createdAt,
      cards: [
        {
          id: randomUUID(),
          deckId,
          question: "Q?",
          answer: "A.",
          sourceRef: null,
          topicLabel: null,
          version: 1,
          createdAt,
          updatedAt: createdAt
        }
      ]
    };
    const proof = teamDeckTextActionHash({
      actionId,
      teamBackendId: backendId,
      workspaceProjectId,
      teamUserId: await f.personal.principalBinding(),
      runnerDeviceId,
      deviceCredentialKeyId: "sealed",
      operationFamily: "team_workspace_write",
      payload,
      nonce
    });
    f.fetch.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/decks/from-text-action") && init?.method === "POST")
        return Response.json(deck, { status: 201 });
      if (path.endsWith(`/decks/by-creation-key/${actionId}`))
        return Response.json({
          deck,
          creationPayloadHash: proof,
          requestDeviceInstanceId: runnerDeviceId
        });
      return Response.json({}, { status: 404 });
    });
    const created = await f.createDeck({
      ...scope,
      actionId,
      effectNonce: nonce,
      runnerDeviceId,
      expectedProjectVersion: 7,
      expectedMemberVersion: 3,
      payload
    });
    expect(created.id).toBe(deckId);
    const posted = f.fetch.mock.calls.find(
      ([, init]) => init?.method === "POST"
    );
    expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({
      ...payload,
      runnerDeviceId,
      teamBackendId: backendId,
      textActionNonce: nonce
    });
    expect(JSON.parse(String(posted?.[1]?.body))).not.toHaveProperty(
      "createdByAgentId"
    );
    expect(
      (
        await f.findDeck({
          ...scope,
          actionId,
          effectNonce: nonce,
          arguments: args,
          runnerDeviceId
        })
      )?.id
    ).toBe(deckId);
    expect(
      await f.findDeck({
        ...scope,
        actionId,
        effectNonce: nonce,
        arguments: args,
        runnerDeviceId: randomUUID()
      })
    ).toBeNull();
    expect(
      (
        await f.receipt({
          ...scope,
          name: "koed_deck_make",
          effectKey: actionId,
          effectNonce: nonce,
          arguments: args,
          snapshot: { runnerDeviceId }
        })
      ).confirmed
    ).toBe(true);
  });
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
