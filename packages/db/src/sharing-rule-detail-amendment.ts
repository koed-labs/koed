import type pg from "pg";
import {
  crossIdentitySyncDigest,
  sharingRuleDetailIntentSchema,
  sharingRuleDetailReviewInputSchema,
  sharingRuleDetailResultSchema,
  SharedMemoryConflictError,
  type SharingRuleDetailReview,
  type SharingRuleDetailAppliedScope,
  type SharedMemoryFidelityCeiling
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
  ): Promise<SharingRuleDetailReview | null>;
  ownerPolicy(
    member: MemberConsent,
    detail: {
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
    }
  ): Promise<{ policyId: string; version: number }>;
  retainScope(scope: SharingRuleDetailAppliedScope): Promise<void>;
};

/** The caller owns the transaction and its native Action Grant. Original
 * publications stay immutable; the current cap closes reads immediately. */
export const applySharingRuleDetailAmendment = async (
  client: pg.PoolClient,
  actor: ActorContext,
  raw: unknown,
  dependencies: Dependencies
) => {
  const intent = sharingRuleDetailIntentSchema.parse(raw),
    { review } = intent;
  await dependencies.authorize();
  const requestHash = crossIdentitySyncDigest(intent);
  const completed = async () => {
    const prior = (
      await client.query<{
        metadata: { requestHash?: string; result?: unknown };
      }>(
        `select metadata from audit_events where owner_user_id=$1 and target_table='team_memory_sharing_rules'
      and target_id=$2 and action='shared_memory.rule.detail_changed' and metadata->>'mutationId'=$3 order by created_at limit 1`,
        [actor.userId, review.ruleId, intent.mutationId]
      )
    ).rows[0];
    if (prior) {
      if (prior.metadata.requestHash !== requestHash)
        throw new SharedMemoryConflictError(
          "Detail amendment retry changed its intent"
        );
      return sharingRuleDetailResultSchema.parse(prior.metadata.result);
    }
    return null;
  };
  const prior = await completed();
  if (prior) return prior;
  const expiry = Date.parse(review.expiresAt);
  if (expiry <= Date.now() || expiry > Date.now() + 5 * 60_000)
    throw new SharedMemoryConflictError(
      "Detail review expired; refresh it before confirming"
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
      publisher_fence: string;
    }>(
      "select state,authority_version,publisher_fence from team_memory_sharing_rules where id=$1 and owner_user_id=$2 and team_id=$3 and team_workspace_id=$4 for update",
      [review.ruleId, actor.userId, review.teamId, review.teamWorkspaceId]
    )
  ).rows[0];
  if (!rule) throw new SharedMemoryConflictError("Sharing rule is unavailable");
  const concurrentReceipt = await completed();
  if (concurrentReceipt) return concurrentReceipt;
  if (expiry <= Date.now())
    throw new SharedMemoryConflictError(
      "Detail review expired while authority was busy"
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
    sharingRuleDetailReviewInputSchema.strip().parse(review),
    review.expiresAt
  );
  if (
    !current ||
    crossIdentitySyncDigest(current) !== crossIdentitySyncDigest(review)
  )
    throw new SharedMemoryConflictError(
      "Rule or policy authority changed after detail review"
    );

  for (const member of members) {
    const policy = await dependencies.ownerPolicy(member, review);
    await client.query(
      `update source_owner_representation_consents set maximum_fidelity=$2,include_curated_memory=$3,
      source_owner_policy_id=$4,source_owner_policy_version=$5,team_policy_version=$6,workspace_policy_version=$7,
      source_capabilities=ARRAY['memory_events','lcm_leaves','lcm_rollups','curated_assertions']::shared_memory_representation[],
      activation_representation=$2,consent_version=consent_version+1,updated_at=now()
      where id=$1`,
      [
        member.consent_id,
        review.maximumFidelity,
        review.includeCuratedMemory,
        policy.policyId,
        policy.version,
        review.teamPolicyVersion,
        review.workspacePolicyVersion
      ]
    );
  }
  const result = sharingRuleDetailResultSchema.parse({
    mutationId: intent.mutationId,
    approvedAt: new Date().toISOString(),
    ruleId: review.ruleId,
    state: rule.state,
    authorityVersion: rule.authority_version + 1,
    publisherFence: Number(rule.publisher_fence),
    maximumFidelity: review.maximumFidelity,
    includeCuratedMemory: review.includeCuratedMemory,
    memberCount: review.memberCount
  });
  await client.query(
    `update team_memory_sharing_rules set maximum_fidelity=$2,include_curated_memory=$3,
    effective_privacy_policy_hash=$4,authority_version=authority_version+1,updated_at=now() where id=$1`,
    [
      review.ruleId,
      review.maximumFidelity,
      review.includeCuratedMemory,
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
    `with affected as (
      select distinct reason.share_grant_id id from team_memory_share_reasons reason
      join team_memory_sharing_rule_members member on member.id=reason.membership_id and member.rule_id=reason.rule_id and member.state='present'
      join source_owner_representation_consents consent on consent.id=reason.consent_id
        and consent.state in ('active','paused') and consent.revoked_at is null
        and (consent.expires_at is null or consent.expires_at>now())
      where reason.rule_id=$1
    ), live as (
      select reason.share_grant_id,consent.maximum_fidelity,consent.include_curated_memory
      from team_memory_share_reasons reason join affected on affected.id=reason.share_grant_id
      join source_owner_representation_consents consent on consent.id=reason.consent_id
        and consent.state in ('active','paused') and consent.revoked_at is null
        and (consent.expires_at is null or consent.expires_at>now())
      left join team_memory_sharing_rules rule on rule.id=reason.rule_id
      where reason.kind='direct' or rule.state in ('active','paused')
    ), caps as (
      select affected.id,
        (select maximum_fidelity from live where share_grant_id=affected.id
          order by case maximum_fidelity when 'memory_events' then 0 when 'lcm_leaves' then 1 else 2 end limit 1) maximum_fidelity,
        coalesce((select bool_or(include_curated_memory) from live where share_grant_id=affected.id),false) include_curated_memory
      from affected
    ) update team_memory_share_grants g set grant_version=grant_version+1,updated_at=now(),
      maximum_fidelity=coalesce(caps.maximum_fidelity,g.maximum_fidelity),include_curated_memory=caps.include_curated_memory,
      activation_representation=coalesce(caps.maximum_fidelity,g.maximum_fidelity),
      source_capabilities=ARRAY['memory_events','lcm_leaves','lcm_rollups','curated_assertions']::shared_memory_representation[]
    from caps where g.id=caps.id`,
    [review.ruleId]
  );
  const applied = { approvedAt: result.approvedAt, review, result };
  await dependencies.retainScope(applied);
  await client.query(
    `insert into audit_events(actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
    values($1,$1,'personal','shared_memory.rule.detail_changed','team_memory_sharing_rules',$2,$3::jsonb)`,
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
    "select pg_notify('koed_shared_memory_privacy','rule_detail_changed')"
  );
  return result;
};
