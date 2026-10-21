import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@koed/shared/project-contract";
import type {
  ProjectsDesktopApi,
  WorkspaceProjectShareContext
} from "../../../ipc/projects-protocol.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import { createShareProjectFlow } from "./share-project-flow.js";

const project = {
  id: randomUUID(),
  name: "Plan",
  key: "PLAN",
  workspaceProjectId: null
} as Project;
const backendId = "cloud";
const principalId = randomUUID();
const teamId = randomUUID();
const workspaceId = randomUUID();
const ready = (): WorkspaceProjectShareContext => ({
  state: "ready",
  backendId,
  profile: "koed_managed_cloud",
  principalId,
  teams: [
    {
      id: teamId,
      name: "Team",
      role: "owner",
      people: [{ id: principalId, displayName: "Owner" }],
      workspaces: [{ id: workspaceId, name: "Plan", access: "write" }]
    }
  ]
});

describe("Share Project flow", () => {
  it("resumes the exact durable Team target after a Desktop restart without creating another Workspace", async () => {
    const createWorkspace = vi.fn();
    const sharedFirstShare = vi.fn(async () => ({
      id: randomUUID(),
      teamId,
      workspaceId
    }));
    const projects = {
      sharedShareContext: async () => ready(),
      sharedPendingShare: async () => ({
        teamBackendId: backendId,
        shareAttemptKey: "attempt-restart",
        targetTeamId: teamId,
        targetWorkspaceId: workspaceId,
        state: "pending" as const
      }),
      sharedFirstShare
    } as unknown as ProjectsDesktopApi;
    const flow = createShareProjectFlow(projects, {
      createWorkspace
    } as unknown as CollaborationRendererClient);
    await flow.share(project, { kind: "team", teamId }, "attempt-restart");
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(sharedFirstShare).toHaveBeenCalledWith(project.id, backendId, {
      teamId,
      workspaceId,
      name: project.name,
      key: project.key,
      shareAttemptKey: "attempt-restart"
    });
  });

  it("rejects a changed attempt key or target before any Team write", async () => {
    const createWorkspace = vi.fn();
    const sharedFirstShare = vi.fn();
    const projects = {
      sharedShareContext: async () => ready(),
      sharedPendingShare: async () => ({
        teamBackendId: backendId,
        shareAttemptKey: "original-key",
        targetTeamId: teamId,
        targetWorkspaceId: workspaceId,
        state: "pending" as const
      }),
      sharedFirstShare
    } as unknown as ProjectsDesktopApi;
    const flow = createShareProjectFlow(projects, {
      createWorkspace
    } as unknown as CollaborationRendererClient);
    await expect(
      flow.share(project, { kind: "team", teamId }, "other-key")
    ).rejects.toThrow("different first-share attempt");
    await expect(
      flow.share(
        project,
        { kind: "team", teamId: randomUUID() },
        "original-key"
      )
    ).rejects.toThrow("different first-share attempt");
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(sharedFirstShare).not.toHaveBeenCalled();
  });

  it("does not mutate a Project without a verified enrolled Team context", async () => {
    const createTeam = vi.fn();
    const sharedFirstShare = vi.fn();
    const projects = {
      sharedShareContext: async () => ({
        ...ready(),
        state: "needs_cloud_enrollment",
        principalId: null,
        teams: []
      }),
      sharedFirstShare
    } as unknown as ProjectsDesktopApi;
    const flow = createShareProjectFlow(projects, {
      createTeam
    } as unknown as CollaborationRendererClient);
    await expect(
      flow.share(project, { kind: "new_team" }, "attempt-cloud")
    ).rejects.toThrow("Sign in to Koed cloud");
    expect(createTeam).not.toHaveBeenCalled();
    expect(sharedFirstShare).not.toHaveBeenCalled();
  });
  it("lets a Project owner with write Workspace Access use an existing Team Workspace without Team manager promotion", async () => {
    const createWorkspace = vi.fn();
    const sharedFirstShare = vi.fn(async () => ({
      id: randomUUID(),
      teamId,
      workspaceId
    }));
    const projects = {
      sharedShareContext: async () => ({
        ...ready(),
        teams: [{ ...ready().teams[0]!, role: "member" as const }]
      }),
      sharedPendingShare: async () => null,
      sharedFirstShare
    } as unknown as ProjectsDesktopApi;
    await createShareProjectFlow(projects, {
      createWorkspace
    } as unknown as CollaborationRendererClient).share(
      project,
      { kind: "workspace", teamId, workspaceId },
      "existing-workspace-attempt"
    );
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(sharedFirstShare).toHaveBeenCalledWith(
      project.id,
      backendId,
      expect.objectContaining({ teamId, workspaceId })
    );
  });
});
