import { randomUUID } from "node:crypto";
import { createDbPool, runDbMigrations } from "../src/index.js";
import { describe, expect, it } from "vitest";

const adminUrl = process.env.MERGED_MIGRATIONS_TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("fresh-only migration history protection", () => {
  const withDisposableDatabase = async (
    run: (pool: ReturnType<typeof createDbPool>) => Promise<void>
  ) => {
    const name = `koed_fresh_${randomUUID().replaceAll("-", "")}`;
    const parsedUrl = new URL(adminUrl!);
    parsedUrl.pathname = `/${name}`;
    const admin = createDbPool({ connectionString: adminUrl });
    const pool = createDbPool({ connectionString: parsedUrl.toString() });
    try {
      await admin.query(`create database "${name}"`);
      await run(pool);
    } finally {
      await pool.end();
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.end();
    }
  };

  it("preserves all preconfigured timeout settings after fresh migrations", async () => {
    await withDisposableDatabase(async (pool) => {
      const settings = [
        ["statement_timeout", "17s"],
        ["lock_timeout", "3s"],
        ["idle_in_transaction_session_timeout", "29s"],
        ["transaction_timeout", "41s"]
      ] as const;
      for (const [name, value] of settings) {
        await pool.query(`set ${name} = '${value}'`);
      }

      await runDbMigrations(pool);

      const actual = await pool.query(
        "select name, setting from pg_settings where name = any($1)",
        [settings.map(([name]) => name)]
      );
      expect(
        Object.fromEntries(
          actual.rows.map(({ name, setting }) => [name, setting])
        )
      ).toEqual(
        Object.fromEntries(
          settings.map(([name, value]) => [
            name,
            String(Number.parseInt(value, 10) * 1000)
          ])
        )
      );
    });
  }, 120_000);

  it("rejects populated schema without history without changing its marker", async () => {
    await withDisposableDatabase(async (pool) => {
      await pool.query(
        "create table public.migration_marker (value text not null)"
      );
      await pool.query(
        "insert into public.migration_marker values ('preserve')"
      );

      await expect(runDbMigrations(pool)).rejects.toThrow(
        "Alpha databases are unsupported as in-place upgrade sources; database left untouched"
      );
      expect(
        (await pool.query("select value from public.migration_marker")).rows
      ).toEqual([{ value: "preserve" }]);
    });
  }, 120_000);

  it("rejects unknown legacy ledger without changing its ledger or schema", async () => {
    await withDisposableDatabase(async (pool) => {
      await pool.query("create schema drizzle");
      await pool.query(
        "create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)"
      );
      await pool.query(
        "insert into drizzle.__drizzle_migrations (hash, created_at) values ('legacy-unknown-hash', 1)"
      );
      await pool.query(
        "create table public.migration_marker (value text not null)"
      );
      await pool.query(
        "insert into public.migration_marker values ('preserve')"
      );
      const ledgerBefore = (
        await pool.query(
          "select hash, created_at from drizzle.__drizzle_migrations order by id"
        )
      ).rows;

      await expect(runDbMigrations(pool)).rejects.toThrow(
        "Alpha databases are unsupported as in-place upgrade sources; database left untouched"
      );
      expect(
        (
          await pool.query(
            "select hash, created_at from drizzle.__drizzle_migrations order by id"
          )
        ).rows
      ).toEqual(ledgerBefore);
      expect(
        (await pool.query("select value from public.migration_marker")).rows
      ).toEqual([{ value: "preserve" }]);
    });
  }, 120_000);
});
