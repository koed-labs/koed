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
    // Keep concurrent startup attempts on one migration history.
    await client.query(
      "select pg_advisory_lock(hashtext('koed:db:migrations'))"
    );
    const ledger = await client.query<{ present: boolean }>(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as present"
    );
    if (ledger.rows[0]?.present) {
      const applied = await client.query<{ hash: string }>(
        "select hash from drizzle.__drizzle_migrations order by id"
      );
      const knownHashes = new Set(
        migrations.map((migration) => migration.hash)
      );
      if (
        applied.rows.some(
          (row, index) =>
            !knownHashes.has(row.hash) || row.hash !== migrations[index]?.hash
        )
      ) {
        throw new Error(
          "Database migration history does not match this build. Preserve the database and reconcile a verified unreleased Project history with the Local Operator Script before retrying."
        );
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
