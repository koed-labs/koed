import { createHash, createPublicKey, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  verifyProjectSharePolicyProof,
  type ProjectSharePolicyProof
} from "@koed/shared";
import { projectSharePolicyManifestHash } from "@koed/shared";
import { createSavepointPool } from "./savepoint-pool.js";
import {
  createSharedMemoryRepository,
  SHARED_MEMORY_AUTHORITY,
  type SharedMemoryAuthorityContext,
  type SharedMemoryRepository
} from "./shared-memory-repository.js";

type CandidateInput = Parameters<
  SharedMemoryRepository["createSharedMemoryCandidatePreview"]
>[1];

export class ProjectSharePolicyUnavailableError extends Error {
  readonly statusCode = 503;
}
export class ProjectSharePolicyConflictError extends Error {
  readonly statusCode = 409;
}
export class ProjectSharePolicyAuthorizationError extends Error {
  readonly statusCode = 403;
}

export interface ProjectShareManifestEntry {
  sessionId: string;
  logicalMemoryId: string;
  sourceRevision: number;
  mappingRevision: number;
  reviewLabel: string;
}

export interface ProjectSharePolicyActor {
  userId: string;
  deviceCredentialId: string;
  upstreamBackendId: string;
}

export interface ProjectSharePolicyReview {
  policyId: string | null;
  ownerTeamMemberId: string;
  projectId: string;
  teamId: string;
  workspaceId: string;
  projectName: string;
  policyVersion: number;
  status: "absent" | "active" | "revoked";
  manifestId: string | null;
  manifestHash: string | null;
  signingPublicKey: string | null;
  personalProjectBindingHash: string | null;
  deviceCredentialId: string | null;
  eligibleCount: number;
  reviewSources: Array<{
    sessionId: string;
    reviewLabel: string;
    eligible: boolean;
  }>;
}

export interface ProjectSharePolicyRepository {
  explicitPendingStatus(
    actor: ProjectSharePolicyActor,
    input: {
      projectId: string;
      mutationId: string;
      sessionId: string;
      logicalMemoryId: string;
    }
  ): Promise<{
    state: "absent" | "pending" | "activated" | "blocked";
    pendingShareId: string | null;
    shareGrantId: string | null;
    grantVersion: number | null;
    sourceRevision: number | null;
    teamId: string;
    workspaceId: string;
    ownerTeamMemberId: string;
  }>;
  fenceExplicitOffer(
    actor: ProjectSharePolicyActor,
    input: { projectId: string; mutationId: string; sessionId: string }
  ): Promise<{
    state: "fenced" | "activated";
    shareGrantId: string | null;
    grantVersion: number | null;
  }>;
  getStatus(
    actor: ProjectSharePolicyActor,
    projectId: string
  ): Promise<ProjectSharePolicyReview>;
  getIssueStatus(
    actor: ProjectSharePolicyActor,
    input: { projectId: string; sessionId: string; policyVersion: number }
  ): Promise<{
    state: "absent" | "staged" | "activated" | "issued_terminal" | "blocked";
    policyVersion: number | null;
    sessionId: string;
    logicalMemoryId: string | null;
    sourceRevision: number | null;
    mappingRevision: number | null;
    pendingShareId: string | null;
    shareGrantId: string | null;
    grantVersion: number | null;
    grantLifecycle: string | null;
    teamId: string;
    workspaceId: string;
    ownerTeamMemberId: string;
  }>;
  prepareInitialManifest(
    actor: ProjectSharePolicyActor,
    input: {
      projectId: string;
      expectedPolicyVersion: number;
      personalProjectBindingHash: string;
      signingPublicKey: string;
      entries: readonly ProjectShareManifestEntry[];
    }
  ): Promise<{
    manifestId: string;
    manifestHash: string;
    expiresAt: string;
    projectId: string;
    ownerTeamMemberId: string;
    deviceCredentialId: string;
    upstreamBackendId: string;
    expectedPolicyVersion: number;
    personalProjectBindingHash: string;
    signingPublicKey: string;
    entries: ProjectShareManifestEntry[];
  }>;
  getReview(
    actor: ProjectSharePolicyActor,
    input: {
      projectId: string;
      expectedPolicyVersion: number;
      manifestId?: string;
      manifestHash?: string;
    }
  ): Promise<ProjectSharePolicyReview | null>;
  enable(
    actor: ProjectSharePolicyActor,
    input: {
      projectId: string;
      expectedPolicyVersion: number;
      manifestId: string;
      manifestHash: string;
      signingPublicKey: string;
      currentEntries: readonly ProjectShareManifestEntry[];
    }
  ): Promise<{
    policyId: string;
    version: number;
    eligible: ProjectShareManifestEntry[];
  }>;
  revoke(
    actor: ProjectSharePolicyActor,
    input: { projectId: string; expectedPolicyVersion: number }
  ): Promise<{ policyId: string; version: number }>;
  stageInitialBundle(
    actor: ProjectSharePolicyActor,
    input: {
      projectId: string;
      expectedPolicyVersion: number;
      personalProjectBindingHash: string;
      sessionId: string;
      mappingRevision: number;
      proof?: ProjectSharePolicyProof;
      candidate: Omit<
        CandidateInput,
        | "teamId"
        | "teamWorkspaceId"
        | "mode"
        | "maximumFidelity"
        | "includeCuratedMemory"
        | "expiresAt"
        | "authority"
      >;
    }
  ): Promise<
    | { state: "staged"; pendingShareId: string }
    | { state: "skipped"; reason: "occupied" | "already_issued" }
  >;
  excludeSession(
    actor: ProjectSharePolicyActor,
    input: {
      projectId: string;
      sessionId: string;
      expectedPolicyVersion: number;
    }
  ): Promise<{
    blocked: true;
    withdrawalRequired: boolean;
    withdrawalTarget: { shareGrantId: string; grantVersion: number } | null;
  }>;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex = /^[0-9a-f]{64}$/;
const assertManifest = (entries: readonly ProjectShareManifestEntry[]) => {
  if (entries.length > 100)
    throw new ProjectSharePolicyConflictError(
      "Initial manifest exceeds 100 Captured Sessions"
    );
  const ids = new Set<string>();
  const memories = new Set<string>();
  const normalized = entries.map((entry) => {
    const sessionId = entry.sessionId.toLowerCase();
    const logicalMemoryId = entry.logicalMemoryId.toLowerCase();
    if (
      !uuid.test(entry.sessionId) ||
      !uuid.test(entry.logicalMemoryId) ||
      !Number.isSafeInteger(entry.sourceRevision) ||
      entry.sourceRevision < 1 ||
      !Number.isSafeInteger(entry.mappingRevision) ||
      entry.mappingRevision < 1 ||
      typeof entry.reviewLabel !== "string" ||
      entry.reviewLabel.trim().length < 1 ||
      Buffer.byteLength(entry.reviewLabel, "utf8") > 160 ||
      /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u.test(
        entry.reviewLabel
      ) ||
      ids.has(sessionId) ||
      memories.has(logicalMemoryId)
    )
      throw new ProjectSharePolicyConflictError(
        "Initial manifest is incomplete or ambiguous"
      );
    ids.add(sessionId);
    memories.add(logicalMemoryId);
    return {
      sessionId,
      logicalMemoryId,
      sourceRevision: entry.sourceRevision,
      mappingRevision: entry.mappingRevision,
      reviewLabel: entry.reviewLabel.trim()
    };
  });
  normalized.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return normalized;
};
const manifestHash = (
  entries: readonly ProjectShareManifestEntry[],
  signingPublicKey: string
) => projectSharePolicyManifestHash(assertManifest(entries), signingPublicKey);
const assertSigningPublicKey = (key: string): void => {
  try {
    const der = Buffer.from(key, "base64");
    if (
      der.toString("base64") !== key ||
      der.length !== 44 ||
      createPublicKey({ key: der, format: "der", type: "spki" })
        .asymmetricKeyType !== "ed25519"
    )
      throw new Error("invalid");
  } catch {
    throw new ProjectSharePolicyConflictError(
      "Project policy signing key is invalid"
    );
  }
};

interface ScopeRow {
  project_id: string;
  team_id: string;
  workspace_id: string;
  project_name: string;
  team_member_id: string;
}
interface PolicyRow {
  id: string;
  version: number;
  status: "active" | "revoked";
  device_credential_id: string;
  upstream_backend_id: string;
  personal_project_binding_hash: string;
  signing_public_key: string;
  initial_manifest_hash: string;
  initial_manifest: ProjectShareManifestEntry[];
  approved_session_ids: string[];
}
interface ManifestRow {
  id: string;
  manifest: ProjectShareManifestEntry[];
  manifest_hash: string;
  personal_project_binding_hash: string;
  signing_public_key: string;
  eligible_session_ids: string[];
}

const scope = async (
  client: pg.PoolClient,
  actor: ProjectSharePolicyActor,
  projectId: string
) => {
  // Match Workspace Project lifecycle mutation order: Team, membership,
  // Workspace, access grant, Project, Project member. A leave, removal, or
  // deletion cannot cross a policy admission between check and commit.
  const identity = await client.query<{
    team_id: string;
    workspace_id: string;
  }>(`select team_id,workspace_id from workspace_projects where id=$1`, [
    projectId
  ]);
  if (!identity.rows[0])
    throw new ProjectSharePolicyAuthorizationError(
      "Current Project member and device authority unavailable"
    );
  const { team_id: teamId, workspace_id: workspaceId } = identity.rows[0];
  await client.query(`select id from teams where id=$1 for update`, [teamId]);
  const membership = await client.query<{ id: string }>(
    `select id from team_memberships where team_id=$1 and user_id=$2 for update`,
    [teamId, actor.userId]
  );
  if (!membership.rows[0])
    throw new ProjectSharePolicyAuthorizationError(
      "Current Project member and device authority unavailable"
    );
  await client.query(`select id from team_workspaces where id=$1 for update`, [
    workspaceId
  ]);
  await client.query(
    `select team_workspace_id from team_workspace_access_grants
      where team_workspace_id=$1 and team_id=$2 and user_id=$3 for update`,
    [workspaceId, teamId, actor.userId]
  );
  await client.query(
    `select id from workspace_projects where id=$1 for update`,
    [projectId]
  );
  await client.query(
    `select team_member_id from workspace_project_members
      where workspace_project_id=$1 and team_member_id=$2 for update`,
    [projectId, membership.rows[0].id]
  );
  const result = await client.query<ScopeRow>(
    `select project.id as project_id,project.team_id,project.workspace_id,
            project.name as project_name,member.id as team_member_id
       from workspace_projects project
       join teams team on team.id=project.team_id
         and team.lifecycle='active' and team.entitlement_status in ('active','grace')
       join team_memberships member on member.team_id=project.team_id
         and member.user_id=$2 and member.status='enabled'
         and member.disabled_at is null
       join users owner_user on owner_user.id=$2
         and owner_user.disabled_at is null and owner_user.deleted_at is null
       join workspace_project_members link on link.workspace_project_id=project.id
         and link.team_member_id=member.id and link.access='write'
         and link.disabled_at is null
       join team_workspaces workspace on workspace.id=project.workspace_id
         and workspace.team_id=project.team_id and workspace.lifecycle='active'
         and workspace.archived_at is null
       join team_workspace_access_grants access on access.team_workspace_id=workspace.id
         and access.team_id=team.id and access.user_id=$2
         and access.disabled_at is null and access.access='write'
         and access.can_share_owned_memory=true
       join device_credentials credential on credential.id=$3
         and credential.owner_user_id=$2 and credential.upstream_backend_id=$4
         and credential.revoked_at is null
         and (credential.expires_at is null or credential.expires_at>now())
         and 'share_grant_management'=any(credential.operation_families)
      where project.id=$1 and project.lifecycle='active'
      for share of credential`,
    [projectId, actor.userId, actor.deviceCredentialId, actor.upstreamBackendId]
  );
  const row = result.rows[0];
  if (!row)
    throw new ProjectSharePolicyAuthorizationError(
      "Current Project member and device authority unavailable"
    );
  return row;
};
const policy = async (
  client: pg.PoolClient,
  projectId: string,
  memberId: string
) => {
  const result = await client.query<PolicyRow>(
    `select id,version,status,device_credential_id,upstream_backend_id,
            personal_project_binding_hash,signing_public_key,
            initial_manifest_hash,initial_manifest,approved_session_ids
       from workspace_project_share_policies
      where workspace_project_id=$1 and source_owner_team_member_id=$2 for update`,
    [projectId, memberId]
  );
  return result.rows[0] ?? null;
};
const assertVersion = (row: PolicyRow | null, expected: number) => {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    (row?.version ?? 0) !== expected
  )
    throw new ProjectSharePolicyConflictError(
      "Project share policy version changed"
    );
};
const eligibleDestination = async (
  client: pg.PoolClient,
  workspaceId: string,
  logicalMemoryId: string
) => {
  const result = await client.query<{ occupied: boolean }>(
    `select exists (
       select 1 from team_memory_share_grants grant_row
        where grant_row.team_workspace_id=$1 and grant_row.logical_memory_id=$2
     ) or exists (
       select 1 from pending_share_operations pending
        where pending.team_workspace_id=$1 and pending.logical_memory_id=$2
          and pending.state in ('preparing','failed','needs_attention','activated')
     ) as occupied`,
    [workspaceId, logicalMemoryId]
  );
  return result.rows[0]?.occupied !== true;
};
const excludedSession = async (
  client: pg.PoolClient,
  projectId: string,
  memberId: string,
  sessionId: string
): Promise<boolean> => {
  const found = await client.query(
    `select 1 from workspace_project_share_policy_exclusions
      where workspace_project_id=$1 and source_owner_team_member_id=$2 and session_id=$3`,
    [projectId, memberId, sessionId]
  );
  return Boolean(found.rows[0]);
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

export const createProjectSharePolicyRepository = (
  pool: pg.Pool
): ProjectSharePolicyRepository => ({
  async fenceExplicitOffer(actor, input) {
    return transaction(pool, async (client) => {
      const current = await scope(client, actor, input.projectId);
      const pending = await client.query<{
        id: string;
        grant_id: string | null;
        state: string;
        grant_version: number | null;
        grant_lifecycle: string | null;
        grant_frozen_at: Date | null;
      }>(
        `select pending.id,pending.grant_id,pending.state,
                grant_row.grant_version,grant_row.lifecycle as grant_lifecycle,
                grant_row.frozen_at as grant_frozen_at
           from pending_share_operations pending
           join captured_session_logical_memories source
             on source.logical_memory_id=pending.logical_memory_id
             and source.source_session_id=$3
           left join team_memory_share_grants grant_row on grant_row.id=pending.grant_id
          where pending.workspace_project_id=$1 and pending.mutation_id=$2
            and pending.owner_user_id=$4 and pending.team_id=$5
            and pending.team_workspace_id=$6
          limit 1 for update of pending`,
        [
          input.projectId,
          input.mutationId,
          input.sessionId,
          actor.userId,
          current.team_id,
          current.workspace_id
        ]
      );
      const row = pending.rows[0];
      if (
        row?.state === "activated" &&
        row.grant_lifecycle === "active" &&
        !row.grant_frozen_at
      )
        return {
          state: "activated" as const,
          shareGrantId: row.grant_id,
          grantVersion: row.grant_version
        };
      await client.query(
        `insert into workspace_project_explicit_share_fences
         (workspace_project_id,source_owner_team_member_id,owner_user_id,
          session_id,mutation_id) values ($1,$2,$3,$4,$5)
         on conflict (mutation_id) do nothing`,
        [
          input.projectId,
          current.team_member_id,
          actor.userId,
          input.sessionId,
          input.mutationId
        ]
      );
      const exact = await client.query(
        `select 1 from workspace_project_explicit_share_fences
          where mutation_id=$1 and workspace_project_id=$2
            and source_owner_team_member_id=$3 and owner_user_id=$4
            and session_id=$5`,
        [
          input.mutationId,
          input.projectId,
          current.team_member_id,
          actor.userId,
          input.sessionId
        ]
      );
      if (!exact.rows[0])
        throw new ProjectSharePolicyConflictError(
          "Explicit Conversation fence identity changed"
        );
      return {
        state: "fenced" as const,
        shareGrantId: null,
        grantVersion: null
      };
    });
  },
  async explicitPendingStatus(actor, input) {
    return transaction(pool, async (client) => {
      const current = await scope(client, actor, input.projectId);
      const result = await client.query<{
        id: string;
        state: string;
        grant_id: string | null;
        grant_version: number | null;
        grant_lifecycle: string | null;
        source_revision: string;
        bound: boolean;
      }>(
        `select pending.id,pending.state,pending.grant_id,
                grant_row.grant_version,grant_row.lifecycle as grant_lifecycle,
                pending.source_revision::text,
                exists(select 1 from workspace_project_share_grant_bindings binding
                  where binding.workspace_project_id=$1
                    and binding.share_grant_id=pending.grant_id
                    and binding.source_owner_team_member_id=$5) as bound
           from pending_share_operations pending
           join captured_session_logical_memories source
             on source.logical_memory_id=pending.logical_memory_id
             and source.source_session_id=$3
           left join team_memory_share_grants grant_row
             on grant_row.id=pending.grant_id
          where pending.workspace_project_id=$1 and pending.mutation_id=$2
            and pending.logical_memory_id=$4 and pending.owner_user_id=$6
            and pending.team_id=$7 and pending.team_workspace_id=$8
            and pending.authority_source='device_action_grant'
          limit 1`,
        [
          input.projectId,
          input.mutationId,
          input.sessionId,
          input.logicalMemoryId,
          current.team_member_id,
          actor.userId,
          current.team_id,
          current.workspace_id
        ]
      );
      const row = result.rows[0];
      const fenced = !row
        ? await client.query(
            `select 1 from workspace_project_explicit_share_fences
          where workspace_project_id=$1 and mutation_id=$2
            and source_owner_team_member_id=$3 and owner_user_id=$4
            and session_id=$5`,
            [
              input.projectId,
              input.mutationId,
              current.team_member_id,
              actor.userId,
              input.sessionId
            ]
          )
        : null;
      return {
        state: !row
          ? fenced?.rows[0]
            ? ("blocked" as const)
            : ("absent" as const)
          : row.state === "activated" &&
              row.grant_lifecycle === "active" &&
              row.bound
            ? ("activated" as const)
            : row.state === "preparing" ||
                row.state === "needs_attention" ||
                row.state === "failed" ||
                (row.state === "activated" &&
                  row.grant_lifecycle === "active" &&
                  !row.bound)
              ? ("pending" as const)
              : ("blocked" as const),
        pendingShareId: row?.id ?? null,
        shareGrantId: row?.grant_id ?? null,
        grantVersion: row?.grant_version ?? null,
        sourceRevision: row ? Number(row.source_revision) : null,
        teamId: String(current.team_id),
        workspaceId: String(current.workspace_id),
        ownerTeamMemberId: String(current.team_member_id)
      };
    });
  },
  async getStatus(actor, projectId) {
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, projectId);
      const currentPolicy = await policy(
        client,
        projectId,
        currentScope.team_member_id
      );
      const reviewSources: ProjectSharePolicyReview["reviewSources"] = [];
      for (const entry of currentPolicy?.status === "active"
        ? currentPolicy.initial_manifest
        : [])
        reviewSources.push({
          sessionId: entry.sessionId,
          reviewLabel: entry.reviewLabel,
          eligible:
            currentPolicy!.approved_session_ids.includes(entry.sessionId) &&
            !(await excludedSession(
              client,
              projectId,
              currentScope.team_member_id,
              entry.sessionId
            )) &&
            (await eligibleDestination(
              client,
              currentScope.workspace_id,
              entry.logicalMemoryId
            ))
        });
      return {
        policyId: currentPolicy?.id ?? null,
        ownerTeamMemberId: currentScope.team_member_id,
        projectId: currentScope.project_id,
        teamId: currentScope.team_id,
        workspaceId: currentScope.workspace_id,
        projectName: currentScope.project_name,
        policyVersion: currentPolicy?.version ?? 0,
        status: currentPolicy?.status ?? "absent",
        manifestId: null,
        manifestHash: null,
        signingPublicKey: currentPolicy?.signing_public_key ?? null,
        personalProjectBindingHash:
          currentPolicy?.personal_project_binding_hash ?? null,
        deviceCredentialId: currentPolicy?.device_credential_id ?? null,
        eligibleCount: reviewSources.filter((source) => source.eligible).length,
        reviewSources
      };
    });
  },
  async getIssueStatus(actor, input) {
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, input.projectId);
      const found = await client.query<{
        policy_version: number;
        logical_memory_id: string;
        source_revision: string;
        mapping_revision: number;
        pending_share_id: string | null;
        private_blocked_at: Date | null;
        activated_at: Date | null;
        grant_id: string | null;
        grant_version: number | null;
        grant_lifecycle: string | null;
      }>(
        `select issue.policy_version,issue.logical_memory_id,
                issue.source_revision::text,issue.mapping_revision,
                issue.pending_share_id,issue.private_blocked_at,issue.activated_at,
                grant_row.id as grant_id,grant_row.grant_version,
                grant_row.lifecycle as grant_lifecycle
           from workspace_project_share_policy_issues issue
           join workspace_project_share_policies policy on policy.id=issue.policy_id
           left join pending_share_operations pending on pending.id=issue.pending_share_id
           left join team_memory_share_grants grant_row on grant_row.id=pending.grant_id
          where policy.workspace_project_id=$1
            and policy.source_owner_team_member_id=$2
            and issue.session_id=$3 and issue.policy_version=$4
          order by issue.created_at desc,issue.id desc limit 1`,
        [
          input.projectId,
          currentScope.team_member_id,
          input.sessionId,
          input.policyVersion
        ]
      );
      const row = found.rows[0];
      const state = !row
        ? "absent"
        : row.activated_at && row.grant_id
          ? row.grant_lifecycle === "active"
            ? "activated"
            : "issued_terminal"
          : row.private_blocked_at
            ? "blocked"
            : "staged";
      return {
        state,
        policyVersion: row?.policy_version ?? null,
        sessionId: input.sessionId,
        logicalMemoryId: row?.logical_memory_id ?? null,
        sourceRevision: row ? Number(row.source_revision) : null,
        mappingRevision: row?.mapping_revision ?? null,
        pendingShareId: row?.pending_share_id ?? null,
        shareGrantId:
          state === "activated" || state === "issued_terminal"
            ? row!.grant_id
            : null,
        grantVersion:
          state === "activated" || state === "issued_terminal"
            ? row!.grant_version
            : null,
        grantLifecycle: row?.grant_lifecycle ?? null,
        teamId: currentScope.team_id,
        workspaceId: currentScope.workspace_id,
        ownerTeamMemberId: currentScope.team_member_id
      };
    });
  },
  async prepareInitialManifest(actor, input) {
    const entries = assertManifest(input.entries);
    assertSigningPublicKey(input.signingPublicKey);
    if (!hex.test(input.personalProjectBindingHash))
      throw new ProjectSharePolicyConflictError("Project binding is invalid");
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, input.projectId);
      const currentPolicy = await policy(
        client,
        input.projectId,
        currentScope.team_member_id
      );
      assertVersion(currentPolicy, input.expectedPolicyVersion);
      if (currentPolicy?.status === "active")
        throw new ProjectSharePolicyConflictError(
          "Project share policy is already active"
        );
      const hash = manifestHash(entries, input.signingPublicKey);
      const eligibleSessionIds: string[] = [];
      for (const entry of entries)
        if (
          !(await excludedSession(
            client,
            input.projectId,
            currentScope.team_member_id,
            entry.sessionId
          )) &&
          (await eligibleDestination(
            client,
            currentScope.workspace_id,
            entry.logicalMemoryId
          ))
        )
          eligibleSessionIds.push(entry.sessionId);
      const stored = await client.query<{ id: string; expires_at: Date }>(
        `insert into workspace_project_share_policy_manifests
         (workspace_project_id,owner_user_id,device_credential_id,upstream_backend_id,
          expected_policy_version,personal_project_binding_hash,signing_public_key,
          manifest_hash,manifest,eligible_session_ids,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,now()+interval '5 minutes')
         returning id,expires_at`,
        [
          input.projectId,
          actor.userId,
          actor.deviceCredentialId,
          actor.upstreamBackendId,
          input.expectedPolicyVersion,
          input.personalProjectBindingHash,
          input.signingPublicKey,
          hash,
          JSON.stringify(entries),
          JSON.stringify(eligibleSessionIds)
        ]
      );
      return {
        manifestId: stored.rows[0]!.id,
        manifestHash: hash,
        expiresAt: stored.rows[0]!.expires_at.toISOString(),
        projectId: input.projectId,
        ownerTeamMemberId: currentScope.team_member_id,
        deviceCredentialId: actor.deviceCredentialId,
        upstreamBackendId: actor.upstreamBackendId,
        expectedPolicyVersion: input.expectedPolicyVersion,
        personalProjectBindingHash: input.personalProjectBindingHash,
        signingPublicKey: input.signingPublicKey,
        entries
      };
    });
  },
  async getReview(actor, input) {
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, input.projectId);
      const currentPolicy = await policy(
        client,
        input.projectId,
        currentScope.team_member_id
      );
      assertVersion(currentPolicy, input.expectedPolicyVersion);
      let eligibleCount = 0;
      let signingPublicKey: string | null = null;
      const reviewSources: ProjectSharePolicyReview["reviewSources"] = [];
      if (input.manifestId || input.manifestHash) {
        if (!input.manifestId || !input.manifestHash)
          throw new ProjectSharePolicyConflictError(
            "Exact initial manifest required"
          );
        const prepared = await client.query<ManifestRow>(
          `select id,manifest,manifest_hash,personal_project_binding_hash,
                  signing_public_key,eligible_session_ids
             from workspace_project_share_policy_manifests
            where id=$1 and workspace_project_id=$2 and owner_user_id=$3
              and device_credential_id=$4 and upstream_backend_id=$6
              and expected_policy_version=$5
              and expires_at>now() and consumed_at is null for share`,
          [
            input.manifestId,
            input.projectId,
            actor.userId,
            actor.deviceCredentialId,
            input.expectedPolicyVersion,
            actor.upstreamBackendId
          ]
        );
        if (prepared.rows[0]?.manifest_hash !== input.manifestHash)
          throw new ProjectSharePolicyConflictError(
            "Initial manifest is stale"
          );
        signingPublicKey = prepared.rows[0]!.signing_public_key;
        for (const entry of prepared.rows[0]!.manifest) {
          const eligible =
            prepared.rows[0]!.eligible_session_ids.includes(entry.sessionId) &&
            !(await excludedSession(
              client,
              input.projectId,
              currentScope.team_member_id,
              entry.sessionId
            )) &&
            (await eligibleDestination(
              client,
              currentScope.workspace_id,
              entry.logicalMemoryId
            ));
          reviewSources.push({
            sessionId: entry.sessionId,
            reviewLabel: entry.reviewLabel,
            eligible
          });
          if (eligible) eligibleCount += 1;
        }
      }
      return {
        policyId: currentPolicy?.id ?? null,
        ownerTeamMemberId: currentScope.team_member_id,
        projectId: currentScope.project_id,
        teamId: currentScope.team_id,
        workspaceId: currentScope.workspace_id,
        projectName: currentScope.project_name,
        policyVersion: currentPolicy?.version ?? 0,
        status: currentPolicy?.status ?? "absent",
        manifestId: input.manifestId ?? null,
        manifestHash: input.manifestHash ?? null,
        signingPublicKey,
        personalProjectBindingHash:
          currentPolicy?.personal_project_binding_hash ?? null,
        deviceCredentialId: currentPolicy?.device_credential_id ?? null,
        eligibleCount,
        reviewSources
      };
    });
  },
  async enable(actor, input) {
    const currentEntries = assertManifest(input.currentEntries);
    assertSigningPublicKey(input.signingPublicKey);
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, input.projectId);
      const currentPolicy = await policy(
        client,
        input.projectId,
        currentScope.team_member_id
      );
      assertVersion(currentPolicy, input.expectedPolicyVersion);
      if (currentPolicy?.status === "active")
        throw new ProjectSharePolicyConflictError(
          "Project share policy is already active"
        );
      const prepared = await client.query<ManifestRow>(
        `select id,manifest,manifest_hash,personal_project_binding_hash,
                signing_public_key,eligible_session_ids
           from workspace_project_share_policy_manifests
          where id=$1 and workspace_project_id=$2 and owner_user_id=$3
            and device_credential_id=$4 and upstream_backend_id=$6
            and expected_policy_version=$5
            and expires_at>now() and consumed_at is null for update`,
        [
          input.manifestId,
          input.projectId,
          actor.userId,
          actor.deviceCredentialId,
          input.expectedPolicyVersion,
          actor.upstreamBackendId
        ]
      );
      const manifest = prepared.rows[0];
      if (
        !manifest ||
        manifest.manifest_hash !== input.manifestHash ||
        manifest.signing_public_key !== input.signingPublicKey ||
        manifestHash(currentEntries, input.signingPublicKey) !==
          manifest.manifest_hash
      )
        throw new ProjectSharePolicyConflictError(
          "Initial manifest changed; review again"
        );
      const eligible: ProjectShareManifestEntry[] = [];
      for (const entry of currentEntries)
        if (
          manifest.eligible_session_ids.includes(entry.sessionId) &&
          !(await excludedSession(
            client,
            input.projectId,
            currentScope.team_member_id,
            entry.sessionId
          )) &&
          (await eligibleDestination(
            client,
            currentScope.workspace_id,
            entry.logicalMemoryId
          ))
        )
          eligible.push(entry);
      const nextVersion = input.expectedPolicyVersion + 1;
      const upserted = await client.query<{ id: string }>(
        `insert into workspace_project_share_policies
         (workspace_project_id,source_owner_team_member_id,owner_user_id,
          device_credential_id,upstream_backend_id,personal_project_binding_hash,
          version,status,initial_manifest_hash,initial_manifest,
          approved_session_ids,signing_public_key)
         values ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::jsonb,$10::jsonb,$11)
         on conflict (workspace_project_id,source_owner_team_member_id) do update
           set device_credential_id=excluded.device_credential_id,
               upstream_backend_id=excluded.upstream_backend_id,
               personal_project_binding_hash=excluded.personal_project_binding_hash,
               version=excluded.version,status='active',revoked_at=null,
               enabled_at=now(),initial_manifest_hash=excluded.initial_manifest_hash,
               initial_manifest=excluded.initial_manifest,updated_at=now()
              ,approved_session_ids=excluded.approved_session_ids
              ,signing_public_key=excluded.signing_public_key
         where workspace_project_share_policies.status='revoked'
           and workspace_project_share_policies.version=excluded.version-1
         returning id`,
        [
          input.projectId,
          currentScope.team_member_id,
          actor.userId,
          actor.deviceCredentialId,
          actor.upstreamBackendId,
          manifest.personal_project_binding_hash,
          nextVersion,
          manifest.manifest_hash,
          JSON.stringify(currentEntries),
          JSON.stringify(manifest.eligible_session_ids),
          input.signingPublicKey
        ]
      );
      if (!upserted.rows[0])
        throw new ProjectSharePolicyConflictError(
          "Project share policy changed"
        );
      await client.query(
        `update workspace_project_share_policy_manifests set consumed_at=now() where id=$1`,
        [input.manifestId]
      );
      return { policyId: upserted.rows[0].id, version: nextVersion, eligible };
    });
  },
  async revoke(actor, input) {
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, input.projectId);
      const currentPolicy = await policy(
        client,
        input.projectId,
        currentScope.team_member_id
      );
      assertVersion(currentPolicy, input.expectedPolicyVersion);
      if (!currentPolicy || currentPolicy.status !== "active")
        throw new ProjectSharePolicyConflictError(
          "Only an active policy can be revoked"
        );
      const changed = await client.query<{ id: string; version: number }>(
        `update workspace_project_share_policies
            set status='revoked',version=version+1,revoked_at=now(),updated_at=now()
          where id=$1 and version=$2 and status='active'
          returning id,version`,
        [currentPolicy.id, input.expectedPolicyVersion]
      );
      if (!changed.rows[0])
        throw new ProjectSharePolicyConflictError(
          "Project share policy changed"
        );
      return { policyId: changed.rows[0].id, version: changed.rows[0].version };
    });
  },
  async stageInitialBundle(actor, input) {
    const candidate = input.candidate;
    if (
      candidate.source.kind !== "captured_session" ||
      candidate.source.sessionId !== input.sessionId ||
      candidate.source.logicalMemoryId !== candidate.logicalMemoryId ||
      candidate.activationRepresentation !== "lcm_leaves" ||
      !candidate.sourceCapabilities.includes("lcm_leaves") ||
      !Number.isSafeInteger(input.mappingRevision) ||
      input.mappingRevision < 1 ||
      !Number.isSafeInteger(candidate.sourceRevision) ||
      candidate.sourceRevision < 1 ||
      candidate.deviceCredentialId !== actor.deviceCredentialId ||
      !hex.test(input.personalProjectBindingHash)
    )
      throw new ProjectSharePolicyConflictError(
        "Bundled source or policy binding is invalid"
      );
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, input.projectId);
      const currentPolicy = await policy(
        client,
        input.projectId,
        currentScope.team_member_id
      );
      assertVersion(currentPolicy, input.expectedPolicyVersion);
      if (
        !currentPolicy ||
        currentPolicy.status !== "active" ||
        currentPolicy.device_credential_id !== actor.deviceCredentialId ||
        currentPolicy.upstream_backend_id !== actor.upstreamBackendId ||
        currentPolicy.personal_project_binding_hash !==
          input.personalProjectBindingHash
      )
        throw new ProjectSharePolicyUnavailableError(
          "Active exact owner Project share policy unavailable"
        );
      const closureHash = createHash("sha256")
        .update(
          JSON.stringify({
            manifest: candidate.manifest,
            byteCount: candidate.byteCount,
            itemCount: candidate.itemCount,
            excludedItemCount: candidate.excludedItemCount
          })
        )
        .digest("hex");
      if (input.proof) {
        const proof = input.proof.payload;
        if (
          !verifyProjectSharePolicyProof(
            input.proof,
            currentPolicy.signing_public_key
          ) ||
          proof.policyId !== currentPolicy.id ||
          proof.policyVersion !== currentPolicy.version ||
          proof.backendId !== actor.upstreamBackendId ||
          proof.workspaceProjectId !== input.projectId ||
          proof.ownerUserId !== actor.userId ||
          proof.ownerTeamMemberId !== currentScope.team_member_id ||
          proof.deviceCredentialId !== actor.deviceCredentialId ||
          proof.personalProjectBindingHash !==
            input.personalProjectBindingHash ||
          proof.sessionId !== input.sessionId ||
          proof.logicalMemoryId !== candidate.logicalMemoryId ||
          proof.sourceRevision !== candidate.sourceRevision ||
          proof.mappingRevision !== input.mappingRevision ||
          proof.candidateHash !== candidate.candidateHash ||
          proof.closureHash !== closureHash
        )
          throw new ProjectSharePolicyConflictError(
            "Trusted future capture proof is invalid or stale"
          );
      } else {
        const approved = currentPolicy.initial_manifest.find(
          (entry) =>
            entry.sessionId === input.sessionId &&
            entry.logicalMemoryId === candidate.logicalMemoryId &&
            entry.sourceRevision === candidate.sourceRevision &&
            entry.mappingRevision === input.mappingRevision &&
            currentPolicy.approved_session_ids.includes(entry.sessionId)
        );
        if (!approved)
          throw new ProjectSharePolicyConflictError(
            "Captured Session is not in the exact approved initial manifest"
          );
      }
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [
          `pending-share-destination:${actor.userId}:${candidate.logicalMemoryId}:${currentScope.team_id}:${currentScope.workspace_id}`
        ]
      );
      const priorIssue = await client.query(
        `select id from workspace_project_share_policy_issues
          where policy_id=$1 and session_id=$2 for update`,
        [currentPolicy.id, input.sessionId]
      );
      if (priorIssue.rows[0])
        return { state: "skipped" as const, reason: "already_issued" as const };
      if (
        await excludedSession(
          client,
          input.projectId,
          currentScope.team_member_id,
          input.sessionId
        )
      )
        return { state: "skipped" as const, reason: "occupied" as const };
      if (
        !(await eligibleDestination(
          client,
          currentScope.workspace_id,
          candidate.logicalMemoryId
        ))
      )
        return { state: "skipped" as const, reason: "occupied" as const };
      const issueId = randomUUID();
      await client.query(
        `insert into workspace_project_share_policy_issues
         (id,policy_id,policy_version,session_id,logical_memory_id,source_revision,
          mapping_revision,source_manifest_hash,provenance,proof_nonce)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          issueId,
          currentPolicy.id,
          currentPolicy.version,
          input.sessionId,
          candidate.logicalMemoryId,
          candidate.sourceRevision,
          input.mappingRevision,
          input.proof ? closureHash : currentPolicy.initial_manifest_hash,
          input.proof ? "future" : "initial",
          input.proof?.payload.nonce ?? null
        ]
      );
      const unavailableEncryption = (): never => {
        throw new ProjectSharePolicyUnavailableError(
          "Policy staging cannot decrypt source content"
        );
      };
      const shared = createSharedMemoryRepository(
        createSavepointPool(client, "project_share_policy"),
        {
          resolveTeamEncryptionProvider: unavailableEncryption,
          resolveOwnerPrivateReplicaEncryptionProvider: unavailableEncryption,
          resolvePersonalEncryptionProvider: unavailableEncryption,
          projectSharePolicyExecution: true
        }
      );
      const authority = {
        action: SHARED_MEMORY_AUTHORITY,
        source: "project_share_policy",
        referenceId: issueId
      } satisfies SharedMemoryAuthorityContext;
      const preview = await shared.createSharedMemoryCandidatePreview(
        { userId: actor.userId },
        {
          ...candidate,
          teamId: currentScope.team_id,
          teamWorkspaceId: currentScope.workspace_id,
          mode: "continuous",
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          expiresAt: null,
          authority
        }
      );
      if (!preview)
        throw new ProjectSharePolicyConflictError(
          "Exact Bundled candidate is not ready"
        );
      const pending = await shared.createPendingShare(
        { userId: actor.userId },
        {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: randomUUID(),
          logicalMemoryId: candidate.logicalMemoryId,
          source: candidate.source,
          sourceCapabilities: candidate.sourceCapabilities,
          activationRepresentation: "lcm_leaves",
          teamId: currentScope.team_id,
          teamWorkspaceId: currentScope.workspace_id,
          preview: {
            previewId: preview.previewId,
            previewHash: preview.previewHash
          },
          previewRevision: preview.previewRevision,
          mode: "continuous",
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          expiresAt: null,
          authority
        }
      );
      const attached = await client.query(
        `update workspace_project_share_policy_issues set pending_share_id=$2
          where id=$1 and pending_share_id is null and private_blocked_at is null
          returning id`,
        [issueId, pending.id]
      );
      if (!attached.rows[0])
        throw new ProjectSharePolicyConflictError(
          "One-use Project policy reservation changed"
        );
      return { state: "staged" as const, pendingShareId: pending.id };
    });
  },
  async excludeSession(actor, input) {
    return transaction(pool, async (client) => {
      const currentScope = await scope(client, actor, input.projectId);
      const currentPolicy = await policy(
        client,
        input.projectId,
        currentScope.team_member_id
      );
      assertVersion(currentPolicy, input.expectedPolicyVersion);
      await client.query(
        `insert into workspace_project_share_policy_exclusions
         (workspace_project_id,source_owner_team_member_id,session_id)
         values ($1,$2,$3) on conflict do nothing`,
        [input.projectId, currentScope.team_member_id, input.sessionId]
      );
      const issue = await client.query<{
        activated_at: Date | null;
        pending_share_id: string | null;
      }>(
        `update workspace_project_share_policy_issues
            set private_blocked_at=coalesce(private_blocked_at,now())
          where policy_id=$1 and session_id=$2
          returning activated_at,pending_share_id`,
        [currentPolicy?.id ?? null, input.sessionId]
      );
      let withdrawalTarget: {
        shareGrantId: string;
        grantVersion: number;
      } | null = null;
      if (issue.rows[0]?.activated_at && issue.rows[0].pending_share_id) {
        const grant = await client.query<{
          id: string;
          grant_version: number;
          lifecycle: string;
          revoked_at: Date | null;
          frozen_at: Date | null;
        }>(
          `select grant_row.id,grant_row.grant_version,grant_row.lifecycle,grant_row.revoked_at,grant_row.frozen_at
             from pending_share_operations pending
             join team_memory_share_grants grant_row on grant_row.id=pending.grant_id
            where pending.id=$1 and grant_row.owner_user_id=$2
            for update of grant_row`,
          [issue.rows[0].pending_share_id, actor.userId]
        );
        if (!grant.rows[0])
          throw new ProjectSharePolicyConflictError(
            "Policy grant withdrawal state is unavailable"
          );
        if (
          grant.rows[0].lifecycle === "active" &&
          !grant.rows[0].revoked_at &&
          !grant.rows[0].frozen_at
        )
          withdrawalTarget = {
            shareGrantId: grant.rows[0].id,
            grantVersion: grant.rows[0].grant_version
          };
      }
      // An explicit moved-in or Share-again Pending Share has its own Native
      // consent, but still belongs to this exact Project and Conversation.
      // Active, unfrozen grants must freeze before owner-local privacy commits.
      const explicit = await client.query<{
        id: string;
        grant_version: number;
      }>(
        `select grant_row.id,grant_row.grant_version
           from workspace_project_share_grant_bindings binding
           join team_memory_share_grants grant_row
             on grant_row.id=binding.share_grant_id
           join captured_session_logical_memories source
             on source.logical_memory_id=grant_row.logical_memory_id
          where binding.workspace_project_id=$1
            and binding.source_owner_team_member_id=$2
            and source.source_session_id=$3
            and grant_row.owner_user_id=$4
            and grant_row.lifecycle='active' and grant_row.revoked_at is null
            and grant_row.frozen_at is null
          order by grant_row.id for update of grant_row`,
        [
          input.projectId,
          currentScope.team_member_id,
          input.sessionId,
          actor.userId
        ]
      );
      if (
        explicit.rows.length > 1 ||
        (explicit.rows[0] &&
          withdrawalTarget &&
          explicit.rows[0].id !== withdrawalTarget.shareGrantId)
      )
        throw new ProjectSharePolicyConflictError(
          "Multiple exact Conversation grants require separate withdrawal"
        );
      if (explicit.rows[0])
        withdrawalTarget = {
          shareGrantId: explicit.rows[0].id,
          grantVersion: explicit.rows[0].grant_version
        };
      return {
        blocked: true as const,
        withdrawalRequired: Boolean(withdrawalTarget),
        withdrawalTarget
      };
    });
  }
});
