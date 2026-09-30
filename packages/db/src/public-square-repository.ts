import pg from "pg";
import {
  decryptEnvelopeToUtf8,
  type EnvelopeEncryptionProvider,
  type EncryptedPayloadEnvelope
} from "@koed/shared";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  decryptTeamEncryptedFieldAfterAuthorizationWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import type { ActorContext } from "./types.js";

export type PublicSquareStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted"
  | "offline";

export interface PublicSquarePublicationRecord {
  id: string;
  jobId: string;
  agentId: string;
  agentName: string;
  ownerId: string;
  ownerName: string;
  projectId: string;
  projectName: string;
  status: PublicSquareStatus;
  lastKnownStatus: PublicSquareStatus | null;
  publishedAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastSeenAt: string | null;
  ownerLeftTeam: boolean;
  sharedBrief: string | null;
  version: number;
  canEditBrief: boolean;
  canRemoveRetainedBrief: boolean;
}

export interface PublicSquareRepository {
  listPublicSquare(
    actor: ActorContext,
    input: { teamId: string; limit: number; cursor?: string }
  ): Promise<{
    teamId: string;
    items: PublicSquarePublicationRecord[];
    nextCursor: string | null;
    serverTime: string;
  } | null>;
  getPublicSquareConnection(
    actor: ActorContext,
    input: { teamId: string; teamProjectId: string }
  ): Promise<{
    teamId: string;
    teamProjectId: string;
    localProjectId: string | null;
    connectedAt: string | null;
    version: number;
  } | null>;
  setPublicSquareConnection(
    actor: ActorContext,
    input: {
      teamId: string;
      teamProjectId: string;
      expectedVersion: number;
      localProjectId: string | null;
    }
  ): Promise<{
    teamId: string;
    teamProjectId: string;
    localProjectId: string | null;
    connectedAt: string | null;
    version: number;
  } | null>;
  getPublicSquareBriefDraft(
    actor: ActorContext,
    input: { teamId: string; publicationId: string }
  ): Promise<{
    publicationId: string;
    briefDraft: string;
    version: number;
  } | null>;
  updatePublicSquareBrief(
    actor: ActorContext,
    input: {
      teamId: string;
      publicationId: string;
      expectedVersion: number;
      brief: string | null;
    }
  ): Promise<PublicSquarePublicationRecord | null>;
  unsharePublicSquareProject(
    actor: ActorContext,
    input: { teamId: string; teamProjectId: string }
  ): Promise<boolean>;
}

type PublicationRow = {
  id: string;
  job_id: string;
  agent_id: string;
  agent_name: string;
  owner_id: string;
  owner_name: string;
  project_id: string;
  project_thread_id: string;
  job_state: string;
  publication_state: string;
  owner_left_team: boolean;
  job_updated_at: Date;
  published_at: Date;
  runner_last_seen_at: Date | null;
  runner_lease_expires_at: Date | null;
  completed_at: Date | null;
  version: number;
  sort_rank: number;
};

const validStatus = (status: string): PublicSquareStatus =>
  [
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "canceled",
    "interrupted"
  ].includes(status)
    ? (status as PublicSquareStatus)
    : "interrupted";

export const createPublicSquareRepository = (
  pool: pg.Pool,
  options: {
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
    teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  }
): PublicSquareRepository => {
  const personalProvider = () => {
    if (!options.envelopeEncryptionProvider)
      throw new Error(
        "Envelope encryption provider is required for Public Square"
      );
    return options.envelopeEncryptionProvider;
  };
  const teamProvider = () => {
    const provider =
      options.teamEnvelopeEncryptionProvider ??
      options.envelopeEncryptionProvider;
    if (!provider)
      throw new Error(
        "Team envelope encryption provider is required for Public Square"
      );
    return provider;
  };
  const activeMember = async (
    client: pg.Pool | pg.PoolClient,
    userId: string,
    teamId: string
  ) => {
    const result = await client.query(
      `select 1 from team_memberships where user_id=$1 and team_id=$2 and status='enabled' for share`,
      [userId, teamId]
    );
    return result.rowCount === 1;
  };
  const authorizePublication = async (
    client: pg.Pool | pg.PoolClient,
    userId: string,
    publicationId: string
  ) => {
    const result = await client.query<{
      team_id: string;
      owner_user_id: string;
      state: string;
      owner_left_team: boolean;
    }>(
      `select team_id, owner_user_id, state, owner_left_team from personal_agent_team_job_publications where id=$1`,
      [publicationId]
    );
    const row = result.rows[0];
    return row && (await activeMember(client, userId, row.team_id))
      ? row
      : null;
  };
  const mapPublication = async (
    client: pg.Pool | pg.PoolClient,
    row: PublicationRow,
    viewerId: string,
    teamId: string
  ): Promise<PublicSquarePublicationRecord> => {
    const actual = validStatus(row.job_state);
    const offline =
      row.publication_state === "active" &&
      (actual === "running" || actual === "waiting") &&
      (!row.runner_lease_expires_at ||
        row.runner_lease_expires_at.getTime() <= Date.now());
    const status: PublicSquareStatus = offline ? "offline" : actual;
    const sharedBrief =
      row.publication_state === "revoked"
        ? null
        : ((await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
            client,
            teamProvider(),
            {
              sourceTable: "personal_agent_team_job_publications",
              sourceId: row.id,
              sourceColumn: "brief_team",
              teamId
            }
          )) as string | null);
    const projectNameValue =
      await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
        client,
        teamProvider(),
        {
          sourceTable: "collaboration_threads",
          sourceId: row.project_thread_id,
          sourceColumn: "name",
          teamId
        }
      );
    const projectName =
      typeof projectNameValue === "string" && projectNameValue.trim()
        ? projectNameValue
        : "Project";
    return {
      id: row.id,
      jobId: row.job_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      projectId: row.project_id,
      projectName,
      status,
      lastKnownStatus: offline ? actual : null,
      publishedAt: row.published_at.toISOString(),
      updatedAt: row.job_updated_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      lastSeenAt: row.runner_last_seen_at?.toISOString() ?? null,
      ownerLeftTeam: row.owner_left_team,
      sharedBrief,
      version: row.version,
      canEditBrief:
        viewerId === row.owner_id &&
        !row.owner_left_team &&
        row.publication_state === "active",
      canRemoveRetainedBrief:
        row.owner_left_team &&
        row.publication_state === "frozen" &&
        (
          await client.query(
            `select 1 from team_memberships where team_id=$1 and user_id=$2 and status='enabled' and role in ('owner','admin') for share`,
            [teamId, viewerId]
          )
        ).rowCount === 1
    };
  };
  const publicationSelect = `select p.id,p.job_id,j.agent_id,coalesce(v.name,'Agent') as agent_name,p.owner_user_id as owner_id,coalesce(u.display_name,'Team member') as owner_name,p.team_project_id as project_id,t.id as project_thread_id,case when p.state='frozen' then coalesce(p.frozen_status,j.state) when j.state in ('queued','running') and e.state='failed' then 'failed' when j.state in ('queued','running') and exists(select 1 from managed_conversation_runtime_items r where r.execution_id=j.conversation_id and r.owner_user_id=j.owner_user_id and r.state='pending') then 'waiting' else j.state end as job_state,p.state as publication_state,p.owner_left_team,case when p.state='frozen' then coalesce(p.frozen_updated_at,p.updated_at) else j.updated_at end as job_updated_at,p.published_at,case when p.state='frozen' then p.frozen_last_seen_at else e.runner_last_seen_at end as runner_last_seen_at,e.runner_lease_expires_at,case when p.state='frozen' then p.frozen_completed_at when j.state in ('succeeded','failed','canceled') or (j.state in ('queued','running') and e.state='failed') then j.updated_at else p.completed_at end as completed_at,case when p.state='active' and j.state in ('queued','running') and e.state<>'failed' then 0 else 1 end as sort_rank,p.version from personal_agent_team_job_publications p join personal_agent_execution_jobs j on j.id=p.job_id and j.owner_user_id=p.owner_user_id join personal_agent_identity_versions v on v.agent_id=j.agent_id and v.owner_user_id=j.owner_user_id and v.version=j.agent_version join users u on u.id=p.owner_user_id join collaboration_team_shared_projects sp on sp.id=p.team_project_id and sp.team_id=p.team_id and sp.unshared_at is null join collaboration_threads t on t.team_project_id=sp.id and t.team_id=sp.team_id and t.lifecycle='active' join managed_conversation_executions e on e.id=j.conversation_id and e.owner_user_id=j.owner_user_id`;
  return {
    async listPublicSquare(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read");
        if (!(await activeMember(client, actor.userId, input.teamId))) {
          await client.query("rollback");
          return null;
        }
        const cursorParts = input.cursor
          ? Buffer.from(input.cursor, "base64url").toString("utf8").split("|")
          : [];
        const uuidPattern =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (
          input.cursor &&
          (cursorParts.length !== 3 ||
            !["0", "1"].includes(cursorParts[0] ?? "") ||
            !Number.isFinite(Date.parse(cursorParts[1] ?? "")) ||
            !uuidPattern.test(cursorParts[2] ?? "") ||
            Buffer.from(input.cursor, "base64url").toString("base64url") !==
              input.cursor)
        )
          throw Object.assign(new Error("Invalid Public Square cursor"), {
            statusCode: 400
          });
        const page = await client.query<PublicationRow>(
          `${publicationSelect} where p.team_id=$1 and p.state in ('active','frozen') and ($2::integer is null or (case when p.state='active' and j.state in ('queued','running') and e.state<>'failed' then 0 else 1 end > $2 or (case when p.state='active' and j.state in ('queued','running') and e.state<>'failed' then 0 else 1 end = $2 and (p.published_at,p.id)<($3::timestamptz,$4::uuid)))) order by sort_rank asc,p.published_at desc,p.id desc limit $5`,
          [
            input.teamId,
            cursorParts.length ? Number(cursorParts[0]) : null,
            cursorParts.length ? new Date(cursorParts[1]!) : null,
            cursorParts[2] ?? null,
            input.limit + 1
          ]
        );
        const hasMore = page.rows.length > input.limit;
        const rows = hasMore ? page.rows.slice(0, input.limit) : page.rows;
        const items = await Promise.all(
          rows.map((row) =>
            mapPublication(client, row, actor.userId, input.teamId)
          )
        );
        const last = rows.at(-1);
        const result = {
          teamId: input.teamId,
          items,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  `${last.sort_rank}|${last.published_at.toISOString()}|${last.id}`
                ).toString("base64url")
              : null,
          serverTime: new Date().toISOString()
        };
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getPublicSquareConnection(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read");
        if (!(await activeMember(client, actor.userId, input.teamId))) {
          await client.query("rollback");
          return null;
        }
        const exists = await client.query(
          `select 1 from collaboration_team_shared_projects where id=$1 and team_id=$2 and unshared_at is null`,
          [input.teamProjectId, input.teamId]
        );
        if (!exists.rowCount) {
          await client.query("rollback");
          return null;
        }
        const result = await client.query<{
          local_project_id: string | null;
          connected_at: Date | null;
          version: number;
        }>(
          `select local_project_id,connected_at,version from public_square_project_connections where actor_user_id=$1 and team_project_id=$2`,
          [actor.userId, input.teamProjectId]
        );
        const row = result.rows[0];
        await client.query("commit");
        return {
          teamId: input.teamId,
          teamProjectId: input.teamProjectId,
          localProjectId: row?.local_project_id ?? null,
          connectedAt: row?.connected_at?.toISOString() ?? null,
          version: row?.version ?? 0
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async setPublicSquareConnection(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await activeMember(client, actor.userId, input.teamId))) {
          await client.query("rollback");
          return null;
        }
        const project = await client.query(
          `select id from collaboration_team_shared_projects where id=$1 and team_id=$2 and unshared_at is null for update`,
          [input.teamProjectId, input.teamId]
        );
        if (!project.rowCount) {
          await client.query("rollback");
          return null;
        }
        const previous = await client.query<{
          id: string;
          local_project_id: string | null;
          version: number;
        }>(
          `select id,local_project_id,version from public_square_project_connections where actor_user_id=$1 and team_project_id=$2 for update`,
          [actor.userId, input.teamProjectId]
        );
        const version = previous.rows[0]?.version ?? 0;
        if (version !== input.expectedVersion)
          throw Object.assign(new Error("Public Square connection changed"), {
            statusCode: 409
          });
        const previousLocalProjectId = previous.rows[0]?.local_project_id;
        if (
          previousLocalProjectId &&
          previousLocalProjectId !== input.localProjectId
        ) {
          await client.query(
            `update personal_agent_team_job_publications p set state='revoked',version=p.version+1,updated_at=now() from personal_agent_execution_jobs j join managed_conversation_executions e on e.id=j.conversation_id and e.owner_user_id=j.owner_user_id where p.job_id=j.id and p.connection_id=$1 and p.state='active' and j.state in ('queued','running') and e.state<>'failed'`,
            [previous.rows[0]!.id]
          );
        }
        const updated = await client.query<{
          version: number;
          connected_at: Date | null;
        }>(
          `insert into public_square_project_connections(actor_user_id,team_id,team_project_id,local_project_id,version,connected_at) values($1,$2,$3,$4,$5,case when $4::text is null then null else now() end) on conflict(actor_user_id,team_project_id) do update set local_project_id=excluded.local_project_id,version=excluded.version,connected_at=excluded.connected_at,updated_at=now() returning version,connected_at`,
          [
            actor.userId,
            input.teamId,
            input.teamProjectId,
            input.localProjectId,
            version + 1
          ]
        );
        if (input.localProjectId)
          await client.query(
            `insert into personal_agent_team_job_publications(team_id,team_project_id,owner_user_id,job_id,connection_id,last_known_status,last_seen_at,completed_at) select $1,$2,$3,j.id,c.id,j.state,e.runner_last_seen_at,case when j.state in ('succeeded','failed','canceled') then j.updated_at else null end from personal_agent_execution_jobs j join managed_conversation_executions e on e.id=j.conversation_id and e.owner_user_id=j.owner_user_id and e.state<>'failed' join public_square_project_connections c on c.actor_user_id=$3 and c.team_project_id=$2 where j.owner_user_id=$3 and j.project_id=$4 and j.state in ('queued','running') on conflict(connection_id,job_id) do nothing`,
            [
              input.teamId,
              input.teamProjectId,
              actor.userId,
              input.localProjectId
            ]
          );
        else
          await client.query(
            `update personal_agent_team_job_publications p set state='revoked',version=p.version+1,updated_at=now() from personal_agent_execution_jobs j join managed_conversation_executions e on e.id=j.conversation_id and e.owner_user_id=j.owner_user_id where p.job_id=j.id and p.connection_id in (select id from public_square_project_connections where actor_user_id=$1 and team_project_id=$2) and p.state='active' and j.state in ('queued','running') and e.state<>'failed'`,
            [actor.userId, input.teamProjectId]
          );
        await client.query("commit");
        return {
          teamId: input.teamId,
          teamProjectId: input.teamProjectId,
          localProjectId: input.localProjectId,
          connectedAt: updated.rows[0]?.connected_at?.toISOString() ?? null,
          version: updated.rows[0]?.version ?? version + 1
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getPublicSquareBriefDraft(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read");
        const membership = await client.query(
          `select 1 from team_memberships where user_id=$1 and team_id=$2 and status='enabled' for share`,
          [actor.userId, input.teamId]
        );
        if (!membership.rowCount) {
          await client.query("rollback");
          return null;
        }
        const row = await authorizePublication(
          client,
          actor.userId,
          input.publicationId
        );
        if (row?.team_id !== input.teamId) {
          await client.query("rollback");
          return null;
        }
        if (
          !row ||
          row.owner_user_id !== actor.userId ||
          row.state !== "active" ||
          row.owner_left_team
        ) {
          await client.query("rollback");
          return null;
        }
        let stored = await decryptAuthorizedEncryptedFieldPayloadWithClient(
          client,
          actor,
          personalProvider(),
          {
            sourceTable: "personal_agent_team_job_publications",
            sourceId: input.publicationId,
            sourceColumn: "brief_private"
          }
        );
        if (!stored) {
          const command = await client.query<{
            encrypted_payload: EncryptedPayloadEnvelope | null;
          }>(
            `select c.encrypted_payload from personal_agent_team_job_publications p join personal_agent_execution_jobs j on j.id=p.job_id and j.owner_user_id=p.owner_user_id join managed_conversation_commands c on c.id=j.command_id and c.owner_user_id=j.owner_user_id and c.execution_id=j.conversation_id where p.id=$1 and p.owner_user_id=$2 and c.command_kind in ('start','prompt')`,
            [input.publicationId, actor.userId]
          );
          const envelope = command.rows[0]?.encrypted_payload;
          if (envelope) {
            const payload: unknown = JSON.parse(
              await decryptEnvelopeToUtf8(personalProvider(), envelope)
            );
            const prompt =
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? (payload as Record<string, unknown>).prompt
                : null;
            if (typeof prompt === "string") {
              const goal =
                prompt.split(
                  /\n\s*\nKoed attached terminal context\b/u,
                  1
                )[0] ?? prompt;
              const draft = Array.from(goal.replace(/\s+/gu, " ").trim())
                .slice(0, 1000)
                .join("");
              await upsertEncryptedFieldPayloadWithClient(
                client,
                actor,
                personalProvider(),
                {
                  sourceTable: "personal_agent_team_job_publications",
                  sourceId: input.publicationId,
                  sourceColumn: "brief_private",
                  plaintext: draft,
                  visibility: "personal"
                }
              );
              stored = { record: null as never, plaintext: draft };
            }
          }
        }
        const draft =
          typeof stored?.plaintext === "string" ? stored.plaintext : "";
        const version = await client.query<{ version: number }>(
          `select version from personal_agent_team_job_publications where id=$1 and team_id=$2`,
          [input.publicationId, input.teamId]
        );
        await client.query("commit");
        return {
          publicationId: input.publicationId,
          briefDraft: draft,
          version: version.rows[0]?.version ?? 1
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async updatePublicSquareBrief(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const auth = await authorizePublication(
          client,
          actor.userId,
          input.publicationId
        );
        if (!auth || auth.team_id !== input.teamId) {
          await client.query("rollback");
          return null;
        }
        const admin = await client.query(
          `select 1 from team_memberships where user_id=$1 and team_id=$2 and status='enabled' and role in ('owner','admin') for share`,
          [actor.userId, auth.team_id]
        );
        const isOwner =
          auth.owner_user_id === actor.userId &&
          !auth.owner_left_team &&
          auth.state === "active";
        const canRemove =
          input.brief === null && auth.owner_left_team && !!admin.rowCount;
        if (!isOwner && !canRemove) {
          await client.query("rollback");
          return null;
        }
        const versionResult = await client.query<{ version: number }>(
          `select version from personal_agent_team_job_publications where id=$1 for update`,
          [input.publicationId]
        );
        if (versionResult.rows[0]?.version !== input.expectedVersion)
          throw Object.assign(new Error("Public Square publication changed"), {
            statusCode: 409
          });
        if (isOwner && input.brief !== null) {
          await upsertEncryptedFieldPayloadWithClient(
            client,
            actor,
            personalProvider(),
            {
              sourceTable: "personal_agent_team_job_publications",
              sourceId: input.publicationId,
              sourceColumn: "brief_private",
              plaintext: input.brief ?? "",
              visibility: "personal"
            }
          );
        }
        if (input.brief === null)
          await client.query(
            `update encrypted_field_payloads set invalidated_at=now(),updated_at=now() where source_table='personal_agent_team_job_publications' and source_id=$1 and source_column='brief_team' and invalidated_at is null`,
            [input.publicationId]
          );
        else
          await upsertEncryptedFieldPayloadWithClient(
            client,
            actor,
            teamProvider(),
            {
              sourceTable: "personal_agent_team_job_publications",
              sourceId: input.publicationId,
              sourceColumn: "brief_team",
              plaintext: input.brief,
              visibility: "team",
              teamId: auth.team_id
            }
          );
        await client.query(
          `update personal_agent_team_job_publications set version=version+1,updated_at=now() where id=$1`,
          [input.publicationId]
        );
        const page = await client.query<PublicationRow>(
          `${publicationSelect} where p.id=$1 and p.team_id=$2`,
          [input.publicationId, input.teamId]
        );
        const publication = page.rows[0]
          ? await mapPublication(
              client,
              page.rows[0],
              actor.userId,
              input.teamId
            )
          : null;
        await client.query("commit");
        return publication;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async unsharePublicSquareProject(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const membership = await client.query<{
          role: "owner" | "admin" | "member";
        }>(
          `select role from team_memberships where team_id=$1 and user_id=$2 and status='enabled' for share`,
          [input.teamId, actor.userId]
        );
        if (!membership.rowCount) {
          await client.query("rollback");
          return false;
        }
        const project = await client.query(
          `select created_by_user_id from collaboration_team_shared_projects where id=$1 and team_id=$2 and unshared_at is null for update`,
          [input.teamProjectId, input.teamId]
        );
        if (!project.rowCount) {
          await client.query("rollback");
          return false;
        }
        if (
          membership.rows[0]?.role !== "owner" &&
          membership.rows[0]?.role !== "admin" &&
          project.rows[0]?.created_by_user_id !== actor.userId
        ) {
          await client.query("rollback");
          return false;
        }
        const result = await client.query(
          `update collaboration_team_shared_projects set unshared_at=now(),updated_at=now() where id=$1 and team_id=$2 and unshared_at is null returning id`,
          [input.teamProjectId, input.teamId]
        );
        await client.query("commit");
        return result.rowCount === 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
};
