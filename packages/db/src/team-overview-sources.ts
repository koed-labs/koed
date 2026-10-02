import { createHash } from "node:crypto";
import pg from "pg";
import {
  type EnvelopeEncryptionProvider,
  type TeamOverviewItem,
  type TeamOverviewSource
} from "@koed/shared";
import { decryptTeamEncryptedFieldAfterAuthorizationWithClient } from "./encrypted-payload-repository.js";
import type { TeamOverviewTeamRecord } from "./team-overview-repository.js";
import type { ActorContext } from "./types.js";

export interface TeamOverviewSourceRef {
  teamId: string;
  source: TeamOverviewSource;
  sourceEventId: string;
  sourceId: string;
  sourceRevision: string;
}

export interface TeamOverviewSourceSnapshot {
  attention: TeamOverviewItem[];
  catchUp: TeamOverviewItem[];
}

export interface TeamOverviewSourcesRepository {
  listCurrentItems(
    actor: ActorContext,
    teams?: TeamOverviewTeamRecord[]
  ): Promise<TeamOverviewSourceSnapshot>;
  getCurrentSourceWithClient(
    client: pg.PoolClient,
    actor: ActorContext,
    input: Omit<TeamOverviewSourceRef, "sourceRevision">
  ): Promise<TeamOverviewSourceRef | null>;
  validateCurrentSourceWithClient(
    client: pg.PoolClient,
    actor: ActorContext,
    input: TeamOverviewSourceRef
  ): Promise<boolean>;
}

export interface TeamOverviewSourcesOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

interface TeamRow {
  team_id: string;
  team_name: string;
}

interface ThreadRow {
  id: string;
  team_id: string;
  team_name: string;
  kind:
    | "team_channel"
    | "team_project_channel"
    | "dm"
    | "group_dm"
    | "workspace_channel";
  team_workspace_id: string | null;
  name_marker: string;
  last_activity_at: Date;
  last_read_sequence: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  team_id: string;
  team_workspace_id: string | null;
  root_message_id: string | null;
  thread_sequence: number;
  version: number;
  sender_kind: string;
  sender_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  root_sender_user_id: string | null;
  is_unread: boolean;
  is_reply_to_viewer_root: boolean;
  body_text?: string;
  mention_user_ids?: string[];
}

interface PublicationRow {
  id: string;
  team_id: string;
  team_name: string;
  team_project_id: string;
  job_id: string;
  owner_user_id: string;
  owner_name: string;
  agent_name: string;
  project_name: string;
  project_thread_id: string;
  project_team_workspace_id: string | null;
  publication_state: "active" | "frozen";
  publication_version: number;
  job_state: string;
  job_version: number;
  job_updated_at: Date;
  execution_updated_at: Date;
  execution_state_version: number;
  execution_state: string;
  frozen_status: string | null;
  frozen_updated_at: Date | null;
  frozen_completed_at: Date | null;
  completed_at: Date | null;
  published_at: Date;
  conversation_id: string | null;
  current_blockers: Array<{ id: string; revision: number; itemKind: string }>;
}

interface RequestRow {
  id: string;
  team_id: string;
  team_name: string;
  team_project_id: string;
  channel_id: string;
  request_message_id: string;
  root_message_id: string | null;
  requester_user_id: string;
  requester_name: string;
  owner_user_id: string;
  agent_name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface PullRequestActionRow {
  team_id: string;
  team_name: string;
  publication_id: string;
  job_id: string;
  team_project_id: string;
  review_id: string;
  repository_id: string;
  pull_request_number: number;
  review_status: string;
  review_revision: number;
  review_updated_at: Date;
  operation_id: string | null;
  operation_state: string | null;
  operation_revision: number | null;
  operation_updated_at: Date | null;
  job_state: string;
}

interface PullRequestActionProjection {
  item: TeamOverviewItem;
  linkedJobId: string;
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const itemRef = (item: TeamOverviewItem): TeamOverviewSourceRef => ({
  teamId: item.teamId,
  source: item.source,
  sourceEventId: item.sourceEventId,
  sourceId: item.sourceId,
  sourceRevision: item.sourceRevision
});

const sameRef = (a: TeamOverviewSourceRef, b: TeamOverviewSourceRef) =>
  a.teamId === b.teamId &&
  a.source === b.source &&
  a.sourceEventId === b.sourceEventId &&
  a.sourceId === b.sourceId &&
  a.sourceRevision === b.sourceRevision;

export const createTeamOverviewSourcesRepository = (
  pool: pg.Pool,
  options: TeamOverviewSourcesOptions = {}
): TeamOverviewSourcesRepository => {
  const teamProvider =
    options.teamEnvelopeEncryptionProvider ??
    options.envelopeEncryptionProvider;

  const listTeamsWithClient = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    teamIds?: string[]
  ): Promise<TeamRow[]> => {
    const result = await client.query<TeamRow>(
      `select team.id as team_id,team.name as team_name
         from team_memberships membership
         join teams team on team.id=membership.team_id
         join users viewer on viewer.id=membership.user_id
        where membership.user_id=$1 and membership.status='enabled'
          and membership.disabled_at is null and team.lifecycle='active'
          and team.entitlement_status in ('active','grace')
          and viewer.disabled_at is null and viewer.deleted_at is null
          and ($2::uuid[] is null or team.id=any($2::uuid[]))
        order by team.name,team.id`,
      [actor.userId, teamIds?.length ? teamIds : null]
    );
    return result.rows;
  };

  const listThreadsWithClient = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    teamId: string,
    teamName: string
  ): Promise<ThreadRow[]> => {
    const result = await client.query<ThreadRow>(
      `select thread.id,thread.team_id,$3::text as team_name,thread.kind,
              thread.team_workspace_id,thread.name_marker,thread.last_activity_at,
              coalesce(receipt.last_read_sequence,0)::bigint as last_read_sequence
         from collaboration_threads thread
         join team_memberships membership on membership.team_id=thread.team_id
           and membership.user_id=$2 and membership.status='enabled'
           and membership.disabled_at is null
         join teams team on team.id=thread.team_id and team.lifecycle='active'
           and team.entitlement_status in ('active','grace')
         join users viewer on viewer.id=$2 and viewer.disabled_at is null
           and viewer.deleted_at is null
         left join collaboration_receipt_states receipt
           on receipt.thread_id=thread.id and receipt.user_id=$2
        where thread.team_id=$1 and thread.scope='team' and thread.lifecycle='active'
          and thread.kind in ('team_channel','team_project_channel','dm','group_dm','workspace_channel')
          and (thread.kind <> 'team_project_channel' or exists (
            select 1 from collaboration_team_shared_projects project
             where project.id=thread.team_project_id and project.team_id=thread.team_id
               and project.unshared_at is null
          ))
          and (thread.kind <> 'workspace_channel' or exists (
            select 1 from team_workspaces workspace
             join team_workspace_access_grants access
               on access.team_workspace_id=workspace.id and access.team_id=workspace.team_id
              and access.user_id=$2 and access.disabled_at is null
              and access.access in ('read','write')
             where workspace.id=thread.team_workspace_id and workspace.team_id=thread.team_id
               and workspace.lifecycle='active' and workspace.archived_at is null
          ))
          and (thread.kind not in ('dm','group_dm') or exists (
            select 1 from collaboration_participants participant
             where participant.thread_id=thread.id and participant.team_id=thread.team_id
               and participant.user_id=$2
          ))
        order by thread.last_activity_at desc,thread.id`,
      [teamId, actor.userId, teamName]
    );
    return result.rows;
  };

  const listUnreadMessagesWithClient = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    thread: ThreadRow,
    input?: { messageId?: string }
  ): Promise<MessageRow[]> => {
    const result = await client.query<MessageRow>(
      `select message.id,message.thread_id,message.team_id,message.team_workspace_id,
              message.root_message_id,message.thread_sequence,message.version,
              message.sender_kind,message.sender_user_id,message.created_at,message.updated_at,
              root.sender_user_id as root_sender_user_id,
              case when thread.kind in ('dm','group_dm') then
                message.thread_sequence>coalesce(thread_receipt.last_read_sequence,0)
              when message.root_message_id is null then
                message.thread_sequence>coalesce(thread_receipt.last_read_sequence,0)
              else message.thread_sequence>coalesce(root_receipt.last_read_sequence,0)
              end as is_unread,
              (message.root_message_id is not null and root.sender_user_id=$2) as is_reply_to_viewer_root
         from collaboration_messages message
         join collaboration_threads thread on thread.id=message.thread_id
           and thread.team_id=message.team_id and thread.scope='team'
           and thread.lifecycle='active'
         join team_memberships membership on membership.team_id=thread.team_id
           and membership.user_id=$2 and membership.status='enabled'
           and membership.disabled_at is null
         join teams active_team on active_team.id=thread.team_id
           and active_team.lifecycle='active'
           and active_team.entitlement_status in ('active','grace')
         join users viewer on viewer.id=$2 and viewer.disabled_at is null
           and viewer.deleted_at is null
         left join collaboration_messages root on root.id=message.root_message_id
           and root.thread_id=message.thread_id and root.root_message_id is null
         left join collaboration_receipt_states thread_receipt
           on thread_receipt.thread_id=thread.id and thread_receipt.user_id=$2
         left join collaboration_root_receipt_states root_receipt
           on root_receipt.root_message_id=message.root_message_id and root_receipt.user_id=$2
        where message.thread_id=$1 and message.sender_kind='user'
          and message.sender_user_id is not null and message.sender_user_id<>$2
          and ($3::uuid is null or message.id=$3::uuid)
          and (thread.kind not in ('dm','group_dm') or exists (
            select 1 from collaboration_participants participant
             where participant.thread_id=thread.id and participant.team_id=thread.team_id
               and participant.user_id=$2
          ))
          and (thread.kind <> 'team_project_channel' or exists (
            select 1 from collaboration_team_shared_projects project
             where project.id=thread.team_project_id and project.team_id=thread.team_id
               and project.unshared_at is null
          ))
          and (thread.kind <> 'workspace_channel' or exists (
            select 1 from team_workspaces workspace
             join team_workspace_access_grants access
               on access.team_workspace_id=workspace.id and access.team_id=workspace.team_id
              and access.user_id=$2 and access.disabled_at is null
              and access.access in ('read','write')
             where workspace.id=thread.team_workspace_id and workspace.team_id=thread.team_id
               and workspace.lifecycle='active' and workspace.archived_at is null
          ))
          and case when thread.kind in ('dm','group_dm') then
            message.thread_sequence>coalesce(thread_receipt.last_read_sequence,0)
          when message.root_message_id is null then
            message.thread_sequence>coalesce(thread_receipt.last_read_sequence,0)
          else message.thread_sequence>coalesce(root_receipt.last_read_sequence,0)
          end
        order by message.thread_sequence,message.id`,
      [thread.id, actor.userId, input?.messageId ?? null]
    );
    return result.rows;
  };

  const decryptMessage = async (
    client: pg.Pool | pg.PoolClient,
    row: MessageRow
  ): Promise<Pick<MessageRow, "body_text" | "mention_user_ids">> => {
    if (!teamProvider) {
      throw Object.assign(
        new Error("Team overview encryption is unavailable"),
        {
          statusCode: 503
        }
      );
    }
    const body = await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
      client,
      teamProvider,
      {
        sourceTable: "collaboration_messages",
        sourceId: row.id,
        sourceColumn: "body",
        teamId: row.team_id,
        teamWorkspaceId: row.team_workspace_id
      }
    );
    const metadata =
      await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
        client,
        teamProvider,
        {
          sourceTable: "collaboration_messages",
          sourceId: row.id,
          sourceColumn: "metadata",
          teamId: row.team_id,
          teamWorkspaceId: row.team_workspace_id
        }
      );
    if (
      typeof body !== "string" ||
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata)
    ) {
      throw new Error("Authorized Team message fields are unavailable");
    }
    const mentionUserIds = (metadata as { mentionUserIds?: unknown })
      .mentionUserIds;
    return {
      body_text: body,
      mention_user_ids: Array.isArray(mentionUserIds)
        ? mentionUserIds.filter((id): id is string => typeof id === "string")
        : []
    };
  };

  const decryptThreadName = async (
    client: pg.Pool | pg.PoolClient,
    thread: ThreadRow
  ): Promise<string> => {
    if (!teamProvider) return "Team channel";
    const name = await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
      client,
      teamProvider,
      {
        sourceTable: "collaboration_threads",
        sourceId: thread.id,
        sourceColumn: "name",
        teamId: thread.team_id,
        teamWorkspaceId: thread.team_workspace_id
      }
    );
    return typeof name === "string" && name.trim()
      ? name.trim()
      : "Team channel";
  };

  const listMessageItemsForTeam = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    team: TeamRow,
    only?: Omit<TeamOverviewSourceRef, "sourceRevision">
  ): Promise<TeamOverviewSourceSnapshot> => {
    const attention: TeamOverviewItem[] = [];
    const catchUp: TeamOverviewItem[] = [];
    if (only && only.source !== "message_attention")
      return { attention, catchUp };
    const threads = await listThreadsWithClient(
      client,
      actor,
      team.team_id,
      team.team_name
    );
    const targetThreadId =
      only?.sourceEventId.startsWith("catch-up:") ||
      only?.sourceEventId.startsWith("dm:")
        ? only.sourceId
        : undefined;
    for (const thread of threads) {
      if (targetThreadId && thread.id !== targetThreadId) continue;
      const rows = await listUnreadMessagesWithClient(client, actor, thread);
      const unread: MessageRow[] = [];
      for (const row of rows) {
        const fields = await decryptMessage(client, row);
        row.body_text = fields.body_text;
        row.mention_user_ids = fields.mention_user_ids;
        unread.push(row);
      }
      const direct = thread.kind === "dm" || thread.kind === "group_dm";
      const relevant = direct
        ? unread
        : unread.filter(
            (message) =>
              message.mention_user_ids?.includes(actor.userId) ||
              message.is_reply_to_viewer_root
          );
      const ordinary = direct
        ? []
        : unread.filter(
            (message) =>
              !message.mention_user_ids?.includes(actor.userId) &&
              !message.is_reply_to_viewer_root
          );
      const title = await decryptThreadName(client, thread);
      const groups = new Map<string, MessageRow[]>();
      for (const message of relevant) {
        const groupId = direct
          ? thread.id
          : (message.root_message_id ?? message.id);
        groups.set(groupId, [...(groups.get(groupId) ?? []), message]);
      }
      for (const [groupId, messages] of groups) {
        const latest = messages.at(-1)!;
        const sourceEventId = direct
          ? `dm:${thread.id}`
          : `message-root:${groupId}`;
        if (
          only &&
          (only.sourceEventId !== sourceEventId || only.sourceId !== groupId)
        ) {
          continue;
        }
        attention.push({
          sourceEventId,
          source: "message_attention",
          sourceId: groupId,
          sourceRevision: `g${digest(
            messages.map((message) => ({
              id: message.id,
              sequence: message.thread_sequence,
              version: message.version
            }))
          )}`,
          teamId: team.team_id,
          teamName: team.team_name,
          kind: "message",
          priority: "attention",
          state: "recent",
          title: direct
            ? "Unread direct message"
            : "Message needs your attention",
          summary: latest.body_text!.slice(0, 1000),
          updatedAt: latest.updated_at.toISOString(),
          unreadCount: messages.length,
          destination: {
            kind: "thread",
            threadId: thread.id,
            rootMessageId: direct ? null : groupId
          }
        });
      }
      if (direct) continue;
      if (only && only.sourceEventId !== `catch-up:${thread.id}`) continue;
      const attentionRoots = new Set(groups.keys());
      const catchUpMessages = ordinary.filter(
        (message) => !attentionRoots.has(message.root_message_id ?? message.id)
      );
      if (catchUpMessages.length > 0) {
        const latest = catchUpMessages.at(-1)!;
        catchUp.push({
          sourceEventId: `catch-up:${thread.id}`,
          source: "message_attention",
          sourceId: thread.id,
          sourceRevision: `c${digest(
            catchUpMessages.map((message) => ({
              id: message.id,
              sequence: message.thread_sequence,
              version: message.version
            }))
          )}`,
          teamId: team.team_id,
          teamName: team.team_name,
          kind: "message",
          priority: "attention",
          state: "recent",
          title,
          summary: latest.body_text!.slice(0, 1000),
          updatedAt: latest.updated_at.toISOString(),
          unreadCount: catchUpMessages.length,
          destination: {
            kind: "thread",
            threadId: thread.id,
            rootMessageId: null
          }
        });
      }
    }
    return { attention, catchUp };
  };

  const listRequestItemsForTeam = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    team: TeamRow,
    only?: Omit<TeamOverviewSourceRef, "sourceRevision">
  ): Promise<TeamOverviewItem[]> => {
    if (
      only &&
      (only.source !== "agent_request" ||
        only.sourceEventId !== `request:${only.sourceId}`)
    )
      return [];
    const result = await client.query<RequestRow>(
      `select request.id,request.team_id,$3::text as team_name,request.team_project_id,
              request.channel_id,request.request_message_id,
              source_message.root_message_id,request.requester_user_id,
              coalesce(nullif(trim(requester.display_name),''),'Team member') as requester_name,
              request.owner_user_id,request.agent_name,request.version,
              request.created_at,request.updated_at
         from team_agent_requests request
         join users requester on requester.id=request.requester_user_id
           and requester.disabled_at is null and requester.deleted_at is null
         join team_memberships requester_membership on requester_membership.team_id=request.team_id
           and requester_membership.user_id=request.requester_user_id
           and requester_membership.status='enabled' and requester_membership.disabled_at is null
         join users owner on owner.id=request.owner_user_id
         join team_agent_offers offer on offer.team_id=request.team_id
           and offer.owner_user_id=request.owner_user_id and offer.agent_id=request.agent_id
           and offer.enabled=true
         join personal_agent_identities identity on identity.id=request.agent_id
           and identity.owner_user_id=request.owner_user_id and identity.lifecycle='active'
         join collaboration_team_shared_projects project on project.id=request.team_project_id
           and project.team_id=request.team_id and project.unshared_at is null
         join collaboration_threads thread on thread.id=request.channel_id
           and thread.team_id=request.team_id and thread.lifecycle='active'
           and thread.kind in ('team_channel','team_project_channel')
           and (thread.kind='team_channel' or thread.team_project_id=request.team_project_id)
         join collaboration_messages source_message on source_message.id=request.request_message_id
           and source_message.thread_id=request.channel_id
        where request.team_id=$1 and request.owner_user_id=$2
          and request.status='awaiting_owner'
          and ($4::uuid is null or request.id=$4)
          and exists (select 1 from team_memberships membership
                       join teams active_team on active_team.id=membership.team_id
                       where membership.team_id=request.team_id and membership.user_id=$2
                         and membership.status='enabled' and membership.disabled_at is null
                         and active_team.lifecycle='active'
                         and active_team.entitlement_status in ('active','grace'))
        order by request.created_at desc,request.id desc`,
      [team.team_id, actor.userId, team.team_name, only?.sourceId ?? null]
    );
    return result.rows.map((row) => ({
      sourceEventId: `request:${row.id}`,
      source: "agent_request",
      sourceId: row.id,
      sourceRevision: `r${row.version}`,
      teamId: row.team_id,
      teamName: row.team_name,
      kind: "agent_request",
      priority: "attention",
      state: "recent",
      title: "Agent request needs review",
      summary: `${row.requester_name} requested ${row.agent_name}`,
      updatedAt: row.updated_at.toISOString(),
      destination: {
        kind: "agent_request",
        requestId: row.id,
        threadId: row.channel_id,
        rootMessageId: row.root_message_id
      }
    }));
  };

  const listPublicationsWithClient = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    team: TeamRow,
    only?: Omit<TeamOverviewSourceRef, "sourceRevision">
  ): Promise<PublicationRow[]> => {
    const jobOnly =
      only?.source === "team_job_action" || only?.source === "team_job_outcome";
    const eventIdMatches =
      !only ||
      (jobOnly &&
        (only.sourceEventId === `job-action:${only.sourceId}` ||
          only.sourceEventId === `job-outcome:${only.sourceId}`));
    if (only && (!jobOnly || !eventIdMatches)) return [];
    const result = await client.query<PublicationRow>(
      `select publication.id,publication.team_id,$3::text as team_name,
              publication.team_project_id,publication.job_id,publication.owner_user_id,
              coalesce(nullif(trim(owner.display_name),''),'Team member') as owner_name,
              coalesce(identity_version.name,'Agent') as agent_name,
              coalesce(thread_name.id::text,'') as project_thread_id,
              thread_name.team_workspace_id as project_team_workspace_id,
              'Project'::text as project_name,
              publication.state as publication_state,
              case when publication.state='active' then publication.version else 0 end as publication_version,
              case when publication.state='active' then job.state
                   else coalesce(publication.frozen_status,publication.last_known_status,'unknown') end as job_state,
              case when publication.state='active' then job.version else 0 end as job_version,
              case when publication.state='active' then job.updated_at
                   else coalesce(publication.frozen_updated_at,publication.published_at) end as job_updated_at,
              case when publication.state='active' then execution.state_version else 0 end as execution_state_version,
              case when publication.state='active' then execution.state else 'frozen' end as execution_state,
              case when publication.state='active' then execution.updated_at
                   else coalesce(publication.frozen_updated_at,publication.published_at) end as execution_updated_at,
              publication.frozen_status,publication.frozen_updated_at,
              publication.frozen_completed_at,
              case when publication.state='active' then publication.completed_at
                   else publication.frozen_completed_at end as completed_at,
              publication.published_at,
              case when publication.state='active' then job.conversation_id else null end as conversation_id,
              coalesce(blockers.items,'[]'::jsonb) as current_blockers
         from personal_agent_team_job_publications publication
         join personal_agent_execution_jobs job on job.id=publication.job_id
           and job.owner_user_id=publication.owner_user_id
         join managed_conversation_executions execution on execution.id=job.conversation_id
           and execution.owner_user_id=job.owner_user_id
         join personal_agent_identity_versions identity_version on identity_version.agent_id=job.agent_id
           and identity_version.owner_user_id=job.owner_user_id and identity_version.version=job.agent_version
         join users owner on owner.id=publication.owner_user_id
         join collaboration_team_shared_projects project on project.id=publication.team_project_id
           and project.team_id=publication.team_id and project.unshared_at is null
         join collaboration_threads project_thread on project_thread.team_project_id=project.id
           and project_thread.team_id=project.team_id and project_thread.lifecycle='active'
           and project_thread.kind='team_project_channel'
         left join lateral (
           select candidate.id,candidate.team_workspace_id
             from collaboration_threads candidate
            where candidate.team_project_id=project.id
              and candidate.team_id=project.team_id
              and candidate.kind='team_project_channel'
              and candidate.lifecycle='active'
            order by candidate.id limit 1
         ) thread_name on true
         left join lateral (
           select coalesce(jsonb_agg(jsonb_build_object('id',item.id,'revision',item.revision,'itemKind',item.item_kind)
                                     order by item.id),'[]'::jsonb) as items
             from managed_conversation_runtime_items item
            where publication.state='active'
              and item.owner_user_id=job.owner_user_id and item.execution_id=job.conversation_id
              and item.execution_generation=execution.execution_generation and item.state='pending'
              and item.item_kind in ('command_approval','file_approval','permissions_approval','user_input')
         ) blockers on true
        where publication.team_id=$1 and publication.state in ('active','frozen')
          and publication.owner_user_id=job.owner_user_id
          and ($4::uuid is null or publication.id=$4)
          and exists (select 1 from team_memberships membership
                       join teams active_team on active_team.id=membership.team_id
                       where membership.team_id=publication.team_id and membership.user_id=$2
                         and membership.status='enabled' and membership.disabled_at is null
                         and active_team.lifecycle='active'
                         and active_team.entitlement_status in ('active','grace'))
        order by publication.published_at desc,publication.id desc`,
      [team.team_id, actor.userId, team.team_name, only?.sourceId ?? null]
    );
    for (const row of result.rows) {
      if (!row.project_thread_id || !teamProvider) continue;
      const projectName =
        await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
          client,
          teamProvider!,
          {
            sourceTable: "collaboration_threads",
            sourceId: row.project_thread_id,
            sourceColumn: "name",
            teamId: row.team_id,
            teamWorkspaceId: row.project_team_workspace_id
          }
        );
      if (typeof projectName === "string" && projectName.trim())
        row.project_name = projectName;
    }
    return result.rows;
  };

  const projectionStatus = (row: PublicationRow): string => {
    if (row.publication_state === "frozen")
      return row.frozen_status ?? row.job_state;
    if (
      ["queued", "running"].includes(row.job_state) &&
      row.execution_state === "failed"
    )
      return "failed";
    if (
      ["queued", "running"].includes(row.job_state) &&
      row.execution_state === "fenced"
    )
      return "uncertain";
    if (
      ["queued", "running"].includes(row.job_state) &&
      row.current_blockers.length > 0
    )
      return "waiting";
    return row.job_state;
  };

  const publicationSourceRevision = (
    row: PublicationRow,
    status: string
  ): string => {
    if (row.publication_state === "frozen") {
      return `f${row.frozen_status ?? status}.${row.frozen_completed_at?.getTime() ?? 0}.${row.frozen_updated_at?.getTime() ?? 0}`;
    }
    if (status === "waiting") {
      const blockers = [...row.current_blockers].sort((a, b) =>
        a.id.localeCompare(b.id)
      );
      return `w${digest({ status, blockers })}`;
    }
    if (
      status === "failed" &&
      ["failed", "fenced"].includes(row.execution_state)
    ) {
      return `e${row.execution_state_version}.${status}`;
    }
    if (status === "uncertain")
      return `e${row.execution_state_version}.uncertain`;
    return `j${row.job_version}.${status}.${row.completed_at?.getTime() ?? 0}`;
  };

  const listJobItemsForTeam = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    team: TeamRow,
    only?: Omit<TeamOverviewSourceRef, "sourceRevision">
  ): Promise<TeamOverviewSourceSnapshot> => {
    const attention: TeamOverviewItem[] = [];
    const catchUp: TeamOverviewItem[] = [];
    const publications = await listPublicationsWithClient(
      client,
      actor,
      team,
      only
    );
    const prActions = await listPullRequestActionsForTeam(
      client,
      actor,
      team,
      only?.source === "pull_request_action" ? only : undefined
    );
    const prJobs = new Set(prActions.map((action) => action.linkedJobId));
    for (const publication of publications) {
      const status = projectionStatus(publication);
      const sourceRevision = publicationSourceRevision(publication, status);
      const hasLinkedPrAction = prJobs.has(publication.job_id);
      const ownerNeedsAction =
        status === "waiting"
          ? publication.current_blockers.length > 0
          : status === "failed" || status === "uncertain";
      if (
        actor.userId === publication.owner_user_id &&
        ownerNeedsAction &&
        !hasLinkedPrAction
      ) {
        const blockers = [...publication.current_blockers].sort((a, b) =>
          a.id.localeCompare(b.id)
        );
        const blockerRevision =
          status === "waiting"
            ? `w${digest({ status, blockers })}`
            : sourceRevision;
        attention.push({
          sourceEventId: `job-action:${publication.id}`,
          source: "team_job_action",
          sourceId: publication.id,
          sourceRevision: blockerRevision,
          teamId: publication.team_id,
          teamName: publication.team_name,
          kind: "job_action",
          priority: status === "waiting" ? "blocker" : "attention",
          state: status === "waiting" ? "blocked" : "recent",
          title:
            status === "failed"
              ? "Published Agent Job failed"
              : status === "uncertain"
                ? "Published Agent Job outcome is uncertain"
                : "Published Agent Job needs your action",
          summary: `${publication.agent_name} · ${publication.project_name}`,
          updatedAt: (publication.publication_state === "frozen"
            ? (publication.frozen_updated_at ?? publication.published_at)
            : status === "failed" || status === "uncertain"
              ? publication.execution_updated_at
              : publication.job_updated_at
          ).toISOString(),
          destination: {
            kind: "team_job",
            publicationId: publication.id,
            jobId: publication.job_id,
            teamProjectId: publication.team_project_id
          }
        });
      }
      if (
        status === "succeeded" ||
        status === "failed" ||
        status === "uncertain"
      ) {
        if (
          !(
            actor.userId === publication.owner_user_id &&
            (status === "failed" || status === "uncertain" || hasLinkedPrAction)
          )
        ) {
          catchUp.push({
            sourceEventId: `job-outcome:${publication.id}`,
            source: "team_job_outcome",
            sourceId: publication.id,
            sourceRevision,
            teamId: publication.team_id,
            teamName: publication.team_name,
            kind: "job_outcome",
            priority: "attention",
            state: "recent",
            title:
              status === "failed"
                ? "Published Agent Job failed"
                : status === "uncertain"
                  ? "Published Agent Job outcome is uncertain"
                  : "Published Agent Job completed",
            summary: `${publication.agent_name} · ${publication.project_name}`,
            updatedAt:
              publication.publication_state === "frozen"
                ? (
                    publication.frozen_completed_at ??
                    publication.frozen_updated_at ??
                    publication.published_at
                  ).toISOString()
                : (
                    publication.completed_at ??
                    (status === "uncertain" ||
                    publication.execution_state === "failed" ||
                    publication.execution_state === "fenced"
                      ? publication.execution_updated_at
                      : publication.job_updated_at)
                  ).toISOString(),
            destination: {
              kind: "team_job",
              publicationId: publication.id,
              jobId: publication.job_id,
              teamProjectId: publication.team_project_id
            }
          });
        }
      }
    }
    attention.push(...prActions.map((action) => action.item));
    return { attention, catchUp };
  };

  const listPullRequestActionsForTeam = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    team: TeamRow,
    only?: Omit<TeamOverviewSourceRef, "sourceRevision">
  ): Promise<PullRequestActionProjection[]> => {
    if (
      only &&
      (only.source !== "pull_request_action" ||
        (!only.sourceEventId.startsWith("pr:") &&
          !only.sourceEventId.startsWith("pr-op:")))
    )
      return [];
    const reviewId = only?.sourceEventId.startsWith("pr:")
      ? only.sourceId
      : null;
    const operationId = only?.sourceEventId.startsWith("pr-op:")
      ? only.sourceId
      : null;
    const result = await client.query<PullRequestActionRow>(
      `select publication.team_id,$3::text as team_name,publication.id as publication_id,
              publication.job_id,publication.team_project_id,review.id as review_id,
              review.repository_id,review.pull_request_number,review.status as review_status,
              review.revision as review_revision,review.updated_at as review_updated_at,
              operation.id as operation_id,operation.state as operation_state,
              operation.revision as operation_revision,operation.updated_at as operation_updated_at,
              job.state as job_state
         from personal_agent_team_job_publications publication
         join personal_agent_execution_jobs job on job.id=publication.job_id
           and job.owner_user_id=publication.owner_user_id
         join collaboration_team_shared_projects project on project.id=publication.team_project_id
           and project.team_id=publication.team_id and project.unshared_at is null
         join collaboration_threads project_thread on project_thread.team_project_id=project.id
           and project_thread.team_id=project.team_id and project_thread.lifecycle='active'
           and project_thread.kind='team_project_channel'
         join pull_request_review_drafts draft on draft.agent_job_id=job.id
           and draft.owner_user_id=job.owner_user_id and draft.origin='agent'
         join pull_request_reviews review on review.id=draft.review_id
           and review.owner_user_id=draft.owner_user_id
         left join pull_request_operations operation on operation.review_id=review.id
           and operation.owner_user_id=review.owner_user_id and operation.kind='push'
           and operation.state in ('failed','uncertain')
        where publication.team_id=$1 and publication.owner_user_id=$2
          and publication.state='active'
          and review.owner_user_id=$2
          and (review.status in ('stale','frozen','uncertain','failed')
               or (review.status='draft' and job.state='succeeded')
               or operation.id is not null)
          and ($4::uuid is null or review.id=$4)
          and ($5::uuid is null or operation.id=$5)
          and exists (select 1 from team_memberships membership
                       join teams active_team on active_team.id=membership.team_id
                       where membership.team_id=publication.team_id and membership.user_id=$2
                         and membership.status='enabled' and membership.disabled_at is null
                         and active_team.lifecycle='active'
                         and active_team.entitlement_status in ('active','grace'))
        order by review.updated_at desc,review.id,operation.updated_at desc`,
      [team.team_id, actor.userId, team.team_name, reviewId, operationId]
    );
    const projections = result.rows.flatMap((row) => {
      const reviewActionable =
        ["stale", "frozen", "uncertain", "failed"].includes(
          row.review_status
        ) ||
        (row.review_status === "draft" && row.job_state === "succeeded");
      const reviewItem: TeamOverviewItem = {
        sourceEventId: `pr:${row.review_id}`,
        source: "pull_request_action",
        sourceId: row.review_id,
        sourceRevision: `r${row.review_revision}.${row.review_status}`,
        teamId: row.team_id,
        teamName: row.team_name,
        kind: "pull_request_action",
        priority:
          row.review_status === "failed" || row.review_status === "uncertain"
            ? "blocker"
            : "attention",
        state:
          row.review_status === "failed" || row.review_status === "uncertain"
            ? "blocked"
            : "recent",
        title: `${row.repository_id} #${row.pull_request_number} ${row.review_status === "frozen" ? "ready to publish" : row.review_status === "failed" || row.review_status === "uncertain" ? "needs attention" : "review needs attention"}`,
        summary: null,
        updatedAt: row.review_updated_at.toISOString(),
        destination: {
          kind: "pull_request_review",
          reviewId: row.review_id,
          repositoryId: row.repository_id,
          number: row.pull_request_number
        }
      };
      if (!row.operation_id) {
        return reviewActionable
          ? [{ item: reviewItem, linkedJobId: row.job_id }]
          : [];
      }
      const operationItem: TeamOverviewItem = {
        sourceEventId: `pr-op:${row.operation_id}`,
        source: "pull_request_action",
        sourceId: row.operation_id,
        sourceRevision: `r${row.review_revision}.o${row.operation_revision}.${row.operation_state}`,
        teamId: row.team_id,
        teamName: row.team_name,
        kind: "pull_request_action",
        priority: "blocker",
        state: "blocked",
        title: `${row.repository_id} #${row.pull_request_number} push needs attention`,
        summary: null,
        updatedAt:
          row.operation_updated_at?.toISOString() ??
          row.review_updated_at.toISOString(),
        destination: reviewItem.destination
      };
      if (reviewId)
        return reviewActionable
          ? [{ item: reviewItem, linkedJobId: row.job_id }]
          : [];
      if (operationId)
        return [{ item: operationItem, linkedJobId: row.job_id }];
      return [
        ...(reviewActionable
          ? [{ item: reviewItem, linkedJobId: row.job_id }]
          : []),
        { item: operationItem, linkedJobId: row.job_id }
      ];
    });
    const seen = new Set<string>();
    return projections.filter(({ item }) => {
      const key = `${item.sourceEventId}\u0000${item.sourceRevision}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const loadTeamItemsWithClient = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    only?: Omit<TeamOverviewSourceRef, "sourceRevision">
  ): Promise<TeamOverviewSourceSnapshot> => {
    const teams = await listTeamsWithClient(
      client,
      actor,
      only ? [only.teamId] : undefined
    );
    const attention: TeamOverviewItem[] = [];
    const catchUp: TeamOverviewItem[] = [];
    for (const team of teams) {
      const messages = await listMessageItemsForTeam(client, actor, team, only);
      const requests = await listRequestItemsForTeam(client, actor, team, only);
      const jobs = await listJobItemsForTeam(client, actor, team, only);
      attention.push(...messages.attention, ...requests, ...jobs.attention);
      catchUp.push(...messages.catchUp, ...jobs.catchUp);
    }
    return { attention, catchUp };
  };

  const repository: TeamOverviewSourcesRepository = {
    async listCurrentItems(actor, teams) {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        const teamIds = teams?.map((team) => team.teamId);
        const authorized = await listTeamsWithClient(client, actor, teamIds);
        const attention: TeamOverviewItem[] = [];
        const catchUp: TeamOverviewItem[] = [];
        for (const team of authorized) {
          const messages = await listMessageItemsForTeam(client, actor, team);
          const requests = await listRequestItemsForTeam(client, actor, team);
          const jobs = await listJobItemsForTeam(client, actor, team);
          attention.push(...messages.attention, ...requests, ...jobs.attention);
          catchUp.push(...messages.catchUp, ...jobs.catchUp);
        }
        await client.query("commit");
        return { attention, catchUp };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async getCurrentSourceWithClient(client, actor, input) {
      const snapshot = await loadTeamItemsWithClient(client, actor, input);
      return (
        [...snapshot.attention, ...snapshot.catchUp]
          .map(itemRef)
          .find(
            (ref) =>
              ref.teamId === input.teamId &&
              ref.source === input.source &&
              ref.sourceEventId === input.sourceEventId &&
              ref.sourceId === input.sourceId
          ) ?? null
      );
    },
    async validateCurrentSourceWithClient(client, actor, input) {
      const current = await repository.getCurrentSourceWithClient(
        client,
        actor,
        input
      );
      return current !== null && sameRef(current, input);
    }
  };
  return repository;
};
