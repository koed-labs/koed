import { createHash } from "node:crypto";
import pg from "pg";
import {
  aiClientResourceCatalogSchema,
  aiClientResourceDiscoveryOperationSchema,
  aiClientResourceDiscoveryRunnerClaimSchema,
  type AiClientResourceCatalog,
  type AiClientResourceDiscoveryOperation,
  type AiClientResourceDiscoveryRunnerClaim
} from "@koed/shared";
import type { ActorContext } from "./types.js";

type QueryClient = pg.Pool | pg.PoolClient;
const LOCAL_DEVICE_CREDENTIAL_ID = "00000000-0000-0000-0000-000000000000";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const replaceControlCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");
const fail = (code: string, statusCode = 409) =>
  Object.assign(new Error(code), { code, statusCode });
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const safeComputerLabel = (value: string | null): string | null => {
  if (!value) return null;
  const cleaned = replaceControlCharacters(value)
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,;]+[\\/])+[^\s,;]*/g, "[path]")
    .trim()
    .slice(0, 80);
  return cleaned || null;
};

type OperationRow = {
  id: string;
  owner_user_id: string;
  ai_client_instance_id: string;
  source_device_credential_id: string;
  hosted_instance_id: string;
  provider: string;
  computer_label: string | null;
  target_device_id: string;
  target_deployment_id: string;
  project_id: string | null;
  request_id: string;
  request_digest: string;
  state: AiClientResourceDiscoveryOperation["state"];
  revision: number;
  attempt: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  claimed_by_runner_id: string | null;
  catalog: Record<string, unknown> | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AiClientResourceDiscoveryTarget = {
  ownerUserId: string;
  aiClientInstanceId: string;
  sourceDeviceCredentialId: string;
  hostedInstanceId: string;
  provider: "codex" | "claude" | "pi";
  computerLabel: string | null;
  targetDeviceId: string;
  targetDeploymentId: string;
};

const hostedInstanceIdFor = (
  instanceId: string,
  sourceDeviceCredentialId: string
): string =>
  sourceDeviceCredentialId === LOCAL_DEVICE_CREDENTIAL_ID
    ? instanceId
    : `runner.${createHash("sha256")
        .update(`${sourceDeviceCredentialId}\0${instanceId}`)
        .digest("hex")
        .slice(0, 40)}`;

const mapOperation = (row: OperationRow): AiClientResourceDiscoveryOperation =>
  aiClientResourceDiscoveryOperationSchema.parse({
    operationId: row.id,
    requestId: row.request_id,
    hostedInstanceId: row.hosted_instance_id,
    projectId: row.project_id,
    state: row.state,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.catalog
      ? { catalog: aiClientResourceCatalogSchema.parse(row.catalog) }
      : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {})
  });

const digestRequest = (input: {
  target: AiClientResourceDiscoveryTarget;
  projectId: string | null;
  requestId: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        hostedInstanceId: input.target.hostedInstanceId,
        aiClientInstanceId: input.target.aiClientInstanceId,
        sourceDeviceCredentialId: input.target.sourceDeviceCredentialId,
        projectId: input.projectId,
        requestId: input.requestId
      })
    )
    .digest("hex");

export interface AiClientResourceRepository {
  resolveAiClientResourceDiscoveryTarget(
    actor: ActorContext,
    input: {
      hostedInstanceId: string;
      localDeviceId: string | null;
      localDeploymentId: string | null;
    }
  ): Promise<AiClientResourceDiscoveryTarget | null>;
  createAiClientResourceDiscoveryOperation(
    actor: ActorContext,
    input: {
      target: AiClientResourceDiscoveryTarget;
      projectId: string | null;
      requestId: string;
    }
  ): Promise<AiClientResourceDiscoveryOperation>;
  getAiClientResourceDiscoveryOperation(
    actor: ActorContext,
    input: { operationId: string }
  ): Promise<AiClientResourceDiscoveryOperation | null>;
  claimAiClientResourceDiscoveryOperations(input: {
    ownerUserId: string;
    deploymentId: string;
    deviceId: string;
    runnerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<AiClientResourceDiscoveryRunnerClaim[]>;
  heartbeatAiClientResourceDiscoveryOperation(input: {
    operationId: string;
    ownerUserId: string;
    deploymentId: string;
    deviceId: string;
    runnerId: string;
    leaseToken: string;
    revision: number;
    leaseMs: number;
  }): Promise<boolean>;
  completeAiClientResourceDiscoveryOperation(input: {
    operationId: string;
    ownerUserId: string;
    deploymentId: string;
    deviceId: string;
    runnerId: string;
    leaseToken: string;
    revision: number;
    catalog: AiClientResourceCatalog;
  }): Promise<AiClientResourceDiscoveryOperation | null>;
  failAiClientResourceDiscoveryOperation(input: {
    operationId: string;
    ownerUserId: string;
    deploymentId: string;
    deviceId: string;
    runnerId: string;
    leaseToken: string;
    revision: number;
    errorCode: string;
  }): Promise<AiClientResourceDiscoveryOperation | null>;
}

export const createAiClientResourceRepository = (
  pool: QueryClient
): AiClientResourceRepository => ({
  async resolveAiClientResourceDiscoveryTarget(actor, input) {
    const { rows } = await pool.query<{
      owner_user_id: string;
      instance_id: string;
      source_device_credential_id: string;
      driver_id: string;
      source_device_label: string | null;
      enabled: boolean;
      device_instance_id: string | null;
      protocol_deployment_id: string | null;
    }>(
      `select i.owner_user_id, i.instance_id, i.source_device_credential_id,
              i.driver_id, i.source_device_label, i.enabled,
              d.device_instance_id,
              d.metadata->>'protocolDeploymentId' as protocol_deployment_id
       from ai_client_instances i
       left join device_credentials d
         on d.id=i.source_device_credential_id
        and d.owner_user_id=i.owner_user_id
        and d.revoked_at is null
        and (d.expires_at is null or d.expires_at>now())
       where i.owner_user_id=$1 and i.enabled=true
         and (i.source_device_credential_id=$2 or d.id is not null)
       order by i.updated_at desc`,
      [actor.userId, LOCAL_DEVICE_CREDENTIAL_ID]
    );
    for (const row of rows) {
      const hostedInstanceId = hostedInstanceIdFor(
        row.instance_id,
        row.source_device_credential_id
      );
      if (hostedInstanceId !== input.hostedInstanceId) continue;
      if (!(["codex", "claude", "pi"] as string[]).includes(row.driver_id))
        return null;
      const isLocal =
        row.source_device_credential_id === LOCAL_DEVICE_CREDENTIAL_ID;
      const targetDeviceId = isLocal
        ? input.localDeviceId
        : row.device_instance_id;
      const targetDeploymentId = isLocal
        ? input.localDeploymentId
        : row.protocol_deployment_id;
      if (
        !targetDeviceId ||
        !targetDeploymentId ||
        !UUID.test(targetDeploymentId)
      )
        throw fail("AI_CLIENT_RESOURCE_TARGET_UNAVAILABLE", 503);
      if (!isLocal) {
        const sourceCredential = await pool.query(
          `select 1 from device_credentials
           where id=$1 and owner_user_id=$2 and revoked_at is null
             and (expires_at is null or expires_at>now())
             and 'managed_execution'=any(operation_families)
           limit 1`,
          [row.source_device_credential_id, actor.userId]
        );
        if (sourceCredential.rowCount !== 1)
          throw fail("AI_CLIENT_RESOURCE_TARGET_UNAVAILABLE", 503);
      }
      return {
        ownerUserId: row.owner_user_id,
        aiClientInstanceId: row.instance_id,
        sourceDeviceCredentialId: row.source_device_credential_id,
        hostedInstanceId,
        provider: row.driver_id as AiClientResourceDiscoveryTarget["provider"],
        computerLabel: safeComputerLabel(row.source_device_label),
        targetDeviceId,
        targetDeploymentId
      };
    }
    return null;
  },

  async createAiClientResourceDiscoveryOperation(actor, input) {
    const digest = digestRequest(input);
    const inserted = await pool.query<OperationRow>(
      `insert into ai_client_resource_discovery_operations
         (owner_user_id,ai_client_instance_id,source_device_credential_id,hosted_instance_id,
          provider,computer_label,target_device_id,target_deployment_id,project_id,request_id,request_digest)
       select $1,$2,$3,$4,$5,$6,$7::text,$8::uuid,$9,$10,$11
       where exists (
         select 1 from ai_client_instances i
         left join device_credentials d on d.id=i.source_device_credential_id
           and d.owner_user_id=i.owner_user_id and d.revoked_at is null
           and (d.expires_at is null or d.expires_at>now())
         where i.owner_user_id=$1 and i.instance_id=$2
           and i.source_device_credential_id=$3 and i.driver_id=$5 and i.enabled=true
           and (($3=$12 and $7::text is not null and $8::uuid is not null)
             or (d.id is not null and d.device_instance_id=$7::text
               and d.metadata->>'protocolDeploymentId'=$8::uuid::text
               and 'managed_execution'=any(d.operation_families)))
       )
       on conflict(owner_user_id,request_id) do nothing returning *`,
      [
        actor.userId,
        input.target.aiClientInstanceId,
        input.target.sourceDeviceCredentialId,
        input.target.hostedInstanceId,
        input.target.provider,
        input.target.computerLabel,
        input.target.targetDeviceId,
        input.target.targetDeploymentId,
        input.projectId,
        input.requestId,
        digest,
        LOCAL_DEVICE_CREDENTIAL_ID
      ]
    );
    let row = inserted.rows[0];
    if (!row) {
      const existing = await pool.query<OperationRow>(
        `select * from ai_client_resource_discovery_operations
         where owner_user_id=$1 and request_id=$2 limit 1`,
        [actor.userId, input.requestId]
      );
      row = existing.rows[0];
      if (!row) throw fail("AI_CLIENT_RESOURCE_INSTANCE_UNAVAILABLE", 404);
      if (row.request_digest !== digest)
        throw fail("AI_CLIENT_RESOURCE_REQUEST_CONFLICT");
    }
    return mapOperation(row);
  },

  async getAiClientResourceDiscoveryOperation(actor, input) {
    if (!UUID.test(input.operationId)) return null;
    const { rows } = await pool.query<OperationRow>(
      `select * from ai_client_resource_discovery_operations
       where id=$1 and owner_user_id=$2 limit 1`,
      [input.operationId, actor.userId]
    );
    return rows[0] ? mapOperation(rows[0]) : null;
  },

  async claimAiClientResourceDiscoveryOperations(input) {
    const client = "connect" in pool ? await pool.connect() : pool;
    const releaseClient = client as pg.PoolClient;
    const release =
      typeof releaseClient.release === "function"
        ? () => releaseClient.release()
        : () => undefined;
    try {
      await client.query("begin");
      await client.query(
        `update ai_client_resource_discovery_operations
         set state='failed', error_code='resource_discovery_attempts_exhausted',
             lease_token=null, lease_expires_at=null, claimed_by_runner_id=null,
             revision=revision+1, updated_at=now(), completed_at=now()
         where owner_user_id=$1 and target_deployment_id=$2 and target_device_id=$3
           and state='running' and lease_expires_at<=now() and attempt>=3`,
        [input.ownerUserId, input.deploymentId, input.deviceId]
      );
      const { rows } = await client.query<OperationRow>(
        `with candidates as (
           select o.id from ai_client_resource_discovery_operations o
           where o.owner_user_id=$1 and o.target_deployment_id=$2 and o.target_device_id=$3
             and (o.state='pending' or (o.state='running' and o.lease_expires_at<=now()))
             and o.attempt<3
             and exists (
               select 1 from ai_client_instances i
               left join device_credentials d on d.id=i.source_device_credential_id
                 and d.owner_user_id=i.owner_user_id and d.revoked_at is null
                 and (d.expires_at is null or d.expires_at>now())
               where i.owner_user_id=o.owner_user_id
                 and i.instance_id=o.ai_client_instance_id
                 and i.source_device_credential_id=o.source_device_credential_id
                 and i.driver_id=o.provider
                 and i.enabled=true
                 and ((o.source_device_credential_id='${LOCAL_DEVICE_CREDENTIAL_ID}'::uuid)
                   or (d.id is not null and d.device_instance_id=o.target_device_id
                     and d.metadata->>'protocolDeploymentId'=o.target_deployment_id::text
                     and 'managed_execution'=any(d.operation_families)))
             )
           order by o.created_at,o.id for update of o skip locked limit $4
         )
         update ai_client_resource_discovery_operations o
         set state='running', lease_token=gen_random_uuid(),
             lease_expires_at=now()+($5::int*interval '1 millisecond'),
             claimed_by_runner_id=$6, attempt=attempt+1, revision=revision+1,
             updated_at=now(), error_code=null
         from candidates where o.id=candidates.id returning o.*`,
        [
          input.ownerUserId,
          input.deploymentId,
          input.deviceId,
          input.limit,
          input.leaseMs,
          input.runnerId
        ]
      );
      await client.query("commit");
      return rows.map((row) =>
        aiClientResourceDiscoveryRunnerClaimSchema.parse({
          operationId: row.id,
          ownerUserId: row.owner_user_id,
          requestId: row.request_id,
          hostedInstanceId: row.hosted_instance_id,
          aiClientInstanceId: row.ai_client_instance_id,
          provider: row.provider,
          computerLabel: row.computer_label,
          projectId: row.project_id,
          targetDeviceId: row.target_device_id,
          targetDeploymentId: row.target_deployment_id,
          state: row.state,
          revision: row.revision,
          attempt: row.attempt,
          leaseToken: row.lease_token,
          createdAt: iso(row.created_at)
        })
      );
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        /* ignore rollback errors */
      }
      throw error;
    } finally {
      release();
    }
  },

  async heartbeatAiClientResourceDiscoveryOperation(input) {
    const result = await pool.query(
      `update ai_client_resource_discovery_operations
       set lease_expires_at=now()+($8::int*interval '1 millisecond'), updated_at=now()
       where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4
         and claimed_by_runner_id=$5 and lease_token=$6 and revision=$7
         and state='running' and lease_expires_at>now() returning id`,
      [
        input.operationId,
        input.ownerUserId,
        input.deploymentId,
        input.deviceId,
        input.runnerId,
        input.leaseToken,
        input.revision,
        input.leaseMs
      ]
    );
    return result.rowCount === 1;
  },

  async completeAiClientResourceDiscoveryOperation(input) {
    const catalog = aiClientResourceCatalogSchema.parse(input.catalog);
    const result = await pool.query<OperationRow>(
      `update ai_client_resource_discovery_operations
       set state='completed', catalog=$8::jsonb, error_code=null, lease_token=null,
           lease_expires_at=null, claimed_by_runner_id=null, revision=revision+1,
           updated_at=now(), completed_at=now()
       where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4
         and claimed_by_runner_id=$5 and lease_token=$6 and revision=$7
         and state='running' and lease_expires_at>now()
         and $8::jsonb->>'hostedInstanceId'=hosted_instance_id
         and $8::jsonb->>'aiClientInstanceId'=ai_client_instance_id
         and $8::jsonb->>'provider'=provider
         and $8::jsonb->>'projectId' is not distinct from project_id
         and $8::jsonb->>'computerLabel' is not distinct from computer_label
       returning *`,
      [
        input.operationId,
        input.ownerUserId,
        input.deploymentId,
        input.deviceId,
        input.runnerId,
        input.leaseToken,
        input.revision,
        JSON.stringify(catalog)
      ]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  },

  async failAiClientResourceDiscoveryOperation(input) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(input.errorCode))
      throw fail("AI_CLIENT_RESOURCE_ERROR_CODE_INVALID", 400);
    const { rows } = await pool.query<OperationRow>(
      `update ai_client_resource_discovery_operations
       set state='failed', error_code=$8, lease_token=null, lease_expires_at=null,
           claimed_by_runner_id=null, revision=revision+1, updated_at=now(), completed_at=now()
       where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4
         and claimed_by_runner_id=$5 and lease_token=$6 and revision=$7
         and state='running' and lease_expires_at>now() returning *`,
      [
        input.operationId,
        input.ownerUserId,
        input.deploymentId,
        input.deviceId,
        input.runnerId,
        input.leaseToken,
        input.revision,
        input.errorCode
      ]
    );
    return rows[0] ? mapOperation(rows[0]) : null;
  }
});
