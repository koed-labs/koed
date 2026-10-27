import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrationSchemaFingerprint } from "./migration-schema.js";
import {
  unreleasedProjectMigrationHistory,
  unreleasedProjectSchemaFingerprint,
  consolidatedProjectSchemaFingerprint,
  retiredProjectUpgradeTables,
  retiredProjectFunctions
} from "./project-migration-history.js";

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle"
);
const ledgerQuery =
  "select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id";
type LedgerRow = { id: number; hash: string; created_at: string };
const matches = (
  rows: LedgerRow[],
  history: readonly (readonly [string, string])[]
) =>
  rows.length === history.length &&
  rows.every(
    (row, index) =>
      row.hash === history[index]![0] && row.created_at === history[index]![1]
  );

/** Explicit Local Operator action for this one known alpha history; never part of normal startup. */
export const reconcileProjectBranchMigrations = async (
  pool: pg.Pool,
  options: { backupPath: string }
): Promise<{ reconciled: boolean }> => {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length !== 49)
    throw new Error(
      "Project reconciliation requires the consolidated build through migration 0048."
    );
  const canonical = migrations.map(
    (migration) => [migration.hash, String(migration.folderMillis)] as const
  );
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query(
      "select pg_advisory_lock(hashtext('koed:db:migrations'))"
    );
    await client.query("begin isolation level repeatable read");
    transaction = true;
    await client.query("set local lock_timeout = '5s'");
    await client.query(
      "lock table drizzle.__drizzle_migrations in access exclusive mode"
    );
    const applied = (await client.query<LedgerRow>(ledgerQuery)).rows;
    if (matches(applied, canonical)) {
      await client.query("rollback");
      transaction = false;
      return { reconciled: false };
    }
    if (!matches(applied, unreleasedProjectMigrationHistory))
      throw new Error(
        "Unrecognized migration history. No schema or ledger changes were made."
      );
    const backup = await open(options.backupPath, "r");
    try {
      const signature = Buffer.alloc(5);
      const { bytesRead } = await backup.read(signature, 0, 5, 0);
      if (bytesRead !== 5 || signature.toString() !== "PGDMP")
        throw new Error(
          "A verified PostgreSQL custom-format backup is required before reconciliation."
        );
    } finally {
      await backup.close();
    }
    const retired = [...retiredProjectUpgradeTables, "personal_project_routes"];
    await client.query(
      `lock table ${[...retired, "personal_capture_target_routes", "pending_sharing_rule_admissions"].map((table) => `public.${table}`).join(",")} in access exclusive mode`
    );
    if (
      (await migrationSchemaFingerprint(client)) !==
      unreleasedProjectSchemaFingerprint
    )
      throw new Error(
        "The old branch schema differs from the verified history. Preserved data requires inspection."
      );
    for (const table of retiredProjectUpgradeTables) {
      if (
        (await client.query(`select 1 from public.${table} limit 1`)).rowCount
      )
        throw new Error(
          `Retained upgrade evidence in ${table} requires preservation before reconciliation.`
        );
    }
    const unpreserved =
      await client.query(`select 1 from public.personal_project_routes old
      left join public.personal_capture_target_routes retained
        on retained.owner_user_id=old.owner_user_id and retained.source_scope=old.source_project_id
      where retained.owner_user_id is null or retained.target_id is distinct from old.target_project_id
        or retained.target_name is distinct from old.target_name or retained.target_path is distinct from old.target_path
        or retained.evidence is distinct from to_jsonb(old) limit 1`);
    if (unpreserved.rowCount)
      throw new Error(
        "A retired Project route lacks its exact preserved Capture Target. No changes were made."
      );
    await client.query(
      `drop table ${retired.map((table) => `public.${table}`).join(",")} restrict`
    );
    await client.query(
      `drop function ${retiredProjectFunctions.map((name) => `public.${name}()`).join(",")} restrict`
    );
    await client.query(
      "alter table public.pending_sharing_rule_admissions rename constraint pending_conversation_sharing_rules_pkey to pending_sharing_rule_admissions_pkey"
    );
    if (
      (await migrationSchemaFingerprint(client)) !==
      consolidatedProjectSchemaFingerprint
    )
      throw new Error(
        "Consolidated schema verification failed; reconciliation was rolled back."
      );
    // Retain main and the initial source cutover exactly. Never replay sharing backfills.
    await client.query(
      "delete from drizzle.__drizzle_migrations where id=any($1::int[])",
      [applied.slice(47).map((row) => row.id)]
    );
    for (const [hash, when] of canonical.slice(47))
      await client.query(
        "insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)",
        [hash, when]
      );
    if (!matches((await client.query<LedgerRow>(ledgerQuery)).rows, canonical))
      throw new Error("Consolidated migration ledger verification failed.");
    await client.query("commit");
    transaction = false;
    return { reconciled: true };
  } catch (error) {
    if (transaction) await client.query("rollback");
    throw error;
  } finally {
    try {
      await client.query(
        "select pg_advisory_unlock(hashtext('koed:db:migrations'))"
      );
    } finally {
      client.release();
    }
  }
};
