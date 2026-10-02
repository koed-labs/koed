import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createTeamOverviewRepository } from "./team-overview-repository.js";
import type {
  TeamOverviewSourceRef,
  TeamOverviewSourcesRepository
} from "./team-overview-sources.js";
import type { ActorContext } from "./types.js";

const baseUrl = process.env.HOME_AUTHORITY_TEST_DATABASE_URL;
const databaseName = `koed_team_overview_state_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)("Team overview reminder states (PostgreSQL)", () => {
  const configured = baseUrl ? new URL(baseUrl) : null;
  const adminUrl = configured ? new URL(configured) : null;
  if (adminUrl) adminUrl.pathname = "/postgres";
  const testUrl = configured ? new URL(configured) : null;
  if (testUrl) testUrl.pathname = `/${databaseName}`;
  const admin = adminUrl
    ? new pg.Client({ connectionString: adminUrl.toString() })
    : null;
  const pool = testUrl
    ? new pg.Pool({ connectionString: testUrl.toString() })
    : null;
  let connected = false;

  afterAll(async () => {
    await pool?.end();
    if (!admin || !connected) return;
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
        [databaseName]
      );
      await admin.query(`drop database if exists "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  it("authorizes states by active Team membership and rejects stale or foreign mutations", async () => {
    if (!admin || !pool) throw new Error("Test database URL unavailable");
    await admin.connect();
    connected = true;
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);
    const ownerId = randomUUID();
    const foreignId = randomUUID();
    const teamId = randomUUID();
    const eventId = `job-outcome:${randomUUID()}`;
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,'Owner'),($3,$4,'Foreign')",
      [
        ownerId,
        `${ownerId}@overview.invalid`,
        foreignId,
        `${foreignId}@overview.invalid`
      ]
    );
    await pool.query("insert into teams(id,name) values($1,'Overview test')", [
      teamId
    ]);
    await pool.query(
      "insert into team_memberships(team_id,user_id,role,status,accepted_at) values($1,$2,'owner','enabled',now())",
      [teamId, ownerId]
    );
    await pool.query(
      "create table team_overview_test_sources(team_id uuid,source_event_id text,source_kind text,source_id text,source_revision text,primary key(team_id,source_event_id))"
    );
    await pool.query(
      "insert into team_overview_test_sources values($1,$2,'team_job_outcome',$3,'terminal-v1')",
      [teamId, eventId, randomUUID()]
    );
    const sources = {
      validateCurrentSourceWithClient: async (
        client: pg.PoolClient,
        actor: ActorContext,
        ref: TeamOverviewSourceRef
      ) => {
        const current = await client.query(
          `select 1 from team_overview_test_sources where team_id=$1 and source_event_id=$2
            and source_kind=$3 and source_id=$4 and source_revision=$5`,
          [
            ref.teamId,
            ref.sourceEventId,
            ref.source,
            ref.sourceId,
            ref.sourceRevision
          ]
        );
        return actor.userId === ownerId && current.rowCount === 1;
      }
    } as unknown as TeamOverviewSourcesRepository;
    const repository = createTeamOverviewRepository(pool, sources);
    const sourceId = (
      await pool.query<{ source_id: string }>(
        "select source_id from team_overview_test_sources where team_id=$1 and source_event_id=$2",
        [teamId, eventId]
      )
    ).rows[0]!.source_id;

    expect(await repository.listAuthorizedTeams({ userId: foreignId })).toEqual(
      []
    );
    expect(
      await repository.setReminderState(
        { userId: foreignId },
        {
          teamId,
          sourceEventId: eventId,
          source: "team_job_outcome",
          sourceId,
          sourceRevision: "terminal-v1",
          seen: true
        }
      )
    ).toBeNull();
    expect(
      await repository.setReminderState(
        { userId: ownerId },
        {
          teamId,
          sourceEventId: eventId,
          source: "team_job_outcome",
          sourceId,
          sourceRevision: "terminal-v0",
          seen: true
        }
      )
    ).toBeNull();
    await expect(
      repository.setReminderState(
        { userId: ownerId },
        {
          teamId,
          sourceEventId: eventId,
          source: "message_attention",
          sourceId,
          sourceRevision: "terminal-v1",
          seen: true
        }
      )
    ).resolves.toBeNull();

    const cleared = await repository.setReminderState(
      { userId: ownerId },
      {
        teamId,
        sourceEventId: eventId,
        source: "team_job_outcome",
        sourceId,
        sourceRevision: "terminal-v1",
        cleared: true
      }
    );
    expect(cleared?.cleared).toBe(true);
    expect(cleared?.seen).toBe(false);
    await pool.query(
      "update team_overview_test_sources set source_revision='terminal-v2' where team_id=$1 and source_event_id=$2",
      [teamId, eventId]
    );
    expect(
      await repository.setReminderState(
        { userId: ownerId },
        {
          teamId,
          sourceEventId: eventId,
          source: "team_job_outcome",
          sourceId,
          sourceRevision: "terminal-v1",
          seen: true
        }
      )
    ).toBeNull();
    const current = await repository.setReminderState(
      { userId: ownerId },
      {
        teamId,
        sourceEventId: eventId,
        source: "team_job_outcome",
        sourceId,
        sourceRevision: "terminal-v2",
        seen: true
      }
    );
    expect(current?.cleared).toBe(false);
    expect(current?.seen).toBe(true);
    await pool.query(
      "update team_overview_test_sources set source_revision='terminal-v3' where team_id=$1 and source_event_id=$2",
      [teamId, eventId]
    );
    const newRevisionClear = await repository.setReminderState(
      { userId: ownerId },
      {
        teamId,
        sourceEventId: eventId,
        source: "team_job_outcome",
        sourceId,
        sourceRevision: "terminal-v3",
        cleared: true
      }
    );
    expect(newRevisionClear?.cleared).toBe(true);
    expect(newRevisionClear?.seen).toBe(false);

    await pool.query(
      "update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2",
      [teamId, ownerId]
    );
    expect(
      await repository.listReminderStates({ userId: ownerId }, { teamId })
    ).toEqual([]);
    expect(
      await repository.setReminderState(
        { userId: ownerId },
        {
          teamId,
          sourceEventId: eventId,
          source: "team_job_outcome",
          sourceId,
          sourceRevision: "terminal-v3",
          seen: true
        }
      )
    ).toBeNull();
  });
});
