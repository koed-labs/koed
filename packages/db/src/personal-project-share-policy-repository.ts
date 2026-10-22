import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID
} from "node:crypto";
import type pg from "pg";
import {
  crossIdentitySyncDeterministicUuid,
  signProjectSharePolicyProof,
  type EnvelopeEncryptionProvider,
  type EncryptedPayloadEnvelope,
  type ProjectSharePolicyProof
} from "@koed/shared";
import { capturedSessionMayLeavePersonalBoundary } from "./project-hq-privacy.js";
import { ensureCapturedSessionSourceRevision } from "./cross-identity-sync-repository.js";
import type { ProjectShareManifestEntry } from "./project-share-policy-repository.js";

export class PersonalProjectSharePolicyConflictError extends Error {
  readonly statusCode = 409;
}
export class PersonalProjectSharePolicyUnavailableError extends Error {
  readonly statusCode = 503;
}

export interface PersonalProjectSharePolicyRepository {
  prepareExplicitOffer(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    teamPrincipalUserId: string;
    deviceCredentialId: string;
    reason: "moved_in" | "share_again";
    logicalMemoryId: string;
    mappingRevision: number;
    sourceRevision: number;
    candidateHash: string;
  }): Promise<{ offerId: string; mutationId: string; expiresAt: string }>;
  readExplicitOffer(input: {
    ownerUserId: string;
    projectId: string;
    offerId: string;
    teamBackendId: string;
    historical?: boolean;
  }): Promise<{
    offerId: string;
    mutationId: string;
    expiresAt: string;
    state: string;
    sessionId: string;
    workspaceProjectId: string;
    reason: string;
    logicalMemoryId: string;
    mappingRevision: number;
    sourceRevision: number;
    candidateHash: string;
    teamPrincipalUserId: string;
    deviceCredentialId: string;
    remotePendingShareId: string | null;
    remoteShareGrantId: string | null;
    remoteGrantVersion: number | null;
  }>;
  settleExplicitOffer(input: {
    ownerUserId: string;
    projectId: string;
    offerId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    mutationId: string;
    pendingShareId: string;
    shareGrantId: string;
    grantVersion: number;
    teamId: string;
    teamWorkspaceId: string;
    state: "accepted" | "activated";
  }): Promise<void>;
  blockExplicitOffer(input: {
    ownerUserId: string;
    projectId: string;
    offerId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    mutationId: string;
  }): Promise<void>;
  hasExactGrantBinding(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    shareGrantId: string;
    grantVersion: number;
  }): Promise<boolean>;
  beginPrivate(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    expectedProjectAssignmentVersion: number;
  }): Promise<void>;
  listOpenExplicitOffers(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<string[]>;
  beginMoveFence(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<{
    fenceId: string;
    mappingRevision: number;
  }>;
  acknowledgeMoveFence(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    fenceId: string;
    mappingRevision: number;
  }): Promise<void>;
  releaseMoveFence(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    fenceId: string;
  }): Promise<void>;
  currentMoveFence(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<
    | { state: "none" }
    | {
        state: "preparing" | "acknowledged";
        fenceId: string;
        mappingRevision: number;
      }
  >;
  localPolicyState(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<{
    policyVersion: number | null;
    deviceCredentialId: string | null;
    signingPublicKey: string | null;
    currentBindingHash: string;
  }>;
  projectBindingHash(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<string>;
  beginAttempt(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    action: "enable" | "revoke";
    clientRequestId: string;
    actionGrantId: string;
    teamId: string;
    teamPrincipalUserId: string;
    payloadHash: string;
    entries?: ProjectShareManifestEntry[];
    deviceCredentialId: string;
    expectedPolicyVersion: number;
    manifestId?: string;
    manifestHash?: string;
  }): Promise<{ attemptId: string }>;
  pendingAttempts(input: {
    ownerUserId: string;
    projectId: string;
    currentScope?: {
      teamBackendId: string;
      workspaceProjectId: string;
      teamId: string;
      teamPrincipalUserId: string;
      deviceCredentialId: string;
    };
  }): Promise<
    Array<{
      attemptId: string;
      teamBackendId: string;
      workspaceProjectId: string;
      action: "enable" | "revoke";
      clientRequestId: string;
      actionGrantId: string;
      payloadHash: string;
      teamId: string;
      teamPrincipalUserId: string;
      deviceCredentialId: string;
      expectedPolicyVersion: number;
      manifestId?: string;
      manifestHash?: string;
    }>
  >;
  assertAttemptCurrent(input: {
    ownerUserId: string;
    projectId: string;
    attemptId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    teamId: string;
    teamPrincipalUserId: string;
    deviceCredentialId: string;
  }): Promise<void>;
  finalizeAttempt(input: {
    ownerUserId: string;
    projectId: string;
    attemptId: string;
    action: "enable" | "revoke";
    expectedPolicyVersion: number;
    deviceCredentialId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<void>;
  terminalAttempt(input: {
    ownerUserId: string;
    projectId: string;
    attemptId: string;
  }): Promise<void>;
  listActivePolicyProjects(
    ownerUserId: string,
    cursor?: string
  ): Promise<{
    projects: Array<{
      projectId: string;
      teamBackendId: string;
      workspaceProjectId: string;
      policyVersion: number;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  signFutureProof(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    teamPrincipalUserId: string;
    workspaceProjectId: string;
    deviceCredentialId: string;
    policyId: string;
    ownerTeamMemberId: string;
    policyVersion: number;
    personalProjectBindingHash: string;
    entry: ProjectShareManifestEntry;
    candidateHash: string;
    closureHash: string;
  }): Promise<ProjectSharePolicyProof>;
  prepareSigningKey(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    deviceCredentialId: string;
    policyVersion: number;
  }): Promise<{ signingPublicKey: string }>;
  reserveLocalIssue(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    policyVersion: number;
    provenance: "initial" | "future";
    entry: ProjectShareManifestEntry;
  }): Promise<{ issueId: string }>;
  attachRemotePending(input: {
    ownerUserId: string;
    issueId: string;
    pendingShareId: string;
  }): Promise<void>;
  listUnsettledIssues(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    sessionId?: string;
    cursor?: string;
  }): Promise<{
    issues: Array<{
      issueId: string;
      sessionId: string;
      logicalMemoryId: string;
      teamBackendId: string;
      workspaceProjectId: string;
      policyVersion: number;
      mappingRevision: number;
      sourceRevision: number;
      remotePendingShareId: string | null;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  reconcileActivatedIssue(input: {
    ownerUserId: string;
    projectId: string;
    issueId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    policyVersion: number;
    mappingRevision: number;
    sourceRevision: number;
    remotePendingShareId: string;
    logicalMemoryId: string;
    teamId: string;
    teamWorkspaceId: string;
    shareGrantId: string;
    grantVersion: number;
  }): Promise<void>;
  reconcileTerminalIssue(input: {
    ownerUserId: string;
    projectId: string;
    issueId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    policyVersion: number;
    mappingRevision: number;
    sourceRevision: number;
    remotePendingShareId: string;
    shareGrantId: string;
    grantVersion: number;
    grantLifecycle: string;
  }): Promise<void>;
  freezeUnpublishedIssue(input: {
    ownerUserId: string;
    projectId: string;
    issueId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    mappingRevision: number;
  }): Promise<void>;
  buildInitialManifest(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<{
    personalProjectBindingHash: string;
    entries: ProjectShareManifestEntry[];
  }>;
  listInitialManifestSources(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<Array<{ sessionId: string; mappingRevision: number }>>;
  prepareInitialManifestSource(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    sessionId: string;
    mappingRevision: number;
    logicalMemoryId: string;
    sourceRevision: number;
    sourceDeploymentProtocolId: string;
  }): Promise<void>;
  activateLocalPolicy(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    version: number;
    deviceCredentialId: string;
  }): Promise<void>;
  revokeLocalPolicy(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    expectedVersion: number;
  }): Promise<void>;
  listFutureSourceCandidates(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    policyVersion: number;
    cursor?: string;
  }): Promise<{
    entries: Array<{ sessionId: string; mappingRevision: number }>;
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  exactFutureSourceCandidate(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    policyVersion: number;
    sessionId: string;
  }): Promise<{ sessionId: string; mappingRevision: number } | null>;
  listFutureEligible(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    policyVersion: number;
    cursor?: string;
  }): Promise<{
    entries: ProjectShareManifestEntry[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  exactFutureEligible(input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    policyVersion: number;
    sessionId: string;
  }): Promise<ProjectShareManifestEntry | null>;
  markPrivate(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    expectedProjectAssignmentVersion: number;
  }): Promise<void>;
  inspectPrivateTarget(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
  }): Promise<{ mappingRevision: number; alreadyPrivate: boolean }>;
  sessionStatus(input: {
    ownerUserId: string;
    projectId: string;
    sessionId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  }): Promise<{
    state: "ineligible" | "private" | "pending" | "shared" | "unshared";
    mappingRevision: number;
  }>;
}

const hashProjectBinding = (
  input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  },
  linkEpoch: string
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "koed.project-share-policy.personal-project/v1",
        input.ownerUserId,
        input.projectId,
        input.teamBackendId,
        input.workspaceProjectId,
        linkEpoch
      ])
    )
    .digest("hex");

interface ProjectRow {
  id: string;
  project_share_policy_version: number | null;
  project_share_policy_device_credential_id: string | null;
  share_policy_link_epoch: string;
}
const project = async (
  client: pg.Pool | pg.PoolClient,
  input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
  },
  lock = false
): Promise<ProjectRow> => {
  const result = await client.query<ProjectRow>(
    `select id,project_share_policy_version,project_share_policy_device_credential_id,
            share_policy_link_epoch from projects
      where id=$1 and owner_user_id=$2 and team_backend_id=$3
        and workspace_project_id=$4 and lifecycle='active'
        and deletion_phase is null ${lock ? "for update" : ""}`,
    [
      input.projectId,
      input.ownerUserId,
      input.teamBackendId,
      input.workspaceProjectId
    ]
  );
  if (!result.rows[0])
    throw new PersonalProjectSharePolicyUnavailableError(
      "Exact shared Personal Project unavailable"
    );
  return result.rows[0];
};
interface SessionRow {
  session_id: string;
  logical_memory_id: string;
  source_revision: string;
  mapping_revision: number;
  review_label: string;
}
const safeReviewLabel = (label: string, sessionId: string): string => {
  const cleaned = label
    .replace(
      /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu,
      " "
    )
    .replace(/\s+/gu, " ")
    .trim();
  const initial = cleaned || `Captured Session ${sessionId.slice(0, 8)}`;
  let bounded = "";
  for (const character of initial) {
    if (Buffer.byteLength(bounded + character, "utf8") > 160) break;
    bounded += character;
  }
  return bounded;
};
const futureSourceRows = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    projectId: string;
    workspaceProjectId: string;
    policyVersion: number;
    linkEpoch: string;
    deviceCredentialId: string;
    cursor?: string;
    targetSessionId?: string;
  }
): Promise<{
  entries: Array<{ sessionId: string; mappingRevision: number }>;
  nextCursor: string | null;
  hasMore: boolean;
}> => {
  const limit = input.targetSessionId ? 1 : 20;
  const result = await client.query<{
    session_id: string;
    mapping_revision: number;
  }>(
    `select session.id as session_id,
            session.project_assignment_version as mapping_revision
       from sessions session
      where session.owner_user_id=$1 and session.visibility='personal'
        and (case when session.project_override_at is not null
              then session.project_override_personal_project_id
              else session.automatic_personal_project_id end)=$2
        and session.project_share_capture_workspace_project_id=$3
        and session.project_share_capture_policy_version=$4
        and session.project_share_capture_link_epoch=$5
        and session.project_share_capture_device_credential_id=$6
        and session.project_share_capture_context_version is not null
        and session.project_share_capture_prepared_at is not null
        and session.project_share_capture_prepared_at<=session.created_at
        and session.project_share_private_at is null
        and session.project_share_private_pending_at is null
        and session.project_share_move_pending_at is null
        and session.source_kind is not null
        and session.source_adapter_version is not null
        and coalesce(session.external_thread_id,session.external_session_id) is not null
        and session.personal_deleted_at is null and session.invalidated_at is null
        and session.delete_batch_id is null and session.forget_batch_id is null
        and session.trashed_at is null
        and exists (
          select 1 from conversation_source_artifacts artifact
           where artifact.session_id=session.id and artifact.owner_user_id=$1
             and artifact.replica_role='origin_local'
        )
        and not exists (
          select 1 from project_share_private_conversations private
           where private.owner_user_id=$1
             and private.source_runtime=session.source_runtime
             and private.source_kind=session.source_kind
             and private.source_adapter_version=session.source_adapter_version
             and private.external_conversation_id=coalesce(
               session.external_thread_id,session.external_session_id)
        )
        and not exists (
          select 1 from project_share_local_issues issue
           where issue.owner_user_id=$1 and issue.session_id=session.id
        )
        and not exists (
          select 1 from project_policy_session_grants grant_row
           where grant_row.owner_user_id=$1 and grant_row.session_id=session.id
        )
        and not exists (
          select 1 from project_share_explicit_offers offer
           where offer.owner_user_id=$1 and offer.session_id=session.id
        )
        and ($7::uuid is null or session.id>$7)
        and ($8::uuid is null or session.id=$8)
      order by session.id limit $9`,
    [
      input.ownerUserId,
      input.projectId,
      input.workspaceProjectId,
      input.policyVersion,
      input.linkEpoch,
      input.deviceCredentialId,
      input.cursor ?? null,
      input.targetSessionId ?? null,
      limit + 1
    ]
  );
  const entries: Array<{ sessionId: string; mappingRevision: number }> = [];
  const page = result.rows.slice(0, limit);
  for (const row of page) {
    if (
      await capturedSessionMayLeavePersonalBoundary(
        client,
        input.ownerUserId,
        row.session_id
      )
    )
      entries.push({
        sessionId: row.session_id,
        mappingRevision: row.mapping_revision
      });
  }
  return {
    entries,
    nextCursor: page.at(-1)?.session_id ?? null,
    hasMore: result.rows.length > limit
  };
};
const sessionRows = async (
  client: pg.Pool | pg.PoolClient,
  input: {
    ownerUserId: string;
    projectId: string;
    workspaceProjectId?: string;
    policyVersion?: number;
    cursor?: string;
    targetSessionId?: string;
    limit?: number;
  }
): Promise<{
  entries: ProjectShareManifestEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}> => {
  const limit = input.limit ?? 100;
  const initialManifest =
    limit === 100 && !input.cursor && !input.targetSessionId;
  const entries: ProjectShareManifestEntry[] = [];
  let nextCursor = input.cursor ?? null;
  let hasMore: boolean;
  do {
    const result = await client.query<SessionRow>(
      `select session.id as session_id,local.logical_memory_id,
            memory.latest_source_revision::text as source_revision,
            session.project_assignment_version as mapping_revision,
            left(artifact.redacted_source_label,160) as review_label
       from sessions session
       join lateral (
         select redacted_source_label from conversation_source_artifacts
          where session_id=session.id and owner_user_id=$1
            and replica_role='origin_local'
          order by created_at desc,id desc limit 1
       ) artifact on true
       join local_captured_session_logical_memories local
         on local.local_session_id=session.id and local.owner_user_id=$1
       join logical_memories memory on memory.id=local.logical_memory_id
         and memory.owner_user_id=$1 and memory.source_kind='captured_session' and memory.latest_source_revision>0
       join captured_session_source_revisions source_revision
         on source_revision.logical_memory_id=memory.id
        and source_revision.owner_principal_id=memory.owner_principal_id
        and source_revision.source_session_id=session.id
        and source_revision.source_cursor=memory.latest_source_revision
      where session.owner_user_id=$1 and session.visibility='personal'
        and (case when session.project_override_at is not null
              then session.project_override_personal_project_id
              else session.automatic_personal_project_id end)=$2
        and session.project_share_private_at is null
        and session.project_share_private_pending_at is null
        and session.project_share_move_pending_at is null
        and session.source_kind is not null
        and session.source_adapter_version is not null
        and coalesce(session.external_thread_id,session.external_session_id) is not null
        and not exists (
          select 1 from project_share_private_conversations private
           where private.owner_user_id=$1
             and private.source_runtime=session.source_runtime
             and private.source_kind=session.source_kind
             and private.source_adapter_version=session.source_adapter_version
             and private.external_conversation_id=coalesce(session.external_thread_id,session.external_session_id)
        )
        and session.personal_deleted_at is null and session.invalidated_at is null
        and session.delete_batch_id is null and session.forget_batch_id is null
        and session.trashed_at is null
        and ($3::uuid is null or
             (session.project_share_capture_workspace_project_id=$3
              and session.project_share_capture_policy_version=$4
              and session.project_share_capture_link_epoch=(
                select share_policy_link_epoch from projects
                 where id=$2 and owner_user_id=$1)))
        and ($5::uuid is null or session.id>$5)
        and ($6::uuid is null or session.id=$6)
      order by session.id limit $7`,
      [
        input.ownerUserId,
        input.projectId,
        input.workspaceProjectId ?? null,
        input.policyVersion ?? null,
        nextCursor,
        input.targetSessionId ?? null,
        limit + 1
      ]
    );
    const pageRows = initialManifest
      ? result.rows
      : result.rows.slice(0, limit);
    for (const row of pageRows) {
      if (
        !(await capturedSessionMayLeavePersonalBoundary(
          client,
          input.ownerUserId,
          row.session_id
        ))
      )
        continue;
      const revision = Number(row.source_revision);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        !Number.isSafeInteger(row.mapping_revision) ||
        row.mapping_revision < 1
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Source or mapping revision unavailable"
        );
      entries.push({
        sessionId: row.session_id,
        logicalMemoryId: row.logical_memory_id,
        sourceRevision: revision,
        mappingRevision: row.mapping_revision,
        reviewLabel: safeReviewLabel(row.review_label, row.session_id)
      });
      if (initialManifest && entries.length > 100)
        throw new PersonalProjectSharePolicyConflictError(
          "More than 100 eligible Captured Sessions exceed this policy's initial review limit"
        );
    }
    nextCursor = pageRows.at(-1)?.session_id ?? null;
    hasMore = result.rows.length > limit;
    if (!initialManifest) break;
  } while (hasMore);
  return { entries, nextCursor, hasMore };
};
const transaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

export const createPersonalProjectSharePolicyRepository = (
  pool: pg.Pool,
  encryptionProvider?: EnvelopeEncryptionProvider
): PersonalProjectSharePolicyRepository => ({
  async prepareExplicitOffer(input) {
    if (!/^[a-f0-9]{64}$/.test(input.candidateHash))
      throw new PersonalProjectSharePolicyConflictError(
        "Candidate hash invalid"
      );
    return transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const source = await client.query<{
        logical_memory_id: string;
        project_assignment_version: number;
        latest_source_revision: string;
        project_share_private_at: Date | null;
        conversation_private: boolean;
      }>(
        `select local.logical_memory_id,session.project_assignment_version,
                memory.latest_source_revision::text,session.project_share_private_at,
                exists(select 1 from project_share_private_conversations private
                  where private.owner_user_id=session.owner_user_id
                    and private.source_runtime=session.source_runtime
                    and private.source_kind=session.source_kind
                    and private.source_adapter_version=session.source_adapter_version
                    and private.external_conversation_id=coalesce(
                      session.external_thread_id,session.external_session_id))
                  as conversation_private
           from sessions session
           join local_captured_session_logical_memories local
             on local.local_session_id=session.id and local.owner_user_id=session.owner_user_id
           join logical_memories memory on memory.id=local.logical_memory_id
             and memory.owner_user_id=session.owner_user_id
             and memory.source_kind='captured_session'
          where session.id=$1 and session.owner_user_id=$2
            and session.visibility='personal'
            and (case when session.project_override_at is not null
                 then session.project_override_personal_project_id
                 else session.automatic_personal_project_id end)=$3
            and session.project_share_private_pending_at is null
            and session.project_share_move_pending_at is null
            and session.personal_deleted_at is null and session.invalidated_at is null
            and session.delete_batch_id is null and session.forget_batch_id is null
            and session.trashed_at is null for update of session`,
        [input.sessionId, input.ownerUserId, input.projectId]
      );
      const row = source.rows[0];
      if (
        !row ||
        row.logical_memory_id !== input.logicalMemoryId ||
        row.project_assignment_version !== input.mappingRevision ||
        Number(row.latest_source_revision) !== input.sourceRevision ||
        !(await capturedSessionMayLeavePersonalBoundary(
          client,
          input.ownerUserId,
          input.sessionId
        ))
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Conversation source changed"
        );
      const isPrivate = Boolean(
        row.project_share_private_at || row.conversation_private
      );
      if ((input.reason === "share_again") !== isPrivate)
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Conversation disclosure reason changed"
        );
      const prior = await client.query<{ id: string }>(
        `select id from project_share_explicit_offers
          where owner_user_id=$1 and project_id=$2 and session_id=$3
            and backend_id=$4 and workspace_project_id=$5
            and state in ('prepared','pending','accepted') and expires_at>now()
          order by created_at desc limit 1 for update`,
        [
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.teamBackendId,
          input.workspaceProjectId
        ]
      );
      if (prior.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Conversation offer remains pending; reconcile it first"
        );
      const inserted = await client.query<{
        id: string;
        mutation_id: string;
        expires_at: Date;
      }>(
        `insert into project_share_explicit_offers
         (owner_user_id,project_id,session_id,logical_memory_id,backend_id,
          workspace_project_id,team_principal_user_id,device_credential_id,
          link_epoch,reason,mapping_revision,source_revision,candidate_hash,
          mutation_id,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+interval '10 minutes')
         returning id,mutation_id,expires_at`,
        [
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.logicalMemoryId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.teamPrincipalUserId,
          input.deviceCredentialId,
          current.share_policy_link_epoch,
          input.reason,
          input.mappingRevision,
          input.sourceRevision,
          input.candidateHash,
          randomUUID()
        ]
      );
      return {
        offerId: inserted.rows[0]!.id,
        mutationId: inserted.rows[0]!.mutation_id,
        expiresAt: inserted.rows[0]!.expires_at.toISOString()
      };
    });
  },
  async readExplicitOffer(input) {
    return transaction(pool, async (client) => {
      const offer = await client.query<{ workspace_project_id: string }>(
        `select workspace_project_id from project_share_explicit_offers
          where id=$1 and owner_user_id=$2 and project_id=$3 and backend_id=$4`,
        [input.offerId, input.ownerUserId, input.projectId, input.teamBackendId]
      );
      if (!offer.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Conversation offer unavailable"
        );
      const current = await project(client, {
        ...input,
        workspaceProjectId: offer.rows[0].workspace_project_id
      });
      const result = await client.query<{
        id: string;
        mutation_id: string;
        expires_at: Date;
        state: string;
        session_id: string;
        workspace_project_id: string;
        reason: string;
        logical_memory_id: string;
        mapping_revision: number;
        source_revision: string;
        candidate_hash: string;
        team_principal_user_id: string;
        device_credential_id: string;
        remote_pending_share_id: string | null;
        remote_share_grant_id: string | null;
        remote_grant_version: number | null;
      }>(
        `select offer.* from project_share_explicit_offers offer
           join sessions session on session.id=offer.session_id
             and session.owner_user_id=offer.owner_user_id
           join logical_memories memory on memory.id=offer.logical_memory_id
             and memory.owner_user_id=offer.owner_user_id
          where offer.id=$1 and offer.owner_user_id=$2 and offer.project_id=$3
            and offer.backend_id=$4 and offer.link_epoch=$5
            and ($6::boolean or offer.expires_at>now())
            and ($6::boolean or (memory.latest_source_revision=offer.source_revision
              and session.project_assignment_version=offer.mapping_revision))
            and ($6::boolean or (case when session.project_override_at is not null
                 then session.project_override_personal_project_id
                 else session.automatic_personal_project_id end)=offer.project_id)
            and ($6::boolean or (session.personal_deleted_at is null
              and session.invalidated_at is null))`,
        [
          input.offerId,
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          current.share_policy_link_epoch,
          input.historical === true
        ]
      );
      const row = result.rows[0];
      if (!row)
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Conversation offer expired or changed"
        );
      return {
        offerId: row.id,
        mutationId: row.mutation_id,
        expiresAt: row.expires_at.toISOString(),
        state: row.state,
        sessionId: row.session_id,
        workspaceProjectId: row.workspace_project_id,
        reason: row.reason,
        logicalMemoryId: row.logical_memory_id,
        mappingRevision: row.mapping_revision,
        sourceRevision: Number(row.source_revision),
        candidateHash: row.candidate_hash,
        teamPrincipalUserId: row.team_principal_user_id,
        deviceCredentialId: row.device_credential_id,
        remotePendingShareId: row.remote_pending_share_id,
        remoteShareGrantId: row.remote_share_grant_id,
        remoteGrantVersion: row.remote_grant_version
      };
    });
  },
  async settleExplicitOffer(input) {
    await transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const updated = await client.query<{
        id: string;
        session_id: string;
        reason: string;
        logical_memory_id: string;
        mapping_revision: number;
      }>(
        `update project_share_explicit_offers offer
            set state=$9,remote_pending_share_id=$7,remote_share_grant_id=$8,
                remote_grant_version=$10,updated_at=now()
          from sessions session
         where offer.id=$1 and offer.owner_user_id=$2 and offer.project_id=$3
           and offer.backend_id=$4 and offer.workspace_project_id=$5
           and offer.mutation_id=$6 and offer.link_epoch=$11
           and offer.state in ('prepared','pending','accepted','activated')
           and (offer.remote_pending_share_id is null or offer.remote_pending_share_id=$7)
           and session.id=offer.session_id and session.owner_user_id=offer.owner_user_id
           and session.project_assignment_version=offer.mapping_revision
           and session.personal_deleted_at is null and session.invalidated_at is null
         returning offer.id,offer.session_id,offer.reason,
           offer.logical_memory_id,offer.mapping_revision`,
        [
          input.offerId,
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.mutationId,
          input.pendingShareId,
          input.shareGrantId,
          input.state,
          input.grantVersion,
          current.share_policy_link_epoch
        ]
      );
      if (!updated.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Conversation offer changed before Team acknowledgment"
        );
      if (input.state === "activated") {
        const source = updated.rows[0];
        const binding = await client.query(
          `insert into project_policy_session_grants
           (owner_user_id,session_id,project_id,backend_id,logical_memory_id,
            team_id,team_workspace_id,share_grant_id,origin,policy_generation,
            mapping_version,grant_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'manual',null,$9,$10)
           on conflict (backend_id,share_grant_id) do update
             set grant_version=excluded.grant_version
           where project_policy_session_grants.owner_user_id=excluded.owner_user_id
             and project_policy_session_grants.session_id=excluded.session_id
             and project_policy_session_grants.project_id=excluded.project_id
             and project_policy_session_grants.logical_memory_id=excluded.logical_memory_id
             and project_policy_session_grants.origin='manual'
             and project_policy_session_grants.mapping_version=excluded.mapping_version
           returning id`,
          [
            input.ownerUserId,
            source.session_id,
            input.projectId,
            input.teamBackendId,
            source.logical_memory_id,
            input.teamId,
            input.teamWorkspaceId,
            input.shareGrantId,
            source.mapping_revision,
            input.grantVersion
          ]
        );
        if (!binding.rows[0])
          throw new PersonalProjectSharePolicyConflictError(
            "Explicit Project grant binding changed before local settlement"
          );
      }
      if (updated.rows[0].reason === "share_again")
        await client.query(
          `update sessions set project_share_private_at=null
          where id=$1 and owner_user_id=$2`,
          [updated.rows[0].session_id, input.ownerUserId]
        );
    });
  },
  async blockExplicitOffer(input) {
    await transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const updated = await client.query(
        `update project_share_explicit_offers
            set state='blocked',updated_at=now()
          where id=$1 and owner_user_id=$2 and project_id=$3
            and backend_id=$4 and workspace_project_id=$5
            and mutation_id=$6 and link_epoch=$7
            and state in ('prepared','pending','accepted','activated','blocked')
          returning id`,
        [
          input.offerId,
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.mutationId,
          current.share_policy_link_epoch
        ]
      );
      if (!updated.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Conversation offer could not be fenced"
        );
    });
  },
  async hasExactGrantBinding(input) {
    return transaction(pool, async (client) => {
      await project(client, input, true);
      const result = await client.query(
        `update project_policy_session_grants binding
            set grant_version=$6
           from sessions session
          where binding.owner_user_id=$1 and binding.project_id=$2
            and binding.session_id=$3 and binding.backend_id=$4
            and binding.share_grant_id=$5 and binding.grant_version<=$6
            and session.id=binding.session_id
            and session.owner_user_id=binding.owner_user_id
            and session.project_assignment_version=binding.mapping_version
            and (case when session.project_override_at is not null
                  then session.project_override_personal_project_id
                  else session.automatic_personal_project_id end)=$2
            and session.personal_deleted_at is null and session.invalidated_at is null
          returning binding.id`,
        [
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.teamBackendId,
          input.shareGrantId,
          input.grantVersion
        ]
      );
      return Boolean(result.rows[0]);
    });
  },
  async localPolicyState(input) {
    const current = await project(pool, input);
    const key =
      current.project_share_policy_version &&
      current.project_share_policy_device_credential_id
        ? await pool.query<{ public_key: string }>(
            `select public_key from project_share_policy_signing_keys
          where owner_user_id=$1 and project_id=$2 and backend_id=$3
            and workspace_project_id=$4 and policy_version=$5
            and device_credential_id=$6 and link_epoch=$7`,
            [
              input.ownerUserId,
              input.projectId,
              input.teamBackendId,
              input.workspaceProjectId,
              current.project_share_policy_version,
              current.project_share_policy_device_credential_id,
              current.share_policy_link_epoch
            ]
          )
        : null;
    return {
      policyVersion: current.project_share_policy_version,
      deviceCredentialId: current.project_share_policy_device_credential_id,
      signingPublicKey: key?.rows[0]?.public_key ?? null,
      currentBindingHash: hashProjectBinding(
        input,
        current.share_policy_link_epoch
      )
    };
  },
  async projectBindingHash(input) {
    const current = await project(pool, input);
    return hashProjectBinding(input, current.share_policy_link_epoch);
  },
  async beginAttempt(input) {
    if (!encryptionProvider)
      throw new PersonalProjectSharePolicyUnavailableError(
        "Policy attempt custody unavailable"
      );
    return transaction(pool, async (client) => {
      const currentProject = await project(client, input, true);
      if (input.action === "enable") {
        if (!input.entries)
          throw new PersonalProjectSharePolicyConflictError(
            "Exact initial manifest unavailable"
          );
        for (const entry of input.entries) {
          const current = await sessionRows(client, {
            ownerUserId: input.ownerUserId,
            projectId: input.projectId,
            targetSessionId: entry.sessionId
          });
          if (
            !current.entries.some(
              (source) =>
                source.sessionId === entry.sessionId &&
                source.logicalMemoryId === entry.logicalMemoryId &&
                source.sourceRevision === entry.sourceRevision &&
                source.mappingRevision === entry.mappingRevision &&
                source.reviewLabel === entry.reviewLabel
            )
          )
            throw new PersonalProjectSharePolicyConflictError(
              "Initial manifest source or privacy changed before effect"
            );
        }
      }
      const existing = await client.query<{
        id: string;
        client_request_id: string;
        sealed_binding: EncryptedPayloadEnvelope;
      }>(
        `select id,client_request_id,sealed_binding from project_share_policy_attempts
          where owner_user_id=$1 and project_id=$2 and backend_id=$3
            and workspace_project_id=$4 and state='pending'
          for update`,
        [
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId
        ]
      );
      for (const row of existing.rows) {
        const binding = JSON.parse(
          Buffer.from(
            await encryptionProvider!.decrypt(row.sealed_binding)
          ).toString("utf8")
        ) as {
          teamId: string;
          teamPrincipalUserId: string;
          deviceCredentialId: string;
          sharePolicyLinkEpoch: string;
        };
        if (
          binding.teamId === input.teamId &&
          binding.teamPrincipalUserId === input.teamPrincipalUserId &&
          binding.deviceCredentialId === input.deviceCredentialId &&
          binding.sharePolicyLinkEpoch ===
            currentProject.share_policy_link_epoch
        )
          throw new PersonalProjectSharePolicyConflictError(
            "An exact Project policy action is awaiting receipt reconciliation"
          );
      }
      const sealed = await encryptionProvider!.encrypt({
        plaintext: JSON.stringify({
          teamId: input.teamId,
          teamPrincipalUserId: input.teamPrincipalUserId,
          deviceCredentialId: input.deviceCredentialId,
          sharePolicyLinkEpoch: currentProject.share_policy_link_epoch,
          expectedPolicyVersion: input.expectedPolicyVersion,
          ...(input.manifestId ? { manifestId: input.manifestId } : {}),
          ...(input.manifestHash ? { manifestHash: input.manifestHash } : {})
        }),
        scope: {
          projectId: input.projectId,
          objectClass: "project_share_policy_attempt"
        },
        provenance: {
          rowFamily: "project_share_policy_attempts",
          sourceId: input.clientRequestId
        },
        ciphertextLocation: `project_share_policy_attempts:${input.clientRequestId}`,
        aad: {
          ownerUserId: input.ownerUserId,
          projectId: input.projectId,
          teamBackendId: input.teamBackendId,
          workspaceProjectId: input.workspaceProjectId,
          action: input.action,
          clientRequestId: input.clientRequestId,
          actionGrantId: input.actionGrantId,
          payloadHash: input.payloadHash
        }
      });
      const inserted = await client.query<{ id: string }>(
        `insert into project_share_policy_attempts
         (owner_user_id,project_id,backend_id,workspace_project_id,action,
          client_request_id,action_grant_id,payload_hash,sealed_binding)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning id`,
        [
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.action,
          input.clientRequestId,
          input.actionGrantId,
          input.payloadHash,
          JSON.stringify(sealed)
        ]
      );
      return { attemptId: inserted.rows[0]!.id };
    });
  },
  async pendingAttempts(input) {
    if (!encryptionProvider)
      throw new PersonalProjectSharePolicyUnavailableError(
        "Policy attempt custody unavailable"
      );
    const currentProject = input.currentScope
      ? await project(pool, {
          ownerUserId: input.ownerUserId,
          projectId: input.projectId,
          teamBackendId: input.currentScope.teamBackendId,
          workspaceProjectId: input.currentScope.workspaceProjectId
        })
      : null;
    const result = await pool.query<{
      id: string;
      backend_id: string;
      workspace_project_id: string;
      action: "enable" | "revoke";
      client_request_id: string;
      action_grant_id: string;
      payload_hash: string;
      sealed_binding: EncryptedPayloadEnvelope;
    }>(
      `select id,backend_id,workspace_project_id,action,
              client_request_id,action_grant_id,payload_hash,sealed_binding
         from project_share_policy_attempts
        where owner_user_id=$1 and project_id=$2 and state='pending'
        order by created_at,id`,
      [input.ownerUserId, input.projectId]
    );
    const attempts = await Promise.all(
      result.rows.map(async (row) => {
        const binding = JSON.parse(
          Buffer.from(
            await encryptionProvider!.decrypt(row.sealed_binding)
          ).toString("utf8")
        ) as {
          teamId: string;
          teamPrincipalUserId: string;
          deviceCredentialId: string;
          sharePolicyLinkEpoch: string;
          expectedPolicyVersion: number;
          manifestId?: string;
          manifestHash?: string;
        };
        return {
          attemptId: row.id,
          teamBackendId: row.backend_id,
          workspaceProjectId: row.workspace_project_id,
          action: row.action,
          clientRequestId: row.client_request_id,
          actionGrantId: row.action_grant_id,
          payloadHash: row.payload_hash,
          ...binding
        };
      })
    );
    const scoped = input.currentScope
      ? attempts.filter(
          (attempt) =>
            attempt.teamBackendId === input.currentScope!.teamBackendId &&
            attempt.workspaceProjectId ===
              input.currentScope!.workspaceProjectId &&
            attempt.teamId === input.currentScope!.teamId &&
            attempt.teamPrincipalUserId ===
              input.currentScope!.teamPrincipalUserId &&
            attempt.deviceCredentialId ===
              input.currentScope!.deviceCredentialId &&
            attempt.sharePolicyLinkEpoch ===
              currentProject!.share_policy_link_epoch
        )
      : attempts;
    return scoped.map((attempt) => ({
      attemptId: attempt.attemptId,
      teamBackendId: attempt.teamBackendId,
      workspaceProjectId: attempt.workspaceProjectId,
      action: attempt.action,
      clientRequestId: attempt.clientRequestId,
      actionGrantId: attempt.actionGrantId,
      payloadHash: attempt.payloadHash,
      teamId: attempt.teamId,
      teamPrincipalUserId: attempt.teamPrincipalUserId,
      deviceCredentialId: attempt.deviceCredentialId,
      expectedPolicyVersion: attempt.expectedPolicyVersion,
      ...(attempt.manifestId ? { manifestId: attempt.manifestId } : {}),
      ...(attempt.manifestHash ? { manifestHash: attempt.manifestHash } : {})
    }));
  },
  async assertAttemptCurrent(input) {
    await transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const result = await client.query<{
        sealed_binding: EncryptedPayloadEnvelope;
      }>(
        `select sealed_binding from project_share_policy_attempts
          where id=$1 and owner_user_id=$2 and project_id=$3
            and backend_id=$4 and workspace_project_id=$5 and state='pending'
          for update`,
        [
          input.attemptId,
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId
        ]
      );
      if (!result.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact pending policy attempt changed"
        );
      const binding = JSON.parse(
        Buffer.from(
          await encryptionProvider!.decrypt(result.rows[0].sealed_binding)
        ).toString("utf8")
      ) as {
        teamId: string;
        teamPrincipalUserId: string;
        deviceCredentialId: string;
        sharePolicyLinkEpoch: string;
      };
      if (
        binding.teamId !== input.teamId ||
        binding.teamPrincipalUserId !== input.teamPrincipalUserId ||
        binding.deviceCredentialId !== input.deviceCredentialId ||
        binding.sharePolicyLinkEpoch !== current.share_policy_link_epoch
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Project policy attempt link epoch changed"
        );
    });
  },
  async finalizeAttempt(input) {
    await transaction(pool, async (client) => {
      const current = await client.query<{
        project_share_policy_version: number | null;
        project_share_policy_device_credential_id: string | null;
        share_policy_link_epoch: string;
      }>(
        `select project_share_policy_version,project_share_policy_device_credential_id,
                share_policy_link_epoch
           from projects where id=$1 and owner_user_id=$2
             and team_backend_id=$3 and workspace_project_id=$4
             and lifecycle='active'
             and deletion_phase is null for update`,
        [
          input.projectId,
          input.ownerUserId,
          input.teamBackendId,
          input.workspaceProjectId
        ]
      );
      const attempt = await client.query<{
        id: string;
        action: string;
        sealed_binding: EncryptedPayloadEnvelope;
      }>(
        `select id,action,sealed_binding from project_share_policy_attempts
          where id=$1 and owner_user_id=$2 and project_id=$3 and state='pending'
          for update`,
        [input.attemptId, input.ownerUserId, input.projectId]
      );
      if (!current.rows[0] || attempt.rows[0]?.action !== input.action)
        throw new PersonalProjectSharePolicyConflictError(
          "Exact policy attempt changed"
        );
      const binding = JSON.parse(
        Buffer.from(
          await encryptionProvider!.decrypt(attempt.rows[0].sealed_binding)
        ).toString("utf8")
      ) as {
        sharePolicyLinkEpoch: string;
        deviceCredentialId: string;
      };
      if (
        binding.sharePolicyLinkEpoch !==
          current.rows[0].share_policy_link_epoch ||
        binding.deviceCredentialId !== input.deviceCredentialId
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Policy attempt link epoch changed"
        );
      if (input.action === "enable") {
        if (current.rows[0].project_share_policy_version === null) {
          const changed = await client.query(
            `update projects set project_share_policy_version=$3,
                project_share_policy_device_credential_id=$4,
                project_share_policy_enabled_at=now(),updated_at=now()
              where id=$1 and owner_user_id=$2 and project_share_policy_version is null`,
            [
              input.projectId,
              input.ownerUserId,
              input.expectedPolicyVersion + 1,
              input.deviceCredentialId
            ]
          );
          if (changed.rowCount !== 1)
            throw new PersonalProjectSharePolicyConflictError(
              "Local policy activation changed"
            );
        } else if (
          current.rows[0].project_share_policy_version !==
            input.expectedPolicyVersion + 1 ||
          current.rows[0].project_share_policy_device_credential_id !==
            input.deviceCredentialId
        )
          throw new PersonalProjectSharePolicyConflictError(
            "Local policy activation changed"
          );
      } else {
        if (
          current.rows[0].project_share_policy_version ===
          input.expectedPolicyVersion
        ) {
          const changed = await client.query(
            `update projects set project_share_policy_version=null,
                project_share_policy_device_credential_id=null,
                project_share_policy_enabled_at=null,updated_at=now()
              where id=$1 and owner_user_id=$2 and project_share_policy_version=$3`,
            [input.projectId, input.ownerUserId, input.expectedPolicyVersion]
          );
          if (changed.rowCount !== 1)
            throw new PersonalProjectSharePolicyConflictError(
              "Local policy revocation changed"
            );
        } else if (current.rows[0].project_share_policy_version !== null)
          throw new PersonalProjectSharePolicyConflictError(
            "Local policy revocation changed"
          );
      }
      await client.query(
        `update project_share_policy_attempts set state='executed',updated_at=now()
          where id=$1 and owner_user_id=$2 and project_id=$3 and state='pending'`,
        [input.attemptId, input.ownerUserId, input.projectId]
      );
    });
  },
  async terminalAttempt(input) {
    await transaction(pool, async (client) => {
      const current = await client.query(
        `select id from projects where id=$1 and owner_user_id=$2
          and lifecycle='active' and deletion_phase is null for update`,
        [input.projectId, input.ownerUserId]
      );
      if (!current.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Project policy attempt owner changed"
        );
      const updated = await client.query(
        `update project_share_policy_attempts set state='terminal',updated_at=now()
          where id=$1 and owner_user_id=$2 and project_id=$3 and state='pending'
          returning id`,
        [input.attemptId, input.ownerUserId, input.projectId]
      );
      if (!updated.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact policy attempt changed"
        );
    });
  },
  async listActivePolicyProjects(ownerUserId, cursor) {
    const found = await pool.query<{
      project_id: string;
      team_backend_id: string;
      workspace_project_id: string;
      project_share_policy_version: number;
    }>(
      `select id as project_id,team_backend_id,workspace_project_id,
              project_share_policy_version
         from projects where owner_user_id=$1 and ($2::uuid is null or id>$2)
           and lifecycle='active'
           and deletion_phase is null and project_share_policy_version is not null
           and team_backend_id is not null and workspace_project_id is not null
         order by id limit 51`,
      [ownerUserId, cursor ?? null]
    );
    const rows = found.rows.slice(0, 50);
    return {
      projects: rows.map((row) => ({
        projectId: row.project_id,
        teamBackendId: row.team_backend_id,
        workspaceProjectId: row.workspace_project_id,
        policyVersion: row.project_share_policy_version
      })),
      nextCursor: rows.at(-1)?.project_id ?? null,
      hasMore: found.rows.length > 50
    };
  },
  async signFutureProof(input) {
    if (!encryptionProvider)
      throw new PersonalProjectSharePolicyUnavailableError(
        "Owner-local signing key custody unavailable"
      );
    return transaction(pool, async (client) => {
      const current = await project(client, input, true);
      if (
        current.project_share_policy_version !== input.policyVersion ||
        current.project_share_policy_device_credential_id !==
          input.deviceCredentialId
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Local policy version changed"
        );
      if (
        hashProjectBinding(input, current.share_policy_link_epoch) !==
        input.personalProjectBindingHash
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Personal Project binding changed"
        );
      const capture = await client.query<{
        created_at: Date;
        project_assignment_version: number;
        project_share_capture_policy_version: number;
        project_share_capture_workspace_project_id: string;
        project_share_capture_device_credential_id: string;
        project_share_capture_context_version: number;
        project_share_capture_prepared_at: Date;
        project_share_capture_link_epoch: string;
      }>(
        `select created_at,project_assignment_version,
                project_share_capture_policy_version,
                project_share_capture_workspace_project_id,
                project_share_capture_device_credential_id,
                project_share_capture_context_version,
                project_share_capture_prepared_at,project_share_capture_link_epoch
           from sessions where id=$1 and owner_user_id=$2
             and personal_deleted_at is null and invalidated_at is null
             and project_share_private_at is null
             and project_share_private_pending_at is null
             and project_share_move_pending_at is null for update`,
        [input.entry.sessionId, input.ownerUserId]
      );
      const row = capture.rows[0];
      if (
        !row ||
        row.project_share_capture_policy_version !== input.policyVersion ||
        row.project_share_capture_workspace_project_id !==
          input.workspaceProjectId ||
        row.project_share_capture_device_credential_id !==
          input.deviceCredentialId ||
        row.project_share_capture_link_epoch !==
          current.share_policy_link_epoch ||
        row.project_assignment_version !== input.entry.mappingRevision ||
        !row.project_share_capture_context_version ||
        !row.project_share_capture_prepared_at ||
        row.project_share_capture_prepared_at > row.created_at
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Trusted capture-time policy proof unavailable"
        );
      const eligible = await sessionRows(client, {
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workspaceProjectId: input.workspaceProjectId,
        policyVersion: input.policyVersion,
        targetSessionId: input.entry.sessionId
      });
      if (
        !eligible.entries.some(
          (entry) =>
            entry.sessionId === input.entry.sessionId &&
            entry.logicalMemoryId === input.entry.logicalMemoryId &&
            entry.sourceRevision === input.entry.sourceRevision &&
            entry.mappingRevision === input.entry.mappingRevision
        )
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session source changed"
        );
      const stored = await client.query<{
        public_key: string;
        sealed_private_key: EncryptedPayloadEnvelope;
      }>(
        `select public_key,sealed_private_key from project_share_policy_signing_keys
          where owner_user_id=$1 and project_id=$2 and backend_id=$3
            and workspace_project_id=$4 and device_credential_id=$5
            and policy_version=$6 and link_epoch=$7 for share`,
        [
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.deviceCredentialId,
          input.policyVersion,
          current.share_policy_link_epoch
        ]
      );
      if (!stored.rows[0])
        throw new PersonalProjectSharePolicyUnavailableError(
          "Active Project signing key unavailable"
        );
      const privateDer = Buffer.from(
        await encryptionProvider!.decrypt(stored.rows[0].sealed_private_key)
      );
      const derived = createPublicKey(
        createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" })
      )
        .export({ type: "spki", format: "der" })
        .toString("base64");
      if (derived !== stored.rows[0].public_key)
        throw new PersonalProjectSharePolicyConflictError(
          "Sealed Project signing key changed"
        );
      const issued = new Date();
      return signProjectSharePolicyProof(
        {
          protocol: "koed_project_share_policy_future_proof",
          version: 1,
          type: "future_summary",
          policyId: input.policyId,
          policyVersion: input.policyVersion,
          backendId: input.teamBackendId,
          workspaceProjectId: input.workspaceProjectId,
          ownerUserId: input.teamPrincipalUserId,
          personalOwnerUserId: input.ownerUserId,
          ownerTeamMemberId: input.ownerTeamMemberId,
          deviceCredentialId: input.deviceCredentialId,
          personalProjectBindingHash: input.personalProjectBindingHash,
          sessionId: input.entry.sessionId,
          logicalMemoryId: input.entry.logicalMemoryId,
          sourceRevision: input.entry.sourceRevision,
          mappingRevision: input.entry.mappingRevision,
          capturePolicyVersion: row.project_share_capture_policy_version,
          captureWorkspaceProjectId:
            row.project_share_capture_workspace_project_id,
          captureContextVersion: row.project_share_capture_context_version,
          captureAt: row.created_at.toISOString(),
          issuedAt: issued.toISOString(),
          expiresAt: new Date(issued.getTime() + 4 * 60_000).toISOString(),
          nonce: randomUUID(),
          candidateHash: input.candidateHash,
          closureHash: input.closureHash
        },
        privateDer.toString("base64")
      );
    });
  },
  async prepareSigningKey(input) {
    if (!encryptionProvider)
      throw new PersonalProjectSharePolicyUnavailableError(
        "Owner-local signing key custody unavailable"
      );
    if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1)
      throw new PersonalProjectSharePolicyConflictError(
        "Policy version invalid"
      );
    return transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const existing = await client.query<{ public_key: string }>(
        `select public_key from project_share_policy_signing_keys
          where owner_user_id=$1 and project_id=$2 and backend_id=$3
            and workspace_project_id=$4 and device_credential_id=$5
            and policy_version=$6 and link_epoch=$7 for update`,
        [
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.deviceCredentialId,
          input.policyVersion,
          current.share_policy_link_epoch
        ]
      );
      if (existing.rows[0])
        return { signingPublicKey: existing.rows[0].public_key };
      const pair = generateKeyPairSync("ed25519");
      const signingPublicKey = pair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64");
      const privateKey = pair.privateKey.export({
        type: "pkcs8",
        format: "der"
      });
      const aad = {
        ownerUserId: input.ownerUserId,
        personalProjectId: input.projectId,
        teamBackendId: input.teamBackendId,
        workspaceProjectId: input.workspaceProjectId,
        deviceCredentialId: input.deviceCredentialId,
        policyVersion: String(input.policyVersion),
        linkEpoch: current.share_policy_link_epoch
      };
      const sealed: EncryptedPayloadEnvelope = await encryptionProvider.encrypt(
        {
          plaintext: privateKey,
          scope: {
            projectId: input.projectId,
            objectClass: "project_share_policy_signing_key"
          },
          provenance: {
            rowFamily: "project_share_policy_signing_keys",
            sourceId: input.projectId
          },
          ciphertextLocation: `project_share_policy_signing_keys:${input.projectId}:${input.policyVersion}`,
          aad
        }
      );
      await client.query(
        `insert into project_share_policy_signing_keys
         (owner_user_id,project_id,backend_id,workspace_project_id,
          device_credential_id,policy_version,link_epoch,public_key,sealed_private_key)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          input.ownerUserId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.deviceCredentialId,
          input.policyVersion,
          current.share_policy_link_epoch,
          signingPublicKey,
          JSON.stringify(sealed)
        ]
      );
      return { signingPublicKey };
    });
  },
  async reserveLocalIssue(input) {
    return transaction(pool, async (client) => {
      const current = await project(client, input, true);
      if (current.project_share_policy_version !== input.policyVersion)
        throw new PersonalProjectSharePolicyConflictError(
          "Exact local Project policy changed"
        );
      const session = await client.query<{
        project_assignment_version: number;
      }>(
        `select project_assignment_version from sessions
          where id=$1 and owner_user_id=$2 and personal_deleted_at is null
            and invalidated_at is null and project_share_private_at is null
            and project_share_private_pending_at is null
            and project_share_move_pending_at is null
          for update`,
        [input.entry.sessionId, input.ownerUserId]
      );
      if (
        session.rows[0]?.project_assignment_version !==
        input.entry.mappingRevision
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session mapping changed"
        );
      const currentEntries = await sessionRows(client, {
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        targetSessionId: input.entry.sessionId,
        ...(input.provenance === "future"
          ? {
              workspaceProjectId: input.workspaceProjectId,
              policyVersion: input.policyVersion
            }
          : {})
      });
      const match = currentEntries.entries.find(
        (entry) =>
          entry.sessionId === input.entry.sessionId &&
          entry.logicalMemoryId === input.entry.logicalMemoryId &&
          entry.sourceRevision === input.entry.sourceRevision &&
          entry.mappingRevision === input.entry.mappingRevision
      );
      if (!match)
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session source or policy changed"
        );
      const inserted = await client.query<{ id: string }>(
        `insert into project_share_local_issues
         (owner_user_id,session_id,logical_memory_id,project_id,backend_id,workspace_project_id,
          policy_version,link_epoch,mapping_revision,source_revision)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (owner_user_id,session_id,project_id,backend_id,
           workspace_project_id,policy_version,link_epoch)
         do update set updated_at=now()
         where project_share_local_issues.backend_id=excluded.backend_id
           and project_share_local_issues.workspace_project_id=excluded.workspace_project_id
           and project_share_local_issues.logical_memory_id=excluded.logical_memory_id
           and project_share_local_issues.mapping_revision=excluded.mapping_revision
           and project_share_local_issues.source_revision=excluded.source_revision
           and project_share_local_issues.state in ('reserved','staged')
         returning id`,
        [
          input.ownerUserId,
          input.entry.sessionId,
          input.entry.logicalMemoryId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.policyVersion,
          current.share_policy_link_epoch,
          input.entry.mappingRevision,
          input.entry.sourceRevision
        ]
      );
      if (!inserted.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Local issue was already consumed or changed"
        );
      return { issueId: inserted.rows[0].id };
    });
  },
  async attachRemotePending(input) {
    await transaction(pool, async (client) => {
      const attached = await client.query(
        `update project_share_local_issues
            set remote_pending_share_id=$3,state='staged',updated_at=now()
          where id=$1 and owner_user_id=$2 and state in ('reserved','staged')
            and (remote_pending_share_id is null or remote_pending_share_id=$3)
          returning id`,
        [input.issueId, input.ownerUserId, input.pendingShareId]
      );
      if (!attached.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Local issue changed before Team acknowledgment"
        );
    });
  },
  async listUnsettledIssues(input) {
    const result = await pool.query<{
      id: string;
      session_id: string;
      logical_memory_id: string;
      backend_id: string;
      workspace_project_id: string;
      policy_version: number;
      mapping_revision: number;
      source_revision: string;
      remote_pending_share_id: string | null;
    }>(
      `select id,session_id,logical_memory_id,backend_id,workspace_project_id,policy_version,
              mapping_revision,source_revision::text,remote_pending_share_id
         from project_share_local_issues
        where owner_user_id=$1 and project_id=$2
          and backend_id=$3 and workspace_project_id=$4
          and ($5::uuid is null or session_id=$5)
          and ($6::uuid is null or id>$6)
          and state in ('reserved','staged')
        order by id limit 21`,
      [
        input.ownerUserId,
        input.projectId,
        input.teamBackendId,
        input.workspaceProjectId,
        input.sessionId ?? null,
        input.cursor ?? null
      ]
    );
    const rows = result.rows.slice(0, 20);
    return {
      issues: rows.map((row) => ({
        issueId: row.id,
        sessionId: row.session_id,
        logicalMemoryId: row.logical_memory_id,
        teamBackendId: row.backend_id,
        workspaceProjectId: row.workspace_project_id,
        policyVersion: row.policy_version,
        mappingRevision: row.mapping_revision,
        sourceRevision: Number(row.source_revision),
        remotePendingShareId: row.remote_pending_share_id
      })),
      nextCursor: rows.at(-1)?.id ?? null,
      hasMore: result.rows.length > 20
    };
  },
  async reconcileActivatedIssue(input) {
    await transaction(pool, async (client) => {
      await project(client, input, true);
      const issue = await client.query<{ id: string }>(
        `select issue.id from project_share_local_issues issue
           join sessions session on session.id=issue.session_id
             and session.owner_user_id=issue.owner_user_id
          where issue.id=$1 and issue.owner_user_id=$2 and issue.project_id=$3
            and issue.session_id=$4 and issue.backend_id=$5
            and issue.workspace_project_id=$6 and issue.policy_version=$7
            and issue.mapping_revision=$8 and issue.source_revision=$9
            and issue.state in ('reserved','staged','activated')
            and (issue.remote_pending_share_id is null or issue.remote_pending_share_id=$10)
            and session.project_assignment_version=$8
            and session.project_share_private_at is null
            and session.project_share_private_pending_at is null
            and session.project_share_move_pending_at is null
            and session.personal_deleted_at is null and session.invalidated_at is null
          for update of issue,session`,
        [
          input.issueId,
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.policyVersion,
          input.mappingRevision,
          input.sourceRevision,
          input.remotePendingShareId
        ]
      );
      if (!issue.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Policy issue source or mapping changed"
        );
      const binding = await client.query(
        `insert into project_policy_session_grants
         (owner_user_id,session_id,project_id,backend_id,logical_memory_id,
          team_id,team_workspace_id,share_grant_id,policy_generation,
          mapping_version,grant_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (backend_id,share_grant_id) do update
           set grant_version=excluded.grant_version
         where project_policy_session_grants.owner_user_id=excluded.owner_user_id
           and project_policy_session_grants.session_id=excluded.session_id
           and project_policy_session_grants.project_id=excluded.project_id
           and project_policy_session_grants.mapping_version=excluded.mapping_version`,
        [
          input.ownerUserId,
          input.sessionId,
          input.projectId,
          input.teamBackendId,
          input.logicalMemoryId,
          input.teamId,
          input.teamWorkspaceId,
          input.shareGrantId,
          input.policyVersion,
          input.mappingRevision,
          input.grantVersion
        ]
      );
      if (binding.rowCount !== 1)
        throw new PersonalProjectSharePolicyConflictError(
          "Policy grant binding changed"
        );
      const updated = await client.query(
        `update project_share_local_issues set state='activated',
            remote_pending_share_id=$2,updated_at=now()
          where id=$1 and state in ('reserved','staged','activated') returning id`,
        [input.issueId, input.remotePendingShareId]
      );
      if (!updated.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Policy issue activation changed"
        );
    });
  },
  async reconcileTerminalIssue(input) {
    await transaction(pool, async (client) => {
      await project(client, input, true);
      const changed = await client.query(
        `update project_share_local_issues issue
            set state='frozen',remote_pending_share_id=$10,
                remote_share_grant_id=$11,remote_grant_version=$12,
                remote_grant_lifecycle=$13,updated_at=now()
          from sessions session
         where issue.id=$1 and issue.owner_user_id=$2 and issue.project_id=$3
           and issue.session_id=$4 and issue.backend_id=$5
           and issue.workspace_project_id=$6 and issue.policy_version=$7
           and issue.mapping_revision=$8 and issue.source_revision=$9
           and issue.state in ('reserved','staged','frozen')
           and (issue.remote_pending_share_id is null or issue.remote_pending_share_id=$10)
           and session.id=issue.session_id and session.owner_user_id=issue.owner_user_id
           and session.project_assignment_version=$8
           and $13 in ('revoked','tombstoned','purge_pending','purged')
         returning issue.id`,
        [
          input.issueId,
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.policyVersion,
          input.mappingRevision,
          input.sourceRevision,
          input.remotePendingShareId,
          input.shareGrantId,
          input.grantVersion,
          input.grantLifecycle
        ]
      );
      if (changed.rowCount !== 1)
        throw new PersonalProjectSharePolicyConflictError(
          "Terminal policy grant provenance changed before settlement"
        );
    });
  },
  async freezeUnpublishedIssue(input) {
    await transaction(pool, async (client) => {
      await project(client, input, true);
      const session = await client.query<{
        project_assignment_version: number;
      }>(
        `select project_assignment_version from sessions
          where id=$1 and owner_user_id=$2 and personal_deleted_at is null
            and invalidated_at is null for update`,
        [input.sessionId, input.ownerUserId]
      );
      if (session.rows[0]?.project_assignment_version !== input.mappingRevision)
        throw new PersonalProjectSharePolicyConflictError(
          "Conversation mapping changed"
        );
      const grant = await client.query(
        `select id from project_policy_session_grants
          where owner_user_id=$1 and session_id=$2 and project_id=$3 limit 1`,
        [input.ownerUserId, input.sessionId, input.projectId]
      );
      if (grant.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Active policy grant needs HQ107 freeze"
        );
      const updated = await client.query(
        `update project_share_local_issues set state='frozen',updated_at=now()
          where id=$1 and owner_user_id=$2 and project_id=$3 and session_id=$4
            and backend_id=$5 and workspace_project_id=$6
            and mapping_revision=$7 and state in ('reserved','staged')
          returning id`,
        [
          input.issueId,
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.mappingRevision
        ]
      );
      if (!updated.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Policy issue freeze changed"
        );
    });
  },
  async buildInitialManifest(input) {
    return transaction(pool, async (client) => {
      await client.query("set transaction isolation level repeatable read");
      const current = await project(client, input);
      return {
        personalProjectBindingHash: hashProjectBinding(
          input,
          current.share_policy_link_epoch
        ),
        entries: (
          await sessionRows(client, {
            ownerUserId: input.ownerUserId,
            projectId: input.projectId
          })
        ).entries
      };
    });
  },
  async listInitialManifestSources(input) {
    return transaction(pool, async (client) => {
      await client.query("set transaction isolation level repeatable read");
      await project(client, input);
      const eligible: Array<{ sessionId: string; mappingRevision: number }> =
        [];
      let cursor: string | null = null;
      for (;;) {
        const result: pg.QueryResult<{
          session_id: string;
          mapping_revision: number;
        }> = await client.query<{
          session_id: string;
          mapping_revision: number;
        }>(
          `select session.id as session_id,
                session.project_assignment_version as mapping_revision
           from sessions session
          where session.owner_user_id=$1 and session.visibility='personal'
            and (case when session.project_override_at is not null
                  then session.project_override_personal_project_id
                  else session.automatic_personal_project_id end)=$2
            and session.project_share_private_at is null
            and session.project_share_private_pending_at is null
            and session.project_share_move_pending_at is null
            and session.source_kind is not null
            and session.source_adapter_version is not null
            and coalesce(session.external_thread_id,session.external_session_id) is not null
            and exists (
              select 1 from conversation_source_artifacts artifact
               where artifact.session_id=session.id and artifact.owner_user_id=$1
                 and artifact.replica_role='origin_local'
            )
            and not exists (
              select 1 from project_share_private_conversations private
               where private.owner_user_id=$1
                 and private.source_runtime=session.source_runtime
                 and private.source_kind=session.source_kind
                 and private.source_adapter_version=session.source_adapter_version
                 and private.external_conversation_id=coalesce(session.external_thread_id,session.external_session_id)
            )
            and session.personal_deleted_at is null
            and session.invalidated_at is null
            and session.delete_batch_id is null and session.forget_batch_id is null
            and session.trashed_at is null
            and ($3::uuid is null or session.id>$3)
          order by session.id limit 101`,
          [input.ownerUserId, input.projectId, cursor]
        );
        for (const row of result.rows) {
          if (
            await capturedSessionMayLeavePersonalBoundary(
              client,
              input.ownerUserId,
              row.session_id
            )
          ) {
            eligible.push({
              sessionId: row.session_id,
              mappingRevision: row.mapping_revision
            });
          }
          if (eligible.length > 100)
            throw new PersonalProjectSharePolicyConflictError(
              "More than 100 eligible Captured Sessions exceed this policy's initial review limit"
            );
        }
        if (result.rows.length < 101) break;
        cursor = result.rows.at(-1)!.session_id;
      }
      return eligible;
    });
  },
  async prepareInitialManifestSource(input) {
    if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1)
      throw new PersonalProjectSharePolicyConflictError(
        "Captured Session source revision unavailable"
      );
    await transaction(pool, async (client) => {
      await project(client, input, true);
      const session = await client.query<{ id: string }>(
        `select session.id from sessions session
          where session.id=$1 and session.owner_user_id=$2
            and session.visibility='personal'
            and (case when session.project_override_at is not null
                  then session.project_override_personal_project_id
                  else session.automatic_personal_project_id end)=$3
            and session.project_assignment_version=$4
            and session.project_share_private_at is null
            and session.project_share_private_pending_at is null
            and session.project_share_move_pending_at is null
            and session.source_kind is not null
            and session.source_adapter_version is not null
            and coalesce(session.external_thread_id,session.external_session_id) is not null
            and exists (
              select 1 from conversation_source_artifacts artifact
               where artifact.session_id=session.id and artifact.owner_user_id=$2
                 and artifact.replica_role='origin_local'
            )
            and not exists (
              select 1 from project_share_private_conversations private
               where private.owner_user_id=$2
                 and private.source_runtime=session.source_runtime
                 and private.source_kind=session.source_kind
                 and private.source_adapter_version=session.source_adapter_version
                 and private.external_conversation_id=coalesce(session.external_thread_id,session.external_session_id)
            )
            and session.personal_deleted_at is null and session.invalidated_at is null
            and session.delete_batch_id is null and session.forget_batch_id is null
            and session.trashed_at is null
          for update`,
        [
          input.sessionId,
          input.ownerUserId,
          input.projectId,
          input.mappingRevision
        ]
      );
      if (
        !session.rows[0] ||
        !(await capturedSessionMayLeavePersonalBoundary(
          client,
          input.ownerUserId,
          input.sessionId
        ))
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session changed before local source preparation"
        );
      const deployment = await client.query<{ id: string }>(
        `select id from deployment_identities
          where locality='local' and protocol_deployment_id=$1
            and disabled_at is null limit 1`,
        [input.sourceDeploymentProtocolId]
      );
      if (!deployment.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Verified local source deployment changed"
        );
      const expectedId = crossIdentitySyncDeterministicUuid({
        protocol: "koed.captured-session-sync/v1",
        sourceDeploymentId: input.sourceDeploymentProtocolId,
        sourceUserId: input.ownerUserId,
        originSessionId: input.sessionId,
        identity: "logical-memory"
      });
      if (input.logicalMemoryId !== expectedId)
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session source identity changed"
        );
      const cursor = await client.query<{ source_revision: string | null }>(
        `select max(cursor)::text as source_revision
           from sync_semantic_changes where session_id=$1`,
        [input.sessionId]
      );
      if (Number(cursor.rows[0]?.source_revision ?? 0) !== input.sourceRevision)
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session source cursor changed"
        );
      const unprepared = await client.query(
        `select 1 from memory_events event
          where event.session_id=$1 and event.owner_user_id=$2
            and event.event_type='captured'
            and not exists (
              select 1 from sync_semantic_changes change
               where change.session_id=event.session_id
                 and change.origin_event_id=event.id
            ) limit 1`,
        [input.sessionId, input.ownerUserId]
      );
      if (unprepared.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session source changed during local preparation"
        );
      const logical = await client.query(
        `insert into logical_memories
           (id,owner_user_id,owner_principal_id,origin_deployment_identity_id,
            source_kind,logical_key,latest_source_revision)
         values ($1,$2,$2,$3,'captured_session',$4,$5)
         on conflict (id) do update
           set latest_source_revision=greatest(logical_memories.latest_source_revision,
                 excluded.latest_source_revision),updated_at=now()
         where logical_memories.owner_user_id=excluded.owner_user_id
           and logical_memories.owner_principal_id=excluded.owner_principal_id
           and logical_memories.origin_deployment_identity_id=excluded.origin_deployment_identity_id
           and logical_memories.source_kind=excluded.source_kind
           and logical_memories.logical_key=excluded.logical_key
         returning id`,
        [
          input.logicalMemoryId,
          input.ownerUserId,
          deployment.rows[0].id,
          `captured-session:${input.sessionId}`,
          input.sourceRevision
        ]
      );
      if (!logical.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session logical memory identity changed"
        );
      await ensureCapturedSessionSourceRevision(client, {
        logicalMemoryId: input.logicalMemoryId,
        ownerPrincipalId: input.ownerUserId,
        sourceSessionId: input.sessionId,
        sourceRevision: input.sourceRevision
      });
      const local = await client.query(
        `insert into local_captured_session_logical_memories
           (logical_memory_id,local_session_id,owner_user_id)
         values ($1,$2,$3)
         on conflict (logical_memory_id) do update
           set local_session_id=local_captured_session_logical_memories.local_session_id
         where local_captured_session_logical_memories.local_session_id=excluded.local_session_id
           and local_captured_session_logical_memories.owner_user_id=excluded.owner_user_id
         returning logical_memory_id`,
        [input.logicalMemoryId, input.sessionId, input.ownerUserId]
      );
      if (!local.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Captured Session local source binding changed"
        );
    });
  },
  async activateLocalPolicy(input) {
    if (!Number.isSafeInteger(input.version) || input.version < 1)
      throw new PersonalProjectSharePolicyConflictError(
        "Policy version invalid"
      );
    await transaction(pool, async (client) => {
      const current = await project(client, input, true);
      if (current.project_share_policy_version === input.version) return;
      if (current.project_share_policy_version !== null)
        throw new PersonalProjectSharePolicyConflictError(
          "Local policy version changed"
        );
      const updated = await client.query(
        `update projects set project_share_policy_version=$5,
            project_share_policy_device_credential_id=$6,
            project_share_policy_enabled_at=now(),updated_at=now()
          where id=$1 and owner_user_id=$2 and team_backend_id=$3
            and workspace_project_id=$4 and project_share_policy_version is null
            and lifecycle='active' and deletion_phase is null`,
        [
          input.projectId,
          input.ownerUserId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.version,
          input.deviceCredentialId
        ]
      );
      if (updated.rowCount !== 1)
        throw new PersonalProjectSharePolicyConflictError(
          "Local policy activation changed"
        );
    });
  },
  async revokeLocalPolicy(input) {
    await transaction(pool, async (client) => {
      const current = await project(client, input, true);
      if (current.project_share_policy_version === null) return;
      if (current.project_share_policy_version !== input.expectedVersion)
        throw new PersonalProjectSharePolicyConflictError(
          "Local policy version changed"
        );
      const updated = await client.query(
        `update projects set project_share_policy_version=null,
            project_share_policy_device_credential_id=null,
            project_share_policy_enabled_at=null,updated_at=now()
          where id=$1 and owner_user_id=$2 and team_backend_id=$3
            and workspace_project_id=$4 and project_share_policy_version=$5`,
        [
          input.projectId,
          input.ownerUserId,
          input.teamBackendId,
          input.workspaceProjectId,
          input.expectedVersion
        ]
      );
      if (updated.rowCount !== 1)
        throw new PersonalProjectSharePolicyConflictError(
          "Local policy revocation changed"
        );
    });
  },
  async listFutureSourceCandidates(input) {
    return transaction(pool, async (client) => {
      await client.query("set transaction isolation level repeatable read");
      const current = await project(client, input);
      if (
        current.project_share_policy_version !== input.policyVersion ||
        !current.project_share_policy_device_credential_id
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Policy version is not active locally"
        );
      return futureSourceRows(client, {
        ...input,
        linkEpoch: current.share_policy_link_epoch,
        deviceCredentialId: current.project_share_policy_device_credential_id
      });
    });
  },
  async exactFutureSourceCandidate(input) {
    return transaction(pool, async (client) => {
      await client.query("set transaction isolation level repeatable read");
      const current = await project(client, input);
      if (
        current.project_share_policy_version !== input.policyVersion ||
        !current.project_share_policy_device_credential_id
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Policy version is not active locally"
        );
      return (
        (
          await futureSourceRows(client, {
            ...input,
            linkEpoch: current.share_policy_link_epoch,
            deviceCredentialId:
              current.project_share_policy_device_credential_id,
            targetSessionId: input.sessionId
          })
        ).entries[0] ?? null
      );
    });
  },
  async listFutureEligible(input) {
    return transaction(pool, async (client) => {
      await client.query("set transaction isolation level repeatable read");
      const current = await project(client, input);
      if (current.project_share_policy_version !== input.policyVersion)
        throw new PersonalProjectSharePolicyConflictError(
          "Policy version is not active locally"
        );
      return sessionRows(client, {
        ...input,
        policyVersion: input.policyVersion,
        limit: 20
      });
    });
  },
  async exactFutureEligible(input) {
    return transaction(pool, async (client) => {
      await client.query("set transaction isolation level repeatable read");
      const current = await project(client, input);
      if (current.project_share_policy_version !== input.policyVersion)
        throw new PersonalProjectSharePolicyConflictError(
          "Policy version is not active locally"
        );
      return (
        (
          await sessionRows(client, {
            ...input,
            targetSessionId: input.sessionId,
            limit: 1
          })
        ).entries[0] ?? null
      );
    });
  },
  async beginPrivate(input) {
    await transaction(pool, async (client) => {
      const lockedProject = await client.query(
        `select id from projects where id=$1 and owner_user_id=$2
          and lifecycle='active' and deletion_phase is null for update`,
        [input.projectId, input.ownerUserId]
      );
      if (!lockedProject.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Project unavailable for privacy review"
        );
      const pending = await client.query(
        `update sessions set project_share_private_pending_at=coalesce(
            project_share_private_pending_at,now()),updated_at=now()
          where id=$1 and owner_user_id=$2 and visibility='personal'
            and (case when project_override_at is not null
                  then project_override_personal_project_id
                  else automatic_personal_project_id end)=$3
            and project_assignment_version=$4
            and personal_deleted_at is null and invalidated_at is null
          returning id`,
        [
          input.sessionId,
          input.ownerUserId,
          input.projectId,
          input.expectedProjectAssignmentVersion
        ]
      );
      if (!pending.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Conversation mapping changed before private fence"
        );
    });
  },
  async listOpenExplicitOffers(input) {
    const current = await project(pool, input);
    const result = await pool.query<{ id: string }>(
      `select id from project_share_explicit_offers
        where owner_user_id=$1 and project_id=$2 and session_id=$3
          and backend_id=$4 and workspace_project_id=$5 and link_epoch=$6
          and state in ('prepared','pending','accepted','activated')
        order by created_at,id limit 101`,
      [
        input.ownerUserId,
        input.projectId,
        input.sessionId,
        input.teamBackendId,
        input.workspaceProjectId,
        current.share_policy_link_epoch
      ]
    );
    if (result.rows.length > 100)
      throw new PersonalProjectSharePolicyConflictError(
        "Too many exact Conversation offers require privacy reconciliation"
      );
    return result.rows.map((row) => row.id);
  },
  async beginMoveFence(input) {
    return transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const session = await client.query<{
        project_assignment_version: number;
      }>(
        `select project_assignment_version from sessions
          where id=$1 and owner_user_id=$2 and visibility='personal'
            and (case when project_override_at is not null
                  then project_override_personal_project_id
                  else automatic_personal_project_id end)=$3
            and personal_deleted_at is null and invalidated_at is null
          for update`,
        [input.sessionId, input.ownerUserId, input.projectId]
      );
      const mappingRevision = session.rows[0]?.project_assignment_version;
      if (!mappingRevision)
        throw new PersonalProjectSharePolicyConflictError(
          "Exact linked Conversation unavailable for move fence"
        );
      await client.query(
        `update sessions set project_share_move_pending_at=coalesce(
            project_share_move_pending_at,now()),updated_at=now()
          where id=$1 and owner_user_id=$2`,
        [input.sessionId, input.ownerUserId]
      );
      const fence = await client.query<{ id: string }>(
        `insert into project_share_move_fences
         (owner_user_id,session_id,project_id,backend_id,workspace_project_id,
          link_epoch,mapping_version)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (owner_user_id,session_id,project_id,backend_id,
           workspace_project_id,link_epoch,mapping_version)
         do update set updated_at=now() returning id`,
        [
          input.ownerUserId,
          input.sessionId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          current.share_policy_link_epoch,
          mappingRevision
        ]
      );
      return { fenceId: fence.rows[0]!.id, mappingRevision };
    });
  },
  async acknowledgeMoveFence(input) {
    await transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const session = await client.query(
        `select id from sessions where id=$1 and owner_user_id=$2
          and project_assignment_version=$3 and project_share_move_pending_at is not null
          and personal_deleted_at is null and invalidated_at is null for update`,
        [input.sessionId, input.ownerUserId, input.mappingRevision]
      );
      if (!session.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Conversation changed before Team move fence acknowledgement"
        );
      const unsettled = await client.query(
        `select id from project_share_local_issues
          where owner_user_id=$1 and project_id=$2 and session_id=$3
            and backend_id=$4 and workspace_project_id=$5
            and state in ('reserved','staged') limit 1`,
        [
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.teamBackendId,
          input.workspaceProjectId
        ]
      );
      const offers = await client.query(
        `select id from project_share_explicit_offers
          where owner_user_id=$1 and project_id=$2 and session_id=$3
            and backend_id=$4 and workspace_project_id=$5 and link_epoch=$6
            and state in ('prepared','pending','accepted') limit 1`,
        [
          input.ownerUserId,
          input.projectId,
          input.sessionId,
          input.teamBackendId,
          input.workspaceProjectId,
          current.share_policy_link_epoch
        ]
      );
      if (unsettled.rows[0] || offers.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Team move fence has unsettled Conversation publication"
        );
      const updated = await client.query(
        `update project_share_move_fences set state='acknowledged',updated_at=now()
          where id=$1 and owner_user_id=$2 and session_id=$3 and project_id=$4
            and backend_id=$5 and workspace_project_id=$6 and link_epoch=$7
            and mapping_version=$8 and state in ('preparing','acknowledged')
          returning id`,
        [
          input.fenceId,
          input.ownerUserId,
          input.sessionId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          current.share_policy_link_epoch,
          input.mappingRevision
        ]
      );
      if (!updated.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Team move fence changed before acknowledgement"
        );
    });
  },
  async releaseMoveFence(input) {
    await transaction(pool, async (client) => {
      const current = await project(client, input, true);
      const session = await client.query(
        `select id from sessions where id=$1 and owner_user_id=$2
          and (case when project_override_at is not null
                then project_override_personal_project_id
                else automatic_personal_project_id end)=$3 for update`,
        [input.sessionId, input.ownerUserId, input.projectId]
      );
      if (!session.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Conversation moved before fence release"
        );
      const activeMove = await client.query(
        `select batch_id from chat_move_operations
          where owner_user_id=$1 and session_id=$2 and old_project_id=$3
            and state in ('freezing','ready','needs_attention') limit 1`,
        [input.ownerUserId, input.sessionId, input.projectId]
      );
      if (activeMove.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Unknown or active Conversation move cannot release its Team fence"
        );
      const removed = await client.query(
        `delete from project_share_move_fences
          where id=$1 and owner_user_id=$2 and session_id=$3 and project_id=$4
            and backend_id=$5 and workspace_project_id=$6 and link_epoch=$7
            and state='acknowledged' returning id`,
        [
          input.fenceId,
          input.ownerUserId,
          input.sessionId,
          input.projectId,
          input.teamBackendId,
          input.workspaceProjectId,
          current.share_policy_link_epoch
        ]
      );
      if (!removed.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Unacknowledged Team move fence cannot be released"
        );
      await client.query(
        `update sessions set project_share_move_pending_at=null,updated_at=now()
          where id=$1 and owner_user_id=$2`,
        [input.sessionId, input.ownerUserId]
      );
    });
  },
  async currentMoveFence(input) {
    const current = await project(pool, input);
    const session = await pool.query<{
      project_assignment_version: number;
      project_share_move_pending_at: Date | null;
    }>(
      `select project_assignment_version,project_share_move_pending_at
         from sessions where id=$1 and owner_user_id=$2
           and (case when project_override_at is not null
                 then project_override_personal_project_id
                 else automatic_personal_project_id end)=$3
           and personal_deleted_at is null and invalidated_at is null`,
      [input.sessionId, input.ownerUserId, input.projectId]
    );
    if (!session.rows[0])
      throw new PersonalProjectSharePolicyConflictError(
        "Exact linked Conversation unavailable for move fence status"
      );
    const fence = await pool.query<{
      id: string;
      state: "preparing" | "acknowledged";
    }>(
      `select id,state from project_share_move_fences
        where owner_user_id=$1 and project_id=$2 and session_id=$3
          and backend_id=$4 and workspace_project_id=$5 and link_epoch=$6
          and mapping_version=$7 order by created_at desc limit 1`,
      [
        input.ownerUserId,
        input.projectId,
        input.sessionId,
        input.teamBackendId,
        input.workspaceProjectId,
        current.share_policy_link_epoch,
        session.rows[0].project_assignment_version
      ]
    );
    if (!fence.rows[0]) {
      if (session.rows[0].project_share_move_pending_at)
        throw new PersonalProjectSharePolicyConflictError(
          "Conversation move hold has no exact fence provenance"
        );
      return { state: "none" as const };
    }
    return {
      state: fence.rows[0].state,
      fenceId: fence.rows[0].id,
      mappingRevision: session.rows[0].project_assignment_version
    };
  },
  async markPrivate(input) {
    await transaction(pool, async (client) => {
      const projectLock = await client.query(
        `select id from projects where id=$1 and owner_user_id=$2
          and lifecycle='active' and deletion_phase is null for update`,
        [input.projectId, input.ownerUserId]
      );
      if (!projectLock.rows[0])
        throw new PersonalProjectSharePolicyConflictError(
          "Exact Project changed before privacy commit"
        );
      const row = await client.query<{
        project_assignment_version: number;
        project_share_private_at: Date | null;
        effective_project_id: string | null;
        source_runtime: string;
        source_kind: string | null;
        source_adapter_version: string | null;
        external_conversation_id: string | null;
      }>(
        `select project_assignment_version,project_share_private_at,
                (case when project_override_at is not null
                      then project_override_personal_project_id
                      else automatic_personal_project_id end) as effective_project_id,
                source_runtime,source_kind,source_adapter_version,
                coalesce(external_thread_id,external_session_id) as external_conversation_id
           from sessions
          where id=$1 and owner_user_id=$2 and personal_deleted_at is null
            and invalidated_at is null for update`,
        [input.sessionId, input.ownerUserId]
      );
      if (
        !row.rows[0] ||
        row.rows[0].project_assignment_version !==
          input.expectedProjectAssignmentVersion ||
        row.rows[0].effective_project_id !== input.projectId
      )
        throw new PersonalProjectSharePolicyConflictError(
          "Conversation Project mapping changed"
        );
      await client.query(
        `update project_share_explicit_offers set state='blocked',updated_at=now()
          where owner_user_id=$1 and project_id=$2 and session_id=$3
            and state in ('prepared','pending','accepted','activated')`,
        [input.ownerUserId, input.projectId, input.sessionId]
      );
      await client.query(
        `update project_share_local_issues set state='frozen',updated_at=now()
          where owner_user_id=$1 and session_id=$2 and project_id=$3
            and state in ('reserved','staged')`,
        [input.ownerUserId, input.sessionId, input.projectId]
      );
      await client.query(
        `update sessions set project_share_private_at=coalesce(project_share_private_at,now()),
            project_share_private_pending_at=null,updated_at=now()
          where id=$1 and owner_user_id=$2`,
        [input.sessionId, input.ownerUserId]
      );
      const source = row.rows[0];
      if (
        source.source_kind &&
        source.source_adapter_version &&
        source.external_conversation_id
      )
        await client.query(
          `insert into project_share_private_conversations
             (owner_user_id,source_runtime,source_kind,source_adapter_version,external_conversation_id)
           values ($1,$2,$3,$4,$5) on conflict do nothing`,
          [
            input.ownerUserId,
            source.source_runtime,
            source.source_kind,
            source.source_adapter_version,
            source.external_conversation_id
          ]
        );
    });
  },
  async inspectPrivateTarget(input) {
    const row = await pool.query<{
      project_assignment_version: number;
      project_share_private_at: Date | null;
    }>(
      `select project_assignment_version,project_share_private_at from sessions
        where id=$1 and owner_user_id=$2 and visibility='personal'
          and (case when project_override_at is not null
                then project_override_personal_project_id
                else automatic_personal_project_id end)=$3
          and personal_deleted_at is null and invalidated_at is null`,
      [input.sessionId, input.ownerUserId, input.projectId]
    );
    if (!row.rows[0])
      throw new PersonalProjectSharePolicyConflictError(
        "Exact owner Conversation unavailable"
      );
    return {
      mappingRevision: row.rows[0].project_assignment_version,
      alreadyPrivate: Boolean(row.rows[0].project_share_private_at)
    };
  },
  async sessionStatus(input) {
    const current = await project(pool, input);
    const row = await pool.query<{
      project_assignment_version: number;
      project_share_private_at: Date | null;
      project_share_private_pending_at: Date | null;
      project_share_move_pending_at: Date | null;
      conversation_private: boolean;
      issue_state: string | null;
      binding_id: string | null;
      explicit_state: string | null;
    }>(
      `select session.project_assignment_version,session.project_share_private_at,
              session.project_share_private_pending_at,
              session.project_share_move_pending_at,
              exists(select 1 from project_share_private_conversations private
                where private.owner_user_id=session.owner_user_id
                  and private.source_runtime=session.source_runtime
                  and private.source_kind=session.source_kind
                  and private.source_adapter_version=session.source_adapter_version
                  and private.external_conversation_id=coalesce(
                    session.external_thread_id,session.external_session_id))
                as conversation_private,
              issue.state as issue_state,binding.id as binding_id,
              explicit_offer.state as explicit_state
         from sessions session
         left join lateral (
           select state from project_share_local_issues issue
            where issue.owner_user_id=session.owner_user_id
              and issue.session_id=session.id and issue.project_id=$3
              and issue.backend_id=$4 and issue.workspace_project_id=$5
            order by issue.created_at desc,issue.id desc limit 1
         ) issue on true
         left join lateral (
           select id from project_policy_session_grants binding
            where binding.owner_user_id=session.owner_user_id
              and binding.session_id=session.id and binding.project_id=$3
              and binding.backend_id=$4 limit 1
         ) binding on true
         left join lateral (
           select state from project_share_explicit_offers offer
            where offer.owner_user_id=session.owner_user_id
              and offer.session_id=session.id and offer.project_id=$3
              and offer.backend_id=$4 and offer.workspace_project_id=$5
              and offer.link_epoch=$6
            order by offer.created_at desc,offer.id desc limit 1
         ) explicit_offer on true
        where session.id=$1 and session.owner_user_id=$2
          and session.visibility='personal'
          and (case when session.project_override_at is not null
                then session.project_override_personal_project_id
                else session.automatic_personal_project_id end)=$3
          and session.personal_deleted_at is null and session.invalidated_at is null`,
      [
        input.sessionId,
        input.ownerUserId,
        input.projectId,
        input.teamBackendId,
        input.workspaceProjectId,
        current.share_policy_link_epoch
      ]
    );
    if (!row.rows[0])
      throw new PersonalProjectSharePolicyConflictError(
        "Exact owner Conversation unavailable"
      );
    const source = row.rows[0];
    if (
      !(await capturedSessionMayLeavePersonalBoundary(
        pool,
        input.ownerUserId,
        input.sessionId
      ))
    )
      return {
        state: "ineligible" as const,
        mappingRevision: source.project_assignment_version
      };
    return {
      state:
        source.project_share_private_pending_at ||
        source.project_share_move_pending_at
          ? "pending"
          : source.explicit_state === "prepared" ||
              source.explicit_state === "accepted" ||
              source.explicit_state === "pending"
            ? "pending"
            : source.explicit_state === "activated"
              ? "shared"
              : source.project_share_private_at
                ? "private"
                : source.conversation_private
                  ? "private"
                  : source.explicit_state === "blocked"
                    ? "unshared"
                    : source.binding_id
                      ? "shared"
                      : source.issue_state === "reserved" ||
                          source.issue_state === "staged"
                        ? "pending"
                        : "unshared",
      mappingRevision: source.project_assignment_version
    };
  }
});
