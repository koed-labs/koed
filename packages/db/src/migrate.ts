import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createDb, waitForDbMigrations } from "./connection.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsFolder = join(currentDir, "..", "drizzle");

export interface RunDbMigrationsOptions {
  migrationsFolder?: string;
}

interface DrizzleJournal {
  entries?: { when?: number }[];
}

const isDrizzleJournal = (value: unknown): value is DrizzleJournal => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("entries" in value)) {
    return true;
  }
  const entries = value.entries;
  return (
    Array.isArray(entries) &&
    entries.every((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const candidate = entry as Record<string, unknown>;
      return !("when" in candidate) || typeof candidate.when === "number";
    })
  );
};

export const getLatestMigrationTimestamp = async (
  migrationsFolder = defaultMigrationsFolder
): Promise<number> => {
  const journalText = await readFile(
    join(migrationsFolder, "meta", "_journal.json"),
    "utf8"
  );
  const journal: unknown = JSON.parse(journalText);
  if (!isDrizzleJournal(journal)) {
    throw new Error("Drizzle migration journal has an unexpected format");
  }
  return Math.max(
    0,
    ...(journal.entries ?? []).map((entry) => entry.when ?? 0)
  );
};

export const runDbMigrations = async (
  pool: pg.Pool,
  options: RunDbMigrationsOptions = {}
): Promise<void> => {
  const config = {
    migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder
  };
  const migrations = readMigrationFiles(config);
  const client = await pool.connect();
  try {
    // Serialize gap repair and the normal timestamp-based migrator together.
    await client.query(
      "select pg_advisory_lock(hashtext('koed:db:migrations'))"
    );
    const ledger = await client.query<{ present: boolean }>(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as present"
    );
    if (ledger.rows[0]?.present) {
      const applied = await client.query<{ hash: string; created_at: string }>(
        "select hash, created_at::text from drizzle.__drizzle_migrations"
      );
      const hashes = new Set(applied.rows.map((row) => row.hash));
      const latest = Math.max(
        0,
        ...applied.rows.map((row) => Number(row.created_at))
      );
      // Independently developed migrations can precede an already-applied main
      // migration. Drizzle's timestamp cursor would silently skip those gaps.
      const gaps = migrations.filter(
        (migration) =>
          migration.folderMillis <= latest && !hashes.has(migration.hash)
      );
      if (gaps.length) {
        await client.query("begin");
        try {
          for (const migration of gaps) {
            for (const statement of migration.sql)
              await client.query(statement);
            await client.query(
              "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
              [migration.hash, migration.folderMillis]
            );
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    }
    await migrate(createDb(client), config);
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

export const waitForCurrentDbMigrations = async (
  pool: pg.Pool,
  options: RunDbMigrationsOptions = {}
): Promise<void> => {
  await waitForDbMigrations(pool, {
    expectedLatestMigrationTimestamp: await getLatestMigrationTimestamp(
      options.migrationsFolder
    ),
    expectedMigrationHashes: [
      ...new Set(
        readMigrationFiles({
          migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder
        }).map((migration) => migration.hash)
      )
    ]
  });
};
