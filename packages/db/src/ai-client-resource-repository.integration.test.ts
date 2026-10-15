import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  createAiClientResourceRepository,
  type AiClientResourceDiscoveryTarget
} from "./ai-client-resource-repository.js";

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

  const fixture = async (remote = false) => {
    if (!pool) throw new Error("Test database URL unavailable");
    const ownerId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = `device-${randomUUID()}`;
    const credentialId = remote
      ? randomUUID()
      : "00000000-0000-0000-0000-000000000000";
    const instanceId = `codex-${randomUUID()}`;
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,'Resource owner')",
      [ownerId, `${ownerId}@resource.invalid`]
    );
    if (remote)
      await pool.query(
        `insert into device_credentials
           (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
            verifier_kind,verifier_hash,operation_families,metadata)
         values($1,$2,$3,'test-backend',$4,'secret_hash',$5,ARRAY['managed_execution'],$6)`,
        [
          credentialId,
          ownerId,
          `key-${randomUUID()}`,
          deviceId,
          "a".repeat(64),
          JSON.stringify({ protocolDeploymentId: deploymentId })
        ]
      );
    await pool.query(
      `insert into ai_client_instances
         (owner_user_id,instance_id,source_device_credential_id,driver_id,display_name)
       values($1,$2,$3,'codex','Codex')`,
      [ownerId, instanceId, credentialId]
    );
    const target: AiClientResourceDiscoveryTarget = {
      ownerUserId: ownerId,
      aiClientInstanceId: instanceId,
      sourceDeviceCredentialId: credentialId,
      hostedInstanceId: instanceId,
      provider: "codex",
      computerLabel: null,
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId
    };
    const repository = createAiClientResourceRepository(pool);
    const request = { target, projectId: null, requestId: randomUUID() };
    const operation = await repository.createAiClientResourceDiscoveryOperation(
      { userId: ownerId },
      request
    );
    const runner = {
      ownerUserId: ownerId,
      deploymentId,
      deviceId,
      runnerId: `runner-${randomUUID()}`,
      limit: 1,
      leaseMs: 60_000
    };
    const claim = async () => {
      const [claimed] =
        await repository.claimAiClientResourceDiscoveryOperations(runner);
      expect(claimed).toBeDefined();
      return {
        operationId: operation.operationId,
        ownerUserId: ownerId,
        deploymentId,
        deviceId,
        runnerId: runner.runnerId,
        leaseToken: claimed!.leaseToken,
        revision: claimed!.revision
      };
    };
    const catalog = {
      version: 1 as const,
      provider: "codex" as const,
      aiClientInstanceId: instanceId,
      hostedInstanceId: instanceId,
      computerLabel: null,
      projectId: null,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resources: []
    };
    return {
      ownerId,
      credentialId,
      instanceId,
      repository,
      request,
      operation,
      runner,
      claim,
      catalog
    };
  };

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

  beforeAll(async () => {
    if (!admin || !pool) throw new Error("Test database URL unavailable");
    await admin.connect();
    adminConnected = true;
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);
  });

  it("creates a scoped operation without conflicting PostgreSQL parameter types", async () => {
    if (!pool) throw new Error("Test database URL unavailable");
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

  it("keeps request replay idempotent and rejects a changed scope or another owner", async () => {
    const f = await fixture();
    const replay = await f.repository.createAiClientResourceDiscoveryOperation(
      { userId: f.ownerId },
      f.request
    );
    expect(replay.operationId).toBe(f.operation.operationId);
    await expect(
      f.repository.createAiClientResourceDiscoveryOperation(
        { userId: f.ownerId },
        { ...f.request, projectId: `lp_${"a".repeat(32)}` }
      )
    ).rejects.toThrow("AI_CLIENT_RESOURCE_REQUEST_CONFLICT");
    expect(
      await f.repository.getAiClientResourceDiscoveryOperation(
        { userId: randomUUID() },
        { operationId: f.operation.operationId }
      )
    ).toBeNull();
    expect(
      await f.repository.claimAiClientResourceDiscoveryOperations({
        ...f.runner,
        deviceId: "other-device"
      })
    ).toEqual([]);
  });

  it("fences completion by lease and exact catalog scope, then returns the owner catalog", async () => {
    const f = await fixture();
    const lease = await f.claim();
    expect(
      await f.repository.completeAiClientResourceDiscoveryOperation({
        ...lease,
        leaseToken: randomUUID(),
        catalog: f.catalog
      })
    ).toBeNull();
    expect(
      await f.repository.completeAiClientResourceDiscoveryOperation({
        ...lease,
        catalog: { ...f.catalog, hostedInstanceId: "another-client" }
      })
    ).toBeNull();
    expect(
      await f.repository.heartbeatAiClientResourceDiscoveryOperation({
        ...lease,
        leaseMs: 60_000
      })
    ).toBe(true);
    expect(
      await f.repository.completeAiClientResourceDiscoveryOperation({
        ...lease,
        catalog: f.catalog
      })
    ).toMatchObject({ state: "completed", catalog: f.catalog });
    expect(
      await f.repository.getAiClientResourceDiscoveryOperation(
        { userId: f.ownerId },
        { operationId: f.operation.operationId }
      )
    ).toMatchObject({ state: "completed" });
    await pool!.query(
      "update ai_client_instances set enabled=false where owner_user_id=$1",
      [f.ownerId]
    );
    expect(
      await f.repository.getAiClientResourceDiscoveryOperation(
        { userId: f.ownerId },
        { operationId: f.operation.operationId }
      )
    ).toBeNull();
  });

  it.each(["disabled", "revoked", "expired", "permission_removed"])(
    "blocks in-flight discovery after access becomes %s",
    async (change) => {
      const f = await fixture(true);
      const lease = await f.claim();
      if (change === "disabled")
        await pool!.query(
          "update ai_client_instances set enabled=false where owner_user_id=$1",
          [f.ownerId]
        );
      else if (change === "revoked")
        await pool!.query(
          "update device_credentials set revoked_at=now() where id=$1",
          [f.credentialId]
        );
      else if (change === "expired")
        await pool!.query(
          "update device_credentials set expires_at=now()-interval '1 second' where id=$1",
          [f.credentialId]
        );
      else
        await pool!.query(
          "update device_credentials set operation_families=ARRAY['other_operation'] where id=$1",
          [f.credentialId]
        );
      expect(
        await f.repository.heartbeatAiClientResourceDiscoveryOperation({
          ...lease,
          leaseMs: 60_000
        })
      ).toBe(false);
      expect(
        await f.repository.completeAiClientResourceDiscoveryOperation({
          ...lease,
          catalog: f.catalog
        })
      ).toBeNull();
      expect(
        await f.repository.getAiClientResourceDiscoveryOperation(
          { userId: f.ownerId },
          { operationId: f.operation.operationId }
        )
      ).toBeNull();
      expect(
        await f.repository.claimAiClientResourceDiscoveryOperations(f.runner)
      ).toEqual([]);
    }
  );

  it("reclaims expired work with a new lease and refuses the old runner result", async () => {
    const f = await fixture();
    const old = await f.claim();
    await pool!.query(
      "update ai_client_resource_discovery_operations set lease_expires_at=now()-interval '1 second' where id=$1",
      [f.operation.operationId]
    );
    const current = await f.claim();
    expect(current.revision).toBeGreaterThan(old.revision);
    expect(
      await f.repository.completeAiClientResourceDiscoveryOperation({
        ...old,
        catalog: f.catalog
      })
    ).toBeNull();
    expect(
      await f.repository.completeAiClientResourceDiscoveryOperation({
        ...current,
        catalog: f.catalog
      })
    ).toMatchObject({ state: "completed" });
  });
});
