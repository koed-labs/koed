import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
  entries?: DrizzleJournalEntry[];
  [key: string]: unknown;
}

interface DrizzleJournalEntry {
  idx?: number;
  tag?: string;
  when?: number;
  breakpoints?: boolean;
  requiresCommittedBoundaryAfter?: boolean;
  [key: string]: unknown;
}

const migrationAdvisoryLockClass = 1_263_482_180;
const migrationAdvisoryLockId = 1_296_649_802;

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
      return (
        (!("when" in candidate) || typeof candidate.when === "number") &&
        (!("requiresCommittedBoundaryAfter" in candidate) ||
          typeof candidate.requiresCommittedBoundaryAfter === "boolean")
      );
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
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder;
  const journal = await readMigrationJournal(migrationsFolder);
  const commitBoundaries = (journal.entries ?? [])
    .map((entry, index) =>
      entry.requiresCommittedBoundaryAfter === true ? index : -1
    )
    .filter((index) => index >= 0);
  if (commitBoundaries.length > 1) {
    throw new Error(
      "runDbMigrations supports one committed enum migration boundary"
    );
  }
  const commitBoundaryIndex = commitBoundaries[0] ?? -1;
  const client = await pool.connect();
  let lockAcquired = false;
  let isolatedFolder: string | null = null;
  try {
    await client.query("select pg_advisory_lock($1::integer, $2::integer)", [
      migrationAdvisoryLockClass,
      migrationAdvisoryLockId
    ]);
    lockAcquired = true;
    const db = createDb(client);

    if (commitBoundaryIndex >= 0) {
      const boundary = journal.entries![commitBoundaryIndex]!;
      if (typeof boundary.when !== "number") {
        throw new Error(
          "Committed Drizzle migration boundary has no timestamp"
        );
      }
      const latestApplied = await latestAppliedMigrationTimestamp(client);
      if (latestApplied < BigInt(boundary.when)) {
        isolatedFolder = await createMigrationPrefix(
          migrationsFolder,
          journal,
          commitBoundaryIndex
        );
        await migrate(db, { migrationsFolder: isolatedFolder });
      }
    }

    await migrate(db, { migrationsFolder });
  } finally {
    try {
      if (isolatedFolder) {
        await rm(isolatedFolder, { recursive: true, force: true });
      }
    } catch {
      // Do not hide the migration result; the next run uses a new temporary folder.
    } finally {
      let releaseError: Error | undefined;
      try {
        if (lockAcquired) {
          await client.query(
            "select pg_advisory_unlock($1::integer, $2::integer)",
            [migrationAdvisoryLockClass, migrationAdvisoryLockId]
          );
        }
      } catch (error) {
        releaseError =
          error instanceof Error
            ? error
            : new Error("Could not release migration lock");
      } finally {
        client.release(releaseError);
      }
    }
  }
};

const readMigrationJournal = async (
  migrationsFolder: string
): Promise<DrizzleJournal> => {
  const journalText = await readFile(
    join(migrationsFolder, "meta", "_journal.json"),
    "utf8"
  );
  const journal: unknown = JSON.parse(journalText);
  if (!isDrizzleJournal(journal)) {
    throw new Error("Drizzle migration journal has an unexpected format");
  }
  return journal;
};

const latestAppliedMigrationTimestamp = async (
  client: pg.PoolClient
): Promise<bigint> => {
  const ledger = await client.query<{ relation: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations')::text as relation`
  );
  if (!ledger.rows[0]?.relation) return 0n;
  const latest = await client.query<{ created_at: string | null }>(
    `select max(created_at)::text as created_at from drizzle.__drizzle_migrations`
  );
  return BigInt(latest.rows[0]?.created_at ?? 0);
};

const createMigrationPrefix = async (
  sourceFolder: string,
  journal: DrizzleJournal,
  lastIndex: number
): Promise<string> => {
  const entries = journal.entries?.slice(0, lastIndex + 1) ?? [];
  if (entries.length !== lastIndex + 1) {
    throw new Error("Drizzle migration journal boundary index is invalid");
  }
  const folder = await mkdtemp(join(tmpdir(), "koed-migration-boundary-"));
  try {
    const metaFolder = join(folder, "meta");
    await mkdir(metaFolder, { recursive: true });
    for (const entry of entries) {
      if (typeof entry.tag !== "string") {
        throw new Error("Drizzle migration journal entry has no tag");
      }
      await copyFile(
        join(sourceFolder, `${entry.tag}.sql`),
        join(folder, `${entry.tag}.sql`)
      );
    }
    await writeFile(
      join(metaFolder, "_journal.json"),
      `${JSON.stringify({ ...journal, entries }, null, 2)}\n`
    );
    return folder;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
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
