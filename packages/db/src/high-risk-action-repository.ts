import { createHash, randomUUID } from "node:crypto";
import {
  collaborationApprovalReviewSchema,
  highRiskActionGrantCanonicalHash,
  highRiskActionGrantCommitment,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS,
  type CollaborationApprovalReview,
  type CollaborationApprovalTier,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type pg from "pg";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { auditEventValues } from "./audit-repository.js";
import { createDb, type KoedDb } from "./connection.js";
import { createRetentionLifecycleRepository } from "./retention-lifecycle-repository.js";
import { createSharedMemoryRepository } from "./shared-memory-repository.js";
import { createCrossIdentitySyncRepository } from "./cross-identity-sync-repository.js";
import { createExternalAuthRepository } from "./external-auth-repository.js";
import { createConversationSourceJournalRepository } from "./conversation-source-journal-repository.js";
import { createDeviceCredentialRepository } from "./device-credential-repository.js";
import { createManagedConversationForkRepository } from "./managed-conversation-fork-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createManagedConversationTransferRepository } from "./managed-conversation-transfer-repository.js";
import { createPersonalDeviceSyncRepository } from "./personal-device-sync-repository.js";
import { createSavepointPool } from "./savepoint-pool.js";
import {
  auditEvents,
  deviceCredentials,
  highRiskActionGrantExecutionReceipts,
  highRiskBrowserConfirmations,
  highRiskDeviceActionGrants,
  legalHolds,
  teams,
  userSessions
} from "./schema.js";
import { createTeamAccessRepository } from "./team-access-repository.js";
import { createWorkspaceProjectRepository } from "./workspace-project-repository.js";
import { createProjectSharePolicyRepository } from "./project-share-policy-repository.js";
import { createTeamConversationSourceRepository } from "./team-conversation-source-repository.js";
import { issueTeamLifecycleFreezeAuthority } from "./team-lifecycle-freeze-authority.js";

export const defaultHighRiskConfirmationTtlMs = 5 * 60 * 1000;
export const defaultHighRiskActionGrantTtlMs = 60 * 1000;
export const defaultFreshAuthenticationMaxAgeMs = 5 * 60 * 1000;
export const maximumHighRiskConfirmationTtlMs = 10 * 60 * 1000;
export const maximumHighRiskActionGrantTtlMs = 5 * 60 * 1000;
export const maximumFreshAuthenticationMaxAgeMs = 15 * 60 * 1000;

type PersistedHighRiskConfirmationState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked";

export type HighRiskConfirmationState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked";

export type HighRiskActionGrantState = HighRiskConfirmationState | "consumed";

export interface HighRiskOperationBinding {
  ownerUserId: string;
  deviceCredentialId: string;
  upstreamBackendId: string;
  teamId: string | null;
  operationFamily: string;
  action: string;
  targetId: string | null;
  scopeHash: string;
  requestHash: string;
}

export interface HighRiskActionGrantBindingRecord extends HighRiskOperationBinding {
  id: string;
  selector: string;
  approvalTier: CollaborationApprovalTier;
  review: CollaborationApprovalReview | null;
  state: HighRiskActionGrantState;
  createdAt: string;
  expiresAt: string;
}

export interface CreateHighRiskActionGrantInput extends HighRiskOperationBinding {
  clientRequestId: string;
  grantCommitment: string;
  credentialOperationFamily:
    | "action_grant"
    | "share_grant_management"
    | "sync"
    | "managed_execution";
  approvalTier: CollaborationApprovalTier;
  review: CollaborationApprovalReview | null;
}

export interface GetHighRiskActionGrantInput {
  clientRequestId: string;
  ownerUserId: string;
  deviceCredentialId: string;
  upstreamBackendId: string;
}

export interface AwaitHighRiskActionGrantInput extends GetHighRiskActionGrantInput {
  maxWaitMs?: number;
  signal?: AbortSignal;
}

export interface CancelHighRiskActionGrantInput extends GetHighRiskActionGrantInput {
  reasonCode: string;
}

export interface GetHighRiskBrowserActivationInput {
  selector: string;
  ownerUserId: string;
}

export interface DecideHighRiskBrowserActivationInput {
  selector: string;
  ownerUserId: string;
  userSessionId: string;
  freshlyAuthenticatedAt: Date;
  decision: "approve" | "deny";
}

export interface DecideNativeActionReviewInput extends GetHighRiskActionGrantInput {
  decision: "approve";
}

export interface HighRiskMutationReceipt<TBody> {
  statusCode: number;
  body: TBody;
}

export interface ExecuteHighRiskActionGrantInput<
  TBody
> extends HighRiskOperationBinding {
  actionGrant: string;
  approvedRequest?: { method: string; path: string; body: unknown };
  execute: (
    repositories: {
      team: ReturnType<typeof createTeamAccessRepository>;
      workspaceProject: ReturnType<typeof createWorkspaceProjectRepository>;
      projectSharePolicy: ReturnType<typeof createProjectSharePolicyRepository>;
      retention: ReturnType<typeof createRetentionLifecycleRepository>;
      sharedMemory: ReturnType<typeof createSharedMemoryRepository>;
      sync: ReturnType<typeof createCrossIdentitySyncRepository>;
      sourceJournal: ReturnType<
        typeof createConversationSourceJournalRepository
      >;
      teamConversationSource: ReturnType<
        typeof createTeamConversationSourceRepository
      >;
      managedConversation: ReturnType<
        typeof createManagedConversationRepository
      > &
        ReturnType<typeof createManagedConversationForkRepository> &
        ReturnType<typeof createManagedConversationTransferRepository> &
        ReturnType<typeof createDeviceCredentialRepository> &
        ReturnType<typeof createPersonalDeviceSyncRepository>;
      externalAuth: ReturnType<typeof createExternalAuthRepository>;
    },
    binding: {
      actionGrantId: string;
      deviceCredentialId: string;
      deviceCredentialVersion: number;
      upstreamBackendId: string;
    }
  ) => Promise<HighRiskMutationReceipt<TBody> | null>;
}

export interface ExecutedHighRiskActionGrant<
  TBody
> extends HighRiskMutationReceipt<TBody> {
  replayed: boolean;
}

export interface HighRiskActionRepositoryOptions {
  confirmationTtlMs?: number;
  actionGrantTtlMs?: number;
  freshAuthenticationMaxAgeMs?: number;
  pool?: pg.Pool;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  ownerPrivateReplicaEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

export interface HighRiskActionRepository {
  createActionGrant(
    input: CreateHighRiskActionGrantInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  getActionGrant(
    input: GetHighRiskActionGrantInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  reconcileActionGrantExecution<TBody>(
    input: GetHighRiskActionGrantInput &
      HighRiskOperationBinding & { actionGrantId: string }
  ): Promise<{
    receipt: HighRiskMutationReceipt<TBody> | null;
    grant: HighRiskActionGrantBindingRecord | null;
    serverTime: Date;
  }>;
  awaitActionGrant(
    input: AwaitHighRiskActionGrantInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  cancelActionGrant(input: CancelHighRiskActionGrantInput): Promise<boolean>;
  getBrowserActivation(
    input: GetHighRiskBrowserActivationInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  decideBrowserActivation(
    input: DecideHighRiskBrowserActivationInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  decideNativeActionReview(
    input: DecideNativeActionReviewInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  executeActionGrant<TBody>(
    input: ExecuteHighRiskActionGrantInput<TBody>
  ): Promise<ExecutedHighRiskActionGrant<TBody> | null>;
  finishPreparedTeamLeave(input: {
    operationId: string;
    continuation: string;
    ownerUserId: string;
    teamId: string;
    deviceCredentialId: string;
    upstreamBackendId: string;
    backendOriginHash: string;
    copyManifestHash: string;
  }): Promise<{
    state: "finished";
    membership: Awaited<
      ReturnType<ReturnType<typeof createTeamAccessRepository>["leaveTeam"]>
    >;
  } | null>;
  recoverTeamLeaveOperations(input: {
    teamId: string;
    ownerUserId: string;
    deviceCredentialId: string;
    upstreamBackendId: string;
    backendOriginHash: string;
    operationIds: string[];
    includePrepared: boolean;
  }): Promise<
    Array<{
      operationId: string;
      continuation: string;
      state: "prepared" | "finished" | "canceled";
      copyManifestHash: string;
      ownedSetHash: string;
      ownedProjects: Array<{ id: string; version: number }>;
      finalMembership: Record<string, unknown> | null;
    }>
  >;
  finishedTeamLeaveProof(input: {
    teamId: string;
    operationId: string;
    ownerUserId: string;
    upstreamBackendId: string;
    backendOriginHash: string;
  }): Promise<{
    operationId: string;
    state: "finished";
    copyManifestHash: string;
    ownedSetHash: string;
    ownedProjects: Array<{ id: string; version: number }>;
    finalMembership: Record<string, unknown>;
  } | null>;
  textActionLifecycleProof(input: {
    ownerUserId: string;
    upstreamBackendId: string;
    backendOriginHash: string;
    teamId: string;
    targetId: string;
    effectKey: string;
    action: "workspace_project.leave" | "team.leave";
    expectedProjectVersion?: number;
    expectedMemberVersion?: number;
    expectedMembershipVersion?: number;
    expectedTeamVersion?: number;
  }): Promise<boolean>;
  lookupLegalHoldTeamId(holdId: string): Promise<string | null>;
  getLegalHoldApprovalReview(holdId: string): Promise<{
    id: string;
    teamId: string;
    teamName: string;
    scope: string;
    state: "active" | "release_pending" | "released";
  } | null>;
  expireBrowserConfirmations(): Promise<number>;
  expireActionGrants(): Promise<number>;
}

type BrowserConfirmationRow = typeof highRiskBrowserConfirmations.$inferSelect;
type ActionGrantRow = typeof highRiskDeviceActionGrants.$inferSelect;
type ActionGrantExecutionReceiptRow =
  typeof highRiskActionGrantExecutionReceipts.$inferSelect;

const timestampIso = (value: Date): string => value.toISOString();

const highRiskActionGrantNotificationChannel = "koed_high_risk_action_grants";

const notifyActionGrant = (
  client: Pick<pg.PoolClient, "query">,
  clientRequestId: string
) =>
  client.query(
    `select pg_notify('${highRiskActionGrantNotificationChannel}', $1)`,
    [clientRequestId]
  );

const notifyActionGrantWithDb = (db: KoedDb, clientRequestId: string) =>
  db.execute(
    sql`select pg_notify(${highRiskActionGrantNotificationChannel}, ${clientRequestId})`
  );

const validateTtl = (name: string, value: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}`
    );
  }
  return value;
};

const validateHash = (name: string, value: string): void => {
  if (value.length !== 64) {
    throw new Error(`${name} must be a 64-character hash`);
  }
};

const validateReasonCode = (reasonCode: string): void => {
  if (!/^[A-Za-z0-9_.:-]+$/.test(reasonCode)) {
    throw new Error("High-risk action revocation reason code is invalid");
  }
};

const validateUuid = (name: string, value: string): void => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
};

const validateGrantCommitment = (value: string): void => {
  if (!/^v1:[0-9A-Fa-f]{64}$/.test(value)) {
    throw new Error("High-risk action grant commitment is invalid");
  }
};

const validateOperationBinding = (input: HighRiskOperationBinding): void => {
  if (!/^[A-Za-z0-9_.:-]+$/.test(input.operationFamily)) {
    throw new Error("High-risk operation family is invalid");
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(input.action)) {
    throw new Error("High-risk action is invalid");
  }
  if (input.upstreamBackendId.length === 0) {
    throw new Error("High-risk action upstream backend is required");
  }
  validateHash("High-risk action scope hash", input.scopeHash);
  validateHash("High-risk action request hash", input.requestHash);
};

const validateCredentialOperationFamily = (
  input: CreateHighRiskActionGrantInput
): void => {
  const expected = credentialOperationFamily(input.operationFamily);
  if (input.credentialOperationFamily !== expected) {
    throw new Error(
      "High-risk credential operation family does not match the protected operation"
    );
  }
};

const credentialOperationFamily = (
  operationFamily: string
):
  | "action_grant"
  | "share_grant_management"
  | "sync"
  | "managed_execution"
  | null =>
  operationFamily === "admin"
    ? "action_grant"
    : operationFamily === "share_grant_management"
      ? "share_grant_management"
      : operationFamily === "source_download"
        ? "sync"
        : operationFamily === "managed_execution"
          ? "managed_execution"
          : null;

const operationAuditMetadata = (
  input: Pick<
    HighRiskOperationBinding,
    | "deviceCredentialId"
    | "upstreamBackendId"
    | "teamId"
    | "operationFamily"
    | "action"
    | "targetId"
  >,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  deviceCredentialId: input.deviceCredentialId,
  upstreamBackendId: input.upstreamBackendId,
  ...(input.teamId ? { teamId: input.teamId } : {}),
  operationFamily: input.operationFamily,
  operationAction: input.action,
  operationTargetId: input.targetId,
  ...extra
});

const confirmationAuditMetadata = (
  row: BrowserConfirmationRow,
  extra: Record<string, unknown> = {}
) =>
  operationAuditMetadata(
    {
      deviceCredentialId: row.deviceCredentialId,
      upstreamBackendId: row.upstreamBackendId,
      teamId: row.teamId,
      operationFamily: row.operationFamily,
      action: row.action,
      targetId: row.targetId
    },
    {
      publicReferenceId: row.clientRequestId,
      approvalTier: row.approvalTier,
      ...extra
    }
  );

const grantAuditMetadata = (
  row: ActionGrantRow,
  publicReferenceId: string,
  extra: Record<string, unknown> = {}
) =>
  operationAuditMetadata(row, {
    publicReferenceId,
    confirmationId: row.confirmationId,
    ...extra
  });

const insertAudit = async (
  tx: KoedDb,
  input: {
    ownerUserId: string;
    teamId: string | null;
    action: string;
    targetTable: string;
    targetId: string;
    metadata: Record<string, unknown>;
    actorUserId?: string | null;
  }
): Promise<void> => {
  await tx.insert(auditEvents).values(
    auditEventValues({
      actorUserId: input.actorUserId ?? null,
      ownerUserId: input.ownerUserId,
      visibility: input.teamId ? null : "personal",
      action: input.action,
      targetTable: input.targetTable,
      targetId: input.targetId,
      metadata: input.metadata
    })
  );
};

const apiStateFromRows = (
  confirmation: Pick<BrowserConfirmationRow, "state" | "revocationReasonCode">,
  grant: Pick<
    ActionGrantRow,
    "state" | "revocationReasonCode" | "consumedAt"
  > | null
): HighRiskActionGrantState => {
  if (grant?.state === "expired" || confirmation.state === "expired") {
    return "expired";
  }
  if (confirmation.state === "denied") {
    return "denied";
  }
  if (grant?.state === "revoked" || confirmation.state === "revoked") {
    return "revoked";
  }
  if (grant?.state === "consumed") {
    return "consumed";
  }
  if (confirmation.state === "pending") {
    return "pending";
  }
  return "approved";
};

const mapBindingRecord = (
  confirmation: BrowserConfirmationRow,
  grant: ActionGrantRow | null
): HighRiskActionGrantBindingRecord => ({
  id: confirmation.clientRequestId,
  selector: confirmation.selector,
  approvalTier: confirmation.approvalTier,
  review: confirmation.reviewSummary
    ? collaborationApprovalReviewSchema.parse(confirmation.reviewSummary)
    : null,
  state: apiStateFromRows(confirmation, grant),
  ownerUserId: confirmation.ownerUserId,
  deviceCredentialId: confirmation.deviceCredentialId,
  upstreamBackendId: confirmation.upstreamBackendId,
  teamId: confirmation.teamId,
  operationFamily: confirmation.operationFamily,
  action: confirmation.action,
  targetId: confirmation.targetId,
  scopeHash: confirmation.scopeHash,
  requestHash: confirmation.requestHash,
  createdAt: timestampIso(confirmation.createdAt),
  expiresAt: timestampIso(grant?.expiresAt ?? confirmation.expiresAt)
});

type TeamFreezeParentAction =
  | "team.leave"
  | "team.member.disable"
  | "team.workspace.access_update";

const isTeamFreezeParentAction = (
  action: string
): action is TeamFreezeParentAction =>
  action === "team.leave" ||
  action === "team.member.disable" ||
  action === "team.workspace.access_update";

interface VerifiedTeamFreezeParent {
  action: TeamFreezeParentAction;
  actorUserId: string;
  teamId: string;
  targetId: string;
  actionGrantId: string;
  requestId: string;
  requestHash: string;
  approvalTier: CollaborationApprovalTier;
  requestBody: Record<string, unknown>;
}

interface VerifiedProjectFreezeParent {
  action:
    | "workspace_project.leave"
    | "workspace_project.member_remove"
    | "workspace_project.delete"
    | "project_source.team_metadata.delete";
  actorUserId: string;
  teamId: string;
  projectId: string;
  sourceId?: string;
  targetId: string;
  actionGrantId: string;
  requestId: string;
  requestHash: string;
  approvalTier: CollaborationApprovalTier;
  requestBody: Record<string, unknown>;
}

const isProjectFreezeParentAction = (
  action: string
): action is VerifiedProjectFreezeParent["action"] =>
  action === "workspace_project.leave" ||
  action === "workspace_project.member_remove" ||
  action === "workspace_project.delete" ||
  action === "project_source.team_metadata.delete";

const buildScopedRepositories = (
  client: pg.PoolClient,
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider,
  teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider,
  ownerPrivateReplicaEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider,
  verifiedTeamFreezeParent?: VerifiedTeamFreezeParent,
  verifiedProjectFreezeParent?: VerifiedProjectFreezeParent
) => {
  const savepointPool = createSavepointPool(client, "high_risk");
  const scopedSharedMemory = createSharedMemoryRepository(savepointPool, {
    resolvePersonalEncryptionProvider: () => {
      if (!envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption is required for Curated Memory execution"
        );
      }
      return Promise.resolve(envelopeEncryptionProvider);
    },
    resolveTeamEncryptionProvider: () => {
      if (!teamEnvelopeEncryptionProvider) {
        throw new Error(
          "Team envelope encryption is required for Shared Memory execution"
        );
      }
      return Promise.resolve(teamEnvelopeEncryptionProvider);
    },
    resolveOwnerPrivateReplicaEncryptionProvider: () => {
      if (!ownerPrivateReplicaEnvelopeEncryptionProvider) {
        throw new Error(
          "Owner-private replica envelope encryption is required for Shared Memory execution"
        );
      }
      return Promise.resolve(ownerPrivateReplicaEnvelopeEncryptionProvider);
    },
    delegatedDeviceActionGrantExecution: true
  });
  return {
    projectSharePolicy: createProjectSharePolicyRepository(savepointPool),
    workspaceProject: createWorkspaceProjectRepository(savepointPool, {
      freezeGrantForParent: async (transactionClient, input) => {
        const verified = verifiedProjectFreezeParent;
        if (
          !verified ||
          verified.action !== input.action ||
          verified.actorUserId !== input.actorUserId ||
          verified.teamId !== input.teamId ||
          verified.projectId !== input.projectId ||
          verified.targetId !== input.projectId ||
          verified.approvalTier !== "step_up" ||
          verified.requestBody.expectedProjectVersion == null ||
          (input.action === "project_source.team_metadata.delete" &&
            (verified.sourceId !== input.sourceId ||
              verified.requestBody.expectedSourceVersion !==
                input.sourceVersion)) ||
          (input.action === "workspace_project.member_remove" &&
            verified.requestBody.expectedMemberVersion == null)
        ) {
          throw new Error(
            "Verified Workspace Project lifecycle parent mismatch"
          );
        }
        const outerTx = await client.query<{ txid: string }>(
          "select txid_current()::text as txid"
        );
        const nestedTx = await transactionClient.query<{ txid: string }>(
          "select txid_current()::text as txid"
        );
        if (outerTx.rows[0]?.txid !== nestedTx.rows[0]?.txid)
          throw new Error("Workspace Project freeze crossed transactions");
        const token = issueTeamLifecycleFreezeAuthority({
          transactionClient,
          action: input.action,
          outerActionGrantId: verified.actionGrantId,
          outerRequestId: verified.requestId,
          outerRequestHash: verified.requestHash,
          approvalTier: "step_up",
          actorUserId: input.actorUserId,
          teamId: input.teamId,
          targetUserId: input.targetUserId,
          targetVersion: input.targetVersion,
          teamWorkspaceId: input.workspaceId,
          workspaceProjectId: input.projectId,
          workspaceProjectSourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          shareGrantId: input.shareGrantId,
          expectedGrantVersion: input.expectedGrantVersion
        });
        await scopedSharedMemory.freezeShareGrant(
          { userId: input.actorUserId },
          {
            mutationId: randomUUID(),
            shareGrantId: input.shareGrantId,
            expectedGrantVersion: input.expectedGrantVersion,
            backendParent: token
          },
          transactionClient
        );
      }
    }),
    team: createTeamAccessRepository(savepointPool, {
      envelopeEncryptionProvider,
      freezeShareGrantForParent: async (transactionClient, input) => {
        const parent = input.parent;
        const verified = verifiedTeamFreezeParent;
        const expectedVersion = verified?.requestBody.expectedVersion;
        let teamLeaveScopeValid = true;
        let teamLeaveOwnedProjectId: string | null = null;
        if (verified?.action === "team.leave") {
          const claimed = verified.requestBody.expectedOwnedWorkspaceProjects;
          const owned = Array.isArray(claimed)
            ? (claimed as Array<{
                id?: unknown;
                version?: unknown;
              }>)
            : [];
          const isOwnedStepUp =
            owned.length > 0 &&
            verified.approvalTier === "step_up" &&
            Number.isSafeInteger(verified.requestBody.expectedTeamVersion);
          if (parent.teamWorkspaceId && parent.workspaceProjectId) {
            const project = await client.query<{ id: string; version: number }>(
              `
              select project.id,project.version
                from workspace_projects project
                join team_memberships actor
                  on actor.id=project.owner_team_member_id
               where project.id=$4 and project.team_id=$1 and project.workspace_id=$2
                 and actor.user_id=$3 and project.lifecycle='active'`,
              [
                parent.teamId,
                parent.teamWorkspaceId,
                verified.actorUserId,
                parent.workspaceProjectId
              ]
            );
            const current = project.rows[0];
            teamLeaveScopeValid =
              isOwnedStepUp &&
              Boolean(current) &&
              owned.some(
                (entry) =>
                  entry.id === current?.id && entry.version === current?.version
              );
            if (teamLeaveScopeValid) teamLeaveOwnedProjectId = current!.id;
          } else {
            teamLeaveScopeValid =
              parent.targetUserId === verified.actorUserId &&
              parent.targetVersion === expectedVersion &&
              ((owned.length === 0 &&
                verified.approvalTier === "native_review") ||
                isOwnedStepUp);
          }
        }
        if (
          !verified ||
          verified.action !== parent.action ||
          verified.actorUserId !== input.actorUserId ||
          verified.teamId !== parent.teamId ||
          !Number.isSafeInteger(expectedVersion) ||
          (verified.action !== "team.leave" &&
            expectedVersion !== parent.targetVersion) ||
          (verified.action === "team.leave" &&
            (verified.targetId !== parent.teamId || !teamLeaveScopeValid)) ||
          (verified.action === "team.member.disable" &&
            (verified.approvalTier !== "step_up" ||
              verified.targetId !== parent.targetUserId ||
              parent.targetUserId === verified.actorUserId ||
              parent.teamWorkspaceId !== undefined)) ||
          (verified.action === "team.workspace.access_update" &&
            (verified.approvalTier !== "step_up" ||
              verified.targetId !== parent.teamWorkspaceId ||
              verified.requestBody.userId !== parent.targetUserId ||
              verified.requestBody.access !== "disabled"))
        ) {
          throw new Error("Verified Team lifecycle freeze parent mismatch");
        }
        const outerTx = await client.query<{ txid: string }>(
          "select txid_current()::text as txid"
        );
        const nestedTx = await transactionClient.query<{ txid: string }>(
          "select txid_current()::text as txid"
        );
        if (outerTx.rows[0]?.txid !== nestedTx.rows[0]?.txid) {
          throw new Error("Team lifecycle freeze crossed transactions");
        }
        const token = issueTeamLifecycleFreezeAuthority({
          transactionClient,
          action: verified.action,
          outerActionGrantId: verified.actionGrantId,
          outerRequestId: verified.requestId,
          outerRequestHash: verified.requestHash,
          approvalTier: verified.approvalTier as "native_review" | "step_up",
          actorUserId: input.actorUserId,
          teamId: parent.teamId,
          targetUserId: parent.targetUserId,
          targetVersion: parent.targetVersion,
          teamWorkspaceId: parent.teamWorkspaceId ?? null,
          workspaceProjectId: teamLeaveOwnedProjectId,
          shareGrantId: input.shareGrantId,
          expectedGrantVersion: input.expectedGrantVersion
        });
        await scopedSharedMemory.freezeShareGrant(
          { userId: input.actorUserId },
          {
            mutationId: input.mutationId,
            shareGrantId: input.shareGrantId,
            expectedGrantVersion: input.expectedGrantVersion,
            backendParent: token
          },
          transactionClient
        );
      }
    }),
    retention: createRetentionLifecycleRepository(savepointPool, {
      authorizeHoldActor: async (context) => {
        if (context.target.scope === "owner_private_replica") {
          return context.authority === "personal_memory.legal_hold.manage";
        }
        const result = await client.query(
          `select 1
             from team_memberships tm
             join teams t on t.id = tm.team_id
            where tm.team_id = $1
              and tm.user_id = $2
              and tm.role in ('owner', 'admin')
              and tm.status = 'enabled'
              and tm.disabled_at is null
              and t.lifecycle in ('active', 'deletion_requested', 'purge_pending')
            limit 1`,
          [context.target.teamId, context.actorUserId]
        );
        return result.rowCount === 1;
      }
    }),
    sharedMemory: scopedSharedMemory,
    sync: createCrossIdentitySyncRepository(savepointPool, {
      envelopeEncryptionProvider: ownerPrivateReplicaEnvelopeEncryptionProvider
    }),
    sourceJournal: createConversationSourceJournalRepository(savepointPool),
    teamConversationSource:
      createTeamConversationSourceRepository(savepointPool),
    managedConversation: {
      ...createManagedConversationRepository(savepointPool, {
        envelopeEncryptionProvider
      }),
      ...createManagedConversationForkRepository(savepointPool),
      ...createManagedConversationTransferRepository(savepointPool, {
        envelopeEncryptionProvider
      }),
      ...createDeviceCredentialRepository(createDb(client)),
      ...createPersonalDeviceSyncRepository(savepointPool)
    },
    externalAuth: createExternalAuthRepository(createDb(client))
  };
};

const hashReceiptPayload = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const receiptBodyJson = (body: unknown): string => {
  const value = JSON.stringify(body);
  if (value === undefined) {
    throw new Error("High-risk receipt body must be JSON-serializable");
  }
  return value;
};

interface EncryptedHighRiskReceiptBody {
  version: 1;
  encoding: "envelope";
  envelope: EncryptedPayloadEnvelope;
}

const encryptedReceiptBody = (
  value: unknown
): EncryptedHighRiskReceiptBody | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<EncryptedHighRiskReceiptBody>;
  if (
    candidate.version !== 1 ||
    candidate.encoding !== "envelope" ||
    !candidate.envelope ||
    typeof candidate.envelope !== "object"
  ) {
    return null;
  }
  return candidate as EncryptedHighRiskReceiptBody;
};

const encodeReceiptBody = async (input: {
  provider: EnvelopeEncryptionProvider;
  bodyJson: string;
  grant: ActionGrantRow;
}): Promise<EncryptedHighRiskReceiptBody> => ({
  version: 1,
  encoding: "envelope",
  envelope: await input.provider.encrypt({
    plaintext: input.bodyJson,
    scope: {
      teamId: input.grant.teamId,
      objectClass: "high_risk_action_grant_receipt"
    },
    provenance: {
      rowFamily: "high_risk_action_grant_receipt",
      sourceTable: "high_risk_device_action_grants",
      sourceColumn: "id",
      sourceId: input.grant.id
    },
    ciphertextLocation:
      "high_risk_action_grant_execution_receipts.receipt_body",
    aad: {
      actionGrantId: input.grant.id,
      ownerUserId: input.grant.ownerUserId,
      action: input.grant.action,
      requestHash: input.grant.requestHash
    }
  })
});

const decodeReceiptRow = async <TBody>(
  provider: EnvelopeEncryptionProvider,
  row: Pick<
    ActionGrantExecutionReceiptRow,
    "statusCode" | "receiptBody" | "receiptHash"
  > | null
): Promise<HighRiskMutationReceipt<TBody> | null> => {
  if (!row) return null;
  const stored = encryptedReceiptBody(row.receiptBody);
  if (!stored) {
    throw new Error("High-risk action grant receipt is not encrypted");
  }
  const bodyJson = Buffer.from(
    await provider.decrypt(stored.envelope)
  ).toString("utf8");
  if (hashReceiptPayload(bodyJson) !== row.receiptHash) {
    throw new Error("High-risk action grant receipt integrity check failed");
  }
  return {
    statusCode: row.statusCode,
    body: JSON.parse(bodyJson) as TBody
  };
};

export const createHighRiskActionRepository = (
  db: KoedDb,
  options: HighRiskActionRepositoryOptions
): HighRiskActionRepository => {
  const confirmationTtlMs = validateTtl(
    "High-risk confirmation TTL",
    options.confirmationTtlMs ?? defaultHighRiskConfirmationTtlMs,
    maximumHighRiskConfirmationTtlMs
  );
  const actionGrantTtlMs = validateTtl(
    "High-risk action grant TTL",
    options.actionGrantTtlMs ?? defaultHighRiskActionGrantTtlMs,
    maximumHighRiskActionGrantTtlMs
  );
  const freshAuthenticationMaxAgeMs = validateTtl(
    "Fresh authentication maximum age",
    options.freshAuthenticationMaxAgeMs ?? defaultFreshAuthenticationMaxAgeMs,
    maximumFreshAuthenticationMaxAgeMs
  );

  const ensureFreshTimestamp = (
    freshlyAuthenticatedAt: Date,
    createdAt: Date
  ): void => {
    if (freshlyAuthenticatedAt.getTime() > createdAt.getTime()) {
      throw new Error("Fresh authentication timestamp cannot be in the future");
    }
    if (
      createdAt.getTime() - freshlyAuthenticatedAt.getTime() >
      freshAuthenticationMaxAgeMs
    ) {
      throw new Error("Fresh authentication timestamp is too old");
    }
  };

  const selectConfirmationWithGrant = async (
    tx: KoedDb,
    input: GetHighRiskActionGrantInput
  ): Promise<{
    confirmation: BrowserConfirmationRow;
    grant: ActionGrantRow | null;
  } | null> => {
    const [row] = await tx
      .select({
        confirmation: highRiskBrowserConfirmations,
        grant: highRiskDeviceActionGrants
      })
      .from(highRiskBrowserConfirmations)
      .leftJoin(
        highRiskDeviceActionGrants,
        eq(
          highRiskDeviceActionGrants.confirmationId,
          highRiskBrowserConfirmations.id
        )
      )
      .where(
        and(
          eq(
            highRiskBrowserConfirmations.clientRequestId,
            input.clientRequestId
          ),
          eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
          eq(
            highRiskBrowserConfirmations.deviceCredentialId,
            input.deviceCredentialId
          ),
          eq(
            highRiskBrowserConfirmations.upstreamBackendId,
            input.upstreamBackendId
          )
        )
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return { confirmation: row.confirmation, grant: row.grant };
  };

  const matchesConfirmationBinding = (
    confirmation: BrowserConfirmationRow,
    input: CreateHighRiskActionGrantInput
  ): boolean =>
    confirmation.teamId === input.teamId &&
    confirmation.operationFamily === input.operationFamily &&
    confirmation.action === input.action &&
    confirmation.targetId === input.targetId &&
    confirmation.scopeHash === input.scopeHash &&
    confirmation.requestHash === input.requestHash &&
    confirmation.secretCommitment === input.grantCommitment &&
    confirmation.approvalTier === input.approvalTier;

  const issueActionGrant = async (
    tx: KoedDb,
    confirmation: BrowserConfirmationRow
  ): Promise<ActionGrantRow> => {
    const [grant] = await tx
      .insert(highRiskDeviceActionGrants)
      .values({
        confirmationId: confirmation.id,
        deviceCredentialId: confirmation.deviceCredentialId,
        ownerUserId: confirmation.ownerUserId,
        upstreamBackendId: confirmation.upstreamBackendId,
        teamId: confirmation.teamId,
        operationFamily: confirmation.operationFamily,
        action: confirmation.action,
        targetId: confirmation.targetId,
        scopeHash: confirmation.scopeHash,
        requestHash: confirmation.requestHash,
        secretCommitment: confirmation.secretCommitment,
        expiresAt: sql`least(
          ${confirmation.expiresAt},
          now() + (${actionGrantTtlMs}::bigint * interval '1 millisecond')
        )`
      })
      .returning();
    if (!grant) {
      throw new Error("Action Grant issuance did not return a record");
    }
    return grant;
  };

  const issueApprovedActionGrant = async (
    tx: KoedDb,
    input: {
      confirmation: BrowserConfirmationRow;
      actorUserId: string;
      confirmationAuditAction?:
        | "high_risk.browser_confirmation.approved"
        | "high_risk.native_review.approved";
    }
  ): Promise<HighRiskActionGrantBindingRecord> => {
    const grant = await issueActionGrant(tx, input.confirmation);
    if (input.confirmationAuditAction) {
      await insertAudit(tx, {
        actorUserId: input.actorUserId,
        ownerUserId: input.confirmation.ownerUserId,
        teamId: input.confirmation.teamId,
        action: input.confirmationAuditAction,
        targetTable: "high_risk_browser_confirmations",
        targetId: input.confirmation.id,
        metadata: confirmationAuditMetadata(input.confirmation, {
          actionGrantId: grant.id
        })
      });
    }
    await insertAudit(tx, {
      actorUserId: input.actorUserId,
      ownerUserId: grant.ownerUserId,
      teamId: grant.teamId,
      action: "high_risk.action_grant.issued",
      targetTable: "high_risk_device_action_grants",
      targetId: grant.id,
      metadata: grantAuditMetadata(grant, input.confirmation.clientRequestId, {
        approvalTier: input.confirmation.approvalTier
      })
    });
    await notifyActionGrantWithDb(tx, input.confirmation.clientRequestId);
    return mapBindingRecord(input.confirmation, grant);
  };

  return {
    async createActionGrant(input) {
      validateUuid("High-risk action grant request ID", input.clientRequestId);
      validateGrantCommitment(input.grantCommitment);
      validateOperationBinding(input);
      validateCredentialOperationFamily(input);
      if (
        input.approvalTier !== "direct" &&
        input.approvalTier !== "native_review" &&
        input.approvalTier !== "step_up"
      ) {
        throw new Error("Action approval tier is invalid");
      }
      const review = input.review
        ? collaborationApprovalReviewSchema.parse(input.review)
        : null;
      if ((input.approvalTier === "direct") !== (review === null)) {
        throw new Error(
          "Direct actions must omit review copy and reviewed actions must include it"
        );
      }
      const createdAt = new Date();

      return db.transaction(async (tx) => {
        const existing = await selectConfirmationWithGrant(tx, {
          clientRequestId: input.clientRequestId,
          ownerUserId: input.ownerUserId,
          deviceCredentialId: input.deviceCredentialId,
          upstreamBackendId: input.upstreamBackendId
        });
        if (existing) {
          if (matchesConfirmationBinding(existing.confirmation, input)) {
            return mapBindingRecord(existing.confirmation, existing.grant);
          }
          return null;
        }

        const [device] = await tx
          .select({ id: deviceCredentials.id })
          .from(deviceCredentials)
          .where(
            and(
              eq(deviceCredentials.id, input.deviceCredentialId),
              eq(deviceCredentials.ownerUserId, input.ownerUserId),
              eq(deviceCredentials.upstreamBackendId, input.upstreamBackendId),
              sql`${input.credentialOperationFamily} = any(${deviceCredentials.operationFamilies})`,
              isNull(deviceCredentials.revokedAt),
              or(
                isNull(deviceCredentials.expiresAt),
                gt(deviceCredentials.expiresAt, sql`now()`)
              )
            )
          )
          .limit(1);
        if (!device) {
          return null;
        }

        const [confirmation] = await tx
          .insert(highRiskBrowserConfirmations)
          .values({
            selector: randomUUID(),
            clientRequestId: input.clientRequestId,
            ownerUserId: input.ownerUserId,
            deviceCredentialId: input.deviceCredentialId,
            upstreamBackendId: input.upstreamBackendId,
            teamId: input.teamId,
            operationFamily: input.operationFamily,
            action: input.action,
            targetId: input.targetId,
            scopeHash: input.scopeHash,
            requestHash: input.requestHash,
            secretCommitment: input.grantCommitment,
            approvalTier: input.approvalTier,
            reviewSummary: review,
            ...(input.approvalTier === "direct"
              ? { state: "approved" as const, decidedAt: createdAt }
              : {}),
            createdAt,
            expiresAt: new Date(createdAt.getTime() + confirmationTtlMs)
          })
          // The idempotency key and secret commitment are independently
          // unique. Resolve either race through the scoped binding lookup.
          .onConflictDoNothing()
          .returning();
        if (!confirmation) {
          const concurrent = await selectConfirmationWithGrant(tx, {
            clientRequestId: input.clientRequestId,
            ownerUserId: input.ownerUserId,
            deviceCredentialId: input.deviceCredentialId,
            upstreamBackendId: input.upstreamBackendId
          });
          return concurrent &&
            matchesConfirmationBinding(concurrent.confirmation, input)
            ? mapBindingRecord(concurrent.confirmation, concurrent.grant)
            : null;
        }

        await insertAudit(tx, {
          actorUserId: input.ownerUserId,
          ownerUserId: input.ownerUserId,
          teamId: input.teamId,
          action: "high_risk.browser_confirmation.created",
          targetTable: "high_risk_browser_confirmations",
          targetId: confirmation!.id,
          metadata: confirmationAuditMetadata(confirmation!)
        });

        if (confirmation!.approvalTier !== "direct") {
          return mapBindingRecord(confirmation!, null);
        }
        return issueApprovedActionGrant(tx, {
          confirmation: confirmation!,
          actorUserId: input.ownerUserId
        });
      });
    },

    async getActionGrant(input) {
      const row = await selectConfirmationWithGrant(db, input);
      return row ? mapBindingRecord(row.confirmation, row.grant) : null;
    },

    async reconcileActionGrantExecution<TBody>(
      input: GetHighRiskActionGrantInput &
        HighRiskOperationBinding & { actionGrantId: string }
    ) {
      validateOperationBinding(input);
      validateUuid("Action Grant ID", input.actionGrantId);
      const provider = options.envelopeEncryptionProvider;
      const pool = options.pool;
      if (!provider || !pool)
        throw new Error("High-risk receipt custody unavailable");
      const client = await pool.connect();
      try {
        await client.query("begin");
        // The mutation transaction locks this same grant row FOR UPDATE.
        // A read after this lock sees either its committed receipt or a
        // provably non-executable terminal grant, never an in-flight active
        // grant that merely crossed its wall-clock expiry.
        await client.query(
          `select grant_row.id
             from high_risk_device_action_grants grant_row
             join high_risk_browser_confirmations confirmation
               on confirmation.id=grant_row.confirmation_id
            where confirmation.client_request_id=$1
              and grant_row.owner_user_id=$2
              and grant_row.device_credential_id=$3
              and grant_row.upstream_backend_id=$4
            for update of grant_row`,
          [
            input.actionGrantId,
            input.ownerUserId,
            input.deviceCredentialId,
            input.upstreamBackendId
          ]
        );
        const tx = createDb(client);
        const row = await selectConfirmationWithGrant(tx, {
          ...input,
          clientRequestId: input.actionGrantId
        });
        const grant = row?.grant;
        const exact = Boolean(
          row &&
          grant &&
          row!.confirmation.clientRequestId === input.actionGrantId &&
          grant!.ownerUserId === input.ownerUserId &&
          grant!.deviceCredentialId === input.deviceCredentialId &&
          grant!.upstreamBackendId === input.upstreamBackendId &&
          grant!.teamId === input.teamId &&
          grant!.operationFamily === input.operationFamily &&
          grant!.action === input.action &&
          grant!.targetId === input.targetId &&
          grant!.scopeHash === input.scopeHash &&
          grant!.requestHash === input.requestHash
        );
        const [nowRow] = (
          await client.query<{ now: Date }>("select now() as now")
        ).rows;
        let receipt: HighRiskMutationReceipt<TBody> | null = null;
        if (exact && grant!.state === "consumed" && grant!.useCount === 1) {
          const [stored] = await tx
            .select()
            .from(highRiskActionGrantExecutionReceipts)
            .where(
              eq(highRiskActionGrantExecutionReceipts.actionGrantId, grant!.id)
            )
            .limit(1);
          if (!stored)
            throw new Error("Consumed Action Grant has no execution receipt");
          receipt = await decodeReceiptRow<TBody>(provider, stored);
        }
        await client.query("commit");
        return {
          receipt,
          grant: exact ? mapBindingRecord(row!.confirmation, grant!) : null,
          serverTime: nowRow!.now
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async awaitActionGrant(input) {
      const pool = options.pool;
      if (!pool) {
        throw new Error(
          "A database pool is required for Action Grant notifications"
        );
      }
      const client = await pool.connect();
      let notified = false;
      let wake: (() => void) | null = null;
      const onNotification = (message: {
        channel: string;
        payload?: string;
      }) => {
        if (
          message.channel === highRiskActionGrantNotificationChannel &&
          message.payload === input.clientRequestId
        ) {
          notified = true;
          wake?.();
        }
      };
      client.on("notification", onNotification);
      try {
        await client.query(`listen ${highRiskActionGrantNotificationChannel}`);
        const read = async () => {
          const row = await selectConfirmationWithGrant(
            createDb(client),
            input
          );
          return row ? mapBindingRecord(row.confirmation, row.grant) : null;
        };
        const current = await read();
        if (!current || current.state !== "pending") {
          return current;
        }
        const remainingMs = Date.parse(current.expiresAt) - Date.now();
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
          return { ...current, state: "expired" };
        }
        if (!notified) {
          const maxWaitMs = input.maxWaitMs ?? remainingMs;
          const waitMs = Math.min(
            remainingMs,
            Number.isFinite(maxWaitMs) ? Math.max(0, maxWaitMs) : remainingMs
          );
          let onAbort: (() => void) | null = null;
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(resolve, waitMs);
              onAbort = () => {
                clearTimeout(timeout);
                reject(
                  Object.assign(new Error("Action Grant wait was aborted"), {
                    name: "AbortError"
                  })
                );
              };
              wake = () => {
                clearTimeout(timeout);
                resolve();
              };
              if (input.signal?.aborted) {
                onAbort();
                return;
              }
              input.signal?.addEventListener("abort", onAbort, { once: true });
            });
          } finally {
            if (onAbort) {
              input.signal?.removeEventListener("abort", onAbort);
            }
          }
        }
        const resolved = await read();
        return resolved?.state === "pending" &&
          Date.parse(resolved.expiresAt) <= Date.now()
          ? { ...resolved, state: "expired" }
          : resolved;
      } finally {
        wake = null;
        client.removeListener("notification", onNotification);
        await client
          .query(`unlisten ${highRiskActionGrantNotificationChannel}`)
          .catch(() => undefined);
        client.release();
      }
    },

    async cancelActionGrant(input) {
      validateReasonCode(input.reasonCode);
      return db.transaction(async (tx) => {
        const confirmationRow = await selectConfirmationWithGrant(tx, input);
        if (!confirmationRow) {
          return false;
        }

        const allowedConfirmationStates: PersistedHighRiskConfirmationState[] =
          ["pending", "approved"];
        if (
          !allowedConfirmationStates.includes(
            confirmationRow.confirmation.state
          )
        ) {
          return false;
        }
        if (confirmationRow.grant && confirmationRow.grant.state !== "active") {
          return false;
        }

        const [confirmation] = await tx
          .update(highRiskBrowserConfirmations)
          .set({
            state: "revoked",
            revokedAt: sql`now()`,
            revocationReasonCode: input.reasonCode
          })
          .where(
            and(
              eq(
                highRiskBrowserConfirmations.clientRequestId,
                input.clientRequestId
              ),
              eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
              eq(
                highRiskBrowserConfirmations.deviceCredentialId,
                input.deviceCredentialId
              ),
              eq(
                highRiskBrowserConfirmations.upstreamBackendId,
                input.upstreamBackendId
              ),
              inArray(highRiskBrowserConfirmations.state, [
                "pending",
                "approved"
              ]),
              isNull(highRiskBrowserConfirmations.revokedAt)
            )
          )
          .returning();
        if (!confirmation) {
          return false;
        }

        if (confirmationRow.grant && confirmationRow.grant.state === "active") {
          await tx
            .update(highRiskDeviceActionGrants)
            .set({
              state: "revoked",
              revokedAt: sql`now()`,
              revocationReasonCode: input.reasonCode
            })
            .where(eq(highRiskDeviceActionGrants.id, confirmationRow.grant.id));
        }

        await insertAudit(tx, {
          actorUserId: input.ownerUserId,
          ownerUserId: confirmation.ownerUserId,
          teamId: confirmation.teamId,
          action: "high_risk.browser_confirmation.revoked",
          targetTable: "high_risk_browser_confirmations",
          targetId: confirmation.id,
          metadata: confirmationAuditMetadata(confirmation, {
            reasonCode: input.reasonCode
          })
        });
        await notifyActionGrantWithDb(tx, confirmation.clientRequestId);
        return true;
      });
    },

    async getBrowserActivation(input) {
      const row = await db
        .select({
          confirmation: highRiskBrowserConfirmations,
          grant: highRiskDeviceActionGrants
        })
        .from(highRiskBrowserConfirmations)
        .leftJoin(
          highRiskDeviceActionGrants,
          eq(
            highRiskDeviceActionGrants.confirmationId,
            highRiskBrowserConfirmations.id
          )
        )
        .where(
          and(
            eq(highRiskBrowserConfirmations.selector, input.selector),
            eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
            eq(highRiskBrowserConfirmations.approvalTier, "step_up")
          )
        )
        .limit(1);
      return row[0]
        ? mapBindingRecord(row[0].confirmation, row[0].grant)
        : null;
    },

    async decideBrowserActivation(input) {
      const decidedAt = new Date();
      ensureFreshTimestamp(input.freshlyAuthenticatedAt, decidedAt);

      return db.transaction(async (tx) => {
        const [session] = await tx
          .select({ id: userSessions.id })
          .from(userSessions)
          .where(
            and(
              eq(userSessions.id, input.userSessionId),
              eq(userSessions.userId, input.ownerUserId),
              isNull(userSessions.revokedAt),
              gt(userSessions.expiresAt, sql`now()`)
            )
          )
          .limit(1);
        if (!session) {
          return null;
        }

        const existing = await tx
          .select({
            confirmation: highRiskBrowserConfirmations,
            grant: highRiskDeviceActionGrants
          })
          .from(highRiskBrowserConfirmations)
          .leftJoin(
            highRiskDeviceActionGrants,
            eq(
              highRiskDeviceActionGrants.confirmationId,
              highRiskBrowserConfirmations.id
            )
          )
          .where(
            and(
              eq(highRiskBrowserConfirmations.selector, input.selector),
              eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId)
            )
          )
          .limit(1);
        const current = existing[0];
        if (
          !current ||
          current.confirmation.approvalTier !== "step_up" ||
          current.confirmation.state !== "pending" ||
          current.grant !== null ||
          current.confirmation.expiresAt.getTime() <= Date.now()
        ) {
          return null;
        }

        if (input.decision === "deny") {
          const [confirmation] = await tx
            .update(highRiskBrowserConfirmations)
            .set({
              decisionUserSessionId: input.userSessionId,
              decisionFreshlyAuthenticatedAt: input.freshlyAuthenticatedAt,
              decidedAt,
              state: "denied"
            })
            .where(
              and(
                eq(highRiskBrowserConfirmations.selector, input.selector),
                eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
                eq(highRiskBrowserConfirmations.state, "pending"),
                isNull(highRiskBrowserConfirmations.decidedAt),
                gt(highRiskBrowserConfirmations.expiresAt, sql`now()`)
              )
            )
            .returning();
          if (!confirmation) {
            return null;
          }
          await insertAudit(tx, {
            actorUserId: input.ownerUserId,
            ownerUserId: confirmation.ownerUserId,
            teamId: confirmation.teamId,
            action: "high_risk.browser_confirmation.denied",
            targetTable: "high_risk_browser_confirmations",
            targetId: confirmation.id,
            metadata: confirmationAuditMetadata(confirmation)
          });
          await notifyActionGrantWithDb(tx, confirmation.clientRequestId);
          return mapBindingRecord(confirmation, null);
        }

        const [confirmation] = await tx
          .update(highRiskBrowserConfirmations)
          .set({
            decisionUserSessionId: input.userSessionId,
            decisionFreshlyAuthenticatedAt: input.freshlyAuthenticatedAt,
            decidedAt,
            state: "approved"
          })
          .where(
            and(
              eq(highRiskBrowserConfirmations.selector, input.selector),
              eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
              eq(highRiskBrowserConfirmations.state, "pending"),
              isNull(highRiskBrowserConfirmations.decidedAt),
              gt(highRiskBrowserConfirmations.expiresAt, sql`now()`)
            )
          )
          .returning();
        if (!confirmation) {
          return null;
        }

        return issueApprovedActionGrant(tx, {
          confirmation,
          actorUserId: input.ownerUserId,
          confirmationAuditAction: "high_risk.browser_confirmation.approved"
        });
      });
    },

    async decideNativeActionReview(input) {
      return db.transaction(async (tx) => {
        const current = await selectConfirmationWithGrant(tx, input);
        if (
          !current ||
          current.confirmation.approvalTier !== "native_review" ||
          current.confirmation.state !== "pending" ||
          current.grant !== null ||
          current.confirmation.expiresAt.getTime() <= Date.now()
        ) {
          return null;
        }

        const [confirmation] = await tx
          .update(highRiskBrowserConfirmations)
          .set({ decidedAt: sql`now()`, state: "approved" })
          .where(
            and(
              eq(
                highRiskBrowserConfirmations.clientRequestId,
                input.clientRequestId
              ),
              eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
              eq(
                highRiskBrowserConfirmations.deviceCredentialId,
                input.deviceCredentialId
              ),
              eq(
                highRiskBrowserConfirmations.upstreamBackendId,
                input.upstreamBackendId
              ),
              eq(highRiskBrowserConfirmations.approvalTier, "native_review"),
              eq(highRiskBrowserConfirmations.state, "pending"),
              isNull(highRiskBrowserConfirmations.decidedAt),
              gt(highRiskBrowserConfirmations.expiresAt, sql`now()`)
            )
          )
          .returning();
        if (!confirmation) return null;

        return issueApprovedActionGrant(tx, {
          confirmation,
          actorUserId: input.ownerUserId,
          confirmationAuditAction: "high_risk.native_review.approved"
        });
      });
    },

    async executeActionGrant<TBody>(
      input: ExecuteHighRiskActionGrantInput<TBody>
    ) {
      validateOperationBinding(input);
      const receiptEncryptionProvider = options.envelopeEncryptionProvider;
      if (!receiptEncryptionProvider) {
        throw new Error(
          "Envelope encryption is required for high-risk action grant receipts"
        );
      }
      const commitment = highRiskActionGrantCommitment(input.actionGrant);
      const pool = options.pool;
      if (!pool) {
        throw new Error(
          "A database pool is required for atomic high-risk action grant execution"
        );
      }

      // A legacy writer can hold an artifact row before its trigger reaches
      // the common source fence. PostgreSQL may resolve that inversion with
      // 40P01 (or abort an RR snapshot with 40001). Retry the *whole* action
      // transaction so its one-use grant and receipt remain atomic.
      const attempts =
        input.action === "shared_memory.grant.freeze" ||
        input.action === "team.leave"
          ? 3
          : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          if (
            input.operationFamily === "share_grant_management" &&
            input.action !== "shared_memory.grant.freeze"
          ) {
            await client.query(
              "set transaction isolation level repeatable read"
            );
          }
          const tx = createDb(client);
          const requiredCredentialFamily = credentialOperationFamily(
            input.operationFamily
          );
          if (!requiredCredentialFamily) {
            await client.query("rollback");
            return null;
          }
          const [activeCredential] = await tx
            .select({
              id: deviceCredentials.id,
              version: deviceCredentials.credentialVersion
            })
            .from(deviceCredentials)
            .where(
              and(
                eq(deviceCredentials.id, input.deviceCredentialId),
                eq(deviceCredentials.ownerUserId, input.ownerUserId),
                eq(
                  deviceCredentials.upstreamBackendId,
                  input.upstreamBackendId
                ),
                sql`${requiredCredentialFamily} = any(${deviceCredentials.operationFamilies})`,
                isNull(deviceCredentials.revokedAt),
                or(
                  isNull(deviceCredentials.expiresAt),
                  gt(deviceCredentials.expiresAt, sql`now()`)
                )
              )
            )
            .limit(1)
            .for("update");
          if (!activeCredential) {
            await client.query("rollback");
            return null;
          }
          const [row] = await tx
            .select({
              confirmation: highRiskBrowserConfirmations,
              grant: highRiskDeviceActionGrants
            })
            .from(highRiskDeviceActionGrants)
            .innerJoin(
              highRiskBrowserConfirmations,
              eq(
                highRiskBrowserConfirmations.id,
                highRiskDeviceActionGrants.confirmationId
              )
            )
            .where(
              and(
                eq(highRiskDeviceActionGrants.secretCommitment, commitment),
                eq(highRiskDeviceActionGrants.ownerUserId, input.ownerUserId),
                eq(
                  highRiskDeviceActionGrants.deviceCredentialId,
                  input.deviceCredentialId
                ),
                eq(
                  highRiskDeviceActionGrants.upstreamBackendId,
                  input.upstreamBackendId
                ),
                input.teamId === null
                  ? isNull(highRiskDeviceActionGrants.teamId)
                  : eq(highRiskDeviceActionGrants.teamId, input.teamId),
                eq(
                  highRiskDeviceActionGrants.operationFamily,
                  input.operationFamily
                ),
                eq(highRiskDeviceActionGrants.action, input.action),
                input.targetId === null
                  ? isNull(highRiskDeviceActionGrants.targetId)
                  : eq(highRiskDeviceActionGrants.targetId, input.targetId),
                eq(highRiskDeviceActionGrants.scopeHash, input.scopeHash),
                eq(highRiskDeviceActionGrants.requestHash, input.requestHash)
              )
            )
            .limit(1)
            .for("update", {
              of: [highRiskDeviceActionGrants, highRiskBrowserConfirmations]
            });
          if (!row) {
            await client.query("rollback");
            return null;
          }

          const grant = row.grant;
          const confirmation = row.confirmation;
          let verifiedTeamFreezeParent: VerifiedTeamFreezeParent | undefined;
          let verifiedProjectFreezeParent:
            | VerifiedProjectFreezeParent
            | undefined;
          if (isTeamFreezeParentAction(grant.action)) {
            const approved = input.approvedRequest;
            const approvedBody = approved?.body;
            const expectedRequest =
              grant.teamId && grant.targetId
                ? grant.action === "team.leave"
                  ? { method: "POST", path: `/v1/teams/${grant.teamId}/leave` }
                  : grant.action === "team.member.disable"
                    ? {
                        method: "POST",
                        path: `/v1/teams/${grant.teamId}/members/${grant.targetId}/disable`
                      }
                    : {
                        method: "PUT",
                        path: `/v1/team-workspaces/${grant.targetId}/access`
                      }
                : null;
            if (
              !approved ||
              !expectedRequest ||
              approved.method !== expectedRequest.method ||
              approved.path !== expectedRequest.path ||
              !approvedBody ||
              typeof approvedBody !== "object" ||
              Array.isArray(approvedBody) ||
              !grant.teamId ||
              !grant.targetId ||
              highRiskActionGrantCanonicalHash(
                HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
                approved
              ) !== grant.requestHash
            ) {
              await client.query("rollback");
              return null;
            }
            verifiedTeamFreezeParent = {
              action: grant.action,
              actorUserId: grant.ownerUserId,
              teamId: grant.teamId,
              targetId: grant.targetId,
              actionGrantId: grant.id,
              requestId: confirmation.clientRequestId,
              requestHash: grant.requestHash,
              approvalTier: confirmation.approvalTier,
              requestBody: approvedBody as Record<string, unknown>
            };
          }
          if (isProjectFreezeParentAction(grant.action)) {
            const approved = input.approvedRequest;
            const approvedBody = approved?.body;
            const projectId = grant.targetId;
            const expectedPath = projectId
              ? grant.action === "workspace_project.leave"
                ? `/v1/workspace-projects/${projectId}/leave`
                : grant.action === "workspace_project.delete"
                  ? `/v1/workspace-projects/${projectId}/delete`
                  : grant.action === "project_source.team_metadata.delete"
                    ? (input.approvedRequest?.path ?? "")
                    : typeof input.approvedRequest?.body === "object" &&
                        input.approvedRequest.body !== null
                      ? input.approvedRequest.path
                      : ""
              : "";
            if (
              !approved ||
              approved.method !== "POST" ||
              !grant.teamId ||
              !projectId ||
              !approved.path.startsWith(
                `/v1/workspace-projects/${projectId}/`
              ) ||
              (grant.action === "project_source.team_metadata.delete" &&
                !new RegExp(
                  `^/v1/workspace-projects/${projectId}/sources/[0-9a-f-]{36}/delete$`,
                  "i"
                ).test(approved.path)) ||
              (grant.action !== "workspace_project.member_remove" &&
                approved.path !== expectedPath) ||
              !approvedBody ||
              typeof approvedBody !== "object" ||
              Array.isArray(approvedBody) ||
              highRiskActionGrantCanonicalHash(
                HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
                approved
              ) !== grant.requestHash
            ) {
              await client.query("rollback");
              return null;
            }
            verifiedProjectFreezeParent = {
              action: grant.action,
              actorUserId: grant.ownerUserId,
              teamId: grant.teamId,
              projectId,
              ...(grant.action === "project_source.team_metadata.delete"
                ? {
                    sourceId: approved.path.match(
                      /^\/v1\/workspace-projects\/[0-9a-f-]{36}\/sources\/([0-9a-f-]{36})\/delete$/i
                    )?.[1]
                  }
                : {}),
              targetId: grant.targetId!,
              actionGrantId: grant.id,
              requestId: confirmation.clientRequestId,
              requestHash: grant.requestHash,
              approvalTier: confirmation.approvalTier,
              requestBody: approvedBody as Record<string, unknown>
            };
          }
          if (
            grant.state === "consumed" &&
            grant.useCount === 1 &&
            grant.consumedAt !== null
          ) {
            const [storedReceipt = null] = await tx
              .select()
              .from(highRiskActionGrantExecutionReceipts)
              .where(
                eq(highRiskActionGrantExecutionReceipts.actionGrantId, grant.id)
              )
              .limit(1);
            const receipt = await decodeReceiptRow<TBody>(
              receiptEncryptionProvider,
              storedReceipt
            );
            await client.query("commit");
            if (!receipt) {
              throw new Error(
                "Consumed high-risk action grant is missing a receipt"
              );
            }
            return { ...receipt, replayed: true };
          }

          if (
            grant.state !== "active" ||
            grant.useCount !== 0 ||
            grant.expiresAt.getTime() <= Date.now() ||
            confirmation.state !== "approved"
          ) {
            await client.query("rollback");
            return null;
          }

          const receipt = await input.execute(
            buildScopedRepositories(
              client,
              options.envelopeEncryptionProvider,
              options.teamEnvelopeEncryptionProvider,
              options.ownerPrivateReplicaEnvelopeEncryptionProvider,
              verifiedTeamFreezeParent,
              verifiedProjectFreezeParent
            ),
            {
              actionGrantId: grant.id,
              deviceCredentialId: grant.deviceCredentialId,
              deviceCredentialVersion: activeCredential.version,
              upstreamBackendId: grant.upstreamBackendId
            }
          );
          if (!receipt) {
            await client.query("rollback");
            return null;
          }

          const bodyJson = receiptBodyJson(receipt.body);
          const storedBody = await encodeReceiptBody({
            provider: receiptEncryptionProvider,
            bodyJson,
            grant
          });
          await tx
            .insert(highRiskActionGrantExecutionReceipts)
            .values({
              actionGrantId: grant.id,
              ownerUserId: grant.ownerUserId,
              statusCode: receipt.statusCode,
              receiptBody: storedBody,
              receiptHash: hashReceiptPayload(bodyJson)
            })
            .returning({ id: highRiskActionGrantExecutionReceipts.id });
          await tx
            .update(highRiskDeviceActionGrants)
            .set({
              state: "consumed",
              useCount: 1,
              consumedAt: sql`now()`
            })
            .where(eq(highRiskDeviceActionGrants.id, grant.id));

          await insertAudit(tx, {
            actorUserId: input.ownerUserId,
            ownerUserId: grant.ownerUserId,
            teamId: grant.teamId,
            action: "high_risk.action_grant.consumed",
            targetTable: "high_risk_device_action_grants",
            targetId: grant.id,
            metadata: grantAuditMetadata(grant, confirmation.clientRequestId)
          });
          await notifyActionGrant(client, confirmation.clientRequestId);

          await client.query("commit");
          return { ...receipt, replayed: false };
        } catch (error) {
          await client.query("rollback");
          const code = (error as { code?: unknown }).code;
          if (
            attempt + 1 < attempts &&
            (code === "40P01" || code === "40001")
          ) {
            continue;
          }
          throw error;
        } finally {
          client.release();
        }
      }
      return null;
    },

    async finishedTeamLeaveProof(input) {
      const pool = options.pool;
      const provider = options.envelopeEncryptionProvider;
      if (!pool || !provider)
        throw new Error("Team departure proof custody unavailable");
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<{
          id: string;
          copy_manifest_hash: string;
          owned_set_hash: string;
          owned_projects: Array<{ id: string; version: number }>;
          final_membership: Record<string, unknown> | null;
          action_grant_id: string;
          continuation_commitment: string;
          expected_team_version: number;
          expected_membership_version: number;
          request_hash: string;
          confirmation_request_hash: string;
          scope_hash: string;
        }>(
          `select operation.id,operation.copy_manifest_hash,operation.owned_set_hash,
                  operation.owned_projects,operation.final_membership,
                  operation.action_grant_id,operation.continuation_commitment,
                  operation.expected_team_version,operation.expected_membership_version,
                  action_grant.request_hash,confirmation.request_hash as confirmation_request_hash,
                  action_grant.scope_hash
             from team_leave_operations operation
             join users owner_user on owner_user.id=operation.owner_user_id
             join high_risk_device_action_grants action_grant on action_grant.id=operation.action_grant_id
             join high_risk_browser_confirmations confirmation on confirmation.id=action_grant.confirmation_id
            where operation.id=$1 and operation.team_id=$2 and operation.owner_user_id=$3
              and operation.upstream_backend_id=$4 and operation.backend_origin_hash=$5
              and operation.state='finished' and operation.final_membership is not null
              and owner_user.disabled_at is null and owner_user.deleted_at is null
              and action_grant.owner_user_id=$3 and action_grant.team_id=$2
              and action_grant.device_credential_id=operation.device_credential_id
              and action_grant.upstream_backend_id=$4 and action_grant.target_id=$2
              and action_grant.action='team.leave' and action_grant.operation_family='admin'
              and action_grant.state='consumed' and action_grant.use_count=1
              and action_grant.consumed_at is not null
              and confirmation.state='approved' and confirmation.approval_tier='step_up'
              and confirmation.owner_user_id=$3
              and confirmation.device_credential_id=operation.device_credential_id
              and confirmation.upstream_backend_id=$4 and confirmation.team_id=$2
              and confirmation.action='team.leave' and confirmation.operation_family='admin'
            for update of operation`,
          [
            input.operationId,
            input.teamId,
            input.ownerUserId,
            input.upstreamBackendId,
            input.backendOriginHash
          ]
        );
        const row = result.rows[0];
        if (!row) {
          await client.query("commit");
          return null;
        }
        const approvedBody = {
          expectedVersion: row.expected_membership_version,
          expectedTeamVersion: row.expected_team_version,
          expectedOwnedWorkspaceProjects: row.owned_projects,
          copyManifestHash: row.copy_manifest_hash
        };
        const requestHash = highRiskActionGrantCanonicalHash(
          HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
          {
            method: "POST",
            path: `/v1/teams/${input.teamId}/leave`,
            body: approvedBody
          }
        );
        const scopeHash = highRiskActionGrantCanonicalHash(
          HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
          {
            operationFamily: "admin",
            action: "team.leave",
            teamId: input.teamId,
            targetId: input.teamId
          }
        );
        if (
          row.request_hash !== requestHash ||
          row.confirmation_request_hash !== requestHash ||
          row.scope_hash !== scopeHash
        )
          throw new Error("Finished Team departure approval binding changed");
        const tx = createDb(client);
        const [stored] = await tx
          .select()
          .from(highRiskActionGrantExecutionReceipts)
          .where(
            eq(
              highRiskActionGrantExecutionReceipts.actionGrantId,
              row.action_grant_id
            )
          )
          .limit(1);
        const receipt = await decodeReceiptRow<{
          operation: {
            operationId: string;
            continuation: string;
            state: string;
            copyManifestHash: string;
            ownedSetHash: string;
          };
        }>(provider, stored ?? null);
        const original = receipt?.body?.operation;
        if (
          receipt?.statusCode !== 200 ||
          !original ||
          original.operationId !== row.id ||
          original.state !== "prepared" ||
          original.copyManifestHash !== row.copy_manifest_hash ||
          original.ownedSetHash !== row.owned_set_hash ||
          createHash("sha256")
            .update(`koed:team-leave-continuation:v1\n${original.continuation}`)
            .digest("hex") !== row.continuation_commitment
        )
          throw new Error("Finished Team departure receipt changed");
        await client.query("commit");
        return {
          operationId: row.id,
          state: "finished",
          copyManifestHash: row.copy_manifest_hash,
          ownedSetHash: row.owned_set_hash,
          ownedProjects: row.owned_projects,
          finalMembership: row.final_membership!
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async textActionLifecycleProof(input) {
      const pool = options.pool;
      const provider = options.envelopeEncryptionProvider;
      if (!pool || !provider)
        throw new Error("Lifecycle receipt custody unavailable");
      if (
        input.action === "workspace_project.leave" &&
        (!input.expectedProjectVersion || !input.expectedMemberVersion)
      )
        return false;
      const rows = await pool.query<{
        id: string;
        request_hash: string;
        confirmation_request_hash: string;
        scope_hash: string;
        status_code: number;
        receipt_body: unknown;
        receipt_hash: string;
        operation_id: string | null;
        operation_state: string | null;
        operation_backend_origin_hash: string | null;
        final_membership: unknown;
        operation_expected_team_version: number | null;
        operation_expected_membership_version: number | null;
        operation_owned_projects: Array<{ id: string; version: number }> | null;
        operation_copy_manifest_hash: string | null;
      }>(
        `
        select action_grant.id,action_grant.request_hash,
               confirmation.request_hash as confirmation_request_hash,
               action_grant.scope_hash,receipt.status_code,receipt.receipt_body,
               receipt.receipt_hash,operation.id as operation_id,
               operation.state as operation_state,
               operation.backend_origin_hash as operation_backend_origin_hash,
               operation.final_membership,
               operation.expected_team_version as operation_expected_team_version,
               operation.expected_membership_version as operation_expected_membership_version,
               operation.owned_projects as operation_owned_projects,
               operation.copy_manifest_hash as operation_copy_manifest_hash
          from high_risk_device_action_grants action_grant
          join high_risk_browser_confirmations confirmation
            on confirmation.id=action_grant.confirmation_id
          join high_risk_action_grant_execution_receipts receipt
            on receipt.action_grant_id=action_grant.id and receipt.owner_user_id=action_grant.owner_user_id
          left join team_leave_operations operation
            on operation.action_grant_id=action_grant.id
         where confirmation.client_request_id=$1
           and action_grant.owner_user_id=$2 and confirmation.owner_user_id=$2
           and action_grant.upstream_backend_id=$3 and confirmation.upstream_backend_id=$3
           and action_grant.team_id=$4 and confirmation.team_id=$4
           and action_grant.target_id=$5 and confirmation.target_id=$5
           and action_grant.action=$6 and confirmation.action=$6
           and action_grant.operation_family='admin' and confirmation.operation_family='admin'
           and action_grant.state='consumed' and action_grant.use_count=1 and action_grant.consumed_at is not null
           and confirmation.state='approved'
           and ((action_grant.action='team.leave' and operation.id is null
                 and confirmation.approval_tier='native_review')
             or ((action_grant.action='workspace_project.leave' or operation.id is not null)
                 and confirmation.approval_tier='step_up'))
           and receipt.status_code=200
         limit 2`,
        [
          input.effectKey,
          input.ownerUserId,
          input.upstreamBackendId,
          input.teamId,
          input.targetId,
          input.action
        ]
      );
      if (rows.rows.length !== 1) return false;
      const row = rows.rows[0]!;
      const scopeHash = highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
        {
          operationFamily: "admin",
          action: input.action,
          teamId: input.teamId,
          targetId: input.targetId
        }
      );
      if (
        row.scope_hash !== scopeHash ||
        row.request_hash !== row.confirmation_request_hash
      )
        return false;
      if (input.action === "workspace_project.leave") {
        const requestHash = highRiskActionGrantCanonicalHash(
          HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
          {
            method: "POST",
            path: `/v1/workspace-projects/${input.targetId}/leave`,
            body: {
              expectedProjectVersion: input.expectedProjectVersion,
              expectedMemberVersion: input.expectedMemberVersion
            }
          }
        );
        if (row.request_hash !== requestHash) return false;
      } else if (!row.operation_id) {
        if (!input.expectedMembershipVersion || !input.expectedTeamVersion)
          return false;
        const requestHash = highRiskActionGrantCanonicalHash(
          HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
          {
            method: "POST",
            path: `/v1/teams/${input.teamId}/leave`,
            body: {
              expectedVersion: input.expectedMembershipVersion,
              expectedTeamVersion: input.expectedTeamVersion,
              expectedOwnedWorkspaceProjects: []
            }
          }
        );
        if (row.request_hash !== requestHash) return false;
      }
      if (row.operation_id) {
        if (
          row.operation_state !== "finished" ||
          row.operation_backend_origin_hash !== input.backendOriginHash ||
          !row.final_membership ||
          !row.operation_owned_projects ||
          !row.operation_expected_team_version ||
          !row.operation_expected_membership_version ||
          row.operation_expected_team_version !== input.expectedTeamVersion ||
          row.operation_expected_membership_version !==
            input.expectedMembershipVersion ||
          !row.operation_copy_manifest_hash
        )
          return false;
        const requestHash = highRiskActionGrantCanonicalHash(
          HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
          {
            method: "POST",
            path: `/v1/teams/${input.teamId}/leave`,
            body: {
              expectedVersion: row.operation_expected_membership_version,
              expectedTeamVersion: row.operation_expected_team_version,
              expectedOwnedWorkspaceProjects: row.operation_owned_projects,
              copyManifestHash: row.operation_copy_manifest_hash
            }
          }
        );
        if (row.request_hash !== requestHash) return false;
      }
      const receipt = await decodeReceiptRow<Record<string, unknown>>(
        provider,
        {
          statusCode: row.status_code,
          receiptBody: row.receipt_body,
          receiptHash: row.receipt_hash
        }
      );
      if (!receipt || receipt.statusCode !== 200) return false;
      if (input.action === "workspace_project.leave") {
        const memberId = receipt.body.memberId;
        if (
          receipt.body.projectId !== input.targetId ||
          receipt.body.access !== "disabled" ||
          typeof memberId !== "string"
        )
          return false;
        const membership = await pool.query<{ id: string }>(
          `select id from team_memberships where id=$1 and team_id=$2 and user_id=$3`,
          [memberId, input.teamId, input.ownerUserId]
        );
        return membership.rows.length === 1;
      }
      if (row.operation_id) {
        const original = receipt.body.operation;
        const final = row.final_membership as Record<string, unknown>;
        return (
          !!original &&
          typeof original === "object" &&
          (original as Record<string, unknown>).operationId ===
            row.operation_id &&
          final.teamId === input.teamId &&
          final.userId === input.ownerUserId &&
          final.status === "disabled"
        );
      }
      const membership = receipt.body.membership as
        | Record<string, unknown>
        | undefined;
      return (
        membership?.teamId === input.teamId &&
        membership.userId === input.ownerUserId &&
        membership.status === "disabled"
      );
    },

    async recoverTeamLeaveOperations(input) {
      const pool = options.pool;
      const provider = options.envelopeEncryptionProvider;
      if (!pool || !provider)
        throw new Error("Team departure recovery custody unavailable");
      if (
        input.operationIds.length > 20 ||
        new Set(input.operationIds).size !== input.operationIds.length
      )
        throw new Error("Team departure recovery IDs are invalid");
      const client = await pool.connect();
      try {
        await client.query("begin");
        // Locking the exact operation makes a read after an interrupted finish
        // wait for its transaction, then observe its committed terminal state.
        const rows = await client.query<{
          id: string;
          state: string;
          copy_manifest_hash: string;
          owned_set_hash: string;
          owned_projects: Array<{ id: string; version: number }>;
          final_membership: Record<string, unknown> | null;
          action_grant_id: string;
          expected_team_version: number;
          expected_membership_version: number;
          continuation_commitment: string;
          request_hash: string;
          confirmation_request_hash: string;
          scope_hash: string;
        }>(
          `select operation.id,operation.state,operation.copy_manifest_hash,
                  operation.owned_set_hash,operation.owned_projects,
                  operation.final_membership,operation.action_grant_id,
                  operation.expected_team_version,operation.expected_membership_version,
                  operation.continuation_commitment,
                  action_grant.request_hash,confirmation.request_hash as confirmation_request_hash,
                  action_grant.scope_hash
             from team_leave_operations operation
             join device_credentials credential on credential.id=operation.device_credential_id
             join users owner_user on owner_user.id=operation.owner_user_id
             join high_risk_device_action_grants action_grant
               on action_grant.id=operation.action_grant_id
             join high_risk_browser_confirmations confirmation
               on confirmation.id=action_grant.confirmation_id
            where operation.team_id=$1 and operation.owner_user_id=$2
              and operation.device_credential_id=$3
              and operation.upstream_backend_id=$4
              and operation.backend_origin_hash=$5
              and ((operation.state='prepared' and $6::boolean)
                or operation.id=any($7::uuid[]))
              and credential.owner_user_id=$2
              and credential.upstream_backend_id=$4
              and credential.credential_version=operation.device_credential_version
              and credential.revoked_at is null
              and (credential.expires_at is null or credential.expires_at>now())
              and 'action_grant'=any(credential.operation_families)
              and owner_user.disabled_at is null and owner_user.deleted_at is null
              and action_grant.owner_user_id=$2 and action_grant.device_credential_id=$3
              and action_grant.upstream_backend_id=$4 and action_grant.team_id=$1
              and action_grant.target_id=$1 and action_grant.action='team.leave'
              and action_grant.operation_family='admin'
              and action_grant.state='consumed' and action_grant.use_count=1
              and action_grant.consumed_at is not null
              and confirmation.state='approved' and confirmation.approval_tier='step_up'
              and confirmation.owner_user_id=$2 and confirmation.device_credential_id=$3
              and confirmation.upstream_backend_id=$4 and confirmation.team_id=$1
              and confirmation.action='team.leave' and confirmation.operation_family='admin'
            order by operation.created_at desc,operation.id desc
            limit 22 for update of operation`,
          [
            input.teamId,
            input.ownerUserId,
            input.deviceCredentialId,
            input.upstreamBackendId,
            input.backendOriginHash,
            input.includePrepared,
            input.operationIds
          ]
        );
        // Twenty explicit Personal stage IDs plus one currently prepared
        // operation is the largest valid bounded request.
        if (rows.rows.length > 21)
          throw new Error("Team departure recovery is not bounded");
        const tx = createDb(client);
        const recovered = [];
        for (const row of rows.rows) {
          const approvedBody = {
            expectedVersion: row.expected_membership_version,
            expectedTeamVersion: row.expected_team_version,
            expectedOwnedWorkspaceProjects: row.owned_projects,
            copyManifestHash: row.copy_manifest_hash
          };
          const expectedHash = highRiskActionGrantCanonicalHash(
            HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
            {
              method: "POST",
              path: `/v1/teams/${input.teamId}/leave`,
              body: approvedBody
            }
          );
          const expectedScope = highRiskActionGrantCanonicalHash(
            HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
            {
              operationFamily: "admin",
              action: "team.leave",
              teamId: input.teamId,
              targetId: input.teamId
            }
          );
          if (
            row.request_hash !== expectedHash ||
            row.confirmation_request_hash !== expectedHash ||
            row.scope_hash !== expectedScope
          )
            throw new Error("Team departure approval binding changed");
          const [stored] = await tx
            .select()
            .from(highRiskActionGrantExecutionReceipts)
            .where(
              eq(
                highRiskActionGrantExecutionReceipts.actionGrantId,
                row.action_grant_id
              )
            )
            .limit(1);
          const receipt = await decodeReceiptRow<{
            operation: {
              operationId: string;
              continuation: string;
              state: string;
              copyManifestHash: string;
              ownedSetHash: string;
            };
          }>(provider, stored ?? null);
          const operation = receipt?.body?.operation;
          if (
            receipt?.statusCode !== 200 ||
            !operation ||
            operation.operationId !== row.id ||
            operation.state !== "prepared" ||
            operation.copyManifestHash !== row.copy_manifest_hash ||
            operation.ownedSetHash !== row.owned_set_hash ||
            typeof operation.continuation !== "string" ||
            createHash("sha256")
              .update(
                `koed:team-leave-continuation:v1\n${operation.continuation}`
              )
              .digest("hex") !== row.continuation_commitment
          )
            throw new Error(
              "Team departure encrypted execution receipt changed"
            );
          recovered.push({
            operationId: row.id,
            continuation: operation.continuation,
            state: row.state as "prepared" | "finished" | "canceled",
            copyManifestHash: row.copy_manifest_hash,
            ownedSetHash: row.owned_set_hash,
            ownedProjects: row.owned_projects,
            finalMembership: row.final_membership
          });
        }
        await client.query("commit");
        return recovered;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async finishPreparedTeamLeave(input) {
      const pool = options.pool;
      if (!pool)
        throw new Error("Team departure needs an atomic database pool");
      const commitment = createHash("sha256")
        .update(`koed:team-leave-continuation:v1\n${input.continuation}`)
        .digest("hex");
      for (let attempt = 0; attempt < 3; attempt++) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const team = await client.query<{
            version: number;
            lifecycle: string;
            entitlement_status: string;
          }>(
            "select version,lifecycle,entitlement_status from teams where id=$1 for update",
            [input.teamId]
          );
          const operation = await client.query<{
            id: string;
            membership_id: string;
            owner_user_id: string;
            device_credential_id: string;
            device_credential_version: number;
            upstream_backend_id: string;
            backend_origin_hash: string;
            action_grant_id: string;
            continuation_commitment: string;
            expected_team_version: number;
            expected_membership_version: number;
            owned_projects: Array<{ id: string; version: number }>;
            owned_set_hash: string;
            copy_manifest_hash: string;
            state: string;
          }>(
            "select * from team_leave_operations where id=$1 and team_id=$2 for update",
            [input.operationId, input.teamId]
          );
          const op = operation.rows[0];
          if (
            !op ||
            op.owner_user_id !== input.ownerUserId ||
            op.device_credential_id !== input.deviceCredentialId ||
            op.upstream_backend_id !== input.upstreamBackendId ||
            op.backend_origin_hash !== input.backendOriginHash ||
            op.continuation_commitment !== commitment ||
            op.copy_manifest_hash !== input.copyManifestHash ||
            op.state !== "prepared" ||
            team.rows[0]?.lifecycle !== "active" ||
            !["active", "grace"].includes(team.rows[0].entitlement_status) ||
            team.rows[0].version !== op.expected_team_version
          ) {
            await client.query("rollback");
            return null;
          }
          const user = await client.query<{
            disabled_at: Date | null;
            deleted_at: Date | null;
          }>(
            "select disabled_at,deleted_at from users where id=$1 for update",
            [input.ownerUserId]
          );
          const member = await client.query<{
            id: string;
            version: number;
            status: string;
            disabled_at: Date | null;
          }>(
            `select id,version,status,disabled_at from team_memberships
              where id=$1 and team_id=$2 and user_id=$3 for update`,
            [op.membership_id, input.teamId, input.ownerUserId]
          );
          const credential = await client.query<{
            credential_version: number;
            revoked_at: Date | null;
            expires_at: Date | null;
            operation_families: string[];
          }>(
            `select credential_version,revoked_at,expires_at,operation_families
               from device_credentials where id=$1 and owner_user_id=$2
                 and upstream_backend_id=$3 for update`,
            [
              input.deviceCredentialId,
              input.ownerUserId,
              input.upstreamBackendId
            ]
          );
          if (
            !user.rows[0] ||
            user.rows[0].disabled_at ||
            user.rows[0].deleted_at ||
            member.rows[0]?.status !== "enabled" ||
            member.rows[0].disabled_at ||
            member.rows[0].version !== op.expected_membership_version ||
            !credential.rows[0] ||
            credential.rows[0].revoked_at ||
            (credential.rows[0].expires_at &&
              credential.rows[0].expires_at <= new Date()) ||
            !credential.rows[0].operation_families.includes("action_grant") ||
            credential.rows[0].credential_version !==
              op.device_credential_version
          ) {
            await client.query("rollback");
            return null;
          }
          const projects = await client.query<{ id: string; version: number }>(
            `select id,version from workspace_projects
               where team_id=$1 and owner_team_member_id=$2 and lifecycle='active'
               order by id for update`,
            [input.teamId, op.membership_id]
          );
          if (
            JSON.stringify(projects.rows) !==
              JSON.stringify(op.owned_projects) ||
            createHash("sha256")
              .update(JSON.stringify(projects.rows))
              .digest("hex") !== op.owned_set_hash
          ) {
            await client.query("rollback");
            return null;
          }
          const approvedBody = {
            expectedVersion: op.expected_membership_version,
            expectedTeamVersion: op.expected_team_version,
            expectedOwnedWorkspaceProjects: op.owned_projects,
            copyManifestHash: op.copy_manifest_hash
          };
          const expectedRequestHash = highRiskActionGrantCanonicalHash(
            HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
            {
              method: "POST",
              path: `/v1/teams/${input.teamId}/leave`,
              body: approvedBody
            }
          );
          const grant = await client.query<{
            id: string;
            request_hash: string;
            state: string;
            use_count: number;
            consumed_at: Date | null;
            request_id: string;
            approval_tier: string;
          }>(
            `select action_grant.id,action_grant.request_hash,action_grant.state,action_grant.use_count,action_grant.consumed_at,
                    confirmation.client_request_id as request_id,confirmation.approval_tier
               from high_risk_device_action_grants action_grant
               join high_risk_browser_confirmations confirmation
                 on confirmation.id=action_grant.confirmation_id
               join high_risk_action_grant_execution_receipts receipt
                 on receipt.action_grant_id=action_grant.id
              where action_grant.id=$1 and action_grant.owner_user_id=$2
                and action_grant.device_credential_id=$3 and action_grant.upstream_backend_id=$4
                and action_grant.team_id=$5 and action_grant.target_id=$5 and action_grant.action='team.leave'
                and confirmation.state='approved'
                and confirmation.owner_user_id=$2
                and confirmation.device_credential_id=$3
                and confirmation.upstream_backend_id=$4
              for update of action_grant,confirmation`,
            [
              op.action_grant_id,
              input.ownerUserId,
              input.deviceCredentialId,
              input.upstreamBackendId,
              input.teamId
            ]
          );
          const approved = grant.rows[0];
          if (
            !approved ||
            approved.state !== "consumed" ||
            approved.use_count !== 1 ||
            !approved.consumed_at ||
            approved.approval_tier !== "step_up" ||
            approved.request_hash !== expectedRequestHash
          ) {
            await client.query("rollback");
            return null;
          }
          await client.query(
            `update team_leave_operations set state='finalizing',updated_at=now()
              where id=$1 and state='prepared'`,
            [op.id]
          );
          const scoped = buildScopedRepositories(
            client,
            options.envelopeEncryptionProvider,
            options.teamEnvelopeEncryptionProvider,
            options.ownerPrivateReplicaEnvelopeEncryptionProvider,
            {
              action: "team.leave",
              actorUserId: input.ownerUserId,
              teamId: input.teamId,
              targetId: input.teamId,
              actionGrantId: approved.id,
              requestId: approved.request_id,
              requestHash: approved.request_hash,
              approvalTier: "step_up",
              requestBody: approvedBody
            }
          );
          const membership = await scoped.team.leaveTeam(
            { userId: input.ownerUserId },
            {
              teamId: input.teamId,
              expectedVersion: op.expected_membership_version,
              expectedTeamVersion: op.expected_team_version,
              expectedOwnedWorkspaceProjects: op.owned_projects
            }
          );
          if (!membership) {
            await client.query("rollback");
            return null;
          }
          await client.query(
            `update team_leave_operations
                set state='finished',final_membership=$2::jsonb,
                    completed_at=now(),updated_at=now()
              where id=$1 and state='finalizing'`,
            [op.id, JSON.stringify(membership)]
          );
          await client.query("commit");
          return { state: "finished" as const, membership };
        } catch (error) {
          await client.query("rollback");
          const code = (error as { code?: unknown }).code;
          if (attempt < 2 && (code === "40P01" || code === "40001")) continue;
          throw error;
        } finally {
          client.release();
        }
      }
      return null;
    },

    async lookupLegalHoldTeamId(holdId) {
      const [row] = await db
        .select({ teamId: legalHolds.teamId })
        .from(legalHolds)
        .where(eq(legalHolds.id, holdId))
        .limit(1);
      return row?.teamId ?? null;
    },

    async getLegalHoldApprovalReview(holdId) {
      const [row] = await db
        .select({
          id: legalHolds.id,
          teamId: legalHolds.teamId,
          teamName: teams.name,
          scope: legalHolds.scope,
          state: legalHolds.state
        })
        .from(legalHolds)
        .innerJoin(teams, eq(teams.id, legalHolds.teamId))
        .where(eq(legalHolds.id, holdId))
        .limit(1);
      return row?.teamId ? { ...row, teamId: row.teamId } : null;
    },

    async expireBrowserConfirmations() {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(highRiskBrowserConfirmations)
          .set({ state: "expired" })
          .where(
            and(
              eq(highRiskBrowserConfirmations.state, "pending"),
              isNull(highRiskBrowserConfirmations.revokedAt),
              sql`${highRiskBrowserConfirmations.expiresAt} <= now()`
            )
          )
          .returning();

        for (const confirmation of rows) {
          await insertAudit(tx, {
            ownerUserId: confirmation.ownerUserId,
            teamId: confirmation.teamId,
            action: "high_risk.browser_confirmation.expired",
            targetTable: "high_risk_browser_confirmations",
            targetId: confirmation.id,
            metadata: confirmationAuditMetadata(confirmation)
          });
          await notifyActionGrantWithDb(tx, confirmation.clientRequestId);
        }
        return rows.length;
      });
    },

    async expireActionGrants() {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(highRiskDeviceActionGrants)
          .set({ state: "expired" })
          .where(
            and(
              eq(highRiskDeviceActionGrants.state, "active"),
              eq(highRiskDeviceActionGrants.useCount, 0),
              isNull(highRiskDeviceActionGrants.consumedAt),
              isNull(highRiskDeviceActionGrants.revokedAt),
              sql`${highRiskDeviceActionGrants.expiresAt} <= now()`
            )
          )
          .returning();

        const publicReferences =
          rows.length === 0
            ? new Map<string, string>()
            : new Map(
                (
                  await tx
                    .select({
                      grantId: highRiskDeviceActionGrants.id,
                      publicReferenceId:
                        highRiskBrowserConfirmations.clientRequestId
                    })
                    .from(highRiskDeviceActionGrants)
                    .innerJoin(
                      highRiskBrowserConfirmations,
                      eq(
                        highRiskBrowserConfirmations.id,
                        highRiskDeviceActionGrants.confirmationId
                      )
                    )
                    .where(
                      inArray(
                        highRiskDeviceActionGrants.id,
                        rows.map((grant) => grant.id)
                      )
                    )
                ).map((row) => [row.grantId, row.publicReferenceId])
              );

        for (const grant of rows) {
          const publicReferenceId = publicReferences.get(grant.id);
          if (!publicReferenceId) {
            throw new Error(
              "Expired Action Grant is missing its public reference"
            );
          }
          await insertAudit(tx, {
            ownerUserId: grant.ownerUserId,
            teamId: grant.teamId,
            action: "high_risk.action_grant.expired",
            targetTable: "high_risk_device_action_grants",
            targetId: grant.id,
            metadata: grantAuditMetadata(grant, publicReferenceId)
          });
        }
        return rows.length;
      });
    }
  };
};
