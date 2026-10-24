import { sharingRemoveTargetSchema } from "@koed/shared/koed-text-action-contract";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { RemovalTarget } from "./removal-coordinator.js";
import { projectSharingRemovalTarget } from "./sharing-removal-target.js";
import type { SharingStore } from "./sharing-store.js";
import { sharingRows } from "./sharing-view-model.js";

type Target = ReturnType<typeof sharingRemoveTargetSchema.parse>;

/** Resolve every target before starting a sequential review; no partial batch begins from stale data. */
export async function sharingTextRemovalTargets(
  proposed: readonly Record<string, unknown>[],
  store: SharingStore,
  client: CollaborationRendererClient
): Promise<RemovalTarget[]> {
  await store.refresh();
  const overview = store.current().overview;
  if (!overview)
    throw new Error("Sharing is unavailable. Refresh before removal.");
  const targets = proposed.map((item) => sharingRemoveTargetSchema.parse(item));
  const out: RemovalTarget[] = [];
  for (const target of targets) {
    const backend = overview.backends.find(
      (item) => item.backendId === target.backendId
    );
    if (!backend || backend.status !== "available")
      throw new Error(
        `Couldn't reach ${target.backendId}. No removal was started.`
      );
    if (
      target.kind === "project_member" ||
      target.kind === "project_invitation"
    ) {
      const rows = sharingRows(overview).filter(
        (row) =>
          row.backendId === target.backendId &&
          row.projectId === target.projectId &&
          row.ownedByMe &&
          (target.kind === "project_member"
            ? !row.invitationId &&
              row.personId === target.personId &&
              row.canRemove
            : row.invitationId === target.invitationId && row.canCancel)
      );
      if (rows.length !== 1)
        throw new Error(
          "Project sharing changed. Review the current Project or leave if someone else owns it."
        );
      out.push(projectSharingRemovalTarget(rows[0]!, store, client));
      continue;
    }
    if (target.kind === "workspace_access") {
      const access = backend.data.workspaceAccess.find(
        (item) =>
          item.workspaceProjectId === null &&
          item.teamId === target.teamId &&
          item.teamWorkspaceId === target.workspaceId &&
          item.person.id === target.personId &&
          item.canRemove
      );
      if (!access)
        throw new Error("Workspace Access changed. Refresh sharing.");
      out.push({
        name: access.person.displayName,
        place: "the Workspace",
        reconcile: () => store.refresh(),
        async prepare() {
          await store.refresh();
          const fresh = store
            .current()
            .overview?.backends.find(
              (item) => item.backendId === target.backendId
            );
          const current =
            fresh?.status === "available"
              ? fresh.data.workspaceAccess.find(
                  (item) =>
                    item.workspaceProjectId === null &&
                    item.teamId === target.teamId &&
                    item.teamWorkspaceId === target.workspaceId &&
                    item.person.id === target.personId &&
                    item.canRemove
                )
              : null;
          if (!current)
            throw new Error("Workspace Access changed. Refresh sharing.");
          return client.prepareDisableWorkspaceAccess({
            teamId: current.teamId,
            workspaceId: current.teamWorkspaceId,
            userId: target.personId,
            expectedVersion: current.version,
            backendId: target.backendId
          });
        }
      });
      continue;
    }
    if (target.kind === "team_invitation") {
      const invite = backend.data.invitations.find(
        (item) =>
          item.workspaceProjectId === null &&
          item.teamId === target.teamId &&
          item.id === target.invitationId &&
          item.canCancel
      );
      if (!invite) throw new Error("Invitation changed. Refresh sharing.");
      out.push({
        name: invite.person.displayName,
        place: "the Team",
        pendingMessage: `Canceling invitation to ${invite.person.displayName}…`,
        doneMessage: `Invitation to ${invite.person.displayName} canceled`,
        reconcile: () => store.refresh(),
        async prepare() {
          await store.refresh();
          const fresh = store
            .current()
            .overview?.backends.find(
              (item) => item.backendId === target.backendId
            );
          const current =
            fresh?.status === "available"
              ? fresh.data.invitations.find(
                  (item) =>
                    item.workspaceProjectId === null &&
                    item.teamId === target.teamId &&
                    item.id === target.invitationId &&
                    item.canCancel
                )
              : null;
          if (!current) throw new Error("Invitation changed. Refresh sharing.");
          let cursor: string | null = null;
          for (;;) {
            const page = await client.listInvitations({
              teamId: target.teamId,
              cursor,
              backendId: target.backendId
            });
            const record = page.items.find(
              (item) => item.id === target.invitationId
            );
            if (record) {
              if (record.lifecycle !== "pending")
                throw new Error("Invitation is no longer pending.");
              return client.prepareRevokeInvitation({
                teamId: target.teamId,
                invitationId: target.invitationId,
                expectedVersion: record.version,
                backendId: target.backendId
              });
            }
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
          }
          throw new Error("Invitation changed. Refresh sharing.");
        }
      });
      continue;
    }
    out.push(await teamMemberTarget(target, client, store));
  }
  return out;
}

async function teamMemberTarget(
  target: Extract<Target, { kind: "team_member" }>,
  client: CollaborationRendererClient,
  store: SharingStore
): Promise<RemovalTarget> {
  const fresh = await client.readTeamForReview({
    backendId: target.backendId,
    teamId: target.teamId
  });
  const team = fresh.navigation.teams.find((item) => item.id === target.teamId);
  const person = team?.people.find((item) => item.id === target.personId);
  const allowed =
    team &&
    team.lifecycle === "active" &&
    (team.role === "owner" || team.role === "admin") &&
    person?.management?.status === "enabled" &&
    target.personId !== fresh.navigation.teamPrincipal?.id &&
    (person.management.role !== "owner" ||
      (team.role === "owner" &&
        team.people.filter(
          (item) =>
            item.management?.role === "owner" &&
            item.management.status === "enabled"
        ).length > 1));
  if (!allowed)
    throw new Error("Team member authority changed. Refresh sharing.");
  return {
    name: person.displayName,
    place: team.name,
    reconcile: () => store.refresh(),
    async prepare() {
      const current = await client.readTeamForReview({
        backendId: target.backendId,
        teamId: target.teamId
      });
      const managed = current.navigation.teams.find(
        (item) => item.id === target.teamId
      );
      const member = managed?.people.find(
        (item) => item.id === target.personId
      );
      if (
        !managed ||
        managed.lifecycle !== "active" ||
        (managed.role !== "owner" && managed.role !== "admin") ||
        member?.management?.status !== "enabled" ||
        target.personId === current.navigation.teamPrincipal?.id ||
        (member.management.role === "owner" &&
          (managed.role !== "owner" ||
            managed.people.filter(
              (item) =>
                item.management?.role === "owner" &&
                item.management.status === "enabled"
            ).length <= 1))
      )
        throw new Error("Team member authority changed. Refresh sharing.");
      return client.prepareDisableMember({
        teamId: target.teamId,
        userId: target.personId,
        expectedVersion: member.management.version,
        backendId: target.backendId
      });
    }
  };
}
