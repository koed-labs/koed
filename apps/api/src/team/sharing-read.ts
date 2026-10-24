import type pg from "pg";
import { teamSharingReadSchema, type TeamSharingRead } from "@koed/shared";

type Row = Record<string, unknown>;
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const name = (value: unknown): string =>
  typeof value === "string" ? value : "Team member";
const nullableId = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const access = (value: unknown): "edit" | "view" =>
  value === "write" ? "edit" : "view";
const origin = (
  row: Row,
  showOrigin: boolean
): TeamSharingRead["invitations"][number]["origin"] => ({
  actorKind:
    showOrigin &&
    (row.actor_kind === "person" || row.actor_kind === "agent_on_behalf")
      ? row.actor_kind
      : null,
  accessMode:
    showOrigin &&
    (row.access_mode === "ask_first" || row.access_mode === "full_access")
      ? row.access_mode
      : null,
  agentDisplayName:
    showOrigin && typeof row.inviter_agent_display_name === "string"
      ? row.inviter_agent_display_name
      : null
});

/** All queries start from current Team and Workspace visibility. No Personal source id is selected. */
export const readTeamSharing = async (
  pool: pg.Pool,
  actorUserId: string
): Promise<TeamSharingRead> => {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read");
    const memberships = (
      await client.query<Row>(
        `
    select m.team_id,m.role,
      (select count(*)::int from team_memberships om where om.team_id=m.team_id and om.role='owner' and om.status='enabled' and om.disabled_at is null) as owner_count
    from team_memberships m join teams t on t.id=m.team_id
    where m.user_id=$1 and m.status='enabled' and m.disabled_at is null and t.lifecycle='active' and t.entitlement_status in ('active','grace')
    for share of m,t`,
        [actorUserId]
      )
    ).rows;
    await client.query(
      `
    select link.workspace_project_id
    from workspace_project_members link
    join workspace_projects project on project.id=link.workspace_project_id and project.lifecycle='active'
    join team_memberships member on member.id=link.team_member_id and member.user_id=$1 and member.status='enabled' and member.disabled_at is null
    join team_workspace_access_grants access on access.team_workspace_id=project.workspace_id and access.user_id=$1 and access.disabled_at is null and access.access in ('read','write')
    join team_workspaces workspace on workspace.id=project.workspace_id and workspace.lifecycle='active'
    where link.disabled_at is null and link.access in ('read','write')
    for share of link,project,access,workspace`,
      [actorUserId]
    );
    const projects = (
      await client.query<Row>(
        `
    select p.id,p.team_id,p.workspace_id,p.name,p.owner_team_member_id,
      owner.user_id as owner_user_id,coalesce(owner_user.display_name,owner_user.email) as owner_name,
      t.name as team_name, actor.role as actor_role, actor.id as actor_member_id,
      actor_access.access as actor_workspace_access,
      actor_link.access as actor_project_access,
      (owner.user_id=$1) as owned_by_me,
      (select count(*)::int from team_memberships om where om.team_id=t.id and om.role='owner' and om.status='enabled' and om.disabled_at is null) as owner_count
    from workspace_projects p
    join teams t on t.id=p.team_id and t.lifecycle='active' and t.entitlement_status in ('active','grace')
    join team_workspaces w on w.id=p.workspace_id and w.lifecycle='active'
    join team_memberships actor on actor.team_id=p.team_id and actor.user_id=$1 and actor.status='enabled' and actor.disabled_at is null
    join team_memberships owner on owner.id=p.owner_team_member_id
    join users owner_user on owner_user.id=owner.user_id
    left join team_workspace_access_grants actor_access on actor_access.team_workspace_id=p.workspace_id and actor_access.user_id=$1 and actor_access.disabled_at is null
    left join workspace_project_members actor_link on actor_link.workspace_project_id=p.id and actor_link.team_member_id=actor.id and actor_link.disabled_at is null and actor_link.access<>'disabled'
    where p.lifecycle='active' and (actor.role in ('owner','admin') or (actor_link.team_member_id is not null and actor_access.access in ('read','write')))
    order by p.name,p.id`,
        [actorUserId]
      )
    ).rows;
    const visibleIds = projects.map((project) => project.id);
    // Keep these metadata counts within the same grant/consent/policy boundary
    // as Team recall; a retained grant alone is not evidence of visibility.
    const policyCompatible = (
      alias: "tp" | "wp",
      scope: "team" | "workspace"
    ) => {
      const table =
        scope === "team"
          ? "team_representation_policies"
          : "workspace_representation_policies";
      const scopeMatch =
        scope === "team"
          ? `successor.team_id=${alias}.team_id`
          : `successor.team_id=${alias}.team_id and successor.team_workspace_id=${alias}.team_workspace_id`;
      return `(${alias}.superseded_at is null or (${alias}.include_curated_memory=false and exists (
        select 1 from ${table} successor where successor.policy_id=${alias}.policy_id
          and successor.version=${alias}.version+1 and ${scopeMatch}
          and successor.maximum_fidelity=${alias}.maximum_fidelity
          and successor.include_curated_memory=true and successor.superseded_at is null)))`;
    };
    const countAuthorityJoins = `
      join source_owner_representation_consents consent on consent.id=g.consent_id
        and consent.logical_memory_id=g.logical_memory_id and consent.team_id=g.team_id
        and consent.team_workspace_id=g.team_workspace_id and consent.state='active'
        and consent.revoked_at is null and (consent.expires_at is null or consent.expires_at>now())
      join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
        and op.version=g.source_owner_policy_version and op.superseded_at is null
      join team_representation_policies tp on tp.policy_id=g.team_policy_id
        and tp.version=g.team_policy_version and tp.team_id=g.team_id
        and ${policyCompatible("tp", "team")}
      join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
        and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
        and wp.team_workspace_id=g.team_workspace_id and ${policyCompatible("wp", "workspace")}`;
    const countRepresentationBinding = `r.consent_id=g.consent_id
      and r.source_owner_policy_id=g.source_owner_policy_id
      and r.source_owner_policy_version=g.source_owner_policy_version
      and r.team_policy_id=g.team_policy_id and r.team_policy_version=g.team_policy_version
      and r.workspace_policy_id=g.workspace_policy_id and r.workspace_policy_version=g.workspace_policy_version`;
    const contentRows = visibleIds.length
      ? (
          await client.query<Row>(
            `
        select p.id,
          (select count(*)::int from workspace_project_sources s where s.workspace_project_id=p.id and s.deleted_at is null and s.kind<>'skill') as sources,
          (select count(*)::int from workspace_project_work_items w where w.workspace_project_id=p.id and w.deleted_at is null and w.kind='todo' and w.status<>'done') as to_dos,
          (select count(distinct g.logical_memory_id)::int from workspace_project_share_grant_bindings b
            join team_memory_share_grants g on g.id=b.share_grant_id and g.team_id=p.team_id and g.team_workspace_id=p.workspace_id
            join logical_memories lm on lm.id=g.logical_memory_id and lm.source_kind='captured_session'
            join team_memory_representations r on r.share_grant_id=g.id and ${countRepresentationBinding} and r.state in ('available','stale') and r.invalidated_at is null and r.frozen_snapshot=(g.frozen_at is not null) and r.representation in ('lcm_leaves','lcm_rollups') and (r.curated_expires_at is null or r.curated_expires_at>now())
            ${countAuthorityJoins}
            where b.workspace_project_id=p.id and b.workspace_project_source_id is null
              and g.revoked_at is null and g.purge_completed_at is null and g.lifecycle='active') as chat_summaries,
          (select count(distinct smi.id)::int from workspace_project_share_grant_bindings b
            join team_memory_share_grants g on g.id=b.share_grant_id and g.team_id=p.team_id and g.team_workspace_id=p.workspace_id
            join team_memory_representations r on r.share_grant_id=g.id and ${countRepresentationBinding} and r.state in ('available','stale') and r.invalidated_at is null and r.frozen_snapshot=(g.frozen_at is not null) and (r.curated_expires_at is null or r.curated_expires_at>now())
            ${countAuthorityJoins}
            join team_memory_semantic_items smi on smi.representation_id=r.id and smi.share_grant_id=g.id and smi.team_id=p.team_id and smi.team_workspace_id=p.workspace_id and smi.embedding_state='embedded' and smi.source_revision=r.source_revision
            left join team_memory_curated_item_eligibility eligibility on eligibility.semantic_item_id=smi.id
            where b.workspace_project_id=p.id and g.revoked_at is null and g.purge_completed_at is null and g.lifecycle='active'
              and eligibility.blocked_at is null
              and not exists (select 1 from team_memory_curated_withdrawal_fences fence where fence.share_grant_id=g.id and fence.pseudonymous_source_id=smi.pseudonymous_source_id)) as shared_memory_items
        from workspace_projects p where p.id=any($1::uuid[])`,
            [visibleIds]
          )
        ).rows
      : [];
    const contentByProject = new Map(
      contentRows.map((row) => [String(row.id), row])
    );
    const memberRows = visibleIds.length
      ? (
          await client.query<Row>(
            `
    select link.workspace_project_id,p.team_id,p.workspace_id,member.user_id,member.role,
      coalesce(u.display_name,u.email) as display_name,link.access,grant_row.access as workspace_access,link.created_at,grant_row.version,
      grant_row.actor_kind,grant_row.access_mode,grant_row.granted_by_user_id,
      (select accepted.inviter_agent_display_name from team_invites accepted
        where accepted.team_id=grant_row.team_id and accepted.default_team_workspace_id=grant_row.team_workspace_id
          and accepted.accepted_by_user_id=grant_row.user_id and accepted.resulting_access_grant_version=grant_row.version
          and accepted.lifecycle='accepted' order by accepted.accepted_at desc limit 1) as inviter_agent_display_name,
      p.owner_team_member_id,member.id as member_id
    from workspace_project_members link
    join workspace_projects p on p.id=link.workspace_project_id
    join team_memberships member on member.id=link.team_member_id and member.status='enabled' and member.disabled_at is null
    join users u on u.id=member.user_id
    join team_workspace_access_grants grant_row on grant_row.team_workspace_id=p.workspace_id and grant_row.user_id=member.user_id and grant_row.disabled_at is null and grant_row.access in ('read','write')
    where link.workspace_project_id=any($1::uuid[]) and link.disabled_at is null and link.access in ('read','write')
    order by u.display_name,u.id`,
            [visibleIds]
          )
        ).rows
      : [];
    const teamIds = [
      ...new Set(
        memberships
          .filter((m) => m.role === "owner" || m.role === "admin")
          .map((m) => String(m.team_id))
          .concat(
            projects.filter((p) => p.owned_by_me).map((p) => String(p.team_id))
          )
      )
    ];
    const invites = teamIds.length
      ? (
          await client.query<Row>(
            `
    select i.id,i.team_id,i.workspace_project_id,i.default_workspace_access,i.email,i.recipient_user_id,i.role,i.created_at,
      t.name as team_name, invite_workspace.name as workspace_name,
      i.actor_kind,i.access_mode,i.inviter_agent_display_name,i.created_by_user_id,
      manager.role as actor_role,project.owner_team_member_id,
      owner.user_id as project_owner_user_id
    from team_invites i
    join teams t on t.id=i.team_id and t.lifecycle='active'
    left join team_workspaces invite_workspace on invite_workspace.id=i.default_team_workspace_id
    join team_memberships manager on manager.team_id=i.team_id and manager.user_id=$1 and manager.status='enabled' and manager.disabled_at is null
    left join workspace_projects project on project.id=i.workspace_project_id and project.lifecycle='active'
    left join team_memberships owner on owner.id=project.owner_team_member_id
    where i.team_id=any($2::uuid[]) and i.lifecycle='pending' and i.expires_at>now()
      and (manager.role in ('owner','admin') or owner.user_id=$1)
    order by i.created_at desc,i.id`,
            [actorUserId, teamIds]
          )
        ).rows
      : [];
    const memberByProject = new Map<
      string,
      TeamSharingRead["projects"][number]["members"]
    >();
    for (const row of memberRows) {
      const project = projects.find(
        (entry) => entry.id === row.workspace_project_id
      )!;
      const mayRemove =
        Boolean(project.owned_by_me) &&
        project.actor_workspace_access === "write" &&
        project.actor_project_access === "write" &&
        row.member_id !== project.owner_team_member_id &&
        row.user_id !== actorUserId;
      const list = memberByProject.get(String(row.workspace_project_id)) ?? [];
      list.push({
        kind: "workspace_access",
        teamId: String(row.team_id),
        teamWorkspaceId: String(row.workspace_id),
        workspaceProjectId: String(row.workspace_project_id),
        person: {
          id: String(row.user_id),
          displayName: name(row.display_name)
        },
        how: "direct",
        access:
          row.access === "write" && row.workspace_access === "write"
            ? "edit"
            : "view",
        status: "joined",
        since: iso(row.created_at),
        version: Number(row.version),
        origin: origin(
          row,
          row.granted_by_user_id === actorUserId || project.owned_by_me === true
        ),
        canRemove: mayRemove
      });
      memberByProject.set(String(row.workspace_project_id), list);
    }
    const inviteItems: TeamSharingRead["invitations"] = invites.map((row) => ({
      kind: "invitation",
      id: String(row.id),
      teamId: String(row.team_id),
      workspaceProjectId: nullableId(row.workspace_project_id),
      teamName: String(row.team_name),
      workspaceName:
        typeof row.workspace_name === "string" ? row.workspace_name : null,
      person: {
        id: nullableId(row.recipient_user_id),
        displayName: String(row.email)
      },
      role: row.role as "owner" | "admin" | "member",
      access: access(row.default_workspace_access),
      status: "invited",
      since: iso(row.created_at),
      origin: origin(
        row,
        row.created_by_user_id === actorUserId ||
          row.project_owner_user_id === actorUserId
      ),
      canCancel:
        row.actor_role === "owner" ||
        (row.actor_role === "admin" && row.role !== "owner")
    }));
    const directRows = memberships.length
      ? (
          await client.query<Row>(
            `
    select grant_row.team_id,grant_row.team_workspace_id,grant_row.user_id,grant_row.access,grant_row.version,grant_row.created_at,
      t.name as team_name,w.name as workspace_name,
      grant_row.actor_kind,grant_row.access_mode,grant_row.granted_by_user_id,
      (select accepted.inviter_agent_display_name from team_invites accepted
        where accepted.team_id=grant_row.team_id and accepted.default_team_workspace_id=grant_row.team_workspace_id
          and accepted.accepted_by_user_id=grant_row.user_id and accepted.resulting_access_grant_version=grant_row.version
          and accepted.lifecycle='accepted' order by accepted.accepted_at desc limit 1) as inviter_agent_display_name,
      coalesce(u.display_name,u.email) as display_name,target.role as target_role,
      owner_project.id as workspace_project_id,project_owner.user_id as project_owner_user_id
    from team_workspace_access_grants grant_row
    join team_memberships target on target.team_id=grant_row.team_id and target.user_id=grant_row.user_id and target.status='enabled' and target.disabled_at is null
    join users u on u.id=target.user_id
    join team_workspaces w on w.id=grant_row.team_workspace_id and w.lifecycle='active'
    join teams t on t.id=grant_row.team_id and t.lifecycle='active'
    left join workspace_projects owner_project on owner_project.workspace_id=w.id and owner_project.lifecycle='active'
    left join team_memberships project_owner on project_owner.id=owner_project.owner_team_member_id
    where grant_row.team_id=any($1::uuid[]) and grant_row.disabled_at is null and grant_row.access in ('read','write')
      and (grant_row.user_id=$2 or exists(select 1 from team_memberships manager where manager.team_id=grant_row.team_id and manager.user_id=$2 and manager.role in ('owner','admin') and manager.status='enabled' and manager.disabled_at is null))
    order by u.display_name,u.id`,
            [memberships.map((m) => String(m.team_id)), actorUserId]
          )
        ).rows
      : [];
    const directAccess: TeamSharingRead["workspaceAccess"] = directRows.map(
      (row) => {
        const membership = memberships.find(
          (entry) => entry.team_id === row.team_id
        );
        const managerRole = membership?.role;
        const canRemove =
          row.user_id !== actorUserId &&
          (managerRole === "owner" || managerRole === "admin") &&
          (row.target_role !== "owner" ||
            (managerRole === "owner" && Number(membership?.owner_count) > 1));
        return {
          kind: "workspace_access",
          teamId: String(row.team_id),
          teamWorkspaceId: String(row.team_workspace_id),
          workspaceProjectId: nullableId(row.workspace_project_id),
          teamName: String(row.team_name),
          workspaceName: String(row.workspace_name),
          person: {
            id: String(row.user_id),
            displayName: name(row.display_name)
          },
          how: "direct",
          access: access(row.access),
          status: "joined",
          since: iso(row.created_at),
          version: Number(row.version),
          origin: origin(
            row,
            row.granted_by_user_id === actorUserId ||
              row.project_owner_user_id === actorUserId
          ),
          canRemove
        };
      }
    );
    const projectItems: TeamSharingRead["projects"] = projects.map((row) => {
      const content = contentByProject.get(String(row.id));
      const members = memberByProject.get(String(row.id)) ?? [];
      const invitations = inviteItems.filter(
        (invite) => invite.workspaceProjectId === row.id
      );
      return {
        id: String(row.id),
        teamId: String(row.team_id),
        teamWorkspaceId: String(row.workspace_id),
        name: String(row.name),
        owner: {
          id: String(row.owner_user_id),
          displayName: name(row.owner_name)
        },
        group: { id: String(row.team_id), name: String(row.team_name) },
        ownedByMe: Boolean(row.owned_by_me),
        joinedByMe:
          (row.actor_project_access === "read" ||
            row.actor_project_access === "write") &&
          (row.actor_workspace_access === "read" ||
            row.actor_workspace_access === "write"),
        members,
        invitations,
        counts: { members: members.length, invitations: invitations.length },
        contentCounts: {
          sources: Number(content?.sources ?? 0),
          toDos: Number(content?.to_dos ?? 0),
          chatSummaries: Number(content?.chat_summaries ?? 0),
          sharedMemoryItems: Number(content?.shared_memory_items ?? 0)
        }
      };
    });
    const result = teamSharingReadSchema.parse({
      projects: projectItems,
      invitations: inviteItems,
      workspaceAccess: directAccess
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
