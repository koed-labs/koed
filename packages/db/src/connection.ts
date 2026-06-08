import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { env } from "@koed/shared";
import * as schema from "./schema.js";

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
}

export type KoedDb = NodePgDatabase<typeof schema>;

export const createDbPool = (config: DbConfig = {}): pg.Pool =>
  new Pool({
    connectionString: config.connectionString ?? env("DATABASE_URL")
  });

export const createDb = (pool: pg.Pool): KoedDb => drizzle(pool, { schema });

export const checkDatabase = async (pool: pg.Pool): Promise<boolean> => {
  const result = await pool.query<{ ok: number }>("select 1 as ok");
  return result.rows[0]?.ok === 1;
};

export const checkDatabaseMigrated = async (
  pool: pg.Pool,
  expectedLatestMigrationTimestamp?: number
): Promise<boolean> => {
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
