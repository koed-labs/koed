import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceProjectDesktopService } from "./workspace-project-service.js";

describe("Desktop joined Project handoff", () => {
  it("joins current Team authority before creating an own Personal link", async () => {
    const workspaceProjectId = randomUUID();
    const workspaceId = randomUUID();
    const teamId = randomUUID();
    const principalId = randomUUID();
    const personalProjectId = randomUUID();
    const order: string[] = [];
    const teamProject = {
      id: workspaceProjectId,
      teamId,
      workspaceId,
      ownerTeamMemberId: randomUUID(),
      name: "Shared class",
      key: "CLASS",
      lifecycle: "active" as const,
      version: 2,
      copiedAt: new Date().toISOString()
    };
    const created = { id: personalProjectId, version: 1 };
    const linked = {
      ...created,
      version: 2,
      workspaceProjectId,
      teamBackendId: "team-backend"
    };
    const sendTeam = vi.fn(async (_backendId: string, path: string) => {
      if (path.endsWith("/join")) {
        order.push("team-join");
        return teamProject;
      }
      order.push("member-proof");
      return {
        projectId: workspaceProjectId,
        teamId,
        workspaceId,
        memberTeamMemberId: randomUUID(),
        memberUserId: principalId,
        projectVersion: 2,
        memberVersion: 1
      };
    });
    const createJoinedProject = vi.fn(async () => {
      order.push("personal-create");
      return created;
    });
    const confirmJoinedProject = vi.fn(async () => {
      order.push("personal-confirm");
      return linked;
    });
    const service = createWorkspaceProjectDesktopService({
      identityKey: async () => "owner|team-backend",
      loadShareContext: async () =>
        ({
          state: "ready",
          backendId: "team-backend",
          principalId,
          teams: [
            { id: teamId, workspaces: [{ id: workspaceId, access: "write" }] }
          ]
        }) as never,
      sendTeam,
      createJoinedProject: createJoinedProject as never,
      confirmJoinedProject: confirmJoinedProject as never,
      loadPersonalCopy: vi.fn() as never,
      loadPersonalSource: vi.fn() as never,
      loadLinkedPersonalSources: vi.fn() as never,
      markPersonalMoved: vi.fn() as never,
      stageTeamLeave: vi.fn() as never,
      finishTeamLeave: vi.fn() as never,
      dispatchLocal: vi.fn() as never,
      loadDispatches: vi.fn() as never,
      loadPersonalLink: vi.fn() as never,
      uploadLinkedSource: vi.fn() as never,
      readLinkedSource: vi.fn() as never
    });
    const result = await service({
      operation: "sharedJoinProject",
      workspaceProjectId,
      teamBackendId: "team-backend"
    });
    expect(result).toEqual({ operation: "sharedJoinProject", project: linked });
    expect(order).toEqual([
      "team-join",
      "member-proof",
      "personal-create",
      "personal-confirm"
    ]);
    expect(sendTeam).toHaveBeenCalledWith(
      "team-backend",
      `/v1/workspace-projects/${workspaceProjectId}/join`,
      { method: "POST" }
    );
    expect(createJoinedProject).toHaveBeenCalledWith(
      workspaceProjectId,
      "team-backend",
      "Shared class"
    );
    expect(confirmJoinedProject).toHaveBeenCalledWith(
      personalProjectId,
      workspaceProjectId,
      "team-backend",
      1
    );
  });
});
