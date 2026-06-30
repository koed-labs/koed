#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  assertLaunchValidationEnvironment,
  formatLaunchValidationReport,
  validateLaunchReadiness
} from "./team-saas-launch-validation-lib.mjs";
import { loadRootEnv } from "./api-token-bootstrap-lib.mjs";

const requireFromDbPackage = createRequire(resolve("packages/db/package.json"));
const pg = requireFromDbPackage("pg");

const usage = `Usage: pnpm team-launch:validate

Validates the seeded Team SaaS fixture and prints the launch validation gates.

Environment:
  DATABASE_URL must point at the Koed database to validate.
  API_TOKEN_PEPPER must be configured so fixture API sessions are seeded and validated.
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}

loadRootEnv(process.cwd(), process.env);

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required. Run pnpm env:setup or set it.");
  process.exit(2);
}

try {
  assertLaunchValidationEnvironment(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const summary = await validateLaunchReadiness(client);
  process.stdout.write(formatLaunchValidationReport(summary));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
