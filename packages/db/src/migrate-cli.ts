import { createDbPool } from "./connection.js";
import { runDbMigrations } from "./migrate.js";

const pool = createDbPool();

try {
  await runDbMigrations(pool);
} finally {
  await pool.end();
}
