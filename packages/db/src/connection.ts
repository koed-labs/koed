import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { env } from "@koed/shared";
import * as schema from "./schema.js";

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
  onPoolError?: (error: Error) => void;
}

export type DbPool = pg.Pool;
export type KoedDb = NodePgDatabase<typeof schema>;

export const createDbPool = (config: DbConfig = {}): pg.Pool => {
  const pool = new Pool({
    connectionString: config.connectionString ?? env("DATABASE_URL")
  });
  const reportedErrors = new WeakSet<object>();
  const reportError = (error: Error) => {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
    config.onPoolError?.(error);
  };
  pool.on("connect", (client) => client.on("error", reportError));
  pool.on("error", reportError);
  return pool;
};

export const databaseErrorCode = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unknown";
  return /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
};

export const createDb = (pool: pg.Pool | pg.PoolClient): KoedDb =>
  drizzle(pool, { schema });

export const checkDatabase = async (pool: pg.Pool): Promise<boolean> => {
  const result = await pool.query<{ ok: number }>("select 1 as ok");
  return result.rows[0]?.ok === 1;
};

export const checkDatabaseMigrated = async (
  pool: pg.Pool,
  expectedLatestMigrationTimestamp?: number
): Promise<boolean> => {
  try {
    if (expectedLatestMigrationTimestamp !== undefined) {
      const result = await pool.query<{ migrated: boolean }>(
        `
          select coalesce(max(created_at), 0)::bigint >= $1::bigint as migrated
          from drizzle.__drizzle_migrations
        `,
        [expectedLatestMigrationTimestamp]
      );
      return result.rows[0]?.migrated === true;
    }

    const result = await pool.query<{ migrated: boolean }>(
      `
        select exists (
          select 1
          from drizzle.__drizzle_migrations
        ) as migrated
      `
    );
    return result.rows[0]?.migrated === true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : null;
    if (code === "42P01" || code === "3F000") {
      return false;
    }
    throw error;
  }
};

export interface DatabaseReadiness {
  reachable: boolean;
  migrationsCurrent: boolean;
  postgresVersionNum: number | null;
  postgresVersion: string | null;
  postgresCompatible: boolean;
  pgvectorInstalled: boolean;
  pgvectorVersion: string | null;
}

export interface InspectDatabaseReadinessOptions {
  expectedLatestMigrationTimestamp?: number;
  minimumPostgresVersionNum?: number;
}

export const inspectDatabaseReadiness = async (
  pool: pg.Pool,
  options: InspectDatabaseReadinessOptions = {}
): Promise<DatabaseReadiness> => {
  const minimumPostgresVersionNum = options.minimumPostgresVersionNum ?? 140000;
  const [version, pgvector, migrationsCurrent] = await Promise.all([
    pool.query<{ version_num: string; version: string }>(
      "select current_setting('server_version_num') as version_num, version() as version"
    ),
    pool.query<{ extversion: string }>(
      "select extversion from pg_extension where extname = 'vector'"
    ),
    checkDatabaseMigrated(pool, options.expectedLatestMigrationTimestamp)
  ]);
  const postgresVersionNum = Number.parseInt(
    version.rows[0]?.version_num ?? "0",
    10
  );
  return {
    reachable: true,
    migrationsCurrent,
    postgresVersionNum: Number.isFinite(postgresVersionNum)
      ? postgresVersionNum
      : null,
    postgresVersion: version.rows[0]?.version ?? null,
    postgresCompatible:
      Number.isFinite(postgresVersionNum) &&
      postgresVersionNum >= minimumPostgresVersionNum,
    pgvectorInstalled: Boolean(pgvector.rows[0]?.extversion),
    pgvectorVersion: pgvector.rows[0]?.extversion ?? null
  };
};

export interface WaitForDbMigrationsOptions {
  timeoutMs?: number;
  intervalMs?: number;
  expectedLatestMigrationTimestamp?: number;
}

export const waitForDbMigrations = async (
  pool: pg.Pool,
  options: WaitForDbMigrationsOptions = {}
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      if (
        await checkDatabaseMigrated(
          pool,
          options.expectedLatestMigrationTimestamp
        )
      ) {
        return;
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (code !== "42P01" && code !== "3F000") {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        "Timed out waiting for Drizzle database migrations to complete"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
