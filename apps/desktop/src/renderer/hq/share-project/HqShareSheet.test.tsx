// @vitest-environment happy-dom

import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@koed/shared/project-contract";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import { HqShareSheet } from "./HqShareSheet.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const collaborationFixture = {
  current: () => null,
  reviewProjectLifecycle: async () => {
    throw new Error("No active Team owner review in this fixture");
  }
} as unknown as CollaborationRendererClient;

describe("Share Project pending cancellation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("requires an explicit cancel action and keeps the pending attempt on an uncertain reply", async () => {
    const project = {
      id: randomUUID(),
      name: "Plan",
      key: "PLAN",
      workspaceProjectId: null
    } as Project;
    const teamId = randomUUID();
    const workspaceId = randomUUID();
    const principalId = randomUUID();
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error("Team unavailable"))
      .mockResolvedValueOnce({ canceled: true });
    const projects = {
      sharedShareContext: async () => ({
        state: "ready",
        backendId: "cloud",
        profile: "koed_managed_cloud",
        principalId,
        teams: [
          {
            id: teamId,
            name: "Team",
            role: "owner",
            people: [{ id: principalId, displayName: "Owner" }],
            workspaces: [{ id: workspaceId, name: "General", access: "write" }]
          }
        ]
      }),
      sharedPendingShare: async () => ({
        teamBackendId: "cloud",
        shareAttemptKey: "pending-attempt",
        targetTeamId: teamId,
        targetWorkspaceId: workspaceId,
        state: "pending"
      }),
      sharedCancelPendingShare: cancel
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqShareSheet
          open
          project={project}
          projectsApi={projects}
          collaboration={collaborationFixture}
          identityKey="owner:profile"
          onClose={() => undefined}
          onShared={() => undefined}
        />
      )
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const button = () =>
      [...document.querySelectorAll("button")].find(
        (item) => item.textContent === "Cancel pending share"
      ) as HTMLButtonElement | undefined;
    expect(button()).toBeDefined();
    await act(async () => button()!.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(button()).toBeDefined();
    expect(document.body.textContent).toContain("Team unavailable");
    await act(async () => button()!.click());
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(button()).toBeUndefined();
    expect(document.body.textContent).toContain("Share Project");
  });

  it("offers summary Native review after first share without making the Project private on cancellation", async () => {
    const project = {
      id: randomUUID(),
      name: "Plan",
      key: "PLAN",
      workspaceProjectId: null
    } as Project;
    const teamId = randomUUID();
    const workspaceId = randomUUID();
    const principalId = randomUUID();
    const share = vi.fn().mockResolvedValue({
      id: randomUUID(),
      teamId,
      workspaceId,
      version: 1
    });
    const enable = vi
      .fn()
      .mockRejectedValue(new Error("Project summary sharing was canceled."));
    const onShared = vi.fn();
    const projects = {
      sharedShareContext: async () => ({
        state: "ready",
        backendId: "cloud",
        profile: "koed_managed_cloud",
        principalId,
        teams: [
          {
            id: teamId,
            name: "Team",
            role: "owner",
            people: [{ id: principalId, displayName: "Owner" }],
            workspaces: [{ id: workspaceId, name: "Launch", access: "write" }]
          }
        ]
      }),
      sharedPendingShare: async () => ({
        teamBackendId: "cloud",
        shareAttemptKey: "pending-attempt",
        targetTeamId: teamId,
        targetWorkspaceId: workspaceId,
        state: "pending"
      }),
      sharedFirstShare: share,
      sharedPolicyStatus: vi.fn().mockResolvedValue({
        projectId: randomUUID(),
        teamId,
        workspaceId,
        projectName: "Plan",
        policyVersion: 0,
        status: "absent",
        manifestId: null,
        manifestHash: null,
        eligibleCount: 0,
        reviewSources: []
      }),
      sharedPolicyEnable: enable
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqShareSheet
          open
          project={project}
          projectsApi={projects}
          collaboration={collaborationFixture}
          identityKey="owner:profile"
          onClose={() => undefined}
          onShared={onShared}
        />
      )
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const resume = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "Resume sharing"
    );
    expect(resume).toBeDefined();
    await act(async () =>
      resume!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(share).toHaveBeenCalledTimes(1);
    expect(onShared).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(document.body.textContent).toContain("Project shared");
    expect(document.body.textContent).toContain(
      "Project summary sharing was canceled."
    );
    expect(document.body.textContent).toContain("Review summary sharing");
  });

  it("ignores a previous Project roster reply after the owner scope changes", async () => {
    const oldProject = {
      id: randomUUID(),
      name: "Old",
      key: "OLD",
      workspaceProjectId: randomUUID(),
      teamBackendId: "cloud"
    } as Project;
    const newProject = {
      ...oldProject,
      id: randomUUID(),
      name: "New"
    } as Project;
    let resolveOld!: (value: unknown) => void;
    const members = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValue({
        projectId: newProject.workspaceProjectId,
        version: 1,
        people: [
          {
            teamMemberId: randomUUID(),
            displayName: "New member",
            access: "read"
          }
        ]
      });
    const projects = {
      sharedShareContext: async () => ({
        state: "ready",
        backendId: "cloud",
        profile: "koed_managed_cloud",
        principalId: randomUUID(),
        teams: []
      }),
      sharedMembers: members,
      sharedPolicyStatus: async () => ({
        projectId: oldProject.workspaceProjectId,
        teamId: randomUUID(),
        workspaceId: randomUUID(),
        projectName: "New",
        policyVersion: 0,
        status: "absent",
        manifestId: null,
        manifestHash: null,
        eligibleCount: 0,
        reviewSources: []
      })
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqShareSheet
          key="old"
          open
          project={oldProject}
          projectsApi={projects}
          collaboration={collaborationFixture}
          identityKey="old-owner"
          onClose={() => undefined}
          onShared={() => undefined}
        />
      )
    );
    await act(async () =>
      root.render(
        <HqShareSheet
          key="new"
          open
          project={newProject}
          projectsApi={projects}
          collaboration={collaborationFixture}
          identityKey="new-owner"
          onClose={() => undefined}
          onShared={() => undefined}
        />
      )
    );
    await act(async () =>
      resolveOld({
        projectId: oldProject.workspaceProjectId,
        version: 1,
        people: [
          {
            teamMemberId: randomUUID(),
            displayName: "Old private member",
            access: "write"
          }
        ]
      })
    );
    expect(document.body.textContent).not.toContain("Old private member");
    expect(document.body.textContent).toContain("New member");
  });
});
