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
          collaboration={{} as CollaborationRendererClient}
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
});
