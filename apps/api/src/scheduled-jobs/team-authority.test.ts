import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduledJobTeamAuthority } from "./team-authority.js";

const ownerUserId = randomUUID(),
  projectId = randomUUID(),
  workspaceProjectId = randomUUID();
const teamPrincipalUserId = randomUUID(),
  teamBackendId = "team-vps";
const scope = { ownerUserId, projectId, workspaceProjectId, teamBackendId };
const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "koed-hq601-team-"));
  directories.push(directory);
  const path = join(directory, "backends.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: teamBackendId,
      backends: [
        {
          id: teamBackendId,
          baseUrl: "https://team.example.test/",
          routePolicy: { teamWorkspaceRead: "enabled" }
        }
      ]
    })
  );
  let principal: string = teamPrincipalUserId;
  let canWrite = true,
    active = true,
    linked = true,
    offline = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new Error("Team offline");
    expect(init?.headers).toMatchObject({
      authorization: "Koed-Device verified:secret"
    });
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/v1/local-edge/device-credentials/status")
      return Response.json({
        ok: true,
        auth: "device_credential",
        user: { id: principal }
      });
    if (pathname === `/v1/workspace-projects/${workspaceProjectId}/lifecycle`)
      return Response.json({
        id: workspaceProjectId,
        active,
        canWrite,
        version: 7,
        memberVersion: 3
      });
    return Response.json({}, { status: 404 });
  });
  const personal = {
    getLink: vi.fn(async () =>
      linked ? { ownerUserId, teamBackendId, workspaceProjectId } : null
    ),
    principalBinding: vi.fn(async () => teamPrincipalUserId)
  };
  const context = {
    localEdge: {
      upstreamBackendsPath: path,
      remoteOperationsAllowed: () => true,
      resolveUpstreamAuthorization: () => "Koed-Device verified:secret",
      fetch
    }
  };
  const authority = createScheduledJobTeamAuthority(
    context as never,
    personal as never
  );
  return {
    authority,
    fetch,
    personal,
    setPrincipal: (value: string) => {
      principal = value;
    },
    setWrite: (value: boolean) => {
      canWrite = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setLink: (value: boolean) => {
      linked = value;
    },
    setOffline: (value: boolean) => {
      offline = value;
    }
  };
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
describe("Scheduled Job Team authority", () => {
  it("binds the Personal link and enrolled principal to current Team versions", async () => {
    const f = fixture();
    await expect(f.authority(scope)).resolves.toEqual({
      projectVersion: 7,
      memberVersion: 3
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.personal.getLink).toHaveBeenCalledTimes(2);
  });
  it("fails closed on changed principal, access, lifecycle, link or offline Team", async () => {
    const f = fixture();
    f.setPrincipal(randomUUID());
    await expect(f.authority(scope)).rejects.toThrow();
    f.setPrincipal(teamPrincipalUserId);
    f.setWrite(false);
    await expect(f.authority(scope)).rejects.toThrow();
    f.setWrite(true);
    f.setActive(false);
    await expect(f.authority(scope)).rejects.toThrow();
    f.setActive(true);
    f.setLink(false);
    await expect(f.authority(scope)).rejects.toThrow();
    f.setLink(true);
    f.setOffline(true);
    await expect(f.authority(scope)).rejects.toThrow();
  });
});
