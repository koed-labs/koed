import pg from "pg";
import { createDb } from "../dist/connection.js";
import { createUserApiTokenRepository } from "../dist/user-api-token-repository.js";

const { Pool } = pg;

export const createApiTokenScriptRepo = (connectionString) => {
  const pool = new Pool({ connectionString });
  const db = createDb(pool);
  const repo = createUserApiTokenRepository(db);

  return {
    ...repo,

    async close() {
      await pool.end();
    }
  };
};
