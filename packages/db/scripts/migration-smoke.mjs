#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadRootEnv } from "../../../scripts/api-token-bootstrap-lib.mjs";
import {
  getLatestMigrationTimestamp,
  runDbMigrations
} from "../dist/migrate.js";

const { Client, Pool } = pg;

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(packageDir, "../..");

loadRootEnv(rootDir, process.env);

const databaseUrl =
  process.env.KOED_MIGRATION_SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "DATABASE_URL is required for the migration smoke test. Point it at a Postgres server whose user can create and drop databases."
  );
  process.exit(2);
}

const targetDatabase =
  process.env.KOED_MIGRATION_SMOKE_DATABASE ??
  `koed_migration_smoke_${process.pid}_${Date.now().toString(36)}`;

if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(targetDatabase)) {
  console.error(
    `Unsafe migration smoke database name: ${JSON.stringify(targetDatabase)}`
  );
  process.exit(2);
}

const adminDatabase =
  process.env.KOED_MIGRATION_SMOKE_ADMIN_DATABASE ?? "postgres";

const withDatabase = (connectionString, database) => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
};

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

const isPostgresAdminTermination = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "57P01";

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

  const pool = new Pool({ connectionString: targetUrl });
  let poolClosing = false;
  let unexpectedPoolError;

  pool.on("error", (error) => {
    if (poolClosing && isPostgresAdminTermination(error)) {
      return;
    }
    unexpectedPoolError ??= error;
  });

  const throwUnexpectedPoolError = () => {
    if (unexpectedPoolError) {
      throw unexpectedPoolError;
    }
  };

  try {
    await runDbMigrations(pool);
    throwUnexpectedPoolError();

    const expectedLatestMigrationTimestamp =
      await getLatestMigrationTimestamp();
    const migrationResult = await pool.query(
      `
        select coalesce(max(created_at), 0)::bigint as latest_migration
        from drizzle.__drizzle_migrations
      `
    );
    const tableResult = await pool.query(
      `
        select
          to_regclass('public.users') as users_table,
          to_regclass('drizzle.__drizzle_migrations') as migrations_table
      `
    );
    throwUnexpectedPoolError();

    const actualLatestMigrationTimestamp = BigInt(
      migrationResult.rows[0]?.latest_migration ?? 0
    );
    if (
      actualLatestMigrationTimestamp < BigInt(expectedLatestMigrationTimestamp)
    ) {
      throw new Error(
        `Latest applied migration ${actualLatestMigrationTimestamp.toString()} is older than expected ${expectedLatestMigrationTimestamp}`
      );
    }

    const tables = tableResult.rows[0];
    if (tables?.users_table !== "users") {
      throw new Error("Migration smoke test did not create public.users");
    }
    if (tables?.migrations_table !== "drizzle.__drizzle_migrations") {
      throw new Error(
        "Migration smoke test did not create drizzle.__drizzle_migrations"
      );
    }

    console.log(
      JSON.stringify(
        {
          database: targetDatabase,
          latestMigration: actualLatestMigrationTimestamp.toString(),
          usersTable: tables.users_table,
          migrationsTable: tables.migrations_table
        },
        null,
        2
      )
    );
  } finally {
    poolClosing = true;
    await pool.end();
  }
} finally {
  await admin.query(
    `drop database if exists ${quoteIdentifier(targetDatabase)} with (force)`
  );
  await admin.end();
}
