// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import type { WorkspaceProjectLifecycleReview } from "@koed/shared/workspace-project-contract";
import { HqProjectLifecycle } from "./HqProjectLifecycle.js";

const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  other: "00000000-0000-4000-8000-000000000002",
  actorMember: "00000000-0000-4000-8000-000000000003",
  otherMember: "00000000-0000-4000-8000-000000000004",
  team: "00000000-0000-4000-8000-000000000005",
  workspace: "00000000-0000-4000-8000-000000000006",
  first: "00000000-0000-4000-8000-000000000007",
  second: "00000000-0000-4000-8000-000000000008"
};
const project = (id = ids.first) => ({
  id: `personal-${id}`,
  workspaceProjectId: id,
  teamBackendId: "team-backend",
  name: id === ids.first ? "First Project" : "Second Project"
});
const review = (
  owns: boolean,
  id = ids.first
): WorkspaceProjectLifecycleReview => ({
  project: {
    id,
    teamId: ids.team,
    workspaceId: ids.workspace,
    ownerTeamMemberId: owns ? ids.actorMember : ids.otherMember,
    name: project(id).name,
    key: "PROJ",
    lifecycle: "active",
    version: 7,
    copiedAt: null
  },
  actorUserId: ids.actor,
  actorTeamMemberId: ids.actorMember,
  actorMemberVersion: 3,
  ownerUserId: owns ? ids.actor : ids.other,
  targetUserId: null,
  targetTeamMemberId: null,
  targetMemberVersion: null,
  targetAccess: null,
  actorAccess: "write",
  actorWorkspaceAccess: "write"
});

describe("HQ Project departure ownership and scope", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    container = null;
    root = null;
  });
  const fixture = (owns: boolean, teamRole: "owner" | "member") => {
    let backend = "team-backend";
    let principal = ids.actor;
    const close = vi.fn(),
      finished = vi.fn();
    const leave = vi.fn(async () => ({
      projectId: ids.first,
      memberId: ids.actorMember,
      access: "disabled"
    }));
    const remove = vi.fn(async () => ({}));
    const deleteProject = vi.fn(async () => ({
      projectId: ids.first,
      lifecycle: "deleted"
    }));
    const read = vi.fn(async (_input: { projectId: string }) =>
      review(owns, _input.projectId)
    );
    const client = {
      current: () => ({
        connection: { backendId: backend },
        navigation: {
          personalOwner: { id: "personal-owner" },
          teamPrincipal: { id: principal },
          teams: [
            {
              id: ids.team,
              role: teamRole,
              people: [{ id: ids.actor, displayName: "You" }]
            }
          ]
        }
      }),
      reviewProjectLifecycle: read,
      leaveProject: leave,
      deleteSharedProject: deleteProject,
      removeProjectMember: remove
    } as unknown as CollaborationRendererClient;
    const render = async (
      selected = project(),
      ownerId = "personal-owner",
      profileKey = "profile"
    ) => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      if (!root) {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
      }
      await act(async () =>
        root!.render(
          <HqProjectLifecycle
            project={selected}
            onClose={close}
            onFinished={finished}
            client={client}
            ownerId={ownerId}
            profileKey={profileKey}
          />
        )
      );
    };
    const click = async (label: RegExp) => {
      const button = [...container!.querySelectorAll("button")].find((item) =>
        label.test(item.textContent ?? "")
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    return {
      read,
      leave,
      remove,
      deleteProject,
      close,
      finished,
      render,
      click,
      setPrincipal: (value: string) => {
        principal = value;
      },
      setBackend: (value: string) => {
        backend = value;
      }
    };
  };

  it("lets a nonowner leave their Project even when their Team role is owner", async () => {
    const f = fixture(false, "owner");
    await f.render();
    expect(container!.textContent).toContain("Leave");
    await f.click(/^Leave/);
    expect(f.leave).toHaveBeenCalledExactlyOnceWith({
      teamId: ids.team,
      projectId: ids.first,
      expectedProjectVersion: 7,
      expectedMemberVersion: 3
    });
    expect(f.deleteProject).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.finished).toHaveBeenCalledOnce();
  });

  it("offers explicit deletion to the Project owner without requiring Team ownership", async () => {
    const f = fixture(true, "member");
    await f.render();
    expect(container!.textContent).toContain("Delete");
    expect(container!.querySelector("select")).toBeNull();
    await f.click(/^Delete/);
    expect(f.deleteProject).toHaveBeenCalledExactlyOnceWith({
      teamId: ids.team,
      projectId: ids.first,
      expectedProjectVersion: 7
    });
    expect(f.leave).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("discards an older Project review after the selected Project changes", async () => {
    const f = fixture(false, "owner");
    let resolveFirst!: (value: WorkspaceProjectLifecycleReview) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    await f.render(project(ids.first));
    await f.render(project(ids.second));
    await act(async () => resolveFirst(review(true, ids.first)));
    await f.click(/^Leave/);
    expect(f.leave).toHaveBeenCalledExactlyOnceWith({
      teamId: ids.team,
      projectId: ids.second,
      expectedProjectVersion: 7,
      expectedMemberVersion: 3
    });
    expect(f.deleteProject).not.toHaveBeenCalled();
  });

  it("refuses a previously loaded action after the backend changes", async () => {
    const f = fixture(true, "member");
    await f.render();
    f.setBackend("another-backend");
    await f.click(/^Delete/);
    expect(f.deleteProject).not.toHaveBeenCalled();
    expect(f.leave).not.toHaveBeenCalled();
    expect(f.finished).not.toHaveBeenCalled();
  });

  it("discards an older owner review after the Personal profile changes", async () => {
    const f = fixture(false, "member");
    let resolveOld!: (value: WorkspaceProjectLifecycleReview) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    await f.render();
    await f.render(project(), "another-personal-owner", "another-profile");
    await act(async () => resolveOld(review(true)));
    await f.click(/^Leave/);
    expect(f.leave).toHaveBeenCalledOnce();
    expect(f.deleteProject).not.toHaveBeenCalled();
  });
  it("refuses a loaded owner action after the enrolled Team principal changes", async () => {
    const f = fixture(true, "member");
    await f.render();
    f.setPrincipal(ids.other);
    await f.click(/^Delete/);
    expect(f.deleteProject).not.toHaveBeenCalled();
    expect(f.finished).not.toHaveBeenCalled();
  });
});
