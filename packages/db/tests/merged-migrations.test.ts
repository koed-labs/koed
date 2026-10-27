import { createMigrationBaseline } from "./fixtures/migration-baseline.js";
import { randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  waitForDbMigrations,
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.MERGED_MIGRATIONS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("consolidated Project recall migrations", () => {
  it.each(["main", "repository identity", "discarded recall"] as const)(
    "handles an existing %s database without replaying applied migrations",
    async (history) => {
      const admin = createDbPool({ connectionString: databaseUrl });
      const name = `koed_merge_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;
      const pool = createDbPool({ connectionString: url.toString() });
      const migrationBaseline = await createMigrationBaseline(
        history === "repository identity"
          ? "0046_project_scoped_recall"
          : undefined
      );
      const { folder, source, journal, entries: baseline } = migrationBaseline;
      try {
        await admin.query(`create database "${name}"`);
        const firstPending = baseline.length;
        const absentTable =
          history === "repository identity"
            ? "personal_named_projects"
            : "session_repository_observations";
        await migrationBaseline.apply(pool);
        const repo = createMemorySourceRepository(pool);
        const owner = await repo.createUser({
          email: `merge-${randomUUID()}@example.test`
        });
        if (history === "discarded recall") {
          // Original unreleased 0045, now replaced by consolidated 0046.
          await pool.query(
            "insert into drizzle.__drizzle_migrations (hash,created_at) values ($1,$2)",
            [
              "85f784af0986ab04d3ac87560cc1984405e579b23b01c01055d11fb60ab67aa6",
              1791983422862
            ]
          );
        }
        const before = (
          await pool.query<{ hash: string; created_at: string }>(
            "select hash, created_at::text from drizzle.__drizzle_migrations order by id"
          )
        ).rows;
        const readiness = {
          timeoutMs: 0,
          expectedLatestMigrationTimestamp: journal.entries.at(-1)!.when,
          expectedMigrationHashes: readMigrationFiles({
            migrationsFolder: source
          }).map((migration) => migration.hash)
        };
        await expect(waitForDbMigrations(pool, readiness)).rejects.toThrow(
          "Timed out waiting"
        );
        if (history === "discarded recall") {
          await expect(runDbMigrations(pool)).rejects.toThrow(
            "Reset disposable databases"
          );
          expect(
            (
              await pool.query(
                "select hash, created_at::text from drizzle.__drizzle_migrations order by id"
              )
            ).rows
          ).toEqual(before);
          expect(
            (
              await pool.query<{ table: string | null }>(
                "select to_regclass($1)::text as table",
                [`public.${absentTable}`]
              )
            ).rows[0]?.table
          ).toBeNull();
          return;
        }
        if (history === "main" || history === "repository identity") {
          // A failed upgrade must roll back all schema changes and ledger inserts.
          for (const entry of journal.entries.slice(firstPending))
            await copyFile(
              join(source, `${entry.tag}.sql`),
              join(folder, `${entry.tag}.sql`)
            );
          const broken = join(
            folder,
            `${journal.entries[firstPending]!.tag}.sql`
          );
          await writeFile(
            broken,
            `${await readFile(broken, "utf8")}\n--> statement-breakpoint\nselect koed_deliberate_migration_failure();`
          );
          await writeFile(
            join(folder, "meta/_journal.json"),
            JSON.stringify(journal)
          );
          await expect(
            runDbMigrations(pool, { migrationsFolder: folder })
          ).rejects.toThrow("koed_deliberate_migration_failure");
          expect(
            (
              await pool.query<{ hash: string; created_at: string }>(
                "select hash, created_at::text from drizzle.__drizzle_migrations order by id"
              )
            ).rows
          ).toEqual(before);
          expect(
            (
              await pool.query<{ table: string | null }>(
                "select to_regclass($1)::text as table",
                [`public.${absentTable}`]
              )
            ).rows[0]?.table
          ).toBeNull();
        }
        await runDbMigrations(pool);
        await expect(
          waitForDbMigrations(pool, readiness)
        ).resolves.toBeUndefined();
        expect(
          (
            await pool.query<{ count: string }>(
              "select count(*)::text from drizzle.__drizzle_migrations"
            )
          ).rows[0]?.count
        ).toBe(String(journal.entries.length));
        expect(
          (
            await pool.query<{ hash: string; created_at: string }>(
              "select hash, created_at::text from drizzle.__drizzle_migrations order by id"
            )
          ).rows.slice(0, before.length)
        ).toEqual(before);
        expect(
          (
            await pool.query<{ id: string }>(
              "select id from users where id=$1",
              [owner.id]
            )
          ).rows[0]?.id
        ).toBe(owner.id);
        expect(
          (
            await pool.query<{ column_name: string }>(
              "select column_name from information_schema.columns where table_name='conversation_items' and column_name='agent_seal_waiting_at'"
            )
          ).rows
        ).toHaveLength(1);
        expect(
          (
            await pool.query<{ table: string | null }>(
              "select to_regclass('public.session_repository_observations')::text as table"
            )
          ).rows[0]?.table
        ).toBe("session_repository_observations");
        const after = (
          await pool.query(
            "select * from drizzle.__drizzle_migrations order by id"
          )
        ).rows;
        await runDbMigrations(pool);
        expect(
          (
            await pool.query(
              "select * from drizzle.__drizzle_migrations order by id"
            )
          ).rows
        ).toEqual(after);
      } finally {
        await pool.end();
        await admin.query(`drop database if exists "${name}" with (force)`);
        await admin.end();
        await migrationBaseline.dispose();
      }
    },
    120_000
  );
});
