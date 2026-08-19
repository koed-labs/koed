import { createHash, randomBytes, randomUUID, verify } from "node:crypto";

import {
  MANAGED_CONVERSATION_FORK_PROTOCOL_V2,
  canonicalManagedConversationForkManifest,
  managedConversationForkManifestDigest,
  parseManagedConversationForkManifest,
  parseSignedManagedConversationForkManifest,
  pdsEd25519PublicKey,
  type ManagedConversationForkManifest,
  type SignedManagedConversationForkManifest
} from "@koed/shared";
import type pg from "pg";

import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { managedConversationEventMutationId } from "./managed-conversation-event.js";
import type { ManagedConversationExecutionRecord } from "./managed-conversation-repository.js";
import type { ActorContext } from "./types.js";

export type ManagedConversationForkState =
  | "requested"
  | "source_prepared"
  | "source_attested"
  | "provider_created"
  | "child_bound"
  | "running"
  | "indeterminate"
  | "failed";

export interface ManagedConversationForkRecord {
  id: string;
  ownerUserId: string;
  operationId: string;
  requestDigest: string;
  state: ManagedConversationForkState;
  stateVersion: number;
  parentExecutionId: string;
  parentExecutionGeneration: number;
  parentNextSourceGenerationId: string;
  parentNextOriginKeyId: string;
  parentLogicalSessionId: string | null;
  parentSourceGenerationId: string | null;
  parentClosureHash: string | null;
  parentEndByteCursor: number | null;
  parentEndItemCursor: number | null;
  sourceDeploymentId: string;
  sourceDeviceId: string;
  targetDeploymentId: string;
  targetDeviceId: string;
  workspaceSnapshotId: string | null;
  childExecutionId: string | null;
  childLogicalSessionId: string | null;
  childLogicalSourceId: string | null;
  providerCreationCorrelation: string;
  forkManifest: ManagedConversationForkManifest | null;
  sourceAttestation: SignedManagedConversationForkManifest["source"] | null;
  manifestDigest: string | null;
  reason: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ManagedConversationForkTargetMaterial {
  fork: ManagedConversationForkRecord;
  signedManifest: SignedManagedConversationForkManifest;
  sourcePublicKey: string;
  snapshot: {
    id: string;
    manifestDigest: string;
    sourceStateDigest: string;
    packageDigest: string;
    packageByteCount: number;
    chunkCount: number;
    readinessEvidence: Record<string, unknown>;
  };
}

export interface ManagedConversationForkRepository {
  requestManagedConversationFork(
    actor: ActorContext,
    input: {
      parentExecutionId: string;
      operationId: string;
      reason: string;
      sourceDeploymentId: string;
      sourceDeviceId: string;
      targetDeploymentId: string;
      targetDeviceId: string;
    }
  ): Promise<ManagedConversationForkRecord>;
  getManagedConversationFork(
    actor: ActorContext,
    forkId: string
  ): Promise<ManagedConversationForkRecord | null>;
  getActiveManagedConversationForkForParent(
    actor: ActorContext,
    parentExecutionId: string
  ): Promise<ManagedConversationForkRecord | null>;
  getLatestManagedConversationForkForParent(
    actor: ActorContext,
    parentExecutionId: string
  ): Promise<ManagedConversationForkRecord | null>;
  prepareManagedConversationForkSource(
    actor: ActorContext,
    input: {
      forkId: string;
      expectedStateVersion: number;
      runnerId: string;
      parentLogicalSessionId: string;
      providerArtifactRelativePath: string;
      logicalSourceId: string;
      sourceGenerationId: string;
      sourceClosureHash: string;
      sourceEndByteCursor: number;
      sourceEndItemCursor: number;
      workspaceSnapshotId: string;
    }
  ): Promise<{
    fork: ManagedConversationForkRecord;
    manifest: ManagedConversationForkManifest;
    sourceOriginKeyId: string;
  }>;
  attestManagedConversationForkSource(
    actor: ActorContext,
    input: {
      forkId: string;
      expectedStateVersion: number;
      sourceKeyId: string;
      sourceSignature: string;
    }
  ): Promise<ManagedConversationForkRecord>;
  getManagedConversationForkTargetMaterial(
    actor: ActorContext,
    input: { forkId: string; targetDeviceId: string }
  ): Promise<ManagedConversationForkTargetMaterial | null>;
  prepareManagedConversationForkChild(
    actor: ActorContext,
    input: {
      forkId: string;
      expectedStateVersion: number;
      targetDeviceId: string;
    }
  ): Promise<{
    fork: ManagedConversationForkRecord;
    childExecution: ManagedConversationExecutionRecord;
  }>;
  completeManagedConversationFork(
    actor: ActorContext,
    input: {
      forkId: string;
      expectedStateVersion: number;
      targetDeviceId: string;
      childExecutionId: string;
      childLogicalSessionId: string;
      childLogicalSourceId: string;
      childProviderThreadId: string;
    }
  ): Promise<ManagedConversationForkRecord>;
  failManagedConversationFork(
    actor: ActorContext,
    input: {
      forkId: string;
      expectedStateVersion: number;
      deviceId: string;
      state: "indeterminate" | "failed";
      failureCode: string;
    }
  ): Promise<ManagedConversationForkRecord>;
}

type ForkRow = {
  id: string;
  owner_user_id: string;
  operation_id: string;
  request_digest: string;
  state: ManagedConversationForkState;
  state_version: number;
  parent_execution_id: string;
  parent_execution_generation: number;
  parent_next_source_generation_id: string;
  parent_next_origin_key_id: string;
  parent_logical_session_id: string | null;
  parent_source_generation_id: string | null;
  parent_closure_hash: string | null;
  parent_end_byte_cursor: number | string | null;
  parent_end_item_cursor: number | string | null;
  source_deployment_id: string;
  source_device_id: string;
  target_deployment_id: string;
  target_device_id: string;
  workspace_snapshot_id: string | null;
  child_execution_id: string | null;
  child_logical_session_id: string | null;
  child_logical_source_id: string | null;
  provider_creation_correlation: string;
  fork_manifest: Record<string, unknown> | null;
  source_attestation: Record<string, unknown> | null;
  manifest_digest: string | null;
  reason: string;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

type ExecutionRow = {
  id: string;
  owner_user_id: string;
  project_id: string;
  provider: string;
  ai_client_instance_id: string;
  state: ManagedConversationExecutionRecord["state"];
  state_version: number;
  execution_generation: number;
  runner_deployment_id: string;
  runner_device_id: string;
  runner_id: string | null;
  runner_lease_expires_at: Date | null;
  logical_session_id: string | null;
  provider_thread_id: string | null;
  provider_cli_version: string | null;
  source_generation_id: string | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  quiesced_at: Date | null;
  stopped_at: Date | null;
};

const FORK_COLUMNS = `
  id, owner_user_id, operation_id, request_digest, state, state_version,
  parent_execution_id, parent_execution_generation,
  parent_next_source_generation_id, parent_next_origin_key_id,
  parent_logical_session_id,
  parent_source_generation_id, parent_closure_hash, parent_end_byte_cursor,
  parent_end_item_cursor, source_deployment_id, source_device_id,
  target_deployment_id, target_device_id, workspace_snapshot_id,
  child_execution_id, child_logical_session_id, child_logical_source_id,
  provider_creation_correlation, fork_manifest, source_attestation,
  manifest_digest, reason, failure_code, created_at, updated_at, completed_at
`;

const EXECUTION_COLUMNS = `
  id, owner_user_id, project_id, provider, ai_client_instance_id, state,
  state_version, execution_generation, runner_deployment_id, runner_device_id,
  runner_id, runner_lease_expires_at, logical_session_id, provider_thread_id,
  provider_cli_version, source_generation_id, last_error_code,
  created_at, updated_at, started_at, quiesced_at, stopped_at
`;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fail = (
  message: string,
  statusCode: number,
  code: string
): Error & { statusCode: number; code: string } =>
  Object.assign(new Error(message), { statusCode, code });

const mapFork = (row: ForkRow): ManagedConversationForkRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  operationId: row.operation_id,
  requestDigest: row.request_digest,
  state: row.state,
  stateVersion: row.state_version,
  parentExecutionId: row.parent_execution_id,
  parentExecutionGeneration: row.parent_execution_generation,
  parentNextSourceGenerationId: row.parent_next_source_generation_id,
  parentNextOriginKeyId: row.parent_next_origin_key_id,
  parentLogicalSessionId: row.parent_logical_session_id,
  parentSourceGenerationId: row.parent_source_generation_id,
  parentClosureHash: row.parent_closure_hash,
  parentEndByteCursor:
    row.parent_end_byte_cursor === null
      ? null
      : Number(row.parent_end_byte_cursor),
  parentEndItemCursor:
    row.parent_end_item_cursor === null
      ? null
      : Number(row.parent_end_item_cursor),
  sourceDeploymentId: row.source_deployment_id,
  sourceDeviceId: row.source_device_id,
  targetDeploymentId: row.target_deployment_id,
  targetDeviceId: row.target_device_id,
  workspaceSnapshotId: row.workspace_snapshot_id,
  childExecutionId: row.child_execution_id,
  childLogicalSessionId: row.child_logical_session_id,
  childLogicalSourceId: row.child_logical_source_id,
  providerCreationCorrelation: row.provider_creation_correlation,
  forkManifest: row.fork_manifest
    ? parseManagedConversationForkManifest(row.fork_manifest)
    : null,
  sourceAttestation: row.source_attestation
    ? parseSignedManagedConversationForkManifest({
        manifest: row.fork_manifest,
        source: row.source_attestation
      }).source
    : null,
  manifestDigest: row.manifest_digest,
  reason: row.reason,
  failureCode: row.failure_code,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  completedAt: row.completed_at?.toISOString() ?? null
});

const mapExecution = (
  row: ExecutionRow
): ManagedConversationExecutionRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  projectId: row.project_id,
  provider: row.provider,
  aiClientInstanceId: row.ai_client_instance_id,
  state: row.state,
  stateVersion: row.state_version,
  executionGeneration: row.execution_generation,
  runnerDeploymentId: row.runner_deployment_id,
  runnerDeviceId: row.runner_device_id,
  runnerId: row.runner_id,
  runnerLeaseExpiresAt: row.runner_lease_expires_at?.toISOString() ?? null,
  logicalSessionId: row.logical_session_id,
  providerThreadId: row.provider_thread_id,
  providerCliVersion: row.provider_cli_version,
  sourceGenerationId: row.source_generation_id,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  quiescedAt: row.quiesced_at?.toISOString() ?? null,
  stoppedAt: row.stopped_at?.toISOString() ?? null
});

const transition = (
  client: pg.PoolClient,
  input: {
    forkId: string;
    ownerUserId: string;
    stateVersion: number;
    state: ManagedConversationForkState;
    evidenceDigest: string;
    actorKind: "user" | "source_runner" | "target_runner" | "recovery";
    actorId: string;
  }
) =>
  client.query(
    `insert into managed_conversation_fork_transitions (
       fork_id, owner_user_id, state_version, state, evidence_digest,
       actor_kind, actor_id
     ) values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.forkId,
      input.ownerUserId,
      input.stateVersion,
      input.state,
      input.evidenceDigest,
      input.actorKind,
      input.actorId
    ]
  );

const notifyCommands = (client: pg.PoolClient, executionId: string) =>
  client.query(
    `select pg_notify(
       'koed_managed_conversation_commands',
       json_build_object('executionId', $1::uuid)::text
     )`,
    [executionId]
  );

const appendEvent = (
  client: pg.PoolClient,
  ownerUserId: string,
  executionId: string,
  mutationId: string
) =>
  appendCollaborationOutboxEventWithClient(client, {
    family: "managed_conversation_changed",
    scope: "personal",
    personalOwnerUserId: ownerUserId,
    teamId: null,
    teamWorkspaceId: null,
    threadId: null,
    messageId: null,
    shareGrantId: null,
    logicalMemoryId: null,
    resourceType: "managed_conversation_execution",
    resourceId: executionId,
    actorPrincipalId: ownerUserId,
    mutationId: managedConversationEventMutationId(mutationId)
  });

export const createManagedConversationForkRepository = (
  pool: pg.Pool
): ManagedConversationForkRepository => ({
  async requestManagedConversationFork(actor, input) {
    if (
      !/^(user_requested|incompatible_provider|origin_unavailable|independent_work)$/.test(
        input.reason
      )
    ) {
      throw fail(
        "Managed Conversation fork reason is invalid",
        400,
        "managed_conversation_fork_reason_invalid"
      );
    }
    const requestDigest = sha256(
      JSON.stringify({
        parentExecutionId: input.parentExecutionId,
        operationId: input.operationId,
        reason: input.reason,
        sourceDeploymentId: input.sourceDeploymentId,
        sourceDeviceId: input.sourceDeviceId,
        targetDeploymentId: input.targetDeploymentId,
        targetDeviceId: input.targetDeviceId
      })
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query<ForkRow>(
        `select ${FORK_COLUMNS}
           from managed_conversation_forks
          where owner_user_id = $1 and operation_id = $2
          for update`,
        [actor.userId, input.operationId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== requestDigest) {
          throw fail(
            "Managed Conversation fork idempotency conflict",
            409,
            "managed_conversation_fork_idempotency_conflict"
          );
        }
        await client.query("commit");
        return mapFork(existing.rows[0]);
      }
      const execution = await client.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, input.parentExecutionId]
      );
      const parent = execution.rows[0];
      if (
        !parent ||
        parent.state !== "running" ||
        !parent.logical_session_id ||
        !parent.provider_thread_id ||
        !parent.provider_cli_version ||
        parent.runner_deployment_id !== input.sourceDeploymentId ||
        parent.runner_device_id !== input.sourceDeviceId
      ) {
        throw fail(
          "Managed Conversation fork source is not writable",
          409,
          "managed_conversation_fork_source_not_writable"
        );
      }
      const unsettled = await client.query<{ exists: boolean }>(
        `select exists (
           select 1 from managed_conversation_commands
            where execution_id = $1
              and state in ('queued','dispatching','indeterminate')
         ) as exists`,
        [parent.id]
      );
      if (unsettled.rows[0]?.exists) {
        throw fail(
          "Managed Conversation has unsettled commands",
          409,
          "managed_conversation_fork_commands_unsettled"
        );
      }
      const forkId = randomUUID();
      const inserted = await client.query<ForkRow>(
        `insert into managed_conversation_forks (
           id, owner_user_id, operation_id, request_digest,
           parent_execution_id, parent_execution_generation,
           parent_next_source_generation_id, parent_next_origin_key_id,
           source_deployment_id, source_device_id, target_deployment_id,
           target_device_id, provider_creation_correlation, reason
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning ${FORK_COLUMNS}`,
        [
          forkId,
          actor.userId,
          input.operationId,
          requestDigest,
          parent.id,
          parent.execution_generation,
          randomUUID(),
          randomUUID(),
          input.sourceDeploymentId,
          input.sourceDeviceId,
          input.targetDeploymentId,
          input.targetDeviceId,
          randomUUID(),
          input.reason
        ]
      );
      const sequence = await client.query<{ value: number }>(
        `select coalesce(max(sequence), -1) + 1 as value
           from managed_conversation_commands
          where execution_id = $1`,
        [parent.id]
      );
      await client.query(
        `insert into managed_conversation_commands (
           owner_user_id, execution_id, idempotency_key, sequence,
           command_kind, request_digest, execution_generation
         ) values ($1,$2,$3,$4,'fork_prepare',$5,$6)`,
        [
          actor.userId,
          parent.id,
          `fork:${input.operationId}:prepare`,
          sequence.rows[0]!.value,
          requestDigest,
          parent.execution_generation
        ]
      );
      await client.query(
        `update managed_conversation_executions
            set state = 'quiesce_requested',
                state_version = state_version + 1,
                updated_at = now()
          where owner_user_id = $1 and id = $2`,
        [actor.userId, parent.id]
      );
      await transition(client, {
        forkId,
        ownerUserId: actor.userId,
        stateVersion: 1,
        state: "requested",
        evidenceDigest: requestDigest,
        actorKind: "user",
        actorId: actor.userId
      });
      await appendEvent(
        client,
        actor.userId,
        parent.id,
        `managed-fork:${forkId}:requested`
      );
      await notifyCommands(client, parent.id);
      await client.query("commit");
      return mapFork(inserted.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getManagedConversationFork(actor, forkId) {
    const result = await pool.query<ForkRow>(
      `select ${FORK_COLUMNS}
         from managed_conversation_forks
        where owner_user_id = $1 and id = $2`,
      [actor.userId, forkId]
    );
    return result.rows[0] ? mapFork(result.rows[0]) : null;
  },

  async getActiveManagedConversationForkForParent(actor, parentExecutionId) {
    const result = await pool.query<ForkRow>(
      `select ${FORK_COLUMNS}
         from managed_conversation_forks
        where owner_user_id = $1
          and parent_execution_id = $2
          and state not in ('running','indeterminate','failed')
        order by created_at, id
        limit 1`,
      [actor.userId, parentExecutionId]
    );
    return result.rows[0] ? mapFork(result.rows[0]) : null;
  },

  async getLatestManagedConversationForkForParent(actor, parentExecutionId) {
    const result = await pool.query<ForkRow>(
      `select ${FORK_COLUMNS}
         from managed_conversation_forks
        where owner_user_id = $1
          and parent_execution_id = $2
        order by created_at desc, id desc
        limit 1`,
      [actor.userId, parentExecutionId]
    );
    return result.rows[0] ? mapFork(result.rows[0]) : null;
  },

  async prepareManagedConversationForkSource(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const forkResult = await client.query<ForkRow>(
        `select ${FORK_COLUMNS}
           from managed_conversation_forks
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, input.forkId]
      );
      const fork = forkResult.rows[0];
      if (
        !fork ||
        fork.state !== "requested" ||
        fork.state_version !== input.expectedStateVersion ||
        fork.fork_manifest ||
        fork.source_attestation
      ) {
        throw fail(
          "Managed Conversation fork preparation conflicted",
          409,
          "managed_conversation_fork_prepare_conflict"
        );
      }
      const execution = await client.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, fork.parent_execution_id]
      );
      const parent = execution.rows[0];
      if (
        !parent ||
        parent.state !== "quiesced" ||
        parent.execution_generation !== fork.parent_execution_generation ||
        parent.runner_id !== input.runnerId ||
        parent.logical_session_id !== input.parentLogicalSessionId ||
        !parent.provider_thread_id ||
        !parent.provider_cli_version
      ) {
        throw fail(
          "Managed Conversation fork source is not quiesced",
          409,
          "managed_conversation_fork_source_not_quiesced"
        );
      }
      const source = await client.query<{
        origin_key_id: string;
        origin_public_key: string;
        lifecycle: string;
        closure_hash: string | null;
        provider_cursor_offset: number | string;
        provider_cursor_line: number;
      }>(
        `select origin_key_id, origin_public_key, lifecycle, closure_hash,
                provider_cursor_offset, provider_cursor_line
           from conversation_source_artifacts
          where owner_user_id = $1
            and logical_source_id = $2
            and source_generation_id = $3
          for update`,
        [actor.userId, input.logicalSourceId, input.sourceGenerationId]
      );
      const sourceRow = source.rows[0];
      if (
        !sourceRow ||
        sourceRow.lifecycle !== "finalized" ||
        sourceRow.closure_hash !== input.sourceClosureHash ||
        Number(sourceRow.provider_cursor_offset) !==
          input.sourceEndByteCursor ||
        sourceRow.provider_cursor_line !== input.sourceEndItemCursor
      ) {
        throw fail(
          "Managed Conversation fork source boundary is not exact",
          409,
          "managed_conversation_fork_source_boundary_conflict"
        );
      }
      const snapshot = (
        await client.query<{ id: string; manifest_digest: string }>(
          `select id, manifest_digest
             from development_workspace_snapshots
            where id = $2
              and owner_user_id = $1
              and execution_id = $3
              and operation_kind = 'fork'
              and operation_id = $4
              and source_generation_id = $5
              and source_deployment_id = $6
              and source_device_id = $7
              and state = 'ready'
              and revoked_at is null
              and deleted_at is null
            for update`,
          [
            actor.userId,
            input.workspaceSnapshotId,
            parent.id,
            fork.id,
            input.sourceGenerationId,
            fork.source_deployment_id,
            fork.source_device_id
          ]
        )
      ).rows[0];
      if (!snapshot) {
        throw fail(
          "Managed Conversation fork workspace snapshot is not ready",
          409,
          "managed_conversation_fork_snapshot_not_ready"
        );
      }
      const now = new Date();
      const manifest: ManagedConversationForkManifest = {
        protocol: MANAGED_CONVERSATION_FORK_PROTOCOL_V2,
        operationId: fork.operation_id,
        requestDigest: fork.request_digest,
        ownerUserId: actor.userId,
        parentExecutionId: parent.id,
        parentExecutionGeneration: parent.execution_generation,
        parentLogicalSessionId: input.parentLogicalSessionId,
        logicalSourceId: input.logicalSourceId,
        sourceGenerationId: input.sourceGenerationId,
        parentNextSourceGenerationId: fork.parent_next_source_generation_id,
        parentNextOriginKeyId: fork.parent_next_origin_key_id,
        sourceClosureHash: input.sourceClosureHash,
        sourceEndByteCursor: input.sourceEndByteCursor,
        sourceEndItemCursor: input.sourceEndItemCursor,
        provider: parent.provider,
        aiClientInstanceId: parent.ai_client_instance_id,
        providerThreadId: parent.provider_thread_id,
        providerArtifactRelativePath: input.providerArtifactRelativePath,
        providerCliVersion: parent.provider_cli_version,
        workspaceSnapshotId: snapshot.id,
        workspaceManifestDigest: snapshot.manifest_digest,
        sourceDeploymentId: fork.source_deployment_id,
        sourceDeviceId: fork.source_device_id,
        targetDeploymentId: fork.target_deployment_id,
        targetDeviceId: fork.target_device_id,
        nonce: randomBytes(32).toString("base64url"),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
      };
      parseManagedConversationForkManifest(manifest);
      const nextVersion = fork.state_version + 1;
      const updated = await client.query<ForkRow>(
        `update managed_conversation_forks
            set state = 'source_prepared',
                state_version = $3,
                parent_logical_session_id = $4,
                parent_source_generation_id = $5,
                parent_closure_hash = $6,
                parent_end_byte_cursor = $7,
                parent_end_item_cursor = $8,
                workspace_snapshot_id = $9,
                fork_manifest = $10::jsonb,
                updated_at = now()
          where owner_user_id = $1 and id = $2
          returning ${FORK_COLUMNS}`,
        [
          actor.userId,
          fork.id,
          nextVersion,
          input.parentLogicalSessionId,
          input.sourceGenerationId,
          input.sourceClosureHash,
          input.sourceEndByteCursor,
          input.sourceEndItemCursor,
          snapshot.id,
          manifest
        ]
      );
      await transition(client, {
        forkId: fork.id,
        ownerUserId: actor.userId,
        stateVersion: nextVersion,
        state: "source_prepared",
        evidenceDigest: snapshot.manifest_digest,
        actorKind: "source_runner",
        actorId: input.runnerId
      });
      await client.query("commit");
      return {
        fork: mapFork(updated.rows[0]!),
        manifest,
        sourceOriginKeyId: sourceRow.origin_key_id
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async attestManagedConversationForkSource(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ForkRow>(
        `select ${FORK_COLUMNS}
           from managed_conversation_forks
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, input.forkId]
      );
      const fork = result.rows[0];
      if (
        !fork ||
        fork.state !== "source_prepared" ||
        fork.state_version !== input.expectedStateVersion ||
        !fork.fork_manifest ||
        fork.source_attestation ||
        !fork.parent_source_generation_id
      ) {
        throw fail(
          "Managed Conversation fork attestation conflicted",
          409,
          "managed_conversation_fork_attestation_conflict"
        );
      }
      const source = await client.query<{
        origin_key_id: string;
        origin_public_key: string;
      }>(
        `select origin_key_id, origin_public_key
           from conversation_source_artifacts
          where owner_user_id = $1
            and source_generation_id = $2
            and lifecycle = 'finalized'`,
        [actor.userId, fork.parent_source_generation_id]
      );
      if (
        source.rows[0]?.origin_key_id !== input.sourceKeyId ||
        !/^[A-Za-z0-9_-]{86}$/.test(input.sourceSignature)
      ) {
        throw fail(
          "Managed Conversation fork attestation identity is invalid",
          409,
          "managed_conversation_fork_attestation_invalid"
        );
      }
      const manifest = parseManagedConversationForkManifest(fork.fork_manifest);
      if (
        manifest.parentNextSourceGenerationId !==
          fork.parent_next_source_generation_id ||
        manifest.parentNextOriginKeyId !== fork.parent_next_origin_key_id
      ) {
        throw fail(
          "Managed Conversation fork successor identity is invalid",
          409,
          "managed_conversation_fork_successor_invalid"
        );
      }
      if (
        !verify(
          null,
          Buffer.from(canonicalManagedConversationForkManifest(manifest)),
          pdsEd25519PublicKey(source.rows[0].origin_public_key),
          Buffer.from(input.sourceSignature, "base64url")
        )
      ) {
        throw fail(
          "Managed Conversation fork attestation is invalid",
          409,
          "managed_conversation_fork_attestation_invalid"
        );
      }
      const parentRuntime = await client.query<{
        state: string;
        execution_generation: number;
        logical_session_id: string | null;
        provider_thread_id: string | null;
        source_generation_id: string | null;
      }>(
        `select state, execution_generation, logical_session_id,
                provider_thread_id,
                source_generation_id
           from managed_conversation_executions
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, fork.parent_execution_id]
      );
      const runtime = parentRuntime.rows[0];
      const successor = await client.query<{ exists: boolean }>(
        `select exists (
           select 1
             from conversation_source_artifacts
            where owner_user_id = $1
              and logical_source_id = $2
              and source_generation_id = $3
              and external_session_id = $4
              and lifecycle = 'active'
              and provider_cursor_offset = $5
              and provider_cursor_line = $6
              and prior_generation_closure->>'sourceGenerationId' = $7
              and prior_generation_closure->>'contentDigest' = $8
         ) as exists`,
        [
          actor.userId,
          manifest.logicalSourceId,
          manifest.parentNextSourceGenerationId,
          manifest.providerThreadId,
          manifest.sourceEndByteCursor,
          manifest.sourceEndItemCursor,
          manifest.sourceGenerationId,
          manifest.sourceClosureHash
        ]
      );
      if (
        runtime?.state !== "running" ||
        runtime.execution_generation !== manifest.parentExecutionGeneration ||
        runtime.logical_session_id !== manifest.parentLogicalSessionId ||
        runtime.provider_thread_id !== manifest.providerThreadId ||
        runtime.source_generation_id !==
          manifest.parentNextSourceGenerationId ||
        !successor.rows[0]?.exists
      ) {
        throw fail(
          "Managed Conversation fork parent did not resume on its signed successor",
          409,
          "managed_conversation_fork_parent_not_resumed"
        );
      }
      const signed: SignedManagedConversationForkManifest = {
        manifest,
        source: {
          keyId: input.sourceKeyId,
          signature: input.sourceSignature
        }
      };
      const digest = managedConversationForkManifestDigest(signed);
      const nextVersion = fork.state_version + 1;
      const updated = await client.query<ForkRow>(
        `update managed_conversation_forks
            set state = 'source_attested',
                state_version = $3,
                source_attestation = $4::jsonb,
                manifest_digest = $5,
                updated_at = now()
          where owner_user_id = $1 and id = $2
          returning ${FORK_COLUMNS}`,
        [actor.userId, fork.id, nextVersion, signed.source, digest]
      );
      await transition(client, {
        forkId: fork.id,
        ownerUserId: actor.userId,
        stateVersion: nextVersion,
        state: "source_attested",
        evidenceDigest: digest,
        actorKind: "source_runner",
        actorId: input.sourceKeyId
      });
      const sequence = await client.query<{ value: number }>(
        `select coalesce(max(sequence), -1) + 1 as value
           from managed_conversation_commands
          where execution_id = $1`,
        [fork.parent_execution_id]
      );
      await client.query(
        `insert into managed_conversation_commands (
           owner_user_id, execution_id, idempotency_key, sequence,
           command_kind, target_deployment_id, target_device_id, request_digest,
           execution_generation
         ) values ($1,$2,$3,$4,'fork_create',$5,$6,$7,$8)`,
        [
          actor.userId,
          fork.parent_execution_id,
          `fork:${fork.operation_id}:create`,
          sequence.rows[0]!.value,
          fork.target_deployment_id,
          fork.target_device_id,
          digest,
          fork.parent_execution_generation
        ]
      );
      await notifyCommands(client, fork.parent_execution_id);
      await client.query("commit");
      return mapFork(updated.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getManagedConversationForkTargetMaterial(actor, input) {
    const result = await pool.query<
      ForkRow & {
        source_public_key: string;
        snapshot_id: string;
        snapshot_manifest_digest: string;
        source_state_digest: string;
        package_digest: string;
        package_byte_count: number | string;
        chunk_count: number;
        readiness_evidence: Record<string, unknown>;
      }
    >(
      `select ${FORK_COLUMNS.split(",")
        .map((column) => `fork.${column.trim()}`)
        .join(", ")},
              source.origin_public_key as source_public_key,
              snapshot.id as snapshot_id,
              snapshot.manifest_digest as snapshot_manifest_digest,
              snapshot.source_state_digest,
              snapshot.package_digest,
              snapshot.package_byte_count,
              snapshot.chunk_count,
              snapshot.readiness_evidence
         from managed_conversation_forks fork
         join conversation_source_artifacts source
           on source.owner_user_id = fork.owner_user_id
          and source.source_generation_id = fork.parent_source_generation_id
          and source.lifecycle = 'finalized'
         join development_workspace_snapshots snapshot
           on snapshot.owner_user_id = fork.owner_user_id
          and snapshot.id = fork.workspace_snapshot_id
          and snapshot.state = 'ready'
        where fork.owner_user_id = $1
          and fork.id = $2
          and fork.target_device_id = $3
          and fork.state = 'source_attested'
          and fork.fork_manifest is not null
          and fork.source_attestation is not null
          and fork.manifest_digest is not null`,
      [actor.userId, input.forkId, input.targetDeviceId]
    );
    const row = result.rows[0];
    if (!row || !row.fork_manifest || !row.source_attestation) return null;
    return {
      fork: mapFork(row),
      signedManifest: parseSignedManagedConversationForkManifest({
        manifest: row.fork_manifest,
        source: row.source_attestation
      }),
      sourcePublicKey: row.source_public_key,
      snapshot: {
        id: row.snapshot_id,
        manifestDigest: row.snapshot_manifest_digest,
        sourceStateDigest: row.source_state_digest,
        packageDigest: row.package_digest,
        packageByteCount: Number(row.package_byte_count),
        chunkCount: row.chunk_count,
        readinessEvidence: row.readiness_evidence
      }
    };
  },

  async prepareManagedConversationForkChild(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ForkRow>(
        `select ${FORK_COLUMNS}
           from managed_conversation_forks
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, input.forkId]
      );
      const fork = result.rows[0];
      if (
        !fork ||
        fork.state !== "source_attested" ||
        fork.state_version !== input.expectedStateVersion ||
        fork.target_device_id !== input.targetDeviceId ||
        !fork.fork_manifest ||
        !fork.source_attestation ||
        !fork.manifest_digest
      ) {
        throw fail(
          "Managed Conversation fork child preparation conflicted",
          409,
          "managed_conversation_fork_child_prepare_conflict"
        );
      }
      if (fork.child_execution_id) {
        const replay = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS}
             from managed_conversation_executions
            where owner_user_id = $1 and id = $2`,
          [actor.userId, fork.child_execution_id]
        );
        if (
          !replay.rows[0] ||
          replay.rows[0].runner_device_id !== input.targetDeviceId ||
          replay.rows[0].runner_deployment_id !== fork.target_deployment_id
        ) {
          throw fail(
            "Managed Conversation fork child already exists",
            409,
            "managed_conversation_fork_child_conflict"
          );
        }
        await client.query("commit");
        return {
          fork: mapFork(fork),
          childExecution: mapExecution(replay.rows[0])
        };
      }
      const parent = await client.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id = $1 and id = $2`,
        [actor.userId, fork.parent_execution_id]
      );
      if (!parent.rows[0]) {
        throw fail(
          "Managed Conversation fork parent is unavailable",
          409,
          "managed_conversation_fork_parent_unavailable"
        );
      }
      const childId = randomUUID();
      const fencingToken = randomBytes(32).toString("base64url");
      const child = await client.query<ExecutionRow>(
        `insert into managed_conversation_executions (
           id, owner_user_id, project_id, provider, ai_client_instance_id,
           fencing_token_hash, runner_deployment_id, runner_device_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning ${EXECUTION_COLUMNS}`,
        [
          childId,
          actor.userId,
          parent.rows[0].project_id,
          parent.rows[0].provider,
          parent.rows[0].ai_client_instance_id,
          sha256(fencingToken),
          fork.target_deployment_id,
          fork.target_device_id
        ]
      );
      const nextVersion = fork.state_version + 1;
      const updated = await client.query<ForkRow>(
        `update managed_conversation_forks
            set state_version = $3,
                child_execution_id = $4,
                updated_at = now()
          where owner_user_id = $1 and id = $2
          returning ${FORK_COLUMNS}`,
        [actor.userId, fork.id, nextVersion, childId]
      );
      await transition(client, {
        forkId: fork.id,
        ownerUserId: actor.userId,
        stateVersion: nextVersion,
        state: "source_attested",
        evidenceDigest: sha256(
          `${fork.provider_creation_correlation}:${childId}:${fork.target_device_id}`
        ),
        actorKind: "target_runner",
        actorId: input.targetDeviceId
      });
      await client.query("commit");
      return {
        fork: mapFork(updated.rows[0]!),
        childExecution: mapExecution(child.rows[0]!)
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async completeManagedConversationFork(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ForkRow>(
        `select ${FORK_COLUMNS}
           from managed_conversation_forks
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, input.forkId]
      );
      const fork = result.rows[0];
      if (
        !fork ||
        fork.state !== "source_attested" ||
        fork.state_version !== input.expectedStateVersion ||
        fork.target_device_id !== input.targetDeviceId ||
        fork.child_execution_id !== input.childExecutionId ||
        !fork.fork_manifest ||
        !fork.manifest_digest
      ) {
        throw fail(
          "Managed Conversation fork completion conflicted",
          409,
          "managed_conversation_fork_complete_conflict"
        );
      }
      const child = await client.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, input.childExecutionId]
      );
      if (
        child.rows[0]?.state !== "running" ||
        child.rows[0].logical_session_id !== input.childLogicalSessionId ||
        child.rows[0].provider_thread_id !== input.childProviderThreadId
      ) {
        throw fail(
          "Managed Conversation fork child is not running",
          409,
          "managed_conversation_fork_child_not_running"
        );
      }
      const source = await client.query<{ exists: boolean }>(
        `select exists (
           select 1
             from conversation_source_artifacts artifact
             join sessions session on session.id = artifact.session_id
            where artifact.owner_user_id = $1
              and artifact.logical_source_id = $2
              and artifact.external_session_id = $3
              and artifact.lifecycle = 'active'
              and session.logical_session_id = $4
              and session.forked_from_external_thread_id = $5
         ) as exists`,
        [
          actor.userId,
          input.childLogicalSourceId,
          input.childProviderThreadId,
          input.childLogicalSessionId,
          fork.fork_manifest.providerThreadId
        ]
      );
      if (!source.rows[0]?.exists) {
        throw fail(
          "Managed Conversation fork lineage is not canonical",
          409,
          "managed_conversation_fork_lineage_invalid"
        );
      }
      const providerCreatedVersion = fork.state_version + 1;
      const childBoundVersion = providerCreatedVersion + 1;
      const runningVersion = childBoundVersion + 1;
      await transition(client, {
        forkId: fork.id,
        ownerUserId: actor.userId,
        stateVersion: providerCreatedVersion,
        state: "provider_created",
        evidenceDigest: sha256(
          `${fork.provider_creation_correlation}:${input.childProviderThreadId}`
        ),
        actorKind: "target_runner",
        actorId: input.targetDeviceId
      });
      await transition(client, {
        forkId: fork.id,
        ownerUserId: actor.userId,
        stateVersion: childBoundVersion,
        state: "child_bound",
        evidenceDigest: sha256(
          `${input.childExecutionId}:${input.childLogicalSessionId}:${input.childLogicalSourceId}`
        ),
        actorKind: "target_runner",
        actorId: input.targetDeviceId
      });
      await transition(client, {
        forkId: fork.id,
        ownerUserId: actor.userId,
        stateVersion: runningVersion,
        state: "running",
        evidenceDigest: fork.manifest_digest,
        actorKind: "target_runner",
        actorId: input.targetDeviceId
      });
      const updated = await client.query<ForkRow>(
        `update managed_conversation_forks
            set state = 'running',
                state_version = $3,
                child_logical_session_id = $4,
                child_logical_source_id = $5,
                failure_code = null,
                completed_at = now(),
                updated_at = now()
          where owner_user_id = $1 and id = $2
          returning ${FORK_COLUMNS}`,
        [
          actor.userId,
          fork.id,
          runningVersion,
          input.childLogicalSessionId,
          input.childLogicalSourceId
        ]
      );
      await appendEvent(
        client,
        actor.userId,
        fork.parent_execution_id,
        `managed-fork:${fork.id}:running`
      );
      await appendEvent(
        client,
        actor.userId,
        input.childExecutionId,
        `managed-fork:${fork.id}:child-running`
      );
      await client.query("commit");
      return mapFork(updated.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async failManagedConversationFork(actor, input) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(input.failureCode)) {
      throw fail(
        "Managed Conversation fork failure code is invalid",
        400,
        "managed_conversation_fork_failure_invalid"
      );
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ForkRow>(
        `select ${FORK_COLUMNS}
           from managed_conversation_forks
          where owner_user_id = $1 and id = $2
          for update`,
        [actor.userId, input.forkId]
      );
      const fork = result.rows[0];
      if (
        !fork ||
        !["requested", "source_prepared", "source_attested"].includes(
          fork.state
        ) ||
        fork.state_version !== input.expectedStateVersion ||
        (fork.state === "source_attested"
          ? fork.target_device_id !== input.deviceId
          : fork.source_device_id !== input.deviceId)
      ) {
        throw fail(
          "Managed Conversation fork failure transition conflicted",
          409,
          "managed_conversation_fork_failure_conflict"
        );
      }
      const nextVersion = fork.state_version + 1;
      const updated = await client.query<ForkRow>(
        `update managed_conversation_forks
            set state = $3,
                state_version = $4,
                failure_code = $5,
                completed_at = now(),
                updated_at = now()
          where owner_user_id = $1 and id = $2
          returning ${FORK_COLUMNS}`,
        [actor.userId, fork.id, input.state, nextVersion, input.failureCode]
      );
      await transition(client, {
        forkId: fork.id,
        ownerUserId: actor.userId,
        stateVersion: nextVersion,
        state: input.state,
        evidenceDigest: sha256(input.failureCode),
        actorKind:
          fork.state === "source_attested" ? "target_runner" : "source_runner",
        actorId: input.deviceId
      });
      if (input.state === "failed") {
        await client.query(
          `update managed_conversation_commands
              set state = 'canceled',
                  lease_token = null,
                  lease_expires_at = null,
                  blocked_on_kind = null,
                  blocked_on_id = null,
                  last_error_code = $4,
                  completed_at = coalesce(completed_at, now()),
                  updated_at = now()
            where owner_user_id = $1
              and execution_id = $2
              and idempotency_key in ($3, $5)
              and state in (
                'queued','blocked','dispatching','indeterminate'
              )`,
          [
            actor.userId,
            fork.parent_execution_id,
            `fork:${fork.operation_id}:prepare`,
            input.failureCode,
            `fork:${fork.operation_id}:create`
          ]
        );
      }
      await appendEvent(
        client,
        actor.userId,
        fork.parent_execution_id,
        `managed-fork:${fork.id}:${input.state}`
      );
      await client.query("commit");
      return mapFork(updated.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});
