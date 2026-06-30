#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  FIXTURE_VERSION,
  resetFixture,
  seedFixture,
  validateFixture
} from "./team-saas-fixture-lib.mjs";
import { loadRootEnv } from "./api-token-bootstrap-lib.mjs";

const requireFromDbPackage = createRequire(resolve("packages/db/package.json"));
const pg = requireFromDbPackage("pg");

const usage = `Usage: pnpm team-fixture:<command>

Commands:
  pnpm team-fixture:reset      Remove only ${FIXTURE_VERSION} rows
  pnpm team-fixture:seed       Reset and seed ${FIXTURE_VERSION}
  pnpm team-fixture:validate   Validate ${FIXTURE_VERSION} access expectations

Environment:
  DATABASE_URL must point at the Koed database to mutate or validate.
`;

const command = process.argv[2];

if (!command || command === "--help" || command === "-h") {
  process.stdout.write(usage);
  process.exit(command ? 0 : 2);
}

loadRootEnv(process.cwd(), process.env);

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required. Run pnpm env:setup or set it.");
  process.exit(2);
}

const runMigrations = () => {
  const result = spawnSync("pnpm", ["--filter", "@koed/db", "migrate:up"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

if (command === "seed") {
  runMigrations();
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();

  if (command === "reset") {
    await resetFixture(client);
    console.log(`Reset ${FIXTURE_VERSION} fixture rows.`);
  } else if (command === "seed") {
    await seedFixture(client);
    console.log(`Seeded ${FIXTURE_VERSION} fixture rows.`);
    const result = await validateFixture(client);
    console.log(
      `Validated ${result.users} users, ${result.workspaces} Workspaces, and ${result.memories} memories.`
    );
  } else if (command === "validate") {
    const result = await validateFixture(client);
    console.log(`Validated ${FIXTURE_VERSION}:`);
    for (const check of result.checks) {
      console.log(`- ${check}`);
    }
  } else {
    console.error(`Unknown Team SaaS fixture command: ${command}`);
    process.stderr.write(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
