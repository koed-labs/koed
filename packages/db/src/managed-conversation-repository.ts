import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  decryptEnvelopeToUtf8,
  decideConversationItemPresentation,
  managedConversationFileOperationResultSchema,
  managedConversationFileOperationSchema,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type ConversationPresentationDecision,
  type ManagedConversationFileOperation,
  type ManagedConversationFileOperationResult
} from "@koed/shared";
import pg from "pg";

import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { managedConversationEventMutationId } from "./managed-conversation-event.js";
import {
  loadConversationPresentationPolicySnapshot,
  type ConversationPresentationPolicySnapshot
} from "./conversation-presentation-policy.js";
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

export type ManagedConversationCommandKind =
  | "start"
  | "prompt"
  | "interrupt"
  | "quiesce"
  | "stop"
  | "verify_target"
  | "restore"
  | "checkpoint_restore"
  | "fork_prepare"
  | "fork_create"
  | "file_browse"
  | "file_read"
  | "file_search"
  | "file_mention";

export type ManagedConversationRuntimeItemKind =
  | "command_approval"
  | "file_approval"
  | "permissions_approval"
  | "user_input"
  | "transient_output";

export type ManagedConversationRuntimeItemState =
  | "pending"
  | "answered"
  | "resolved"
  | "canceled";

export interface ManagedConversationRuntimeItemRecord {
  id: string;
  ownerUserId: string;
  executionId: string;
  executionGeneration: number;
  providerRequestId: string;
  providerTurnId: string | null;
  providerItemId: string | null;
  itemKind: ManagedConversationRuntimeItemKind;
  presentation: ConversationPresentationDecision;
  state: ManagedConversationRuntimeItemState;
  requestDigest: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  responseDigest: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
  resolvedAt: string | null;
}

export interface ManagedConversationExecutionRecord {
  id: string;
  ownerUserId: string;
  projectId: string;
  provider: string;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string | null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
  runnerKind: "local_device";
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
  sourceProjectPath: string;
  projectPath: string;
  workspaceId: string | null;
  workspaceKind:
    | "pending"
    | "koed_managed_worktree"
    | "user_managed_checkout"
    | "non_vcs_directory";
  workspaceLifecycle:
    | "pending"
    | "ready"
    | "cleanup_requested"
    | "removed"
    | "cleanup_failed"
    | "orphaned";
  cleanupState: "not_requested" | "requested" | "completed" | "failed";
  vcsDriver: "git" | null;
  localRepositoryCommonDirectory: string | null;
  localGitDirectory: string | null;
  repositoryIdentityHash: string | null;
  worktreeIdentityHash: string | null;
  baseRef: string | null;
  baseObjectId: string | null;
  branchRef: string | null;
  headObjectId: string | null;
  creationOperationId: string | null;
  localSessionId: string | null;
  providerThreadId: string | null;
  transcriptPath: string | null;
  managedHome: string | null;
  providerCliVersion: string | null;
  sourceGenerationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedConversationExecutionCheckpointRecord {
  id: string;
  ownerUserId: string;
  executionId: string;
  executionGeneration: number;
  commandId: string;
  providerTurnId: string | null;
  sourceGenerationId: string | null;
  sequence: number;
  checkpointKind: "baseline" | "terminal" | "recovery";
  checkpointStatus: "pending" | "ready" | "failed" | "unsupported";
  failureCode: string | null;
  repositoryIdentityHash: string | null;
  worktreeIdentityHash: string | null;
  vcsDriver: "git" | null;
  checkpointRef: string | null;
  commitObjectId: string | null;
  capturedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedConversationExecutionDiffRecord {
  id: string;
  ownerUserId: string;
  executionId: string;
  executionGeneration: number;
  scopeKey: string;
  diffScope: "turn" | "full";
  fromCheckpointId: string;
  toCheckpointId: string;
  revisionDigest: string;
  complete: boolean;
  truncated: boolean;
  fileCount: number;
  byteCount: number;
  payloadDigest: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedConversationCommandRecord {
  id: string;
  ownerUserId: string;
  executionId: string;
  idempotencyKey: string;
  sequence: number;
  commandKind: ManagedConversationCommandKind;
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
      provider: string;
      aiClientInstanceId: string;
      model: string;
      reasoningEffort?: string | null;
      permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
      runnerKind: "local_device";
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
      clientUserMessageId: string;
      prompt: string;
      fileMentionCommandIds?: string[];
    }
  ): Promise<ManagedConversationCommandRecord>;
  enqueueManagedConversationFileOperation(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      idempotencyKey: string;
      operation: ManagedConversationFileOperation;
    }
  ): Promise<ManagedConversationCommandRecord>;
  enqueueManagedConversationControl(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      idempotencyKey: string;
      commandKind: "interrupt" | "stop";
    }
  ): Promise<ManagedConversationCommandRecord>;
  enqueueManagedConversationCheckpointRestore(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      checkpointId: string;
      idempotencyKey: string;
    }
  ): Promise<ManagedConversationCommandRecord>;
  claimManagedConversationControlCommands(input: {
    ownerUserId?: string;
    runnerId: string;
    deploymentId: string;
    deviceId: string;
    limit?: number;
    leaseMs: number;
  }): Promise<ClaimedManagedConversationCommand[]>;
  claimManagedConversationFileOperations(input: {
    ownerUserId?: string;
    runnerId: string;
    deploymentId: string;
    deviceId: string;
    limit?: number;
    leaseMs: number;
  }): Promise<ClaimedManagedConversationCommand[]>;
  completeManagedConversationFileOperation(input: {
    commandId: string;
    leaseToken: string;
    result: ManagedConversationFileOperationResult;
  }): Promise<boolean>;
  failManagedConversationFileOperation(input: {
    commandId: string;
    leaseToken: string;
    state: "queued" | "failed";
    errorCode: string;
  }): Promise<boolean>;
  putManagedConversationRuntimeItem(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      providerRequestId: string;
      providerTurnId?: string;
      providerItemId?: string;
      itemKind: ManagedConversationRuntimeItemKind;
      payload: Record<string, unknown>;
    }
  ): Promise<ManagedConversationRuntimeItemRecord>;
  listManagedConversationRuntimeItems(
    actor: ActorContext,
    input: { executionId: string; includeTerminal?: boolean }
  ): Promise<ManagedConversationRuntimeItemRecord[]>;
  getManagedConversationRuntimeItem(
    actor: ActorContext,
    itemId: string
  ): Promise<ManagedConversationRuntimeItemRecord | null>;
  answerManagedConversationRuntimeItem(
    actor: ActorContext,
    input: {
      itemId: string;
      executionGeneration: number;
      response: Record<string, unknown>;
    }
  ): Promise<ManagedConversationRuntimeItemRecord>;
  resolveManagedConversationRuntimeItem(
    actor: ActorContext,
    input: {
      itemId: string;
      executionGeneration: number;
      state: "resolved" | "canceled";
    }
  ): Promise<boolean>;
  cancelManagedConversationRuntimeItems(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      providerTurnId?: string;
    }
  ): Promise<number>;
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
  getLatestManagedConversationCommandForExecution(
    actor: ActorContext,
    executionId: string
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
  markManagedConversationCheckpointPending(input: {
    commandId: string;
    leaseToken: string;
    sourceGenerationId: string;
    providerTurnId?: string;
  }): Promise<boolean>;
  failManagedConversationCommand(input: {
    commandId: string;
    leaseToken: string;
    state: "queued" | "indeterminate" | "failed";
    errorCode: string;
  }): Promise<{ updated: boolean; reconciled: boolean; requeued: boolean }>;
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
  failManagedConversationStartForRuntimeBinding(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
    errorCode: string;
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
  listPendingManagedConversationRuntimeBindings(input: {
    ownerUserId?: string;
    deploymentId: string;
    deviceId: string;
    limit?: number;
  }): Promise<ManagedConversationRuntimeBindingRecord[]>;
  bindManagedConversationExecutionWorkspace(
    actor: ActorContext,
    input: {
      executionId: string;
      deploymentId: string;
      deviceId: string;
      executionGeneration: number;
      sourceProjectPath: string;
      projectPath: string;
      workspaceId: string;
      workspaceKind:
        | "koed_managed_worktree"
        | "user_managed_checkout"
        | "non_vcs_directory";
      vcsDriver: "git" | null;
      localRepositoryCommonDirectory?: string;
      localGitDirectory?: string;
      repositoryIdentityHash?: string;
      worktreeIdentityHash?: string;
      baseRef?: string;
      baseObjectId?: string;
      branchRef?: string;
      headObjectId?: string;
      creationOperationId: string;
    }
  ): Promise<ManagedConversationRuntimeBindingRecord>;
  requestManagedConversationExecutionWorkspaceCleanup(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      deploymentId: string;
      deviceId: string;
    }
  ): Promise<ManagedConversationRuntimeBindingRecord>;
  listManagedConversationExecutionWorkspaceCleanupRequests(input: {
    deploymentId: string;
    deviceId: string;
    limit?: number;
  }): Promise<ManagedConversationRuntimeBindingRecord[]>;
  completeManagedConversationExecutionWorkspaceCleanup(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
    workspaceId: string;
  }): Promise<boolean>;
  failManagedConversationExecutionWorkspaceCleanup(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
    workspaceId: string;
    lifecycle: "cleanup_failed" | "orphaned";
  }): Promise<boolean>;
  bindManagedConversationLocalRuntime(
    actor: ActorContext,
    input: {
      executionId: string;
      deploymentId: string;
      deviceId: string;
      executionGeneration: number;
      localSessionId: string;
      providerThreadId: string;
      transcriptPath: string | null;
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
  listManagedConversationExecutionCheckpoints(
    actor: ActorContext,
    input: { executionId: string; executionGeneration: number }
  ): Promise<ManagedConversationExecutionCheckpointRecord[]>;
  recordManagedConversationExecutionCheckpoint(
    actor: ActorContext,
    input: {
      checkpoint: Omit<
        ManagedConversationExecutionCheckpointRecord,
        "ownerUserId" | "createdAt" | "updatedAt"
      >;
      diffs?: Array<{
        id: string;
        scopeKey: string;
        diffScope: "turn" | "full";
        fromCheckpointId: string;
        toCheckpointId: string;
        revisionDigest: string;
        complete: boolean;
        truncated: boolean;
        fileCount: number;
        byteCount: number;
        payload: Record<string, unknown>;
      }>;
    }
  ): Promise<ManagedConversationExecutionCheckpointRecord>;
  getManagedConversationExecutionDiff(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      scopeKey: string;
    }
  ): Promise<ManagedConversationExecutionDiffRecord | null>;
}

type ExecutionRow = {
  id: string;
  owner_user_id: string;
  project_id: string;
  provider: string;
  ai_client_instance_id: string;
  model: string;
  reasoning_effort: string | null;
  permission_mode: "supervised" | "auto_edit" | "auto" | "full_access";
  runner_kind: "local_device";
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
  source_project_path: string;
  project_path: string;
  workspace_id: string | null;
  workspace_kind: ManagedConversationRuntimeBindingRecord["workspaceKind"];
  workspace_lifecycle: ManagedConversationRuntimeBindingRecord["workspaceLifecycle"];
  cleanup_state: ManagedConversationRuntimeBindingRecord["cleanupState"];
  vcs_driver: "git" | null;
  local_repository_common_directory: string | null;
  local_git_directory: string | null;
  repository_identity_hash: string | null;
  worktree_identity_hash: string | null;
  base_ref: string | null;
  base_object_id: string | null;
  branch_ref: string | null;
  head_object_id: string | null;
  creation_operation_id: string | null;
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
  command_kind: ManagedConversationCommandKind;
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

type RuntimeItemRow = {
  id: string;
  owner_user_id: string;
  execution_id: string;
  execution_generation: number;
  provider_request_id: string;
  provider_turn_id: string | null;
  provider_item_id: string | null;
  item_kind: ManagedConversationRuntimeItemKind;
  state: ManagedConversationRuntimeItemState;
  request_digest: string;
  encrypted_payload: Record<string, unknown>;
  encrypted_response: Record<string, unknown> | null;
  response_digest: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  responded_at: Date | string | null;
  resolved_at: Date | string | null;
};

type CheckpointRow = {
  id: string;
  owner_user_id: string;
  execution_id: string;
  execution_generation: number;
  command_id: string;
  provider_turn_id: string | null;
  source_generation_id: string | null;
  sequence: number;
  checkpoint_kind: "baseline" | "terminal" | "recovery";
  checkpoint_status: "pending" | "ready" | "failed" | "unsupported";
  failure_code: string | null;
  repository_identity_hash: string | null;
  worktree_identity_hash: string | null;
  vcs_driver: "git" | null;
  checkpoint_ref: string | null;
  commit_object_id: string | null;
  captured_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DiffRow = {
  id: string;
  owner_user_id: string;
  execution_id: string;
  execution_generation: number;
  scope_key: string;
  diff_scope: "turn" | "full";
  from_checkpoint_id: string;
  to_checkpoint_id: string;
  revision_digest: string;
  complete: boolean;
  truncated: boolean;
  file_count: number;
  byte_count: number;
  payload_digest: string;
  encrypted_payload: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

const EXECUTION_COLUMNS = `
  id, owner_user_id, project_id, provider, ai_client_instance_id, model,
  reasoning_effort, permission_mode, runner_kind, state,
  state_version, execution_generation, runner_deployment_id, runner_device_id,
  runner_id, runner_lease_expires_at, logical_session_id, provider_thread_id,
  provider_cli_version, source_generation_id, last_error_code,
  created_at, updated_at, started_at, quiesced_at, stopped_at
`;

const RUNTIME_BINDING_COLUMNS = `
  execution_id, owner_user_id, deployment_id, device_id, execution_generation,
  source_project_path, project_path, workspace_id, workspace_kind,
  workspace_lifecycle, cleanup_state, vcs_driver,
  local_repository_common_directory, local_git_directory,
  repository_identity_hash, worktree_identity_hash, base_ref, base_object_id,
  branch_ref, head_object_id, creation_operation_id, local_session_id,
  provider_thread_id, transcript_path, managed_home, provider_cli_version,
  source_generation_id, created_at, updated_at
`;

const COMMAND_COLUMNS = `
  id, owner_user_id, execution_id, idempotency_key, sequence, command_kind,
  target_deployment_id, target_device_id, request_digest, client_user_message_id, execution_generation,
  encrypted_payload, state, attempts, lease_token, lease_expires_at, result,
  blocked_on_kind, blocked_on_id, last_error_code, created_at, updated_at,
  dispatching_at, completed_at
`;

const RUNTIME_ITEM_COLUMNS = `
  id, owner_user_id, execution_id, execution_generation,
  provider_request_id, provider_turn_id, provider_item_id, item_kind, state,
  request_digest, encrypted_payload, encrypted_response, response_digest,
  revision, created_at, updated_at, responded_at, resolved_at
`;

const CHECKPOINT_COLUMNS = `
  id, owner_user_id, execution_id, execution_generation, command_id,
  provider_turn_id, source_generation_id, sequence, checkpoint_kind,
  checkpoint_status, failure_code, repository_identity_hash,
  worktree_identity_hash, vcs_driver, checkpoint_ref, commit_object_id,
  captured_at, created_at, updated_at
`;

const DIFF_COLUMNS = `
  id, owner_user_id, execution_id, execution_generation, scope_key, diff_scope,
  from_checkpoint_id, to_checkpoint_id, revision_digest, complete, truncated,
  file_count, byte_count, payload_digest, encrypted_payload, created_at, updated_at
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
  aiClientInstanceId: row.ai_client_instance_id,
  model: row.model,
  reasoningEffort: row.reasoning_effort,
  permissionMode: row.permission_mode,
  runnerKind: row.runner_kind,
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
  sourceProjectPath: row.source_project_path,
  projectPath: row.project_path,
  workspaceId: row.workspace_id,
  workspaceKind: row.workspace_kind,
  workspaceLifecycle: row.workspace_lifecycle,
  cleanupState: row.cleanup_state,
  vcsDriver: row.vcs_driver,
  localRepositoryCommonDirectory: row.local_repository_common_directory,
  localGitDirectory: row.local_git_directory,
  repositoryIdentityHash: row.repository_identity_hash,
  worktreeIdentityHash: row.worktree_identity_hash,
  baseRef: row.base_ref,
  baseObjectId: row.base_object_id,
  branchRef: row.branch_ref,
  headObjectId: row.head_object_id,
  creationOperationId: row.creation_operation_id,
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

const mapRuntimeItem = (
  row: RuntimeItemRow,
  payload: Record<string, unknown>,
  response: Record<string, unknown> | null,
  presentation: ConversationPresentationDecision
): ManagedConversationRuntimeItemRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  executionId: row.execution_id,
  executionGeneration: row.execution_generation,
  providerRequestId: row.provider_request_id,
  providerTurnId: row.provider_turn_id,
  providerItemId: row.provider_item_id,
  itemKind: row.item_kind,
  presentation,
  state: row.state,
  requestDigest: row.request_digest,
  payload,
  response,
  responseDigest: row.response_digest,
  revision: row.revision,
  createdAt: requiredIso(row.created_at),
  updatedAt: requiredIso(row.updated_at),
  respondedAt: iso(row.responded_at),
  resolvedAt: iso(row.resolved_at)
});

const mapCheckpoint = (
  row: CheckpointRow
): ManagedConversationExecutionCheckpointRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  executionId: row.execution_id,
  executionGeneration: row.execution_generation,
  commandId: row.command_id,
  providerTurnId: row.provider_turn_id,
  sourceGenerationId: row.source_generation_id,
  sequence: row.sequence,
  checkpointKind: row.checkpoint_kind,
  checkpointStatus: row.checkpoint_status,
  failureCode: row.failure_code,
  repositoryIdentityHash: row.repository_identity_hash,
  worktreeIdentityHash: row.worktree_identity_hash,
  vcsDriver: row.vcs_driver,
  checkpointRef: row.checkpoint_ref,
  commitObjectId: row.commit_object_id,
  capturedAt: iso(row.captured_at),
  createdAt: requiredIso(row.created_at),
  updatedAt: requiredIso(row.updated_at)
});

const mapDiff = (
  row: DiffRow,
  payload: Record<string, unknown>
): ManagedConversationExecutionDiffRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  executionId: row.execution_id,
  executionGeneration: row.execution_generation,
  scopeKey: row.scope_key,
  diffScope: row.diff_scope,
  fromCheckpointId: row.from_checkpoint_id,
  toCheckpointId: row.to_checkpoint_id,
  revisionDigest: row.revision_digest,
  complete: row.complete,
  truncated: row.truncated,
  fileCount: row.file_count,
  byteCount: row.byte_count,
  payloadDigest: row.payload_digest,
  payload,
  createdAt: requiredIso(row.created_at),
  updatedAt: requiredIso(row.updated_at)
});

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const startDigest = (input: {
  projectId: string;
  provider: string;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string | null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
  runnerKind: "local_device";
  runnerDeploymentId: string;
  runnerDeviceId: string;
  initialPrompt?: string;
  deferUntilRuntimeBinding?: boolean;
}): string =>
  sha256(
    JSON.stringify({
      kind: "start",
      projectId: input.projectId,
      provider: input.provider,
      aiClientInstanceId: input.aiClientInstanceId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      permissionMode: input.permissionMode,
      runnerKind: input.runnerKind,
      runnerDeploymentId: input.runnerDeploymentId,
      runnerDeviceId: input.runnerDeviceId,
      initialPrompt: input.initialPrompt ?? null,
      deferUntilRuntimeBinding: input.deferUntilRuntimeBinding === true
    })
  );

const statusError = (
  message: string,
  statusCode: number
): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode });

const validErrorCode = (value: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(value);

type ManagedCheckpointInput = Parameters<
  ManagedConversationRepository["recordManagedConversationExecutionCheckpoint"]
>[1]["checkpoint"];

const validManagedCheckpointInput = (
  checkpoint: ManagedCheckpointInput
): boolean => {
  if (
    !Number.isSafeInteger(checkpoint.executionGeneration) ||
    checkpoint.executionGeneration < 1 ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0 ||
    (checkpoint.checkpointKind === "terminal" &&
      checkpoint.sourceGenerationId === null)
  ) {
    return false;
  }
  if (checkpoint.checkpointStatus === "ready") {
    return (
      checkpoint.vcsDriver === "git" &&
      checkpoint.repositoryIdentityHash !== null &&
      checkpoint.worktreeIdentityHash !== null &&
      checkpoint.checkpointRef ===
        `refs/koed/checkpoints/${checkpoint.executionId}/${checkpoint.executionGeneration}/${checkpoint.sequence}/${checkpoint.checkpointKind}` &&
      checkpoint.commitObjectId !== null &&
      /^[0-9a-f]{40,64}$/.test(checkpoint.commitObjectId) &&
      checkpoint.capturedAt !== null &&
      Number.isFinite(Date.parse(checkpoint.capturedAt)) &&
      checkpoint.failureCode === null
    );
  }
  if (checkpoint.checkpointStatus === "unsupported") {
    return (
      checkpoint.vcsDriver === null &&
      checkpoint.repositoryIdentityHash === null &&
      checkpoint.worktreeIdentityHash === null &&
      checkpoint.checkpointRef === null &&
      checkpoint.commitObjectId === null &&
      checkpoint.capturedAt === null &&
      checkpoint.failureCode === null
    );
  }
  return (
    checkpoint.checkpointRef === null &&
    checkpoint.commitObjectId === null &&
    checkpoint.capturedAt === null &&
    (checkpoint.checkpointStatus === "pending"
      ? checkpoint.failureCode === null
      : checkpoint.failureCode !== null &&
        validErrorCode(checkpoint.failureCode))
  );
};

const appendManagedConversationEvent = (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    executionId: string;
    mutationId: string;
    runtimeItemId?: string;
    runtimeItemsReset?: boolean;
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
    resourceType: input.runtimeItemId
      ? "managed_conversation_runtime_item"
      : input.runtimeItemsReset
        ? "managed_conversation_runtime_reset"
        : "managed_conversation_execution",
    resourceId: input.runtimeItemId ?? input.executionId,
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
      throw statusError("Managed Conversation encryption is unavailable", 503);
    }
    return options.envelopeEncryptionProvider;
  };

  const encryptCommandPayload = async (input: {
    ownerUserId: string;
    executionId: string;
    commandId: string;
    objectClass:
      | "managed_conversation_prompt"
      | "managed_conversation_file_operation"
      | "managed_conversation_checkpoint_restore";
    value: Record<string, unknown>;
  }) =>
    provider().encrypt({
      plaintext: JSON.stringify(input.value),
      scope: {
        tenantId: input.ownerUserId,
        objectClass: input.objectClass
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

  const encryptPrompt = (input: {
    ownerUserId: string;
    executionId: string;
    commandId: string;
    prompt: string;
    fileMentions?: Array<Record<string, unknown>>;
  }) =>
    encryptCommandPayload({
      ownerUserId: input.ownerUserId,
      executionId: input.executionId,
      commandId: input.commandId,
      objectClass: "managed_conversation_prompt",
      value: {
        prompt: input.prompt,
        ...(input.fileMentions?.length
          ? { fileMentions: input.fileMentions }
          : {})
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

  const encryptRuntimeValue = async (input: {
    ownerUserId: string;
    executionId: string;
    itemId: string;
    field: "payload" | "response";
    value: Record<string, unknown>;
  }) =>
    provider().encrypt({
      plaintext: JSON.stringify(input.value),
      scope: {
        tenantId: input.ownerUserId,
        objectClass: "managed_conversation_runtime_item"
      },
      provenance: {
        rowFamily: "managed_conversation_runtime_items",
        sourceId: input.itemId
      },
      ciphertextLocation: `managed_conversation_runtime_items.encrypted_${input.field}`,
      aad: {
        ownerUserId: input.ownerUserId,
        executionId: input.executionId,
        itemId: input.itemId,
        field: input.field
      }
    });

  const decryptRuntimeValue = async (
    value: Record<string, unknown> | null,
    label: string
  ): Promise<Record<string, unknown> | null> => {
    if (!value) return null;
    const plaintext = await decryptEnvelopeToUtf8(
      provider(),
      value as unknown as EncryptedPayloadEnvelope
    );
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw statusError(`Managed Conversation ${label} is invalid`, 409);
    }
    return parsed as Record<string, unknown>;
  };

  const hydrateRuntimeItem = async (
    row: RuntimeItemRow,
    policySnapshot?: ConversationPresentationPolicySnapshot
  ): Promise<ManagedConversationRuntimeItemRecord> => {
    const presentationPolicy =
      policySnapshot ??
      (await loadConversationPresentationPolicySnapshot(pool));
    return mapRuntimeItem(
      row,
      (await decryptRuntimeValue(row.encrypted_payload, "runtime payload"))!,
      await decryptRuntimeValue(row.encrypted_response, "runtime response"),
      decideConversationItemPresentation({
        sourceKind: "managed_runtime",
        sourceAdapterVersion: "managed-runtime-v1",
        lookupItemTypes: [row.item_kind],
        policyRevision: presentationPolicy.revision,
        rules: presentationPolicy.rules
      })
    );
  };

  const encryptDiffPayload = async (input: {
    ownerUserId: string;
    executionId: string;
    diffId: string;
    payload: Record<string, unknown>;
  }) =>
    provider().encrypt({
      plaintext: JSON.stringify(input.payload),
      scope: {
        tenantId: input.ownerUserId,
        objectClass: "managed_conversation_execution_diff"
      },
      provenance: {
        rowFamily: "managed_conversation_execution_diffs",
        sourceId: input.diffId
      },
      ciphertextLocation:
        "managed_conversation_execution_diffs.encrypted_payload",
      aad: {
        ownerUserId: input.ownerUserId,
        executionId: input.executionId,
        diffId: input.diffId
      }
    });

  const hydrateDiff = async (
    row: DiffRow
  ): Promise<ManagedConversationExecutionDiffRecord> => {
    const plaintext = await decryptEnvelopeToUtf8(
      provider(),
      row.encrypted_payload as unknown as EncryptedPayloadEnvelope
    );
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw statusError("Managed Conversation execution diff is invalid", 409);
    }
    return mapDiff(row, parsed as Record<string, unknown>);
  };

  return {
    async createManagedConversation(actor, input) {
      const projectId = input.projectId.trim();
      if (
        !projectId ||
        !input.provider.trim() ||
        !input.aiClientInstanceId.trim() ||
        !input.model.trim() ||
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
          const expectedDigest = startDigest({
            projectId,
            provider: input.provider,
            aiClientInstanceId: input.aiClientInstanceId,
            model: input.model,
            reasoningEffort: input.reasoningEffort ?? null,
            permissionMode: input.permissionMode,
            runnerKind: input.runnerKind,
            runnerDeploymentId: input.runnerDeploymentId,
            runnerDeviceId: input.runnerDeviceId,
            initialPrompt: input.initialPrompt,
            deferUntilRuntimeBinding: input.deferUntilRuntimeBinding
          });
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
        const requestDigest = startDigest({
          projectId,
          provider: input.provider,
          aiClientInstanceId: input.aiClientInstanceId,
          model: input.model,
          reasoningEffort: input.reasoningEffort ?? null,
          permissionMode: input.permissionMode,
          runnerKind: input.runnerKind,
          runnerDeploymentId: input.runnerDeploymentId,
          runnerDeviceId: input.runnerDeviceId,
          initialPrompt: input.initialPrompt,
          deferUntilRuntimeBinding: input.deferUntilRuntimeBinding
        });
        const executionResult = await client.query<ExecutionRow>(
          `insert into managed_conversation_executions (
             id, owner_user_id, project_id, provider, ai_client_instance_id,
             model, reasoning_effort, permission_mode, runner_kind,
             fencing_token_hash, runner_deployment_id, runner_device_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           returning ${EXECUTION_COLUMNS}`,
          [
            executionId,
            actor.userId,
            projectId,
            input.provider,
            input.aiClientInstanceId,
            input.model,
            input.reasoningEffort ?? null,
            input.permissionMode,
            input.runnerKind,
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
      const fileMentionCommandIds = input.fileMentionCommandIds ?? [];
      if (
        !prompt ||
        !input.idempotencyKey.trim() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          input.clientUserMessageId
        ) ||
        fileMentionCommandIds.length > 16 ||
        new Set(fileMentionCommandIds).size !== fileMentionCommandIds.length
      ) {
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
          !["starting", "running"].includes(current.state) ||
          current.execution_generation !== input.executionGeneration
        ) {
          throw statusError("Managed Conversation is not writable", 409);
        }
        const fileMentions: Array<Record<string, unknown>> = [];
        if (fileMentionCommandIds.length > 0) {
          const mentionRows = await client.query<CommandRow>(
            `select ${COMMAND_COLUMNS}
               from managed_conversation_commands
              where owner_user_id = $1
                and execution_id = $2
                and id = any($3::uuid[])
              for share`,
            [actor.userId, input.executionId, fileMentionCommandIds]
          );
          const byId = new Map(mentionRows.rows.map((row) => [row.id, row]));
          for (const commandId of fileMentionCommandIds) {
            const row = byId.get(commandId);
            if (
              !row ||
              row.command_kind !== "file_mention" ||
              row.state !== "completed" ||
              row.execution_generation !== input.executionGeneration
            ) {
              throw statusError(
                "Managed Conversation file mention is unavailable",
                409
              );
            }
            const payload = await decryptPayload(row);
            const operation = managedConversationFileOperationSchema.safeParse(
              payload?.operation
            );
            const result =
              managedConversationFileOperationResultSchema.safeParse(
                payload?.result
              );
            if (
              !operation.success ||
              operation.data.kind !== "mention" ||
              !result.success ||
              result.data.kind !== "mention" ||
              Date.parse(result.data.expiresAt) <= Date.now()
            ) {
              throw statusError(
                "Managed Conversation file mention is unavailable",
                409
              );
            }
            fileMentions.push({
              commandId,
              operation: operation.data,
              result: result.data
            });
          }
        }
        const requestDigest = sha256(
          JSON.stringify({
            kind: "prompt",
            executionId: input.executionId,
            executionGeneration: input.executionGeneration,
            clientUserMessageId: input.clientUserMessageId,
            prompt,
            fileMentionCommandIds
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
          prompt,
          fileMentions
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
            input.clientUserMessageId,
            input.executionGeneration,
            encryptedPayload
          ]
        );
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapCommand(result.rows[0]!, {
          prompt,
          ...(fileMentions.length > 0 ? { fileMentions } : {})
        });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async enqueueManagedConversationFileOperation(actor, input) {
      if (!input.idempotencyKey.trim()) {
        throw statusError(
          "Managed Conversation file operation is invalid",
          400
        );
      }
      const operation = managedConversationFileOperationSchema.parse(
        input.operation
      );
      const commandKind = `file_${operation.kind}` as const;
      const requestDigest = sha256(
        JSON.stringify({
          kind: commandKind,
          executionId: input.executionId,
          executionGeneration: input.executionGeneration,
          operation
        })
      );
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
          current.execution_generation !== input.executionGeneration
        ) {
          throw statusError("Managed Conversation files are unavailable", 409);
        }
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
        const commandId = randomUUID();
        const encryptedPayload = await encryptCommandPayload({
          ownerUserId: actor.userId,
          executionId: input.executionId,
          commandId,
          objectClass: "managed_conversation_file_operation",
          value: { operation }
        });
        const result = await client.query<CommandRow>(
          `insert into managed_conversation_commands (
             id, owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, request_digest, execution_generation,
             encrypted_payload
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            input.executionId,
            input.idempotencyKey,
            sequenceResult.rows[0]!.sequence,
            commandKind,
            requestDigest,
            input.executionGeneration,
            encryptedPayload
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation-file:${commandId}:queued`
        });
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapCommand(result.rows[0]!, { operation });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async enqueueManagedConversationControl(actor, input) {
      if (!input.idempotencyKey.trim()) {
        throw statusError("Managed Conversation control is invalid", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const executionResult = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS}
             from managed_conversation_executions
            where owner_user_id = $1 and id = $2
            for update`,
          [actor.userId, input.executionId]
        );
        const execution = executionResult.rows[0];
        if (
          !execution ||
          execution.execution_generation !== input.executionGeneration ||
          !["starting", "running", "reconciling"].includes(execution.state)
        ) {
          throw statusError("Managed Conversation is not controllable", 409);
        }
        const requestDigest = sha256(
          JSON.stringify({
            kind: input.commandKind,
            executionId: input.executionId,
            executionGeneration: input.executionGeneration
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
          return mapCommand(existing.rows[0]);
        }
        const sequenceResult = await client.query<{ sequence: number }>(
          `select coalesce(max(sequence), -1) + 1 as sequence
             from managed_conversation_commands
            where execution_id = $1`,
          [input.executionId]
        );
        const commandId = randomUUID();
        const result = await client.query<CommandRow>(
          `insert into managed_conversation_commands (
             id, owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, request_digest, execution_generation
           ) values ($1,$2,$3,$4,$5,$6,$7,$8)
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            input.executionId,
            input.idempotencyKey,
            sequenceResult.rows[0]!.sequence,
            input.commandKind,
            requestDigest,
            input.executionGeneration
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation-command:${commandId}:queued`
        });
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapCommand(result.rows[0]!);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async enqueueManagedConversationCheckpointRestore(actor, input) {
      if (!input.idempotencyKey.trim()) {
        throw statusError("Managed Conversation Restore is invalid", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const executionResult = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS}
             from managed_conversation_executions
            where owner_user_id = $1 and id = $2
            for update`,
          [actor.userId, input.executionId]
        );
        const execution = executionResult.rows[0];
        if (
          !execution ||
          execution.execution_generation !== input.executionGeneration ||
          execution.state !== "running"
        ) {
          throw statusError("Managed Conversation Restore is unavailable", 409);
        }
        const checkpoint = await client.query<{
          id: string;
          checkpoint_status: string;
          vcs_driver: string | null;
        }>(
          `select id, checkpoint_status, vcs_driver
             from managed_conversation_execution_checkpoints
            where id = $1
              and owner_user_id = $2
              and execution_id = $3
              and execution_generation = $4
            limit 1`,
          [
            input.checkpointId,
            actor.userId,
            input.executionId,
            input.executionGeneration
          ]
        );
        if (
          checkpoint.rows[0]?.checkpoint_status !== "ready" ||
          checkpoint.rows[0]?.vcs_driver !== "git"
        ) {
          throw statusError(
            "Managed Conversation checkpoint is unavailable",
            409
          );
        }
        const requestDigest = sha256(
          JSON.stringify({
            kind: "checkpoint_restore",
            executionId: input.executionId,
            executionGeneration: input.executionGeneration,
            checkpointId: input.checkpointId
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
        const active = await client.query(
          `select 1
             from managed_conversation_commands
            where execution_id = $1
              and state in ('queued','blocked','dispatching')
            limit 1`,
          [input.executionId]
        );
        if (active.rows[0]) {
          throw statusError(
            "Managed Conversation Restore requires an idle Conversation",
            409
          );
        }
        const sequenceResult = await client.query<{ sequence: number }>(
          `select coalesce(max(sequence), -1) + 1 as sequence
             from managed_conversation_commands
            where execution_id = $1`,
          [input.executionId]
        );
        const commandId = randomUUID();
        const encryptedPayload = await encryptCommandPayload({
          ownerUserId: actor.userId,
          executionId: input.executionId,
          commandId,
          objectClass: "managed_conversation_checkpoint_restore",
          value: { checkpointId: input.checkpointId }
        });
        const inserted = await client.query<CommandRow>(
          `insert into managed_conversation_commands (
             id, owner_user_id, execution_id, idempotency_key, sequence,
             command_kind, request_digest, execution_generation,
             encrypted_payload
           ) values ($1,$2,$3,$4,$5,'checkpoint_restore',$6,$7,$8::jsonb)
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            input.executionId,
            input.idempotencyKey,
            sequenceResult.rows[0]!.sequence,
            requestDigest,
            input.executionGeneration,
            encryptedPayload
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation-checkpoint-restore:${commandId}:queued`
        });
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapCommand(inserted.rows[0]!, {
          checkpointId: input.checkpointId
        });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async putManagedConversationRuntimeItem(actor, input) {
      const providerRequestId = input.providerRequestId.trim();
      if (!providerRequestId || providerRequestId.length > 512) {
        throw statusError(
          "Managed Conversation runtime identity is invalid",
          400
        );
      }
      const requestDigest = sha256(JSON.stringify(input.payload));
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
        if (
          !execution.rows[0] ||
          execution.rows[0].execution_generation !==
            input.executionGeneration ||
          ["stopped", "failed", "fenced"].includes(execution.rows[0].state)
        ) {
          throw statusError("Managed Conversation runtime is fenced", 409);
        }
        const existing = await client.query<RuntimeItemRow>(
          `select ${RUNTIME_ITEM_COLUMNS}
             from managed_conversation_runtime_items
            where owner_user_id = $1 and execution_id = $2
              and execution_generation = $3 and provider_request_id = $4
            for update`,
          [
            actor.userId,
            input.executionId,
            input.executionGeneration,
            providerRequestId
          ]
        );
        if (
          existing.rows[0] &&
          existing.rows[0].item_kind !== "transient_output"
        ) {
          if (
            existing.rows[0].request_digest !== requestDigest ||
            existing.rows[0].item_kind !== input.itemKind
          ) {
            throw statusError(
              "Managed Conversation runtime identity was reused",
              409
            );
          }
          await client.query("commit");
          return hydrateRuntimeItem(existing.rows[0]);
        }
        const itemId = existing.rows[0]?.id ?? randomUUID();
        const encryptedPayload = await encryptRuntimeValue({
          ownerUserId: actor.userId,
          executionId: input.executionId,
          itemId,
          field: "payload",
          value: input.payload
        });
        const result = await client.query<RuntimeItemRow>(
          `insert into managed_conversation_runtime_items (
             id, owner_user_id, execution_id, execution_generation,
             provider_request_id, provider_turn_id, provider_item_id,
             item_kind, request_digest, encrypted_payload
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           on conflict (owner_user_id, execution_id, execution_generation, provider_request_id)
           do update set provider_turn_id = excluded.provider_turn_id,
                         provider_item_id = excluded.provider_item_id,
                         request_digest = excluded.request_digest,
                         encrypted_payload = excluded.encrypted_payload,
                         revision = managed_conversation_runtime_items.revision + 1,
                         updated_at = now()
             where managed_conversation_runtime_items.item_kind = 'transient_output'
               and excluded.item_kind = 'transient_output'
               and managed_conversation_runtime_items.state = 'pending'
           returning ${RUNTIME_ITEM_COLUMNS}`,
          [
            itemId,
            actor.userId,
            input.executionId,
            input.executionGeneration,
            providerRequestId,
            input.providerTurnId ?? null,
            input.providerItemId ?? null,
            input.itemKind,
            requestDigest,
            encryptedPayload
          ]
        );
        if (!result.rows[0]) {
          throw statusError(
            "Managed Conversation runtime item conflicted",
            409
          );
        }
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation-runtime:${itemId}:${result.rows[0].revision}`,
          runtimeItemId: itemId
        });
        await client.query("commit");
        return hydrateRuntimeItem(result.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listManagedConversationRuntimeItems(actor, input) {
      const result = await pool.query<RuntimeItemRow>(
        `select ${RUNTIME_ITEM_COLUMNS}
           from managed_conversation_runtime_items
          where owner_user_id = $1 and execution_id = $2
            and ($3::boolean or state in ('pending','answered'))
          order by created_at, id`,
        [actor.userId, input.executionId, input.includeTerminal === true]
      );
      const policySnapshot =
        await loadConversationPresentationPolicySnapshot(pool);
      return Promise.all(
        result.rows.map((row) => hydrateRuntimeItem(row, policySnapshot))
      );
    },

    async getManagedConversationRuntimeItem(actor, itemId) {
      const result = await pool.query<RuntimeItemRow>(
        `select ${RUNTIME_ITEM_COLUMNS}
           from managed_conversation_runtime_items
          where owner_user_id = $1 and id = $2 limit 1`,
        [actor.userId, itemId]
      );
      return result.rows[0] ? hydrateRuntimeItem(result.rows[0]) : null;
    },

    async answerManagedConversationRuntimeItem(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const candidate = await client.query<{
          execution_id: string;
          item_kind: ManagedConversationRuntimeItemKind;
        }>(
          `select execution_id, item_kind
             from managed_conversation_runtime_items
            where owner_user_id = $1 and id = $2`,
          [actor.userId, input.itemId]
        );
        const executionId = candidate.rows[0]?.execution_id;
        const execution = executionId
          ? await client.query<{
              execution_generation: number;
              state: ManagedConversationExecutionState;
            }>(
              `select execution_generation, state
                 from managed_conversation_executions
                where owner_user_id = $1 and id = $2 for update`,
              [actor.userId, executionId]
            )
          : null;
        const current = await client.query<RuntimeItemRow>(
          `select ${RUNTIME_ITEM_COLUMNS}
             from managed_conversation_runtime_items
            where owner_user_id = $1 and id = $2 for update`,
          [actor.userId, input.itemId]
        );
        const row = current.rows[0];
        if (
          !row ||
          !execution?.rows[0] ||
          execution.rows[0].execution_generation !==
            input.executionGeneration ||
          ["stopped", "failed", "fenced"].includes(execution.rows[0].state) ||
          row.execution_generation !== input.executionGeneration ||
          row.item_kind === "transient_output"
        ) {
          throw statusError(
            "Managed Conversation runtime response is invalid",
            409
          );
        }
        const responseDigest = sha256(JSON.stringify(input.response));
        if (row.state === "answered") {
          if (row.response_digest !== responseDigest) {
            throw statusError(
              "Managed Conversation runtime item was already answered",
              409
            );
          }
          await client.query("commit");
          return hydrateRuntimeItem(row);
        }
        if (row.state !== "pending") {
          throw statusError(
            "Managed Conversation runtime item is no longer active",
            409
          );
        }
        const encryptedResponse = await encryptRuntimeValue({
          ownerUserId: actor.userId,
          executionId: row.execution_id,
          itemId: row.id,
          field: "response",
          value: input.response
        });
        const result = await client.query<RuntimeItemRow>(
          `update managed_conversation_runtime_items
              set state = 'answered', encrypted_response = $3::jsonb,
                  response_digest = $4, responded_at = now(),
                  revision = revision + 1, updated_at = now()
            where owner_user_id = $1 and id = $2 and state = 'pending'
          returning ${RUNTIME_ITEM_COLUMNS}`,
          [actor.userId, input.itemId, encryptedResponse, responseDigest]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: row.execution_id,
          mutationId: `managed-conversation-runtime:${row.id}:answered`,
          runtimeItemId: row.id
        });
        await notifyManagedConversationCommand(client, row.execution_id);
        await client.query("commit");
        return hydrateRuntimeItem(result.rows[0]!);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async resolveManagedConversationRuntimeItem(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const candidate = await client.query<{
          execution_id: string;
          item_kind: ManagedConversationRuntimeItemKind;
        }>(
          `select execution_id, item_kind
             from managed_conversation_runtime_items
            where owner_user_id = $1 and id = $2`,
          [actor.userId, input.itemId]
        );
        const executionId = candidate.rows[0]?.execution_id;
        const execution = executionId
          ? await client.query<{ execution_generation: number }>(
              `select execution_generation
                 from managed_conversation_executions
                where owner_user_id = $1 and id = $2 for update`,
              [actor.userId, executionId]
            )
          : null;
        if (
          !execution?.rows[0] ||
          execution.rows[0].execution_generation !== input.executionGeneration
        ) {
          await client.query("commit");
          return false;
        }
        const result =
          candidate.rows[0]?.item_kind === "transient_output"
            ? await client.query<{ execution_id: string }>(
                `delete from managed_conversation_runtime_items
                  where owner_user_id = $1 and id = $2
                    and execution_generation = $3 and state = 'pending'
                returning execution_id`,
                [actor.userId, input.itemId, input.executionGeneration]
              )
            : await client.query<{ execution_id: string }>(
                `update managed_conversation_runtime_items
                    set state = $4, resolved_at = now(), revision = revision + 1,
                        updated_at = now()
                  where owner_user_id = $1 and id = $2
                    and execution_generation = $3
                    and state in ('pending','answered')
                returning execution_id`,
                [
                  actor.userId,
                  input.itemId,
                  input.executionGeneration,
                  input.state
                ]
              );
        if (result.rows[0]) {
          await appendManagedConversationEvent(client, {
            ownerUserId: actor.userId,
            executionId: result.rows[0].execution_id,
            mutationId: `managed-conversation-runtime:${input.itemId}:${input.state}`,
            runtimeItemId: input.itemId
          });
        }
        await client.query("commit");
        return Boolean(result.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async cancelManagedConversationRuntimeItems(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const removed = await client.query(
          `delete from managed_conversation_runtime_items
            where owner_user_id = $1 and execution_id = $2
              and execution_generation = $3 and item_kind = 'transient_output'
              and state = 'pending'
              and ($4::text is null or provider_turn_id = $4)`,
          [
            actor.userId,
            input.executionId,
            input.executionGeneration,
            input.providerTurnId ?? null
          ]
        );
        const updated = await client.query(
          `update managed_conversation_runtime_items
              set state = 'canceled', resolved_at = now(),
                  revision = revision + 1, updated_at = now()
            where owner_user_id = $1 and execution_id = $2
              and execution_generation = $3 and state in ('pending','answered')
              and item_kind <> 'transient_output'
              and ($4::text is null or provider_turn_id = $4)`,
          [
            actor.userId,
            input.executionId,
            input.executionGeneration,
            input.providerTurnId ?? null
          ]
        );
        const affected = (removed.rowCount ?? 0) + (updated.rowCount ?? 0);
        if (affected > 0) {
          await appendManagedConversationEvent(client, {
            ownerUserId: actor.userId,
            executionId: input.executionId,
            mutationId: `managed-conversation-runtime:${input.executionGeneration}:canceled`,
            runtimeItemsReset: true
          });
        }
        await client.query("commit");
        return affected;
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

    async getLatestManagedConversationCommandForExecution(actor, executionId) {
      const result = await pool.query<CommandRow>(
        `select ${COMMAND_COLUMNS}
           from managed_conversation_commands
          where owner_user_id = $1 and execution_id = $2
          order by sequence desc, created_at desc, id desc
          limit 1`,
        [actor.userId, executionId]
      );
      return result.rows[0] ? mapCommand(result.rows[0]) : null;
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
              and command.command_kind not in (
                'interrupt','stop',
                'file_browse','file_read','file_search','file_mention'
              )
              and ($7::uuid is null or command.owner_user_id = $7)
              and command.execution_generation = execution.execution_generation
              and not exists (
                select 1
                  from managed_conversation_commands predecessor
                 where predecessor.execution_id = command.execution_id
                   and predecessor.execution_generation = command.execution_generation
                   and predecessor.sequence < command.sequence
                   and predecessor.state not in (
                     'completed', 'failed', 'canceled'
                   )
              )
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

    async claimManagedConversationControlCommands(input) {
      const limit = Math.min(Math.max(input.limit ?? 8, 1), 32);
      const leaseToken = randomUUID();
      const result = await pool.query<
        CommandRow & { execution_json: ExecutionRow }
      >(
        `with candidates as (
           select command.id
             from managed_conversation_commands command
             join managed_conversation_executions execution
               on execution.id = command.execution_id
              and execution.owner_user_id = command.owner_user_id
            where command.state = 'queued'
              and command.command_kind in ('interrupt','stop')
              and command.execution_generation = execution.execution_generation
              and ($7::uuid is null or command.owner_user_id = $7)
              and execution.runner_device_id = $5
              and execution.runner_deployment_id = $6
              and execution.runner_id = $4
              and execution.runner_lease_expires_at > now()
              and execution.state not in ('stopped','failed','fenced')
            order by command.created_at, command.sequence
            for update of command skip locked
            limit $1
         ), claimed as (
           update managed_conversation_commands command
              set state = 'dispatching', attempts = command.attempts + 1,
                  lease_token = $2,
                  lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
                  dispatching_at = coalesce(command.dispatching_at, now()),
                  updated_at = now()
             from candidates
            where command.id = candidates.id
           returning command.*
         )
         select claimed.*, to_jsonb(execution.*) as execution_json
           from claimed
           join managed_conversation_executions execution
             on execution.id = claimed.execution_id
            and execution.owner_user_id = claimed.owner_user_id`,
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
      return result.rows.map((row) => ({
        ...mapCommand(row),
        execution: mapExecution(row.execution_json)
      }));
    },

    async claimManagedConversationFileOperations(input) {
      const limit = Math.min(Math.max(input.limit ?? 8, 1), 32);
      const leaseToken = randomUUID();
      const result = await pool.query<
        CommandRow & { execution_json: ExecutionRow }
      >(
        `with candidates as (
           select command.id
             from managed_conversation_commands command
             join managed_conversation_executions execution
               on execution.id = command.execution_id
              and execution.owner_user_id = command.owner_user_id
            where command.command_kind in (
                    'file_browse','file_read','file_search','file_mention'
                  )
              and (
                command.state = 'queued'
                or (command.state = 'dispatching'
                  and command.lease_expires_at <= now())
              )
              and command.execution_generation = execution.execution_generation
              and ($6::uuid is null or command.owner_user_id = $6)
              and execution.runner_device_id = $4
              and execution.runner_deployment_id = $5
            order by command.created_at, command.sequence
            for update of command skip locked
            limit $1
         ), claimed as (
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
         )
         select claimed.*, to_jsonb(execution.*) as execution_json
           from claimed
           join managed_conversation_executions execution
             on execution.id = claimed.execution_id
            and execution.owner_user_id = claimed.owner_user_id`,
        [
          limit,
          leaseToken,
          input.leaseMs,
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

    async completeManagedConversationFileOperation(input) {
      const parsedResult = managedConversationFileOperationResultSchema.parse(
        input.result
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const selected = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS}
             from managed_conversation_commands
            where id = $1
              and lease_token = $2
              and state = 'dispatching'
              and lease_expires_at > now()
              and command_kind in (
                'file_browse','file_read','file_search','file_mention'
              )
            for update`,
          [input.commandId, input.leaseToken]
        );
        const row = selected.rows[0];
        if (!row) {
          await client.query("commit");
          return false;
        }
        const payload = await decryptPayload(row);
        const operation = managedConversationFileOperationSchema.parse(
          payload?.operation
        );
        if (
          row.command_kind !== `file_${operation.kind}` ||
          operation.kind !== parsedResult.kind ||
          operation.path !== parsedResult.path ||
          (operation.revision !== null &&
            (operation.revision.checkpointId !==
              parsedResult.revision.checkpointId ||
              operation.revision.revisionDigest !==
                parsedResult.revision.revisionDigest)) ||
          (operation.kind === "read" &&
            parsedResult.kind === "read" &&
            operation.offset !== parsedResult.offset) ||
          (operation.kind === "search" &&
            parsedResult.kind === "search" &&
            operation.query !== parsedResult.query) ||
          (operation.kind === "mention" &&
            parsedResult.kind === "mention" &&
            ((operation.startLine !== undefined &&
              operation.startLine !== parsedResult.startLine) ||
              (operation.endLine !== undefined &&
                operation.endLine !== parsedResult.endLine)))
        ) {
          throw statusError(
            "Managed Conversation file operation result conflicted",
            409
          );
        }
        const encryptedPayload = await encryptCommandPayload({
          ownerUserId: row.owner_user_id,
          executionId: row.execution_id,
          commandId: row.id,
          objectClass: "managed_conversation_file_operation",
          value: { operation, result: parsedResult }
        });
        const completed = await client.query<{
          owner_user_id: string;
          execution_id: string;
        }>(
          `update managed_conversation_commands
              set encrypted_payload = $3::jsonb,
                  state = 'completed',
                  result = $4::jsonb,
                  lease_token = null,
                  lease_expires_at = null,
                  completed_at = now(),
                  last_error_code = null,
                  updated_at = now()
            where id = $1
              and lease_token = $2
              and state = 'dispatching'
          returning owner_user_id, execution_id`,
          [
            input.commandId,
            input.leaseToken,
            encryptedPayload,
            {
              phase: "file_result",
              kind: parsedResult.kind,
              revisionDigest: parsedResult.revision.revisionDigest
            }
          ]
        );
        const completedRow = completed.rows[0];
        if (completedRow) {
          await appendManagedConversationEvent(client, {
            ownerUserId: completedRow.owner_user_id,
            executionId: completedRow.execution_id,
            mutationId: `managed-conversation-file:${input.commandId}:completed`
          });
        }
        await client.query("commit");
        return Boolean(completedRow);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async failManagedConversationFileOperation(input) {
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
                  lease_token = null,
                  lease_expires_at = null,
                  completed_at = case when $3 = 'failed' then now() else null end,
                  last_error_code = $4,
                  updated_at = now()
            where id = $1
              and lease_token = $2
              and state = 'dispatching'
              and command_kind in (
                'file_browse','file_read','file_search','file_mention'
              )
          returning owner_user_id, execution_id`,
          [input.commandId, input.leaseToken, input.state, input.errorCode]
        );
        const row = result.rows[0];
        if (row) {
          await appendManagedConversationEvent(client, {
            ownerUserId: row.owner_user_id,
            executionId: row.execution_id,
            mutationId: `managed-conversation-file:${input.commandId}:${input.state}`
          });
          if (input.state === "queued") {
            await notifyManagedConversationCommand(client, row.execution_id);
          }
        }
        await client.query("commit");
        return Boolean(row);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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
          let checkpointPending = false;
          let result: Record<string, unknown> | null = null;
          if (command.command_kind === "prompt") {
            const accepted = await client.query<{
              accepted: boolean;
              checkpointed: boolean;
              source_generation_id: string | null;
            }>(
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
               ) as accepted,
               exists (
                 select 1
                   from managed_conversation_execution_checkpoints checkpoint
                  where checkpoint.command_id = $4
                    and checkpoint.owner_user_id = $1
                    and checkpoint.execution_id = $2
                    and checkpoint.checkpoint_kind = 'terminal'
               ) as checkpointed,
               coalesce(binding.source_generation_id, execution.source_generation_id)
                 as source_generation_id
                 from managed_conversation_executions execution
                 left join managed_conversation_runtime_bindings binding
                   on binding.owner_user_id = execution.owner_user_id
                  and binding.execution_id = execution.id
                  and binding.execution_generation = execution.execution_generation
                where execution.owner_user_id = $1 and execution.id = $2`,
              [
                command.owner_user_id,
                command.execution_id,
                command.client_user_message_id,
                command.id
              ]
            );
            completed =
              accepted.rows[0]?.accepted === true &&
              accepted.rows[0]?.checkpointed === true;
            if (completed) {
              result = {
                accepted: true,
                reconciledBy: "canonical_client_user_message_id"
              };
            } else if (
              accepted.rows[0]?.accepted === true &&
              accepted.rows[0]?.source_generation_id
            ) {
              checkpointPending = true;
              result = {
                phase: "checkpoint_pending",
                providerTurnId: null,
                sourceGenerationId: accepted.rows[0].source_generation_id
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
                    completed_at = case when $3 = 'queued' then null else now() end,
                    last_error_code = $5,
                    updated_at = now()
              where id = $1
                and owner_user_id = $2
                and state = 'dispatching'
                and lease_expires_at <= now()`,
            [
              command.id,
              command.owner_user_id,
              completed
                ? "completed"
                : checkpointPending
                  ? "queued"
                  : "indeterminate",
              result,
              completed
                ? null
                : checkpointPending
                  ? "ExecutionCheckpointRecoveryPendingError"
                  : "ManagedConversationRunnerInterruptedError"
            ]
          );
          await appendManagedConversationEvent(client, {
            ownerUserId: command.owner_user_id,
            executionId: command.execution_id,
            mutationId: `managed-conversation-command:${command.id}:${
              completed
                ? "reconciled"
                : checkpointPending
                  ? "checkpoint_pending"
                  : "indeterminate"
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
                 where command_kind in (
                   'verify_target','fork_create',
                   'file_browse','file_read','file_search','file_mention'
                 )
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

    async markManagedConversationCheckpointPending(input) {
      const providerTurnId = input.providerTurnId?.trim() || null;
      const result = await pool.query(
        `update managed_conversation_commands command
            set result = jsonb_build_object(
                  'phase', 'checkpoint_pending',
                  'providerTurnId', $3::text,
                  'sourceGenerationId', $4::uuid
                ),
                updated_at = now()
           from managed_conversation_executions execution
          where command.id = $1
            and command.lease_token = $2
            and command.state = 'dispatching'
            and command.command_kind = 'prompt'
            and execution.id = command.execution_id
            and execution.owner_user_id = command.owner_user_id
            and execution.execution_generation = command.execution_generation
            and execution.source_generation_id = $4::uuid`,
        [
          input.commandId,
          input.leaseToken,
          providerTurnId,
          input.sourceGenerationId
        ]
      );
      return (result.rowCount ?? 0) === 1;
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
          state: ManagedConversationCommandState;
        }>(
          `update managed_conversation_commands
            set state = case
                  when $3 = 'indeterminate'
                    and result->>'phase' = 'checkpoint_pending'
                    then 'queued'
                  else $3
                end,
                last_error_code = case
                  when $3 = 'indeterminate'
                    and result->>'phase' = 'checkpoint_pending'
                    then 'ExecutionCheckpointRecoveryPendingError'
                  else $4
                end,
                lease_token = null,
                lease_expires_at = null,
                completed_at = case
                  when $3 = 'queued'
                    or ($3 = 'indeterminate'
                      and result->>'phase' = 'checkpoint_pending')
                    then null
                  else now()
                end,
                updated_at = now()
          where id = $1 and lease_token = $2 and state = 'dispatching'
        returning owner_user_id, execution_id, state`,
          [input.commandId, input.leaseToken, input.state, input.errorCode]
        );
        let row = result.rows[0];
        let reconciled = false;
        let requeued =
          row?.state === "queued" && input.state === "indeterminate";
        if (row && input.state === "indeterminate" && !requeued) {
          const accepted = await client.query<{
            owner_user_id: string;
            execution_id: string;
            state: "completed" | "queued";
          }>(
            `
              update managed_conversation_commands command
                 set state = case
                       when exists (
                         select 1
                           from managed_conversation_execution_checkpoints checkpoint
                          where checkpoint.command_id = command.id
                            and checkpoint.owner_user_id = command.owner_user_id
                            and checkpoint.execution_id = command.execution_id
                            and checkpoint.checkpoint_kind = 'terminal'
                       ) then 'completed'
                       else 'queued'
                     end,
                     result = case
                       when exists (
                         select 1
                           from managed_conversation_execution_checkpoints checkpoint
                          where checkpoint.command_id = command.id
                            and checkpoint.owner_user_id = command.owner_user_id
                            and checkpoint.execution_id = command.execution_id
                            and checkpoint.checkpoint_kind = 'terminal'
                       ) then jsonb_build_object(
                         'accepted', true,
                         'reconciledBy', 'canonical_client_user_message_id'
                       )
                       else jsonb_build_object(
                         'phase', 'checkpoint_pending',
                         'providerTurnId', command.result->'providerTurnId',
                         'sourceGenerationId',
                           coalesce(
                             command.result->'sourceGenerationId',
                             to_jsonb(binding.source_generation_id),
                             to_jsonb(execution.source_generation_id)
                           )
                       )
                     end,
                     last_error_code = case
                       when exists (
                         select 1
                           from managed_conversation_execution_checkpoints checkpoint
                          where checkpoint.command_id = command.id
                            and checkpoint.owner_user_id = command.owner_user_id
                            and checkpoint.execution_id = command.execution_id
                            and checkpoint.checkpoint_kind = 'terminal'
                       ) then null
                       else 'ExecutionCheckpointRecoveryPendingError'
                     end,
                     completed_at = case
                       when exists (
                         select 1
                           from managed_conversation_execution_checkpoints checkpoint
                          where checkpoint.command_id = command.id
                            and checkpoint.owner_user_id = command.owner_user_id
                            and checkpoint.execution_id = command.execution_id
                            and checkpoint.checkpoint_kind = 'terminal'
                       ) then now()
                       else null
                     end,
                     updated_at = now()
                from managed_conversation_executions execution
                left join managed_conversation_runtime_bindings binding
                  on binding.owner_user_id = execution.owner_user_id
                 and binding.execution_id = execution.id
                 and binding.execution_generation = execution.execution_generation
               where command.id = $1
                 and command.state = 'indeterminate'
                 and execution.id = command.execution_id
                 and execution.owner_user_id = command.owner_user_id
                 and coalesce(
                       command.result->>'sourceGenerationId',
                       binding.source_generation_id::text,
                       execution.source_generation_id::text
                     ) is not null
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
              returning command.owner_user_id, command.execution_id, command.state
            `,
            [input.commandId]
          );
          if (accepted.rows[0]) {
            row = accepted.rows[0];
            reconciled = accepted.rows[0].state === "completed";
            requeued = accepted.rows[0].state === "queued";
          }
        }
        if (row) {
          await appendManagedConversationEvent(client, {
            ownerUserId: row.owner_user_id,
            executionId: row.execution_id,
            mutationId: `managed-conversation-command:${input.commandId}:${
              reconciled
                ? "reconciled"
                : requeued
                  ? "checkpoint_pending"
                  : input.state
            }`
          });
        }
        await client.query("commit");
        return { updated: Boolean(row), reconciled, requeued };
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

    async failManagedConversationStartForRuntimeBinding(input) {
      if (!validErrorCode(input.errorCode)) {
        throw statusError("Managed Conversation error code is invalid", 400);
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const command = await client.query<{ execution_id: string }>(
          `update managed_conversation_commands command
              set state = 'failed',
                  blocked_on_kind = null,
                  blocked_on_id = null,
                  last_error_code = $6,
                  completed_at = now(),
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
              and execution.state = 'starting'
              and execution.runner_deployment_id = $4
              and execution.runner_device_id = $5
          returning command.execution_id`,
          [
            input.ownerUserId,
            input.executionId,
            input.executionGeneration,
            input.deploymentId,
            input.deviceId,
            input.errorCode
          ]
        );
        if (!command.rows[0]) {
          const alreadyFailed = Boolean(
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
                    and command.state = 'failed'
                    and command.last_error_code = $6
                    and execution.state = 'failed'
                    and execution.last_error_code = $6
                    and execution.execution_generation = $3
                    and execution.runner_deployment_id = $4
                    and execution.runner_device_id = $5
                  limit 1`,
                [
                  input.ownerUserId,
                  input.executionId,
                  input.executionGeneration,
                  input.deploymentId,
                  input.deviceId,
                  input.errorCode
                ]
              )
            ).rows[0]
          );
          await client.query("commit");
          return alreadyFailed;
        }
        const execution = await client.query(
          `update managed_conversation_executions
              set state = 'failed',
                  state_version = state_version + 1,
                  runner_id = null,
                  runner_lease_expires_at = null,
                  last_error_code = $6,
                  stopped_at = now(),
                  updated_at = now()
            where owner_user_id = $1
              and id = $2
              and execution_generation = $3
              and state = 'starting'
              and runner_deployment_id = $4
              and runner_device_id = $5`,
          [
            input.ownerUserId,
            input.executionId,
            input.executionGeneration,
            input.deploymentId,
            input.deviceId,
            input.errorCode
          ]
        );
        if ((execution.rowCount ?? 0) !== 1) {
          throw statusError(
            "Managed Conversation runtime binding failure conflicted",
            409
          );
        }
        await appendManagedConversationEvent(client, {
          ownerUserId: input.ownerUserId,
          executionId: input.executionId,
          mutationId: `managed-conversation:${input.executionId}:workspace-failed:${input.executionGeneration}`
        });
        await client.query("commit");
        return true;
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
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<RuntimeBindingRow>(
          `insert into managed_conversation_runtime_bindings (
           execution_id, owner_user_id, deployment_id, device_id,
           execution_generation, source_project_path, project_path
         ) values ($1, $2, $3, $4, $5, $6, $6)
         on conflict (execution_id) do update
           set deployment_id = excluded.deployment_id,
               device_id = excluded.device_id,
               execution_generation = excluded.execution_generation,
               source_project_path = excluded.source_project_path,
               project_path = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.project_path else excluded.project_path end,
               workspace_id = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.workspace_id else null end,
               workspace_kind = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.workspace_kind else 'pending' end,
               workspace_lifecycle = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.workspace_lifecycle else 'pending' end,
               cleanup_state = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.cleanup_state else 'not_requested' end,
               vcs_driver = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.vcs_driver else null end,
               local_repository_common_directory = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.local_repository_common_directory else null end,
               local_git_directory = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.local_git_directory else null end,
               repository_identity_hash = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.repository_identity_hash else null end,
               worktree_identity_hash = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.worktree_identity_hash else null end,
               base_ref = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.base_ref else null end,
               base_object_id = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.base_object_id else null end,
               branch_ref = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.branch_ref else null end,
               head_object_id = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.head_object_id else null end,
               creation_operation_id = case when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                 and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path then managed_conversation_runtime_bindings.creation_operation_id else null end,
               local_session_id = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.local_session_id
                 else null
               end,
               provider_thread_id = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.provider_thread_id
                 else null
               end,
               transcript_path = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.transcript_path
                 else null
               end,
               managed_home = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.managed_home
                 else null
               end,
               provider_cli_version = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.provider_cli_version
                 else null
               end,
               source_generation_id = case
                 when managed_conversation_runtime_bindings.execution_generation =
                      excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.source_generation_id
                 else null
               end,
               updated_at = now()
         where managed_conversation_runtime_bindings.owner_user_id =
               excluded.owner_user_id
           and managed_conversation_runtime_bindings.device_id =
               excluded.device_id
           and (managed_conversation_runtime_bindings.workspace_lifecycle = 'pending'
             or (managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
               and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path))
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
        if (result.rows[0].workspace_lifecycle === "pending") {
          await notifyManagedConversationCommand(client, input.executionId);
        }
        await client.query("commit");
        return mapRuntimeBinding(result.rows[0]);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listPendingManagedConversationRuntimeBindings(input) {
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const result = await pool.query<RuntimeBindingRow>(
        `select binding.*
           from managed_conversation_runtime_bindings binding
           join managed_conversation_executions execution
             on execution.id = binding.execution_id
            and execution.owner_user_id = binding.owner_user_id
            and execution.execution_generation = binding.execution_generation
          where binding.deployment_id = $1
            and binding.device_id = $2
            and binding.workspace_lifecycle = 'pending'
            and execution.state = 'starting'
            and ($3::uuid is null or binding.owner_user_id = $3)
          order by binding.created_at, binding.execution_id
          limit $4`,
        [input.deploymentId, input.deviceId, input.ownerUserId ?? null, limit]
      );
      return result.rows.map(mapRuntimeBinding);
    },

    async bindManagedConversationExecutionWorkspace(actor, input) {
      let result: pg.QueryResult<RuntimeBindingRow>;
      try {
        result = await pool.query<RuntimeBindingRow>(
          `update managed_conversation_runtime_bindings
            set source_project_path = $6,
                project_path = $7,
                workspace_id = $8,
                workspace_kind = $9,
                workspace_lifecycle = 'ready',
                cleanup_state = 'not_requested',
                vcs_driver = $10,
                local_repository_common_directory = $11,
                local_git_directory = $12,
                repository_identity_hash = $13,
                worktree_identity_hash = $14,
                base_ref = $15,
                base_object_id = $16,
                branch_ref = $17,
                head_object_id = $18,
                creation_operation_id = $19,
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and deployment_id = $3
            and device_id = $4
            and execution_generation = $5
            and (
              workspace_lifecycle = 'pending'
              or (
                workspace_lifecycle = 'ready'
                and source_project_path = $6
                and project_path = $7
                and workspace_id = $8
                and workspace_kind = $9
                and vcs_driver is not distinct from $10
                and local_repository_common_directory is not distinct from $11
                and local_git_directory is not distinct from $12
                and repository_identity_hash is not distinct from $13
                and worktree_identity_hash is not distinct from $14
                and base_ref is not distinct from $15
                and base_object_id is not distinct from $16
                and branch_ref is not distinct from $17
                and head_object_id is not distinct from $18
                and creation_operation_id = $19
              )
            )
        returning ${RUNTIME_BINDING_COLUMNS}`,
          [
            input.executionId,
            actor.userId,
            input.deploymentId,
            input.deviceId,
            input.executionGeneration,
            input.sourceProjectPath,
            input.projectPath,
            input.workspaceId,
            input.workspaceKind,
            input.vcsDriver,
            input.localRepositoryCommonDirectory ?? null,
            input.localGitDirectory ?? null,
            input.repositoryIdentityHash ?? null,
            input.worktreeIdentityHash ?? null,
            input.baseRef ?? null,
            input.baseObjectId ?? null,
            input.branchRef ?? null,
            input.headObjectId ?? null,
            input.creationOperationId
          ]
        );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505" &&
          "constraint" in error &&
          error.constraint ===
            "managed_conversation_runtime_binding_active_path_unique"
        ) {
          throw Object.assign(
            new Error("ExecutionWorkspaceActivePathConflictError"),
            {
              name: "ExecutionWorkspaceActivePathConflictError",
              statusCode: 409
            }
          );
        }
        throw error;
      }
      if (!result.rows[0]) {
        throw statusError(
          "Managed Conversation execution workspace conflicted",
          409
        );
      }
      return mapRuntimeBinding(result.rows[0]);
    },

    async requestManagedConversationExecutionWorkspaceCleanup(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<RuntimeBindingRow>(
          `update managed_conversation_runtime_bindings
            set workspace_lifecycle = 'cleanup_requested',
                cleanup_state = 'requested',
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and execution_generation = $3
            and deployment_id = $4
            and device_id = $5
            and workspace_kind = 'koed_managed_worktree'
            and workspace_lifecycle in ('ready', 'cleanup_requested')
            and cleanup_state in ('not_requested', 'requested')
        returning ${RUNTIME_BINDING_COLUMNS}`,
          [
            input.executionId,
            actor.userId,
            input.executionGeneration,
            input.deploymentId,
            input.deviceId
          ]
        );
        if (!result.rows[0]) {
          throw statusError(
            "Managed Conversation execution workspace cannot be cleaned up",
            409
          );
        }
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapRuntimeBinding(result.rows[0]);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listManagedConversationExecutionWorkspaceCleanupRequests(input) {
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const result = await pool.query<RuntimeBindingRow>(
        `select ${RUNTIME_BINDING_COLUMNS}
           from managed_conversation_runtime_bindings
          where deployment_id = $1
            and device_id = $2
            and workspace_kind = 'koed_managed_worktree'
            and workspace_lifecycle = 'cleanup_requested'
            and cleanup_state = 'requested'
          order by updated_at, execution_id
          limit $3`,
        [input.deploymentId, input.deviceId, limit]
      );
      return result.rows.map(mapRuntimeBinding);
    },

    async completeManagedConversationExecutionWorkspaceCleanup(input) {
      const result = await pool.query(
        `update managed_conversation_runtime_bindings
            set workspace_lifecycle = 'removed',
                cleanup_state = 'completed',
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and execution_generation = $3
            and deployment_id = $4
            and device_id = $5
            and workspace_id = $6
            and workspace_kind = 'koed_managed_worktree'
            and workspace_lifecycle = 'cleanup_requested'
            and cleanup_state = 'requested'`,
        [
          input.executionId,
          input.ownerUserId,
          input.executionGeneration,
          input.deploymentId,
          input.deviceId,
          input.workspaceId
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async failManagedConversationExecutionWorkspaceCleanup(input) {
      const result = await pool.query(
        `update managed_conversation_runtime_bindings
            set workspace_lifecycle = $7,
                cleanup_state = 'failed',
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and execution_generation = $3
            and deployment_id = $4
            and device_id = $5
            and workspace_id = $6
            and workspace_kind = 'koed_managed_worktree'
            and workspace_lifecycle = 'cleanup_requested'
            and cleanup_state = 'requested'`,
        [
          input.executionId,
          input.ownerUserId,
          input.executionGeneration,
          input.deploymentId,
          input.deviceId,
          input.workspaceId,
          input.lifecycle
        ]
      );
      return (result.rowCount ?? 0) === 1;
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

    async listManagedConversationExecutionCheckpoints(actor, input) {
      const result = await pool.query<CheckpointRow>(
        `select ${CHECKPOINT_COLUMNS}
           from managed_conversation_execution_checkpoints
          where owner_user_id = $1
            and execution_id = $2
            and execution_generation = $3
          order by sequence,
                   case checkpoint_kind
                     when 'baseline' then 0
                     when 'terminal' then 1
                     when 'recovery' then 2
                   end,
                   id`,
        [actor.userId, input.executionId, input.executionGeneration]
      );
      return result.rows.map(mapCheckpoint);
    },

    async recordManagedConversationExecutionCheckpoint(actor, input) {
      const checkpoint = input.checkpoint;
      if (!validManagedCheckpointInput(checkpoint)) {
        throw statusError("Managed Conversation checkpoint is invalid", 400);
      }
      if (checkpoint.checkpointStatus !== "ready" && input.diffs?.length) {
        throw statusError(
          "Managed Conversation diff requires a ready checkpoint",
          400
        );
      }
      for (const diff of input.diffs ?? []) {
        const expectedScopeKey =
          diff.diffScope === "full" ? "full" : `turn:${checkpoint.commandId}`;
        if (
          diff.scopeKey !== expectedScopeKey ||
          diff.toCheckpointId !== checkpoint.id ||
          !/^[0-9a-f]{64}$/.test(diff.revisionDigest) ||
          !Number.isSafeInteger(diff.fileCount) ||
          diff.fileCount < 0 ||
          diff.fileCount > 25_000 ||
          !Number.isSafeInteger(diff.byteCount) ||
          diff.byteCount < 0 ||
          diff.byteCount > 16 * 1024 * 1024 ||
          (diff.complete && diff.truncated) ||
          diff.payload.revisionDigest !== diff.revisionDigest ||
          diff.payload.complete !== diff.complete ||
          diff.payload.truncated !== diff.truncated ||
          diff.payload.fileCount !== diff.fileCount ||
          diff.payload.byteCount !== diff.byteCount
        ) {
          throw statusError("Managed Conversation diff is invalid", 400);
        }
      }
      const encryptedDiffs = await Promise.all(
        (input.diffs ?? []).map(async (diff) => ({
          ...diff,
          payloadDigest: sha256(JSON.stringify(diff.payload)),
          encryptedPayload: await encryptDiffPayload({
            ownerUserId: actor.userId,
            executionId: checkpoint.executionId,
            diffId: diff.id,
            payload: diff.payload
          })
        }))
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const execution = await client.query<{
          source_generation_id: string | null;
        }>(
          `select source_generation_id
             from managed_conversation_executions
            where id = $1 and owner_user_id = $2 and execution_generation = $3
            for update`,
          [checkpoint.executionId, actor.userId, checkpoint.executionGeneration]
        );
        if (!execution.rows[0]) {
          throw statusError(
            "Managed Conversation checkpoint is unavailable",
            404
          );
        }
        if (
          checkpoint.checkpointKind === "terminal" &&
          execution.rows[0].source_generation_id !==
            checkpoint.sourceGenerationId
        ) {
          throw statusError(
            "Managed Conversation checkpoint source boundary is invalid",
            409
          );
        }
        const command = await client.query<{ command_kind: string }>(
          `select command_kind
             from managed_conversation_commands
            where id = $1
              and owner_user_id = $2
              and execution_id = $3
              and execution_generation = $4
              and sequence = $5`,
          [
            checkpoint.commandId,
            actor.userId,
            checkpoint.executionId,
            checkpoint.executionGeneration,
            checkpoint.sequence
          ]
        );
        if (
          !command.rows[0] ||
          (checkpoint.checkpointKind === "baseline" &&
            command.rows[0].command_kind !== "prompt") ||
          (checkpoint.checkpointKind === "terminal" &&
            !["prompt", "checkpoint_restore"].includes(
              command.rows[0].command_kind
            ))
        ) {
          throw statusError(
            "Managed Conversation checkpoint boundary is invalid",
            409
          );
        }
        const existing = await client.query<CheckpointRow>(
          `select ${CHECKPOINT_COLUMNS}
             from managed_conversation_execution_checkpoints
            where execution_id = $1
              and execution_generation = $2
              and sequence = $3
              and checkpoint_kind = $4
            limit 1`,
          [
            checkpoint.executionId,
            checkpoint.executionGeneration,
            checkpoint.sequence,
            checkpoint.checkpointKind
          ]
        );
        let recorded: CheckpointRow;
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (
            row.id !== checkpoint.id ||
            row.checkpoint_kind !== checkpoint.checkpointKind ||
            row.command_id !== checkpoint.commandId ||
            (row.provider_turn_id !== null &&
              row.provider_turn_id !== checkpoint.providerTurnId) ||
            (row.source_generation_id !== null &&
              row.source_generation_id !== checkpoint.sourceGenerationId) ||
            (row.checkpoint_status === "ready" &&
              (checkpoint.checkpointStatus !== "ready" ||
                row.checkpoint_ref !== checkpoint.checkpointRef ||
                row.commit_object_id !== checkpoint.commitObjectId))
          ) {
            throw statusError(
              "Managed Conversation checkpoint conflicted",
              409
            );
          }
          const updated = await client.query<CheckpointRow>(
            `update managed_conversation_execution_checkpoints
                set provider_turn_id = coalesce($2, provider_turn_id),
                    source_generation_id = coalesce($3, source_generation_id),
                    checkpoint_status = $4,
                    failure_code = $5,
                    repository_identity_hash = $6,
                    worktree_identity_hash = $7,
                    vcs_driver = $8,
                    checkpoint_ref = $9,
                    commit_object_id = $10,
                    captured_at = $11,
                    updated_at = now()
              where id = $1
              returning ${CHECKPOINT_COLUMNS}`,
            [
              checkpoint.id,
              checkpoint.providerTurnId,
              checkpoint.sourceGenerationId,
              checkpoint.checkpointStatus,
              checkpoint.failureCode,
              checkpoint.repositoryIdentityHash,
              checkpoint.worktreeIdentityHash,
              checkpoint.vcsDriver,
              checkpoint.checkpointRef,
              checkpoint.commitObjectId,
              checkpoint.capturedAt
            ]
          );
          recorded = updated.rows[0]!;
        } else {
          const inserted = await client.query<CheckpointRow>(
            `insert into managed_conversation_execution_checkpoints (
               id, owner_user_id, execution_id, execution_generation, command_id,
               provider_turn_id, source_generation_id, sequence, checkpoint_kind,
               checkpoint_status, failure_code, repository_identity_hash,
               worktree_identity_hash, vcs_driver, checkpoint_ref,
               commit_object_id, captured_at
             ) values (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
             )
             returning ${CHECKPOINT_COLUMNS}`,
            [
              checkpoint.id,
              actor.userId,
              checkpoint.executionId,
              checkpoint.executionGeneration,
              checkpoint.commandId,
              checkpoint.providerTurnId,
              checkpoint.sourceGenerationId,
              checkpoint.sequence,
              checkpoint.checkpointKind,
              checkpoint.checkpointStatus,
              checkpoint.failureCode,
              checkpoint.repositoryIdentityHash,
              checkpoint.worktreeIdentityHash,
              checkpoint.vcsDriver,
              checkpoint.checkpointRef,
              checkpoint.commitObjectId,
              checkpoint.capturedAt
            ]
          );
          recorded = inserted.rows[0]!;
        }
        for (const diff of encryptedDiffs) {
          const from = await client.query<{
            id: string;
            command_id: string;
            checkpoint_kind: "baseline" | "terminal" | "recovery";
            checkpoint_status: "pending" | "ready" | "failed" | "unsupported";
          }>(
            `select id, command_id, checkpoint_kind, checkpoint_status
               from managed_conversation_execution_checkpoints
              where id = $1
                and owner_user_id = $2
                and execution_id = $3
                and execution_generation = $4`,
            [
              diff.fromCheckpointId,
              actor.userId,
              checkpoint.executionId,
              checkpoint.executionGeneration
            ]
          );
          if (
            !from.rows[0] ||
            from.rows[0].checkpoint_status !== "ready" ||
            (diff.diffScope === "turn" &&
              (from.rows[0].checkpoint_kind !==
                (command.rows[0].command_kind === "checkpoint_restore"
                  ? "recovery"
                  : "baseline") ||
                from.rows[0].command_id !== checkpoint.commandId)) ||
            (diff.diffScope === "full" &&
              from.rows[0].checkpoint_kind !== "baseline")
          ) {
            throw statusError(
              "Managed Conversation diff boundary is invalid",
              409
            );
          }
          const persistedDiff = await client.query(
            `insert into managed_conversation_execution_diffs (
               id, owner_user_id, execution_id, execution_generation, scope_key,
               diff_scope, from_checkpoint_id, to_checkpoint_id, revision_digest,
               complete, truncated, file_count, byte_count, payload_digest,
               encrypted_payload
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             on conflict (execution_id, execution_generation, scope_key) do update
               set diff_scope = excluded.diff_scope,
                   from_checkpoint_id = excluded.from_checkpoint_id,
                   to_checkpoint_id = excluded.to_checkpoint_id,
                   revision_digest = excluded.revision_digest,
                   complete = excluded.complete,
                   truncated = excluded.truncated,
                   file_count = excluded.file_count,
                   byte_count = excluded.byte_count,
                   payload_digest = excluded.payload_digest,
                   encrypted_payload = excluded.encrypted_payload,
                   updated_at = now()
               where managed_conversation_execution_diffs.id = excluded.id`,
            [
              diff.id,
              actor.userId,
              checkpoint.executionId,
              checkpoint.executionGeneration,
              diff.scopeKey,
              diff.diffScope,
              diff.fromCheckpointId,
              recorded.id,
              diff.revisionDigest,
              diff.complete,
              diff.truncated,
              diff.fileCount,
              diff.byteCount,
              diff.payloadDigest,
              diff.encryptedPayload
            ]
          );
          if ((persistedDiff.rowCount ?? 0) !== 1) {
            throw statusError(
              "Managed Conversation diff identity conflicted",
              409
            );
          }
        }
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: checkpoint.executionId,
          mutationId: `checkpoint:${recorded.id}:${recorded.commit_object_id ?? recorded.checkpoint_status}`
        });
        await client.query("commit");
        return mapCheckpoint(recorded);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async getManagedConversationExecutionDiff(actor, input) {
      const result = await pool.query<DiffRow>(
        `select ${DIFF_COLUMNS}
           from managed_conversation_execution_diffs
          where owner_user_id = $1
            and execution_id = $2
            and execution_generation = $3
            and scope_key = $4
          limit 1`,
        [
          actor.userId,
          input.executionId,
          input.executionGeneration,
          input.scopeKey
        ]
      );
      return result.rows[0] ? hydrateDiff(result.rows[0]) : null;
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
