// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import type { ProjectsDesktopApi } from "../../ipc/projects-protocol.js";
import { HqTeamGroups } from "./HqTeamGroups.js";

describe("HQ shared group departure", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    container = null;
    root = null;
  });
  it("shows the exact owned Project effect before the real leave action and offers no Undo", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const teamId = "00000000-0000-4000-8000-000000000704";
    const stage = vi.fn(async () => ({
      teamId,
      expectedMembershipVersion: 3,
      expectedOwnedWorkspaceProjects: [
        { id: "00000000-0000-4000-8000-000000000705", version: 1 }
      ]
    }));
    const leave = vi.fn(async () => ({}));
    const client = {
      current: () => ({
        connection: { backendId: "team-backend" },
        navigation: {
          teamPrincipal: { id: "00000000-0000-4000-8000-000000000706" },
          teams: [
            {
              id: teamId,
              name: "Research",
              role: "member",
              membershipVersion: 3
            }
          ]
        }
      }),
      leaveTeam: leave,
      listRestorableProjects: vi.fn(async () => [])
    } as unknown as CollaborationRendererClient;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <HqTeamGroups
          open
          onClose={() => {}}
          onFinished={() => {}}
          client={client}
          projectsApi={
            { sharedTeamLeaveStage: stage } as unknown as ProjectsDesktopApi
          }
          ownerId="owner"
          profileKey="team-backend"
        />
      )
    );
    const click = async (label: string) => {
      const button = [...container!.querySelectorAll("button")].find((item) =>
        item.textContent?.includes(label)
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    await click("Research");
    await click("Review leave");
    expect(stage).toHaveBeenCalledWith("team-backend", teamId);
    expect(leave).not.toHaveBeenCalled();
    expect(container.textContent).toContain("1 owned Project stays in Just me");
    expect(container.textContent).toContain(
      "A member must send a new invitation"
    );
    expect(container.textContent).toContain("no Undo");
    await click("Leave group");
    expect(leave).toHaveBeenCalledExactlyOnceWith({
      teamId,
      expectedVersion: 3
    });
    expect(container.textContent).not.toContain("Undo");
  });
});
