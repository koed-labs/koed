#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { loadRootEnv } from "../../../scripts/api-token-bootstrap-lib.mjs";
import { reconcileProjectBranchMigrations } from "../dist/project-migration-reconciliation.js";
import {
  unreleasedProjectMigrationHistory,
  preMainConsolidatedProjectMigrationHistory
} from "../dist/project-migration-history.js";
import { runPostgresTool } from "./postgres-tool.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadRootEnv(resolve(packageDir, "../.."), process.env);
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help")) {
  console.log(
    "Reconcile the exact unreleased Project history on a local database.\nUsage: pnpm db:migrate:reconcile-projects --backup /absolute/path/pre-cleanup.dump\nUses DATABASE_URL; creates and validates a private full backup before changing the schema or ledger."
  );
} else {
  const run = async () => {
    if (args.length !== 2 || args[0] !== "--backup")
      throw new Error(
        "Provide --backup <new backup path>. Existing backup files are never overwritten."
      );
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new Error("DATABASE_URL is required.");
    const url = new URL(connection);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error(
        "This unreleased-history utility accepts local databases only."
      );
    const profile = process.env.KOED_DEPLOYMENT_PROFILE?.trim() ?? "developer";
    if (
      process.env.NODE_ENV === "production" ||
      !["developer", "local_personal"].includes(profile)
    )
      throw new Error(
        "Unreleased Project reconciliation requires a local development profile."
      );
    const pool = new pg.Pool({ connectionString: connection });
    try {
      const actual = (
        await pool.query(
          "select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id"
        )
      ).rows.map((row) => [row.hash, row.created_at]);
      const canonical = readMigrationFiles({
        migrationsFolder: resolve(packageDir, "drizzle")
      }).map((migration) => [migration.hash, String(migration.folderMillis)]);
      if (JSON.stringify(actual) === JSON.stringify(canonical)) {
        console.log(JSON.stringify({ status: "already_current" }));
        return;
      }
      if (
        JSON.stringify(actual) !==
          JSON.stringify(unreleasedProjectMigrationHistory) &&
        JSON.stringify(actual) !==
          JSON.stringify(preMainConsolidatedProjectMigrationHistory)
      )
        throw new Error(
          "Unrecognized migration history. No schema or ledger changes were made."
        );
      const backupPath = resolve(args[1]);
      await mkdir(dirname(backupPath), { recursive: true });
      const reserved = await open(backupPath, "wx", 0o600);
      await reserved.close();
      await runPostgresTool(
        process.env.PG_DUMP_BIN ?? "pg_dump",
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          "--file",
          backupPath
        ],
        connection
      );
      const contents = await runPostgresTool(
        process.env.PG_RESTORE_BIN ?? "pg_restore",
        ["--list", backupPath],
        connection
      );
      if (
        !contents.includes("TABLE public users ") ||
        !contents.includes("TABLE drizzle __drizzle_migrations ")
      )
        throw new Error(
          "Backup validation failed; the required tables are missing. No reconciliation was attempted."
        );
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(backupPath))
        hash.update(chunk);
      const sha256 = hash.digest("hex");
      await writeFile(
        `${backupPath}.json`,
        JSON.stringify(
          {
            database: decodeURIComponent(url.pathname.slice(1)),
            host: url.hostname,
            port: url.port || "5432",
            createdAt: new Date().toISOString(),
            sourceMigrationCount: actual.length,
            sha256
          },
          null,
          2
        ) + "\n",
        { flag: "wx", mode: 0o600 }
      );
      const result = await reconcileProjectBranchMigrations(pool, {
        backupPath
      });
      console.log(
        JSON.stringify({
          status: result.reconciled ? "reconciled" : "already_current",
          backupPath,
          sha256
        })
      );
    } finally {
      await pool.end();
    }
  };
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
