import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import pg from "pg";

import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { managedConversationEventMutationId } from "./managed-conversation-event.js";
import type { ActorContext } from "./types.js";

export type ManagedConversationExecutionState =
  | "starting"
  | "running"
  | "reconciling"
  | "quiesce_requested"
  | "quiesced"
  | "stopping"
  | "stopped"
  | "failed"
  | "fenced";

export type ManagedConversationCommandState =
  | "queued"
  | "blocked"
  | "dispatching"
  | "completed"
  | "indeterminate"
  | "failed"
  | "canceled";

export interface ManagedConversationExecutionRecord {
  id: string;
  ownerUserId: string;
  projectId: string;
  provider: "codex";
  state: ManagedConversationExecutionState;
  stateVersion: number;
  executionGeneration: number;
  runnerDeploymentId: string;
  runnerDeviceId: string;
  runnerId: string | null;
  runnerLeaseExpiresAt: string | null;
  logicalSessionId: string | null;
  providerThreadId: string | null;
  providerCliVersion: string | null;
  sourceGenerationId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  quiescedAt: string | null;
  stoppedAt: string | null;
}

export interface ManagedConversationRuntimeBindingRecord {
  executionId: string;
  ownerUserId: string;
  deploymentId: string;
  deviceId: string;
  executionGeneration: number;
  projectPath: string;
  localSessionId: string | null;
  providerThreadId: string | null;
  transcriptPath: string | null;
  managedHome: string | null;
  providerCliVersion: string | null;
  sourceGenerationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedConversationCommandRecord {
  id: string;
  ownerUserId: string;
  executionId: string;
  idempotencyKey: string;
  sequence: number;
  commandKind:
    | "start"
    | "prompt"
    | "quiesce"
    | "stop"
    | "verify_target"
    | "restore"
    | "fork_prepare"
    | "fork_create";
  targetDeploymentId: string | null;
  targetDeviceId: string | null;
  requestDigest: string;
  clientUserMessageId: string | null;
  executionGeneration: number;
  state: ManagedConversationCommandState;
  blockedOnKind:
    | "source_replica"
    | "source_registration"
    | "runtime_binding"
    | null;
  blockedOnId: string | null;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchingAt: string | null;
  completedAt: string | null;
}

export interface ClaimedManagedConversationCommand extends ManagedConversationCommandRecord {
  execution: ManagedConversationExecutionRecord;
}

export interface ManagedConversationRepository {
  createManagedConversation(
    actor: ActorContext,
    input: {
      projectId: string;
      runnerDeploymentId: string;
      runnerDeviceId: string;
      idempotencyKey: string;
      initialPrompt?: string;
      deferUntilRuntimeBinding?: boolean;
    }
  ): Promise<{
    execution: ManagedConversationExecutionRecord;
    command: ManagedConversationCommandRecord;
    fencingToken: string;
  }>;
  enqueueManagedConversationPrompt(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      idempotencyKey: string;
      prompt: string;
    }
  ): Promise<ManagedConversationCommandRecord>;
  getManagedConversationExecution(
    actor: ActorContext,
    executionId: string
  ): Promise<ManagedConversationExecutionRecord | null>;
  getManagedConversationExecutionBySession(
    actor: ActorContext,
    input: { logicalSessionId: string; providerThreadId: string }
  ): Promise<ManagedConversationExecutionRecord | null>;
  listManagedConversationExecutions(
    actor: ActorContext,
    input?: { projectId?: string; limit?: number }
  ): Promise<ManagedConversationExecutionRecord[]>;
  listManagedConversationExecutionsForRunner(input: {
    ownerUserId?: string;
    deploymentId: string;
    deviceId: string;
    limit?: number;
  }): Promise<ManagedConversationExecutionRecord[]>;
  getManagedConversationCommand(
    actor: ActorContext,
    commandId: string
  ): Promise<ManagedConversationCommandRecord | null>;
  claimManagedConversationCommands(input: {
    ownerUserId?: string;
    runnerId: string;
    deploymentId: string;
    deviceId: string;
    limit?: number;
    leaseMs: number;
  }): Promise<ClaimedManagedConversationCommand[]>;
  reconcileAbandonedManagedConversationCommands(input: {
    ownerUserId?: string;
    deploymentId: string;
    deviceId: string;
    limit?: number;
  }): Promise<number>;
  renewManagedConversationCommandLease(input: {
    commandId: string;
    leaseToken: string;
    runnerId: string;
    executionId: string;
    leaseMs: number;
  }): Promise<boolean>;
  renewManagedConversationExecutionLease(input: {
    executionId: string;
    executionGeneration: number;
    runnerId: string;
    leaseMs: number;
  }): Promise<boolean>;
  acquireManagedConversationExecutionLease(input: {
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
    runnerId: string;
    leaseMs: number;
  }): Promise<boolean>;
  releaseManagedConversationRunner(input: {
    executionId: string;
    executionGeneration: number;
    runnerId: string;
  }): Promise<boolean>;
  bindManagedConversationRuntime(
    actor: ActorContext,
    input: {
      executionId: string;
      expectedStateVersion: number;
      executionGeneration: number;
      runnerId: string;
      logicalSessionId: string;
      providerThreadId: string;
      providerCliVersion?: string;
      sourceGenerationId?: string;
    }
  ): Promise<ManagedConversationExecutionRecord>;
  bindManagedConversationSourceGeneration(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      runnerId: string;
      expectedSourceGenerationId?: string;
      sourceGenerationId: string;
    }
  ): Promise<ManagedConversationExecutionRecord>;
  setManagedConversationExecutionState(
    actor: ActorContext,
    input: {
      executionId: string;
      expectedStateVersion: number;
      executionGeneration: number;
      state: ManagedConversationExecutionState;
      lastErrorCode?: string;
    }
  ): Promise<ManagedConversationExecutionRecord>;
  completeManagedConversationCommand(input: {
    commandId: string;
    leaseToken: string;
    result?: Record<string, unknown>;
  }): Promise<boolean>;
  failManagedConversationCommand(input: {
    commandId: string;
    leaseToken: string;
    state: "queued" | "indeterminate" | "failed";
    errorCode: string;
  }): Promise<{ updated: boolean; reconciled: boolean }>;
  blockManagedConversationCommand(input: {
    commandId: string;
    leaseToken: string;
    sourceGenerationId: string;
    readiness?: "finalized" | "registered";
    errorCode: string;
  }): Promise<boolean>;
  releaseManagedConversationCommandsForSourceGeneration(input: {
    ownerUserId: string;
    sourceGenerationId: string;
    targetDeploymentId: string;
    targetDeviceId: string;
    readiness?: "finalized" | "registered";
  }): Promise<number>;
  isManagedConversationSourceGenerationReady(input: {
    ownerUserId: string;
    sourceGenerationId: string;
    readiness?: "finalized" | "registered";
  }): Promise<boolean>;
  releaseManagedConversationStartForRuntimeBinding(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
  }): Promise<boolean>;
  upsertManagedConversationRuntimeBinding(
    actor: ActorContext,
    input: {
      executionId: string;
      deploymentId: string;
      deviceId: string;
      executionGeneration: number;
      projectPath: string;
    }
  ): Promise<ManagedConversationRuntimeBindingRecord>;
  bindManagedConversationLocalRuntime(
    actor: ActorContext,
    input: {
      executionId: string;
      deploymentId: string;
      deviceId: string;
      executionGeneration: number;
      localSessionId: string;
      providerThreadId: string;
      transcriptPath: string;
      managedHome: string;
      providerCliVersion?: string;
      sourceGenerationId?: string;
    }
  ): Promise<ManagedConversationRuntimeBindingRecord>;
  getManagedConversationRuntimeBinding(
    actor: ActorContext,
    executionId: string
  ): Promise<ManagedConversationRuntimeBindingRecord | null>;
  clearManagedConversationRuntimeBinding(
    actor: ActorContext,
    executionId: string
  ): Promise<boolean>;
}

type ExecutionRow = {
  id: string;
  owner_user_id: string;
  project_id: string;
  provider: "codex";
  state: ManagedConversationExecutionState;
  state_version: number;
  execution_generation: number;
  runner_deployment_id: string;
  runner_device_id: string;
  runner_id: string | null;
  runner_lease_expires_at: Date | string | null;
  logical_session_id: string | null;
  provider_thread_id: string | null;
  provider_cli_version: string | null;
  source_generation_id: string | null;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  quiesced_at: Date | string | null;
  stopped_at: Date | string | null;
};

type RuntimeBindingRow = {
  execution_id: string;
  owner_user_id: string;
  deployment_id: string;
  device_id: string;
  execution_generation: number;
  project_path: string;
  local_session_id: string | null;
  provider_thread_id: string | null;
  transcript_path: string | null;
  managed_home: string | null;
  provider_cli_version: string | null;
  source_generation_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type CommandRow = {
  id: string;
  owner_user_id: string;
  execution_id: string;
  idempotency_key: string;
  sequence: number;
  command_kind:
    | "start"
    | "prompt"
    | "quiesce"
    | "stop"
    | "verify_target"
    | "restore"
    | "fork_prepare"
    | "fork_create";
  target_deployment_id: string | null;
  target_device_id: string | null;
  request_digest: string;
  client_user_message_id: string | null;
  execution_generation: number;
  encrypted_payload: Record<string, unknown> | null;
  state: ManagedConversationCommandState;
  blocked_on_kind:
    | "source_replica"
    | "source_registration"
    | "runtime_binding"
    | null;
  blocked_on_id: string | null;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  result: Record<string, unknown> | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
  dispatching_at: Date | null;
  completed_at: Date | null;
};

const EXECUTION_COLUMNS = `
  id, owner_user_id, project_id, provider, state,
  state_version, execution_generation, runner_deployment_id, runner_device_id,
  runner_id, runner_lease_expires_at, logical_session_id, provider_thread_id,
  provider_cli_version, source_generation_id, last_error_code,
  created_at, updated_at, started_at, quiesced_at, stopped_at
`;

const RUNTIME_BINDING_COLUMNS = `
  execution_id, owner_user_id, deployment_id, device_id, execution_generation,
  project_path, local_session_id, provider_thread_id, transcript_path,
  managed_home, provider_cli_version, source_generation_id, created_at, updated_at
`;

const COMMAND_COLUMNS = `
  id, owner_user_id, execution_id, idempotency_key, sequence, command_kind,
  target_deployment_id, target_device_id, request_digest, client_user_message_id, execution_generation,
  encrypted_payload, state, attempts, lease_token, lease_expires_at, result,
  blocked_on_kind, blocked_on_id, last_error_code, created_at, updated_at,
  dispatching_at, completed_at
`;

const iso = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value;

const requiredIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

const mapExecution = (
  row: ExecutionRow
): ManagedConversationExecutionRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  projectId: row.project_id,
  provider: row.provider,
  state: row.state,
  stateVersion: row.state_version,
  executionGeneration: row.execution_generation,
  runnerDeploymentId: row.runner_deployment_id,
  runnerDeviceId: row.runner_device_id,
  runnerId: row.runner_id,
  runnerLeaseExpiresAt: iso(row.runner_lease_expires_at),
  logicalSessionId: row.logical_session_id,
  providerThreadId: row.provider_thread_id,
  providerCliVersion: row.provider_cli_version,
  sourceGenerationId: row.source_generation_id,
  lastErrorCode: row.last_error_code,
  createdAt: requiredIso(row.created_at),
  updatedAt: requiredIso(row.updated_at),
  startedAt: iso(row.started_at),
  quiescedAt: iso(row.quiesced_at),
  stoppedAt: iso(row.stopped_at)
});

const mapRuntimeBinding = (
  row: RuntimeBindingRow
): ManagedConversationRuntimeBindingRecord => ({
  executionId: row.execution_id,
  ownerUserId: row.owner_user_id,
  deploymentId: row.deployment_id,
  deviceId: row.device_id,
  executionGeneration: row.execution_generation,
  projectPath: row.project_path,
  localSessionId: row.local_session_id,
  providerThreadId: row.provider_thread_id,
  transcriptPath: row.transcript_path,
  managedHome: row.managed_home,
  providerCliVersion: row.provider_cli_version,
  sourceGenerationId: row.source_generation_id,
  createdAt: requiredIso(row.created_at),
  updatedAt: requiredIso(row.updated_at)
});

const mapCommand = (
  row: CommandRow,
  payload: Record<string, unknown> | null = null
): ManagedConversationCommandRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  executionId: row.execution_id,
  idempotencyKey: row.idempotency_key,
  sequence: row.sequence,
  commandKind: row.command_kind,
  targetDeploymentId: row.target_deployment_id,
  targetDeviceId: row.target_device_id,
  requestDigest: row.request_digest,
  clientUserMessageId: row.client_user_message_id,
  executionGeneration: row.execution_generation,
  state: row.state,
  blockedOnKind: row.blocked_on_kind,
  blockedOnId: row.blocked_on_id,
  attempts: row.attempts,
  leaseToken: row.lease_token,
  leaseExpiresAt: iso(row.lease_expires_at),
  payload,
  result: row.result,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  dispatchingAt: iso(row.dispatching_at),
  completedAt: iso(row.completed_at)
});

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const statusError = (
  message: string,
  statusCode: number
): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode });

const validErrorCode = (value: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(value);

const appendManagedConversationEvent = (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    executionId: string;
    mutationId: string;
  }
) =>
  appendCollaborationOutboxEventWithClient(client, {
    family: "managed_conversation_changed",
    scope: "personal",
    personalOwnerUserId: input.ownerUserId,
    teamId: null,
    teamWorkspaceId: null,
    threadId: null,
    messageId: null,
    shareGrantId: null,
    logicalMemoryId: null,
    resourceType: "managed_conversation_execution",
    resourceId: input.executionId,
    actorPrincipalId: input.ownerUserId,
    mutationId: managedConversationEventMutationId(input.mutationId)
  });

const notifyManagedConversationCommand = (
  client: pg.PoolClient,
  executionId: string
) =>
  client.query(
    `select pg_notify(
       'koed_managed_conversation_commands',
       json_build_object('executionId', $1::uuid)::text
     )`,
    [executionId]
  );

export const createManagedConversationRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider }
): ManagedConversationRepository => {
  const provider = (): EnvelopeEncryptionProvider => {
    if (!options.envelopeEncryptionProvider) {
      throw statusError(
        "Managed Conversation prompt encryption is unavailable",
        503
      );
    }
    return options.envelopeEncryptionProvider;
  };

  const encryptPrompt = async (input: {
    ownerUserId: string;
    executionId: string;
    commandId: string;
    prompt: string;
  }) =>
    provider().encrypt({
      plaintext: JSON.stringify({ prompt: input.prompt }),
      scope: {
        tenantId: input.ownerUserId,
        objectClass: "managed_conversation_prompt"
      },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: input.commandId
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: {
        ownerUserId: input.ownerUserId,
        executionId: input.executionId,
        commandId: input.commandId
      }
    });

  const decryptPayload = async (
    row: CommandRow
  ): Promise<Record<string, unknown> | null> => {
    if (!row.encrypted_payload) return null;
    const plaintext = await decryptEnvelopeToUtf8(
      provider(),
      row.encrypted_payload as unknown as EncryptedPayloadEnvelope
    );
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw statusError("Managed Conversation command payload is invalid", 409);
    }
    return parsed as Record<string, unknown>;
  };

  return {
    async createManagedConversation(actor, input) {
      const projectId = input.projectId.trim();
      if (
        !projectId ||
        !input.runnerDeploymentId ||
        !input.runnerDeviceId ||
        !input.idempotencyKey.trim()
      ) {
        throw statusError("Managed Conversation identity is invalid", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const existing = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS}
             from managed_conversation_commands
            where owner_user_id = $1 and idempotency_key = $2
            limit 1`,
          [actor.userId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          const execution = await client.query<ExecutionRow>(
            `select ${EXECUTION_COLUMNS}
               from managed_conversation_executions
              where owner_user_id = $1 and id = $2`,
            [actor.userId, existing.rows[0].execution_id]
          );
          if (!execution.rows[0]) {
            throw statusError(
              "Managed Conversation state is inconsistent",
              409
            );
          }
          const expectedDigest = sha256(
            JSON.stringify({
              kind: "start",
              projectId,
              runnerDeploymentId: input.runnerDeploymentId,
              runnerDeviceId: input.runnerDeviceId,
              initialPrompt: input.initialPrompt ?? null,
              deferUntilRuntimeBinding: input.deferUntilRuntimeBinding === true
            })
          );
          if (existing.rows[0].request_digest !== expectedDigest) {
            throw statusError(
              "Managed Conversation idempotency key was reused",
              409
            );
          }
          await client.query("commit");
          return {
            execution: mapExecution(execution.rows[0]),
            command: mapCommand(
              existing.rows[0],
              await decryptPayload(existing.rows[0])
            ),
            fencingToken: ""
          };
        }
        const executionId = randomUUID();
        const commandId = randomUUID();
        const fencingToken = randomBytes(32).toString("base64url");
        const requestDigest = sha256(
          JSON.stringify({
            kind: "start",
            projectId,
            runnerDeploymentId: input.runnerDeploymentId,
            runnerDeviceId: input.runnerDeviceId,
            initialPrompt: input.initialPrompt ?? null,
            deferUntilRuntimeBinding: input.deferUntilRuntimeBinding === true
          })
        );
        const executionResult = await client.query<ExecutionRow>(
          `insert into managed_conversation_executions (
             id, owner_user_id, project_id, fencing_token_hash,
             runner_deployment_id, runner_device_id
           ) values ($1, $2, $3, $4, $5, $6)
           returning ${EXECUTION_COLUMNS}`,
          [
            executionId,
            actor.userId,
            projectId,
            sha256(fencingToken),
            input.runnerDeploymentId,
            input.runnerDeviceId
          ]
        );
        const encryptedPayload = input.initialPrompt
          ? await encryptPrompt({
              ownerUserId: actor.userId,
              executionId,
              commandId,
              prompt: input.initialPrompt
            })
          : null;
        const commandResult = await client.query<CommandRow>(
          `insert into managed_conversation_commands (
             id, owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, request_digest, execution_generation,
             encrypted_payload,
             state, blocked_on_kind, blocked_on_id
           ) values (
             $1, $2, $3, $4, 0, 'start', $5, 1, $6::jsonb,
             $7, $8, $9
           )
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            executionId,
            input.idempotencyKey,
            requestDigest,
            encryptedPayload,
            input.deferUntilRuntimeBinding === true ? "blocked" : "queued",
            input.deferUntilRuntimeBinding === true ? "runtime_binding" : null,
            input.deferUntilRuntimeBinding === true ? executionId : null
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId,
          mutationId: `managed-conversation:${executionId}:created`
        });
        await notifyManagedConversationCommand(client, executionId);
        await client.query("commit");
        return {
          execution: mapExecution(executionResult.rows[0]!),
          command: mapCommand(
            commandResult.rows[0]!,
            input.initialPrompt ? { prompt: input.initialPrompt } : null
          ),
          fencingToken
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async enqueueManagedConversationPrompt(actor, input) {
      const prompt = input.prompt.trim();
      if (!prompt || !input.idempotencyKey.trim()) {
        throw statusError("Managed Conversation prompt is invalid", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const execution = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS}
             from managed_conversation_executions
            where owner_user_id = $1 and id = $2
            for update`,
          [actor.userId, input.executionId]
        );
        const current = execution.rows[0];
        if (
          !current ||
          current.state !== "running" ||
          current.execution_generation !== input.executionGeneration
        ) {
          throw statusError("Managed Conversation is not writable", 409);
        }
        const requestDigest = sha256(
          JSON.stringify({
            kind: "prompt",
            executionId: input.executionId,
            executionGeneration: input.executionGeneration,
            prompt
          })
        );
        const existing = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS}
             from managed_conversation_commands
            where owner_user_id = $1 and idempotency_key = $2
            limit 1`,
          [actor.userId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_digest !== requestDigest) {
            throw statusError(
              "Managed Conversation idempotency key was reused",
              409
            );
          }
          await client.query("commit");
          return mapCommand(
            existing.rows[0],
            await decryptPayload(existing.rows[0])
          );
        }
        const sequenceResult = await client.query<{ sequence: number }>(
          `select coalesce(max(sequence), -1) + 1 as sequence
             from managed_conversation_commands
            where execution_id = $1`,
          [input.executionId]
        );
        const sequence = sequenceResult.rows[0]!.sequence;
        const commandId = randomUUID();
        const encryptedPayload = await encryptPrompt({
          ownerUserId: actor.userId,
          executionId: input.executionId,
          commandId,
          prompt
        });
        const result = await client.query<CommandRow>(
          `insert into managed_conversation_commands (
             id, owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, request_digest, client_user_message_id,
             execution_generation, encrypted_payload
           ) values ($1, $2, $3, $4, $5, 'prompt', $6, $7, $8, $9::jsonb)
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            input.executionId,
            input.idempotencyKey,
            sequence,
            requestDigest,
            randomUUID(),
            input.executionGeneration,
            encryptedPayload
          ]
        );
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapCommand(result.rows[0]!, { prompt });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async getManagedConversationExecution(actor, executionId) {
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id = $1 and id = $2
          limit 1`,
        [actor.userId, executionId]
      );
      return result.rows[0] ? mapExecution(result.rows[0]) : null;
    },

    async getManagedConversationExecutionBySession(actor, input) {
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
             from managed_conversation_executions
            where owner_user_id = $1
              and logical_session_id = $2
              and provider_thread_id = $3
           limit 1`,
        [actor.userId, input.logicalSessionId, input.providerThreadId]
      );
      return result.rows[0] ? mapExecution(result.rows[0]) : null;
    },

    async listManagedConversationExecutions(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id = $1
            and ($2::text is null or project_id = $2)
          order by updated_at desc, id desc
          limit $3`,
        [actor.userId, input.projectId ?? null, limit]
      );
      return result.rows.map(mapExecution);
    },

    async listManagedConversationExecutionsForRunner(input) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where ($1::uuid is null or owner_user_id = $1)
            and runner_deployment_id = $2
            and runner_device_id = $3
            and state in (
              'starting',
              'running',
              'reconciling',
              'quiesce_requested',
              'quiesced',
              'stopping'
            )
          order by updated_at desc, id desc
          limit $4`,
        [input.ownerUserId ?? null, input.deploymentId, input.deviceId, limit]
      );
      return result.rows.map(mapExecution);
    },

    async getManagedConversationCommand(actor, commandId) {
      const result = await pool.query<CommandRow>(
        `select ${COMMAND_COLUMNS}
           from managed_conversation_commands
          where owner_user_id = $1 and id = $2
          limit 1`,
        [actor.userId, commandId]
      );
      if (!result.rows[0]) return null;
      return mapCommand(result.rows[0], await decryptPayload(result.rows[0]));
    },

    async claimManagedConversationCommands(input) {
      const limit = Math.min(Math.max(input.limit ?? 8, 1), 32);
      const leaseToken = randomUUID();
      const result = await pool.query<
        CommandRow & {
          execution_json: ExecutionRow;
        }
      >(
        `with candidates as (
           select command.id
             from managed_conversation_commands command
             join managed_conversation_executions execution
               on execution.id = command.execution_id
              and execution.owner_user_id = command.owner_user_id
            where (
              command.state = 'queued'
              or (
                command.state = 'dispatching'
                and command.lease_expires_at <= now()
                and command.command_kind not in ('prompt','fork_create')
              )
            )
              and ($7::uuid is null or command.owner_user_id = $7)
              and command.execution_generation = execution.execution_generation
              and $5::uuid is not null
              and $6::uuid is not null
              and (
                (command.target_device_id is null
                  and execution.runner_device_id = $5
                  and execution.runner_deployment_id = $6)
                or (
                  command.target_device_id = $5
                  and command.target_deployment_id = $6
                )
              )
              and execution.state not in ('stopped','failed','fenced')
              and (
                command.command_kind in ('verify_target','fork_create')
                or
                execution.runner_id is null
                or execution.runner_id = $4
                or execution.runner_lease_expires_at <= now()
              )
            order by command.created_at, command.sequence
            for update of command, execution skip locked
            limit $1
         ),
         claimed as (
           update managed_conversation_commands command
              set state = 'dispatching',
                  attempts = command.attempts + 1,
                  lease_token = $2,
                  lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
                  dispatching_at = coalesce(command.dispatching_at, now()),
                  updated_at = now()
             from candidates
            where command.id = candidates.id
         returning command.*
         ),
         leased as (
           update managed_conversation_executions execution
              set runner_id = $4,
                  runner_lease_expires_at =
                    now() + ($3::bigint * interval '1 millisecond'),
                  updated_at = now()
             from (
               select distinct owner_user_id, execution_id
                 from claimed
                where command_kind not in ('verify_target','fork_create')
             ) claim
            where execution.id = claim.execution_id
              and execution.owner_user_id = claim.owner_user_id
              and (
                execution.runner_id is null
                or execution.runner_id = $4
                or execution.runner_lease_expires_at <= now()
              )
           returning execution.*
         )
         select claimed.*,
                coalesce(
                  to_jsonb(leased.*),
                  to_jsonb(execution.*)
                ) as execution_json
           from claimed
           join managed_conversation_executions execution
             on execution.id = claimed.execution_id
            and execution.owner_user_id = claimed.owner_user_id
           left join leased
             on leased.id = claimed.execution_id
            and leased.owner_user_id = claimed.owner_user_id
          where claimed.command_kind in ('verify_target','fork_create')
             or leased.id is not null`,
        [
          limit,
          leaseToken,
          input.leaseMs,
          input.runnerId,
          input.deviceId,
          input.deploymentId,
          input.ownerUserId ?? null
        ]
      );
      const claims: ClaimedManagedConversationCommand[] = [];
      for (const row of result.rows) {
        claims.push({
          ...mapCommand(row, await decryptPayload(row)),
          execution: mapExecution(row.execution_json)
        });
      }
      return claims;
    },

    async reconcileAbandonedManagedConversationCommands(input) {
      const limit = Math.min(Math.max(input.limit ?? 32, 1), 100);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const abandoned = await client.query<CommandRow>(
          `select command.*
             from managed_conversation_commands command
             join managed_conversation_executions execution
               on execution.id = command.execution_id
              and execution.owner_user_id = command.owner_user_id
            where command.state = 'dispatching'
              and command.lease_expires_at <= now()
              and command.command_kind in ('prompt','fork_create')
              and ($1::uuid is null or command.owner_user_id = $1)
              and (
                (command.target_device_id is null
                  and execution.runner_device_id = $2
                  and execution.runner_deployment_id = $3)
                or (
                  command.target_device_id = $2
                  and command.target_deployment_id = $3
                )
              )
            order by command.created_at, command.sequence
            for update of command skip locked
            limit $4`,
          [input.ownerUserId ?? null, input.deviceId, input.deploymentId, limit]
        );
        let reconciled = 0;
        for (const command of abandoned.rows) {
          let completed = false;
          let result: Record<string, unknown> | null = null;
          if (command.command_kind === "prompt") {
            const accepted = await client.query<{ exists: boolean }>(
              `select exists (
                 select 1
                   from conversation_items item
                   join sessions session
                     on session.id = item.session_id
                    and session.owner_user_id = item.owner_user_id
                   join managed_conversation_executions execution
                     on execution.id = $2
                    and execution.owner_user_id = $1
                  where item.owner_user_id = $1
                    and item.visibility = 'personal'
                    and session.logical_session_id =
                      execution.logical_session_id
                    and item.canonical_stable_item_id =
                      'koed-user-message:' || $3::text
                    and item.personal_deleted_at is null
               ) as exists`,
              [
                command.owner_user_id,
                command.execution_id,
                command.client_user_message_id
              ]
            );
            completed = accepted.rows[0]?.exists === true;
            if (completed) {
              result = {
                accepted: true,
                reconciledBy: "canonical_client_user_message_id"
              };
            }
          } else {
            const fork = await client.query<{
              id: string;
              state: string;
              state_version: number;
              child_execution_id: string | null;
            }>(
              `select id, state, state_version, child_execution_id
                 from managed_conversation_forks
                where owner_user_id = $1
                  and parent_execution_id = $2
                  and manifest_digest = $3
                  and target_device_id = $4
                  and target_deployment_id = $5
                order by created_at desc, id desc
                limit 1
                for update`,
              [
                command.owner_user_id,
                command.execution_id,
                command.request_digest,
                input.deviceId,
                input.deploymentId
              ]
            );
            const current = fork.rows[0];
            completed = current?.state === "running";
            if (completed && current) {
              result = {
                forkId: current.id,
                state: current.state,
                childExecutionId: current.child_execution_id,
                reconciledBy: "durable_fork_state"
              };
            } else if (current?.state === "source_attested") {
              const nextVersion = current.state_version + 1;
              await client.query(
                `update managed_conversation_forks
                    set state = 'indeterminate',
                        state_version = $3,
                        failure_code =
                          'ManagedConversationRunnerInterruptedError',
                        updated_at = now()
                  where owner_user_id = $1 and id = $2`,
                [command.owner_user_id, current.id, nextVersion]
              );
              await client.query(
                `insert into managed_conversation_fork_transitions (
                   fork_id, owner_user_id, state_version, state,
                   evidence_digest, actor_kind, actor_id
                 ) values ($1,$2,$3,'indeterminate',$4,'target_runner',$5)`,
                [
                  current.id,
                  command.owner_user_id,
                  nextVersion,
                  createHash("sha256")
                    .update(
                      `${command.id}:ManagedConversationRunnerInterruptedError`
                    )
                    .digest("hex"),
                  input.deviceId
                ]
              );
            }
          }
          await client.query(
            `update managed_conversation_commands
                set state = $3,
                    result = $4::jsonb,
                    lease_token = null,
                    lease_expires_at = null,
                    completed_at = now(),
                    last_error_code = $5,
                    updated_at = now()
              where id = $1
                and owner_user_id = $2
                and state = 'dispatching'
                and lease_expires_at <= now()`,
            [
              command.id,
              command.owner_user_id,
              completed ? "completed" : "indeterminate",
              result,
              completed ? null : "ManagedConversationRunnerInterruptedError"
            ]
          );
          await appendManagedConversationEvent(client, {
            ownerUserId: command.owner_user_id,
            executionId: command.execution_id,
            mutationId: `managed-conversation-command:${command.id}:${
              completed ? "reconciled" : "indeterminate"
            }`
          });
          reconciled += 1;
        }
        await client.query("commit");
        return reconciled;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async renewManagedConversationCommandLease(input) {
      const result = await pool.query(
        `with target_command as (
           select command_kind
             from managed_conversation_commands
            where id = $1
              and lease_token = $2
              and execution_id = $3
              and state = 'dispatching'
              and lease_expires_at > now()
         ),
         renewed_execution as (
           update managed_conversation_executions
              set runner_lease_expires_at =
                    now() + ($5::bigint * interval '1 millisecond'),
                  updated_at = now()
            where id = $3
              and runner_id = $4
              and runner_lease_expires_at > now()
           returning id
         )
         update managed_conversation_commands
            set lease_expires_at =
                  now() + ($5::bigint * interval '1 millisecond'),
                updated_at = now()
          where id = $1
            and lease_token = $2
            and state = 'dispatching'
            and lease_expires_at > now()
            and (
              execution_id in (select id from renewed_execution)
              or exists (
                select 1
                  from target_command
                 where command_kind in ('verify_target','fork_create')
              )
            )`,
        [
          input.commandId,
          input.leaseToken,
          input.executionId,
          input.runnerId,
          input.leaseMs
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async renewManagedConversationExecutionLease(input) {
      const result = await pool.query(
        `update managed_conversation_executions
            set runner_lease_expires_at =
                  now() + ($4::bigint * interval '1 millisecond'),
                updated_at = now()
          where id = $1
            and execution_generation = $2
            and runner_id = $3
            and state in (
              'starting','running','reconciling',
              'quiesce_requested','quiesced','stopping'
            )
            and runner_lease_expires_at > now()`,
        [
          input.executionId,
          input.executionGeneration,
          input.runnerId,
          input.leaseMs
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async acquireManagedConversationExecutionLease(input) {
      const result = await pool.query(
        `update managed_conversation_executions
            set runner_id = $5,
                runner_lease_expires_at =
                  now() + ($6::bigint * interval '1 millisecond'),
                updated_at = now()
          where id = $1
            and execution_generation = $2
            and runner_deployment_id = $3
            and runner_device_id = $4
            and state = 'running'
            and (
              runner_id is null
              or runner_id = $5
              or runner_lease_expires_at <= now()
            )`,
        [
          input.executionId,
          input.executionGeneration,
          input.deploymentId,
          input.deviceId,
          input.runnerId,
          input.leaseMs
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async releaseManagedConversationRunner(input) {
      const result = await pool.query(
        `update managed_conversation_executions execution
            set runner_id = null,
                runner_lease_expires_at = null,
                updated_at = now()
          where execution.id = $1
            and execution.execution_generation = $2
            and execution.runner_id = $3
            and not exists (
              select 1
                from managed_conversation_commands command
               where command.execution_id = execution.id
                 and command.state = 'dispatching'
            )`,
        [input.executionId, input.executionGeneration, input.runnerId]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async bindManagedConversationRuntime(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<ExecutionRow>(
          `update managed_conversation_executions
            set state = 'running',
                state_version = state_version + 1,
                runner_id = $5,
                runner_lease_expires_at = now() + interval '3 minutes',
                logical_session_id = $6,
                provider_thread_id = $7,
                provider_cli_version = $8,
                source_generation_id = coalesce($9, source_generation_id),
                started_at = coalesce(started_at, now()),
                last_error_code = null,
                updated_at = now()
          where owner_user_id = $1
            and id = $2
            and state_version = $3
            and execution_generation = $4
            and state in ('starting','reconciling')
        returning ${EXECUTION_COLUMNS}`,
          [
            actor.userId,
            input.executionId,
            input.expectedStateVersion,
            input.executionGeneration,
            input.runnerId,
            input.logicalSessionId,
            input.providerThreadId,
            input.providerCliVersion ?? null,
            input.sourceGenerationId ?? null
          ]
        );
        if (!result.rows[0]) {
          throw statusError(
            "Managed Conversation runtime binding conflicted",
            409
          );
        }
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation:${input.executionId}:state:${result.rows[0].state_version}`
        });
        await client.query("commit");
        return mapExecution(result.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async bindManagedConversationSourceGeneration(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const current = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS}
             from managed_conversation_executions
            where owner_user_id = $1
              and id = $2
            for update`,
          [actor.userId, input.executionId]
        );
        const execution = current.rows[0];
        if (
          !execution ||
          execution.execution_generation !== input.executionGeneration ||
          execution.runner_id !== input.runnerId ||
          execution.state !== "running" ||
          execution.source_generation_id !==
            (input.expectedSourceGenerationId ?? null)
        ) {
          throw statusError(
            "Managed Conversation source generation binding conflicted",
            409
          );
        }
        if (execution.source_generation_id === input.sourceGenerationId) {
          await client.query("commit");
          return mapExecution(execution);
        }
        const result = await client.query<ExecutionRow>(
          `update managed_conversation_executions
              set source_generation_id = $3,
                  state_version = state_version + 1,
                  updated_at = now()
            where owner_user_id = $1
              and id = $2
          returning ${EXECUTION_COLUMNS}`,
          [actor.userId, input.executionId, input.sourceGenerationId]
        );
        const updated = result.rows[0]!;
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation:${input.executionId}:state:${updated.state_version}`
        });
        await client.query("commit");
        return mapExecution(updated);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async setManagedConversationExecutionState(actor, input) {
      if (input.lastErrorCode && !validErrorCode(input.lastErrorCode)) {
        throw statusError("Managed Conversation error code is invalid", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<ExecutionRow>(
          `update managed_conversation_executions
            set state = $5,
                state_version = state_version + 1,
                last_error_code = $6,
                runner_id = case
                  when $5 in ('stopped','failed','fenced') then null
                  else runner_id
                end,
                runner_lease_expires_at = case
                  when $5 in ('stopped','failed','fenced') then null
                  else runner_lease_expires_at
                end,
                quiesced_at = case when $5 = 'quiesced' then now() else quiesced_at end,
                stopped_at = case when $5 in ('stopped','failed','fenced') then now() else stopped_at end,
                updated_at = now()
          where owner_user_id = $1
            and id = $2
            and state_version = $3
            and execution_generation = $4
        returning ${EXECUTION_COLUMNS}`,
          [
            actor.userId,
            input.executionId,
            input.expectedStateVersion,
            input.executionGeneration,
            input.state,
            input.lastErrorCode ?? null
          ]
        );
        if (!result.rows[0]) {
          throw statusError(
            "Managed Conversation state transition conflicted",
            409
          );
        }
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation:${input.executionId}:state:${result.rows[0].state_version}`
        });
        await client.query("commit");
        return mapExecution(result.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async completeManagedConversationCommand(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<{
          owner_user_id: string;
          execution_id: string;
        }>(
          `update managed_conversation_commands
            set state = 'completed',
                result = $3::jsonb,
                lease_token = null,
                lease_expires_at = null,
                completed_at = now(),
                last_error_code = null,
                updated_at = now()
          where id = $1 and lease_token = $2 and state = 'dispatching'
        returning owner_user_id, execution_id`,
          [input.commandId, input.leaseToken, input.result ?? null]
        );
        const row = result.rows[0];
        if (row) {
          await appendManagedConversationEvent(client, {
            ownerUserId: row.owner_user_id,
            executionId: row.execution_id,
            mutationId: `managed-conversation-command:${input.commandId}:completed`
          });
        }
        await client.query("commit");
        return Boolean(row);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async failManagedConversationCommand(input) {
      if (!validErrorCode(input.errorCode)) {
        throw statusError("Managed Conversation error code is invalid", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<{
          owner_user_id: string;
          execution_id: string;
        }>(
          `update managed_conversation_commands
            set state = $3,
                last_error_code = $4,
                lease_token = null,
                lease_expires_at = null,
                completed_at = case when $3 = 'queued' then null else now() end,
                updated_at = now()
          where id = $1 and lease_token = $2 and state = 'dispatching'
        returning owner_user_id, execution_id`,
          [input.commandId, input.leaseToken, input.state, input.errorCode]
        );
        let row = result.rows[0];
        let reconciled = false;
        if (row && input.state === "indeterminate") {
          const accepted = await client.query<{
            owner_user_id: string;
            execution_id: string;
          }>(
            `
              update managed_conversation_commands command
                 set state = 'completed',
                     result = jsonb_build_object(
                       'accepted', true,
                       'reconciledBy', 'canonical_client_user_message_id'
                     ),
                     last_error_code = null,
                     completed_at = now(),
                     updated_at = now()
                from managed_conversation_executions execution
               where command.id = $1
                 and command.state = 'indeterminate'
                 and execution.id = command.execution_id
                 and execution.owner_user_id = command.owner_user_id
                 and exists (
                   select 1
                     from conversation_items item
                     join sessions session
                       on session.id = item.session_id
                      and session.owner_user_id = item.owner_user_id
                    where item.owner_user_id = command.owner_user_id
                      and item.visibility = 'personal'
                      and session.logical_session_id =
                        execution.logical_session_id
                      and item.canonical_stable_item_id =
                        'koed-user-message:' || command.client_user_message_id::text
                      and item.personal_deleted_at is null
                 )
              returning command.owner_user_id, command.execution_id
            `,
            [input.commandId]
          );
          if (accepted.rows[0]) {
            row = accepted.rows[0];
            reconciled = true;
          }
        }
        if (row) {
          await appendManagedConversationEvent(client, {
            ownerUserId: row.owner_user_id,
            executionId: row.execution_id,
            mutationId: `managed-conversation-command:${input.commandId}:${
              reconciled ? "reconciled" : input.state
            }`
          });
        }
        await client.query("commit");
        return { updated: Boolean(row), reconciled };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async blockManagedConversationCommand(input) {
      if (!validErrorCode(input.errorCode)) {
        throw statusError("Managed Conversation error code is invalid", 400);
      }
      const result = await pool.query(
        `update managed_conversation_commands
            set state = 'blocked',
                blocked_on_kind = $5,
                blocked_on_id = $3,
                last_error_code = $4,
                lease_token = null,
                lease_expires_at = null,
                completed_at = null,
                updated_at = now()
          where id = $1
            and lease_token = $2
            and state = 'dispatching'`,
        [
          input.commandId,
          input.leaseToken,
          input.sourceGenerationId,
          input.errorCode,
          input.readiness === "registered"
            ? "source_registration"
            : "source_replica"
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async releaseManagedConversationCommandsForSourceGeneration(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<{ execution_id: string }>(
          `update managed_conversation_commands command
              set state = 'queued',
                  blocked_on_kind = null,
                  blocked_on_id = null,
                  last_error_code = null,
                  updated_at = now()
             from managed_conversation_executions execution
            where command.owner_user_id = $1
              and execution.id = command.execution_id
              and execution.owner_user_id = command.owner_user_id
              and command.state = 'blocked'
              and command.blocked_on_kind = $5
              and command.blocked_on_id = $2
              and (
                (
                  command.target_deployment_id is null
                  and command.target_device_id is null
                  and execution.runner_deployment_id = $3
                  and execution.runner_device_id = $4
                )
                or (
                  command.target_deployment_id = $3
                  and command.target_device_id = $4
                )
              )
          returning command.execution_id`,
          [
            input.ownerUserId,
            input.sourceGenerationId,
            input.targetDeploymentId,
            input.targetDeviceId,
            input.readiness === "registered"
              ? "source_registration"
              : "source_replica"
          ]
        );
        for (const executionId of new Set(
          result.rows.map((row) => row.execution_id)
        )) {
          await notifyManagedConversationCommand(client, executionId);
        }
        await client.query("commit");
        return result.rowCount ?? 0;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async isManagedConversationSourceGenerationReady(input) {
      const result = await pool.query(
        `select 1
           from conversation_source_artifacts
          where owner_user_id = $1
            and source_generation_id = $2
            and (
              ($3 = 'registered' and lifecycle in ('active', 'finalized'))
              or (
                $3 = 'finalized'
                and lifecycle = 'finalized'
                and closure_hash is not null
              )
            )
          limit 1`,
        [
          input.ownerUserId,
          input.sourceGenerationId,
          input.readiness ?? "finalized"
        ]
      );
      return Boolean(result.rows[0]);
    },

    async releaseManagedConversationStartForRuntimeBinding(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<{ execution_id: string }>(
          `update managed_conversation_commands command
              set state = 'queued',
                  blocked_on_kind = null,
                  blocked_on_id = null,
                  last_error_code = null,
                  updated_at = now()
             from managed_conversation_executions execution
            where command.owner_user_id = $1
              and command.execution_id = $2
              and command.execution_generation = $3
              and command.command_kind = 'start'
              and command.state = 'blocked'
              and command.blocked_on_kind = 'runtime_binding'
              and command.blocked_on_id = command.execution_id
              and execution.id = command.execution_id
              and execution.owner_user_id = command.owner_user_id
              and execution.execution_generation = command.execution_generation
              and execution.runner_deployment_id = $4
              and execution.runner_device_id = $5
          returning command.execution_id`,
          [
            input.ownerUserId,
            input.executionId,
            input.executionGeneration,
            input.deploymentId,
            input.deviceId
          ]
        );
        if (result.rows[0]) {
          await notifyManagedConversationCommand(
            client,
            result.rows[0].execution_id
          );
        }
        const alreadyReady = result.rows[0]
          ? true
          : Boolean(
              (
                await client.query(
                  `select 1
                     from managed_conversation_commands command
                     join managed_conversation_executions execution
                       on execution.id = command.execution_id
                      and execution.owner_user_id = command.owner_user_id
                    where command.owner_user_id = $1
                      and command.execution_id = $2
                      and command.execution_generation = $3
                      and command.command_kind = 'start'
                      and command.state in (
                        'queued',
                        'dispatching',
                        'completed'
                      )
                      and command.blocked_on_kind is null
                      and command.blocked_on_id is null
                      and execution.execution_generation =
                          command.execution_generation
                      and execution.runner_deployment_id = $4
                      and execution.runner_device_id = $5
                    limit 1`,
                  [
                    input.ownerUserId,
                    input.executionId,
                    input.executionGeneration,
                    input.deploymentId,
                    input.deviceId
                  ]
                )
              ).rows[0]
            );
        await client.query("commit");
        return alreadyReady;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async upsertManagedConversationRuntimeBinding(actor, input) {
      const projectPath = input.projectPath.trim();
      if (!projectPath) {
        throw statusError("Managed Conversation project path is invalid", 400);
      }
      const result = await pool.query<RuntimeBindingRow>(
        `insert into managed_conversation_runtime_bindings (
           execution_id, owner_user_id, deployment_id, device_id,
           execution_generation, project_path
         ) values ($1, $2, $3, $4, $5, $6)
         on conflict (execution_id) do update
           set deployment_id = excluded.deployment_id,
               device_id = excluded.device_id,
               execution_generation = excluded.execution_generation,
               project_path = excluded.project_path,
               local_session_id = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                 then managed_conversation_runtime_bindings.local_session_id
                 else null
               end,
               provider_thread_id = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                 then managed_conversation_runtime_bindings.provider_thread_id
                 else null
               end,
               transcript_path = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                 then managed_conversation_runtime_bindings.transcript_path
                 else null
               end,
               managed_home = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                 then managed_conversation_runtime_bindings.managed_home
                 else null
               end,
               provider_cli_version = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                 then managed_conversation_runtime_bindings.provider_cli_version
                 else null
               end,
               source_generation_id = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                 then managed_conversation_runtime_bindings.source_generation_id
                 else null
               end,
               updated_at = now()
         where managed_conversation_runtime_bindings.owner_user_id =
               excluded.owner_user_id
           and managed_conversation_runtime_bindings.device_id =
               excluded.device_id
         returning ${RUNTIME_BINDING_COLUMNS}`,
        [
          input.executionId,
          actor.userId,
          input.deploymentId,
          input.deviceId,
          input.executionGeneration,
          projectPath
        ]
      );
      if (!result.rows[0]) {
        throw statusError(
          "Managed Conversation runtime binding conflicted",
          409
        );
      }
      return mapRuntimeBinding(result.rows[0]);
    },

    async bindManagedConversationLocalRuntime(actor, input) {
      const result = await pool.query<RuntimeBindingRow>(
        `update managed_conversation_runtime_bindings
            set local_session_id = $6,
                provider_thread_id = $7,
                transcript_path = $8,
                managed_home = $9,
                provider_cli_version = $10,
                source_generation_id = coalesce(
                  $11,
                  source_generation_id
                ),
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and deployment_id = $3
            and device_id = $4
            and execution_generation = $5
        returning ${RUNTIME_BINDING_COLUMNS}`,
        [
          input.executionId,
          actor.userId,
          input.deploymentId,
          input.deviceId,
          input.executionGeneration,
          input.localSessionId,
          input.providerThreadId,
          input.transcriptPath,
          input.managedHome,
          input.providerCliVersion ?? null,
          input.sourceGenerationId ?? null
        ]
      );
      if (!result.rows[0]) {
        throw statusError(
          "Managed Conversation local runtime binding conflicted",
          409
        );
      }
      return mapRuntimeBinding(result.rows[0]);
    },

    async getManagedConversationRuntimeBinding(actor, executionId) {
      const result = await pool.query<RuntimeBindingRow>(
        `select ${RUNTIME_BINDING_COLUMNS}
           from managed_conversation_runtime_bindings
          where owner_user_id = $1 and execution_id = $2
          limit 1`,
        [actor.userId, executionId]
      );
      return result.rows[0] ? mapRuntimeBinding(result.rows[0]) : null;
    },

    async clearManagedConversationRuntimeBinding(actor, executionId) {
      const result = await pool.query(
        `delete from managed_conversation_runtime_bindings
          where owner_user_id = $1 and execution_id = $2`,
        [actor.userId, executionId]
      );
      return (result.rowCount ?? 0) === 1;
    }
  };
};
