import type pg from "pg";
import {
  crossIdentitySyncDigest,
  SharedMemoryConflictError,
  workspaceConversationExclusionSchema,
  workspaceConversationRestorationReviewSchema,
  type WorkspaceConversationExclusion,
  type WorkspaceConversationExclusionReviewInput,
  type WorkspaceConversationRestorationIntent,
  type WorkspaceConversationRestorationReview
} from "@koed/shared";
import { recordAuditEventWithClient } from "./audit-repository.js";
import {
  readWorkspaceConversationExclusionReview,
  workspaceConversationExclusionFromRow
} from "./workspace-conversation-exclusion.js";

type Client = Pick<pg.PoolClient, "query">;
type Row = Record<string, unknown>;
const uuid = (value: unknown): string | null =>
  value == null ? null : (value as string);

export const readWorkspaceConversationRestorationReview = async (
  client: Client,
  ownerUserId: string,
  input: WorkspaceConversationExclusionReviewInput,
  requirePermission: () => Promise<unknown>,
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(),
  lock = false
): Promise<WorkspaceConversationRestorationReview | null> => {
  const expiry = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 5 * 60_000
  )
    throw new SharedMemoryConflictError(
      "Restoration review expired; refresh it before confirming"
    );
  await requirePermission();
  const source = await client.query(
    "select id from logical_memories where id=$1 and owner_user_id=$2 and lifecycle='active' and invalidated_at is null and purge_completed_at is null",
    [input.logicalMemoryId, ownerUserId]
  );
  if (!source.rowCount) return null;
  const loaded = await readWorkspaceConversationExclusionReview(
    client,
    ownerUserId,
    input,
    requirePermission
  );
  if (loaded?.review.exclusion?.state !== "excluded") return null;
  // All selector rules are included: private current selection belongs to the
  // publisher. A missing membership is never invented by the Team Backend.
  const rows = await client.query<Row>(
    `select rule.*,member.id membership_id,member.membership_version membership_version,member.state membership_state,
       to_jsonb(member) membership_binding,to_jsonb(consent) consent_binding,
       (rule.state='active' and member.state='present' and consent.state='active'
         and consent.revoked_at is null and (consent.expires_at is null or consent.expires_at>now())
         and root.lifecycle in ('active','unavailable') and root.revoked_at is null
         and root.tombstoned_at is null and root.purge_completed_at is null
         and credential.id is not null and credential.revoked_at is null
         and (credential.expires_at is null or credential.expires_at>now())
         and credential.operation_families @> ARRAY['share_grant_management','sync']::text[]) eligible
     from team_memory_sharing_rules rule
     left join team_memory_sharing_rule_members member
       on member.rule_id=rule.id and member.owner_user_id=$1 and member.logical_memory_id=$2
     left join team_memory_share_reasons reason on reason.rule_id=rule.id and reason.membership_id=member.id
     left join team_memory_share_grants root on root.id=reason.share_grant_id
     left join source_owner_representation_consents consent on consent.id=reason.consent_id
     left join device_credentials credential on credential.id=rule.publisher_credential_id and credential.owner_user_id=$1
     where rule.owner_user_id=$1 and rule.team_id=$3 and rule.team_workspace_id=$4
       and (rule.logical_memory_id=$2 or rule.selector_kind in ('repository','folder','project'))
     order by rule.id`,
    [ownerUserId, input.logicalMemoryId, input.teamId, input.teamWorkspaceId]
  );
  const policies = [
    await client.query<Row>(
      `select policy_id,version,policy_hash,maximum_fidelity,include_curated_memory from source_owner_representation_policies
      where logical_memory_id=$1 and superseded_at is null ${lock ? "for share" : ""}`,
      [input.logicalMemoryId]
    ),
    await client.query<Row>(
      `select policy_id,version,policy_hash,maximum_fidelity,include_curated_memory from team_representation_policies
      where team_id=$1 and superseded_at is null ${lock ? "for share" : ""}`,
      [input.teamId]
    ),
    await client.query<Row>(
      `select policy_id,version,policy_hash,maximum_fidelity,include_curated_memory from workspace_representation_policies
      where team_id=$1 and team_workspace_id=$2 and superseded_at is null ${lock ? "for share" : ""}`,
      [input.teamId, input.teamWorkspaceId]
    )
  ];
  // Exclude mutable worker scheduling and encrypted payloads from the binding.
  // Versions, source membership, consent and current policy remain exact.
  const authorityHash = crossIdentitySyncDigest({
    policies: policies.map((policy) => policy.rows),
    rules: rows.rows.map((row) => ({
      id: row.id,
      state: row.state,
      authorityVersion: row.authority_version,
      publisherCredentialId: row.publisher_credential_id,
      publisherFence: row.publisher_fence,
      maximumFidelity: row.maximum_fidelity,
      includeCuratedMemory: row.include_curated_memory,
      effectivePrivacyPolicyHash: row.effective_privacy_policy_hash,
      membershipId: row.membership_id,
      membershipVersion: row.membership_version,
      membershipState: row.membership_state,
      consent: row.consent_binding,
      eligible: row.eligible
    }))
  });
  const rules = rows.rows.map((row) => ({
    ruleId: row.id,
    selectorKind: row.selector_kind,
    state: row.state,
    authorityVersion: Number(row.authority_version),
    publisherFence: Number(row.publisher_fence),
    membershipId: uuid(row.membership_id),
    membershipVersion:
      row.membership_version == null ? null : Number(row.membership_version),
    membershipState: row.membership_state ?? null,
    eligible: row.eligible === true
  }));
  const review = { ...loaded.review, rules, authorityHash, expiresAt };
  return workspaceConversationRestorationReviewSchema.parse({
    ...review,
    reviewHash: crossIdentitySyncDigest(review)
  });
};

export const applyWorkspaceConversationRestoration = async (
  client: pg.PoolClient,
  ownerUserId: string,
  intent: WorkspaceConversationRestorationIntent,
  dependencies: {
    requirePermission: () => Promise<unknown>;
    requireAuthority: () => Promise<unknown>;
    notifyChanged: (result: WorkspaceConversationExclusion) => Promise<void>;
  }
): Promise<WorkspaceConversationExclusion> => {
  const requestHash = crossIdentitySyncDigest({ ownerUserId, ...intent });
  const replay = async () => {
    const prior = (
      await client.query<Row>(
        "select * from team_memory_workspace_exclusion_mutations where mutation_id=$1",
        [intent.mutationId]
      )
    ).rows[0];
    if (!prior) return null;
    if (
      prior.owner_user_id !== ownerUserId ||
      prior.operation !== "restore" ||
      prior.request_hash !== requestHash
    )
      throw new SharedMemoryConflictError(
        "Workspace restoration mutation ID was reused"
      );
    return workspaceConversationExclusionSchema.parse(prior.result_snapshot);
  };
  const prior = await replay();
  if (prior) return prior;
  const input = {
    logicalMemoryId: intent.scope.logicalMemoryId,
    teamId: intent.scope.teamId,
    teamWorkspaceId: intent.scope.teamWorkspaceId
  };
  const loaded = await readWorkspaceConversationExclusionReview(
    client,
    ownerUserId,
    input,
    dependencies.requirePermission
  );
  if (!loaded || ownerUserId !== intent.scope.ownerUserId)
    throw new SharedMemoryConflictError(
      "The owned Conversation is unavailable"
    );
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `shared-memory-owner-policy:${input.logicalMemoryId}:${loaded.ownerPrincipalId}`
  ]);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `pending-share-destination:${ownerUserId}:${input.logicalMemoryId}:${input.teamId}:${input.teamWorkspaceId}`
  ]);
  const lockedPrior = await replay();
  if (lockedPrior) return lockedPrior;
  await client.query(
    "select id from team_memory_share_grants where owner_user_id=$1 and logical_memory_id=$2 and team_workspace_id=$3 for update",
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId]
  );
  await client.query(
    "select id from team_memory_workspace_exclusions where owner_user_id=$1 and logical_memory_id=$2 and team_workspace_id=$3 for update",
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId]
  );
  // The source lock fences admission and member edits; rule controls own their
  // rule lock. Match that order before recomputing the reviewed authority.
  await client.query(
    "select id from team_memory_sharing_rules where owner_user_id=$1 and team_id=$2 and team_workspace_id=$3 order by id for update",
    [ownerUserId, input.teamId, input.teamWorkspaceId]
  );
  const review = await readWorkspaceConversationRestorationReview(
    client,
    ownerUserId,
    input,
    dependencies.requirePermission,
    intent.restoration.expiresAt,
    true
  );
  if (
    !review ||
    crossIdentitySyncDigest(review) !==
      crossIdentitySyncDigest(intent.restoration)
  )
    throw new SharedMemoryConflictError(
      "The Workspace restoration review is stale"
    );
  await dependencies.requireAuthority();
  const saved = await client.query<Row>(
    `update team_memory_workspace_exclusions set state='restored',version=version+1,restored_at=now(),updated_at=now()
    where id=$1 and owner_user_id=$2 and state='excluded' and version=$3 returning *`,
    [review.exclusion!.id, ownerUserId, intent.scope.expectedExclusionVersion]
  );
  if (!saved.rows[0])
    throw new SharedMemoryConflictError("The Workspace exclusion changed");
  const result = workspaceConversationExclusionFromRow(saved.rows[0]);
  await client.query(
    "update team_memory_share_grants set grant_version=grant_version+1,updated_at=now() where owner_user_id=$1 and logical_memory_id=$2 and team_workspace_id=$3",
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId]
  );
  const eligibleRuleIds = review.rules
    .filter((rule) => rule.eligible)
    .map((rule) => rule.ruleId);
  await client.query(
    `update pending_share_operations operation set source_update_state='preparing',
       redacted_failure_code='workspace_restoring',operation_version=operation_version+1,updated_at=now()
     where operation.owner_user_id=$1 and operation.logical_memory_id=$2 and operation.team_workspace_id=$3
       and operation.activated_at is not null and operation.revoked_at is null
       and operation.state='needs_attention' and operation.redacted_failure_code='workspace_excluded'
       and exists(select 1 from pending_sharing_rule_admissions admission
         where admission.pending_share_id=operation.id and admission.rule_id=any($4::uuid[]))`,
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId, eligibleRuleIds]
  );
  // Reprocess only currently active reasons. Paused history and revoked direct
  // consent remain invalidated; no representation becomes readable here.
  await client.query(
    `update shared_source_semantic_previews semantic set invalidation_reason_code='workspace_exclusion_removed',updated_at=now()
    where semantic.owner_user_id=$1 and semantic.logical_memory_id=$2 and semantic.team_workspace_id=$3
      and semantic.status='invalidated' and semantic.invalidation_reason_code='workspace_excluded'
      and exists(select 1 from team_memory_reason_preparations preparation
        join team_memory_share_reasons reason on reason.id=preparation.reason_id
        where preparation.preview_id=semantic.source_preview_id and reason.rule_id=any($4::uuid[]))`,
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId, eligibleRuleIds]
  );
  await client.query(
    `update team_memory_sharing_rule_members set reconciliation_requested_at=now(),next_reconciliation_at=now(),
    reconciliation_attempt_count=0,reconciliation_failure_code=null,updated_at=now()
    where owner_user_id=$1 and logical_memory_id=$2 and state='present' and rule_id=any($3::uuid[])`,
    [ownerUserId, input.logicalMemoryId, eligibleRuleIds]
  );
  await client.query(
    `insert into team_memory_workspace_exclusion_mutations(mutation_id,exclusion_id,owner_user_id,operation,request_hash,result_version,result_snapshot)
    values($1,$2,$3,'restore',$4,$5,$6::jsonb)`,
    [
      intent.mutationId,
      result.id,
      ownerUserId,
      requestHash,
      result.version,
      JSON.stringify(result)
    ]
  );
  await recordAuditEventWithClient(client, {
    actorUserId: ownerUserId,
    ownerUserId,
    visibility: "personal",
    action: "shared_memory.workspace_exclusion_removed",
    targetTable: "team_memory_workspace_exclusions",
    targetId: result.id,
    metadata: {
      mutationId: intent.mutationId,
      version: result.version,
      teamWorkspaceId: result.teamWorkspaceId,
      activeRuleCount: eligibleRuleIds.length
    }
  });
  await dependencies.notifyChanged(result);
  return result;
};
