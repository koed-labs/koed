import type pg from "pg";
import {
  crossIdentitySyncDigest,
  sharingRuleContentPolicyIntentSchema,
  sharingRuleContentPolicyReviewInputSchema,
  sharingRuleContentPolicyResultSchema,
  SharedMemoryConflictError,
  type SharingRuleContentPolicyReview,
  type SharingRuleContentPolicyAppliedScope
} from "@koed/shared";
import type { ActorContext } from "./types.js";

type MemberConsent = {
  consent_id: string;
  logical_memory_id: string;
  owner_principal_id: string;
  share_grant_id: string;
};
type Dependencies = {
  authorize(): Promise<void>;
  review(
    input: unknown,
    expiresAt: string
  ): Promise<SharingRuleContentPolicyReview | null>;
  retainScope(scope: SharingRuleContentPolicyAppliedScope): Promise<void>;
};

/** The caller owns the transaction and its native Action Grant. Original
 * publications stay immutable; the current policy closes reads immediately.
 * Fidelity policies and their approval timestamps are never expanded here. */
export const applySharingRuleContentPolicyAmendment = async (
  client: pg.PoolClient,
  actor: ActorContext,
  raw: unknown,
  dependencies: Dependencies
) => {
  const intent = sharingRuleContentPolicyIntentSchema.parse(raw),
    { review } = intent;
  await dependencies.authorize();
  const requestHash = crossIdentitySyncDigest(intent);
  const completed = async () => {
    const prior = (
      await client.query<{
        metadata: { requestHash?: string; result?: unknown };
      }>(
        `select metadata from audit_events where owner_user_id=$1 and target_table='team_memory_sharing_rules'
      and target_id=$2 and action='shared_memory.rule.content_policy_changed' and metadata->>'mutationId'=$3 order by created_at limit 1`,
        [actor.userId, review.ruleId, intent.mutationId]
      )
    ).rows[0];
    if (prior) {
      if (prior.metadata.requestHash !== requestHash)
        throw new SharedMemoryConflictError(
          "Content-policy amendment retry changed its intent"
        );
      return sharingRuleContentPolicyResultSchema.parse(prior.metadata.result);
    }
    return null;
  };
  const prior = await completed();
  if (prior) return prior;
  const expiry = Date.parse(review.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 5 * 60_000
  )
    throw new SharedMemoryConflictError(
      "Content-policy review expired; refresh it before confirming"
    );

  // Match the source -> grant -> rule lock order of publication and controls.
  await client.query(
    `select pg_advisory_xact_lock(hashtextextended(
      'shared-memory-owner-policy:' || scope.logical_memory_id::text || ':' || scope.owner_principal_id::text,0))
    from (select distinct member.logical_memory_id,lm.owner_principal_id
      from team_memory_sharing_rule_members member join logical_memories lm on lm.id=member.logical_memory_id
      where member.rule_id=$1 and member.owner_user_id=$2 and member.state='present') scope order by scope.logical_memory_id`,
    [review.ruleId, actor.userId]
  );
  await client.query(
    `select g.id from team_memory_share_grants g where g.owner_user_id=$2
    and exists(select 1 from team_memory_share_reasons reason
      join team_memory_sharing_rule_members member on member.id=reason.membership_id and member.rule_id=reason.rule_id and member.state='present'
      where reason.share_grant_id=g.id and reason.rule_id=$1)
    order by g.id for update of g`,
    [review.ruleId, actor.userId]
  );
  const rule = (
    await client.query<{
      state: "active" | "paused" | "stopped";
      authority_version: number;
      content_policy_version: number;
      publisher_fence: string;
    }>(
      "select state,authority_version,content_policy_version,publisher_fence from team_memory_sharing_rules where id=$1 and owner_user_id=$2 and team_id=$3 and team_workspace_id=$4 for update",
      [review.ruleId, actor.userId, review.teamId, review.teamWorkspaceId]
    )
  ).rows[0];
  if (!rule) throw new SharedMemoryConflictError("Sharing rule is unavailable");
  const concurrentReceipt = await completed();
  if (concurrentReceipt) return concurrentReceipt;
  if (expiry <= Date.now())
    throw new SharedMemoryConflictError(
      "Content-policy review expired while authority was busy"
    );
  const members = (
    await client.query<MemberConsent>(
      `select consent.id consent_id,consent.logical_memory_id,
      consent.source_owner_principal_id owner_principal_id,reason.share_grant_id
    from team_memory_share_reasons reason join source_owner_representation_consents consent on consent.id=reason.consent_id
    join team_memory_sharing_rule_members member on member.id=reason.membership_id and member.rule_id=reason.rule_id and member.state='present'
    where reason.rule_id=$1 and consent.state in ('active','paused') and consent.revoked_at is null
      and (consent.expires_at is null or consent.expires_at>now())
    order by consent.logical_memory_id,consent.id for update of reason,consent`,
      [review.ruleId]
    )
  ).rows;
  await client.query(
    `select policy.id from source_owner_representation_policies policy
    where policy.superseded_at is null and exists(select 1 from team_memory_sharing_rule_members member
      where member.rule_id=$1 and member.owner_user_id=$2 and member.state='present' and member.logical_memory_id=policy.logical_memory_id)
    order by policy.logical_memory_id for share of policy`,
    [review.ruleId, actor.userId]
  );
  const current = await dependencies.review(
    sharingRuleContentPolicyReviewInputSchema.strip().parse(review),
    review.expiresAt
  );
  if (
    !current ||
    crossIdentitySyncDigest(current) !== crossIdentitySyncDigest(review)
  )
    throw new SharedMemoryConflictError(
      "Rule or policy authority changed after content-policy review"
    );

  for (const member of members) {
    await client.query(
      "update source_owner_representation_consents set consent_version=consent_version+1,updated_at=now() where id=$1",
      [member.consent_id]
    );
  }
  const result = sharingRuleContentPolicyResultSchema.parse({
    mutationId: intent.mutationId,
    approvedAt: new Date().toISOString(),
    ruleId: review.ruleId,
    state: rule.state,
    authorityVersion: rule.authority_version + 1,
    publisherFence: Number(rule.publisher_fence),
    contentPolicyVersion: rule.content_policy_version + 1,
    labels: review.labels,
    globalPolicyHash: review.globalPolicyHash,
    effectivePrivacyPolicyHash: review.effectivePrivacyPolicyHash,
    memberCount: review.memberCount
  });
  await client.query(
    `update team_memory_sharing_rules set content_privacy_labels=$2,
      content_policy_version=content_policy_version+1,
      approved_global_privacy_policy_hash=$3,approved_effective_privacy_labels=$4,
      effective_privacy_policy_hash=$5,authority_version=authority_version+1,
      updated_at=now() where id=$1`,
    [
      review.ruleId,
      JSON.stringify(review.labels),
      review.globalPolicyHash,
      JSON.stringify(review.effectiveLabels),
      review.effectivePrivacyPolicyHash
    ]
  );
  await client.query(
    `update team_memory_sharing_rule_members set
    reconciliation_requested_at=case when $2='active' and state='present' then now() else null end,
    next_reconciliation_at=case when $2='active' and state='present' then now() else null end,
    reconciliation_attempt_count=0,reconciliation_failure_code=null,updated_at=now() where rule_id=$1`,
    [review.ruleId, rule.state]
  );
  await client.query(
    `update team_memory_share_grants g set grant_version=grant_version+1,updated_at=now()
      where g.owner_user_id=$2 and exists (
        select 1 from team_memory_share_reasons reason
        join team_memory_sharing_rule_members member on member.id=reason.membership_id
          and member.rule_id=reason.rule_id and member.state='present'
        join source_owner_representation_consents consent on consent.id=reason.consent_id
          and consent.state in ('active','paused') and consent.revoked_at is null
          and (consent.expires_at is null or consent.expires_at>now())
        where reason.rule_id=$1 and reason.share_grant_id=g.id
      )`,
    [review.ruleId, actor.userId]
  );
  // A content hash may return to an earlier value. Invalidate the old lease
  // explicitly so work admitted before either amendment cannot finish using
  // its old token after the policy is restored.
  await client.query(
    `update shared_source_semantic_privacy_work_claims claim
      set state='released',released_at=now()
      from shared_source_semantic_previews semantic
      where claim.semantic_preview_id=semantic.id and claim.state='active'
        and semantic.owner_user_id=$2 and semantic.team_id=$3
        and semantic.team_workspace_id=$4
        and exists (
          select 1 from team_memory_sharing_rule_members member
          where member.rule_id=$1 and member.owner_user_id=$2
            and member.logical_memory_id=semantic.logical_memory_id
            and member.state='present'
        )`,
    [review.ruleId, actor.userId, review.teamId, review.teamWorkspaceId]
  );
  const applied = { approvedAt: result.approvedAt, review, result };
  await dependencies.retainScope(applied);
  await client.query(
    `insert into audit_events(actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
    values($1,$1,'personal','shared_memory.rule.content_policy_changed','team_memory_sharing_rules',$2,$3::jsonb)`,
    [
      actor.userId,
      review.ruleId,
      JSON.stringify({
        mutationId: intent.mutationId,
        requestHash,
        reviewHash: review.reviewHash,
        result
      })
    ]
  );
  await client.query(
    "select pg_notify('koed_shared_memory_privacy','rule_content_policy_changed')"
  );
  return result;
};
