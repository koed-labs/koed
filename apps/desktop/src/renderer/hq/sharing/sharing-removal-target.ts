import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import { SharingStore } from "./sharing-store.js";
import { sharingRows, type SharingRow } from "./sharing-view-model.js";
import type { RemovalTarget } from "./removal-coordinator.js";

/** Re-read before every review so a previous removal's Project version is never reused. */
export function projectSharingRemovalTarget(
  row: SharingRow,
  store: SharingStore,
  client: CollaborationRendererClient
): RemovalTarget {
  const currentRow = async () => {
    await store.refresh();
    const overview = store.current().overview;
    const fresh =
      overview && sharingRows(overview).find((item) => item.key === row.key);
    if (!fresh || fresh.backendId !== row.backendId)
      throw new Error("Sharing changed. Refresh and try again.");
    return fresh;
  };
  return {
    name: row.personName,
    place: row.projectName,
    pendingMessage: row.invitationId
      ? `Canceling invitation to ${row.personName}…`
      : undefined,
    doneMessage: row.invitationId
      ? `Invitation to ${row.personName} canceled`
      : undefined,
    reconcile: () => store.refresh(),
    async prepare() {
      const fresh = await currentRow();
      if (fresh.invitationId) {
        if (!fresh.canCancel)
          throw new Error("You can no longer cancel this invitation.");
        let cursor: string | null = null;
        for (;;) {
          const page = await client.listInvitations({
            teamId: fresh.teamId,
            cursor,
            backendId: fresh.backendId
          });
          const invite = page.items.find(
            (item) => item.id === fresh.invitationId
          );
          if (invite) {
            if (invite.lifecycle !== "pending")
              throw new Error("Invitation is no longer pending.");
            return client.prepareRevokeInvitation({
              teamId: fresh.teamId,
              invitationId: invite.id,
              expectedVersion: invite.version,
              backendId: fresh.backendId
            });
          }
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        throw new Error("Invitation changed. Refresh and try again.");
      }
      if (!fresh.canRemove || !fresh.personId || !fresh.memberVersion)
        throw new Error("You can no longer remove this person.");
      const review = await client.reviewProjectLifecycle({
        projectId: fresh.projectId,
        targetUserId: fresh.personId,
        backendId: fresh.backendId
      });
      if (
        review.project.id !== fresh.projectId ||
        review.project.teamId !== fresh.teamId ||
        review.targetUserId !== fresh.personId ||
        review.targetMemberVersion !== fresh.memberVersion ||
        review.actorTeamMemberId !== review.project.ownerTeamMemberId
      )
        throw new Error("Project review changed. Refresh and try again.");
      return client.prepareRemoveProjectMember({
        teamId: fresh.teamId,
        projectId: fresh.projectId,
        targetUserId: fresh.personId,
        expectedProjectVersion: review.project.version,
        expectedMemberVersion: review.targetMemberVersion,
        backendId: fresh.backendId
      });
    }
  };
}
