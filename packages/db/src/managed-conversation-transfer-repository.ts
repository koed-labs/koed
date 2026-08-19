import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify
} from "node:crypto";

import {
  MANAGED_CONVERSATION_TRANSFER_PROTOCOL_V2,
  canonicalManagedConversationHandoffManifest,
  countersignManagedConversationHandoffCertificate,
  decryptEnvelopeToUtf8,
  managedConversationAuthorityLogHead,
  managedConversationHandoffCertificateDigest,
  managedConversationTargetReadinessEvidenceDigest,
  managedConversationTargetReadinessIsFresh,
  parseManagedConversationHandoffCertificate,
  parseManagedConversationHandoffManifest,
  parseManagedConversationTargetReadinessEvidence,
  pdsEd25519PublicKey,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type ManagedConversationHandoffCertificate,
  type ManagedConversationHandoffManifest,
  type ManagedConversationHandoffState,
  type ManagedConversationTargetReadinessEvidence
} from "@koed/shared";
import type pg from "pg";

import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { managedConversationEventMutationId } from "./managed-conversation-event.js";
import type { ActorContext } from "./types.js";

export interface ManagedConversationHandoffRecord {
  id: string;
  ownerUserId: string;
  executionId: string;
  operationId: string;
  requestDigest: string;
  state: ManagedConversationHandoffState;
  stateVersion: number;
  sourceExecutionGeneration: number;
  nextExecutionGeneration: number;
  sourceDeploymentId: string;
  sourceDeviceId: string;
  targetDeploymentId: string;
  targetDeviceId: string;
  logicalSourceId: string | null;
  sourceGenerationId: string | null;
  sourceClosureHash: string | null;
  sourceEndByteCursor: number | null;
  sourceEndItemCursor: number | null;
  workspaceSnapshotId: string | null;
  workspaceManifestDigest: string | null;
  authoritySequence: number | null;
  priorAuthorityLogHead: string | null;
  transferManifest: ManagedConversationHandoffManifest | null;
  sourceAttestation: Record<string, unknown> | null;
  targetReadinessEvidence: ManagedConversationTargetReadinessEvidence | null;
  targetReadinessDigest: string | null;
  certificate: ManagedConversationHandoffCertificate | null;
  certificateDigest: string | null;
  resultingAuthorityLogHead: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  transferredAt: string | null;
  completedAt: string | null;
}

export interface ManagedConversationHandoffTargetMaterial {
  handoff: ManagedConversationHandoffRecord;
  snapshot: {
    id: string;
    manifestDigest: string;
    sourceStateDigest: string;
    packageDigest: string;
    packageByteCount: number;
    chunkCount: number;
    readinessEvidence: Record<string, unknown>;
  };
  sourcePublicKey: string;
  authorityPublicKey: string;
}

export interface ManagedConversationTransferRepository {
  requestManagedConversationHandoff(
    actor: ActorContext,
    input: {
      executionId: string;
      operationId: string;
      sourceDeploymentId: string;
      sourceDeviceId: string;
      targetDeploymentId: string;
      targetDeviceId: string;
    }
  ): Promise<ManagedConversationHandoffRecord>;
  getManagedConversationHandoff(
    actor: ActorContext,
    handoffId: string
  ): Promise<ManagedConversationHandoffRecord | null>;
  getActiveManagedConversationHandoffForExecution(
    actor: ActorContext,
    executionId: string
  ): Promise<ManagedConversationHandoffRecord | null>;
  getLatestManagedConversationHandoffForExecution(
    actor: ActorContext,
    executionId: string
  ): Promise<ManagedConversationHandoffRecord | null>;
  getManagedConversationHandoffTargetMaterial(
    actor: ActorContext,
    input: { handoffId: string; targetDeviceId: string }
  ): Promise<ManagedConversationHandoffTargetMaterial | null>;
  prepareManagedConversationHandoff(
    actor: ActorContext,
    input: {
      handoffId: string;
      expectedStateVersion: number;
      runnerId: string;
      providerArtifactRelativePath: string;
      logicalSourceId: string;
      sourceGenerationId: string;
      sourceClosureHash: string;
      sourceEndByteCursor: number;
      sourceEndItemCursor: number;
      workspaceSnapshotId: string;
    }
  ): Promise<{
    handoff: ManagedConversationHandoffRecord;
    manifest: ManagedConversationHandoffManifest;
    sourceOriginKeyId: string;
  }>;
  attestManagedConversationHandoffSource(
    actor: ActorContext,
    input: {
      handoffId: string;
      expectedStateVersion: number;
      sourceKeyId: string;
      sourceSignature: string;
    }
  ): Promise<ManagedConversationHandoffRecord>;
  verifyManagedConversationHandoffTarget(
    actor: ActorContext,
    input: {
      handoffId: string;
      expectedStateVersion: number;
      targetDeviceId: string;
      evidence: ManagedConversationTargetReadinessEvidence;
    }
  ): Promise<ManagedConversationHandoffRecord>;
  commitManagedConversationHandoff(
    actor: ActorContext,
    input: {
      handoffId: string;
      expectedStateVersion: number;
    }
  ): Promise<ManagedConversationHandoffRecord>;
  beginManagedConversationHandoffRestore(
    actor: ActorContext,
    input: {
      handoffId: string;
      expectedStateVersion: number;
      targetDeviceId: string;
      runnerId: string;
      leaseMs: number;
    }
  ): Promise<ManagedConversationHandoffRecord>;
  renewManagedConversationHandoffRestoreLease(input: {
    handoffId: string;
    expectedStateVersion: number;
    targetDeviceId: string;
    runnerId: string;
    leaseMs: number;
  }): Promise<boolean>;
  completeManagedConversationHandoffRestore(
    actor: ActorContext,
    input: {
      handoffId: string;
      expectedStateVersion: number;
      targetDeviceId: string;
      runnerId: string;
      logicalSessionId: string;
      providerThreadId: string;
      providerCliVersion: string;
      sourceGenerationId: string;
    }
  ): Promise<ManagedConversationHandoffRecord>;
}

type HandoffRow = {
  id: string;
  owner_user_id: string;
  execution_id: string;
  operation_id: string;
  request_digest: string;
  state: ManagedConversationHandoffState;
  state_version: number;
  source_execution_generation: number;
  next_execution_generation: number;
  source_deployment_id: string;
  source_device_id: string;
  target_deployment_id: string;
  target_device_id: string;
  logical_source_id: string | null;
  source_generation_id: string | null;
  source_closure_hash: string | null;
  source_end_byte_cursor: string | number | null;
  source_end_item_cursor: string | number | null;
  workspace_snapshot_id: string | null;
  workspace_manifest_digest: string | null;
  authority_sequence: number | null;
  prior_authority_log_head: string | null;
  transfer_manifest: Record<string, unknown> | null;
  source_attestation: Record<string, unknown> | null;
  target_readiness_evidence: Record<string, unknown> | null;
  target_readiness_digest: string | null;
  certificate: Record<string, unknown> | null;
  certificate_digest: string | null;
  resulting_authority_log_head: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  transferred_at: Date | null;
  completed_at: Date | null;
};

type AuthorityRow = {
  execution_id: string;
  owner_user_id: string;
  authority_key_id: string;
  authority_public_key: string;
  encrypted_authority_private_key: Record<string, unknown>;
  head_sequence: number;
  head_hash: string | null;
  highest_execution_generation: number;
  quarantined_at: Date | null;
};

const HANDOFF_COLUMNS = `
  id, owner_user_id, execution_id, operation_id, request_digest, state,
  state_version, source_execution_generation, next_execution_generation,
  source_deployment_id, source_device_id, target_deployment_id,
  target_device_id, logical_source_id, source_generation_id,
  source_closure_hash, source_end_byte_cursor, source_end_item_cursor,
  workspace_snapshot_id, workspace_manifest_digest, authority_sequence,
  prior_authority_log_head, transfer_manifest, source_attestation, certificate,
  target_readiness_evidence, target_readiness_digest, certificate_digest,
  resulting_authority_log_head, failure_code,
  created_at, updated_at, transferred_at, completed_at
`;

const mapHandoff = (row: HandoffRow): ManagedConversationHandoffRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  executionId: row.execution_id,
  operationId: row.operation_id,
  requestDigest: row.request_digest,
  state: row.state,
  stateVersion: row.state_version,
  sourceExecutionGeneration: row.source_execution_generation,
  nextExecutionGeneration: row.next_execution_generation,
  sourceDeploymentId: row.source_deployment_id,
  sourceDeviceId: row.source_device_id,
  targetDeploymentId: row.target_deployment_id,
  targetDeviceId: row.target_device_id,
  logicalSourceId: row.logical_source_id,
  sourceGenerationId: row.source_generation_id,
  sourceClosureHash: row.source_closure_hash,
  sourceEndByteCursor:
    row.source_end_byte_cursor === null
      ? null
      : Number(row.source_end_byte_cursor),
  sourceEndItemCursor:
    row.source_end_item_cursor === null
      ? null
      : Number(row.source_end_item_cursor),
  workspaceSnapshotId: row.workspace_snapshot_id,
  workspaceManifestDigest: row.workspace_manifest_digest,
  authoritySequence: row.authority_sequence,
  priorAuthorityLogHead: row.prior_authority_log_head,
  transferManifest: row.transfer_manifest
    ? parseManagedConversationHandoffManifest(row.transfer_manifest)
    : null,
  sourceAttestation: row.source_attestation,
  targetReadinessEvidence: row.target_readiness_evidence
    ? parseManagedConversationTargetReadinessEvidence(
        row.target_readiness_evidence
      )
    : null,
  targetReadinessDigest: row.target_readiness_digest,
  certificate: row.certificate
    ? parseManagedConversationHandoffCertificate(row.certificate)
    : null,
  certificateDigest: row.certificate_digest,
  resultingAuthorityLogHead: row.resulting_authority_log_head,
  failureCode: row.failure_code,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  transferredAt: row.transferred_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null
});

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const fail = (
  message: string,
  statusCode: number,
  code: string
): Error & { statusCode: number; code: string } =>
  Object.assign(new Error(message), { statusCode, code });

const transition = async (
  client: pg.PoolClient,
  input: {
    handoffId: string;
    ownerUserId: string;
    stateVersion: number;
    state: ManagedConversationHandoffState;
    evidenceDigest: string;
    actorKind:
      | "user"
      | "source_runner"
      | "target_runner"
      | "authority"
      | "recovery";
    actorId: string;
  }
): Promise<void> => {
  await client.query(
    `insert into managed_conversation_handoff_transitions (
       handoff_id, owner_user_id, state_version, state, evidence_digest,
       actor_kind, actor_id
     ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.handoffId,
      input.ownerUserId,
      input.stateVersion,
      input.state,
      input.evidenceDigest,
      input.actorKind,
      input.actorId
    ]
  );
};

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

export const createManagedConversationTransferRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider }
): ManagedConversationTransferRepository => {
  const encryption = (): EnvelopeEncryptionProvider => {
    if (!options.envelopeEncryptionProvider) {
      throw fail(
        "Managed Conversation transfer encryption is unavailable",
        503,
        "managed_conversation_transfer_encryption_unavailable"
      );
    }
    return options.envelopeEncryptionProvider;
  };

  const createAuthority = async (
    client: pg.PoolClient,
    ownerUserId: string,
    executionId: string,
    executionGeneration: number
  ): Promise<void> => {
    const keyId = randomUUID();
    const pair = generateKeyPairSync("ed25519");
    const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const privateDer = pair.privateKey.export({
      format: "der",
      type: "pkcs8"
    });
    if (typeof publicJwk.x !== "string") {
      throw new Error("Managed Conversation authority key export failed");
    }
    const encrypted = await encryption().encrypt({
      plaintext: Buffer.from(privateDer).toString("base64url"),
      scope: {
        tenantId: ownerUserId,
        objectClass: "managed_conversation_authority_key"
      },
      provenance: {
        rowFamily: "managed_conversation_authority_logs",
        sourceId: executionId
      },
      ciphertextLocation:
        "managed_conversation_authority_logs.encrypted_authority_private_key",
      aad: { ownerUserId, executionId, keyId }
    });
    await client.query(
      `insert into managed_conversation_authority_logs (
         execution_id, owner_user_id, authority_key_id, authority_public_key,
         encrypted_authority_private_key, highest_execution_generation
       ) values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (execution_id) do nothing`,
      [
        executionId,
        ownerUserId,
        keyId,
        publicJwk.x,
        encrypted,
        executionGeneration
      ]
    );
  };

  return {
    async requestManagedConversationHandoff(actor, input) {
      if (input.sourceDeviceId === input.targetDeviceId) {
        throw fail(
          "Managed Conversation handoff target must be another device",
          400,
          "managed_conversation_handoff_same_device"
        );
      }
      const requestDigest = sha256(
        JSON.stringify({
          executionId: input.executionId,
          operationId: input.operationId,
          sourceDeploymentId: input.sourceDeploymentId,
          sourceDeviceId: input.sourceDeviceId,
          targetDeploymentId: input.targetDeploymentId,
          targetDeviceId: input.targetDeviceId
        })
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const replay = await client.query<HandoffRow>(
          `select ${HANDOFF_COLUMNS}
             from managed_conversation_handoffs
            where owner_user_id = $1 and operation_id = $2
            for update`,
          [actor.userId, input.operationId]
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_digest !== requestDigest) {
            throw fail(
              "Managed Conversation handoff idempotency conflict",
              409,
              "managed_conversation_handoff_idempotency_conflict"
            );
          }
          await client.query("commit");
          return mapHandoff(replay.rows[0]);
        }
        const execution = await client.query<{
          execution_generation: number;
          state_version: number;
          state: string;
          provider: string;
          runner_id: string | null;
          runner_deployment_id: string;
          runner_device_id: string;
        }>(
          `select execution_generation, state_version, state, runner_id,
                  runner_deployment_id, runner_device_id
             from managed_conversation_executions
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, input.executionId]
        );
        const current = execution.rows[0];
        if (
          !current ||
          current.state !== "running" ||
          current.runner_deployment_id !== input.sourceDeploymentId ||
          current.runner_device_id !== input.sourceDeviceId
        ) {
          throw fail(
            "Managed Conversation is not writable on a source runner",
            409,
            "managed_conversation_handoff_source_not_writable"
          );
        }
        const unsettled = await client.query<{ exists: boolean }>(
          `select exists (
             select 1
               from managed_conversation_commands
              where execution_id = $1
                and state in ('queued','dispatching','indeterminate')
           ) as exists`,
          [input.executionId]
        );
        if (unsettled.rows[0]?.exists) {
          throw fail(
            "Managed Conversation has unsettled commands",
            409,
            "managed_conversation_handoff_commands_unsettled"
          );
        }
        await createAuthority(
          client,
          actor.userId,
          input.executionId,
          current.execution_generation
        );
        const handoffId = randomUUID();
        const inserted = await client.query<HandoffRow>(
          `insert into managed_conversation_handoffs (
             id, owner_user_id, execution_id, operation_id, request_digest,
             source_execution_generation, next_execution_generation,
             source_deployment_id, source_device_id, target_deployment_id,
             target_device_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning ${HANDOFF_COLUMNS}`,
          [
            handoffId,
            actor.userId,
            input.executionId,
            input.operationId,
            requestDigest,
            current.execution_generation,
            current.execution_generation + 1,
            input.sourceDeploymentId,
            input.sourceDeviceId,
            input.targetDeploymentId,
            input.targetDeviceId
          ]
        );
        const commandId = randomUUID();
        const sequence = await client.query<{ value: number }>(
          `select coalesce(max(sequence), -1) + 1 as value
             from managed_conversation_commands
            where execution_id = $1`,
          [input.executionId]
        );
        await client.query(
          `insert into managed_conversation_commands (
             id, owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, request_digest, execution_generation
           ) values ($1, $2, $3, $4, $5, 'quiesce', $6, $7)`,
          [
            commandId,
            actor.userId,
            input.executionId,
            `handoff:${input.operationId}:quiesce`,
            sequence.rows[0]!.value,
            requestDigest,
            current.execution_generation
          ]
        );
        await client.query(
          `update managed_conversation_executions
              set state = 'quiesce_requested',
                  state_version = state_version + 1,
                  updated_at = now()
            where id = $2 and owner_user_id = $1`,
          [actor.userId, input.executionId]
        );
        await transition(client, {
          handoffId,
          ownerUserId: actor.userId,
          stateVersion: 1,
          state: "quiesce_requested",
          evidenceDigest: requestDigest,
          actorKind: "user",
          actorId: actor.userId
        });
        await appendEvent(
          client,
          actor.userId,
          input.executionId,
          `managed-handoff:${handoffId}:requested`
        );
        await notifyCommands(client, input.executionId);
        await client.query("commit");
        return mapHandoff(inserted.rows[0]!);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async getManagedConversationHandoff(actor, handoffId) {
      const result = await pool.query<HandoffRow>(
        `select ${HANDOFF_COLUMNS}
           from managed_conversation_handoffs
          where id = $2 and owner_user_id = $1`,
        [actor.userId, handoffId]
      );
      return result.rows[0] ? mapHandoff(result.rows[0]) : null;
    },

    async getActiveManagedConversationHandoffForExecution(actor, executionId) {
      const result = await pool.query<HandoffRow>(
        `select ${HANDOFF_COLUMNS}
           from managed_conversation_handoffs
          where execution_id = $2
            and owner_user_id = $1
            and state not in ('running','failed','quarantined')
          limit 1`,
        [actor.userId, executionId]
      );
      return result.rows[0] ? mapHandoff(result.rows[0]) : null;
    },

    async getLatestManagedConversationHandoffForExecution(actor, executionId) {
      const result = await pool.query<HandoffRow>(
        `select ${HANDOFF_COLUMNS}
           from managed_conversation_handoffs
          where execution_id = $2
            and owner_user_id = $1
          order by created_at desc, id desc
          limit 1`,
        [actor.userId, executionId]
      );
      return result.rows[0] ? mapHandoff(result.rows[0]) : null;
    },

    async getManagedConversationHandoffTargetMaterial(actor, input) {
      const result = await pool.query<
        HandoffRow & {
          snapshot_id: string;
          snapshot_manifest_digest: string;
          snapshot_source_state_digest: string;
          snapshot_package_digest: string;
          snapshot_package_byte_count: string | number;
          snapshot_chunk_count: number;
          snapshot_readiness_evidence: Record<string, unknown>;
          source_public_key: string;
          authority_public_key: string;
        }
      >(
        `select ${HANDOFF_COLUMNS.split(",")
          .map((column) => `handoff.${column.trim()}`)
          .join(", ")},
                snapshot.id as snapshot_id,
                snapshot.manifest_digest as snapshot_manifest_digest,
                snapshot.source_state_digest as snapshot_source_state_digest,
                snapshot.package_digest as snapshot_package_digest,
                snapshot.package_byte_count as snapshot_package_byte_count,
                snapshot.chunk_count as snapshot_chunk_count,
                snapshot.readiness_evidence as snapshot_readiness_evidence,
                source.origin_public_key as source_public_key,
                authority.authority_public_key as authority_public_key
           from managed_conversation_handoffs handoff
           join development_workspace_snapshots snapshot
             on snapshot.id = handoff.workspace_snapshot_id
            and snapshot.owner_user_id = handoff.owner_user_id
           join conversation_source_artifacts source
             on source.owner_user_id = handoff.owner_user_id
            and source.logical_source_id = handoff.logical_source_id
            and source.source_generation_id = handoff.source_generation_id
           join managed_conversation_authority_logs authority
             on authority.execution_id = handoff.execution_id
            and authority.owner_user_id = handoff.owner_user_id
          where handoff.id = $2
            and handoff.owner_user_id = $1
            and handoff.target_device_id = $3
            and handoff.state in (
              'workspace_prepared',
              'target_verified',
              'lease_transferred',
              'restoring',
              'identity_verified',
              'running'
            )
            and snapshot.state = 'ready'
            and snapshot.revoked_at is null
            and snapshot.deleted_at is null
            and authority.quarantined_at is null`,
        [actor.userId, input.handoffId, input.targetDeviceId]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        handoff: mapHandoff(row),
        snapshot: {
          id: row.snapshot_id,
          manifestDigest: row.snapshot_manifest_digest,
          sourceStateDigest: row.snapshot_source_state_digest,
          packageDigest: row.snapshot_package_digest,
          packageByteCount: Number(row.snapshot_package_byte_count),
          chunkCount: row.snapshot_chunk_count,
          readinessEvidence: row.snapshot_readiness_evidence
        },
        sourcePublicKey: row.source_public_key,
        authorityPublicKey: row.authority_public_key
      };
    },

    async prepareManagedConversationHandoff(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<HandoffRow>(
          `select ${HANDOFF_COLUMNS}
             from managed_conversation_handoffs
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, input.handoffId]
        );
        const handoff = result.rows[0];
        if (
          !handoff ||
          handoff.state !== "quiesce_requested" ||
          handoff.state_version !== input.expectedStateVersion
        ) {
          throw fail(
            "Managed Conversation handoff preparation conflicted",
            409,
            "managed_conversation_handoff_prepare_conflict"
          );
        }
        const execution = await client.query<{
          state: string;
          provider: string;
          ai_client_instance_id: string;
          execution_generation: number;
          runner_id: string | null;
          provider_thread_id: string | null;
          provider_cli_version: string | null;
        }>(
          `select state, provider, ai_client_instance_id, execution_generation, runner_id, provider_thread_id,
                  provider_cli_version
             from managed_conversation_executions
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, handoff.execution_id]
        );
        if (
          execution.rows[0]?.state !== "quiesced" ||
          execution.rows[0].execution_generation !==
            handoff.source_execution_generation ||
          execution.rows[0].runner_id !== input.runnerId ||
          !execution.rows[0].provider_thread_id ||
          !execution.rows[0].provider_cli_version
        ) {
          throw fail(
            "Managed Conversation source is not quiesced by its owner",
            409,
            "managed_conversation_handoff_source_not_quiesced"
          );
        }
        const artifact = await client.query<{
          origin_key_id: string;
          lifecycle: string;
          closure_hash: string | null;
          logical_source_id: string;
          source_generation_id: string;
          provider_cursor_offset: string | number;
          provider_cursor_line: number;
        }>(
          `select origin_key_id, lifecycle, closure_hash, logical_source_id,
                  source_generation_id, provider_cursor_offset,
                  provider_cursor_line
             from conversation_source_artifacts
            where owner_user_id = $1
              and logical_source_id = $2
              and source_generation_id = $3
            for update`,
          [actor.userId, input.logicalSourceId, input.sourceGenerationId]
        );
        const source = artifact.rows[0];
        if (
          !source ||
          source.lifecycle !== "finalized" ||
          source.closure_hash !== input.sourceClosureHash ||
          Number(source.provider_cursor_offset) !== input.sourceEndByteCursor ||
          source.provider_cursor_line !== input.sourceEndItemCursor
        ) {
          throw fail(
            "Managed Conversation source closure is not exact",
            409,
            "managed_conversation_handoff_source_closure_conflict"
          );
        }
        const snapshot = (
          await client.query<{
            id: string;
            manifest_digest: string;
          }>(
            `select id, manifest_digest
               from development_workspace_snapshots
              where id = $2
                and owner_user_id = $1
                and execution_id = $3
                and operation_kind = 'handoff'
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
              handoff.execution_id,
              handoff.id,
              input.sourceGenerationId,
              handoff.source_deployment_id,
              handoff.source_device_id
            ]
          )
        ).rows[0];
        if (!snapshot) {
          throw fail(
            "Managed Conversation workspace snapshot is not ready",
            409,
            "managed_conversation_handoff_snapshot_not_ready"
          );
        }
        const authority = await client.query<AuthorityRow>(
          `select *
             from managed_conversation_authority_logs
            where execution_id = $1 and owner_user_id = $2
            for update`,
          [handoff.execution_id, actor.userId]
        );
        const log = authority.rows[0];
        if (
          !log ||
          log.quarantined_at ||
          log.highest_execution_generation !==
            handoff.source_execution_generation
        ) {
          throw fail(
            "Managed Conversation authority is unavailable",
            409,
            "managed_conversation_authority_conflict"
          );
        }
        const authoritySequence = log.head_sequence + 1;
        const now = new Date();
        const manifest: ManagedConversationHandoffManifest = {
          protocol: MANAGED_CONVERSATION_TRANSFER_PROTOCOL_V2,
          operationId: handoff.operation_id,
          ownerUserId: actor.userId,
          executionId: handoff.execution_id,
          sourceExecutionGeneration: handoff.source_execution_generation,
          nextExecutionGeneration: handoff.next_execution_generation,
          logicalSourceId: input.logicalSourceId,
          sourceGenerationId: input.sourceGenerationId,
          nextSourceGenerationId: randomUUID(),
          targetOriginKeyId: randomUUID(),
          sourceClosureHash: input.sourceClosureHash,
          sourceEndByteCursor: input.sourceEndByteCursor,
          sourceEndItemCursor: input.sourceEndItemCursor,
          provider: execution.rows[0].provider,
          aiClientInstanceId: execution.rows[0].ai_client_instance_id,
          providerThreadId: execution.rows[0].provider_thread_id,
          providerArtifactRelativePath: input.providerArtifactRelativePath,
          providerCliVersion: execution.rows[0].provider_cli_version,
          workspaceSnapshotId: snapshot.id,
          workspaceManifestDigest: snapshot.manifest_digest,
          sourceDeploymentId: handoff.source_deployment_id,
          sourceDeviceId: handoff.source_device_id,
          targetDeploymentId: handoff.target_deployment_id,
          targetDeviceId: handoff.target_device_id,
          authoritySequence,
          priorAuthorityLogHead: log.head_hash,
          nonce: randomBytes(32).toString("base64url"),
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
        };
        const providerStoppedVersion = handoff.state_version + 1;
        const sourceSealedVersion = providerStoppedVersion + 1;
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: providerStoppedVersion,
          state: "provider_stopped",
          evidenceDigest: sha256(
            `${input.sourceGenerationId}:${input.sourceClosureHash}:stopped`
          ),
          actorKind: "source_runner",
          actorId: input.runnerId
        });
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: sourceSealedVersion,
          state: "source_sealed",
          evidenceDigest: input.sourceClosureHash,
          actorKind: "source_runner",
          actorId: input.runnerId
        });
        const updated = await client.query<HandoffRow>(
          `update managed_conversation_handoffs
              set state = 'source_sealed',
                  state_version = $3,
                  logical_source_id = $4,
                  source_generation_id = $5,
                  source_closure_hash = $6,
                  source_end_byte_cursor = $7,
                  source_end_item_cursor = $8,
                  workspace_snapshot_id = $9,
                  workspace_manifest_digest = $10,
                  authority_sequence = $11,
                  prior_authority_log_head = $12,
                  transfer_manifest = $13::jsonb,
                  updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${HANDOFF_COLUMNS}`,
          [
            actor.userId,
            handoff.id,
            sourceSealedVersion,
            input.logicalSourceId,
            input.sourceGenerationId,
            input.sourceClosureHash,
            input.sourceEndByteCursor,
            input.sourceEndItemCursor,
            snapshot.id,
            snapshot.manifest_digest,
            authoritySequence,
            log.head_hash,
            manifest
          ]
        );
        await client.query("commit");
        return {
          handoff: mapHandoff(updated.rows[0]!),
          manifest,
          sourceOriginKeyId: source.origin_key_id
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async attestManagedConversationHandoffSource(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<HandoffRow>(
          `select ${HANDOFF_COLUMNS}
             from managed_conversation_handoffs
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, input.handoffId]
        );
        const handoff = result.rows[0];
        if (
          !handoff ||
          handoff.state !== "source_sealed" ||
          handoff.state_version !== input.expectedStateVersion ||
          !handoff.logical_source_id ||
          !handoff.source_generation_id ||
          !handoff.source_closure_hash ||
          handoff.source_end_byte_cursor === null ||
          handoff.source_end_item_cursor === null ||
          !handoff.workspace_snapshot_id ||
          !handoff.workspace_manifest_digest ||
          handoff.authority_sequence === null ||
          !handoff.transfer_manifest
        ) {
          throw fail(
            "Managed Conversation source attestation conflicted",
            409,
            "managed_conversation_source_attestation_conflict"
          );
        }
        const source = await client.query<{
          origin_key_id: string;
          origin_public_key: string;
        }>(
          `select origin_key_id, origin_public_key
             from conversation_source_artifacts
            where owner_user_id = $1
              and logical_source_id = $2
              and source_generation_id = $3
              and lifecycle = 'finalized'`,
          [
            actor.userId,
            handoff.logical_source_id,
            handoff.source_generation_id
          ]
        );
        if (
          source.rows[0]?.origin_key_id !== input.sourceKeyId ||
          !/^[A-Za-z0-9_-]{86}$/.test(input.sourceSignature)
        ) {
          throw fail(
            "Managed Conversation source attestation identity is invalid",
            409,
            "managed_conversation_source_attestation_invalid"
          );
        }
        const manifest = parseManagedConversationHandoffManifest(
          handoff.transfer_manifest
        );
        const sourceAttestation = {
          keyId: input.sourceKeyId,
          signature: input.sourceSignature
        };
        if (
          !verify(
            null,
            Buffer.from(
              canonicalManagedConversationHandoffManifest(manifest),
              "utf8"
            ),
            pdsEd25519PublicKey(source.rows[0].origin_public_key),
            Buffer.from(input.sourceSignature, "base64url")
          )
        ) {
          throw fail(
            "Managed Conversation source attestation signature is invalid",
            409,
            "managed_conversation_source_attestation_invalid"
          );
        }
        const nextVersion = handoff.state_version + 1;
        const evidenceDigest = sha256(JSON.stringify(sourceAttestation));
        const updated = await client.query<HandoffRow>(
          `update managed_conversation_handoffs
              set state = 'workspace_prepared',
                  state_version = $3,
                  source_attestation = $4::jsonb,
                  updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${HANDOFF_COLUMNS}`,
          [actor.userId, handoff.id, nextVersion, sourceAttestation]
        );
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: nextVersion,
          state: "workspace_prepared",
          evidenceDigest,
          actorKind: "source_runner",
          actorId: input.sourceKeyId
        });
        const sequence = await client.query<{ value: number }>(
          `select coalesce(max(sequence), -1) + 1 as value
             from managed_conversation_commands
            where execution_id = $1`,
          [handoff.execution_id]
        );
        await client.query(
          `insert into managed_conversation_commands (
             owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, target_deployment_id, target_device_id, request_digest,
             execution_generation
           ) values ($1, $2, $3, $4, 'verify_target', $5, $6, $7, $8)`,
          [
            actor.userId,
            handoff.execution_id,
            `handoff:${handoff.operation_id}:verify-target`,
            sequence.rows[0]!.value,
            handoff.target_deployment_id,
            handoff.target_device_id,
            evidenceDigest,
            handoff.source_execution_generation
          ]
        );
        await notifyCommands(client, handoff.execution_id);
        await client.query("commit");
        return mapHandoff(updated.rows[0]!);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async verifyManagedConversationHandoffTarget(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const evidence = parseManagedConversationTargetReadinessEvidence(
          input.evidence
        );
        const evidenceDigest =
          managedConversationTargetReadinessEvidenceDigest(evidence);
        const result = await client.query<HandoffRow>(
          `select ${HANDOFF_COLUMNS}
             from managed_conversation_handoffs
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, input.handoffId]
        );
        const handoff = result.rows[0];
        if (
          !handoff ||
          !["workspace_prepared", "target_verified"].includes(handoff.state) ||
          handoff.state_version !== input.expectedStateVersion ||
          handoff.target_device_id !== input.targetDeviceId ||
          !handoff.workspace_snapshot_id ||
          evidence.operationId !== handoff.operation_id ||
          evidence.executionId !== handoff.execution_id ||
          evidence.snapshotId !== handoff.workspace_snapshot_id ||
          evidence.sourceGenerationId !== handoff.source_generation_id ||
          evidence.targetDeploymentId !== handoff.target_deployment_id ||
          evidence.targetDeviceId !== handoff.target_device_id ||
          !managedConversationTargetReadinessIsFresh(evidence)
        ) {
          throw fail(
            "Managed Conversation target verification conflicted",
            409,
            "managed_conversation_target_verification_conflict"
          );
        }
        const snapshot = await client.query<{
          state: string;
          manifest_digest: string | null;
          readiness_evidence: Record<string, unknown> | null;
        }>(
          `select state, manifest_digest, readiness_evidence
             from development_workspace_snapshots
            where id = $2 and owner_user_id = $1`,
          [actor.userId, handoff.workspace_snapshot_id]
        );
        if (
          snapshot.rows[0]?.state !== "ready" ||
          snapshot.rows[0].manifest_digest !==
            handoff.workspace_manifest_digest ||
          !snapshot.rows[0].readiness_evidence
        ) {
          throw fail(
            "Development workspace snapshot is not ready",
            409,
            "managed_conversation_workspace_not_ready"
          );
        }
        const nextVersion = handoff.state_version + 1;
        const updated = await client.query<HandoffRow>(
          `update managed_conversation_handoffs
              set state = 'target_verified',
                  state_version = $3,
                  recovery_owner_device_id = $4,
                  target_readiness_evidence = $5::jsonb,
                  target_readiness_digest = $6,
                  updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${HANDOFF_COLUMNS}`,
          [
            actor.userId,
            handoff.id,
            nextVersion,
            input.targetDeviceId,
            evidence,
            evidenceDigest
          ]
        );
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: nextVersion,
          state: "target_verified",
          evidenceDigest,
          actorKind: "target_runner",
          actorId: input.targetDeviceId
        });
        await client.query("commit");
        return mapHandoff(updated.rows[0]!);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async commitManagedConversationHandoff(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<HandoffRow>(
          `select ${HANDOFF_COLUMNS}
             from managed_conversation_handoffs
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, input.handoffId]
        );
        const handoff = result.rows[0];
        if (
          !handoff ||
          handoff.state !== "target_verified" ||
          handoff.state_version !== input.expectedStateVersion ||
          !handoff.transfer_manifest ||
          !handoff.source_attestation ||
          !handoff.target_readiness_evidence ||
          !handoff.target_readiness_digest ||
          handoff.authority_sequence === null
        ) {
          throw fail(
            "Managed Conversation lease transfer conflicted",
            409,
            "managed_conversation_transfer_conflict"
          );
        }
        const manifest = parseManagedConversationHandoffManifest(
          handoff.transfer_manifest
        );
        const readiness = parseManagedConversationTargetReadinessEvidence(
          handoff.target_readiness_evidence
        );
        if (
          !managedConversationTargetReadinessIsFresh(readiness) ||
          managedConversationTargetReadinessEvidenceDigest(readiness) !==
            handoff.target_readiness_digest ||
          readiness.operationId !== handoff.operation_id ||
          readiness.executionId !== handoff.execution_id ||
          readiness.snapshotId !== handoff.workspace_snapshot_id ||
          readiness.sourceGenerationId !== handoff.source_generation_id ||
          readiness.targetDeploymentId !== handoff.target_deployment_id ||
          readiness.targetDeviceId !== handoff.target_device_id
        ) {
          throw fail(
            "Managed Conversation target readiness expired or changed",
            409,
            "managed_conversation_target_readiness_invalid"
          );
        }
        if (Date.parse(manifest.expiresAt) <= Date.now()) {
          throw fail(
            "Managed Conversation transfer certificate expired",
            409,
            "managed_conversation_transfer_expired"
          );
        }
        const sourceAttestation = handoff.source_attestation as {
          keyId?: unknown;
          signature?: unknown;
        };
        if (
          typeof sourceAttestation.keyId !== "string" ||
          typeof sourceAttestation.signature !== "string"
        ) {
          throw fail(
            "Managed Conversation source attestation is invalid",
            409,
            "managed_conversation_source_attestation_invalid"
          );
        }
        const source = await client.query<{
          origin_key_id: string;
          origin_public_key: string;
        }>(
          `select origin_key_id, origin_public_key
             from conversation_source_artifacts
            where owner_user_id = $1
              and logical_source_id = $2
              and source_generation_id = $3
              and lifecycle = 'finalized'
              and closure_hash = $4`,
          [
            actor.userId,
            manifest.logicalSourceId,
            manifest.sourceGenerationId,
            manifest.sourceClosureHash
          ]
        );
        if (
          source.rows[0]?.origin_key_id !== sourceAttestation.keyId ||
          !verify(
            null,
            Buffer.from(
              canonicalManagedConversationHandoffManifest(manifest),
              "utf8"
            ),
            pdsEd25519PublicKey(source.rows[0].origin_public_key),
            Buffer.from(sourceAttestation.signature, "base64url")
          )
        ) {
          throw fail(
            "Managed Conversation source attestation is invalid",
            409,
            "managed_conversation_source_attestation_invalid"
          );
        }
        const authority = await client.query<AuthorityRow>(
          `select *
             from managed_conversation_authority_logs
            where execution_id = $1 and owner_user_id = $2
            for update`,
          [handoff.execution_id, actor.userId]
        );
        const log = authority.rows[0];
        if (
          !log ||
          log.quarantined_at ||
          log.head_sequence + 1 !== handoff.authority_sequence ||
          log.head_hash !== handoff.prior_authority_log_head ||
          log.highest_execution_generation !==
            handoff.source_execution_generation
        ) {
          throw fail(
            "Managed Conversation authority head conflicted",
            409,
            "managed_conversation_authority_conflict"
          );
        }
        const privateKeyBase64url = await decryptEnvelopeToUtf8(
          encryption(),
          log.encrypted_authority_private_key as unknown as EncryptedPayloadEnvelope
        );
        const authorityPrivateKey = createPrivateKey({
          key: Buffer.from(privateKeyBase64url, "base64url"),
          format: "der",
          type: "pkcs8"
        });
        const certificate = countersignManagedConversationHandoffCertificate({
          manifest,
          source: {
            keyId: sourceAttestation.keyId,
            signature: sourceAttestation.signature
          },
          authorityKeyId: log.authority_key_id,
          authorityPrivateKey
        });
        const certificateDigest =
          managedConversationHandoffCertificateDigest(certificate);
        const resultingHead = managedConversationAuthorityLogHead({
          priorHead: log.head_hash,
          sequence: handoff.authority_sequence,
          certificateDigest
        });
        const authorityUpdate = await client.query(
          `update managed_conversation_authority_logs
              set head_sequence = $3,
                  head_hash = $4,
                  highest_execution_generation = $5,
                  updated_at = now()
            where execution_id = $1
              and owner_user_id = $2
              and head_sequence = $6
              and head_hash is not distinct from $7
              and highest_execution_generation = $8
              and quarantined_at is null`,
          [
            handoff.execution_id,
            actor.userId,
            handoff.authority_sequence,
            resultingHead,
            handoff.next_execution_generation,
            log.head_sequence,
            log.head_hash,
            handoff.source_execution_generation
          ]
        );
        if (authorityUpdate.rowCount !== 1) {
          throw fail(
            "Managed Conversation authority changed concurrently",
            409,
            "managed_conversation_authority_conflict"
          );
        }
        const fencingToken = randomBytes(32).toString("base64url");
        const executionUpdate = await client.query(
          `update managed_conversation_executions
              set state = 'reconciling',
                  state_version = state_version + 1,
                  execution_generation = $3,
                  fencing_token_hash = $4,
                  runner_deployment_id = $5,
                  runner_device_id = $6,
                  runner_id = null,
                  runner_lease_expires_at = null,
                  updated_at = now()
            where id = $2
              and owner_user_id = $1
              and execution_generation = $7
              and state = 'quiesced'`,
          [
            actor.userId,
            handoff.execution_id,
            handoff.next_execution_generation,
            sha256(fencingToken),
            handoff.target_deployment_id,
            handoff.target_device_id,
            handoff.source_execution_generation
          ]
        );
        if (executionUpdate.rowCount !== 1) {
          throw fail(
            "Managed Conversation execution generation changed",
            409,
            "managed_conversation_execution_generation_conflict"
          );
        }
        const nextVersion = handoff.state_version + 1;
        const updated = await client.query<HandoffRow>(
          `update managed_conversation_handoffs
              set state = 'lease_transferred',
                  state_version = $3,
                  certificate = $4::jsonb,
                  certificate_digest = $5,
                  resulting_authority_log_head = $6,
                  transferred_at = now(),
                  updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${HANDOFF_COLUMNS}`,
          [
            actor.userId,
            handoff.id,
            nextVersion,
            certificate,
            certificateDigest,
            resultingHead
          ]
        );
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: nextVersion,
          state: "lease_transferred",
          evidenceDigest: certificateDigest,
          actorKind: "authority",
          actorId: log.authority_key_id
        });
        const sequence = await client.query<{ value: number }>(
          `select coalesce(max(sequence), -1) + 1 as value
             from managed_conversation_commands
            where execution_id = $1`,
          [handoff.execution_id]
        );
        await client.query(
          `insert into managed_conversation_commands (
             owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, target_deployment_id, target_device_id, request_digest,
             execution_generation
           ) values ($1, $2, $3, $4, 'restore', $5, $6, $7, $8)`,
          [
            actor.userId,
            handoff.execution_id,
            `handoff:${handoff.operation_id}:restore`,
            sequence.rows[0]!.value,
            handoff.target_deployment_id,
            handoff.target_device_id,
            certificateDigest,
            handoff.next_execution_generation
          ]
        );
        await appendEvent(
          client,
          actor.userId,
          handoff.execution_id,
          `managed-handoff:${handoff.id}:transferred`
        );
        await notifyCommands(client, handoff.execution_id);
        await client.query("commit");
        return mapHandoff(updated.rows[0]!);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async beginManagedConversationHandoffRestore(actor, input) {
      if (
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 30_000 ||
        input.leaseMs > 10 * 60_000
      ) {
        throw fail(
          "Managed Conversation restoration lease is invalid",
          400,
          "managed_conversation_restore_lease_invalid"
        );
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<
          HandoffRow & {
            restoration_lease_owner: string | null;
            restoration_lease_expires_at: Date | null;
          }
        >(
          `select ${HANDOFF_COLUMNS}, restoration_lease_owner,
                  restoration_lease_expires_at
             from managed_conversation_handoffs
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, input.handoffId]
        );
        const handoff = result.rows[0];
        if (
          handoff?.state === "restoring" &&
          handoff.state_version === input.expectedStateVersion &&
          handoff.target_device_id === input.targetDeviceId
        ) {
          if (
            handoff.restoration_lease_owner !== input.runnerId &&
            handoff.restoration_lease_expires_at &&
            handoff.restoration_lease_expires_at.getTime() > Date.now()
          ) {
            throw fail(
              "Managed Conversation restoration is owned by another runner",
              409,
              "managed_conversation_restore_lease_active"
            );
          }
          const renewed = await client.query<HandoffRow>(
            `update managed_conversation_handoffs
                set restoration_lease_owner = $3,
                    restoration_lease_token = $4,
                    restoration_lease_expires_at =
                      now() + ($5::bigint * interval '1 millisecond'),
                    recovery_owner_device_id = $6,
                    updated_at = now()
              where id = $2 and owner_user_id = $1
              returning ${HANDOFF_COLUMNS}`,
            [
              actor.userId,
              handoff.id,
              input.runnerId,
              randomUUID(),
              input.leaseMs,
              input.targetDeviceId
            ]
          );
          await appendEvent(
            client,
            actor.userId,
            handoff.execution_id,
            `managed-handoff:${handoff.id}:restore-lease-recovered`
          );
          await client.query("commit");
          return mapHandoff(renewed.rows[0]!);
        }
        if (
          !handoff ||
          handoff.state !== "lease_transferred" ||
          handoff.state_version !== input.expectedStateVersion ||
          handoff.target_device_id !== input.targetDeviceId
        ) {
          throw fail(
            "Managed Conversation restoration conflicted",
            409,
            "managed_conversation_restore_conflict"
          );
        }
        const nextVersion = handoff.state_version + 1;
        const leaseToken = randomUUID();
        const updated = await client.query<HandoffRow>(
          `update managed_conversation_handoffs
              set state = 'restoring',
                  state_version = $3,
                  restoration_lease_owner = $4,
                  restoration_lease_token = $5,
                  restoration_lease_expires_at =
                    now() + ($6::bigint * interval '1 millisecond'),
                  recovery_owner_device_id = $7,
                  updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${HANDOFF_COLUMNS}`,
          [
            actor.userId,
            handoff.id,
            nextVersion,
            input.runnerId,
            leaseToken,
            input.leaseMs,
            input.targetDeviceId
          ]
        );
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: nextVersion,
          state: "restoring",
          evidenceDigest: sha256(
            `${handoff.certificate_digest}:${input.targetDeviceId}:restoring`
          ),
          actorKind: "target_runner",
          actorId: input.runnerId
        });
        await client.query("commit");
        return mapHandoff(updated.rows[0]!);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async completeManagedConversationHandoffRestore(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<
          HandoffRow & {
            restoration_lease_owner: string | null;
            restoration_lease_expires_at: Date | null;
          }
        >(
          `select ${HANDOFF_COLUMNS}, restoration_lease_owner,
                  restoration_lease_expires_at
             from managed_conversation_handoffs
            where id = $2 and owner_user_id = $1
            for update`,
          [actor.userId, input.handoffId]
        );
        const handoff = result.rows[0];
        if (
          !handoff ||
          handoff.state !== "restoring" ||
          handoff.state_version !== input.expectedStateVersion ||
          handoff.target_device_id !== input.targetDeviceId ||
          handoff.restoration_lease_owner !== input.runnerId ||
          !handoff.restoration_lease_expires_at ||
          handoff.restoration_lease_expires_at.getTime() <= Date.now() ||
          !handoff.certificate_digest
        ) {
          throw fail(
            "Managed Conversation restoration authority was lost",
            409,
            "managed_conversation_restore_authority_lost"
          );
        }
        const execution = await client.query(
          `update managed_conversation_executions
              set state = 'running',
                  state_version = state_version + 1,
                  runner_id = $4,
                  runner_lease_expires_at = now() + interval '3 minutes',
                  logical_session_id = $5,
                  provider_thread_id = $6,
                  provider_cli_version = $7,
                  source_generation_id = $8,
                  last_error_code = null,
                  updated_at = now()
            where owner_user_id = $1
              and id = $2
              and execution_generation = $3
              and state = 'reconciling'`,
          [
            actor.userId,
            handoff.execution_id,
            handoff.next_execution_generation,
            input.runnerId,
            input.logicalSessionId,
            input.providerThreadId,
            input.providerCliVersion,
            input.sourceGenerationId
          ]
        );
        if (execution.rowCount !== 1) {
          throw fail(
            "Managed Conversation execution restoration conflicted",
            409,
            "managed_conversation_restore_execution_conflict"
          );
        }
        const identityVersion = handoff.state_version + 1;
        const runningVersion = identityVersion + 1;
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: identityVersion,
          state: "identity_verified",
          evidenceDigest: sha256(
            `${input.logicalSessionId}:${input.providerThreadId}:${handoff.certificate_digest}`
          ),
          actorKind: "target_runner",
          actorId: input.runnerId
        });
        await transition(client, {
          handoffId: handoff.id,
          ownerUserId: actor.userId,
          stateVersion: runningVersion,
          state: "running",
          evidenceDigest: sha256(
            `${handoff.next_execution_generation}:${input.providerThreadId}:running`
          ),
          actorKind: "target_runner",
          actorId: input.runnerId
        });
        const updated = await client.query<HandoffRow>(
          `update managed_conversation_handoffs
              set state = 'running',
                  state_version = $3,
                  restoration_lease_owner = null,
                  restoration_lease_token = null,
                  restoration_lease_expires_at = null,
                  completed_at = now(),
                  updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${HANDOFF_COLUMNS}`,
          [actor.userId, handoff.id, runningVersion]
        );
        await appendEvent(
          client,
          actor.userId,
          handoff.execution_id,
          `managed-handoff:${handoff.id}:running`
        );
        await client.query("commit");
        return mapHandoff(updated.rows[0]!);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async renewManagedConversationHandoffRestoreLease(input) {
      if (
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 30_000 ||
        input.leaseMs > 10 * 60_000
      ) {
        return false;
      }
      const result = await pool.query(
        `update managed_conversation_handoffs
            set restoration_lease_expires_at =
                  now() + ($5::bigint * interval '1 millisecond'),
                updated_at = now()
          where id = $1
            and state = 'restoring'
            and state_version = $2
            and target_device_id = $3
            and restoration_lease_owner = $4
            and restoration_lease_expires_at > now()`,
        [
          input.handoffId,
          input.expectedStateVersion,
          input.targetDeviceId,
          input.runnerId,
          input.leaseMs
        ]
      );
      return (result.rowCount ?? 0) === 1;
    }
  };
};
