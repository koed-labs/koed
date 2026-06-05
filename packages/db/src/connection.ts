import pg from "pg";
import { env } from "@koed/shared";

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
}

export const createDbPool = (config: DbConfig = {}): pg.Pool =>
  new Pool({
    connectionString: config.connectionString ?? env("DATABASE_URL")
  });

export const checkDatabase = async (pool: pg.Pool): Promise<boolean> => {
  const result = await pool.query<{ ok: number }>("select 1 as ok");
  return result.rows[0]?.ok === 1;
};
