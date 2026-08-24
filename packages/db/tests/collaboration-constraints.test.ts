import { randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";

const databaseUrl = process.env.COLLABORATION_CONSTRAINT_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("collaboration participant database invariants", () => {
  let pool: pg.Pool;

  const createFixture = async () => {
    const users = await Promise.all(
      ["owner", "member", "second", "extra"].map(async (label) => {
        const result = await pool.query<{ id: string }>(
          `insert into users (email, display_name)
           values ($1, $2) returning id`,
          [`${label}-${randomUUID()}@example.test`, label]
        );
        return result.rows[0]!.id;
      })
    );
    const team = await pool.query<{ id: string }>(
      "insert into teams (name) values ($1) returning id",
      [`Constraint Team ${randomUUID()}`]
    );
    await pool.query(
      `insert into team_memberships (
         team_id, user_id, role, status, accepted_at
       )
       select $1, member.user_id,
              case when member.ordinal = 1 then 'owner'::team_role else 'member'::team_role end,
              'enabled', now()
         from unnest($2::uuid[]) with ordinality as member(user_id, ordinal)`,
      [team.rows[0]!.id, users]
    );
    return {
      ownerId: users[0]!,
      memberId: users[1]!,
      secondMemberId: users[2]!,
      extraMemberId: users[3]!,
      teamId: team.rows[0]!.id
    };
  };

  const expectDeferredConstraintViolation = async (
    mutate: (client: pg.PoolClient) => Promise<void>
  ) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await mutate(client);
      await expect(client.query("commit")).rejects.toMatchObject({
        code: "23514",
        constraint: "collaboration_participant_set_check"
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  };

  const expectTwoClientUniqueConflict = async (input: {
    first: { text: string; values: unknown[] };
    second: { text: string; values: unknown[] };
    constraint: string;
  }) => {
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const backendPids = await Promise.all([
        firstClient.query<{ pid: number }>("select pg_backend_pid() as pid"),
        secondClient.query<{ pid: number }>("select pg_backend_pid() as pid")
      ]);
      expect(backendPids[0].rows[0]!.pid).not.toBe(backendPids[1].rows[0]!.pid);
      await Promise.all([
        firstClient.query("begin"),
        secondClient.query("begin")
      ]);
      await firstClient.query(input.first.text, input.first.values);
      const competingInsert = secondClient
        .query(input.second.text, input.second.values)
        .then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      await firstClient.query("commit");
      const outcome = await competingInsert;
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("Expected the competing transaction to lose the race");
      }
      expect(outcome.error).toMatchObject({
        code: "23505",
        constraint: input.constraint
      });
    } finally {
      await Promise.all([
        firstClient.query("rollback").catch(() => undefined),
        secondClient.query("rollback").catch(() => undefined)
      ]);
      firstClient.release();
      secondClient.release();
    }
  };

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  afterEach(async () => {
    await pool.query("truncate table users, teams restart identity cascade");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("accepts repository-created Personal channels, DMs, and group DMs", async () => {
    const fixture = await createFixture();
    const repository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 41).toString("base64")
      )
    });

    const personalChannel = await repository.createThread(
      { userId: fixture.ownerId },
      {
        kind: "personal_channel",
        idempotencyKey: randomUUID(),
        name: "Private scratch"
      }
    );
    const directMessage = await repository.createThread(
      { userId: fixture.ownerId },
      {
        kind: "dm",
        idempotencyKey: randomUUID(),
        teamId: fixture.teamId,
        participantUserIds: [fixture.memberId]
      }
    );
    const groupDirectMessage = await repository.createThread(
      { userId: fixture.ownerId },
      {
        kind: "group_dm",
        idempotencyKey: randomUUID(),
        teamId: fixture.teamId,
        participantUserIds: [fixture.memberId, fixture.secondMemberId]
      }
    );

    expect(personalChannel).not.toBeNull();
    expect(directMessage).not.toBeNull();
    expect(groupDirectMessage).not.toBeNull();
    const counts = await pool.query<{ thread_id: string; count: string }>(
      `select thread_id, count(*)::text as count
         from collaboration_participants
        where thread_id = any($1::uuid[])
        group by thread_id`,
      [[personalChannel!.id, directMessage!.id, groupDirectMessage!.id]]
    );
    expect(
      new Map(counts.rows.map((row) => [row.thread_id, row.count]))
    ).toEqual(
      new Map([
        [directMessage!.id, "2"],
        [groupDirectMessage!.id, "3"]
      ])
    );
    expect(
      counts.rows.some((row) => row.thread_id === personalChannel!.id)
    ).toBe(false);
  });

  it("rejects participant deletion, addition, and participant-key tampering at commit", async () => {
    const fixture = await createFixture();
    const repository = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 42).toString("base64")
      )
    });
    const directMessage = await repository.createThread(
      { userId: fixture.ownerId },
      {
        kind: "dm",
        idempotencyKey: randomUUID(),
        teamId: fixture.teamId,
        participantUserIds: [fixture.memberId]
      }
    );
    const groupDirectMessage = await repository.createThread(
      { userId: fixture.ownerId },
      {
        kind: "group_dm",
        idempotencyKey: randomUUID(),
        teamId: fixture.teamId,
        participantUserIds: [fixture.memberId, fixture.secondMemberId]
      }
    );

    await expectDeferredConstraintViolation((client) =>
      client
        .query(
          `delete from collaboration_participants
          where thread_id = $1 and user_id = $2`,
          [directMessage!.id, fixture.memberId]
        )
        .then(() => undefined)
    );
    await expectDeferredConstraintViolation((client) =>
      client
        .query(
          `insert into collaboration_participants (
           thread_id, scope, thread_kind, team_id, user_id, ordinal
         ) values ($1, 'team', 'dm', $2, $3, 2)`,
          [directMessage!.id, fixture.teamId, fixture.extraMemberId]
        )
        .then(() => undefined)
    );
    await expectDeferredConstraintViolation((client) =>
      client
        .query(
          `delete from collaboration_participants
          where thread_id = $1 and user_id = $2`,
          [groupDirectMessage!.id, fixture.secondMemberId]
        )
        .then(() => undefined)
    );
    await expectDeferredConstraintViolation((client) =>
      client
        .query(
          "update collaboration_threads set participant_key = repeat('0', 64) where id = $1",
          [directMessage!.id]
        )
        .then(() => undefined)
    );
  });

  it("serializes two-client logical-thread and outbox mutation-family races", async () => {
    const fixture = await createFixture();
    const logicalId = randomUUID();
    const insertPersonalChannel = `insert into collaboration_threads (
       id,logical_id,scope,kind,personal_owner_user_id,name_marker,
       normalized_name_hash,created_by_user_id
     ) values ($1,$2,'personal','personal_channel',$3,
       '[koed encrypted collaboration name]',$4,$3)`;
    await expectTwoClientUniqueConflict({
      first: {
        text: insertPersonalChannel,
        values: [randomUUID(), logicalId, fixture.ownerId, "a".repeat(64)]
      },
      second: {
        text: insertPersonalChannel,
        values: [randomUUID(), logicalId, fixture.extraMemberId, "b".repeat(64)]
      },
      constraint: "collaboration_threads_logical_id_unique"
    });

    const mutationId = randomUUID();
    const insertOutboxEvent = `insert into collaboration_outbox (
       protocol_version,family,scope,personal_owner_user_id,resource_type,
       resource_id,actor_principal_id,mutation_id,replay_until
     ) values (1,'message_created','personal',$1,'test_resource',$2,$1,$3,
       now() + interval '1 day')`;
    await expectTwoClientUniqueConflict({
      first: {
        text: insertOutboxEvent,
        values: [fixture.ownerId, randomUUID(), mutationId]
      },
      second: {
        text: insertOutboxEvent,
        values: [fixture.ownerId, randomUUID(), mutationId]
      },
      constraint: "collaboration_outbox_mutation_family_unique"
    });

    const durable = await pool.query<{
      logical_threads: string;
      mutation_family_events: string;
    }>(
      `select
         (select count(*)::text from collaboration_threads
           where logical_id=$1) as logical_threads,
         (select count(*)::text from collaboration_outbox
           where mutation_id=$2 and family='message_created') as mutation_family_events`,
      [logicalId, mutationId]
    );
    expect(durable.rows[0]).toEqual({
      logical_threads: "1",
      mutation_family_events: "1"
    });
  });
});
