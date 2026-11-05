// Disposable test fixture only: not a production persistence design.
import type pg from "pg";
import {
  apply,
  initialize,
  inspect,
  markIncomplete,
  type Anchor,
  type State
} from "../../../shared/src/peer-membership-history.test-support.js";

type Queryable = pg.Pool | pg.PoolClient;
export function createEvidenceFixture(
  pool: pg.Pool,
  schema: string,
  anchor: Anchor
) {
  if (!/^peer_evidence_[a-f0-9]{32}$/.test(schema))
    throw new Error("invalid fixture schema");
  const prefix = `"${schema}"`;
  async function load(
    client: Queryable,
    afterStatus?: () => Promise<void>
  ): Promise<State> {
    const status = await client.query<{
      conflict: boolean;
      incomplete: boolean;
    }>(`select conflict, incomplete from ${prefix}.status where id = true`);
    if (status.rows.length !== 1) throw new Error("missing status");
    await afterStatus?.();
    const records = await client.query<{ evidence: string }>(
      `select evidence from ${prefix}.evidence order by ordinal`
    );
    const genesis = records.rows[0];
    if (!genesis) throw new Error("missing genesis");
    const initial = initialize(anchor, genesis.evidence);
    if (initial.status !== "accepted")
      throw new Error("invalid genesis evidence");
    let state = initial.state;
    for (const row of records.rows.slice(1)) {
      const result = apply(state, row.evidence);
      if (result.status !== "accepted")
        throw new Error("invalid persisted evidence");
      state = result.state;
    }
    if (status.rows[0]!.conflict !== inspect(state).conflict)
      throw new Error("inconsistent evidence");
    return status.rows[0]!.incomplete ? markIncomplete(state) : state;
  }
  return {
    async setup(genesis: string) {
      if (initialize(anchor, genesis).status !== "accepted")
        throw new Error("invalid genesis");
      await pool.query(
        `create table ${prefix}.status (id boolean primary key default true check (id), conflict boolean not null, incomplete boolean not null)`
      );
      await pool.query(
        `create table ${prefix}.evidence (ordinal bigint generated always as identity primary key, evidence text not null)`
      );
      await pool.query(
        `insert into ${prefix}.status values (true, false, false)`
      );
      await pool.query(`insert into ${prefix}.evidence(evidence) values ($1)`, [
        genesis
      ]);
    },
    async load(afterStatus?: () => Promise<void>) {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        const state = await load(client, afterStatus);
        await client.query("commit");
        return state;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async append(
      evidence: string,
      options?: {
        failBeforeCommit?: boolean;
        failAfterInsert?: boolean;
        beforeLock?: (pid: number) => void;
        afterLock?: () => Promise<void>;
      }
    ) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (options?.beforeLock) {
          const result = await client.query<{ pid: number }>(
            "select pg_backend_pid() as pid"
          );
          options.beforeLock(result.rows[0]!.pid);
        }
        await client.query(
          `select id from ${prefix}.status where id = true for update`
        );
        await options?.afterLock?.();
        const state = await load(client);
        const next = apply(state, evidence);
        if (next.status === "limit") {
          await client.query(
            `update ${prefix}.status set incomplete = true where id = true`
          );
        } else if (next.status === "accepted") {
          await client.query(
            `insert into ${prefix}.evidence(evidence) values ($1)`,
            [evidence]
          );
          if (options?.failAfterInsert) throw new Error("injected rollback");
          await client.query(
            `update ${prefix}.status set conflict = $1 where id = true`,
            [inspect(next.state).conflict]
          );
        } else if (next.status !== "duplicate") {
          throw new Error(`unaccepted evidence: ${next.status}`);
        }
        if (options?.failBeforeCommit) throw new Error("injected rollback");
        await client.query("commit");
        return next.status;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
