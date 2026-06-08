import pg from "pg";
import { createDb } from "../dist/connection.js";
import { createUserApiTokenRepository } from "../dist/user-api-token-repository.js";

const { Pool } = pg;

export const createApiTokenScriptRepo = (connectionString) => {
  const pool = new Pool({ connectionString });
  const repo = createUserApiTokenRepository(createDb(pool));

  return {
    ...repo,

    async close() {
      await pool.end();
    }
  };
};
