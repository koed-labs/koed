import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createAiClientResourceRepository } from "./ai-client-resource-repository.js";

const baseUrl = process.env.AI_CLIENT_RESOURCE_TEST_DATABASE_URL;
const databaseName = `koed_ai_resource_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)("AI Client resource discovery (PostgreSQL)", () => {
  const configured = baseUrl ? new URL(baseUrl) : null;
  const adminUrl = configured ? new URL(configured) : null;
  if (adminUrl) adminUrl.pathname = "/postgres";
  const testUrl = configured ? new URL(configured) : null;
  if (testUrl) testUrl.pathname = `/${databaseName}`;
  const admin = adminUrl
    ? new pg.Client({ connectionString: adminUrl.toString() })
    : null;
  const pool = testUrl
    ? new pg.Pool({ connectionString: testUrl.toString() })
    : null;
  let adminConnected = false;

  afterAll(async () => {
    await pool?.end();
    if (!admin || !adminConnected) return;
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
        [databaseName]
      );
      await admin.query(`drop database if exists "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  it("creates a scoped operation without conflicting PostgreSQL parameter types", async () => {
    if (!admin || !pool) throw new Error("Test database URL unavailable");
    await admin.connect();
    adminConnected = true;
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);

    const ownerId = randomUUID();
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,$3)",
      [ownerId, `${ownerId}@ai-client-resource.invalid`, "Resource owner"]
    );
    await pool.query(
      `insert into ai_client_instances
         (owner_user_id,instance_id,source_device_credential_id,driver_id,display_name)
       values($1,'codex.default','00000000-0000-0000-0000-000000000000','codex','Codex')`,
      [ownerId]
    );

    const deploymentId = randomUUID();
    const repository = createAiClientResourceRepository(pool);
    const operation = await repository.createAiClientResourceDiscoveryOperation(
      { userId: ownerId },
      {
        target: {
          ownerUserId: ownerId,
          aiClientInstanceId: "codex.default",
          sourceDeviceCredentialId: "00000000-0000-0000-0000-000000000000",
          hostedInstanceId: "codex.default",
          provider: "codex",
          computerLabel: null,
          targetDeviceId: "local-device-test",
          targetDeploymentId: deploymentId
        },
        projectId: null,
        requestId: randomUUID()
      }
    );

    expect(operation).toMatchObject({
      hostedInstanceId: "codex.default",
      projectId: null,
      state: "pending",
      revision: 1
    });
  });
});
