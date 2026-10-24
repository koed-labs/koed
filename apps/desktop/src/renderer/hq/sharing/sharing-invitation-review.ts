import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";

/** Reuse the existing reviewed invitation decision and local Project join. */
export async function reviewSharingInvitation(input: {
  id: string;
  backendId: string;
  decision: "accept" | "decline";
  listMyInvitations: CollaborationRendererClient["listMyInvitations"];
  decideInvitation: CollaborationRendererClient["decideInvitation"];
  sharedJoinProject: NonNullable<ProjectsDesktopApi["sharedJoinProject"]>;
  isCurrent: () => boolean;
  onJoined: (projectId: string) => Promise<void>;
  onRefresh: () => void;
}): Promise<void> {
  if (!input.isCurrent()) return;
  const invite = (await input.listMyInvitations()).find(
    (item) => item.id === input.id
  );
  if (!input.isCurrent()) return;
  if (!invite) throw new Error("This invitation is no longer available.");
  await input.decideInvitation(invite, input.decision);
  if (!input.isCurrent()) return;
  if (input.decision === "accept" && invite.project) {
    const joined = await input.sharedJoinProject(
      invite.project.id,
      input.backendId
    );
    if (!input.isCurrent()) return;
    await input.onJoined(joined.id);
    if (!input.isCurrent()) return;
  }
  input.onRefresh();
}
