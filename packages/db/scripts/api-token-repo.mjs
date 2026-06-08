import pg from "pg";
import { createAuditRepository } from "../dist/audit-repository.js";
import { createDb } from "../dist/connection.js";
import { createUserApiTokenRepository } from "../dist/user-api-token-repository.js";

const { Pool } = pg;

export const createApiTokenScriptRepo = (connectionString) => {
  const pool = new Pool({ connectionString });
  const db = createDb(pool);
  const repo = {
    ...createUserApiTokenRepository(db),
    ...createAuditRepository(db)
  };

  return {
    ...repo,

    async close() {
      await pool.end();
    }
  };
};
