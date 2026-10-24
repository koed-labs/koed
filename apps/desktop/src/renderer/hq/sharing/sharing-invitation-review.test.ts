import { describe, expect, it, vi } from "vitest";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import { reviewSharingInvitation } from "./sharing-invitation-review.js";

type Invitation = Awaited<
  ReturnType<CollaborationRendererClient["listMyInvitations"]>
>[number];
const invite = {
  id: "invitation-a",
  project: { id: "workspace-project-a", name: "Investor deck" }
} as Invitation;

describe("HQ-723 invitation review", () => {
  it("S7 accepts through the reviewed decision and local Project join", async () => {
    const decideInvitation = vi.fn().mockResolvedValue(undefined);
    const sharedJoinProject = vi
      .fn()
      .mockResolvedValue({ id: "personal-project-a" });
    const onJoined = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn();
    await reviewSharingInvitation({
      id: invite.id,
      backendId: "team-a",
      decision: "accept",
      listMyInvitations: async () => [invite],
      decideInvitation:
        decideInvitation as CollaborationRendererClient["decideInvitation"],
      sharedJoinProject: sharedJoinProject as NonNullable<
        ProjectsDesktopApi["sharedJoinProject"]
      >,
      isCurrent: () => true,
      onJoined,
      onRefresh
    });
    expect(decideInvitation).toHaveBeenCalledWith(invite, "accept");
    expect(sharedJoinProject).toHaveBeenCalledWith(
      "workspace-project-a",
      "team-a"
    );
    expect(onJoined).toHaveBeenCalledWith("personal-project-a");
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("S7 declines without joining", async () => {
    const decideInvitation = vi.fn().mockResolvedValue(undefined);
    const sharedJoinProject = vi.fn();
    await reviewSharingInvitation({
      id: invite.id,
      backendId: "team-a",
      decision: "decline",
      listMyInvitations: async () => [invite],
      decideInvitation:
        decideInvitation as CollaborationRendererClient["decideInvitation"],
      sharedJoinProject: sharedJoinProject as NonNullable<
        ProjectsDesktopApi["sharedJoinProject"]
      >,
      isCurrent: () => true,
      onJoined: async () => undefined,
      onRefresh: () => undefined
    });
    expect(decideInvitation).toHaveBeenCalledWith(invite, "decline");
    expect(sharedJoinProject).not.toHaveBeenCalled();
  });
  it("N27 stops after an owner switch before deciding", async () => {
    let release!: (items: Invitation[]) => void;
    let current = true;
    const decideInvitation = vi.fn();
    const task = reviewSharingInvitation({
      id: invite.id,
      backendId: "team-a",
      decision: "accept",
      listMyInvitations: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      decideInvitation:
        decideInvitation as CollaborationRendererClient["decideInvitation"],
      sharedJoinProject: vi.fn() as NonNullable<
        ProjectsDesktopApi["sharedJoinProject"]
      >,
      isCurrent: () => current,
      onJoined: async () => undefined,
      onRefresh: () => undefined
    });
    current = false;
    release([invite]);
    await task;
    expect(decideInvitation).not.toHaveBeenCalled();
  });
});
