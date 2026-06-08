#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(packageDir, "../..");
const command = process.argv[2];
const commandArgs = process.argv.slice(3);

if (!command) {
  console.error(
    "Usage: node packages/db/scripts/with-temp-db.mjs <command> [...args]"
  );
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    [
      "DATABASE_URL is required for DB-backed verification.",
      "Run `pnpm env:setup` and start Postgres, or set DATABASE_URL explicitly."
    ].join("\n")
  );
  process.exit(2);
}

const targetDatabase =
  process.env.KOED_VERIFY_DATABASE ??
  `koed_verify_${process.pid}_${Date.now().toString(36)}`;

if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(targetDatabase)) {
  console.error(
    `Unsafe verify database name: ${JSON.stringify(targetDatabase)}`
  );
  process.exit(2);
}

const adminDatabase =
  process.env.KOED_VERIFY_ADMIN_DATABASE ??
  process.env.KOED_MIGRATION_SMOKE_ADMIN_DATABASE ??
  "postgres";

const withDatabase = (connectionString, database) => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
};

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

const admin = new Client({
  connectionString: withDatabase(databaseUrl, adminDatabase)
});
const targetUrl = withDatabase(databaseUrl, targetDatabase);

await admin.connect();

try {
  await admin.query(
    `drop database if exists ${quoteIdentifier(targetDatabase)} with (force)`
  );
  await admin.query(`create database ${quoteIdentifier(targetDatabase)}`);

  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    env: { ...process.env, DATABASE_URL: targetUrl },
    stdio: "inherit"
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exitCode = result.status ?? 1;
} finally {
  await admin.query(
    `drop database if exists ${quoteIdentifier(targetDatabase)} with (force)`
  );
  await admin.end();
}
