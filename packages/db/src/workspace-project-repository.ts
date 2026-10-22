import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  COLLABORATION_CONTRACT_VERSION,
  type WorkspaceProjectDispatchProgress
} from "@koed/shared";

export class WorkspaceProjectUnavailableError extends Error {}
export class WorkspaceProjectConflictError extends Error {
  constructor(public readonly current: unknown) {
    super("Workspace Project version changed");
  }
}

type Row = Record<string, unknown>;
type Client = pg.Pool | pg.PoolClient;
const textValue = (value: unknown): string => {
  if (typeof value !== "string")
    throw new Error("Expected text database value");
  return value;
};
const nullableText = (value: unknown): string | null =>
  value == null ? null : textValue(value);
const textEffectHash = (nonce: string | undefined): string | null => {
  if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
  const bytes = Buffer.from(nonce, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== nonce) return null;
  return createHash("sha256").update(bytes).digest("hex");
};
const dueDate = (value: unknown): string | null =>
  value == null
    ? null
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : textValue(value);

const one = async (client: Client, sql: string, values: unknown[] = []) =>
  (await client.query<Row>(sql, values)).rows[0] ?? null;

const transaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

export const notifyProjectChange = async (
  client: pg.PoolClient,
  input: {
    teamId: string;
    workspaceId: string;
    actorUserId: string;
    resourceType: string;
    resourceId: string;
  }
) => {
  const event = await one(
    client,
    `
    insert into collaboration_outbox
      (protocol_version,family,scope,team_id,team_workspace_id,
       resource_type,resource_id,actor_principal_id,mutation_id,replay_until)
    values ($1,'workspace_lifecycle_access','team',$2,$3,$4,$5,$6,$7,now()+interval '30 days')
    returning cursor,family,scope,team_id`,
    [
      COLLABORATION_CONTRACT_VERSION,
      input.teamId,
      input.workspaceId,
      input.resourceType,
      input.resourceId,
      input.actorUserId,
      randomUUID()
    ]
  );
  if (!event) throw new Error("Workspace Project realtime event unavailable");
  await client.query("select pg_notify('koed_collaboration_realtime',$1)", [
    JSON.stringify({
      scope: "team",
      personalOwnerUserId: null,
      teamId: input.teamId,
      cursor: event.cursor,
      family: event.family
    })
  ]);
};

const appendActivity = async (
  client: pg.PoolClient,
  projectId: string,
  actorTeamMemberId: string,
  kind: string,
  ref: string
) => {
  await client.query(
    `insert into workspace_project_activity
    (workspace_project_id,sequence,actor_team_member_id,kind,ref)
    values ($1,(select coalesce(max(sequence),0)+1 from workspace_project_activity
      where workspace_project_id=$1),$2,$3,$4)
    on conflict (workspace_project_id,kind,ref) do nothing`,
    [projectId, actorTeamMemberId, kind, ref]
  );
};

const encodeActivityCursor = (
  projectId: string,
  memberId: string,
  sequence: string
) =>
  Buffer.from(JSON.stringify({ v: 1, projectId, memberId, sequence })).toString(
    "base64url"
  );

const decodeActivityCursor = (
  cursor: string,
  projectId: string,
  memberId: string
): string => {
  if (
    !/^[A-Za-z0-9_-]{1,500}$/u.test(cursor) ||
    Buffer.from(cursor, "base64url").toString("base64url") !== cursor
  )
    throw new WorkspaceProjectUnavailableError(
      "Project activity cursor is invalid"
    );
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new WorkspaceProjectUnavailableError(
      "Project activity cursor is invalid"
    );
  }
  const row = value as Record<string, unknown>;
  if (
    !row ||
    Object.keys(row).sort().join(",") !== "memberId,projectId,sequence,v" ||
    row.v !== 1 ||
    row.projectId !== projectId ||
    row.memberId !== memberId ||
    typeof row.sequence !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(row.sequence) ||
    BigInt(row.sequence) > 9223372036854775807n
  )
    throw new WorkspaceProjectUnavailableError(
      "Project activity cursor is invalid"
    );
  return row.sequence;
};

const currentMember = async (
  client: Client,
  userId: string,
  projectId: string,
  lock = false
) => {
  if (lock) {
    // Team lifecycle operations lock Team, membership, then Project. Match that
    // order so revocation and a shared write cannot pass one another.
    const identity = await one(
      client,
      `select team_id,workspace_id from workspace_projects where id=$1`,
      [projectId]
    );
    if (!identity)
      throw new WorkspaceProjectUnavailableError(
        "Workspace Project unavailable"
      );
    await one(client, `select id from teams where id=$1 for update`, [
      identity.team_id
    ]);
    const member = await one(
      client,
      `select id from team_memberships
      where team_id=$1 and user_id=$2 for update`,
      [identity.team_id, userId]
    );
    if (!member)
      throw new WorkspaceProjectUnavailableError(
        "Workspace Project access unavailable"
      );
    await one(client, `select id from team_workspaces where id=$1 for update`, [
      identity.workspace_id
    ]);
    await one(
      client,
      `select team_workspace_id from team_workspace_access_grants
      where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update`,
      [identity.workspace_id, identity.team_id, userId]
    );
    await one(
      client,
      `select id from workspace_projects where id=$1 for update`,
      [projectId]
    );
    await one(
      client,
      `select team_member_id from workspace_project_members
      where workspace_project_id=$1 and team_member_id=$2 for update`,
      [projectId, member.id]
    );
  }
  const row = await one(
    client,
    `
    select project.*, member.id as actor_team_member_id,
           association.access as project_access,
           association.version as project_member_version,
           association.created_at as project_member_created_at,
           workspace_access.access as workspace_access
      from workspace_projects project
      join team_memberships member
        on member.team_id=project.team_id and member.user_id=$2
       and member.status='enabled' and member.disabled_at is null
      join workspace_project_members association
        on association.workspace_project_id=project.id
       and association.team_member_id=member.id
       and association.disabled_at is null
      join team_workspace_access_grants workspace_access
        on workspace_access.team_workspace_id=project.workspace_id
       and workspace_access.user_id=$2
       and workspace_access.team_id=project.team_id
       and workspace_access.disabled_at is null
      join teams team on team.id=project.team_id and team.lifecycle='active'
      join team_workspaces workspace
        on workspace.id=project.workspace_id and workspace.lifecycle='active'
     where project.id=$1 and project.lifecycle='active'
    `,
    [projectId, userId]
  );
  if (
    !row ||
    row.project_access === "disabled" ||
    row.workspace_access === "disabled"
  )
    throw new WorkspaceProjectUnavailableError(
      "Workspace Project access unavailable"
    );
  return row;
};

const requireWrite = (row: Row) => {
  if (row.project_access !== "write" || row.workspace_access !== "write")
    throw new WorkspaceProjectUnavailableError(
      "Workspace Project write access unavailable"
    );
};

const projectRecord = (row: Row) => ({
  id: String(row.id),
  teamId: String(row.team_id),
  workspaceId: String(row.workspace_id),
  ownerTeamMemberId: String(row.owner_team_member_id),
  name: String(row.name),
  key: String(row.key),
  lifecycle: String(row.lifecycle),
  version: Number(row.version),
  copiedAt: row.copied_at ?? null
});
const workItemRecord = (row: Row) => ({
  id: String(row.id),
  sourceOwnerTeamMemberId: String(row.source_owner_team_member_id),
  sourceWorkItemId: nullableText(row.source_work_item_id),
  kind: String(row.kind),
  key: nullableText(row.key),
  title: String(row.title),
  goal: String(row.goal),
  status: String(row.status),
  dueOn: dueDate(row.due_on),
  doneAt:
    row.done_at == null ? null : new Date(row.done_at as Date).toISOString(),
  assigneeDisplayName: nullableText(row.assignee_display_name),
  stepLabel: nullableText(row.step_label),
  dispatchKey: nullableText(row.dispatch_key),
  prUrl: nullableText(row.pr_url),
  prState: nullableText(row.pr_state),
  createdAt: new Date(row.created_at as Date).toISOString(),
  updatedAt: new Date(row.updated_at as Date).toISOString(),
  version: Number(row.version)
});
const sourceRecord = (row: Row) => ({
  id: String(row.id),
  uploaderTeamMemberId: String(row.uploader_team_member_id),
  sourceProjectSourceId: String(row.source_project_source_id),
  name: String(row.name),
  kind: String(row.kind),
  status: String(row.status),
  personalNoteId: nullableText(row.personal_note_id),
  personalNoteRevisionId: nullableText(row.personal_note_revision_id),
  version: Number(row.version)
});
export const workspaceProjectCopyManifestHash = (input: {
  personalProjectVersion: number;
  workItems: Array<{ id: string }>;
  sources: Array<{ id: string }>;
  decks?: Array<{ id: string; cards: Array<{ id: string }> }>;
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        personalProjectVersion: input.personalProjectVersion,
        workItems: [...input.workItems].sort((a, b) =>
          a.id.localeCompare(b.id)
        ),
        sources: [...input.sources].sort((a, b) => a.id.localeCompare(b.id)),
        ...(input.decks?.length
          ? {
              decks: [...input.decks]
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((d) => ({
                  ...d,
                  cards: [...d.cards].sort((a, b) => a.id.localeCompare(b.id))
                }))
            }
          : {})
      })
    )
    .digest("hex");

export const createWorkspaceProjectRepository = (
  pool: pg.Pool,
  options: {
    freezeGrantForParent?: (
      client: pg.PoolClient,
      input: {
        action:
          | "workspace_project.leave"
          | "workspace_project.member_remove"
          | "workspace_project.delete"
          | "project_source.team_metadata.delete";
        actorUserId: string;
        teamId: string;
        workspaceId: string;
        projectId: string;
        targetUserId: string;
        targetVersion: number;
        sourceId?: string;
        sourceVersion?: number;
        shareGrantId: string;
        expectedGrantVersion: number;
      }
    ) => Promise<void>;
  } = {}
) => {
  const freezeMemberGrants = async (
    client: pg.PoolClient,
    project: Row,
    action:
      | "workspace_project.leave"
      | "workspace_project.member_remove"
      | "workspace_project.delete",
    actorUserId: string,
    targetUserId: string,
    targetVersion: number
  ) => {
    const grants = await client.query<{ id: string; grant_version: number }>(
      `
      select grant_row.id,grant_row.grant_version
        from team_memory_share_grants grant_row
        join workspace_project_share_grant_bindings binding
          on binding.share_grant_id=grant_row.id
       where grant_row.team_id=$1 and grant_row.team_workspace_id=$2
         and grant_row.owner_user_id=$3
         and binding.workspace_project_id=$4
         and grant_row.lifecycle='active' and grant_row.revoked_at is null
         and grant_row.frozen_at is null
       order by grant_row.id for update of grant_row`,
      [project.team_id, project.workspace_id, targetUserId, project.id]
    );
    if (grants.rows.length && !options.freezeGrantForParent)
      throw new WorkspaceProjectUnavailableError(
        "Verified Project grant freeze is unavailable"
      );
    for (const grant of grants.rows) {
      await options.freezeGrantForParent!(client, {
        action,
        actorUserId,
        teamId: String(project.team_id),
        workspaceId: String(project.workspace_id),
        projectId: String(project.id),
        targetUserId,
        targetVersion,
        shareGrantId: grant.id,
        expectedGrantVersion: grant.grant_version
      });
    }
  };
  return {
    async shareTarget(
      actorUserId: string,
      teamId: string,
      workspaceId: string,
      shareAttemptKey?: string
    ) {
      return transaction(pool, async (client) => {
        await one(client, `select id from teams where id=$1 for update`, [
          teamId
        ]);
        await one(
          client,
          `select id from team_memberships where team_id=$1 and user_id=$2 for update`,
          [teamId, actorUserId]
        );
        await one(
          client,
          `select id from team_workspaces where id=$1 and team_id=$2 for update`,
          [workspaceId, teamId]
        );
        await one(
          client,
          `select team_workspace_id from team_workspace_access_grants where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update`,
          [workspaceId, teamId, actorUserId]
        );
        const row = await one(
          client,
          `select membership.id as team_member_id
           from team_memberships membership
           join teams team on team.id=membership.team_id
            and team.lifecycle='active'
           join team_workspaces workspace on workspace.team_id=team.id
            and workspace.id=$2 and workspace.lifecycle='active'
           join team_workspace_access_grants access
             on access.team_workspace_id=workspace.id
            and access.team_id=team.id and access.user_id=membership.user_id
            and access.access='write' and access.disabled_at is null
          where membership.team_id=$1 and membership.user_id=$3
            and membership.status='enabled' and membership.disabled_at is null`,
          [teamId, workspaceId, actorUserId]
        );
        if (!row)
          throw new WorkspaceProjectUnavailableError(
            "Current Team sharing target is unavailable"
          );
        const occupying = await one(
          client,
          `select project.owner_team_member_id,project.share_attempt_key
           from workspace_projects project
          where project.workspace_id=$1 and project.team_id=$2`,
          [workspaceId, teamId]
        );
        const canceled = shareAttemptKey
          ? await one(
              client,
              `select id from workspace_project_share_cancellations
          where team_id=$1 and owner_team_member_id=$2
            and share_attempt_key=$3`,
              [teamId, row.team_member_id, shareAttemptKey]
            )
          : null;
        return {
          teamId,
          workspaceId,
          ownerUserId: actorUserId,
          canStart:
            !canceled &&
            (!occupying ||
              (occupying.owner_team_member_id === row.team_member_id &&
                occupying.share_attempt_key === shareAttemptKey))
        };
      });
    },
    async cancelShareAttempt(
      actorUserId: string,
      input: {
        teamId: string;
        workspaceId: string;
        shareAttemptKey: string;
      }
    ) {
      return transaction(pool, async (client) => {
        await one(client, `select id from teams where id=$1 for update`, [
          input.teamId
        ]);
        await one(
          client,
          `select id from team_memberships where team_id=$1 and user_id=$2 for update`,
          [input.teamId, actorUserId]
        );
        await one(
          client,
          `select id from team_workspaces where id=$1 and team_id=$2 for update`,
          [input.workspaceId, input.teamId]
        );
        await one(
          client,
          `select team_workspace_id from team_workspace_access_grants where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update`,
          [input.workspaceId, input.teamId, actorUserId]
        );
        const member = await one(
          client,
          `select membership.id
          from team_memberships membership
          join teams team on team.id=membership.team_id and team.lifecycle='active'
          join team_workspaces workspace on workspace.id=$2 and workspace.team_id=team.id and workspace.lifecycle='active'
          join team_workspace_access_grants access on access.team_workspace_id=workspace.id
            and access.team_id=team.id and access.user_id=membership.user_id
            and access.access='write' and access.disabled_at is null
          where membership.team_id=$1 and membership.user_id=$3
            and membership.status='enabled' and membership.disabled_at is null`,
          [input.teamId, input.workspaceId, actorUserId]
        );
        if (!member)
          throw new WorkspaceProjectUnavailableError(
            "Current Team sharing target is unavailable"
          );
        const prior = await one(
          client,
          `select id,workspace_id from workspace_project_share_cancellations
          where team_id=$1 and owner_team_member_id=$2 and share_attempt_key=$3`,
          [input.teamId, member.id, input.shareAttemptKey]
        );
        if (prior && prior.workspace_id !== input.workspaceId)
          throw new WorkspaceProjectConflictError(prior);
        const existing = await one(
          client,
          `select id,workspace_id,lifecycle,share_attempt_key,
                  copy_manifest_hash,copied_at
             from workspace_projects
            where team_id=$1 and owner_team_member_id=$2
              and share_attempt_key=$3 for update`,
          [input.teamId, member.id, input.shareAttemptKey]
        );
        if (existing && existing.workspace_id !== input.workspaceId)
          throw new WorkspaceProjectConflictError(existing);
        if (existing && !prior) {
          if (existing.lifecycle !== "deleted")
            throw new WorkspaceProjectConflictError(existing);
          const tombstone = await one(
            client,
            `select
               not exists(select 1 from workspace_project_members link
                 where link.workspace_project_id=$1 and link.disabled_at is null)
                 as all_member_links_disabled,
               not exists(select 1 from team_memory_share_grants grant_row
                 join workspace_project_share_grant_bindings binding
                   on binding.share_grant_id=grant_row.id
                 where binding.workspace_project_id=$1
                   and grant_row.lifecycle='active'
                   and grant_row.revoked_at is null
                   and grant_row.frozen_at is null) as grants_frozen,
               not exists(select 1 from collaboration_threads thread
                 where thread.workspace_project_id=$1 and thread.scope='team'
                   and thread.kind='project_thread'
                   and thread.lifecycle='active') as thread_archived`,
            [existing.id]
          );
          if (
            !tombstone?.all_member_links_disabled ||
            !tombstone.grants_frozen ||
            !tombstone.thread_archived ||
            Boolean(existing.copied_at) !==
              (typeof existing.copy_manifest_hash === "string")
          )
            throw new WorkspaceProjectUnavailableError(
              "Team Project tombstone is incomplete"
            );
        }
        await client.query(
          `insert into workspace_project_share_cancellations
          (id,team_id,workspace_id,owner_team_member_id,share_attempt_key)
          values ($1,$2,$3,$4,$5)
          on conflict (team_id,owner_team_member_id,share_attempt_key)
          do nothing`,
          [
            randomUUID(),
            input.teamId,
            input.workspaceId,
            member.id,
            input.shareAttemptKey
          ]
        );
        const receipt = await one(
          client,
          `select id from workspace_project_share_cancellations
          where team_id=$1 and workspace_id=$2 and owner_team_member_id=$3
            and share_attempt_key=$4`,
          [input.teamId, input.workspaceId, member.id, input.shareAttemptKey]
        );
        return {
          canceled: true as const,
          receiptId: String(receipt!.id),
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          ownerUserId: actorUserId,
          shareAttemptKey: input.shareAttemptKey,
          ...(existing
            ? {
                terminalProject: {
                  projectId: String(existing.id),
                  copyManifestHash: nullableText(existing.copy_manifest_hash),
                  copiedAt: existing.copied_at
                }
              }
            : {})
        };
      });
    },
    async members(actorUserId: string, projectId: string) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        const rows = await client.query<{
          team_member_id: string;
          user_id: string;
          display_name: string | null;
          access: "read" | "write";
        }>(
          `select membership.id as team_member_id,membership.user_id,
                  coalesce(account.display_name,account.email) as display_name,
                  association.access
             from workspace_project_members association
             join team_memberships membership
               on membership.id=association.team_member_id
              and membership.team_id=$2
              and membership.status='enabled' and membership.disabled_at is null
             join users account on account.id=membership.user_id
             join team_workspace_access_grants workspace_access
               on workspace_access.team_workspace_id=$3
              and workspace_access.user_id=membership.user_id
              and workspace_access.team_id=$2
              and workspace_access.disabled_at is null
              and workspace_access.access<>'disabled'
            where association.workspace_project_id=$1
              and association.disabled_at is null
              and association.access<>'disabled'
            order by account.display_name nulls last,account.email,membership.id`,
          [projectId, project.team_id, project.workspace_id]
        );
        return {
          projectId,
          version: Number(project.version),
          people: rows.rows.map((row) => ({
            teamMemberId: row.team_member_id,
            userId: row.user_id,
            displayName: row.display_name ?? "Team member",
            access: row.access
          }))
        };
      });
    },
    async create(
      actorUserId: string,
      input: {
        teamId: string;
        workspaceId: string;
        name: string;
        key: string;
        shareAttemptKey: string;
      }
    ) {
      return transaction(pool, async (client) => {
        // Keep the same authority lock order as currentMember and Team leave.
        await one(client, `select id from teams where id=$1 for update`, [
          input.teamId
        ]);
        const memberLock = await one(
          client,
          `select id from team_memberships
        where team_id=$1 and user_id=$2 for update`,
          [input.teamId, actorUserId]
        );
        await one(
          client,
          `select id from team_workspaces where id=$1 for update`,
          [input.workspaceId]
        );
        await one(
          client,
          `select team_workspace_id from team_workspace_access_grants
        where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update`,
          [input.workspaceId, input.teamId, actorUserId]
        );
        const member =
          memberLock &&
          (await one(
            client,
            `
        select membership.id
          from team_memberships membership
          join teams team on team.id=membership.team_id and team.lifecycle='active'
          join team_workspaces workspace
            on workspace.team_id=team.id and workspace.id=$2
           and workspace.lifecycle='active'
          join team_workspace_access_grants access
            on access.team_workspace_id=workspace.id
           and access.team_id=team.id and access.user_id=membership.user_id
           and access.access='write' and access.disabled_at is null
         where membership.team_id=$1 and membership.user_id=$3
           and membership.status='enabled' and membership.disabled_at is null`,
            [input.teamId, input.workspaceId, actorUserId]
          ));
        if (!member)
          throw new WorkspaceProjectUnavailableError(
            "Workspace Project creation unavailable"
          );
        const canceled = await one(
          client,
          `select id from workspace_project_share_cancellations
          where team_id=$1 and owner_team_member_id=$2
            and share_attempt_key=$3`,
          [input.teamId, member.id, input.shareAttemptKey]
        );
        if (canceled)
          throw new WorkspaceProjectUnavailableError(
            "First-share attempt was canceled"
          );
        const existing = await one(
          client,
          `
        select * from workspace_projects
         where team_id=$1 and owner_team_member_id=$2 and share_attempt_key=$3
         for update`,
          [input.teamId, member.id, input.shareAttemptKey]
        );
        if (existing) {
          if (
            existing.workspace_id !== input.workspaceId ||
            existing.name !== input.name ||
            existing.key !== input.key
          )
            throw new WorkspaceProjectConflictError(projectRecord(existing));
          return projectRecord(existing);
        }
        const project = await one(
          client,
          `
        insert into workspace_projects
          (id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key)
        values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [
            randomUUID(),
            input.teamId,
            input.workspaceId,
            member.id,
            input.name,
            input.key,
            input.shareAttemptKey
          ]
        );
        if (!project) throw new Error("Workspace Project insert failed");
        await client.query(
          `
        insert into workspace_project_members (workspace_project_id,team_member_id,access)
        values ($1,$2,'write')`,
          [project.id, member.id]
        );
        await notifyProjectChange(client, {
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          actorUserId,
          resourceType: "workspace_project",
          resourceId: String(project.id)
        });
        return projectRecord(project);
      });
    },

    async get(actorUserId: string, projectId: string) {
      const row = await currentMember(pool, actorUserId, projectId);
      return projectRecord(row);
    },

    async getOwnerLinkProof(actorUserId: string, projectId: string) {
      const row = await currentMember(pool, actorUserId, projectId);
      if (
        row.owner_team_member_id !== row.actor_team_member_id ||
        !row.copied_at ||
        typeof row.copy_manifest_hash !== "string"
      )
        throw new WorkspaceProjectUnavailableError(
          "Workspace Project copy is unconfirmed"
        );
      return {
        projectId: String(row.id),
        workspaceId: String(row.workspace_id),
        teamId: String(row.team_id),
        ownerTeamMemberId: String(row.owner_team_member_id),
        ownerUserId: actorUserId,
        projectVersion: Number(row.version),
        copyManifestHash: String(row.copy_manifest_hash)
      };
    },
    async getMemberLinkProof(actorUserId: string, projectId: string) {
      const row = await currentMember(pool, actorUserId, projectId);
      if (
        row.owner_team_member_id === row.actor_team_member_id ||
        !row.copied_at ||
        typeof row.copy_manifest_hash !== "string"
      )
        throw new WorkspaceProjectUnavailableError(
          "Joined Workspace Project copy is unavailable"
        );
      return {
        projectId: String(row.id),
        workspaceId: String(row.workspace_id),
        teamId: String(row.team_id),
        memberTeamMemberId: String(row.actor_team_member_id),
        memberUserId: actorUserId,
        projectVersion: Number(row.version),
        memberVersion: Number(row.project_member_version)
      };
    },
    async getOwnerTombstoneProof(actorUserId: string, projectId: string) {
      const row = await one(
        pool,
        `
      select project.id,project.team_id,project.workspace_id,project.version,
             project.deleted_at,project.share_attempt_key,
             project.copy_manifest_hash,project.copied_at,
             owner_member.user_id as owner_user_id,
             not exists(select 1 from workspace_project_members link
               where link.workspace_project_id=project.id and link.disabled_at is null)
               as all_member_links_disabled,
             not exists(select 1 from team_memory_share_grants grant_row
               join workspace_project_share_grant_bindings binding
                 on binding.share_grant_id=grant_row.id
               where grant_row.team_id=project.team_id
                 and grant_row.team_workspace_id=project.workspace_id
                 and grant_row.lifecycle='active' and grant_row.revoked_at is null
                 and grant_row.frozen_at is null
                 and binding.workspace_project_id=project.id) as grants_frozen,
             not exists(select 1 from collaboration_threads thread
               where thread.workspace_project_id=project.id
                 and thread.scope='team' and thread.kind='project_thread'
                 and thread.lifecycle='active') as thread_archived
        from workspace_projects project
        join team_memberships owner_member
          on owner_member.id=project.owner_team_member_id
       where project.id=$1 and project.lifecycle='deleted'
         and owner_member.user_id=$2`,
        [projectId, actorUserId]
      );
      if (
        !row ||
        !row.all_member_links_disabled ||
        !row.grants_frozen ||
        !row.thread_archived
      )
        throw new WorkspaceProjectUnavailableError(
          "Team Project tombstone is incomplete"
        );
      return {
        projectId: String(row.id),
        teamId: String(row.team_id),
        workspaceId: String(row.workspace_id),
        ownerUserId: actorUserId,
        version: Number(row.version),
        deletedAt: row.deleted_at,
        shareAttemptKey: nullableText(row.share_attempt_key),
        copyManifestHash: nullableText(row.copy_manifest_hash),
        copiedAt: row.copied_at,
        allMemberLinksDisabled: true as const,
        grantsFrozen: true as const,
        threadArchived: true as const
      };
    },

    async lifecycle(actorUserId: string, projectId: string) {
      const row = await one(
        pool,
        `
      select project.id,project.version,project.lifecycle,
             association.access as project_access,
             association.version as member_version,
             membership.status as membership_status,
             workspace_access.access as workspace_access,
             membership.disabled_at as membership_disabled_at,
             association.disabled_at as association_disabled_at,
             team.lifecycle as team_lifecycle,
             workspace.lifecycle as workspace_lifecycle
        from workspace_projects project
        join teams team on team.id=project.team_id
        join team_workspaces workspace on workspace.id=project.workspace_id
        join team_memberships membership
          on membership.team_id=project.team_id and membership.user_id=$2
        join workspace_project_members association
          on association.workspace_project_id=project.id
         and association.team_member_id=membership.id
        left join team_workspace_access_grants workspace_access
          on workspace_access.team_workspace_id=project.workspace_id
         and workspace_access.user_id=$2
         and workspace_access.disabled_at is null
       where project.id=$1`,
        [projectId, actorUserId]
      );
      if (!row)
        throw new WorkspaceProjectUnavailableError(
          "Workspace Project link unavailable"
        );
      return {
        id: String(row.id),
        version: Number(row.version),
        memberVersion: Number(row.member_version),
        canWrite:
          row.project_access === "write" &&
          row.workspace_access === "write" &&
          row.lifecycle === "active" &&
          row.team_lifecycle === "active" &&
          row.workspace_lifecycle === "active" &&
          row.membership_status === "enabled" &&
          row.membership_disabled_at === null &&
          row.association_disabled_at === null,
        active:
          row.lifecycle === "active" &&
          row.team_lifecycle === "active" &&
          row.workspace_lifecycle === "active" &&
          row.project_access !== "disabled" &&
          row.association_disabled_at === null &&
          row.membership_disabled_at === null &&
          row.membership_status === "enabled" &&
          row.workspace_access !== null &&
          row.workspace_access !== "disabled"
      };
    },

    async assertDispatch(
      actorUserId: string,
      projectId: string,
      expectedVersion: number,
      expectedMemberVersion: number
    ) {
      const project = await currentMember(pool, actorUserId, projectId);
      requireWrite(project);
      if (
        Number(project.version) !== expectedVersion ||
        Number(project.project_member_version) !== expectedMemberVersion
      )
        throw new WorkspaceProjectConflictError(projectRecord(project));
      return {
        allowed: true as const,
        projectVersion: Number(project.version),
        memberVersion: Number(project.project_member_version)
      };
    },
    async dispatchProof(
      actorUserId: string,
      projectId: string,
      itemId: string,
      input: {
        expectedProjectVersion: number;
        expectedMemberVersion: number;
        expectedWorkItemVersion: number;
      }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        if (
          Number(project.version) !== input.expectedProjectVersion ||
          Number(project.project_member_version) !== input.expectedMemberVersion
        )
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const item = await one(
          client,
          `select id,title,goal,status,version
        from workspace_project_work_items where id=$1 and workspace_project_id=$2
          and deleted_at is null for update`,
          [itemId, projectId]
        );
        if (!item)
          throw new WorkspaceProjectUnavailableError("Work Item unavailable");
        if (
          Number(item.version) !== input.expectedWorkItemVersion ||
          !["todo", "blocked"].includes(String(item.status))
        )
          throw new WorkspaceProjectConflictError(item);
        return {
          projectId,
          itemId,
          projectVersion: Number(project.version),
          memberVersion: Number(project.project_member_version),
          workItemVersion: Number(item.version),
          title: String(item.title),
          goal: String(item.goal),
          status: String(item.status)
        };
      });
    },
    async dispatchAuthority(
      actorUserId: string,
      projectId: string,
      itemId: string,
      dispatchKey: string
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        const item = await one(
          client,
          `select id,version,status,dispatch_key,
        dispatch_owner_team_member_id from workspace_project_work_items
        where id=$1 and workspace_project_id=$2 and deleted_at is null for update`,
          [itemId, projectId]
        );
        if (
          !item ||
          item.dispatch_key !== dispatchKey ||
          item.dispatch_owner_team_member_id !== project.actor_team_member_id ||
          !["doing", "review"].includes(String(item.status))
        )
          throw new WorkspaceProjectUnavailableError(
            "Shared dispatch no longer current"
          );
        return {
          allowed: true as const,
          projectId,
          itemId,
          dispatchKey,
          workItemVersion: Number(item.version)
        };
      });
    },

    async dispatchStatus(
      actorUserId: string,
      projectId: string,
      itemId: string,
      dispatchKey: string
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        const item = await one(
          client,
          `select id,version,status,step_label,dispatch_key,
        dispatch_owner_team_member_id,pr_url,pr_state
        from workspace_project_work_items
        where id=$1 and workspace_project_id=$2 and deleted_at is null for update`,
          [itemId, projectId]
        );
        if (
          !item ||
          item.dispatch_key !== dispatchKey ||
          item.dispatch_owner_team_member_id !== project.actor_team_member_id
        )
          throw new WorkspaceProjectUnavailableError(
            "Shared dispatch no longer current"
          );
        if (!["done", "blocked"].includes(String(item.status)))
          requireWrite(project);
        return {
          id: String(item.id),
          version: Number(item.version),
          status: String(item.status),
          stepLabel: nullableText(item.step_label),
          dispatchKey: textValue(item.dispatch_key),
          prUrl: nullableText(item.pr_url),
          prState: nullableText(item.pr_state)
        };
      });
    },

    async list(actorUserId: string, teamId: string) {
      const result = await pool.query<Row>(
        `
      select project.*
        from workspace_projects project
        join teams team on team.id=project.team_id and team.lifecycle='active'
        join team_workspaces workspace on workspace.id=project.workspace_id and workspace.lifecycle='active'
        join team_memberships membership
          on membership.team_id=project.team_id and membership.user_id=$2
         and membership.status='enabled' and membership.disabled_at is null
        join workspace_project_members association
          on association.workspace_project_id=project.id
         and association.team_member_id=membership.id
         and association.access <> 'disabled' and association.disabled_at is null
        join team_workspace_access_grants access
          on access.team_workspace_id=project.workspace_id
         and access.user_id=$2 and access.access <> 'disabled'
         and access.disabled_at is null
         where project.team_id=$1 and project.lifecycle='active'
       order by project.created_at,project.id`,
        [teamId, actorUserId]
      );
      return result.rows.map(projectRecord);
    },

    async join(actorUserId: string, projectId: string) {
      return transaction(pool, async (client) => {
        const identity = await one(
          client,
          `select team_id,workspace_id from workspace_projects
        where id=$1`,
          [projectId]
        );
        if (!identity)
          throw new WorkspaceProjectUnavailableError(
            "Workspace Project join unavailable"
          );
        await one(client, `select id from teams where id=$1 for update`, [
          identity.team_id
        ]);
        await one(
          client,
          `select id from team_memberships
        where team_id=$1 and user_id=$2 for update`,
          [identity.team_id, actorUserId]
        );
        await one(
          client,
          `select id from team_workspaces where id=$1 for update`,
          [identity.workspace_id]
        );
        await one(
          client,
          `select team_workspace_id from team_workspace_access_grants
        where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update`,
          [identity.workspace_id, identity.team_id, actorUserId]
        );
        await one(
          client,
          `select id from workspace_projects where id=$1 for update`,
          [projectId]
        );
        const project = await one(
          client,
          `
        select project.*,membership.id as actor_team_member_id
          from workspace_projects project
          join teams team on team.id=project.team_id and team.lifecycle='active'
          join team_workspaces workspace on workspace.id=project.workspace_id and workspace.lifecycle='active'
          join team_memberships membership
            on membership.team_id=project.team_id and membership.user_id=$2
           and membership.status='enabled' and membership.disabled_at is null
          join team_workspace_access_grants access
            on access.team_workspace_id=project.workspace_id
           and access.user_id=$2 and access.access='write'
           and access.disabled_at is null
         where project.id=$1 and project.lifecycle='active'`,
          [projectId, actorUserId]
        );
        if (!project)
          throw new WorkspaceProjectUnavailableError(
            "Workspace Project join unavailable"
          );
        const prior = await one(
          client,
          `select access,disabled_at from workspace_project_members
        where workspace_project_id=$1 and team_member_id=$2 for update`,
          [projectId, project.actor_team_member_id]
        );
        if (prior?.disabled_at || prior?.access === "disabled")
          throw new WorkspaceProjectUnavailableError(
            "Project rejoin requires owner approval"
          );
        await client.query(
          `
        insert into workspace_project_members (workspace_project_id,team_member_id,access)
        values ($1,$2,'write')
        on conflict (workspace_project_id,team_member_id) do nothing`,
          [projectId, project.actor_team_member_id]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_member",
          resourceId: projectId
        });
        return projectRecord(project);
      });
    },

    async copyFirstShare(
      actorUserId: string,
      projectId: string,
      input: {
        expectedVersion: number;
        personalProjectVersion: number;
        workItems: Array<{
          id: string;
          kind: "todo" | "ticket";
          key?: string | null;
          title: string;
          goal: string;
          status: "todo" | "doing" | "review" | "blocked" | "done";
          dueOn?: string | null;
          doneAt?: string | null;
        }>;
        sources: Array<{
          id: string;
          name: string;
          kind: string;
          status: string;
          personalNoteId?: string | null;
          personalNoteRevisionId?: string | null;
        }>;
        decks?: Array<{
          id: string;
          title: string;
          scope: string;
          madeFrom: string;
          createdByAgentId: string | null;
          cards: Array<{
            id: string;
            question: string;
            answer: string;
            sourceRef: string | null;
            topicLabel: string | null;
          }>;
        }>;
      }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        if (project.owner_team_member_id !== project.actor_team_member_id)
          throw new WorkspaceProjectUnavailableError(
            "Only the Workspace Project owner can copy first-share records"
          );
        const canceled = await one(
          client,
          `select id from workspace_project_share_cancellations
            where team_id=$1 and owner_team_member_id=$2
              and share_attempt_key=$3`,
          [
            project.team_id,
            project.owner_team_member_id,
            project.share_attempt_key
          ]
        );
        if (canceled)
          throw new WorkspaceProjectUnavailableError(
            "First-share attempt was canceled"
          );
        const manifestHash = workspaceProjectCopyManifestHash(input);
        if (project.copied_at) {
          if (project.copy_manifest_hash !== manifestHash)
            throw new WorkspaceProjectConflictError(projectRecord(project));
          return projectRecord(project);
        }
        if (Number(project.version) !== input.expectedVersion)
          throw new WorkspaceProjectConflictError(projectRecord(project));
        for (const item of input.workItems) {
          await client.query(
            `
          insert into workspace_project_work_items
            (id,workspace_project_id,source_owner_team_member_id,source_work_item_id,
             kind,key,title,goal,status,due_on,done_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          on conflict (workspace_project_id,source_owner_team_member_id,source_work_item_id)
          do nothing`,
            [
              randomUUID(),
              projectId,
              project.actor_team_member_id,
              item.id,
              item.kind,
              item.key ?? null,
              item.title,
              item.goal,
              item.status,
              item.dueOn ?? null,
              item.doneAt ?? null
            ]
          );
        }
        for (const source of input.sources) {
          if (
            Boolean(source.personalNoteId) !==
            Boolean(source.personalNoteRevisionId)
          )
            throw new WorkspaceProjectUnavailableError(
              "Personal Note provenance is incomplete"
            );
          await client.query(
            `
          insert into workspace_project_sources
            (id,workspace_project_id,uploader_team_member_id,source_project_source_id,
             name,kind,status,personal_note_id,personal_note_revision_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          on conflict (workspace_project_id,uploader_team_member_id,source_project_source_id)
          do nothing`,
            [
              randomUUID(),
              projectId,
              project.actor_team_member_id,
              source.id,
              source.name,
              source.kind,
              source.status,
              source.personalNoteId ?? null,
              source.personalNoteRevisionId ?? null
            ]
          );
        }
        for (const deck of input.decks ?? []) {
          const deckId = randomUUID();
          await client.query(
            `insert into workspace_project_decks
            (id,workspace_project_id,created_by_team_member_id,source_deck_id,title,scope,made_from,created_by_agent_id)
            values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (workspace_project_id,created_by_team_member_id,source_deck_id) do nothing`,
            [
              deckId,
              projectId,
              project.actor_team_member_id,
              deck.id,
              deck.title,
              deck.scope,
              deck.madeFrom,
              deck.createdByAgentId
            ]
          );
          const actual = (
            await client.query<{ id: string }>(
              `select id from workspace_project_decks
            where workspace_project_id=$1 and created_by_team_member_id=$2 and source_deck_id=$3`,
              [projectId, project.actor_team_member_id, deck.id]
            )
          ).rows[0];
          if (!actual)
            throw new WorkspaceProjectUnavailableError("Deck copy unavailable");
          for (const card of deck.cards)
            await client.query(
              `insert into workspace_project_deck_cards
            (id,workspace_project_id,deck_id,source_card_id,question,answer,source_ref,topic_label)
            values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (deck_id,source_card_id) do nothing`,
              [
                randomUUID(),
                projectId,
                actual.id,
                card.id,
                card.question,
                card.answer,
                card.sourceRef,
                card.topicLabel
              ]
            );
        }
        const updated = await one(
          client,
          `
        update workspace_projects set copied_at=now(),copy_manifest_hash=$2,version=version+1,updated_at=now()
         where id=$1 returning *`,
          [projectId, manifestHash]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project",
          resourceId: projectId
        });
        return projectRecord(updated!);
      });
    },

    async listWorkItems(
      actorUserId: string,
      projectId: string,
      input: { offset: number; expectedProjectVersion?: number }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        if (
          input.expectedProjectVersion !== undefined &&
          Number(project.version) !== input.expectedProjectVersion
        )
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const rows = (
          await client.query<Row>(
            `
      select id,source_owner_team_member_id,source_work_item_id,
             kind,key,title,goal,status,due_on,done_at,assignee_display_name,step_label,dispatch_key,
             pr_url,pr_state,version,created_at,updated_at
        from workspace_project_work_items
       where workspace_project_id=$1 and deleted_at is null
       order by created_at,id limit 51 offset $2`,
            [projectId, input.offset]
          )
        ).rows;
        const hasMore = rows.length > 50;
        return {
          items: rows.slice(0, 50).map(workItemRecord),
          nextOffset: hasMore ? input.offset + 50 : null,
          projectVersion: Number(project.version)
        };
      });
    },
    async activitySeen(actorUserId: string, projectId: string) {
      return transaction(pool, async (client) => {
        const member = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        const memberId = String(member.actor_team_member_id);
        const row = await one(
          client,
          `select seen_sequence,seen_at,welcome_delivered_at
           from workspace_project_seen
          where workspace_project_id=$1 and team_member_id=$2`,
          [projectId, memberId]
        );
        // A newly admitted member starts at their Project membership frontier,
        // not at the beginning of another member's historical activity.
        const initial = row
          ? null
          : await one(
              client,
              `select coalesce(max(sequence),0) as sequence
                 from workspace_project_activity
                where workspace_project_id=$1 and at < $2`,
              [projectId, member.project_member_created_at]
            );
        return {
          cursor: encodeActivityCursor(
            projectId,
            memberId,
            textValue(row?.seen_sequence ?? initial?.sequence ?? "0")
          ),
          seenAt: row?.seen_at
            ? new Date(row.seen_at as Date).toISOString()
            : null,
          welcomeDue: !row?.welcome_delivered_at,
          memberId
        };
      });
    },
    async activityPage(
      actorUserId: string,
      projectId: string,
      input: { after: string; limit: number }
    ) {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new WorkspaceProjectUnavailableError(
          "Project activity limit is invalid"
        );
      return transaction(pool, async (client) => {
        const member = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        const memberId = String(member.actor_team_member_id);
        const after = decodeActivityCursor(input.after, projectId, memberId);
        const rows = await client.query<{
          sequence: string;
          actor_team_member_id: string;
          kind: string;
          ref: string;
          at: Date;
        }>(
          `select sequence,actor_team_member_id,kind,ref,at
           from workspace_project_activity
          where workspace_project_id=$1 and sequence>$2
            and kind in ('work_item_created','work_item_done','source_added','pr_merged')
          order by sequence limit $3`,
          [projectId, after, input.limit + 1]
        );
        const selected = rows.rows.slice(0, input.limit);
        const items = selected.map((row) => ({
          cursor: encodeActivityCursor(projectId, memberId, row.sequence),
          actorTeamMemberId: row.actor_team_member_id,
          kind: row.kind as
            | "work_item_created"
            | "work_item_done"
            | "source_added"
            | "pr_merged",
          ref: row.ref,
          at: row.at.toISOString()
        }));
        return {
          projectId,
          memberId,
          items,
          hasMore: rows.rows.length > input.limit,
          nextCursor: items.at(-1)?.cursor ?? null
        };
      });
    },
    async acknowledgeActivity(
      actorUserId: string,
      projectId: string,
      cursor: string,
      welcomeDelivered: boolean
    ) {
      return transaction(pool, async (client) => {
        const member = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        const memberId = String(member.actor_team_member_id);
        const sequence = decodeActivityCursor(cursor, projectId, memberId);
        const prior = await one(
          client,
          `select seen_sequence from workspace_project_seen
            where workspace_project_id=$1 and team_member_id=$2`,
          [projectId, memberId]
        );
        if (!prior) {
          const initial = await one(
            client,
            `select coalesce(max(sequence),0) as sequence
               from workspace_project_activity
              where workspace_project_id=$1 and at < $2`,
            [projectId, member.project_member_created_at]
          );
          if (BigInt(sequence) < BigInt(textValue(initial?.sequence ?? "0")))
            throw new WorkspaceProjectUnavailableError(
              "Project activity cursor predates membership"
            );
        }
        if (sequence !== "0") {
          const exists = await one(
            client,
            `select 1 from workspace_project_activity
              where workspace_project_id=$1 and sequence=$2`,
            [projectId, sequence]
          );
          if (!exists)
            throw new WorkspaceProjectUnavailableError(
              "Project activity cursor is not committed"
            );
        }
        const row = await one(
          client,
          `insert into workspace_project_seen
            (workspace_project_id,team_member_id,seen_sequence,seen_at,welcome_delivered_at)
           values ($1,$2,$3,now(),case when $4 then now() else null end)
           on conflict (workspace_project_id,team_member_id) do update
             set seen_sequence=greatest(workspace_project_seen.seen_sequence,excluded.seen_sequence),
                 seen_at=case when excluded.seen_sequence>workspace_project_seen.seen_sequence
                   then now() else workspace_project_seen.seen_at end,
                 welcome_delivered_at=coalesce(workspace_project_seen.welcome_delivered_at,
                   excluded.welcome_delivered_at)
           returning seen_sequence,seen_at,welcome_delivered_at`,
          [projectId, memberId, sequence, welcomeDelivered]
        );
        return {
          cursor: encodeActivityCursor(
            projectId,
            memberId,
            String(row!.seen_sequence)
          ),
          seenAt: row!.seen_at
            ? new Date(row!.seen_at as Date).toISOString()
            : null,
          welcomeDue: !row!.welcome_delivered_at,
          memberId
        };
      });
    },
    async activitySummary(actorUserId: string, projectId: string) {
      return transaction(pool, async (client) => {
        await currentMember(client, actorUserId, projectId, true);
        const result = await client.query<{
          day: string;
          count: number;
          done: number;
          merged: number;
        }>(
          `
        with dates as (select generate_series(
          (now() at time zone 'UTC')::date - 6,
          (now() at time zone 'UTC')::date,interval '1 day')::date as day)
        select to_char(dates.day,'YYYY-MM-DD') as day,
          count(activity.sequence)::integer as count,
          count(activity.sequence) filter (where activity.kind='work_item_done')::integer as done,
          count(activity.sequence) filter (where activity.kind='pr_merged')::integer as merged
        from dates left join workspace_project_activity activity
          on activity.workspace_project_id=$1
         and activity.at >= dates.day::timestamp at time zone 'UTC'
         and activity.at < (dates.day+1)::timestamp at time zone 'UTC'
         and activity.at <= now()
        group by dates.day order by dates.day`,
          [projectId]
        );
        return {
          days: result.rows.map((row) => ({
            date: row.day,
            count: row.done + row.merged
          })),
          done: result.rows.reduce((total, row) => total + row.done, 0),
          merged: result.rows.reduce((total, row) => total + row.merged, 0)
        };
      });
    },

    async workItemByIdempotencyKey(
      actorUserId: string,
      projectId: string,
      idempotencyKey: string
    ) {
      const project = await currentMember(pool, actorUserId, projectId);
      requireWrite(project);
      const row = await one(
        pool,
        `select * from workspace_project_work_items
          where workspace_project_id=$1 and source_owner_team_member_id=$2
            and idempotency_key=$3 and deleted_at is null`,
        [projectId, project.actor_team_member_id, idempotencyKey]
      );
      return row ? workItemRecord(row) : null;
    },
    async workItemTextActionEffect(
      actorUserId: string,
      projectId: string,
      actionId: string
    ) {
      const project = await currentMember(pool, actorUserId, projectId);
      requireWrite(project);
      const row = await one(
        pool,
        `select item.*,effect.effect_nonce_hash from workspace_project_text_action_create_effects effect
           join workspace_project_work_items item
             on item.id=effect.work_item_id
            and item.workspace_project_id=effect.workspace_project_id
          where effect.workspace_project_id=$1
            and effect.source_owner_team_member_id=$2
            and effect.action_id=$3 and item.deleted_at is null`,
        [projectId, project.actor_team_member_id, actionId]
      );
      return row
        ? {
            item: workItemRecord(row),
            effectNonceHash: String(row.effect_nonce_hash)
          }
        : null;
    },
    async workItemProposalProof(
      actorUserId: string,
      projectId: string,
      itemId: string
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        const item = await one(
          client,
          `select id,version,status,title from workspace_project_work_items
            where workspace_project_id=$1 and id=$2 and deleted_at is null
            for update`,
          [projectId, itemId]
        );
        if (!item || !["todo", "blocked"].includes(String(item.status)))
          throw new WorkspaceProjectUnavailableError("Work Item unavailable");
        return {
          projectId,
          itemId,
          projectVersion: Number(project.version),
          memberVersion: Number(project.project_member_version),
          workItemVersion: Number(item.version),
          workItemTitle: String(item.title)
        };
      });
    },
    async createWorkItem(
      actorUserId: string,
      projectId: string,
      input: {
        idempotencyKey: string;
        kind: "todo" | "ticket";
        key?: string | null;
        title: string;
        goal: string;
        status: "todo" | "doing" | "review" | "blocked" | "done";
        dueOn?: string | null;
        expectedProjectVersion?: number;
        expectedMemberVersion?: number;
        textActionId?: string;
        textActionNonce?: string;
      }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        const effectNonceHash = textEffectHash(input.textActionNonce);
        if (
          input.textActionId &&
          (input.idempotencyKey !== input.textActionId ||
            !effectNonceHash ||
            input.kind !== "todo" ||
            input.key != null ||
            input.status !== "todo" ||
            input.expectedProjectVersion === undefined ||
            input.expectedMemberVersion === undefined)
        )
          throw new WorkspaceProjectUnavailableError(
            "Text action request is invalid"
          );
        if (!input.textActionId && input.textActionNonce)
          throw new WorkspaceProjectUnavailableError(
            "Text action nonce requires an action"
          );
        if (
          input.textActionId &&
          (Number(project.version) !== input.expectedProjectVersion ||
            Number(project.project_member_version) !==
              input.expectedMemberVersion)
        )
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const existing = await one(
          client,
          `select * from workspace_project_work_items
        where workspace_project_id=$1 and source_owner_team_member_id=$2
          and idempotency_key=$3 for update`,
          [projectId, project.actor_team_member_id, input.idempotencyKey]
        );
        if (existing) {
          if (input.textActionId) {
            const effect = await one(
              client,
              `select effect_nonce_hash from workspace_project_text_action_create_effects
                where workspace_project_id=$1
                  and source_owner_team_member_id=$2 and action_id=$3
                  and work_item_id=$4`,
              [
                projectId,
                project.actor_team_member_id,
                input.textActionId,
                existing.id
              ]
            );
            if (!effect || effect.effect_nonce_hash !== effectNonceHash)
              throw new WorkspaceProjectConflictError(workItemRecord(existing));
          }
          if (
            existing.kind !== input.kind ||
            existing.key !== (input.key ?? null) ||
            existing.title !== input.title ||
            existing.goal !== input.goal ||
            existing.status !== input.status ||
            existing.due_on !== (input.dueOn ?? null)
          )
            throw new WorkspaceProjectConflictError(workItemRecord(existing));
          return workItemRecord(existing);
        }
        if (effectNonceHash) {
          const reusedNonce = await one(
            client,
            `select 1 from workspace_project_text_action_create_effects
              where source_owner_team_member_id=$1 and effect_nonce_hash=$2`,
            [project.actor_team_member_id, effectNonceHash]
          );
          if (reusedNonce)
            throw new WorkspaceProjectUnavailableError(
              "Text action nonce was already consumed"
            );
        }
        if (
          (input.expectedProjectVersion === undefined) !==
            (input.expectedMemberVersion === undefined) ||
          (input.expectedProjectVersion !== undefined &&
            (Number(project.version) !== input.expectedProjectVersion ||
              Number(project.project_member_version) !==
                input.expectedMemberVersion))
        )
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const item = await one(
          client,
          `insert into workspace_project_work_items
        (id,workspace_project_id,source_owner_team_member_id,idempotency_key,
         kind,key,title,goal,status,due_on,done_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         case when $9='done' then now() else null end) returning *`,
          [
            randomUUID(),
            projectId,
            project.actor_team_member_id,
            input.idempotencyKey,
            input.kind,
            input.key ?? null,
            input.title,
            input.goal,
            input.status,
            input.dueOn ?? null
          ]
        );
        if (input.textActionId)
          await client.query(
            `insert into workspace_project_text_action_create_effects
              (workspace_project_id,source_owner_team_member_id,action_id,work_item_id,effect_nonce_hash)
             values ($1,$2,$3,$4,$5)`,
            [
              projectId,
              project.actor_team_member_id,
              input.textActionId,
              item!.id,
              effectNonceHash
            ]
          );
        await appendActivity(
          client,
          projectId,
          String(project.actor_team_member_id),
          input.status === "done" ? "work_item_done" : "work_item_created",
          String(item!.id)
        );
        await client.query(
          `update workspace_projects
        set version=version+1,updated_at=now() where id=$1`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_work_item",
          resourceId: String(item!.id)
        });
        return workItemRecord(item!);
      });
    },

    async patchWorkItem(
      actorUserId: string,
      projectId: string,
      itemId: string,
      input: {
        expectedVersion: number;
        title?: string;
        goal?: string;
        status?: string;
        dueOn?: string | null;
        assigneeDisplayName?: string | null;
        stepLabel?: string | null;
        dispatchKey?: string;
        prUrl?: string | null;
        prState?: string | null;
        mode?: "dispatch_receipt" | "dispatch_progress";
      }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        const item = await one(
          client,
          `
        select * from workspace_project_work_items
         where id=$1 and workspace_project_id=$2 and deleted_at is null
         for update`,
          [itemId, projectId]
        );
        if (!item)
          throw new WorkspaceProjectUnavailableError("Work Item unavailable");
        if (Number(item.version) !== input.expectedVersion)
          throw new WorkspaceProjectConflictError(item);
        if (input.mode === "dispatch_receipt") {
          if (
            input.dispatchKey !==
              `shared-work-item:${projectId}:${itemId}:${input.expectedVersion}` ||
            input.status !== "doing" ||
            input.stepLabel !== "Sent to Agent" ||
            item.dispatch_key !== null ||
            !["todo", "blocked"].includes(String(item.status))
          )
            throw new WorkspaceProjectConflictError(item);
        } else if (input.mode === "dispatch_progress") {
          if (
            !input.dispatchKey ||
            item.dispatch_key !== input.dispatchKey ||
            item.dispatch_owner_team_member_id !==
              project.actor_team_member_id ||
            !["doing", "review"].includes(String(item.status))
          )
            throw new WorkspaceProjectUnavailableError(
              "Current dispatch attempt unavailable"
            );
        } else if (
          input.assigneeDisplayName !== undefined ||
          input.stepLabel !== undefined ||
          input.dispatchKey !== undefined ||
          input.prUrl !== undefined ||
          input.prState !== undefined
        ) {
          throw new WorkspaceProjectUnavailableError(
            "Managed progress requires a dispatch attempt"
          );
        }
        const dispatchKey =
          input.mode === "dispatch_receipt"
            ? input.dispatchKey
            : input.mode === "dispatch_progress"
              ? item.dispatch_key
              : input.title !== undefined ||
                  input.goal !== undefined ||
                  input.status !== undefined ||
                  input.dueOn !== undefined
                ? null
                : item.dispatch_key;
        const dispatchOwnerTeamMemberId =
          input.mode === "dispatch_receipt"
            ? project.actor_team_member_id
            : dispatchKey
              ? item.dispatch_owner_team_member_id
              : null;
        const updated = await one(
          client,
          `
        update workspace_project_work_items
           set title=$3,goal=$4,status=$5,due_on=$6,assignee_display_name=$7,
               step_label=$8,pr_url=$9,pr_state=$10,dispatch_key=$11,
               dispatch_owner_team_member_id=$12,
               done_at=case when $5='done' then coalesce(done_at,now()) else null end,
               version=version+1,updated_at=now()
         where id=$1 and workspace_project_id=$2 returning *`,
          [
            itemId,
            projectId,
            input.title ?? item.title,
            input.goal ?? item.goal,
            input.status ?? item.status,
            input.dueOn === undefined ? item.due_on : input.dueOn,
            input.assigneeDisplayName === undefined
              ? item.assignee_display_name
              : input.assigneeDisplayName,
            input.stepLabel === undefined ? item.step_label : input.stepLabel,
            input.prUrl === undefined ? item.pr_url : input.prUrl,
            input.prState === undefined ? item.pr_state : input.prState,
            dispatchKey,
            dispatchOwnerTeamMemberId
          ]
        );
        await client.query(
          `update workspace_projects
        set version=version+1,updated_at=now() where id=$1`,
          [projectId]
        );
        const activityRef = `${itemId}:${updated!.version}`;
        await appendActivity(
          client,
          projectId,
          String(project.actor_team_member_id),
          item.status !== "done" && updated!.status === "done"
            ? "work_item_done"
            : "work_item_status",
          activityRef
        );
        if (item.pr_state !== "merged" && updated!.pr_state === "merged")
          await appendActivity(
            client,
            projectId,
            String(project.actor_team_member_id),
            "pr_merged",
            activityRef
          );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_work_item",
          resourceId: itemId
        });
        return workItemRecord(updated!);
      });
    },
    async dispatchReceipt(
      actorUserId: string,
      projectId: string,
      itemId: string,
      input: {
        expectedVersion: number;
        dispatchKey: string;
      }
    ) {
      return this.patchWorkItem(actorUserId, projectId, itemId, {
        ...input,
        status: "doing",
        stepLabel: "Sent to Agent",
        mode: "dispatch_receipt"
      });
    },
    async dispatchProgress(
      actorUserId: string,
      projectId: string,
      itemId: string,
      input: WorkspaceProjectDispatchProgress
    ) {
      return this.patchWorkItem(actorUserId, projectId, itemId, {
        ...input,
        mode: "dispatch_progress"
      });
    },

    async listSources(
      actorUserId: string,
      projectId: string,
      input: { offset: number; expectedProjectVersion?: number }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        if (
          input.expectedProjectVersion !== undefined &&
          Number(project.version) !== input.expectedProjectVersion
        )
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const rows = (
          await client.query<Row>(
            `
      select id,uploader_team_member_id,source_project_source_id,name,kind,status,
             personal_note_id,personal_note_revision_id,
             version,created_at,updated_at
        from workspace_project_sources
       where workspace_project_id=$1 and deleted_at is null
       order by created_at,id limit 101 offset $2`,
            [projectId, input.offset]
          )
        ).rows;
        return {
          items: rows.slice(0, 100).map(sourceRecord),
          nextOffset: rows.length > 100 ? input.offset + 100 : null,
          projectVersion: Number(project.version)
        };
      });
    },
    async bindShareGrant(
      actorUserId: string,
      projectId: string,
      shareGrantId: string,
      expectedGrantVersion: number,
      workspaceProjectSourceId?: string
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        const grant = await one(
          client,
          `select grant_row.id,grant_row.grant_version,
          grant_row.team_id,grant_row.team_workspace_id,grant_row.owner_user_id,
          grant_row.lifecycle,grant_row.revoked_at,grant_row.frozen_at,
          source.source_kind, note_source.source_note_id
        from team_memory_share_grants grant_row
        left join logical_memory_source_revision_bindings source
          on source.source_revision_id=grant_row.source_revision_id
        left join personal_note_source_revisions note_source
          on note_source.source_revision_id=grant_row.source_revision_id
        where grant_row.id=$1 for update of grant_row`,
          [shareGrantId]
        );
        if (
          !grant ||
          grant.team_id !== project.team_id ||
          grant.team_workspace_id !== project.workspace_id ||
          grant.owner_user_id !== actorUserId ||
          grant.lifecycle !== "active" ||
          grant.revoked_at !== null ||
          grant.frozen_at !== null ||
          Number(grant.grant_version) !== expectedGrantVersion
        )
          throw new WorkspaceProjectUnavailableError(
            "Current owner grant unavailable"
          );
        if (workspaceProjectSourceId) {
          const source = await one(
            client,
            `select id,personal_note_id from workspace_project_sources
          where id=$1 and workspace_project_id=$2
            and uploader_team_member_id=$3 and deleted_at is null
            and personal_note_id is not null and personal_note_revision_id is not null for update`,
            [workspaceProjectSourceId, projectId, project.actor_team_member_id]
          );
          if (
            !source ||
            grant.source_kind !== "personal_note" ||
            source.personal_note_id !== grant.source_note_id
          )
            throw new WorkspaceProjectUnavailableError(
              "Exact uploader Note Source grant is unavailable"
            );
        }
        const bound = await one(
          client,
          `select workspace_project_id,share_grant_id,
          source_owner_team_member_id,workspace_project_source_id
        from workspace_project_share_grant_bindings where share_grant_id=$1 for update`,
          [shareGrantId]
        );
        if (bound) {
          if (
            bound.workspace_project_id !== projectId ||
            bound.source_owner_team_member_id !==
              project.actor_team_member_id ||
            bound.workspace_project_source_id !==
              (workspaceProjectSourceId ?? null)
          )
            throw new WorkspaceProjectConflictError(bound);
          return {
            workspaceProjectId: projectId,
            shareGrantId,
            sourceOwnerTeamMemberId: String(project.actor_team_member_id),
            workspaceProjectSourceId: workspaceProjectSourceId ?? null
          };
        }
        const row = await one(
          client,
          `insert into workspace_project_share_grant_bindings
        (workspace_project_id,share_grant_id,source_owner_team_member_id,
         workspace_project_source_id)
        values ($1,$2,$3,$4)
        returning workspace_project_id,share_grant_id,
          source_owner_team_member_id,workspace_project_source_id`,
          [
            projectId,
            shareGrantId,
            project.actor_team_member_id,
            workspaceProjectSourceId ?? null
          ]
        );
        await client.query(
          `update workspace_projects set version=version+1,
        updated_at=now() where id=$1`,
          [projectId]
        );
        return {
          workspaceProjectId: String(row!.workspace_project_id),
          shareGrantId: String(row!.share_grant_id),
          sourceOwnerTeamMemberId: String(row!.source_owner_team_member_id),
          workspaceProjectSourceId: row!.workspace_project_source_id ?? null
        };
      });
    },
    async createSource(
      actorUserId: string,
      projectId: string,
      input: {
        sourceProjectSourceId: string;
        name: string;
        kind: string;
        status: string;
        personalNoteId: string | null;
        personalNoteRevisionId: string | null;
      }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        if (
          Boolean(input.personalNoteId) !==
          Boolean(input.personalNoteRevisionId)
        )
          throw new WorkspaceProjectUnavailableError(
            "Personal Note provenance is incomplete"
          );
        const existing = await one(
          client,
          `select * from workspace_project_sources
        where workspace_project_id=$1 and uploader_team_member_id=$2
          and source_project_source_id=$3 for update`,
          [projectId, project.actor_team_member_id, input.sourceProjectSourceId]
        );
        if (existing) {
          if (
            existing.name !== input.name ||
            existing.kind !== input.kind ||
            existing.status !== input.status ||
            existing.personal_note_id !== input.personalNoteId ||
            existing.personal_note_revision_id !==
              input.personalNoteRevisionId ||
            existing.deleted_at !== null
          )
            throw new WorkspaceProjectConflictError(sourceRecord(existing));
          return sourceRecord(existing);
        }
        const source = await one(
          client,
          `insert into workspace_project_sources
        (id,workspace_project_id,uploader_team_member_id,source_project_source_id,
         name,kind,status,personal_note_id,personal_note_revision_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
          [
            randomUUID(),
            projectId,
            project.actor_team_member_id,
            input.sourceProjectSourceId,
            input.name,
            input.kind,
            input.status,
            input.personalNoteId,
            input.personalNoteRevisionId
          ]
        );
        await appendActivity(
          client,
          projectId,
          String(project.actor_team_member_id),
          "source_added",
          String(source!.id)
        );
        await client.query(
          `update workspace_projects set version=version+1,
        updated_at=now() where id=$1`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_source",
          resourceId: String(source!.id)
        });
        return sourceRecord(source!);
      });
    },
    async getSourceUploaderProof(
      actorUserId: string,
      projectId: string,
      sourceId: string
    ) {
      return transaction(pool, async (client) => {
        const member = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        const source = await one(
          client,
          `select source_project_source_id,uploader_team_member_id,version,
        personal_note_id,personal_note_revision_id
      from workspace_project_sources where workspace_project_id=$1 and id=$2
        and deleted_at is null for update`,
          [projectId, sourceId]
        );
        if (
          !source ||
          source.uploader_team_member_id !== member.actor_team_member_id
        )
          throw new WorkspaceProjectUnavailableError(
            "Uploader Source unavailable"
          );
        return {
          workspaceProjectId: projectId,
          sourceId,
          sourceProjectSourceId: String(source.source_project_source_id),
          uploaderTeamMemberId: String(source.uploader_team_member_id),
          sourceVersion: Number(source.version),
          personalNoteId: source.personal_note_id ?? null,
          personalNoteRevisionId: source.personal_note_revision_id ?? null
        };
      });
    },
    async getSourceDeleteReview(
      actorUserId: string,
      projectId: string,
      sourceId: string
    ) {
      const review = await this.getLifecycleReview(actorUserId, projectId);
      if (
        !review ||
        review.actorAccess !== "write" ||
        review.actorWorkspaceAccess !== "write"
      )
        return null;
      const source = await one(
        pool,
        `select source.id,source.name,source.version,
        source.uploader_team_member_id,uploader.user_id as uploader_user_id
      from workspace_project_sources source
      join team_memberships uploader on uploader.id=source.uploader_team_member_id
      where source.id=$1 and source.workspace_project_id=$2
        and source.deleted_at is null`,
        [sourceId, projectId]
      );
      if (
        !source ||
        (review.ownerUserId !== actorUserId &&
          source.uploader_user_id !== actorUserId)
      )
        return null;
      return {
        project: review.project,
        sourceId,
        sourceName: String(source.name),
        sourceVersion: Number(source.version),
        uploaderUserId: String(source.uploader_user_id),
        uploaderTeamMemberId: String(source.uploader_team_member_id)
      };
    },

    async patchSource(
      actorUserId: string,
      projectId: string,
      sourceId: string,
      input: {
        expectedVersion: number;
        name?: string;
        status?: string;
        personalNoteId?: string | null;
        personalNoteRevisionId?: string | null;
        deleted?: boolean;
      }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        const source = await one(
          client,
          `select * from workspace_project_sources
        where id=$1 and workspace_project_id=$2 for update`,
          [sourceId, projectId]
        );
        if (!source)
          throw new WorkspaceProjectUnavailableError("Source unavailable");
        if (
          source.uploader_team_member_id !== project.actor_team_member_id &&
          project.owner_team_member_id !== project.actor_team_member_id
        )
          throw new WorkspaceProjectUnavailableError(
            "Only uploader or Project owner edits Source metadata"
          );
        if (Number(source.version) !== input.expectedVersion)
          throw new WorkspaceProjectConflictError(sourceRecord(source));
        if (input.deleted === true)
          throw new WorkspaceProjectUnavailableError(
            "Source deletion requires reviewed Step-up approval"
          );
        if (
          (input.personalNoteId !== undefined ||
            input.personalNoteRevisionId !== undefined) &&
          source.uploader_team_member_id !== project.actor_team_member_id
        )
          throw new WorkspaceProjectUnavailableError(
            "Only uploader updates Personal Note revision link"
          );
        const noteId =
          input.personalNoteId === undefined
            ? source.personal_note_id
            : input.personalNoteId;
        const noteRevisionId =
          input.personalNoteRevisionId === undefined
            ? source.personal_note_revision_id
            : input.personalNoteRevisionId;
        if (Boolean(noteId) !== Boolean(noteRevisionId))
          throw new WorkspaceProjectUnavailableError(
            "Personal Note provenance changed"
          );
        const updated = await one(
          client,
          `update workspace_project_sources
        set name=$3,status=$4,personal_note_id=$5,personal_note_revision_id=$6,deleted_at=$7,
            version=version+1,updated_at=now()
        where id=$1 and workspace_project_id=$2 returning *`,
          [
            sourceId,
            projectId,
            input.name ?? source.name,
            input.status ?? source.status,
            noteId,
            noteRevisionId,
            input.deleted === undefined
              ? source.deleted_at
              : input.deleted
                ? new Date()
                : null
          ]
        );
        await client.query(
          `update workspace_projects set version=version+1,
        updated_at=now() where id=$1`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_source",
          resourceId: sourceId
        });
        return sourceRecord(updated!);
      });
    },

    async deleteSourceMetadata(
      actorUserId: string,
      projectId: string,
      sourceId: string,
      input: { expectedProjectVersion: number; expectedSourceVersion: number }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        if (Number(project.version) !== input.expectedProjectVersion)
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const source = await one(
          client,
          `select source.*,
          uploader.user_id as uploader_user_id,
          uploader.version as uploader_member_version
        from workspace_project_sources source
        join team_memberships uploader on uploader.id=source.uploader_team_member_id
        where source.id=$1 and source.workspace_project_id=$2
        for update of source,uploader`,
          [sourceId, projectId]
        );
        if (!source || source.deleted_at !== null)
          throw new WorkspaceProjectUnavailableError(
            "Current Source unavailable"
          );
        if (Number(source.version) !== input.expectedSourceVersion)
          throw new WorkspaceProjectConflictError(sourceRecord(source));
        if (
          source.uploader_user_id !== actorUserId &&
          project.owner_team_member_id !== project.actor_team_member_id
        )
          throw new WorkspaceProjectUnavailableError(
            "Only uploader or Project owner may delete Source metadata"
          );
        const grants = await client.query<{
          id: string;
          grant_version: number;
        }>(
          `
        select grant_row.id,grant_row.grant_version
          from team_memory_share_grants grant_row
          join workspace_project_share_grant_bindings binding
            on binding.share_grant_id=grant_row.id
         where binding.workspace_project_id=$1
           and binding.workspace_project_source_id=$2
           and binding.source_owner_team_member_id=$3
           and grant_row.team_id=$4 and grant_row.team_workspace_id=$5
           and grant_row.owner_user_id=$6
           and grant_row.lifecycle='active' and grant_row.revoked_at is null
           and grant_row.frozen_at is null
         order by grant_row.id for update of grant_row`,
          [
            projectId,
            sourceId,
            source.uploader_team_member_id,
            project.team_id,
            project.workspace_id,
            source.uploader_user_id
          ]
        );
        if (grants.rows.length && !options.freezeGrantForParent)
          throw new WorkspaceProjectUnavailableError(
            "Verified Source grant freeze is unavailable"
          );
        for (const grant of grants.rows)
          await options.freezeGrantForParent!(client, {
            action: "project_source.team_metadata.delete",
            actorUserId,
            teamId: String(project.team_id),
            workspaceId: String(project.workspace_id),
            projectId,
            targetUserId: String(source.uploader_user_id),
            targetVersion: Number(source.uploader_member_version),
            sourceId,
            sourceVersion: Number(source.version),
            shareGrantId: grant.id,
            expectedGrantVersion: grant.grant_version
          });
        const deleted = await one(
          client,
          `update workspace_project_sources
        set deleted_at=now(),version=version+1,updated_at=now()
        where id=$1 and workspace_project_id=$2 returning version`,
          [sourceId, projectId]
        );
        await client.query(
          `update workspace_projects
        set version=version+1,updated_at=now() where id=$1`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_source",
          resourceId: sourceId
        });
        return {
          projectId,
          sourceId,
          version: Number(deleted!.version),
          deleted: true as const
        };
      });
    },

    async getLifecycleReview(
      actorUserId: string,
      projectId: string,
      targetUserId?: string
    ) {
      const row = await one(
        pool,
        `
      select project.*, actor_member.id as actor_member_id,
             actor_member.version as actor_membership_version,
             actor_link.access as actor_access,
             actor_link.version as actor_link_version,
             actor_workspace.access as actor_workspace_access,
             owner_member.user_id as owner_user_id,
             target_member.id as target_member_id,
             target_member.version as target_membership_version,
             target_link.access as target_access,
             target_link.version as target_link_version
        from workspace_projects project
        join team_memberships actor_member
          on actor_member.team_id=project.team_id and actor_member.user_id=$2
         and actor_member.status='enabled' and actor_member.disabled_at is null
        join workspace_project_members actor_link
          on actor_link.workspace_project_id=project.id
         and actor_link.team_member_id=actor_member.id
         and actor_link.disabled_at is null
        join team_workspace_access_grants actor_workspace
          on actor_workspace.team_workspace_id=project.workspace_id
         and actor_workspace.user_id=$2
         and actor_workspace.disabled_at is null
        join team_memberships owner_member on owner_member.id=project.owner_team_member_id
        left join team_memberships target_member
          on target_member.team_id=project.team_id and target_member.user_id=$3
         and target_member.status='enabled' and target_member.disabled_at is null
        left join workspace_project_members target_link
          on target_link.workspace_project_id=project.id
         and target_link.team_member_id=target_member.id
         and target_link.disabled_at is null
       where project.id=$1 and project.lifecycle='active'`,
        [projectId, actorUserId, targetUserId ?? null]
      );
      if (
        !row ||
        row.actor_access === "disabled" ||
        row.actor_workspace_access === "disabled"
      )
        return null;
      return {
        project: projectRecord(row),
        actorUserId,
        actorTeamMemberId: String(row.actor_member_id),
        actorMemberVersion: Number(row.actor_link_version),
        ownerUserId: String(row.owner_user_id),
        targetUserId: targetUserId ?? null,
        targetTeamMemberId: nullableText(row.target_member_id),
        targetMemberVersion: row.target_link_version
          ? Number(row.target_link_version)
          : null,
        targetAccess: row.target_access ?? null,
        actorAccess: String(row.actor_access),
        actorWorkspaceAccess: String(row.actor_workspace_access)
      };
    },

    async leave(
      actorUserId: string,
      projectId: string,
      input: {
        expectedProjectVersion: number;
        expectedMemberVersion: number;
      }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        if (project.owner_team_member_id === project.actor_team_member_id)
          throw new WorkspaceProjectUnavailableError(
            "Project owner cannot self-leave"
          );
        if (
          Number(project.version) !== input.expectedProjectVersion ||
          Number(project.project_member_version) !== input.expectedMemberVersion
        )
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const member = await one(
          client,
          "select version from team_memberships where id=$1 for update",
          [project.actor_team_member_id]
        );
        await freezeMemberGrants(
          client,
          project,
          "workspace_project.leave",
          actorUserId,
          actorUserId,
          Number(member?.version)
        );
        await client.query(
          `update workspace_project_work_items
        set dispatch_key=null,dispatch_owner_team_member_id=null,
            version=version+1,updated_at=now()
        where workspace_project_id=$1 and dispatch_owner_team_member_id=$2
          and dispatch_key is not null`,
          [projectId, project.actor_team_member_id]
        );
        await client.query(
          `
        update workspace_project_members
           set access='disabled',disabled_at=now(),version=version+1,updated_at=now()
         where workspace_project_id=$1 and team_member_id=$2`,
          [projectId, project.actor_team_member_id]
        );
        await client.query(
          `update team_workspace_access_grants
         set access='disabled',can_share_owned_memory=false,
             disabled_at=now(),disabled_reason='workspace_project_left',
             version=version+1,updated_at=now()
       where team_workspace_id=$1 and user_id=$2`,
          [project.workspace_id, actorUserId]
        );
        await client.query(
          `update workspace_projects set version=version+1,
        updated_at=now() where id=$1`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_member",
          resourceId: projectId
        });
        return {
          projectId,
          memberId: String(project.actor_team_member_id),
          access: "disabled" as const
        };
      });
    },

    async removeMember(
      actorUserId: string,
      projectId: string,
      targetUserId: string,
      input: { expectedProjectVersion: number; expectedMemberVersion: number }
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        if (
          project.owner_team_member_id !== project.actor_team_member_id ||
          targetUserId === actorUserId
        )
          throw new WorkspaceProjectUnavailableError(
            "Only the Project owner removes another member"
          );
        if (Number(project.version) !== input.expectedProjectVersion)
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const target = await one(
          client,
          `
        select member.id,member.version,association.version as link_version
          from team_memberships member
          join workspace_project_members association
            on association.team_member_id=member.id
           and association.workspace_project_id=$1
           and association.disabled_at is null
         where member.team_id=$2 and member.user_id=$3
           and member.status='enabled' and member.disabled_at is null
         for update of member,association`,
          [projectId, project.team_id, targetUserId]
        );
        if (!target || target.id === project.owner_team_member_id)
          throw new WorkspaceProjectUnavailableError(
            "Named non-owner Project member unavailable"
          );
        if (Number(target.link_version) !== input.expectedMemberVersion)
          throw new WorkspaceProjectConflictError(target);
        await freezeMemberGrants(
          client,
          project,
          "workspace_project.member_remove",
          actorUserId,
          targetUserId,
          Number(target.version)
        );
        await client.query(
          `update workspace_project_work_items
        set dispatch_key=null,dispatch_owner_team_member_id=null,
            version=version+1,updated_at=now()
        where workspace_project_id=$1 and dispatch_owner_team_member_id=$2
          and dispatch_key is not null`,
          [projectId, target.id]
        );
        await client.query(
          `
        update workspace_project_members
           set access='disabled',disabled_at=now(),version=version+1,updated_at=now()
         where workspace_project_id=$1 and team_member_id=$2`,
          [projectId, target.id]
        );
        await client.query(
          `update team_workspace_access_grants
         set access='disabled',can_share_owned_memory=false,
             disabled_at=now(),disabled_reason='workspace_project_removed',
             version=version+1,updated_at=now()
       where team_workspace_id=$1 and user_id=$2`,
          [project.workspace_id, targetUserId]
        );
        await client.query(
          `update workspace_projects set version=version+1,
        updated_at=now() where id=$1`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project_member",
          resourceId: projectId
        });
        return {
          projectId,
          memberId: String(target.id),
          access: "disabled" as const
        };
      });
    },

    async deleteProject(
      actorUserId: string,
      projectId: string,
      expectedProjectVersion: number
    ) {
      return transaction(pool, async (client) => {
        const project = await currentMember(
          client,
          actorUserId,
          projectId,
          true
        );
        requireWrite(project);
        if (project.owner_team_member_id !== project.actor_team_member_id)
          throw new WorkspaceProjectUnavailableError(
            "Only the Project owner can delete"
          );
        if (Number(project.version) !== expectedProjectVersion)
          throw new WorkspaceProjectConflictError(projectRecord(project));
        const members = await client.query<{
          id: string;
          user_id: string;
          version: number;
        }>(
          `
        select membership.id,membership.user_id,membership.version
          from workspace_project_members association
          join team_memberships membership on membership.id=association.team_member_id
         where association.workspace_project_id=$1 and association.disabled_at is null
         order by membership.id for update of association,membership`,
          [projectId]
        );
        for (const member of members.rows)
          await freezeMemberGrants(
            client,
            project,
            "workspace_project.delete",
            actorUserId,
            member.user_id,
            member.version
          );
        await client.query(
          `update workspace_project_work_items
        set dispatch_key=null,dispatch_owner_team_member_id=null,
            version=version+1,updated_at=now()
        where workspace_project_id=$1 and dispatch_key is not null`,
          [projectId]
        );
        await client.query(
          `
        update workspace_projects
           set lifecycle='deleted',deleted_at=now(),version=version+1,updated_at=now()
         where id=$1`,
          [projectId]
        );
        await client.query(
          `update workspace_project_decks set deleted_at=now(),version=version+1,updated_at=now()
          where workspace_project_id=$1 and deleted_at is null`,
          [projectId]
        );
        await client.query(
          `
        update workspace_project_members
           set access='disabled',disabled_at=now(),version=version+1,updated_at=now()
         where workspace_project_id=$1 and disabled_at is null`,
          [projectId]
        );
        await client.query(
          `
        update collaboration_threads
           set lifecycle='archived',archived_at=now(),version=version+1,updated_at=now()
         where workspace_project_id=$1 and scope='team' and kind='project_thread'
           and lifecycle='active'`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(project.team_id),
          workspaceId: String(project.workspace_id),
          actorUserId,
          resourceType: "workspace_project",
          resourceId: projectId
        });
        return { projectId, lifecycle: "deleted" as const };
      });
    },

    async listRestorableProjects(actorUserId: string) {
      const rows = await pool.query<Row>(
        `
        select project.id,project.team_id,project.name,project.version,
               project.deleted_at
          from workspace_projects project
          join team_memberships member
            on member.id=project.owner_team_member_id
           and member.team_id=project.team_id and member.user_id=$1
           and member.status='enabled' and member.disabled_at is null
          join users actor on actor.id=$1
           and actor.disabled_at is null and actor.deleted_at is null
          join teams team on team.id=project.team_id
           and team.lifecycle='active' and team.entitlement_status in ('active','grace')
          join team_workspaces workspace on workspace.id=project.workspace_id
           and workspace.team_id=team.id and workspace.lifecycle='active'
          join team_workspace_access_grants access
            on access.team_workspace_id=workspace.id
           and access.team_id=team.id and access.user_id=$1
           and access.access='write' and access.disabled_at is null
         where project.lifecycle='deleted'
           and project.deleted_at>now()-interval '30 days'
         order by project.deleted_at desc,project.id
         limit 100`,
        [actorUserId]
      );
      return rows.rows.map((row) => ({
        projectId: String(row.id),
        teamId: String(row.team_id),
        name: String(row.name),
        version: Number(row.version),
        deletedAt:
          row.deleted_at instanceof Date
            ? row.deleted_at.toISOString()
            : String(row.deleted_at)
      }));
    },

    async restoreProject(
      actorUserId: string,
      projectId: string,
      expectedProjectVersion: number
    ) {
      return transaction(pool, async (client) => {
        const identity = await one(
          client,
          "select team_id,workspace_id from workspace_projects where id=$1",
          [projectId]
        );
        if (!identity)
          throw new WorkspaceProjectUnavailableError(
            "Deleted Project unavailable"
          );
        const team = await one(
          client,
          "select lifecycle,entitlement_status from teams where id=$1 for update",
          [identity.team_id]
        );
        const user = await one(
          client,
          "select disabled_at,deleted_at from users where id=$1 for update",
          [actorUserId]
        );
        const member = await one(
          client,
          `select id,status,disabled_at from team_memberships
             where team_id=$1 and user_id=$2 for update`,
          [identity.team_id, actorUserId]
        );
        const workspace = await one(
          client,
          "select lifecycle from team_workspaces where id=$1 and team_id=$2 for update",
          [identity.workspace_id, identity.team_id]
        );
        const access = await one(
          client,
          `select access,disabled_at from team_workspace_access_grants
            where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update`,
          [identity.workspace_id, identity.team_id, actorUserId]
        );
        if (
          team?.lifecycle !== "active" ||
          !["active", "grace"].includes(String(team.entitlement_status)) ||
          !user ||
          user.disabled_at ||
          user.deleted_at ||
          member?.status !== "enabled" ||
          member.disabled_at ||
          workspace?.lifecycle !== "active" ||
          access?.access !== "write" ||
          access.disabled_at
        )
          throw new WorkspaceProjectUnavailableError(
            "Current Project owner authority unavailable"
          );
        const row = await one(
          client,
          `select project.id,project.team_id,project.workspace_id,
                  project.version,project.lifecycle,project.deleted_at,
                  owner_member.user_id as owner_user_id
             from workspace_projects project
             join team_memberships owner_member
               on owner_member.id=project.owner_team_member_id
            where project.id=$1 and owner_member.user_id=$2
              and owner_member.id=$3
            for update of project`,
          [projectId, actorUserId, member.id]
        );
        if (!row || row.lifecycle !== "deleted")
          throw new WorkspaceProjectUnavailableError(
            "Deleted Project owner authority unavailable"
          );
        if (Number(row.version) !== expectedProjectVersion)
          throw new WorkspaceProjectConflictError(row);
        const restored = await one(
          client,
          `update workspace_projects
              set lifecycle='active',deleted_at=null,
                  version=version+1,updated_at=now()
            where id=$1 and lifecycle='deleted' and version=$2
              and deleted_at > now() - interval '30 days'
            returning version`,
          [projectId, expectedProjectVersion]
        );
        if (!restored)
          throw new WorkspaceProjectUnavailableError(
            "Project restore window expired"
          );
        await client.query(
          `update collaboration_threads
              set lifecycle='active',archived_at=null,
                  version=version+1,updated_at=now()
            where workspace_project_id=$1 and scope='team'
              and kind='project_thread' and lifecycle='archived'`,
          [projectId]
        );
        await notifyProjectChange(client, {
          teamId: String(row.team_id),
          workspaceId: String(row.workspace_id),
          actorUserId,
          resourceType: "workspace_project",
          resourceId: projectId
        });
        return {
          projectId,
          lifecycle: "active" as const,
          version: Number(restored.version)
        };
      });
    }
  };
};

export type WorkspaceProjectRepository = ReturnType<
  typeof createWorkspaceProjectRepository
>;
