import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// This command is mandatory in CI. A missing service prerequisite must fail,
// rather than turn the two-user contract into a skipped or empty suite.
const databaseUrl = process.env.KOED_HQ713_TEST_DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write(
    "HQ two-user integration requires KOED_HQ713_TEST_DATABASE_URL.\n"
  );
  process.exit(1);
}
let validPostgres = false;
try {
  validPostgres = ["postgres:", "postgresql:"].includes(
    new URL(databaseUrl).protocol
  );
} catch {
  // Never echo an invalid URL: it may contain a test credential.
}
if (!validPostgres) {
  process.stderr.write("HQ two-user integration requires PostgreSQL.\n");
  process.exit(1);
}
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "apps/api/tests/hq-integration/hq713-two-user.integration.ts",
    "--config",
    "vitest.hq-two-user.config.ts"
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdio: "inherit"
  }
);
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
}
process.exit(result.status ?? 1);
