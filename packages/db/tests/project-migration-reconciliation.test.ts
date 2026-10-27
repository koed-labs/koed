import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createDbPool, runDbMigrations } from "../src/index.js";
import * as migrationSchema from "../src/migration-schema.js";
const realFingerprint = migrationSchema.migrationSchemaFingerprint;
import { reconcileProjectBranchMigrations } from "../src/project-migration-reconciliation.js";
import {
  unreleasedProjectMigrationHistory,
  unreleasedProjectSchemaFingerprint,
  consolidatedProjectSchemaFingerprint,
  preMainConsolidatedProjectMigrationHistory,
  preMainConsolidatedProjectSchemaFingerprint
} from "../src/project-migration-history.js";

const databaseUrl = process.env.MERGED_MIGRATIONS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "unreleased Project migration reconciliation",
  () => {
    it.each([
      "preserve",
      "preserve consolidated",
      "unknown history",
      "retained upgrade",
      "unpreserved route",
      "changed function",
      "dependent object",
      "rollback after cleanup",
      "missing backup"
    ] as const)(
      "%s",
      async (scenario) => {
        const admin = createDbPool({ connectionString: databaseUrl });
        const name = `project_history_${randomUUID().replaceAll("-", "")}`;
        const url = new URL(databaseUrl!);
        url.pathname = `/${name}`;
        const pool = createDbPool({ connectionString: url.toString() });
        const folder = await mkdtemp(
          fileURLToPath(
            new URL("../../../scratch/project-history-", import.meta.url)
          )
        );
        try {
          await admin.query(`create database "${name}"`);
          await runDbMigrations(pool);
          if (scenario !== "preserve consolidated")
            await pool.query(
              await readFile(
                new URL(
                  "./fixtures/unreleased-project-schema.sql",
                  import.meta.url
                ),
                "utf8"
              )
            );
          await pool.query(`alter table remote_mcp_oauth_grants
            drop constraint remote_mcp_external_registration_unique,
            drop constraint remote_mcp_grant_binding_check,
            drop constraint remote_mcp_grant_version_check,
            drop column provider_issuer, drop column provider_environment,
            drop column provider_registration_id, drop column provider_user_id,
            drop column provider_organization_id, drop column team_boundary_id,
            drop column authorization_version,
            alter column client_id set not null`);
          const oldHistory =
            scenario === "preserve consolidated"
              ? preMainConsolidatedProjectMigrationHistory
              : unreleasedProjectMigrationHistory;
          const canonical = (
            await pool.query<{ id: number }>(
              "select id from drizzle.__drizzle_migrations order by id"
            )
          ).rows;
          await pool.query(
            "delete from drizzle.__drizzle_migrations where id=any($1::int[])",
            [canonical.slice(46).map((row) => row.id)]
          );
          for (const [hash, when] of oldHistory.slice(46))
            await pool.query(
              "insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)",
              [hash, when]
            );
          const fingerprint = async () => {
            const client = await pool.connect();
            try {
              await client.query("begin read only");
              return await realFingerprint(client);
            } finally {
              await client.query("rollback");
              client.release();
            }
          };
          expect(await fingerprint()).toBe(
            scenario === "preserve consolidated"
              ? preMainConsolidatedProjectSchemaFingerprint
              : unreleasedProjectSchemaFingerprint
          );
          const owner = randomUUID();
          await pool.query("insert into users(id,email) values($1,$2)", [
            owner,
            `preserved-${owner}@example.test`
          ]);
          const sourceScope = "gr_retained_capture_source";
          if (scenario === "preserve" || scenario === "unpreserved route") {
            await pool.query(
              "alter table personal_project_routes disable trigger personal_legacy_route_write_guard"
            );
            await pool.query(
              "insert into personal_project_routes(owner_user_id,source_project_id,target_project_id,target_name,target_path,target_identity) values($1,$2,'retained-target','Retained Capture Target','/recorded/context',$3)",
              [
                owner,
                sourceScope,
                {
                  kind: "local_project",
                  key: "retained-target",
                  root: null,
                  branch: null,
                  checkoutId: null,
                  originatingDeviceId: "fixture-device",
                  selectedRemote: null,
                  anchorDisplay: null,
                  reason: "manual"
                }
              ]
            );
            await pool.query(
              "alter table personal_project_routes enable trigger personal_legacy_route_write_guard"
            );
            if (scenario === "preserve")
              await pool.query(
                "insert into personal_capture_target_routes(owner_user_id,source_scope,target_id,target_name,target_path,evidence) select owner_user_id,source_project_id,target_project_id,target_name,target_path,to_jsonb(r) from personal_project_routes r"
              );
          }
          if (scenario === "unknown history")
            await pool.query(
              "update drizzle.__drizzle_migrations set hash='unknown-history' where id=(select max(id) from drizzle.__drizzle_migrations)"
            );
          if (scenario === "retained upgrade")
            await pool.query(
              "insert into personal_project_upgrades(owner_user_id,profile_identity,catalog_hash,catalog) values($1,'retained-profile','retained-hash','{}')",
              [owner]
            );
          if (scenario === "changed function")
            await pool.query(
              "create or replace function personal_legacy_route_write_guard() returns trigger language plpgsql as $$ begin raise exception 'changed'; end $$"
            );
          if (scenario === "dependent object")
            await pool.query(
              "create schema kept; create view kept.upgrade_records as select * from personal_project_upgrades"
            );
          const beforeSchema = await fingerprint();
          const ledger = async () =>
            (
              await pool.query<{
                id: number;
                hash: string;
                created_at: string;
              }>("select * from drizzle.__drizzle_migrations order by id")
            ).rows;
          const beforeLedger = await ledger();
          const beforeRoutes = (
            await pool.query(
              "select * from personal_capture_target_routes order by owner_user_id,source_scope"
            )
          ).rows;
          const backupPath = join(folder, "before.dump");
          const backup = spawnSync(
            process.env.PG_DUMP_BIN ?? "pg_dump",
            [
              "--format=custom",
              "--no-owner",
              "--no-privileges",
              "--file",
              backupPath
            ],
            {
              env: {
                ...process.env,
                PGHOST: url.hostname,
                PGPORT: url.port || "5432",
                PGUSER: decodeURIComponent(url.username),
                PGPASSWORD: decodeURIComponent(url.password),
                PGDATABASE: name
              },
              encoding: "utf8"
            }
          );
          expect(backup.status, backup.stderr).toBe(0);
          const options = {
            backupPath:
              scenario === "missing backup"
                ? join(folder, "missing.dump")
                : backupPath
          };
          if (scenario === "preserve" || scenario === "preserve consolidated") {
            await expect(runDbMigrations(pool)).rejects.toThrow(
              "Preserve the database"
            );
            expect(
              await reconcileProjectBranchMigrations(pool, options)
            ).toEqual({ reconciled: true });
            expect(await fingerprint()).toBe(
              consolidatedProjectSchemaFingerprint
            );
            expect(
              (await pool.query("select id from users where id=$1", [owner]))
                .rows
            ).toEqual([{ id: owner }]);
            expect(
              (
                await pool.query(
                  "select * from personal_capture_target_routes order by owner_user_id,source_scope"
                )
              ).rows
            ).toEqual(beforeRoutes);
            expect((await ledger()).slice(0, 46)).toEqual(
              beforeLedger.slice(0, 46)
            );
            await runDbMigrations(pool);
            const after = await ledger();
            expect(after).toHaveLength(50);
            expect(
              await reconcileProjectBranchMigrations(pool, options)
            ).toEqual({ reconciled: false });
            expect(await ledger()).toEqual(after);
          } else {
            const failure = {
              "unknown history": "Unrecognized migration history",
              "retained upgrade": "Retained upgrade evidence",
              "unpreserved route": "exact preserved Capture Target",
              "changed function": "schema differs",
              "dependent object": "depend",
              "rollback after cleanup":
                "Consolidated schema verification failed",
              "missing backup": "ENOENT"
            }[scenario];
            const verification =
              scenario === "rollback after cleanup"
                ? vi
                    .spyOn(migrationSchema, "migrationSchemaFingerprint")
                    .mockImplementationOnce(realFingerprint)
                    .mockResolvedValueOnce("deliberate-post-cleanup-mismatch")
                : undefined;
            try {
              await expect(
                reconcileProjectBranchMigrations(pool, options)
              ).rejects.toThrow(failure);
              if (verification) expect(verification).toHaveBeenCalledTimes(2);
            } finally {
              verification?.mockRestore();
            }
            expect(await fingerprint()).toBe(beforeSchema);
            expect(await ledger()).toEqual(beforeLedger);
            expect(
              (await pool.query("select id from users where id=$1", [owner]))
                .rows
            ).toEqual([{ id: owner }]);
            expect(
              (
                await pool.query(
                  "select * from personal_capture_target_routes order by owner_user_id,source_scope"
                )
              ).rows
            ).toEqual(beforeRoutes);
          }
        } finally {
          await pool.end();
          await admin.query(`drop database if exists "${name}" with(force)`);
          await admin.end();
          await rm(folder, { recursive: true, force: true });
        }
      },
      120_000
    );
  }
);
