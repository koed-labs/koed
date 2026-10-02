import type pg from "pg";
import type { TeamOverviewSource } from "@koed/shared";
import type { ActorContext } from "./types.js";
import type { TeamOverviewSourcesRepository } from "./team-overview-sources.js";

export interface TeamOverviewTeamRecord {
  teamId: string;
  name: string;
}

export interface TeamOverviewReminderState {
  ownerUserId: string;
  teamId: string;
  sourceEventId: string;
  source: TeamOverviewSource;
  sourceId: string;
  sourceRevision: string;
  cleared: boolean;
  seen: boolean;
  updatedAt: string;
}

export interface TeamOverviewRepository {
  listAuthorizedTeams(actor: ActorContext): Promise<TeamOverviewTeamRecord[]>;
  listReminderStates(
    actor: ActorContext,
    input?: { teamId?: string; sourceEventIds?: string[] }
  ): Promise<TeamOverviewReminderState[]>;
  setReminderState(
    actor: ActorContext,
    input: {
      teamId: string;
      sourceEventId: string;
      source: TeamOverviewSource;
      sourceId: string;
      sourceRevision: string;
      cleared?: boolean;
      seen?: boolean;
    }
  ): Promise<TeamOverviewReminderState | null>;
}

interface StateRow {
  owner_user_id: string;
  team_id: string;
  source_event_id: string;
  source_kind: TeamOverviewSource;
  source_id: string;
  source_revision: string;
  cleared: boolean;
  seen: boolean;
  updated_at: Date;
}

const mapState = (row: StateRow): TeamOverviewReminderState => ({
  ownerUserId: row.owner_user_id,
  teamId: row.team_id,
  sourceEventId: row.source_event_id,
  source: row.source_kind,
  sourceId: row.source_id,
  sourceRevision: row.source_revision,
  cleared: row.cleared,
  seen: row.seen,
  updatedAt: row.updated_at.toISOString()
});

export const createTeamOverviewRepository = (
  pool: pg.Pool,
  sources: TeamOverviewSourcesRepository
): TeamOverviewRepository => ({
  async listAuthorizedTeams(actor) {
    const result = await pool.query<
      TeamOverviewTeamRecord & { team_id: string }
    >(
      `select team.id as "teamId", team.id as team_id, team.name
         from team_memberships membership join teams team on team.id=membership.team_id
         join users member on member.id=membership.user_id
        where membership.user_id=$1 and membership.status='enabled' and membership.disabled_at is null
          and team.lifecycle='active' and team.entitlement_status in ('active','grace')
          and member.disabled_at is null and member.deleted_at is null
        order by team.name,team.id`,
      [actor.userId]
    );
    return result.rows.map((row) => ({ teamId: row.team_id, name: row.name }));
  },
  async listReminderStates(actor, input = {}) {
    const result = await pool.query<StateRow>(
      `select state.owner_user_id,state.team_id,state.source_event_id,state.source_kind,
              state.source_id,state.source_revision,state.cleared,state.seen,state.updated_at
         from team_overview_reminder_states state
        where state.owner_user_id=$1
          and ($2::uuid is null or state.team_id=$2)
          and ($3::text[] is null or state.source_event_id=any($3::text[]))
          and exists (
            select 1 from team_memberships membership
            join teams team on team.id=membership.team_id
            join users member on member.id=membership.user_id
            where membership.team_id=state.team_id and membership.user_id=$1
              and membership.status='enabled' and membership.disabled_at is null
              and team.lifecycle='active' and team.entitlement_status in ('active','grace')
              and member.disabled_at is null and member.deleted_at is null
          )
        order by state.updated_at desc`,
      [actor.userId, input.teamId ?? null, input.sourceEventIds ?? null]
    );
    return result.rows.map(mapState);
  },
  async setReminderState(actor, input) {
    if (input.seen !== undefined && input.source !== "team_job_outcome")
      return null;
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      const membership = await client.query(
        `select 1 from team_memberships membership
          join teams team on team.id=membership.team_id
          join users member on member.id=membership.user_id
         where membership.team_id=$1 and membership.user_id=$2
           and membership.status='enabled' and membership.disabled_at is null
           and team.lifecycle='active' and team.entitlement_status in ('active','grace')
           and member.disabled_at is null and member.deleted_at is null
         for share of membership,team,member`,
        [input.teamId, actor.userId]
      );
      if (
        membership.rowCount !== 1 ||
        !(await sources.validateCurrentSourceWithClient(client, actor, input))
      ) {
        await client.query("rollback");
        return null;
      }
      const result = await client.query<StateRow>(
        `insert into team_overview_reminder_states
           (owner_user_id,team_id,source_event_id,source_kind,source_id,source_revision,cleared,seen,updated_at)
         values ($1,$2,$3,$4,$5,$6,coalesce($7::boolean,false),coalesce($8::boolean,false),now())
         on conflict(owner_user_id,team_id,source_event_id) do update set
           source_kind=excluded.source_kind,source_id=excluded.source_id,source_revision=excluded.source_revision,
           cleared=case when team_overview_reminder_states.source_kind=excluded.source_kind
                              and team_overview_reminder_states.source_id=excluded.source_id
                              and team_overview_reminder_states.source_revision=excluded.source_revision
                        then coalesce($7::boolean,team_overview_reminder_states.cleared)
                        else coalesce($7::boolean,false) end,
           seen=case when team_overview_reminder_states.source_kind=excluded.source_kind
                           and team_overview_reminder_states.source_id=excluded.source_id
                           and team_overview_reminder_states.source_revision=excluded.source_revision
                     then coalesce($8::boolean,team_overview_reminder_states.seen)
                     else coalesce($8::boolean,false) end,
           updated_at=now()
         returning owner_user_id,team_id,source_event_id,source_kind,source_id,source_revision,cleared,seen,updated_at`,
        [
          actor.userId,
          input.teamId,
          input.sourceEventId,
          input.source,
          input.sourceId,
          input.sourceRevision,
          input.cleared ?? null,
          input.seen ?? null
        ]
      );
      await client.query("commit");
      return result.rows[0] ? mapState(result.rows[0]) : null;
    } catch (error) {
      await client.query("rollback");
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "40001" || error.code === "40P01")
      )
        return null;
      throw error;
    } finally {
      client.release();
    }
  }
});
