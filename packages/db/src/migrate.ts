import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, waitForDbMigrations } from "./connection.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsFolder = join(currentDir, "..", "drizzle");

export interface RunDbMigrationsOptions {
  migrationsFolder?: string;
}

interface DrizzleJournal {
  entries?: { when?: number }[];
}

export const getLatestMigrationTimestamp = async (
  migrationsFolder = defaultMigrationsFolder
): Promise<number> => {
  const journalText = await readFile(
    join(migrationsFolder, "meta", "_journal.json"),
    "utf8"
  );
  const journal: DrizzleJournal = JSON.parse(journalText);
  return Math.max(
    0,
    ...(journal.entries ?? []).map((entry) => entry.when ?? 0)
  );
};

export const runDbMigrations = async (
  pool: pg.Pool,
  options: RunDbMigrationsOptions = {}
): Promise<void> => {
  await migrate(createDb(pool), {
    migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder
  });
};

export const waitForCurrentDbMigrations = async (
  pool: pg.Pool,
  options: RunDbMigrationsOptions = {}
): Promise<void> => {
  await waitForDbMigrations(pool, {
    expectedLatestMigrationTimestamp: await getLatestMigrationTimestamp(
      options.migrationsFolder
    )
  });
};
