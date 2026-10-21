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
import { stampManagedPolicyCapture } from "./managed-policy-capture.js";
import {
  appendProjectActivityWithClient,
  decodeProjectActivityCursor
} from "./project-activity-repository.js";
import {
  managedConversationSettingsKey,
  parseManagedConversationSettings,
  type ManagedConversationSettings,
  type ManagedConversationSettingsChange
} from "@koed/shared/ai-client-contract";

import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { managedConversationEventMutationId } from "./managed-conversation-event.js";
import {
  loadConversationPresentationPolicySnapshot,
  type ConversationPresentationPolicySnapshot
} from "./conversation-presentation-policy.js";
import type { ActorContext } from "./types.js";
import { ScheduledJobConflict } from "./scheduled-job-repository.js";
import { activeCuratedMemoryEvidencePredicate } from "./curated-memory-policy.js";

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
  | "hq_catch_up"
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
  checkoutId: string | null;
  checkoutKind:
    | "pending"
    | "koed_managed_worktree"
    | "user_managed_checkout"
    | "non_vcs_directory";
  checkoutLifecycle:
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

export type ProjectHqCatchUpDisposition =
  | "none"
  | "active"
  | "completed"
  | "proven_no_send"
  | "needs_reconciliation";

export type ProjectHqTeamCatchUpWindow = Readonly<{
  teamBackendId: string;
  workspaceProjectId: string;
  teamPrincipalUserId: string;
  memberId: string;
  projectVersion: number;
  memberVersion: number;
  seenCursor: string;
  highCursor: string;
  welcomeDue: boolean;
  events: ReadonlyArray<{
    kind: "work_item_created" | "work_item_done" | "source_added" | "pr_merged";
    ref: string;
    at: string;
  }>;
}>;

const isProjectHqTeamCatchUpWindow = (
  value: unknown
): value is ProjectHqTeamCatchUpWindow => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.teamBackendId === "string" &&
    item.teamBackendId.length > 0 &&
    typeof item.workspaceProjectId === "string" &&
    typeof item.teamPrincipalUserId === "string" &&
    typeof item.memberId === "string" &&
    Number.isSafeInteger(item.projectVersion) &&
    Number(item.projectVersion) > 0 &&
    Number.isSafeInteger(item.memberVersion) &&
    Number(item.memberVersion) > 0 &&
    typeof item.seenCursor === "string" &&
    typeof item.highCursor === "string" &&
    typeof item.welcomeDue === "boolean" &&
    Array.isArray(item.events) &&
    item.events.length <= 100 &&
    item.events.every(
      (event: unknown) =>
        event !== null &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        [
          "work_item_created",
          "work_item_done",
          "source_added",
          "pr_merged"
        ].includes(String((event as Record<string, unknown>).kind)) &&
        typeof (event as Record<string, unknown>).ref === "string" &&
        typeof (event as Record<string, unknown>).at === "string"
    )
  );
};

export interface ClaimedManagedConversationCommand extends ManagedConversationCommandRecord {
  execution: ManagedConversationExecutionRecord;
}

export interface ManagedConversationRepository {
  listSharedDispatchProgressCandidates(
    actor: ActorContext,
    input: {
      deploymentId: string;
      deviceId: string;
      afterExecutionId?: string;
      limit?: number;
    }
  ): Promise<Array<{ executionId: string; commandId: string }>>;
  listSharedWorkItemDispatches(
    actor: ActorContext,
    input: {
      personalProjectId: string;
      teamBackendId: string;
      workspaceProjectId: string;
    }
  ): Promise<
    Array<{ teamWorkItemId: string; executionId: string; agentId: string }>
  >;
  getSharedWorkItemDispatchForExecution(
    actor: ActorContext,
    executionId: string
  ): Promise<{
    agentId: string;
    teamBackendId: string;
    teamPrincipalUserId: string;
    workspaceProjectId: string;
    teamWorkItemId: string;
    teamWorkItemVersion: number;
    expectedProjectVersion: number;
    expectedMemberVersion: number;
  } | null>;
  getSharedWorkItemDispatch(
    actor: ActorContext,
    input: {
      projectId: string;
      idempotencyKey: string;
    }
  ): Promise<{
    executionId: string;
    agentId: string;
    teamBackendId: string;
    teamPrincipalUserId: string;
    workspaceProjectId: string;
    teamWorkItemId: string;
    teamWorkItemVersion: number;
    expectedProjectVersion: number;
    expectedMemberVersion: number;
    textActionId: string | null;
  } | null>;
  getManagedAgentDelegationByRequest(
    actor: ActorContext,
    requestId: string
  ): Promise<{
    parentExecutionId: string | null;
    parentExecutionGeneration: number | null;
    childExecutionId: string;
    agentId: string;
    projectId: string;
  } | null>;
  listManagedAgentDelegations(
    actor: ActorContext,
    projectId: string
  ): Promise<
    Array<{
      parentExecutionId: string | null;
      childExecutionId: string;
      agentId: string;
      taskLabel: string;
      childSessionId: string | null;
      childState: string;
    }>
  >;
  createManagedConversation(
    actor: ActorContext,
    input: {
      projectId: string;
      contextKind?: "project" | "independent";
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
      /** Set only by the authenticated Desktop User-message route. */
      textActionHumanOrigin?: "hq_first_message";
      selectedDocumentSourceId?: string;
      deferUntilRuntimeBinding?: boolean;
      hqProjectId?: string;
      hqPrivatePath?: string;
      workItemDispatch?: {
        itemId: string;
        agentId: string;
        version: number;
        textActionId?: string;
        sources?: Array<{ id: string; currentRevisionId: string | null }>;
      };
      sharedWorkItemDispatch?: {
        teamBackendId: string;
        teamPrincipalUserId: string;
        workspaceProjectId: string;
        teamWorkItemId: string;
        teamWorkItemVersion: number;
        expectedProjectVersion: number;
        expectedMemberVersion: number;
        agentId: string;
        textActionId?: string;
      };
      agentDelegation?: {
        parentExecutionId: string | null;
        parentExecutionGeneration: number | null;
        agentId: string;
        requestId: string;
      };
    }
  ): Promise<{
    execution: ManagedConversationExecutionRecord;
    command: ManagedConversationCommandRecord;
    fencingToken: string;
  }>;
  retryWorkItemConversation(
    actor: ActorContext,
    input: {
      projectId: string;
      itemId: string;
      agentId: string;
      expectedVersion: number;
    }
  ): Promise<{
    execution: ManagedConversationExecutionRecord;
    command: ManagedConversationCommandRecord;
  }>;
  enqueueManagedConversationPrompt(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      idempotencyKey: string;
      clientUserMessageId: string;
      prompt: string;
      /** Set only by the authenticated Desktop User-message route. */
      textActionHumanOrigin?: "human_prompt";
      selectedDocumentSourceId?: string;
      fileMentionCommandIds?: string[];
      settingsChange?: ManagedConversationSettingsChange;
      /** Trusted scheduler hooks run in the prompt transaction, before command visibility. */
      scheduledDispatch?: {
        start: (client: pg.PoolClient) => Promise<void>;
        bind: (client: pg.PoolClient, commandId: string) => Promise<void>;
      };
    }
  ): Promise<ManagedConversationCommandRecord>;
  /** Only the trusted local HQ coordinator may supply server-derived input. */
  enqueueManagedConversationCatchUp(
    actor: ActorContext,
    input: {
      projectId: string;
      executionId: string;
      executionGeneration: number;
      seenCursor: string;
      highWater: string;
      events: readonly (
        | {
            cursor: string;
            kind: "source_ready" | "source_failed";
            attemptId: string;
            sourceId: string;
            name: string;
            at: string;
          }
        | {
            cursor: string;
            kind: "assertion_created";
            assertionId: string;
            text: string;
            classificationVersion: number;
            updatedAt: string;
            at: string;
          }
      )[];
      teamWindow?: ProjectHqTeamCatchUpWindow | null;
      prompt: string;
      inputDigest: string;
    }
  ): Promise<ManagedConversationCommandRecord>;
  inspectProjectHqCatchUp(
    actor: ActorContext,
    input: { projectId: string; executionId: string }
  ): Promise<{
    disposition: ProjectHqCatchUpDisposition;
    command: ManagedConversationCommandRecord | null;
  }>;
  pendingProjectHqTeamAck(
    actor: ActorContext,
    input: { projectId: string; executionId: string }
  ): Promise<{
    commandId: string;
    teamWindow: ProjectHqTeamCatchUpWindow;
  } | null>;
  markProjectHqTeamAck(
    actor: ActorContext,
    input: {
      projectId: string;
      executionId: string;
      commandId: string;
      teamWindow: ProjectHqTeamCatchUpWindow;
    }
  ): Promise<boolean>;
  getProjectHqCatchUpRetry(
    actor: ActorContext,
    input: {
      projectId: string;
      executionId: string;
      failedCommandId: string;
      retryRequestId: string;
    }
  ): Promise<ManagedConversationCommandRecord | null>;
  recoverProjectHqCatchUp(
    actor: ActorContext,
    input: { projectId: string; executionId: string; commandId: string }
  ): Promise<boolean>;
  retryProjectHqCatchUp(
    actor: ActorContext,
    input: Parameters<
      ManagedConversationRepository["enqueueManagedConversationCatchUp"]
    >[1] & {
      failedCommandId: string;
      retryRequestId: string;
    }
  ): Promise<{
    execution: ManagedConversationExecutionRecord;
    command: ManagedConversationCommandRecord;
  }>;
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
  declineManagedMergeProposal(
    actor: ActorContext,
    input: { executionId: string; itemId: string; executionGeneration: number }
  ): Promise<boolean>;
  listManagedMergeDecisionContext(
    actor: ActorContext,
    input: { executionId: string; executionGeneration: number }
  ): Promise<string[]>;
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
  getManagedConversationExecutionForSession(
    actor: ActorContext,
    logicalSessionId: string
  ): Promise<ManagedConversationExecutionRecord | null>;
  hasScheduledJobDispatchForCommand(
    actor: ActorContext,
    commandId: string
  ): Promise<boolean>;
  getInterruptedScheduledCommandForExecution(
    actor: ActorContext,
    input: { executionId: string; executionGeneration: number }
  ): Promise<string | null>;
  listQueuedScheduledJobCommands(
    actor: ActorContext,
    input: { deviceId: string; deploymentId: string; limit: number }
  ): Promise<string[]>;
  hasActiveScheduledJobDispatchForExecution(
    actor: ActorContext,
    executionId: string
  ): Promise<boolean>;
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
    /** Trusted runner preflight allowlist; ordinary commands are unaffected. */
    allowedScheduledCommandIds?: string[];
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
      providerTurnId?: string;
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
  completeManagedConversationCatchUp(input: {
    commandId: string;
    leaseToken: string;
    localSessionId: string;
    sourceKind: "codex" | "pi" | "claude-code";
    externalSessionId: string;
    sourceGenerationId: string;
    sourceToLine: number;
    providerTurnId: string | null;
  }): Promise<boolean>;
  markManagedConversationCatchUpSendStarted(input: {
    commandId: string;
    leaseToken: string;
    executionGeneration: number;
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
  acknowledgeManagedConversationRuntimeBinding(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
  }): Promise<boolean>;
  listPendingManagedConversationRuntimeBindings(input: {
    ownerUserId?: string;
    deploymentId: string;
    deviceId: string;
    limit?: number;
  }): Promise<ManagedConversationRuntimeBindingRecord[]>;
  bindManagedConversationExecutionCheckout(
    actor: ActorContext,
    input: {
      executionId: string;
      deploymentId: string;
      deviceId: string;
      executionGeneration: number;
      sourceProjectPath: string;
      projectPath: string;
      checkoutId: string;
      checkoutKind:
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
  requestManagedConversationExecutionCheckoutCleanup(
    actor: ActorContext,
    input: {
      executionId: string;
      executionGeneration: number;
      deploymentId: string;
      deviceId: string;
    }
  ): Promise<ManagedConversationRuntimeBindingRecord>;
  listManagedConversationExecutionCheckoutCleanupRequests(input: {
    deploymentId: string;
    deviceId: string;
    limit?: number;
  }): Promise<ManagedConversationRuntimeBindingRecord[]>;
  completeManagedConversationExecutionCheckoutCleanup(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
    checkoutId: string;
  }): Promise<boolean>;
  failManagedConversationExecutionCheckoutCleanup(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    deploymentId: string;
    deviceId: string;
    checkoutId: string;
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
    executionId: string,
    pendingAssignment?: {
      executionGeneration: number;
      deploymentId: string;
      deviceId: string;
    }
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
  is_project_hq: boolean;
  hq_private_path: string | null;
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
  checkout_id: string | null;
  checkout_kind: ManagedConversationRuntimeBindingRecord["checkoutKind"];
  checkout_lifecycle: ManagedConversationRuntimeBindingRecord["checkoutLifecycle"];
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
  id, owner_user_id, project_id, is_project_hq, hq_private_path,
  provider, ai_client_instance_id, model,
  reasoning_effort, permission_mode, runner_kind, state,
  state_version, execution_generation, runner_deployment_id, runner_device_id,
  runner_id, runner_lease_expires_at, logical_session_id, provider_thread_id,
  provider_cli_version, source_generation_id, last_error_code,
  created_at, updated_at, started_at, quiesced_at, stopped_at
`;

const RUNTIME_BINDING_COLUMNS = `
  execution_id, owner_user_id, deployment_id, device_id, execution_generation,
  source_project_path, project_path, checkout_id, checkout_kind,
  checkout_lifecycle, cleanup_state, vcs_driver,
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
  checkoutId: row.checkout_id,
  checkoutKind: row.checkout_kind,
  checkoutLifecycle: row.checkout_lifecycle,
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
  contextKind?: "project" | "independent";
  provider: string;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string | null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
  runnerKind: "local_device";
  runnerDeploymentId: string;
  runnerDeviceId: string;
  initialPrompt?: string;
  selectedDocumentSourceId?: string;
  deferUntilRuntimeBinding?: boolean;
}): string =>
  sha256(
    JSON.stringify({
      kind: "start",
      // Keep existing Project request digests compatible with retries.
      ...(input.contextKind === "independent"
        ? { contextKind: "independent" }
        : {}),
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
      ...(input.selectedDocumentSourceId
        ? { selectedDocumentSourceId: input.selectedDocumentSourceId }
        : {}),
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
    selectedDocumentSourceId?: string;
    fileMentions?: Array<Record<string, unknown>>;
    workItemSourceProof?: Array<{
      id: string;
      currentRevisionId: string | null;
    }>;
    sharedWorkItemDispatch?: {
      teamBackendId: string;
      teamPrincipalUserId: string;
      workspaceProjectId: string;
      teamWorkItemId: string;
      teamWorkItemVersion: number;
      expectedProjectVersion: number;
      expectedMemberVersion: number;
      agentId: string;
      textActionId?: string;
    };
    settings: ManagedConversationSettings;
  }) =>
    encryptCommandPayload({
      ownerUserId: input.ownerUserId,
      executionId: input.executionId,
      commandId: input.commandId,
      objectClass: "managed_conversation_prompt",
      value: {
        prompt: input.prompt,
        ...(input.selectedDocumentSourceId
          ? { selectedDocumentSourceId: input.selectedDocumentSourceId }
          : {}),
        settings: input.settings,
        ...(input.workItemSourceProof
          ? { workItemSourceProof: input.workItemSourceProof }
          : {}),
        ...(input.sharedWorkItemDispatch
          ? { sharedWorkItemDispatch: input.sharedWorkItemDispatch }
          : {}),
        ...(input.fileMentions?.length
          ? { fileMentions: input.fileMentions }
          : {})
      }
    });

  const checkedCatchUpInput = (
    ownerUserId: string,
    input: Parameters<
      ManagedConversationRepository["enqueueManagedConversationCatchUp"]
    >[1]
  ) => {
    const seenSequence = decodeProjectActivityCursor(
      input.seenCursor,
      ownerUserId,
      input.projectId
    );
    const highSequence = decodeProjectActivityCursor(
      input.highWater,
      ownerUserId,
      input.projectId
    );
    const computedDigest = sha256(
      JSON.stringify({
        ownerUserId,
        projectId: input.projectId,
        seenCursor: input.seenCursor,
        highWater: input.highWater,
        events: input.events,
        ...(input.teamWindow ? { teamWindow: input.teamWindow } : {})
      })
    );
    if (
      (input.teamWindow !== null &&
        input.teamWindow !== undefined &&
        !isProjectHqTeamCatchUpWindow(input.teamWindow)) ||
      seenSequence > highSequence ||
      (!input.teamWindow && seenSequence === highSequence) ||
      (input.events.length < 1 &&
        (!input.teamWindow ||
          (!input.teamWindow.welcomeDue &&
            !input.teamWindow.events.some(
              (event) =>
                event.kind === "work_item_created" ||
                event.kind === "source_added"
            )))) ||
      input.events.length > 100 ||
      !input.prompt.trim() ||
      input.prompt.length > 256_000 ||
      computedDigest !== input.inputDigest
    )
      throw statusError("Project HQ catch-up input changed", 409);
    return { seenSequence, highSequence };
  };

  const assertCurrentCatchUpProject = async (
    client: pg.PoolClient,
    ownerUserId: string,
    projectId: string,
    teamWindow: ProjectHqTeamCatchUpWindow | null | undefined
  ) => {
    const project = await client.query(
      `select 1 from projects where id=$1 and owner_user_id=$2
         and lifecycle='active' and deletion_phase is null
         and (
           ($3::text is null and team_backend_id is null
              and workspace_project_id is null)
           or (team_backend_id=$3 and workspace_project_id=$4::uuid)
         )
         and not exists (
           select 1 from personal_workspace_project_share_attempts attempt
            where attempt.personal_project_id=projects.id
              and attempt.state='pending'
         ) for share nowait`,
      [
        projectId,
        ownerUserId,
        teamWindow?.teamBackendId ?? null,
        teamWindow?.workspaceProjectId ?? null
      ]
    );
    if (!project.rowCount)
      throw statusError("Project HQ catch-up Project changed", 409);
    if (teamWindow) {
      const binding = await client.query(
        `select 1 from personal_workspace_project_principal_bindings
          where local_user_id=$1 and team_backend_id=$2
            and team_principal_user_id=$3`,
        [ownerUserId, teamWindow.teamBackendId, teamWindow.teamPrincipalUserId]
      );
      if (!binding.rowCount)
        throw statusError("Project HQ Team principal changed", 409);
    }
  };

  const assertCurrentCatchUpRange = async (
    client: pg.PoolClient,
    ownerUserId: string,
    input: Parameters<
      ManagedConversationRepository["enqueueManagedConversationCatchUp"]
    >[1],
    seenSequence: bigint,
    highSequence: bigint,
    allowSeenAdvance = false
  ) => {
    const seen = await client.query<{ seen_sequence: string }>(
      `select seen_sequence from project_seen
        where owner_user_id=$1 and project_id=$2 for update nowait`,
      [ownerUserId, input.projectId]
    );
    const currentSeen = BigInt(seen.rows[0]?.seen_sequence ?? "0");
    if (
      currentSeen !== seenSequence &&
      (!allowSeenAdvance || currentSeen < seenSequence)
    )
      throw statusError("Project HQ seen cursor changed", 409);
    const highWater = await client.query(
      `select 1 from project_activity
        where owner_user_id=$1 and project_id=$2 and sequence=$3`,
      [ownerUserId, input.projectId, highSequence.toString()]
    );
    if (highSequence > seenSequence && !highWater.rowCount)
      throw statusError("Project HQ activity changed", 409);
    const checked = new Set<string>();
    for (const event of input.events) {
      const sequence = decodeProjectActivityCursor(
        event.cursor,
        ownerUserId,
        input.projectId
      );
      if (
        sequence <= seenSequence ||
        sequence > highSequence ||
        checked.has(sequence.toString())
      )
        throw statusError("Project HQ activity range changed", 409);
      checked.add(sequence.toString());
      if (event.kind === "assertion_created") {
        const decision = await client.query(
          `select 1 from project_activity activity
           join curated_memory_assertions cma
             on cma.id::text=activity.ref and cma.owner_user_id=activity.owner_user_id
           where activity.owner_user_id=$1 and activity.project_id=$2
             and activity.sequence=$3 and activity.kind='assertion_created'
             and activity.ref=$4 and cma.id=$5 and cma.scope='project'
             and cma.project_id=activity.project_id and cma.kind='decision'
             and cma.visibility='personal' and cma.status='current'
             and cma.classification_version=$6
             and cma.updated_at=$7::timestamptz
             and cma.suppressed_at is null
             and (cma.expires_at is null or cma.expires_at>now())
             and ${activeCuratedMemoryEvidencePredicate("cma")}`,
          [
            ownerUserId,
            input.projectId,
            sequence.toString(),
            event.assertionId,
            event.assertionId,
            event.classificationVersion,
            event.updatedAt
          ]
        );
        if (!decision.rowCount)
          throw statusError("Project HQ decision changed", 409);
        continue;
      }
      const actual = await client.query(
        `select 1 from project_activity activity
          join project_source_revisions revision
            on revision.id::text=activity.ref
           and revision.owner_user_id=activity.owner_user_id
          join project_sources source
            on source.id=revision.source_id
           and source.owner_user_id=revision.owner_user_id
           and source.project_id=activity.project_id
         where activity.owner_user_id=$1 and activity.project_id=$2
           and activity.sequence=$3 and activity.kind=$4 and activity.ref=$5
           and revision.id::text=$5 and source.id::text=$6 and source.name=$7
           and source.deleted_at is null and source.remove_batch_id is null
           and source.pending_revision_id is null
           and revision.state=source.status
           and source.status=case when $4='source_ready' then 'ready' else 'failed' end
           and not exists (
             select 1 from project_source_revisions newer
              where newer.owner_user_id=revision.owner_user_id
                and newer.source_id=revision.source_id
                and newer.revision>revision.revision
           )
           and (source.status='failed' or
                source.current_revision_id=revision.note_revision_id)`,
        [
          ownerUserId,
          input.projectId,
          sequence.toString(),
          event.kind,
          event.attemptId,
          event.sourceId,
          event.name
        ]
      );
      if (!actual.rowCount) throw statusError("Project HQ Source changed", 409);
    }
  };

  const assertCurrentWorkItemSources = async (
    client: pg.PoolClient,
    ownerUserId: string,
    projectId: string,
    sources: Array<{ id: string; currentRevisionId: string | null }>
  ) => {
    if (
      sources.length > 20 ||
      new Set(sources.map((source) => source.id)).size !== sources.length ||
      sources.some(
        (source) =>
          typeof source.id !== "string" ||
          (source.currentRevisionId !== null &&
            typeof source.currentRevisionId !== "string")
      )
    )
      throw statusError("Work Item Source context is invalid", 409);
    for (const source of [...sources].sort((a, b) =>
      a.id.localeCompare(b.id)
    )) {
      const currentSource = await client.query<{
        current_revision_id: string | null;
        kind: string;
      }>(
        `select current_revision_id,kind from project_sources
         where id=$1 and owner_user_id=$2 and project_id=$3
           and deleted_at is null and remove_batch_id is null and status='ready'
         for share`,
        [source.id, ownerUserId, projectId]
      );
      if (
        !currentSource.rows[0] ||
        currentSource.rows[0].current_revision_id !== source.currentRevisionId
      )
        throw statusError("Work Item Source context changed", 409);
      if (currentSource.rows[0].kind === "doc") {
        const note = await client.query(
          `select 1 from personal_note_revisions revision
             join personal_notes note on note.id=revision.note_id
              and note.owner_user_id=revision.owner_user_id
           where revision.id=$1 and revision.owner_user_id=$2
             and revision.projection_state='available'
             and revision.forgotten_at is null and note.lifecycle='active'
           for share of revision,note`,
          [source.currentRevisionId, ownerUserId]
        );
        if (!note.rowCount)
          throw statusError("Work Item Source Note is unavailable", 409);
      }
    }
  };

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

  const assertExecutionProjectWritable = async (
    client: pg.PoolClient,
    execution: ExecutionRow
  ) => {
    if (execution.is_project_hq) {
      const hqProject = await client.query<{
        lifecycle: string;
        deletion_phase: string | null;
      }>(
        `select lifecycle,deletion_phase from projects
          where owner_user_id=$1 and id=$2::uuid
          for share`,
        [execution.owner_user_id, execution.project_id]
      );
      if (
        hqProject.rowCount !== 1 ||
        hqProject.rows[0]?.lifecycle !== "active" ||
        hqProject.rows[0]?.deletion_phase !== null
      )
        throw statusError("Project is unavailable for managed execution", 409);
      return;
    }
    const result = await client.query<{
      lifecycle: string;
      deletion_phase: string | null;
    }>(
      `select p.lifecycle,p.deletion_phase from projects p
        left join project_local_contexts context on context.project_id=p.id
          and context.owner_user_id=p.owner_user_id
          and context.device_id=$2 and context.local_project_id=$3
          and context.association_state='resolved'
       where p.owner_user_id=$1 and (p.id::text=$3 or context.local_project_id=$3)
       for share of p`,
      [
        execution.owner_user_id,
        execution.runner_device_id,
        execution.project_id
      ]
    );
    if (
      result.rows.some(
        (row) => row.lifecycle !== "active" || row.deletion_phase !== null
      )
    )
      throw statusError("Project is unavailable for managed execution", 409);
  };

  const assertExecutionChatWritable = async (
    client: pg.PoolClient,
    execution: ExecutionRow
  ) => {
    const blocked = await client.query(
      `select 1 from sessions captured
        where captured.owner_user_id=$1 and captured.logical_session_id=$2
          and (captured.delete_batch_id is not null or captured.forget_batch_id is not null
            or captured.trashed_at is not null
            or captured.personal_deleted_at is not null)
        limit 1`,
      [execution.owner_user_id, execution.logical_session_id]
    );
    if (blocked.rowCount)
      throw statusError("Conversation lifecycle blocks new work", 409);
  };

  const assertHqCatchUpSessionWritable = async (
    client: pg.PoolClient,
    execution: Pick<
      ExecutionRow,
      "owner_user_id" | "logical_session_id" | "provider_thread_id"
    >,
    localSessionId: string | null
  ) => {
    if (
      !execution.logical_session_id ||
      !execution.provider_thread_id ||
      !localSessionId
    )
      throw statusError("Project HQ capture is not ready", 409);
    // Captured-session lifecycle paths can hold Session before Execution.
    // A catch-up already holding Execution must never wait for Session.
    const sessions = await client.query<{
      deleted: boolean;
    }>(
      `select (delete_batch_id is not null or forget_batch_id is not null
                 or trashed_at is not null or personal_deleted_at is not null)
                 as deleted
         from sessions
        where owner_user_id=$1 and logical_session_id=$2 and id=$3
        for share nowait`,
      [execution.owner_user_id, execution.logical_session_id, localSessionId]
    );
    if (!sessions.rows.length || sessions.rows.some((row) => row.deleted))
      throw statusError("Project HQ capture changed", 409);
  };

  return {
    async listSharedDispatchProgressCandidates(actor, input) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const result = await pool.query<{
        execution_id: string;
        command_id: string;
      }>(
        `select execution.id as execution_id, latest.id as command_id
         from managed_conversation_executions execution
         join projects project on project.id::text=execution.project_id
           and project.owner_user_id=execution.owner_user_id
         join lateral (
           select command.id,command.state from managed_conversation_commands command
            where command.owner_user_id=execution.owner_user_id
              and command.execution_id=execution.id
              and command.command_kind in ('start','prompt')
            order by command.sequence desc,command.created_at desc,command.id desc limit 1
         ) latest on true
         where execution.owner_user_id=$1 and execution.runner_deployment_id=$2
           and execution.runner_device_id=$3 and execution.id>$4::uuid
           and project.lifecycle='active' and project.deletion_phase is null
           and project.team_backend_id is not null and project.workspace_project_id is not null
           and latest.state in ('completed','failed','indeterminate','canceled')
           and exists (select 1 from managed_conversation_commands start_command
             where start_command.owner_user_id=execution.owner_user_id
               and start_command.execution_id=execution.id
               and start_command.command_kind='start'
               and start_command.idempotency_key like
                 'shared-work-item:'||project.workspace_project_id::text||':%')
           and not exists (select 1 from managed_shared_dispatch_detachments detached
             where detached.owner_user_id=execution.owner_user_id
               and detached.execution_id=execution.id)
         order by execution.id limit $5`,
        [
          actor.userId,
          input.deploymentId,
          input.deviceId,
          input.afterExecutionId ?? "00000000-0000-0000-0000-000000000000",
          limit
        ]
      );
      return result.rows.map((row) => ({
        executionId: row.execution_id,
        commandId: row.command_id
      }));
    },
    async listSharedWorkItemDispatches(actor, input) {
      const link = await pool.query<{ team_principal_user_id: string }>(
        `select binding.team_principal_user_id from projects project
         join personal_workspace_project_principal_bindings binding
           on binding.local_user_id=project.owner_user_id
          and binding.team_backend_id=project.team_backend_id
         where project.id=$1 and project.owner_user_id=$2
           and project.lifecycle='active' and project.deletion_phase is null
           and project.team_backend_id=$3 and project.workspace_project_id=$4
           and not exists (select 1 from personal_workspace_project_share_attempts attempt
             where attempt.personal_project_id=project.id and attempt.state='pending')`,
        [
          input.personalProjectId,
          actor.userId,
          input.teamBackendId,
          input.workspaceProjectId
        ]
      );
      const principal = link.rows[0]?.team_principal_user_id;
      if (!principal) return [];
      const starts = await pool.query<CommandRow>(
        `select command.* from managed_conversation_commands command
         join managed_conversation_executions execution
           on execution.id=command.execution_id and execution.owner_user_id=command.owner_user_id
         left join managed_shared_dispatch_detachments detached
           on detached.owner_user_id=command.owner_user_id and detached.execution_id=command.execution_id
         where command.owner_user_id=$1 and execution.project_id=$2
           and command.command_kind='start' and detached.execution_id is null
         order by command.created_at desc limit 501`,
        [actor.userId, input.personalProjectId]
      );
      if (starts.rows.length > 500)
        throw statusError("Shared dispatch list is too large", 409);
      const result: Array<{
        teamWorkItemId: string;
        executionId: string;
        agentId: string;
      }> = [];
      for (const command of starts.rows) {
        const payload = await decryptPayload(command);
        const dispatch = payload?.sharedWorkItemDispatch;
        if (
          !dispatch ||
          typeof dispatch !== "object" ||
          Array.isArray(dispatch)
        )
          continue;
        const value = dispatch as Record<string, unknown>;
        if (
          value.teamBackendId !== input.teamBackendId ||
          value.workspaceProjectId !== input.workspaceProjectId ||
          value.teamPrincipalUserId !== principal ||
          typeof value.teamWorkItemId !== "string" ||
          typeof value.agentId !== "string"
        )
          continue;
        result.push({
          teamWorkItemId: value.teamWorkItemId,
          executionId: command.execution_id,
          agentId: value.agentId
        });
      }
      return result;
    },
    async getSharedWorkItemDispatchForExecution(actor, executionId) {
      const detached = await pool.query(
        `select 1 from managed_shared_dispatch_detachments
         where owner_user_id=$1 and execution_id=$2 limit 1`,
        [actor.userId, executionId]
      );
      if (detached.rowCount) return null;
      const result = await pool.query<CommandRow>(
        `select ${COMMAND_COLUMNS} from managed_conversation_commands
         where owner_user_id=$1 and execution_id=$2 and command_kind='start'
         order by sequence asc limit 1`,
        [actor.userId, executionId]
      );
      const command = result.rows[0];
      if (!command) return null;
      const payload = await decryptPayload(command);
      const dispatch = payload?.sharedWorkItemDispatch;
      if (dispatch === undefined) return null;
      if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch))
        throw statusError("Shared Work Item dispatch metadata is invalid", 409);
      const value = dispatch as Record<string, unknown>;
      if (
        typeof value.agentId !== "string" ||
        typeof value.teamBackendId !== "string" ||
        typeof value.teamPrincipalUserId !== "string" ||
        typeof value.workspaceProjectId !== "string" ||
        typeof value.teamWorkItemId !== "string" ||
        typeof value.teamWorkItemVersion !== "number" ||
        typeof value.expectedProjectVersion !== "number" ||
        typeof value.expectedMemberVersion !== "number"
      )
        throw statusError("Shared Work Item dispatch metadata is invalid", 409);
      return {
        agentId: value.agentId,
        teamBackendId: value.teamBackendId,
        teamPrincipalUserId: value.teamPrincipalUserId,
        workspaceProjectId: value.workspaceProjectId,
        teamWorkItemId: value.teamWorkItemId,
        teamWorkItemVersion: value.teamWorkItemVersion,
        expectedProjectVersion: value.expectedProjectVersion,
        expectedMemberVersion: value.expectedMemberVersion
      };
    },
    async getSharedWorkItemDispatch(actor, input) {
      const result = await pool.query<CommandRow>(
        `select ${COMMAND_COLUMNS} from managed_conversation_commands
         where owner_user_id=$1 and idempotency_key=$2 and command_kind='start'
           and exists (
             select 1 from managed_conversation_executions execution
               join projects project
                 on project.id::text=execution.project_id and project.owner_user_id=execution.owner_user_id
              where execution.id=managed_conversation_commands.execution_id
                and execution.owner_user_id=$1 and execution.project_id=$3
                and project.lifecycle='active' and project.deletion_phase is null
                and project.team_backend_id is not null and project.workspace_project_id is not null
           )
         limit 1`,
        [actor.userId, input.idempotencyKey, input.projectId]
      );
      const command = result.rows[0];
      if (!command) return null;
      const payload = await decryptPayload(command);
      const dispatch = payload?.sharedWorkItemDispatch;
      if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch))
        throw statusError("Shared Work Item dispatch key is inconsistent", 409);
      const value = dispatch as Record<string, unknown>;
      if (
        typeof value.agentId !== "string" ||
        typeof value.teamBackendId !== "string" ||
        typeof value.teamPrincipalUserId !== "string" ||
        typeof value.workspaceProjectId !== "string" ||
        typeof value.teamWorkItemId !== "string" ||
        typeof value.teamWorkItemVersion !== "number" ||
        typeof value.expectedProjectVersion !== "number" ||
        typeof value.expectedMemberVersion !== "number"
      )
        throw statusError("Shared Work Item dispatch metadata is invalid", 409);
      return {
        executionId: command.execution_id,
        agentId: value.agentId,
        teamBackendId: value.teamBackendId,
        teamPrincipalUserId: value.teamPrincipalUserId,
        workspaceProjectId: value.workspaceProjectId,
        teamWorkItemId: value.teamWorkItemId,
        teamWorkItemVersion: value.teamWorkItemVersion,
        expectedProjectVersion: value.expectedProjectVersion,
        expectedMemberVersion: value.expectedMemberVersion,
        textActionId:
          typeof value.textActionId === "string" ? value.textActionId : null
      };
    },
    async getManagedAgentDelegationByRequest(actor, requestId) {
      const result = await pool.query<{
        parent_execution_id: string | null;
        parent_execution_generation: number | null;
        child_execution_id: string;
        agent_id: string;
        project_id: string;
      }>(
        `select d.parent_execution_id,d.parent_execution_generation,
                d.child_execution_id,d.agent_id,d.project_id
           from managed_agent_delegations d
           join projects p on p.id=d.project_id and p.owner_user_id=d.owner_user_id
          where d.owner_user_id=$1 and d.request_id=$2
            and p.lifecycle='active' and p.deletion_phase is null`,
        [actor.userId, requestId]
      );
      const row = result.rows[0];
      return row
        ? {
            parentExecutionId: row.parent_execution_id,
            parentExecutionGeneration: row.parent_execution_generation,
            childExecutionId: row.child_execution_id,
            agentId: row.agent_id,
            projectId: row.project_id
          }
        : null;
    },
    async listManagedAgentDelegations(actor, projectId) {
      const result = await pool.query<{
        parent_execution_id: string | null;
        child_execution_id: string;
        agent_id: string;
        task_label: string;
        logical_session_id: string | null;
        state: string;
      }>(
        `select d.parent_execution_id,d.child_execution_id,d.agent_id,d.task_label,
                c.logical_session_id,c.state
           from managed_agent_delegations d
           join managed_conversation_executions c
             on c.id=d.child_execution_id and c.owner_user_id=d.owner_user_id
           join projects p on p.id=d.project_id and p.owner_user_id=d.owner_user_id
          where d.owner_user_id=$1 and d.project_id=$2
            and p.lifecycle='active' and p.deletion_phase is null
          order by d.created_at desc,d.id desc limit 100`,
        [actor.userId, projectId]
      );
      return result.rows.map((row) => ({
        parentExecutionId: row.parent_execution_id,
        childExecutionId: row.child_execution_id,
        agentId: row.agent_id,
        taskLabel: row.task_label,
        childSessionId: row.logical_session_id,
        childState: row.state
      }));
    },
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
      if (input.hqProjectId && !input.hqPrivatePath?.startsWith("/"))
        throw statusError("Project HQ private path is invalid", 400);
      if (
        input.textActionHumanOrigin &&
        (input.textActionHumanOrigin !== "hq_first_message" ||
          !input.hqProjectId ||
          !input.initialPrompt?.trim())
      )
        throw statusError("Koed text action origin is invalid", 400);
      if (
        input.agentDelegation &&
        (input.hqProjectId ||
          input.workItemDispatch ||
          !input.initialPrompt ||
          input.contextKind === "independent" ||
          input.agentDelegation.requestId !== input.idempotencyKey)
      )
        throw statusError("Agent delegation request is invalid", 400);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const textDispatch = input.workItemDispatch?.textActionId
          ? {
              id: input.workItemDispatch.textActionId,
              itemId: input.workItemDispatch.itemId,
              agentId: input.workItemDispatch.agentId,
              version: input.workItemDispatch.version,
              teamBackendId: null,
              workspaceProjectId: null,
              teamProjectVersion: null,
              teamMemberVersion: null
            }
          : input.sharedWorkItemDispatch?.textActionId
            ? {
                id: input.sharedWorkItemDispatch.textActionId,
                itemId: input.sharedWorkItemDispatch.teamWorkItemId,
                agentId: input.sharedWorkItemDispatch.agentId,
                version: input.sharedWorkItemDispatch.teamWorkItemVersion,
                teamBackendId: input.sharedWorkItemDispatch.teamBackendId,
                workspaceProjectId:
                  input.sharedWorkItemDispatch.workspaceProjectId,
                teamProjectVersion:
                  input.sharedWorkItemDispatch.expectedProjectVersion,
                teamMemberVersion:
                  input.sharedWorkItemDispatch.expectedMemberVersion
              }
            : null;
        if (textDispatch) {
          const bound = await client.query(
            `select 1 from managed_conversation_text_action_dispatch_authorities intent
               join managed_conversation_text_actions action
                 on action.id=intent.action_id and action.owner_user_id=intent.owner_user_id
               join managed_conversation_executions origin_execution
                 on origin_execution.id=action.execution_id
                and origin_execution.owner_user_id=action.owner_user_id
               join managed_conversation_commands origin_command
                 on origin_command.id=action.command_id
                and origin_command.owner_user_id=action.owner_user_id
                and origin_command.execution_id=action.execution_id
               join managed_conversation_text_human_origins origin
                 on origin.owner_user_id=origin_command.owner_user_id
                and origin.command_id=origin_command.id
                and origin.execution_id=origin_command.execution_id
                and origin.execution_generation=origin_command.execution_generation
                and origin.request_digest=origin_command.request_digest
               join managed_conversation_runtime_bindings origin_binding
                 on origin_binding.execution_id=origin_execution.id
                and origin_binding.owner_user_id=origin_execution.owner_user_id
               join sessions origin_session
                 on origin_session.id=origin_binding.local_session_id
                and origin_session.owner_user_id=origin_execution.owner_user_id
              where intent.action_id=$1 and intent.owner_user_id=$2
                and intent.project_id=$3 and intent.work_item_id=$4
                and intent.agent_id=$5 and intent.work_item_version=$6
                and intent.team_backend_id is not distinct from $7::text
                and intent.workspace_project_id is not distinct from $8::uuid
                and intent.team_project_version is not distinct from $9::int
                and intent.team_member_version is not distinct from $10::int
                and action.state='claimed' and action.action_name='koed_todo_send'
                and origin_execution.execution_generation=action.execution_generation
                and origin_execution.state in ('running','reconciling')
                and origin_command.execution_generation=action.execution_generation
                and ((origin_command.command_kind='start' and origin.source_kind='hq_first_message')
                  or (origin_command.command_kind='prompt' and origin.source_kind='human_prompt'
                    and origin_command.client_user_message_id is not null))
                and ((origin_command.state='completed' and origin_command.completed_at is not null)
                  or (origin_command.state='dispatching' and origin_command.lease_expires_at>now()
                    and origin_execution.runner_lease_expires_at>now()))
                and origin_session.invalidated_at is null
                and origin_session.personal_deleted_at is null
                and origin_session.trashed_at is null
                and origin_session.delete_batch_id is null
                and origin_session.forget_batch_id is null
              for share of intent,action,origin_execution,origin_session`,
            [
              textDispatch.id,
              actor.userId,
              projectId,
              textDispatch.itemId,
              textDispatch.agentId,
              textDispatch.version,
              textDispatch.teamBackendId,
              textDispatch.workspaceProjectId,
              textDispatch.teamProjectVersion,
              textDispatch.teamMemberVersion
            ]
          );
          if (bound.rowCount !== 1)
            throw statusError("Text action dispatch authority changed", 409);
        }
        // Lock the item before creating the command. The link and the start
        // command commit together, so a crash cannot leave an orphan launch.
        type DispatchItemRow = {
          id: string;
          version: number;
          status: string;
          execution_id: string | null;
          assignee_agent_id: string | null;
        };
        let dispatchItem: DispatchItemRow | null = null;
        let delegationRequestDigest: string | null = null;
        if (input.workItemDispatch) {
          const dispatch = input.workItemDispatch;
          const activeProject = await client.query(
            `select 1 from projects where id=$1 and owner_user_id=$2
               and lifecycle='active' and deletion_phase is null
               and team_backend_id is null and team_workspace_id is null
               and workspace_project_id is null for update`,
            [projectId, actor.userId]
          );
          if (!activeProject.rowCount)
            throw statusError("Project is unavailable", 409);
          const found = await client.query<DispatchItemRow>(
            `select id,version,status,execution_id,assignee_agent_id
               from project_work_items where id=$1 and owner_user_id=$2
               and project_id=$3 and deleted_at is null for update`,
            [dispatch.itemId, actor.userId, projectId]
          );
          dispatchItem = found.rows[0] ?? null;
          if (!dispatchItem) throw statusError("Work Item is unavailable", 404);
          await assertCurrentWorkItemSources(
            client,
            actor.userId,
            projectId,
            dispatch.sources ?? []
          );
          if (dispatchItem.execution_id) {
            if (textDispatch) {
              const priorEffect = await client.query<{ execution_id: string }>(
                `select execution_id from managed_conversation_text_action_dispatch_effects
                  where action_id=$1 and owner_user_id=$2 and project_id=$3
                    and work_item_id=$4 and agent_id=$5 and work_item_version=$6`,
                [
                  textDispatch.id,
                  actor.userId,
                  projectId,
                  textDispatch.itemId,
                  textDispatch.agentId,
                  textDispatch.version
                ]
              );
              if (
                priorEffect.rows[0]?.execution_id !== dispatchItem.execution_id
              )
                throw statusError(
                  "Another action dispatched this Work Item",
                  409
                );
            }
            if (
              dispatchItem.status === "blocked" &&
              dispatchItem.assignee_agent_id !== dispatch.agentId &&
              dispatchItem.version === dispatch.version
            ) {
              const old = await client.query<{ state: string }>(
                `select state from managed_conversation_executions
                 where id=$1 and owner_user_id=$2 for update`,
                [dispatchItem.execution_id, actor.userId]
              );
              if (
                !old.rows[0] ||
                !["stopped", "failed", "fenced"].includes(old.rows[0].state)
              )
                throw statusError(
                  "Previous Agent execution has not stopped",
                  409
                );
            } else if (
              dispatchItem.assignee_agent_id !== dispatch.agentId ||
              !["doing", "review"].includes(dispatchItem.status)
            ) {
              throw statusError("Work Item dispatch needs reconciliation", 409);
            } else {
              const execution = await client.query<ExecutionRow>(
                `select ${EXECUTION_COLUMNS} from managed_conversation_executions
               where id=$1 and owner_user_id=$2`,
                [dispatchItem.execution_id, actor.userId]
              );
              const command = await client.query<CommandRow>(
                `select ${COMMAND_COLUMNS} from managed_conversation_commands
               where execution_id=$1 and owner_user_id=$2 and command_kind='start'
               order by sequence asc limit 1`,
                [dispatchItem.execution_id, actor.userId]
              );
              if (!execution.rows[0] || !command.rows[0])
                throw statusError("Work Item execution is inconsistent", 409);
              await client.query("commit");
              return {
                execution: mapExecution(execution.rows[0]),
                command: mapCommand(
                  command.rows[0],
                  await decryptPayload(command.rows[0])
                ),
                fencingToken: ""
              };
            }
          }
          if (
            !["todo", "blocked"].includes(dispatchItem.status) ||
            dispatchItem.version !== dispatch.version
          )
            throw statusError("Work Item version changed", 409);
          const agent = await client.query(
            `select 1 from agents a join ai_client_instances i
               on i.owner_user_id=a.owner_user_id and i.instance_id=a.ai_client_instance_id
             where a.id=$1 and a.owner_user_id=$2 and a.ai_client_instance_id=$3
               and i.driver_id=$4 and i.enabled=true for share of a,i`,
            [
              dispatch.agentId,
              actor.userId,
              input.aiClientInstanceId,
              input.provider
            ]
          );
          if (!agent.rowCount) throw statusError("Agent is unavailable", 409);
        }
        if (input.sharedWorkItemDispatch) {
          const dispatch = input.sharedWorkItemDispatch;
          const link = await client.query(
            `select 1 from projects project
                join personal_workspace_project_principal_bindings binding
                  on binding.local_user_id=project.owner_user_id
                 and binding.team_backend_id=project.team_backend_id
               where project.id=$1 and project.owner_user_id=$2
                 and project.lifecycle='active' and project.deletion_phase is null
                 and project.team_backend_id=$3 and project.workspace_project_id=$4
                 and binding.team_principal_user_id=$5
                 and not exists (
                   select 1 from personal_workspace_project_share_attempts attempt
                    where attempt.personal_project_id=project.id and attempt.state='pending'
                 )
               for share of project`,
            [
              projectId,
              actor.userId,
              dispatch.teamBackendId,
              dispatch.workspaceProjectId,
              dispatch.teamPrincipalUserId
            ]
          );
          if (!link.rowCount)
            throw statusError("Shared Project dispatch link changed", 409);
          const agent = await client.query(
            `select 1 from agents agent
                join ai_client_instances instance
                  on instance.owner_user_id=agent.owner_user_id
                 and instance.instance_id=agent.ai_client_instance_id
               where agent.id=$1 and agent.owner_user_id=$2
                 and instance.instance_id=$3 and instance.driver_id=$4
                 and instance.enabled=true
               for share of agent,instance`,
            [
              dispatch.agentId,
              actor.userId,
              input.aiClientInstanceId,
              input.provider
            ]
          );
          if (!agent.rowCount) throw statusError("Agent is unavailable", 409);
        }
        if (input.agentDelegation) {
          const delegation = input.agentDelegation;
          if (
            (delegation.parentExecutionId === null) !==
            (delegation.parentExecutionGeneration === null)
          )
            throw statusError(
              "Agent delegation parent identity is invalid",
              400
            );
          let parent: ExecutionRow | null = null;
          if (delegation.parentExecutionId === null) {
            const hq = await client.query<{
              managed_execution_id: string | null;
            }>(
              `select h.managed_execution_id from project_hq_conversations h
                 join projects p on p.id=h.project_id and p.owner_user_id=h.owner_user_id
                where h.project_id=$1 and h.owner_user_id=$2
                  and p.lifecycle='active' and p.deletion_phase is null
                for update of h,p`,
              [projectId, actor.userId]
            );
            if (!hq.rows[0])
              throw statusError("Project HQ is unavailable", 404);
            // A prior cold request remains recoverable after Chief starts.
            if (hq.rows[0].managed_execution_id) {
              const priorCold = await client.query(
                `select 1 from managed_agent_delegations where owner_user_id=$1
                   and project_id=$2 and request_id=$3 and parent_execution_id is null`,
                [actor.userId, projectId, delegation.requestId]
              );
              if (!priorCold.rowCount)
                throw statusError(
                  "Project HQ has started; refresh the Conversation",
                  409
                );
            }
          } else {
            // The lifecycle path locks Project/Session before execution. Read a
            // selector without a lock, acquire those parents in that order,
            // then lock and revalidate the execution so we cannot deadlock a
            // concurrent chat move, forget, or Project deletion.
            const selector = await client.query<{
              logical_session_id: string | null;
              provider_thread_id: string | null;
            }>(
              `select logical_session_id,provider_thread_id
                 from managed_conversation_executions
                where id=$1 and owner_user_id=$2 and project_id=$3
                  and runner_deployment_id=$4 and runner_device_id=$5`,
              [
                delegation.parentExecutionId,
                actor.userId,
                projectId,
                input.runnerDeploymentId,
                input.runnerDeviceId
              ]
            );
            if (
              !selector.rows[0]?.logical_session_id ||
              !selector.rows[0].provider_thread_id
            )
              throw statusError(
                "Parent private Conversation is not captured",
                409
              );
            const projectLock = await client.query(
              `select 1 from projects where id=$1 and owner_user_id=$2
                 and lifecycle='active' and deletion_phase is null for share`,
              [projectId, actor.userId]
            );
            if (!projectLock.rowCount)
              throw statusError("Parent Project is unavailable", 409);
            const sessions = await client.query<{
              visibility: string;
              trashed_at: Date | null;
              personal_deleted_at: Date | null;
              delete_batch_id: string | null;
              forget_batch_id: string | null;
            }>(
              `select visibility,trashed_at,personal_deleted_at,delete_batch_id,forget_batch_id
                 from sessions where owner_user_id=$1 and logical_session_id=$2
                order by id for share`,
              [actor.userId, selector.rows[0].logical_session_id]
            );
            if (
              !sessions.rows.some(
                (row) =>
                  row.visibility === "personal" &&
                  !row.trashed_at &&
                  !row.personal_deleted_at &&
                  !row.delete_batch_id &&
                  !row.forget_batch_id
              )
            )
              throw statusError(
                "Parent private Conversation is unavailable",
                409
              );
            const foundParent = await client.query<ExecutionRow>(
              `select ${EXECUTION_COLUMNS} from managed_conversation_executions
              where id=$1 and owner_user_id=$2 and project_id=$3
                and runner_deployment_id=$4 and runner_device_id=$5
              for update`,
              [
                delegation.parentExecutionId,
                actor.userId,
                projectId,
                input.runnerDeploymentId,
                input.runnerDeviceId
              ]
            );
            parent = foundParent.rows[0] ?? null;
            if (!parent)
              throw statusError("Parent Conversation is unavailable", 404);
            if (
              parent.logical_session_id !==
                selector.rows[0].logical_session_id ||
              parent.provider_thread_id !== selector.rows[0].provider_thread_id
            )
              throw statusError("Parent Conversation identity changed", 409);
            await assertExecutionProjectWritable(client, parent);
            await assertExecutionChatWritable(client, parent);
            if (!parent.logical_session_id || !parent.provider_thread_id)
              throw statusError(
                "Parent private Conversation is not captured",
                409
              );
          }
          const prior = await client.query<{
            request_digest: string;
            child_execution_id: string;
          }>(
            `select request_digest,child_execution_id from managed_agent_delegations
              where owner_user_id=$1 and request_id=$2`,
            [actor.userId, delegation.requestId]
          );
          const digest = sha256(
            JSON.stringify({
              parentExecutionId: delegation.parentExecutionId,
              parentExecutionGeneration: delegation.parentExecutionGeneration,
              agentId: delegation.agentId,
              projectId,
              prompt: input.initialPrompt,
              provider: input.provider,
              aiClientInstanceId: input.aiClientInstanceId,
              model: input.model,
              reasoningEffort: input.reasoningEffort ?? null,
              permissionMode: input.permissionMode,
              runnerDeploymentId: input.runnerDeploymentId,
              runnerDeviceId: input.runnerDeviceId
            })
          );
          delegationRequestDigest = digest;
          if (prior.rows[0]) {
            if (prior.rows[0].request_digest !== digest)
              throw statusError("Agent delegation request changed", 409);
          } else {
            if (
              parent &&
              (parent.execution_generation !==
                delegation.parentExecutionGeneration ||
                !["running", "quiesced"].includes(parent.state))
            )
              throw statusError("Parent Conversation generation changed", 409);
            const agent = await client.query(
              `select 1 from agents a join ai_client_instances i
                 on i.owner_user_id=a.owner_user_id and i.instance_id=a.ai_client_instance_id
               where a.id=$1 and a.owner_user_id=$2 and not a.is_chief_of_staff
                 and a.ai_client_instance_id=$3 and a.default_permission_mode=$4
                 and (a.default_model is null or a.default_model=$5)
                 and i.driver_id=$6 and i.enabled=true for share of a,i`,
              [
                delegation.agentId,
                actor.userId,
                input.aiClientInstanceId,
                input.permissionMode,
                input.model,
                input.provider
              ]
            );
            if (!agent.rowCount)
              throw statusError("Helper Agent is unavailable", 409);
          }
        }
        if (input.hqProjectId) {
          if (projectId !== input.hqProjectId)
            throw statusError("HQ Project identity mismatch", 400);
          const hq = await client.query<{
            managed_execution_id: string | null;
          }>(
            `select h.managed_execution_id from project_hq_conversations h
              join projects p on p.id=h.project_id and p.owner_user_id=h.owner_user_id
             where h.project_id=$1 and h.owner_user_id=$2
               and p.lifecycle='active' and p.deletion_phase is null
             for update of h, p`,
            [input.hqProjectId, actor.userId]
          );
          if (!hq.rows[0]) throw statusError("Project HQ is unavailable", 404);
          if (hq.rows[0].managed_execution_id) {
            const execution = await client.query<ExecutionRow>(
              `select ${EXECUTION_COLUMNS} from managed_conversation_executions
                where id=$1 and owner_user_id=$2 and is_project_hq
                  and hq_private_path=$3`,
              [
                hq.rows[0].managed_execution_id,
                actor.userId,
                input.hqPrivatePath
              ]
            );
            const command = await client.query<CommandRow>(
              `select ${COMMAND_COLUMNS} from managed_conversation_commands
                where execution_id=$1 and owner_user_id=$2 and command_kind='start'
                order by sequence asc limit 1`,
              [hq.rows[0].managed_execution_id, actor.userId]
            );
            if (!execution.rows[0] || !command.rows[0])
              throw statusError("Project HQ execution is inconsistent", 409);
            if (execution.rows[0].permission_mode !== input.permissionMode)
              throw statusError(
                "Project HQ already started with another permission choice",
                409
              );
            const originalStart = await decryptPayload(command.rows[0]);
            if (
              input.initialPrompt &&
              originalStart?.prompt !== input.initialPrompt
            )
              throw statusError(
                "Project HQ already started with another first message",
                409
              );
            if (
              (originalStart?.selectedDocumentSourceId ?? null) !==
              (input.selectedDocumentSourceId ?? null)
            )
              throw statusError(
                "Project HQ already started with another document",
                409
              );
            await client.query("commit");
            return {
              execution: mapExecution(execution.rows[0]),
              command: mapCommand(command.rows[0], originalStart),
              fencingToken: ""
            };
          }
        }
        const projectAvailability = await client.query<{
          lifecycle: string;
          deletion_phase: string | null;
        }>(
          `select p.lifecycle,p.deletion_phase from projects p
             left join project_local_contexts c on c.project_id=p.id and c.owner_user_id=p.owner_user_id
              and c.device_id=$2 and c.local_project_id=$3 and c.association_state='resolved'
            where p.owner_user_id=$1 and (p.id::text=$3 or c.local_project_id=$3)
            for share of p`,
          [actor.userId, input.runnerDeviceId, projectId]
        );
        if (
          projectAvailability.rows.some(
            (row) => row.lifecycle !== "active" || row.deletion_phase !== null
          )
        )
          throw statusError(
            "Project is unavailable for managed execution",
            409
          );
        const existing = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS}
             from managed_conversation_commands
            where owner_user_id = $1 and idempotency_key = $2
            limit 1`,
          [actor.userId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (input.workItemDispatch)
            throw statusError("Work Item start key is already in use", 409);
          if (input.sharedWorkItemDispatch) {
            const original = await decryptPayload(existing.rows[0]);
            if (
              JSON.stringify(original?.sharedWorkItemDispatch) !==
              JSON.stringify(input.sharedWorkItemDispatch)
            )
              throw statusError("Shared Work Item dispatch key changed", 409);
          }
          if (input.agentDelegation) {
            const linked = await client.query<{
              child_execution_id: string;
              request_digest: string;
            }>(
              `select child_execution_id,request_digest from managed_agent_delegations
                 where owner_user_id=$1 and request_id=$2`,
              [actor.userId, input.idempotencyKey]
            );
            if (
              linked.rows[0]?.child_execution_id !==
                existing.rows[0].execution_id ||
              linked.rows[0]?.request_digest !== delegationRequestDigest
            )
              throw statusError("Agent delegation request changed", 409);
          }
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
            contextKind: input.contextKind,
            provider: input.provider,
            aiClientInstanceId: input.aiClientInstanceId,
            model: input.model,
            reasoningEffort: input.reasoningEffort ?? null,
            permissionMode: input.permissionMode,
            runnerKind: input.runnerKind,
            runnerDeploymentId: input.runnerDeploymentId,
            runnerDeviceId: input.runnerDeviceId,
            initialPrompt: input.initialPrompt,
            selectedDocumentSourceId: input.selectedDocumentSourceId,
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
          contextKind: input.contextKind,
          provider: input.provider,
          aiClientInstanceId: input.aiClientInstanceId,
          model: input.model,
          reasoningEffort: input.reasoningEffort ?? null,
          permissionMode: input.permissionMode,
          runnerKind: input.runnerKind,
          runnerDeploymentId: input.runnerDeploymentId,
          runnerDeviceId: input.runnerDeviceId,
          initialPrompt: input.initialPrompt,
          selectedDocumentSourceId: input.selectedDocumentSourceId,
          deferUntilRuntimeBinding: input.deferUntilRuntimeBinding
        });
        const executionResult = await client.query<ExecutionRow>(
          `insert into managed_conversation_executions (
             id, owner_user_id, project_id, is_project_hq, hq_private_path, provider, ai_client_instance_id,
             model, reasoning_effort, permission_mode, runner_kind,
             fencing_token_hash, runner_deployment_id, runner_device_id
           ) values ($1, $2, $3, $13, $14, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
            input.runnerDeviceId,
            Boolean(input.hqProjectId),
            input.hqPrivatePath ?? null
          ]
        );
        // The selected Personal Project is trusted before any source write.
        // Snapshot only this new non-HQ execution; resuming it cannot mint a
        // policy capture proof after the fact.
        if (!input.hqProjectId)
          await client.query(
            `update managed_conversation_executions execution
              set share_policy_capture_version=project.project_share_policy_version,
                  share_policy_capture_workspace_project_id=project.workspace_project_id,
                  share_policy_capture_device_credential_id=project.project_share_policy_device_credential_id,
                  share_policy_capture_link_epoch=project.share_policy_link_epoch,
                  share_policy_capture_prepared_at=execution.created_at
             from projects project
            where execution.id=$1 and execution.owner_user_id=$2
              and execution.project_id=project.id::text
              and project.owner_user_id=$2 and project.lifecycle='active'
              and project.deletion_phase is null
              and project.project_share_policy_version is not null
              and project.project_share_policy_device_credential_id is not null
              and project.team_backend_id is not null
              and project.workspace_project_id is not null
              and execution.share_policy_capture_version is null`,
            [executionId, actor.userId]
          );
        const encryptedPayload = input.initialPrompt
          ? await encryptPrompt({
              ownerUserId: actor.userId,
              executionId,
              commandId,
              prompt: input.initialPrompt,
              selectedDocumentSourceId: input.selectedDocumentSourceId,
              ...(input.workItemDispatch
                ? { workItemSourceProof: input.workItemDispatch.sources ?? [] }
                : {}),
              ...(input.sharedWorkItemDispatch
                ? { sharedWorkItemDispatch: input.sharedWorkItemDispatch }
                : {}),
              settings: {
                model: input.model,
                reasoningEffort: input.reasoningEffort ?? null,
                permissionMode: input.permissionMode
              }
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
        if (input.textActionHumanOrigin) {
          await client.query(
            `insert into managed_conversation_text_human_origins
              (owner_user_id,command_id,execution_id,execution_generation,
               request_digest,source_kind)
             values($1,$2,$3,1,$4,'hq_first_message')`,
            [actor.userId, commandId, executionId, requestDigest]
          );
        }
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId,
          mutationId: `managed-conversation:${executionId}:created`
        });
        if (input.hqProjectId) {
          const bound = await client.query(
            `update project_hq_conversations set managed_execution_id=$3
              where project_id=$1 and owner_user_id=$2
                and managed_execution_id is null`,
            [input.hqProjectId, actor.userId, executionId]
          );
          if (bound.rowCount !== 1)
            throw statusError("Project HQ was started concurrently", 409);
        }
        if (input.workItemDispatch && dispatchItem) {
          const dispatch = input.workItemDispatch;
          const changed = await client.query(
            `update project_work_items set status='doing', assignee_agent_id=$4,
               execution_id=$5, dispatch_key=$6, blocked_reason=null,
               version=version+1, updated_at=now()
             where id=$1 and owner_user_id=$2 and version=$3 and status in ('todo','blocked')
               and deleted_at is null`,
            [
              dispatch.itemId,
              actor.userId,
              dispatch.version,
              dispatch.agentId,
              executionId,
              `${dispatch.itemId}:${dispatch.version}`
            ]
          );
          if (changed.rowCount !== 1)
            throw statusError("Work Item version changed", 409);
          if (textDispatch)
            await client.query(
              `insert into managed_conversation_text_action_dispatch_effects
               (action_id,owner_user_id,project_id,work_item_id,agent_id,
                work_item_version,execution_id,command_id)
             values($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                textDispatch.id,
                actor.userId,
                projectId,
                textDispatch.itemId,
                textDispatch.agentId,
                textDispatch.version,
                executionId,
                commandId
              ]
            );
          await appendProjectActivityWithClient(client, {
            ownerUserId: actor.userId,
            projectId,
            actorUserId: actor.userId,
            kind: "work_item_status",
            ref: `${dispatch.itemId}:${dispatch.version + 1}`
          });
          await appendCollaborationOutboxEventWithClient(client, {
            family: "work_item_changed",
            scope: "personal",
            personalOwnerUserId: actor.userId,
            teamId: null,
            teamWorkspaceId: null,
            threadId: null,
            messageId: null,
            shareGrantId: null,
            logicalMemoryId: null,
            resourceType: "project_work_item",
            resourceId: dispatch.itemId,
            actorPrincipalId: actor.userId,
            mutationId: randomUUID()
          });
        }
        if (input.sharedWorkItemDispatch && textDispatch)
          await client.query(
            `insert into managed_conversation_text_action_dispatch_effects
               (action_id,owner_user_id,project_id,work_item_id,agent_id,
                work_item_version,execution_id,command_id)
             values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              textDispatch.id,
              actor.userId,
              projectId,
              textDispatch.itemId,
              textDispatch.agentId,
              textDispatch.version,
              executionId,
              commandId
            ]
          );
        if (input.agentDelegation && delegationRequestDigest) {
          await client.query(
            `insert into managed_agent_delegations
               (owner_user_id,project_id,parent_execution_id,parent_execution_generation,
                cold_hq_project_id,child_execution_id,agent_id,task_label,request_id,request_digest)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              actor.userId,
              projectId,
              input.agentDelegation.parentExecutionId,
              input.agentDelegation.parentExecutionGeneration,
              input.agentDelegation.parentExecutionId === null
                ? projectId
                : null,
              executionId,
              input.agentDelegation.agentId,
              input.initialPrompt!.trim().replace(/\s+/g, " ").slice(0, 200),
              input.agentDelegation.requestId,
              delegationRequestDigest
            ]
          );
        }
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

    async retryWorkItemConversation(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const project = await client.query(
          `select 1 from projects where id=$1 and owner_user_id=$2
             and lifecycle='active' and deletion_phase is null
             and team_backend_id is null and team_workspace_id is null
             and workspace_project_id is null for update`,
          [input.projectId, actor.userId]
        );
        if (!project.rowCount) throw statusError("Project is unavailable", 409);
        const item = await client.query<{
          version: number;
          status: string;
          execution_id: string | null;
          assignee_agent_id: string | null;
        }>(
          `select version,status,execution_id,assignee_agent_id
             from project_work_items where id=$1 and owner_user_id=$2
               and project_id=$3 and deleted_at is null for update`,
          [input.itemId, actor.userId, input.projectId]
        );
        const current = item.rows[0];
        if (!current) throw statusError("Work Item is unavailable", 404);
        const availableAgent = await client.query(
          `select 1 from agents agent
             join ai_client_instances instance
               on instance.owner_user_id=agent.owner_user_id
              and instance.instance_id=agent.ai_client_instance_id
             join managed_conversation_executions execution
               on execution.id=$3 and execution.owner_user_id=agent.owner_user_id
           where agent.id=$1 and agent.owner_user_id=$2
             and agent.ai_client_instance_id=execution.ai_client_instance_id
             and instance.driver_id=execution.provider and instance.enabled=true
           for share of agent,instance`,
          [input.agentId, actor.userId, current.execution_id]
        );
        if (!availableAgent.rowCount)
          throw statusError("Agent or AI Client is unavailable", 409);
        const retryKey = `work-item-retry:${input.itemId}:${input.expectedVersion}`;
        if (
          current.status === "doing" &&
          current.version === input.expectedVersion + 1 &&
          current.assignee_agent_id === input.agentId &&
          current.execution_id
        ) {
          const prior = await client.query<CommandRow>(
            `select ${COMMAND_COLUMNS} from managed_conversation_commands
             where owner_user_id=$1 and idempotency_key=$2`,
            [actor.userId, retryKey]
          );
          if (prior.rows[0]?.execution_id === current.execution_id) {
            const execution = await client.query<ExecutionRow>(
              `select ${EXECUTION_COLUMNS} from managed_conversation_executions
               where id=$1 and owner_user_id=$2`,
              [current.execution_id, actor.userId]
            );
            if (execution.rows[0]) {
              await client.query("commit");
              return {
                execution: mapExecution(execution.rows[0]),
                command: mapCommand(
                  prior.rows[0],
                  await decryptPayload(prior.rows[0])
                )
              };
            }
          }
        }
        if (
          current.status !== "blocked" ||
          current.version !== input.expectedVersion ||
          current.assignee_agent_id !== input.agentId ||
          !current.execution_id
        )
          throw statusError("Work Item Retry binding changed", 409);
        const executionResult = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS} from managed_conversation_executions
           where id=$1 and owner_user_id=$2 and project_id=$3 for update`,
          [current.execution_id, actor.userId, input.projectId]
        );
        const execution = executionResult.rows[0];
        if (
          !execution ||
          !["failed", "stopped", "fenced"].includes(execution.state)
        )
          throw statusError("Previous Agent execution has not stopped", 409);
        await assertExecutionChatWritable(client, execution);
        const binding = await client.query<RuntimeBindingRow>(
          `select ${RUNTIME_BINDING_COLUMNS} from managed_conversation_runtime_bindings
           where execution_id=$1 and owner_user_id=$2 for update`,
          [execution.id, actor.userId]
        );
        if (
          !binding.rows[0] ||
          binding.rows[0].deployment_id !== execution.runner_deployment_id ||
          binding.rows[0].device_id !== execution.runner_device_id ||
          binding.rows[0].execution_generation !==
            execution.execution_generation
        )
          throw statusError(
            "Managed Conversation runtime binding changed",
            409
          );
        const hasSession = Boolean(
          execution.logical_session_id && execution.provider_thread_id
        );
        if (
          Boolean(execution.logical_session_id) !==
          Boolean(execution.provider_thread_id)
        )
          throw statusError(
            "Managed Conversation identity needs reconciliation",
            409
          );
        const original = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS} from managed_conversation_commands
           where execution_id=$1 and owner_user_id=$2 and command_kind='start'
           order by sequence asc limit 1`,
          [execution.id, actor.userId]
        );
        if (!original.rows[0])
          throw statusError("Managed Conversation start is missing", 409);
        if (!hasSession && original.rows[0].state === "indeterminate")
          throw statusError(
            "Original start needs read-only reconciliation",
            409
          );
        const initial = await decryptPayload(original.rows[0]);
        if (!hasSession) {
          const proof = initial?.workItemSourceProof;
          if (
            !Array.isArray(proof) ||
            proof.some(
              (source: unknown) =>
                !source ||
                typeof source !== "object" ||
                Array.isArray(source) ||
                !("id" in source) ||
                typeof source.id !== "string" ||
                !("currentRevisionId" in source) ||
                (source.currentRevisionId !== null &&
                  typeof source.currentRevisionId !== "string")
            )
          )
            throw statusError(
              "Original Work Item Source proof is unavailable",
              409
            );
          await assertCurrentWorkItemSources(
            client,
            actor.userId,
            input.projectId,
            proof as Array<{ id: string; currentRevisionId: string | null }>
          );
        }
        const prompt = hasSession
          ? "Retry this Work Item in the same Conversation. Continue from the prior work and report progress."
          : typeof initial?.prompt === "string"
            ? initial.prompt
            : null;
        if (!prompt)
          throw statusError("Original Work Item brief is unavailable", 409);
        const commandId = randomUUID();
        const sequenceResult = await client.query<{ sequence: number }>(
          `select coalesce(max(sequence),-1)+1 as sequence from managed_conversation_commands
           where execution_id=$1`,
          [execution.id]
        );
        const generation = execution.execution_generation + 1;
        const clientUserMessageId = hasSession ? randomUUID() : null;
        const encryptedPayload = await encryptPrompt({
          ownerUserId: actor.userId,
          executionId: execution.id,
          commandId,
          prompt,
          ...(!hasSession
            ? {
                workItemSourceProof: initial!.workItemSourceProof as Array<{
                  id: string;
                  currentRevisionId: string | null;
                }>
              }
            : {}),
          settings: {
            model: execution.model,
            reasoningEffort: execution.reasoning_effort,
            permissionMode: execution.permission_mode
          }
        });
        const commandKind = hasSession ? "prompt" : "start";
        const requestDigest = sha256(
          JSON.stringify({
            kind: commandKind,
            executionId: execution.id,
            generation,
            prompt,
            clientUserMessageId
          })
        );
        const changedExecution = await client.query<ExecutionRow>(
          `update managed_conversation_executions set
             execution_generation=$3,state=$4,state_version=state_version+1,
             fencing_token_hash=$5,runner_id=null,runner_lease_expires_at=null,
             last_error_code=null,stopped_at=null,updated_at=now()
           where id=$1 and owner_user_id=$2 returning ${EXECUTION_COLUMNS}`,
          [
            execution.id,
            actor.userId,
            generation,
            hasSession ? "running" : "starting",
            sha256(randomBytes(32).toString("base64url"))
          ]
        );
        await client.query(
          `update managed_conversation_runtime_bindings set execution_generation=$3,
             start_authority_acknowledged_at=null,updated_at=now()
           where execution_id=$1 and owner_user_id=$2`,
          [execution.id, actor.userId, generation]
        );
        const command = await client.query<CommandRow>(
          `insert into managed_conversation_commands
           (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
            request_digest,client_user_message_id,execution_generation,encrypted_payload,state)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'queued')
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            execution.id,
            retryKey,
            sequenceResult.rows[0]!.sequence,
            commandKind,
            requestDigest,
            clientUserMessageId,
            generation,
            encryptedPayload
          ]
        );
        await client.query(
          `update project_work_items set status='doing',blocked_reason=null,
             dispatch_key=$4,version=version+1,updated_at=now()
           where id=$1 and owner_user_id=$2 and version=$3`,
          [
            input.itemId,
            actor.userId,
            input.expectedVersion,
            `${input.itemId}:${input.expectedVersion}`
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: execution.id,
          mutationId: `managed-conversation-command:${commandId}:queued`
        });
        await appendCollaborationOutboxEventWithClient(client, {
          family: "work_item_changed",
          scope: "personal",
          personalOwnerUserId: actor.userId,
          teamId: null,
          teamWorkspaceId: null,
          threadId: null,
          messageId: null,
          shareGrantId: null,
          logicalMemoryId: null,
          resourceType: "project_work_item",
          resourceId: input.itemId,
          actorPrincipalId: actor.userId,
          mutationId: randomUUID()
        });
        await notifyManagedConversationCommand(client, execution.id);
        await client.query("commit");
        return {
          execution: mapExecution(changedExecution.rows[0]!),
          command: mapCommand(command.rows[0]!, { prompt })
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async enqueueManagedConversationPrompt(actor, input) {
      if (input.scheduledDispatch && input.textActionHumanOrigin)
        throw statusError(
          "Scheduled dispatch cannot claim human text authority",
          400
        );
      if (
        input.textActionHumanOrigin &&
        input.textActionHumanOrigin !== "human_prompt"
      )
        throw statusError("Koed text action origin is invalid", 400);
      const prompt = input.prompt.trim();
      const settingsChange = input.settingsChange
        ? {
            expected: parseManagedConversationSettings(
              input.settingsChange.expected
            ),
            next: parseManagedConversationSettings(input.settingsChange.next)
          }
        : undefined;
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
        // A scheduled attempt takes Project/Conversation/Job locks before the
        // Managed execution lock. Its start event and command binding commit
        // with the queued command, so no runner can see a partial dispatch.
        if (input.scheduledDispatch)
          await input.scheduledDispatch.start(client);
        const execution = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS}
             from managed_conversation_executions
            where owner_user_id = $1 and id = $2
            for update${input.scheduledDispatch ? " nowait" : ""}`,
          [actor.userId, input.executionId]
        );
        const current = execution.rows[0];
        if (current) await assertExecutionProjectWritable(client, current);
        if (current) await assertExecutionChatWritable(client, current);
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
            ...(input.selectedDocumentSourceId
              ? { selectedDocumentSourceId: input.selectedDocumentSourceId }
              : {}),
            fileMentionCommandIds,
            ...(settingsChange ? { settingsChange } : {})
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
        const currentSettings: ManagedConversationSettings = {
          model: current.model,
          reasoningEffort: current.reasoning_effort,
          permissionMode: current.permission_mode
        };
        const settings = settingsChange?.next ?? currentSettings;
        if (settingsChange) {
          if (
            managedConversationSettingsKey(currentSettings) !==
            managedConversationSettingsKey(settingsChange.expected)
          ) {
            throw statusError(
              "Conversation settings changed. Refresh before sending.",
              409
            );
          }
          const activeCommands = await client.query(
            `select id from managed_conversation_commands
              where execution_id = $1 and execution_generation = $2
                and state not in ('completed', 'failed', 'canceled')
              limit 1`,
            [input.executionId, input.executionGeneration]
          );
          if (current.state !== "running" || activeCommands.rows.length) {
            throw statusError(
              "Finish the current operation before changing Conversation settings.",
              409
            );
          }
          const updated = await client.query<ExecutionRow>(
            `update managed_conversation_executions
                set model = $3, reasoning_effort = $4, permission_mode = $5,
                    state_version = state_version + 1, updated_at = now()
              where owner_user_id = $1 and id = $2
              returning ${EXECUTION_COLUMNS}`,
            [
              actor.userId,
              input.executionId,
              settings.model,
              settings.reasoningEffort,
              settings.permissionMode
            ]
          );
          await appendManagedConversationEvent(client, {
            ownerUserId: actor.userId,
            executionId: input.executionId,
            mutationId: `managed-conversation:${input.executionId}:state:${updated.rows[0]!.state_version}`
          });
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
          selectedDocumentSourceId: input.selectedDocumentSourceId,
          fileMentions,
          settings
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
        if (input.scheduledDispatch)
          await input.scheduledDispatch.bind(client, commandId);
        if (input.textActionHumanOrigin) {
          await client.query(
            `insert into managed_conversation_text_human_origins
              (owner_user_id,command_id,execution_id,execution_generation,
               request_digest,source_kind)
             values($1,$2,$3,$4,$5,'human_prompt')`,
            [
              actor.userId,
              commandId,
              input.executionId,
              input.executionGeneration,
              requestDigest
            ]
          );
        }
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapCommand(result.rows[0]!, {
          prompt,
          settings,
          ...(fileMentions.length > 0 ? { fileMentions } : {})
        });
      } catch (error) {
        await client.query("rollback");
        if (
          input.scheduledDispatch &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "55P03"
        )
          throw new ScheduledJobConflict("Managed Conversation is busy");
        throw error;
      } finally {
        client.release();
      }
    },

    async inspectProjectHqCatchUp(actor, input) {
      const latest = await pool.query<CommandRow>(
        `select command.*
           from managed_conversation_commands command
           join managed_conversation_executions execution
             on execution.id=command.execution_id
            and execution.owner_user_id=command.owner_user_id
          where execution.id=$1 and execution.owner_user_id=$2
            and execution.project_id=$3 and execution.is_project_hq
            and command.command_kind='hq_catch_up'
          order by command.sequence desc, command.created_at desc
          limit 1`,
        [input.executionId, actor.userId, input.projectId]
      );
      const row = latest.rows[0];
      if (!row) return { disposition: "none", command: null };
      const command = mapCommand(row);
      const disposition: ProjectHqCatchUpDisposition =
        row.state === "completed" && row.result?.assistantPersisted === true
          ? "completed"
          : ["queued", "blocked", "dispatching"].includes(row.state)
            ? "active"
            : row.state === "failed" && row.result?.phase !== "send_started"
              ? "proven_no_send"
              : "needs_reconciliation";
      return { disposition, command };
    },

    async pendingProjectHqTeamAck(actor, input) {
      const rows = await pool.query<CommandRow>(
        `select command.* from managed_conversation_commands command
           join managed_conversation_executions execution
             on execution.id=command.execution_id
            and execution.owner_user_id=command.owner_user_id
          where execution.id=$1 and execution.owner_user_id=$2
            and execution.project_id=$3 and execution.is_project_hq
            and command.command_kind='hq_catch_up'
            and command.state='completed'
            and command.result->>'assistantPersisted'='true'
            and command.result ? 'teamWindow'
            and not (command.result ? 'teamAckedAt')
          order by command.sequence asc limit 1`,
        [input.executionId, actor.userId, input.projectId]
      );
      const command = rows.rows[0];
      if (!command) return null;
      const window = command.result?.teamWindow;
      const assistantId = command.result?.assistantMessageId;
      if (
        !isProjectHqTeamCatchUpWindow(window) ||
        typeof assistantId !== "string"
      )
        throw statusError("Project HQ Team receipt is invalid", 409);
      const retained = await pool.query(
        `select 1 from messages message
           join sessions session on session.id=message.session_id
           join managed_conversation_executions execution
             on execution.logical_session_id=session.logical_session_id
            and execution.owner_user_id=message.owner_user_id
          where message.id=$1 and message.owner_user_id=$2
            and execution.id=$3 and execution.project_id=$4
            and message.role='assistant' and message.visibility='personal'
            and message.invalidated_at is null limit 1`,
        [assistantId, actor.userId, input.executionId, input.projectId]
      );
      if (!retained.rowCount)
        throw statusError("Project HQ Team reply is no longer retained", 409);
      return { commandId: command.id, teamWindow: window };
    },

    async markProjectHqTeamAck(actor, input) {
      const updated = await pool.query(
        `update managed_conversation_commands command
            set result=command.result || jsonb_build_object(
                  'teamAckedAt', to_char(now() at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                updated_at=now()
          where command.id=$1 and command.owner_user_id=$2
            and command.execution_id=$3 and command.state='completed'
            and command.command_kind='hq_catch_up'
            and command.result->>'assistantPersisted'='true'
            and command.result->'teamWindow'=$5::jsonb
            and exists (
              select 1 from managed_conversation_executions execution
               where execution.id=command.execution_id
                 and execution.owner_user_id=command.owner_user_id
                 and execution.project_id=$4 and execution.is_project_hq
            )`,
        [
          input.commandId,
          actor.userId,
          input.executionId,
          input.projectId,
          JSON.stringify(input.teamWindow)
        ]
      );
      return updated.rowCount === 1;
    },

    async getProjectHqCatchUpRetry(actor, input) {
      const key = `project-hq-catch-up-retry:${input.failedCommandId}:${input.retryRequestId}`;
      const found = await pool.query<CommandRow>(
        `select command.* from managed_conversation_commands command
           join managed_conversation_executions execution
             on execution.id=command.execution_id
            and execution.owner_user_id=command.owner_user_id
          where execution.id=$1 and execution.owner_user_id=$2
            and execution.project_id=$3 and execution.is_project_hq
            and command.idempotency_key=$4
            and command.command_kind='hq_catch_up' limit 1`,
        [input.executionId, actor.userId, input.projectId, key]
      );
      return found.rows[0] ? mapCommand(found.rows[0]) : null;
    },

    async enqueueManagedConversationCatchUp(actor, input) {
      const { seenSequence, highSequence } = checkedCatchUpInput(
        actor.userId,
        input
      );
      const teamRangeKey = input.teamWindow
        ? `:team:${sha256(
            JSON.stringify({
              backendId: input.teamWindow.teamBackendId,
              projectId: input.teamWindow.workspaceProjectId,
              memberId: input.teamWindow.memberId,
              seenCursor: input.teamWindow.seenCursor,
              highCursor: input.teamWindow.highCursor,
              welcomeDue: input.teamWindow.welcomeDue
            })
          )}`
        : "";
      const idempotencyKey = `project-hq-catch-up:${input.projectId}:${seenSequence}:${highSequence}${teamRangeKey}`;
      const requestDigest = sha256(
        JSON.stringify({
          kind: "hq_catch_up",
          executionId: input.executionId,
          generation: input.executionGeneration,
          inputDigest: input.inputDigest
        })
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const execution = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS} from managed_conversation_executions
            where id=$1 and owner_user_id=$2 and project_id=$3
              and is_project_hq and state='running'
              and execution_generation=$4 for update`,
          [
            input.executionId,
            actor.userId,
            input.projectId,
            input.executionGeneration
          ]
        );
        if (!execution.rows[0])
          throw statusError("Project HQ is not running", 409);
        // The human prompt path locks execution before Project, but other
        // lifecycle paths use different parent orders. Never wait for a
        // Project lock while holding this execution; report a retryable 409.
        await assertCurrentCatchUpProject(
          client,
          actor.userId,
          input.projectId,
          input.teamWindow
        );
        const binding = await client.query<{
          local_session_id: string | null;
          provider_thread_id: string | null;
        }>(
          `select local_session_id,provider_thread_id
             from managed_conversation_runtime_bindings
            where execution_id=$1 and owner_user_id=$2
              and execution_generation=$3 for share nowait`,
          [input.executionId, actor.userId, input.executionGeneration]
        );
        if (
          !binding.rows[0] ||
          binding.rows[0].provider_thread_id !==
            execution.rows[0]!.provider_thread_id
        )
          throw statusError("Project HQ runtime identity changed", 409);
        await assertHqCatchUpSessionWritable(
          client,
          execution.rows[0]!,
          binding.rows[0].local_session_id
        );
        const existing = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS} from managed_conversation_commands
            where owner_user_id=$1 and idempotency_key=$2 limit 1`,
          [actor.userId, idempotencyKey]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_digest !== requestDigest)
            throw statusError("Project HQ catch-up range changed", 409);
          await client.query("commit");
          return mapCommand(
            existing.rows[0],
            await decryptPayload(existing.rows[0])
          );
        }
        await assertCurrentCatchUpRange(
          client,
          actor.userId,
          input,
          seenSequence,
          highSequence
        );
        const active = await client.query(
          `select 1 from managed_conversation_commands
             where owner_user_id=$1 and execution_id=$2
               and state not in ('completed','failed','canceled') limit 1`,
          [actor.userId, input.executionId]
        );
        if (active.rowCount) throw statusError("Project HQ is busy", 409);
        const sequence = await client.query<{ sequence: number }>(
          `select coalesce(max(sequence),-1)+1 as sequence
             from managed_conversation_commands where execution_id=$1`,
          [input.executionId]
        );
        const commandId = randomUUID();
        const encryptedPayload = await encryptCommandPayload({
          ownerUserId: actor.userId,
          executionId: input.executionId,
          commandId,
          objectClass: "managed_conversation_prompt",
          value: {
            prompt: input.prompt,
            projectId: input.projectId,
            seenCursor: input.seenCursor,
            highWater: input.highWater,
            events: input.events,
            ...(input.teamWindow ? { teamWindow: input.teamWindow } : {}),
            inputDigest: input.inputDigest
          }
        });
        const inserted = await client.query<CommandRow>(
          `insert into managed_conversation_commands
            (id,owner_user_id,execution_id,idempotency_key,sequence,
             command_kind,request_digest,client_user_message_id,
             execution_generation,encrypted_payload,state)
           values($1,$2,$3,$4,$5,'hq_catch_up',$6,$7,$8,$9::jsonb,'queued')
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            input.executionId,
            idempotencyKey,
            sequence.rows[0]!.sequence,
            requestDigest,
            randomUUID(),
            input.executionGeneration,
            encryptedPayload
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation-command:${commandId}:queued`
        });
        await notifyManagedConversationCommand(client, input.executionId);
        await client.query("commit");
        return mapCommand(inserted.rows[0]!, {
          prompt: input.prompt,
          projectId: input.projectId,
          seenCursor: input.seenCursor,
          highWater: input.highWater,
          events: [...input.events],
          ...(input.teamWindow ? { teamWindow: input.teamWindow } : {}),
          inputDigest: input.inputDigest
        });
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if ((error as { code?: string }).code === "55P03")
          throw statusError("Project HQ catch-up authority is busy", 409);
        throw error;
      } finally {
        client.release();
      }
    },

    async retryProjectHqCatchUp(actor, input) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          input.retryRequestId
        )
      )
        throw statusError("Project HQ retry request is invalid", 400);
      const { seenSequence, highSequence } = checkedCatchUpInput(
        actor.userId,
        input
      );
      const idempotencyKey = `project-hq-catch-up-retry:${input.failedCommandId}:${input.retryRequestId}`;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS} from managed_conversation_executions
            where id=$1 and owner_user_id=$2 and project_id=$3
              and is_project_hq for update`,
          [input.executionId, actor.userId, input.projectId]
        );
        const execution = found.rows[0];
        if (!execution) throw statusError("Project HQ identity changed", 409);
        const previousRetry = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS} from managed_conversation_commands
            where owner_user_id=$1 and idempotency_key=$2 limit 1`,
          [actor.userId, idempotencyKey]
        );
        if (previousRetry.rows[0]) {
          const command = previousRetry.rows[0];
          if (
            command.execution_id !== execution.id ||
            command.command_kind !== "hq_catch_up"
          )
            throw statusError("Project HQ retry key changed", 409);
          await client.query("commit");
          return {
            execution: mapExecution(execution),
            command: mapCommand(command, await decryptPayload(command))
          };
        }
        if (
          execution.state !== "failed" ||
          execution.execution_generation !== input.executionGeneration ||
          (execution.runner_lease_expires_at &&
            new Date(execution.runner_lease_expires_at).getTime() > Date.now())
        )
          throw statusError("Project HQ retry is not ready", 409);
        await assertCurrentCatchUpProject(
          client,
          actor.userId,
          input.projectId,
          input.teamWindow
        );
        const original = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS} from managed_conversation_commands
            where id=$1 and owner_user_id=$2 and execution_id=$3
              and command_kind='hq_catch_up' for update nowait`,
          [input.failedCommandId, actor.userId, input.executionId]
        );
        const failed = original.rows[0];
        if (
          !failed ||
          failed.state !== "failed" ||
          failed.result?.phase === "send_started" ||
          failed.execution_generation !== execution.execution_generation
        )
          throw statusError("Project HQ outcome needs reconciliation", 409);
        const later = await client.query(
          `select 1 from managed_conversation_commands
            where owner_user_id=$1 and execution_id=$2 and sequence>$3 limit 1`,
          [actor.userId, input.executionId, failed.sequence]
        );
        if (later.rowCount)
          throw statusError("Project HQ changed after the failed turn", 409);
        const binding = await client.query<RuntimeBindingRow>(
          `select ${RUNTIME_BINDING_COLUMNS}
             from managed_conversation_runtime_bindings
            where execution_id=$1 and owner_user_id=$2 for update nowait`,
          [execution.id, actor.userId]
        );
        const runtime = binding.rows[0];
        if (
          !runtime ||
          runtime.execution_generation !== execution.execution_generation ||
          runtime.deployment_id !== execution.runner_deployment_id ||
          runtime.device_id !== execution.runner_device_id ||
          runtime.provider_thread_id !== execution.provider_thread_id ||
          !runtime.local_session_id
        )
          throw statusError("Project HQ runtime identity changed", 409);
        await assertHqCatchUpSessionWritable(
          client,
          execution,
          runtime.local_session_id
        );
        await assertCurrentCatchUpRange(
          client,
          actor.userId,
          input,
          seenSequence,
          highSequence
        );
        const generation = execution.execution_generation + 1;
        const commandId = randomUUID();
        const requestDigest = sha256(
          JSON.stringify({
            kind: "hq_catch_up",
            executionId: execution.id,
            generation,
            inputDigest: input.inputDigest,
            retryOfCommandId: failed.id,
            retryRequestId: input.retryRequestId
          })
        );
        const encryptedPayload = await encryptCommandPayload({
          ownerUserId: actor.userId,
          executionId: execution.id,
          commandId,
          objectClass: "managed_conversation_prompt",
          value: {
            prompt: input.prompt,
            projectId: input.projectId,
            seenCursor: input.seenCursor,
            highWater: input.highWater,
            events: input.events,
            ...(input.teamWindow ? { teamWindow: input.teamWindow } : {}),
            inputDigest: input.inputDigest,
            retryOfCommandId: failed.id,
            retryRequestId: input.retryRequestId
          }
        });
        const changed = await client.query<ExecutionRow>(
          `update managed_conversation_executions set
             execution_generation=$3,state='running',state_version=state_version+1,
             fencing_token_hash=$4,runner_id=null,runner_lease_expires_at=null,
             last_error_code=null,stopped_at=null,updated_at=now()
           where id=$1 and owner_user_id=$2 and state='failed'
             and execution_generation=$3-1
           returning ${EXECUTION_COLUMNS}`,
          [
            execution.id,
            actor.userId,
            generation,
            sha256(randomBytes(32).toString("base64url"))
          ]
        );
        if (!changed.rows[0])
          throw statusError("Project HQ retry generation changed", 409);
        const rebound = await client.query(
          `update managed_conversation_runtime_bindings set
             execution_generation=$3,start_authority_acknowledged_at=null,
             updated_at=now()
           where execution_id=$1 and owner_user_id=$2
             and execution_generation=$3-1`,
          [execution.id, actor.userId, generation]
        );
        if (rebound.rowCount !== 1)
          throw statusError("Project HQ runtime generation changed", 409);
        const command = await client.query<CommandRow>(
          `insert into managed_conversation_commands
            (id,owner_user_id,execution_id,idempotency_key,sequence,
             command_kind,request_digest,client_user_message_id,
             execution_generation,encrypted_payload,state)
           values($1,$2,$3,$4,$5,'hq_catch_up',$6,$7,$8,$9::jsonb,'queued')
           returning ${COMMAND_COLUMNS}`,
          [
            commandId,
            actor.userId,
            execution.id,
            idempotencyKey,
            failed.sequence + 1,
            requestDigest,
            randomUUID(),
            generation,
            encryptedPayload
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: execution.id,
          mutationId: `managed-conversation-command:${commandId}:queued`
        });
        await notifyManagedConversationCommand(client, execution.id);
        await client.query("commit");
        return {
          execution: mapExecution(changed.rows[0]),
          command: mapCommand(command.rows[0]!, {
            prompt: input.prompt,
            projectId: input.projectId,
            seenCursor: input.seenCursor,
            highWater: input.highWater,
            events: [...input.events],
            inputDigest: input.inputDigest,
            retryOfCommandId: failed.id,
            retryRequestId: input.retryRequestId
          })
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if ((error as { code?: string }).code === "55P03")
          throw statusError("Project HQ retry authority is busy", 409);
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
        if (current) await assertExecutionProjectWritable(client, current);
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
          !(input.commandKind === "stop"
            ? [
                "starting",
                "running",
                "reconciling",
                "quiesce_requested",
                "quiesced",
                "stopping"
              ].includes(execution.state)
            : ["starting", "running", "reconciling"].includes(execution.state))
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
        if (execution) await assertExecutionProjectWritable(client, execution);
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

    async declineManagedMergeProposal(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const execution = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS} from managed_conversation_executions
            where owner_user_id = $1 and id = $2 for update`,
          [actor.userId, input.executionId]
        );
        if (
          execution.rows[0]?.execution_generation !== input.executionGeneration
        ) {
          await client.query("commit");
          return false;
        }
        await assertExecutionProjectWritable(client, execution.rows[0]!);
        await assertExecutionChatWritable(client, execution.rows[0]!);
        const found = await client.query<RuntimeItemRow>(
          `select ${RUNTIME_ITEM_COLUMNS} from managed_conversation_runtime_items
            where owner_user_id = $1 and execution_id = $2 and id = $3
              and execution_generation = $4
              and provider_request_id like 'review-request-merge-propose:%'
              and item_kind = 'transient_output'
            for update`,
          [
            actor.userId,
            input.executionId,
            input.itemId,
            input.executionGeneration
          ]
        );
        const row = found.rows[0];
        if (!row) {
          await client.query("commit");
          return false;
        }
        const payload = await decryptRuntimeValue(
          row.encrypted_payload,
          "runtime payload"
        );
        const proposal = payload?.mergeProposal;
        const number =
          proposal && typeof proposal === "object" && !Array.isArray(proposal)
            ? (proposal as Record<string, unknown>).reviewRequestNumber
            : null;
        if (!Number.isSafeInteger(number) || (number as number) < 1) {
          await client.query("commit");
          return false;
        }
        const response = {
          mergeDecision: "declined",
          reviewRequestNumber: number
        };
        const digest = sha256(JSON.stringify(response));
        if (row.response_digest === digest) {
          await client.query("commit");
          return true;
        }
        if (row.response_digest) {
          await client.query("commit");
          return false;
        }
        const encryptedResponse = await encryptRuntimeValue({
          ownerUserId: actor.userId,
          executionId: input.executionId,
          itemId: row.id,
          field: "response",
          value: response
        });
        await client.query(
          `update managed_conversation_runtime_items
              set state = 'canceled', encrypted_response = $3::jsonb,
                  response_digest = $4, responded_at = now(),
                  resolved_at = coalesce(resolved_at, now()),
                  revision = revision + 1, updated_at = now()
            where owner_user_id = $1 and id = $2`,
          [actor.userId, row.id, encryptedResponse, digest]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: input.executionId,
          mutationId: `managed-conversation-runtime:${row.id}:merge-declined`,
          runtimeItemId: row.id
        });
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listManagedMergeDecisionContext(actor, input) {
      const client = await pool.connect();
      try {
        const execution = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS} from managed_conversation_executions
            where owner_user_id = $1 and id = $2`,
          [actor.userId, input.executionId]
        );
        if (
          execution.rows[0]?.execution_generation !== input.executionGeneration
        )
          return [];
        await assertExecutionProjectWritable(client, execution.rows[0]!);
        await assertExecutionChatWritable(client, execution.rows[0]!);
      } finally {
        client.release();
      }
      const result = await pool.query<RuntimeItemRow>(
        `select ${RUNTIME_ITEM_COLUMNS} from managed_conversation_runtime_items
          where owner_user_id = $1 and execution_id = $2
            and execution_generation = $3
            and provider_request_id like 'review-request-merge-propose:%'
            and item_kind = 'transient_output'
            and response_digest is not null
          order by responded_at desc, id desc limit 10`,
        [actor.userId, input.executionId, input.executionGeneration]
      );
      const lines: string[] = [];
      for (const row of result.rows) {
        const response = await decryptRuntimeValue(
          row.encrypted_response,
          "runtime response"
        );
        const number = response?.reviewRequestNumber;
        if (
          response?.mergeDecision === "declined" &&
          Number.isSafeInteger(number) &&
          (number as number) > 0
        )
          lines.push(
            `Koed status: the prior Native review for PR #${number} was declined; that proposal grants no approval. A later User request requires a fresh Native review.`
          );
      }
      return lines;
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
                    and provider_request_id not like 'review-request-merge-propose:%'
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
              and provider_request_id not like 'review-request-merge-propose:%'
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

    async getManagedConversationExecutionForSession(actor, logicalSessionId) {
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id=$1 and logical_session_id=(
            select session.logical_session_id from sessions session
             where session.id=$2 and session.owner_user_id=$1
               and session.visibility='personal' and session.trashed_at is null
               and session.personal_deleted_at is null and session.invalidated_at is null
               and session.delete_batch_id is null and session.forget_batch_id is null)
          limit 1`,
        [actor.userId, logicalSessionId]
      );
      return result.rows[0] ? mapExecution(result.rows[0]) : null;
    },

    async hasScheduledJobDispatchForCommand(actor, commandId) {
      const result = await pool.query(
        `select 1 from scheduled_job_attempt_dispatch_bindings
         where owner_user_id=$1 and managed_command_id=$2 limit 1`,
        [actor.userId, commandId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async getInterruptedScheduledCommandForExecution(actor, input) {
      const result = await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id
         from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
          join managed_conversation_executions execution on execution.id=command.execution_id
         where dispatch.owner_user_id=$1 and dispatch.managed_execution_id=$2
           and dispatch.managed_execution_generation=$3
           and execution.owner_user_id=$1 and execution.id=$2
           and execution.execution_generation=$3
           and command.owner_user_id=$1 and command.execution_generation=$3
           and command.state='indeterminate' and run.status='interrupted'
           and run.execution_id=attempt.execution_id and run.attempt=attempt.attempt
         order by attempt.started_at desc limit 1`,
        [actor.userId, input.executionId, input.executionGeneration]
      );
      return result.rows[0]?.managed_command_id ?? null;
    },

    async listQueuedScheduledJobCommands(actor, input) {
      const result = await pool.query<{ id: string }>(
        `select command.id from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join scheduled_jobs job on job.id=run.job_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
          join managed_conversation_executions execution on execution.id=command.execution_id
         where dispatch.owner_user_id=$1 and job.owner_user_id=$1
           and job.runner_device_id=$2 and execution.runner_device_id=$2
           and execution.runner_deployment_id=$3
           and command.owner_user_id=$1 and command.state='queued'
           and command.execution_generation=execution.execution_generation
           and run.execution_id=attempt.execution_id
           and run.attempt=attempt.attempt
           and run.status in ('running','waiting_approval')
         order by command.created_at,command.id limit $4`,
        [
          actor.userId,
          input.deviceId,
          input.deploymentId,
          Math.min(Math.max(input.limit, 1), 100)
        ]
      );
      return result.rows.map((row) => row.id);
    },

    async hasActiveScheduledJobDispatchForExecution(actor, executionId) {
      const result = await pool.query(
        `select 1 from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
         where dispatch.owner_user_id=$1 and dispatch.managed_execution_id=$2
           and run.execution_id=attempt.execution_id
           and run.attempt=attempt.attempt
           and (run.status in ('running','waiting_approval')
             or command.state in ('queued','blocked','dispatching','indeterminate')) limit 1`,
        [actor.userId, executionId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async listManagedConversationExecutions(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from managed_conversation_executions
          where owner_user_id = $1
            and ($2::text is null or project_id = $2)
            and not is_project_hq
            and not exists (
              select 1 from sessions captured
              where captured.owner_user_id=managed_conversation_executions.owner_user_id
                and captured.logical_session_id=managed_conversation_executions.logical_session_id
                and (captured.trashed_at is not null or captured.personal_deleted_at is not null)
            )
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
                and command.command_kind not in ('prompt','fork_create','hq_catch_up')
              )
            )
              and command.command_kind not in (
                'interrupt','stop',
                'file_browse','file_read','file_search','file_mention'
              )
              and ($7::uuid is null or command.owner_user_id = $7)
              and command.execution_generation = execution.execution_generation
              and (not exists (
                select 1 from scheduled_job_attempt_dispatch_bindings scheduled
                 where scheduled.managed_command_id=command.id
              ) or command.id=any($8::uuid[]))
              and not exists (
                select 1 from sessions captured
                 where captured.owner_user_id=execution.owner_user_id
                   and captured.logical_session_id=execution.logical_session_id
                   and (captured.delete_batch_id is not null or captured.forget_batch_id is not null
            or captured.trashed_at is not null
                     or captured.personal_deleted_at is not null)
              )
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
                not execution.is_project_hq
                or exists (
                  select 1 from projects hq_project
                   where hq_project.owner_user_id=execution.owner_user_id
                     and hq_project.id::text=execution.project_id
                     and hq_project.lifecycle='active'
                     and hq_project.deletion_phase is null
                )
              )
              and not exists (
                select 1 from projects project
                  left join project_local_contexts context
                    on context.project_id=project.id
                   and context.owner_user_id=project.owner_user_id
                   and context.device_id=execution.runner_device_id
                   and context.local_project_id=execution.project_id
                   and context.association_state='resolved'
                 where project.owner_user_id=execution.owner_user_id
                   and (project.id::text=execution.project_id or context.local_project_id=execution.project_id)
                   and (project.lifecycle<>'active' or project.deletion_phase is not null)
              )
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
          input.ownerUserId ?? null,
          input.allowedScheduledCommandIds ?? []
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
              and not exists (
                select 1 from sessions captured
                 where captured.owner_user_id=execution.owner_user_id
                   and captured.logical_session_id=execution.logical_session_id
                   and (captured.delete_batch_id is not null or captured.forget_batch_id is not null
            or captured.trashed_at is not null
                     or captured.personal_deleted_at is not null)
              )
              and ($6::uuid is null or command.owner_user_id = $6)
              and execution.runner_device_id = $4
              and execution.runner_deployment_id = $5
              and (
                not execution.is_project_hq
                or exists (
                  select 1 from projects hq_project
                   where hq_project.owner_user_id=execution.owner_user_id
                     and hq_project.id::text=execution.project_id
                     and hq_project.lifecycle='active'
                     and hq_project.deletion_phase is null
                )
              )
              and not exists (
                select 1 from projects project
                  left join project_local_contexts context
                    on context.project_id=project.id
                   and context.owner_user_id=project.owner_user_id
                   and context.device_id=execution.runner_device_id
                   and context.local_project_id=execution.project_id
                   and context.association_state='resolved'
                 where project.owner_user_id=execution.owner_user_id
                   and (project.id::text=execution.project_id or context.local_project_id=execution.project_id)
                   and (project.lifecycle<>'active' or project.deletion_phase is not null)
              )
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
              and command.command_kind in ('prompt','fork_create','hq_catch_up')
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
          if (command.command_kind === "hq_catch_up") {
            // Command was locked first by the abandoned-lease scanner. Never
            // wait for Execution, which normal dispatch paths lock first.
            const execution = await client.query<ExecutionRow>(
              `select ${EXECUTION_COLUMNS} from managed_conversation_executions
                where id=$1 and owner_user_id=$2 for update skip locked`,
              [command.execution_id, command.owner_user_id]
            );
            if (!execution.rows[0]) continue;
            const sent = command.result?.phase === "send_started";
            const state = sent ? "indeterminate" : "failed";
            await client.query(
              `update managed_conversation_commands set
                 state=$3,lease_token=null,lease_expires_at=null,
                 completed_at=now(),last_error_code=$4,updated_at=now()
               where id=$1 and owner_user_id=$2 and state='dispatching'
                 and lease_expires_at<=now()`,
              [
                command.id,
                command.owner_user_id,
                state,
                sent
                  ? "ProjectHqCatchUpOutcomeUnknownError"
                  : "ProjectHqCatchUpNotSentError"
              ]
            );
            if (
              execution.rows[0].execution_generation ===
                command.execution_generation &&
              execution.rows[0].state === "running"
            )
              await client.query(
                `update managed_conversation_executions set
                   state=$3,state_version=state_version+1,
                   runner_id=null,runner_lease_expires_at=null,
                   last_error_code=$4,updated_at=now()
                 where id=$1 and owner_user_id=$2 and state='running'
                   and execution_generation=$5`,
                [
                  command.execution_id,
                  command.owner_user_id,
                  sent ? "reconciling" : "failed",
                  sent
                    ? "ProjectHqCatchUpOutcomeUnknownError"
                    : "ProjectHqCatchUpNotSentError",
                  command.execution_generation
                ]
              );
            await appendManagedConversationEvent(client, {
              ownerUserId: command.owner_user_id,
              executionId: command.execution_id,
              mutationId: `managed-conversation-command:${command.id}:${state}`
            });
            reconciled += 1;
            continue;
          }
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
              not is_project_hq
              or exists (
                select 1 from projects hq_project
                 where hq_project.owner_user_id=managed_conversation_executions.owner_user_id
                   and hq_project.id::text=managed_conversation_executions.project_id
                   and hq_project.lifecycle='active'
                   and hq_project.deletion_phase is null
              )
            )
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
        const captured = await client.query<{
          delete_batch_id: string | null;
          forget_batch_id: string | null;
          trashed_at: Date | null;
          personal_deleted_at: Date | null;
        }>(
          `select delete_batch_id,forget_batch_id,trashed_at,personal_deleted_at from sessions
            where owner_user_id=$1 and logical_session_id=$2
            order by id for update`,
          [actor.userId, input.logicalSessionId]
        );
        if (
          captured.rows.some(
            (row) =>
              row.delete_batch_id ||
              row.forget_batch_id ||
              row.trashed_at ||
              row.personal_deleted_at
          )
        )
          throw statusError(
            "Conversation lifecycle blocks runtime binding",
            409
          );
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
        await stampManagedPolicyCapture(
          client,
          actor.userId,
          input.logicalSessionId
        );
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
        if (input.providerTurnId)
          await client.query(
            `update managed_conversation_turn_citations
              set source_generation_id = $3
            where owner_user_id = $1 and execution_id = $2
              and execution_generation = $4 and provider_turn_id = $5
              and source_generation_id is null`,
            [
              actor.userId,
              input.executionId,
              input.sourceGenerationId,
              input.executionGeneration,
              input.providerTurnId
            ]
          );
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
          execution_generation: number;
          command_kind: string;
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
            and command_kind <> 'hq_catch_up'
        returning owner_user_id, execution_id, execution_generation, command_kind`,
          [input.commandId, input.leaseToken, input.result ?? null]
        );
        const row = result.rows[0];
        if (row) {
          // Prompts execute serially. Completion follows canonical capture, so
          // temporary output from this generation must not survive into a new turn.
          const retired =
            row.command_kind === "prompt"
              ? await client.query(
                  `delete from managed_conversation_runtime_items
                  where owner_user_id = $1 and execution_id = $2
                    and execution_generation = $3 and item_kind = 'transient_output'`,
                  [
                    row.owner_user_id,
                    row.execution_id,
                    row.execution_generation
                  ]
                )
              : null;
          await appendManagedConversationEvent(client, {
            ownerUserId: row.owner_user_id,
            executionId: row.execution_id,
            mutationId: `managed-conversation-command:${input.commandId}:completed`,
            runtimeItemsReset: (retired?.rowCount ?? 0) > 0
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

    async completeManagedConversationCatchUp(input) {
      if (!Number.isSafeInteger(input.sourceToLine) || input.sourceToLine <= 0)
        return false;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const authority = await client.query<
          CommandRow & {
            project_id: string;
            current_generation: number;
            logical_session_id: string | null;
            provider_thread_id: string | null;
            local_session_id: string | null;
          }
        >(
          `select command.*, execution.project_id,
                  execution.logical_session_id,execution.provider_thread_id,
                  binding.local_session_id,
                  execution.execution_generation as current_generation
             from managed_conversation_commands command
             join managed_conversation_executions execution
               on execution.id=command.execution_id
              and execution.owner_user_id=command.owner_user_id
             join managed_conversation_runtime_bindings binding
               on binding.execution_id=execution.id
              and binding.owner_user_id=execution.owner_user_id
              and binding.execution_generation=command.execution_generation
            where command.id=$1 and command.lease_token=$2
              and command.state='dispatching'
              and command.lease_expires_at>now()
              and command.command_kind='hq_catch_up'
              and execution.is_project_hq and execution.state='running'
              and execution.execution_generation=command.execution_generation
              and execution.runner_lease_expires_at>now()
              and binding.local_session_id=$3
              and binding.provider_thread_id=$4
              and binding.source_generation_id=$5
              and execution.source_generation_id=$5
            for update of command,execution`,
          [
            input.commandId,
            input.leaseToken,
            input.localSessionId,
            input.externalSessionId,
            input.sourceGenerationId
          ]
        );
        const command = authority.rows[0];
        if (!command) {
          await client.query("rollback");
          return false;
        }
        const payload = await decryptPayload(command);
        const projectId = command.project_id;
        if (
          !payload ||
          payload.projectId !== projectId ||
          typeof payload.seenCursor !== "string" ||
          typeof payload.highWater !== "string" ||
          typeof payload.inputDigest !== "string" ||
          (typeof payload.retryOfCommandId === "string") !==
            (typeof payload.retryRequestId === "string") ||
          !Array.isArray(payload.events) ||
          (payload.events.length < 1 && !payload.teamWindow) ||
          payload.events.length > 100 ||
          (payload.teamWindow !== undefined &&
            !isProjectHqTeamCatchUpWindow(payload.teamWindow)) ||
          !command.client_user_message_id
        )
          throw statusError("Project HQ catch-up payload is invalid", 409);
        const verifiedInputDigest = sha256(
          JSON.stringify({
            ownerUserId: command.owner_user_id,
            projectId,
            seenCursor: payload.seenCursor,
            highWater: payload.highWater,
            events: payload.events,
            ...(payload.teamWindow ? { teamWindow: payload.teamWindow } : {})
          })
        );
        const verifiedRequestDigest = sha256(
          JSON.stringify({
            kind: "hq_catch_up",
            executionId: command.execution_id,
            generation: command.execution_generation,
            inputDigest: payload.inputDigest,
            ...(typeof payload.retryOfCommandId === "string" &&
            typeof payload.retryRequestId === "string"
              ? {
                  retryOfCommandId: payload.retryOfCommandId,
                  retryRequestId: payload.retryRequestId
                }
              : {})
          })
        );
        if (
          verifiedInputDigest !== payload.inputDigest ||
          verifiedRequestDigest !== command.request_digest
        )
          throw statusError("Project HQ catch-up command changed", 409);
        const seenSequence = decodeProjectActivityCursor(
          payload.seenCursor,
          command.owner_user_id,
          projectId
        );
        const highSequence = decodeProjectActivityCursor(
          payload.highWater,
          command.owner_user_id,
          projectId
        );
        if (
          seenSequence > highSequence ||
          (seenSequence === highSequence && !payload.teamWindow)
        )
          throw statusError("Project HQ catch-up range is invalid", 409);
        await assertCurrentCatchUpProject(
          client,
          command.owner_user_id,
          projectId,
          (payload.teamWindow as ProjectHqTeamCatchUpWindow | undefined) ?? null
        );
        await assertHqCatchUpSessionWritable(
          client,
          command,
          command.local_session_id
        );
        for (const unknownEvent of payload.events) {
          const event = unknownEvent as Record<string, unknown>;
          if (event.kind === "assertion_created") {
            if (
              typeof event.cursor !== "string" ||
              typeof event.assertionId !== "string" ||
              !Number.isSafeInteger(event.classificationVersion) ||
              typeof event.updatedAt !== "string"
            )
              throw statusError("Project HQ decision changed", 409);
            const sequence = decodeProjectActivityCursor(
              event.cursor,
              command.owner_user_id,
              projectId
            );
            if (sequence <= seenSequence || sequence > highSequence)
              throw statusError("Project HQ catch-up range changed", 409);
            const current = await client.query(
              `select 1 from project_activity activity
                 join curated_memory_assertions cma
                   on cma.id::text=activity.ref
                  and cma.owner_user_id=activity.owner_user_id
                where activity.owner_user_id=$1 and activity.project_id=$2
                  and activity.sequence=$3 and activity.kind='assertion_created'
                  and activity.ref=$4 and cma.id=$4::uuid
                  and cma.scope='project' and cma.project_id=activity.project_id
                  and cma.kind='decision' and cma.visibility='personal'
                  and cma.status='current' and cma.classification_version=$5
                  and cma.updated_at=$6::timestamptz
                  and cma.suppressed_at is null
                  and (cma.expires_at is null or cma.expires_at>now())
                  and ${activeCuratedMemoryEvidencePredicate("cma")}`,
              [
                command.owner_user_id,
                projectId,
                sequence.toString(),
                event.assertionId,
                event.classificationVersion,
                event.updatedAt
              ]
            );
            if (!current.rowCount)
              throw statusError("Project HQ decision changed", 409);
            continue;
          }
          if (
            typeof event.cursor !== "string" ||
            !["source_ready", "source_failed"].includes(String(event.kind)) ||
            typeof event.attemptId !== "string" ||
            typeof event.sourceId !== "string" ||
            typeof event.name !== "string"
          )
            throw statusError("Project HQ catch-up Source changed", 409);
          const sequence = decodeProjectActivityCursor(
            event.cursor,
            command.owner_user_id,
            projectId
          );
          if (sequence <= seenSequence || sequence > highSequence)
            throw statusError("Project HQ catch-up range changed", 409);
          const current = await client.query(
            `select 1 from project_activity activity
               join project_source_revisions revision
                 on revision.id::text=activity.ref
                and revision.owner_user_id=activity.owner_user_id
               join project_sources source
                 on source.id=revision.source_id
                and source.owner_user_id=revision.owner_user_id
                and source.project_id=activity.project_id
              where activity.owner_user_id=$1 and activity.project_id=$2
                and activity.sequence=$3 and activity.kind=$4 and activity.ref=$5
                and source.id::text=$6 and source.name=$7
                and source.deleted_at is null and source.remove_batch_id is null
                and source.pending_revision_id is null
                and revision.state=source.status
                and source.status=case when $4='source_ready' then 'ready' else 'failed' end
                and not exists (
                  select 1 from project_source_revisions newer
                   where newer.owner_user_id=revision.owner_user_id
                     and newer.source_id=revision.source_id
                     and newer.revision>revision.revision
                )
                and (source.status='failed' or
                     source.current_revision_id=revision.note_revision_id)`,
            [
              command.owner_user_id,
              projectId,
              sequence.toString(),
              event.kind,
              event.attemptId,
              event.sourceId,
              event.name
            ]
          );
          if (!current.rowCount)
            throw statusError("Project HQ catch-up Source changed", 409);
        }
        const origin = await client.query<{
          id: string;
          source_line_number: number | null;
          external_turn_id: string | null;
          source_fingerprint: string | null;
        }>(
          `select item.id,item.source_line_number,item.external_turn_id,
                  item.source_fingerprint
             from conversation_items item
             join sessions session on session.id=item.session_id
               and session.owner_user_id=item.owner_user_id
             join managed_conversation_executions execution
               on execution.logical_session_id=session.logical_session_id
               and execution.id=$2 and execution.owner_user_id=item.owner_user_id
            where item.owner_user_id=$1 and item.session_id=$3
              and item.source_kind=$4 and item.external_session_id=$5
              and exists (
                select 1 from conversation_source_artifacts artifact
                 where artifact.session_id=session.id
                   and artifact.owner_user_id=item.owner_user_id
                   and artifact.source_kind=$4
                   and artifact.external_session_id=$5
                   and artifact.source_generation_id=$6
                   and artifact.source_component_role='primary'
                   and artifact.lifecycle='active'
                   and artifact.source_fingerprint=item.source_fingerprint
              )
              and item.projection_status='raw_only'
              and (case when $4='codex'
                   then item.metadata->>'transcriptType'='user_message'
                   else item.source_event_type='user_message' end)
              and item.metadata->>'managedKoedCatchUpCommandId'=$7
              and item.metadata->>'managedClientUserMessageId'=$8
              and ($4<>'codex' or item.canonical_stable_item_id=
                   'koed-user-message:' || $8)
              and item.source_line_number<$9
              and item.personal_deleted_at is null
            limit 2`,
          [
            command.owner_user_id,
            command.execution_id,
            input.localSessionId,
            input.sourceKind,
            input.externalSessionId,
            input.sourceGenerationId,
            command.id,
            command.client_user_message_id,
            input.sourceToLine
          ]
        );
        if (origin.rows.length !== 1)
          throw statusError("Project HQ catch-up origin is unverified", 409);
        const user = origin.rows[0]!;
        if (
          user.source_line_number === null ||
          input.sourceToLine - user.source_line_number > 5000 ||
          (input.sourceKind === "codex" &&
            (!input.providerTurnId ||
              user.external_turn_id !== input.providerTurnId))
        )
          throw statusError("Project HQ catch-up turn changed", 409);
        const assistant = await client.query<{ assistant_message_id: string }>(
          `select message.id as assistant_message_id from conversation_items item
             join messages message
               on message.owner_user_id=item.owner_user_id
              and message.session_id=item.session_id
              and message.visibility='personal'
              and message.role='assistant'
              and message.invalidated_at is null
              and message.idempotency_key=('message:' ||
                coalesce(item.metadata->>'canonicalConversationItemKey',
                         item.canonical_item_key,item.logical_source_id,item.id::text))
            where item.owner_user_id=$1 and item.session_id=$2
              and item.source_kind=$3 and item.external_session_id=$4
              and item.source_fingerprint=$5
              and item.source_line_number>$6
              and item.source_line_number<$7
              and item.source_line_number-$6<=5000
              and item.projection_status='projected'
              and item.personal_deleted_at is null
              and ($8::text is null or item.external_turn_id=$8)
            limit 1`,
          [
            command.owner_user_id,
            input.localSessionId,
            input.sourceKind,
            input.externalSessionId,
            user.source_fingerprint,
            user.source_line_number,
            input.sourceToLine,
            input.sourceKind === "pi"
              ? null
              : input.sourceKind === "codex"
                ? input.providerTurnId
                : user.external_turn_id
          ]
        );
        if (!assistant.rowCount)
          throw statusError("Project HQ catch-up reply is not persisted", 409);
        await client.query(
          `insert into project_seen(owner_user_id,project_id,seen_sequence)
           values($1,$2,$3)
           on conflict(owner_user_id,project_id) do update set
             seen_sequence=greatest(project_seen.seen_sequence,excluded.seen_sequence),
             seen_at=case when excluded.seen_sequence>project_seen.seen_sequence
               then now() else project_seen.seen_at end`,
          [command.owner_user_id, projectId, highSequence.toString()]
        );
        const completed = await client.query(
          `update managed_conversation_commands set
             state='completed',result=$3::jsonb,lease_token=null,
             lease_expires_at=null,completed_at=now(),last_error_code=null,
             updated_at=now()
           where id=$1 and lease_token=$2 and state='dispatching'
             and command_kind='hq_catch_up'`,
          [
            command.id,
            input.leaseToken,
            JSON.stringify({
              turnId: input.providerTurnId ?? user.external_turn_id,
              highWater: payload.highWater,
              assistantPersisted: true,
              assistantMessageId: assistant.rows[0]!.assistant_message_id,
              ...(payload.teamWindow ? { teamWindow: payload.teamWindow } : {})
            })
          ]
        );
        if (completed.rowCount !== 1)
          throw statusError("Project HQ catch-up completion changed", 409);
        await appendManagedConversationEvent(client, {
          ownerUserId: command.owner_user_id,
          executionId: command.execution_id,
          mutationId: `managed-conversation-command:${command.id}:completed`
        });
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if ((error as { code?: string }).code === "55P03")
          throw statusError("Project HQ catch-up completion is busy", 409);
        throw error;
      } finally {
        client.release();
      }
    },

    async recoverProjectHqCatchUp(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const selected = await client.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS} from managed_conversation_executions
            where id=$1 and owner_user_id=$2 and project_id=$3
              and is_project_hq for update nowait`,
          [input.executionId, actor.userId, input.projectId]
        );
        const execution = selected.rows[0];
        if (!execution) throw statusError("Project HQ identity changed", 409);
        const commands = await client.query<CommandRow>(
          `select ${COMMAND_COLUMNS} from managed_conversation_commands
            where id=$1 and owner_user_id=$2 and execution_id=$3
              and command_kind='hq_catch_up' for update nowait`,
          [input.commandId, actor.userId, execution.id]
        );
        const command = commands.rows[0];
        if (!command) throw statusError("Project HQ command changed", 409);
        if (command.state === "completed") {
          await client.query("commit");
          return command.result?.assistantPersisted === true;
        }
        if (
          !["failed", "indeterminate"].includes(command.state) ||
          command.result?.phase !== "send_started" ||
          command.execution_generation !== execution.execution_generation ||
          !["failed", "reconciling"].includes(execution.state) ||
          (execution.runner_lease_expires_at &&
            new Date(execution.runner_lease_expires_at).getTime() > Date.now())
        ) {
          await client.query("rollback");
          return false;
        }
        const later = await client.query(
          `select 1 from managed_conversation_commands
            where owner_user_id=$1 and execution_id=$2 and sequence>$3 limit 1`,
          [actor.userId, execution.id, command.sequence]
        );
        if (later.rowCount) {
          await client.query("rollback");
          return false;
        }
        const runtime = await client.query<RuntimeBindingRow>(
          `select ${RUNTIME_BINDING_COLUMNS}
             from managed_conversation_runtime_bindings
            where execution_id=$1 and owner_user_id=$2
              and execution_generation=$3 for share nowait`,
          [execution.id, actor.userId, execution.execution_generation]
        );
        const binding = runtime.rows[0];
        if (
          !binding ||
          !binding.local_session_id ||
          !binding.source_generation_id ||
          binding.provider_thread_id !== execution.provider_thread_id ||
          binding.source_generation_id !== execution.source_generation_id
        ) {
          await client.query("rollback");
          return false;
        }
        await assertHqCatchUpSessionWritable(
          client,
          execution,
          binding.local_session_id
        );
        const payload = await decryptPayload(command);
        if (
          !payload ||
          payload.projectId !== input.projectId ||
          typeof payload.seenCursor !== "string" ||
          typeof payload.highWater !== "string" ||
          typeof payload.inputDigest !== "string" ||
          typeof payload.prompt !== "string" ||
          !Array.isArray(payload.events) ||
          (payload.events.length < 1 && !payload.teamWindow) ||
          payload.events.length > 100 ||
          (payload.teamWindow !== undefined &&
            !isProjectHqTeamCatchUpWindow(payload.teamWindow)) ||
          (typeof payload.retryOfCommandId === "string") !==
            (typeof payload.retryRequestId === "string") ||
          !command.client_user_message_id
        )
          throw statusError("Project HQ catch-up payload changed", 409);
        await assertCurrentCatchUpProject(
          client,
          actor.userId,
          input.projectId,
          (payload.teamWindow as ProjectHqTeamCatchUpWindow | undefined) ?? null
        );
        const events = payload.events.map((unknownEvent) => {
          const event = unknownEvent as Record<string, unknown>;
          if (
            event &&
            typeof event === "object" &&
            event.kind === "assertion_created" &&
            typeof event.cursor === "string" &&
            typeof event.assertionId === "string" &&
            typeof event.text === "string" &&
            Number.isSafeInteger(event.classificationVersion) &&
            typeof event.updatedAt === "string" &&
            typeof event.at === "string"
          )
            return event as {
              cursor: string;
              kind: "assertion_created";
              assertionId: string;
              text: string;
              classificationVersion: number;
              updatedAt: string;
              at: string;
            };
          if (
            !event ||
            typeof event !== "object" ||
            !["source_ready", "source_failed"].includes(String(event.kind)) ||
            typeof event.cursor !== "string" ||
            typeof event.attemptId !== "string" ||
            typeof event.sourceId !== "string" ||
            typeof event.name !== "string" ||
            typeof event.at !== "string"
          )
            throw statusError("Project HQ catch-up Source changed", 409);
          return event as {
            cursor: string;
            kind: "source_ready" | "source_failed";
            attemptId: string;
            sourceId: string;
            name: string;
            at: string;
          };
        });
        const oldInput = {
          projectId: input.projectId,
          executionId: execution.id,
          executionGeneration: execution.execution_generation,
          seenCursor: payload.seenCursor,
          highWater: payload.highWater,
          events,
          ...(payload.teamWindow ? { teamWindow: payload.teamWindow } : {}),
          prompt: payload.prompt,
          inputDigest: payload.inputDigest
        };
        const { seenSequence, highSequence } = checkedCatchUpInput(
          actor.userId,
          oldInput
        );
        const digest = sha256(
          JSON.stringify({
            kind: "hq_catch_up",
            executionId: execution.id,
            generation: execution.execution_generation,
            inputDigest: payload.inputDigest,
            ...(typeof payload.retryOfCommandId === "string" &&
            typeof payload.retryRequestId === "string"
              ? {
                  retryOfCommandId: payload.retryOfCommandId,
                  retryRequestId: payload.retryRequestId
                }
              : {})
          })
        );
        if (digest !== command.request_digest)
          throw statusError("Project HQ catch-up command changed", 409);
        await assertCurrentCatchUpRange(
          client,
          actor.userId,
          oldInput,
          seenSequence,
          highSequence,
          true
        );
        const sourceKind =
          execution.provider === "claude" ? "claude-code" : execution.provider;
        if (!["codex", "pi", "claude-code"].includes(sourceKind))
          throw statusError("Project HQ AI Client changed", 409);
        const artifact = await client.query<{
          source_fingerprint: string;
          provider_cursor_line: number;
        }>(
          `select source_fingerprint,provider_cursor_line
             from conversation_source_artifacts
            where session_id=$1 and owner_user_id=$2
              and source_kind=$3 and external_session_id=$4
              and source_generation_id=$5
              and source_component_role='primary' and lifecycle='active'
            limit 1`,
          [
            binding.local_session_id,
            actor.userId,
            sourceKind,
            binding.provider_thread_id,
            binding.source_generation_id
          ]
        );
        const currentArtifact = artifact.rows[0];
        if (!currentArtifact) {
          await client.query("rollback");
          return false;
        }
        const origins = await client.query<{
          id: string;
          source_line_number: number | null;
          external_turn_id: string | null;
          source_fingerprint: string | null;
        }>(
          `select id,source_line_number,external_turn_id,source_fingerprint
             from conversation_items
            where owner_user_id=$1 and session_id=$2
              and source_kind=$3 and external_session_id=$4
              and projection_status='raw_only'
              and (case when $3='codex'
                   then metadata->>'transcriptType'='user_message'
                   else source_event_type='user_message' end)
              and metadata->>'managedKoedCatchUpCommandId'=$5
              and metadata->>'managedClientUserMessageId'=$6
              and source_fingerprint=$7
              and ($3<>'codex' or canonical_stable_item_id=
                   'koed-user-message:' || $6)
              and personal_deleted_at is null
            limit 2`,
          [
            actor.userId,
            binding.local_session_id,
            sourceKind,
            binding.provider_thread_id,
            command.id,
            command.client_user_message_id,
            currentArtifact.source_fingerprint
          ]
        );
        if (origins.rows.length !== 1) {
          await client.query("rollback");
          return false;
        }
        const origin = origins.rows[0]!;
        if (
          origin.source_line_number === null ||
          origin.source_line_number >= currentArtifact.provider_cursor_line
        ) {
          await client.query("rollback");
          return false;
        }
        const assistant = await client.query<{
          assistant_message_id: string;
          external_turn_id: string | null;
          source_line_number: number | null;
        }>(
          `select message.id as assistant_message_id,
                  item.external_turn_id,item.source_line_number
             from conversation_items item
             join messages message
               on message.owner_user_id=item.owner_user_id
              and message.session_id=item.session_id
              and message.visibility='personal'
              and message.role='assistant'
              and message.invalidated_at is null
              and message.idempotency_key=('message:' ||
                coalesce(item.metadata->>'canonicalConversationItemKey',
                         item.canonical_item_key,item.logical_source_id,item.id::text))
            where item.owner_user_id=$1 and item.session_id=$2
              and item.source_kind=$3 and item.external_session_id=$4
              and item.projection_status='projected'
              and item.personal_deleted_at is null
              and item.source_fingerprint=$5
              and item.source_line_number>$6
              and item.source_line_number<$7
              and item.source_line_number-$6<=5000
              and ($3='pi' or (item.external_turn_id is not null
                and item.external_turn_id=$8))
              and ($3<>'pi' or not exists (
                select 1 from conversation_items later_user
                 where later_user.owner_user_id=item.owner_user_id
                   and later_user.session_id=item.session_id
                   and later_user.source_kind=item.source_kind
                   and later_user.external_session_id=item.external_session_id
                   and later_user.source_fingerprint=item.source_fingerprint
                   and later_user.source_line_number>$6
                   and later_user.source_line_number<item.source_line_number
                   and later_user.source_event_type='user_message'
              ))
            order by item.source_line_number desc nulls last
            limit 1`,
          [
            actor.userId,
            binding.local_session_id,
            sourceKind,
            binding.provider_thread_id,
            currentArtifact.source_fingerprint,
            origin.source_line_number,
            currentArtifact.provider_cursor_line,
            origin.external_turn_id
          ]
        );
        if (assistant.rows.length !== 1) {
          await client.query("rollback");
          return false;
        }
        await client.query(
          `insert into project_seen(owner_user_id,project_id,seen_sequence)
           values($1,$2,$3)
           on conflict(owner_user_id,project_id) do update set
             seen_sequence=greatest(project_seen.seen_sequence,excluded.seen_sequence),
             seen_at=case when excluded.seen_sequence>project_seen.seen_sequence
               then now() else project_seen.seen_at end`,
          [actor.userId, input.projectId, highSequence.toString()]
        );
        await client.query(
          `update managed_conversation_commands set
             state='completed',result=$3::jsonb,last_error_code=null,
             completed_at=now(),updated_at=now()
           where id=$1 and owner_user_id=$2 and command_kind='hq_catch_up'
             and state in ('failed','indeterminate')`,
          [
            command.id,
            actor.userId,
            JSON.stringify({
              highWater: payload.highWater,
              assistantPersisted: true,
              assistantMessageId: assistant.rows[0]!.assistant_message_id,
              ...(payload.teamWindow ? { teamWindow: payload.teamWindow } : {}),
              turnId: assistant.rows[0]!.external_turn_id,
              reconciledBy: "projected_assistant"
            })
          ]
        );
        await client.query(
          `update managed_conversation_executions set
             state='running',state_version=state_version+1,
             fencing_token_hash=$3,runner_id=null,runner_lease_expires_at=null,
             last_error_code=null,stopped_at=null,updated_at=now()
           where id=$1 and owner_user_id=$2
             and state in ('failed','reconciling')
             and execution_generation=$4`,
          [
            execution.id,
            actor.userId,
            sha256(randomBytes(32).toString("base64url")),
            execution.execution_generation
          ]
        );
        await appendManagedConversationEvent(client, {
          ownerUserId: actor.userId,
          executionId: execution.id,
          mutationId: `managed-conversation-command:${command.id}:recovered`
        });
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if ((error as { code?: string }).code === "55P03")
          throw statusError("Project HQ reconciliation is busy", 409);
        throw error;
      } finally {
        client.release();
      }
    },

    async markManagedConversationCatchUpSendStarted(input) {
      const changed = await pool.query(
        `update managed_conversation_commands command
            set result=jsonb_build_object('phase','send_started'),
                updated_at=now()
           from managed_conversation_executions execution
          where command.id=$1 and command.lease_token=$2
            and command.command_kind='hq_catch_up'
            and command.state='dispatching'
            and command.lease_expires_at>now()
            and command.execution_generation=$3
            and execution.id=command.execution_id
            and execution.owner_user_id=command.owner_user_id
            and execution.execution_generation=$3
            and execution.state='running'`,
        [input.commandId, input.leaseToken, input.executionGeneration]
      );
      return changed.rowCount === 1;
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
                  when command_kind = 'hq_catch_up' then 'failed'
                  when $3 = 'indeterminate'
                    and result->>'phase' = 'checkpoint_pending'
                    then 'queued'
                  else $3
                end,
                last_error_code = case
                  when command_kind <> 'hq_catch_up'
                    and $3 = 'indeterminate'
                    and result->>'phase' = 'checkpoint_pending'
                    then 'ExecutionCheckpointRecoveryPendingError'
                  else $4
                end,
                lease_token = null,
                lease_expires_at = null,
                completed_at = case
                  when command_kind <> 'hq_catch_up'
                    and ($3 = 'queued'
                      or ($3 = 'indeterminate'
                        and result->>'phase' = 'checkpoint_pending'))
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
                 and command.command_kind <> 'hq_catch_up'
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
               start_authority_acknowledged_at = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                   and managed_conversation_runtime_bindings.deployment_id = excluded.deployment_id
                 then managed_conversation_runtime_bindings.start_authority_acknowledged_at else null end,
               checkout_id = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.checkout_id else null end,
               checkout_kind = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.checkout_kind else 'pending' end,
               checkout_lifecycle = case
                 when managed_conversation_runtime_bindings.execution_generation = excluded.execution_generation
                   and managed_conversation_runtime_bindings.source_project_path = excluded.source_project_path
                 then managed_conversation_runtime_bindings.checkout_lifecycle else 'pending' end,
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
           and (managed_conversation_runtime_bindings.checkout_lifecycle = 'pending'
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
        if (result.rows[0].checkout_lifecycle === "pending") {
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

    async acknowledgeManagedConversationRuntimeBinding(input) {
      const result = await pool.query(
        `update managed_conversation_runtime_bindings
            set start_authority_acknowledged_at = coalesce(start_authority_acknowledged_at, now())
          where owner_user_id = $1 and execution_id = $2
            and execution_generation = $3 and deployment_id = $4 and device_id = $5
            and checkout_lifecycle = 'ready'`,
        [
          input.ownerUserId,
          input.executionId,
          input.executionGeneration,
          input.deploymentId,
          input.deviceId
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async listPendingManagedConversationRuntimeBindings(input) {
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const result = await pool.query<RuntimeBindingRow>(
        `select binding.*
           from managed_conversation_runtime_bindings binding
          where binding.deployment_id = $1
            and binding.device_id = $2
            and (binding.checkout_lifecycle = 'pending'
              or (binding.checkout_lifecycle = 'ready'
                and binding.start_authority_acknowledged_at is null))
            and ($3::uuid is null or binding.owner_user_id = $3)
          order by binding.created_at, binding.execution_id
          limit $4`,
        [input.deploymentId, input.deviceId, input.ownerUserId ?? null, limit]
      );
      return result.rows.map(mapRuntimeBinding);
    },

    async bindManagedConversationExecutionCheckout(actor, input) {
      let result: pg.QueryResult<RuntimeBindingRow>;
      try {
        result = await pool.query<RuntimeBindingRow>(
          `update managed_conversation_runtime_bindings
            set source_project_path = $6,
                project_path = $7,
                checkout_id = $8,
                checkout_kind = $9,
                checkout_lifecycle = 'ready',
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
              checkout_lifecycle = 'pending'
              or (
                checkout_lifecycle = 'ready'
                and source_project_path = $6
                and project_path = $7
                and checkout_id = $8
                and checkout_kind = $9
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
            input.checkoutId,
            input.checkoutKind,
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
            new Error("ExecutionCheckoutActivePathConflictError"),
            {
              name: "ExecutionCheckoutActivePathConflictError",
              statusCode: 409
            }
          );
        }
        throw error;
      }
      if (!result.rows[0]) {
        throw statusError(
          "Managed Conversation execution checkout conflicted",
          409
        );
      }
      return mapRuntimeBinding(result.rows[0]);
    },

    async requestManagedConversationExecutionCheckoutCleanup(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<RuntimeBindingRow>(
          `update managed_conversation_runtime_bindings
            set checkout_lifecycle = 'cleanup_requested',
                cleanup_state = 'requested',
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and execution_generation = $3
            and deployment_id = $4
            and device_id = $5
            and checkout_kind = 'koed_managed_worktree'
            and checkout_lifecycle in ('ready', 'cleanup_requested')
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
            "Managed Conversation execution checkout cannot be cleaned up",
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

    async listManagedConversationExecutionCheckoutCleanupRequests(input) {
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const result = await pool.query<RuntimeBindingRow>(
        `select ${RUNTIME_BINDING_COLUMNS}
           from managed_conversation_runtime_bindings
          where deployment_id = $1
            and device_id = $2
            and checkout_kind = 'koed_managed_worktree'
            and checkout_lifecycle = 'cleanup_requested'
            and cleanup_state = 'requested'
          order by updated_at, execution_id
          limit $3`,
        [input.deploymentId, input.deviceId, limit]
      );
      return result.rows.map(mapRuntimeBinding);
    },

    async completeManagedConversationExecutionCheckoutCleanup(input) {
      const result = await pool.query(
        `update managed_conversation_runtime_bindings
            set checkout_lifecycle = 'removed',
                cleanup_state = 'completed',
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and execution_generation = $3
            and deployment_id = $4
            and device_id = $5
            and checkout_id = $6
            and checkout_kind = 'koed_managed_worktree'
            and checkout_lifecycle = 'cleanup_requested'
            and cleanup_state = 'requested'`,
        [
          input.executionId,
          input.ownerUserId,
          input.executionGeneration,
          input.deploymentId,
          input.deviceId,
          input.checkoutId
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async failManagedConversationExecutionCheckoutCleanup(input) {
      const result = await pool.query(
        `update managed_conversation_runtime_bindings
            set checkout_lifecycle = $7,
                cleanup_state = 'failed',
                updated_at = now()
          where execution_id = $1
            and owner_user_id = $2
            and execution_generation = $3
            and deployment_id = $4
            and device_id = $5
            and checkout_id = $6
            and checkout_kind = 'koed_managed_worktree'
            and checkout_lifecycle = 'cleanup_requested'
            and cleanup_state = 'requested'`,
        [
          input.executionId,
          input.ownerUserId,
          input.executionGeneration,
          input.deploymentId,
          input.deviceId,
          input.checkoutId,
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

    async clearManagedConversationRuntimeBinding(
      actor,
      executionId,
      pendingAssignment
    ) {
      const result = await pool.query(
        `delete from managed_conversation_runtime_bindings
          where owner_user_id = $1 and execution_id = $2
            and ($3::bigint is null or (
              checkout_lifecycle = 'pending'
              and execution_generation = $3
              and deployment_id = $4 and device_id = $5))`,
        [
          actor.userId,
          executionId,
          pendingAssignment?.executionGeneration ?? null,
          pendingAssignment?.deploymentId ?? null,
          pendingAssignment?.deviceId ?? null
        ]
      );
      return (result.rowCount ?? 0) === 1;
    }
  };
};
