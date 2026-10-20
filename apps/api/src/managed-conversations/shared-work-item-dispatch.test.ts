import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import {
  ensureSharedDispatchTeamReceipt,
  readSharedDispatchAttemptAuthority,
  readSharedDispatchAuthority,
  requireSharedDispatchRunnerAuthority
} from "./shared-work-item-dispatch.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const fixture = () => {
  const home = mkdtempSync(resolve(tmpdir(), "koed-shared-dispatch-"));
  homes.push(home);
  const registry = resolve(home, "team-backends.json");
  writeFileSync(
    registry,
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: "team-vps",
      backends: [
        {
          id: "team-vps",
          baseUrl: "https://team.example.test/",
          routePolicy: { teamWorkspaceRead: "enabled" }
        }
      ]
    })
  );
  const link = {
    teamBackendId: "team-vps",
    workspaceProjectId: randomUUID(),
    teamPrincipalUserId: randomUUID()
  };
  const itemId = randomUUID();
  const requests: string[] = [];
  let principal: string = link.teamPrincipalUserId;
  let proofVersion = 7;
  let attemptAllowed = true;
  const dispatchKey = `shared-work-item:${link.workspaceProjectId}:${itemId}:7`;
  let patchResponseLost = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path.endsWith("/dispatch-receipt") && init?.method === "POST") {
      if (patchResponseLost) throw new Error("response lost");
      return Response.json({ id: itemId, status: "doing", dispatchKey });
    }
    if (path.endsWith("/device-credentials/status"))
      return Response.json({
        ok: true,
        auth: "device_credential",
        user: { id: principal }
      });
    if (path.endsWith("/lifecycle"))
      return Response.json({
        id: link.workspaceProjectId,
        active: true,
        canWrite: true,
        version: 9,
        memberVersion: 4
      });
    if (path.endsWith("/dispatch-authority"))
      return attemptAllowed
        ? Response.json({
            allowed: true,
            projectId: link.workspaceProjectId,
            itemId,
            dispatchKey,
            workItemVersion: 8
          })
        : Response.json({ error: "Dispatch attempt changed" }, { status: 409 });
    return Response.json({
      projectId: link.workspaceProjectId,
      itemId,
      projectVersion: 9,
      memberVersion: 4,
      workItemVersion: proofVersion,
      title: "Team ticket",
      goal: "Ship without Team transcript",
      status: "todo"
    });
  });
  const context = {
    localEdge: {
      upstreamBackendsPath: registry,
      remoteOperationsAllowed: () => true,
      resolveUpstreamAuthorization: () => "Koed-Device key:secret",
      fetch
    }
  } as unknown as ApiRouteContext;
  const input = {
    itemId,
    expectedProjectVersion: 9,
    expectedMemberVersion: 4,
    expectedWorkItemVersion: 7
  };
  return {
    context,
    link,
    input,
    dispatchKey,
    requests,
    setPrincipal: (value: string) => {
      principal = value;
    },
    setProofVersion: (value: number) => {
      proofVersion = value;
    },
    setAttemptAllowed: (value: boolean) => {
      attemptAllowed = value;
    },
    setPatchResponseLost: (value: boolean) => {
      patchResponseLost = value;
    }
  };
};

describe("private shared Work Item dispatch authority", () => {
  it("fetches exact current Team proof through enrolled upstream, without a renderer brief", async () => {
    const f = fixture();
    const result = await readSharedDispatchAuthority(f.context, f.link, {
      ...f.input
    });
    expect(result).toMatchObject({
      kind: "new",
      proof: {
        title: "Team ticket",
        goal: "Ship without Team transcript",
        workItemVersion: 7
      }
    });
    expect(f.requests).toEqual([
      "/v1/local-edge/device-credentials/status",
      `/v1/workspace-projects/${f.link.workspaceProjectId}/work-items/${f.input.itemId}/dispatch-proof`
    ]);
  });

  it("rejects changed Team principal or Work Item version", async () => {
    const f = fixture();
    f.setPrincipal(randomUUID());
    await expect(
      readSharedDispatchAuthority(f.context, f.link, {
        ...f.input
      })
    ).rejects.toThrow("Authoritative Team dispatch");
    expect(f.requests).toHaveLength(1);
    f.setPrincipal(f.link.teamPrincipalUserId);
    f.setProofVersion(8);
    await expect(
      readSharedDispatchAuthority(f.context, f.link, {
        ...f.input
      })
    ).rejects.toThrow("Authoritative Team dispatch");
  });

  it("denies a private command after the Team Work Item attempt changes", async () => {
    const f = fixture();
    const execution = { id: randomUUID(), projectId: randomUUID() };
    const dispatch = {
      agentId: randomUUID(),
      teamBackendId: f.link.teamBackendId,
      teamPrincipalUserId: f.link.teamPrincipalUserId,
      workspaceProjectId: f.link.workspaceProjectId,
      teamWorkItemId: f.input.itemId,
      teamWorkItemVersion: 7,
      expectedProjectVersion: 9,
      expectedMemberVersion: 4
    };
    const repo = {
      getSharedWorkItemDispatchForExecution: vi.fn(async () => dispatch),
      getSharedDispatchLink: vi.fn(async () => f.link)
    };
    const context = {
      ...f.context,
      requireRepository: () => repo
    } as unknown as ApiRouteContext;
    await requireSharedDispatchRunnerAuthority(
      context,
      randomUUID(),
      execution
    );
    expect(f.requests.at(-1)).toBe(
      `/v1/workspace-projects/${f.link.workspaceProjectId}/work-items/${f.input.itemId}/dispatch-authority`
    );
    f.setAttemptAllowed(false);
    await expect(
      requireSharedDispatchRunnerAuthority(context, randomUUID(), execution)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.getSharedWorkItemDispatchForExecution).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the Team backend is offline", async () => {
    const f = fixture();
    f.context.localEdge.remoteOperationsAllowed = () => false;
    await expect(
      readSharedDispatchAttemptAuthority(f.context, f.link, {
        itemId: f.input.itemId,
        dispatchKey: f.dispatchKey
      })
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("binds Team receipt by exact CAS and verifies the attempt, including a lost POST response", async () => {
    const f = fixture();
    await ensureSharedDispatchTeamReceipt(f.context, f.link, {
      itemId: f.input.itemId,
      teamWorkItemVersion: 7,
      dispatchKey: f.dispatchKey
    });
    expect(f.context.localEdge.fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedVersion: 7,
          dispatchKey: f.dispatchKey
        })
      })
    );
    f.setPatchResponseLost(true);
    await ensureSharedDispatchTeamReceipt(f.context, f.link, {
      itemId: f.input.itemId,
      teamWorkItemVersion: 7,
      dispatchKey: f.dispatchKey
    });
    f.setAttemptAllowed(false);
    await expect(
      ensureSharedDispatchTeamReceipt(f.context, f.link, {
        itemId: f.input.itemId,
        teamWorkItemVersion: 7,
        dispatchKey: f.dispatchKey
      })
    ).rejects.toThrow("Authoritative Team dispatch is unavailable");
  });
});
