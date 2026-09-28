import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";

const databaseUrl = process.env.COLLABORATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle"
);

const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const createMigrationSlice = async (
  entries: Array<{ idx: number; tag: string }>,
  journal: Record<string, unknown>,
  lastIndex: number,
  transformLastSql?: (sql: string) => string
): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "koed-ticket07-migrations-"));
  const metaFolder = join(folder, "meta");
  await mkdir(metaFolder, { recursive: true });
  const prefixEntries = entries.slice(0, lastIndex + 1);
  try {
    for (const entry of prefixEntries) {
      const source = join(drizzleFolder, `${entry.tag}.sql`);
      const target = join(folder, `${entry.tag}.sql`);
      if (entry.idx === lastIndex && transformLastSql) {
        await writeFile(
          target,
          transformLastSql(await readFile(source, "utf8"))
        );
      } else {
        await copyFile(source, target);
      }
    }
    await writeFile(
      join(metaFolder, "_journal.json"),
      `${JSON.stringify({ ...journal, entries: prefixEntries }, null, 2)}\n`
    );
    return folder;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
};

describeWithDatabase("Ticket07 enum migration boundary", () => {
  it("upgrades T06, commits the enum before schema use, and resumes safely", async () => {
    const journalText = await readFile(
      join(drizzleFolder, "meta", "_journal.json"),
      "utf8"
    );
    const journal = JSON.parse(journalText) as {
      entries: Array<{
        idx: number;
        tag: string;
        when: number;
        requiresCommittedBoundaryAfter?: boolean;
      }>;
    };
    const t06Index = journal.entries.findIndex(
      (entry) => entry.tag === "0050_ai_client_capability_device_binding"
    );
    const enumIndex = journal.entries.findIndex(
      (entry) => entry.requiresCommittedBoundaryAfter === true
    );
    const latestIndex = journal.entries.length - 1;
    expect(t06Index).toBeGreaterThanOrEqual(0);
    expect(enumIndex).toBe(t06Index + 1);
    expect(journal.entries[enumIndex]?.tag).toBe(
      "0051_collaboration_thread_kinds"
    );

    const baseUrl = new URL(databaseUrl!);
    baseUrl.pathname = "/postgres";
    const admin = new pg.Client({ connectionString: baseUrl.toString() });
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const t06Name = `koed_t07_t06_${suffix}`;
    const freshName = `koed_t07_fresh_${suffix}`;
    const databaseNames: string[] = [];
    const pools: pg.Pool[] = [];
    const temporaryFolders: string[] = [];
    let adminConnected = false;

    try {
      await admin.connect();
      adminConnected = true;
      for (const name of [t06Name, freshName]) {
        await admin.query(`create database ${quoteIdentifier(name)}`);
        databaseNames.push(name);
      }

      const t06Folder = await createMigrationSlice(
        journal.entries,
        journal as unknown as Record<string, unknown>,
        t06Index
      );
      temporaryFolders.push(t06Folder);
      const failedFollowupFolder = await createMigrationSlice(
        journal.entries,
        journal as unknown as Record<string, unknown>,
        latestIndex,
        (sql) => `${sql}\n--> statement-breakpoint\nselect 1 / 0;\n`
      );
      temporaryFolders.push(failedFollowupFolder);
      const enumMigrationSql = await readFile(
        join(drizzleFolder, `${journal.entries[enumIndex]!.tag}.sql`),
        "utf8"
      );
      const enumMigrationHash = createHash("sha256")
        .update(enumMigrationSql)
        .digest("hex");

      const t06Url = new URL(databaseUrl!);
      t06Url.pathname = `/${t06Name}`;
      const t06Pool = createDbPool({ connectionString: t06Url.toString() });
      pools.push(t06Pool);
      await runDbMigrations(t06Pool, { migrationsFolder: t06Folder });
      await expect(
        runDbMigrations(t06Pool, { migrationsFolder: failedFollowupFolder })
      ).rejects.toThrow(/Failed query:[\s\S]*select 1 \/ 0/i);
      const committedBoundary = await t06Pool.query<{
        hash: string;
        created_at: string;
        project_table: string | null;
      }>(`select
          (select hash from drizzle.__drizzle_migrations order by created_at desc limit 1) as hash,
          (select max(created_at)::text from drizzle.__drizzle_migrations) as created_at,
          to_regclass('public.collaboration_team_shared_projects')::text as project_table`);
      expect(committedBoundary.rows[0]).toEqual({
        hash: enumMigrationHash,
        created_at: String(journal.entries[enumIndex]!.when),
        project_table: null
      });
      const enumLabels = await t06Pool.query<{ enumlabel: string }>(
        `select enumlabel from pg_enum
          join pg_type on pg_type.oid=enumtypid
         where typname='collaboration_thread_kind'`
      );
      expect(enumLabels.rows.map((row) => row.enumlabel)).toContain(
        "team_project_channel"
      );

      await runDbMigrations(t06Pool);
      const completedUpgrade = await t06Pool.query<{
        created_at: string;
        project_table: string | null;
      }>(`select
          (select max(created_at)::text from drizzle.__drizzle_migrations) as created_at,
          to_regclass('public.collaboration_team_shared_projects')::text as project_table`);
      expect(completedUpgrade.rows[0]).toEqual({
        created_at: String(journal.entries[latestIndex]!.when),
        project_table: "collaboration_team_shared_projects"
      });

      const freshUrl = new URL(databaseUrl!);
      freshUrl.pathname = `/${freshName}`;
      const freshPool = createDbPool({ connectionString: freshUrl.toString() });
      pools.push(freshPool);
      await Promise.all([
        runDbMigrations(freshPool),
        runDbMigrations(freshPool)
      ]);
      const fresh = await freshPool.query<{ created_at: string }>(
        `select max(created_at)::text as created_at from drizzle.__drizzle_migrations`
      );
      expect(fresh.rows[0]?.created_at).toBe(
        String(journal.entries[latestIndex]!.when)
      );
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      for (const folder of temporaryFolders) {
        await rm(folder, { recursive: true, force: true });
      }
      if (adminConnected) {
        for (const name of databaseNames) {
          await admin.query(
            `drop database if exists ${quoteIdentifier(name)} with (force)`
          );
        }
        await admin.end();
      }
    }
  });
});
