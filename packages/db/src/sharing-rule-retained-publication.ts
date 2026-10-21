import type pg from "pg";
import {
  cumulativeRepresentationAuthorizationSql,
  grantAuthorizesRepresentationSql,
  sharingRuleMemberSourceSql
} from "./shared-memory-publication-authority-sql.js";

/** Read only the exact publication requested by the owner. Eligibility is per
 * representation, so a reduced current cap can still permit retained Rollups.
 * The caller must recheck Privacy and locked authority before preparing data. */
export const readRetainedRulePublication = async (
  client: Pick<pg.PoolClient, "query">,
  input: {
    ownerUserId: string;
    ruleId: string;
    reasonId: string;
    shareGrantId: string;
    representationId: string;
  }
) =>
  (
    await client.query<Record<string, unknown>>(
      `select original.id retained_representation_id,original.source_revision,
      original.representation,source_preview.id source_preview_id,source_preview.preview_hash,
      source_preview.source_artifact_id,source_preview.source_revision_id,
      source_preview.source_hash,source_preview.source_content_hash,
      rule.team_id,rule.team_workspace_id,rule.authority_version,rule.publisher_fence,
      rule.publisher_credential_id,rule.effective_privacy_policy_hash,rule.content_policy_version,
      rule.maximum_fidelity rule_maximum_fidelity,rule.include_curated_memory rule_include_curated_memory,
      consent.id consent_id,consent.consent_version,grant_row.grant_version,
      consent.maximum_fidelity consent_maximum_fidelity,consent.include_curated_memory consent_include_curated_memory,
      grant_row.maximum_fidelity grant_maximum_fidelity,grant_row.include_curated_memory grant_include_curated_memory,
      consent.fidelity_policy_revision,consent.content_policy_version preview_content_policy_version,
      owner_current.policy_hash owner_policy_hash,team_current.policy_hash team_policy_hash,
      workspace_current.policy_hash workspace_policy_hash,
      grant_row.logical_memory_id,grant_row.owner_principal_id,
      owner_current.policy_id owner_policy_id,owner_current.version owner_policy_version,
      owner_current.maximum_fidelity owner_maximum_fidelity,owner_current.include_curated_memory owner_include_curated_memory,
      team_current.policy_id team_policy_id,team_current.version team_policy_version,
      team_current.maximum_fidelity team_maximum_fidelity,team_current.include_curated_memory team_include_curated_memory,
      workspace_current.policy_id workspace_policy_id,workspace_current.version workspace_policy_version,
      workspace_current.maximum_fidelity workspace_maximum_fidelity,workspace_current.include_curated_memory workspace_include_curated_memory
    from team_memory_share_grants grant_row
    join team_memory_share_reasons reason on reason.share_grant_id=grant_row.id
      and reason.id=$3 and reason.rule_id=$2 and reason.kind='rule'
    join team_memory_sharing_rules rule on rule.id=reason.rule_id
      and rule.owner_user_id=grant_row.owner_user_id and rule.team_id=grant_row.team_id
      and rule.team_workspace_id=grant_row.team_workspace_id
      and rule.state in ('active','paused') and rule.content_policy_version>0
    join team_memory_sharing_rule_members member on member.id=reason.membership_id
      and member.rule_id=rule.id and member.owner_user_id=rule.owner_user_id
      and member.state='present' and ${sharingRuleMemberSourceSql("rule", "member", "grant_row.logical_memory_id")}
    join source_owner_representation_consents consent on consent.id=reason.consent_id
      and consent.logical_memory_id=grant_row.logical_memory_id
      and consent.source_owner_principal_id=grant_row.owner_principal_id
      and consent.team_id=grant_row.team_id and consent.team_workspace_id=grant_row.team_workspace_id
      and consent.mode='continuous' and consent.state in ('active','paused') and consent.revoked_at is null
      and (consent.expires_at is null or consent.expires_at>now())
    join team_memory_reason_publications publication on publication.reason_id=reason.id
      and publication.share_grant_id=grant_row.id and publication.consent_id=consent.id
      and publication.representation_id=$5 and publication.rule_version<=rule.authority_version
      and publication.publisher_fence<=rule.publisher_fence
    join team_memory_representations original on original.id=publication.representation_id
      and original.share_grant_id=grant_row.id and original.consent_id=consent.id
      and original.logical_memory_id=grant_row.logical_memory_id
      and original.team_id=grant_row.team_id and original.team_workspace_id=grant_row.team_workspace_id
    join shared_source_previews source_preview on source_preview.id=original.source_preview_id
      and source_preview.source_artifact_id=original.source_artifact_id
      and source_preview.logical_memory_id=original.logical_memory_id
      and source_preview.representation=original.representation and source_preview.source_revision=original.source_revision
      and source_preview.team_id=original.team_id and source_preview.team_workspace_id=original.team_workspace_id
      and source_preview.owner_user_id=grant_row.owner_user_id and source_preview.owner_principal_id=grant_row.owner_principal_id
      and source_preview.invalidated_at is null
    join shared_source_artifacts artifact on artifact.id=source_preview.source_artifact_id
      and artifact.logical_memory_id=source_preview.logical_memory_id
      and artifact.owner_user_id=source_preview.owner_user_id and artifact.owner_principal_id=source_preview.owner_principal_id
      and artifact.team_id=source_preview.team_id and artifact.team_workspace_id=source_preview.team_workspace_id
      and artifact.source_revision=source_preview.source_revision and artifact.representation=source_preview.representation
      and artifact.source_hash=source_preview.source_hash and artifact.source_content_hash=source_preview.source_content_hash
      and artifact.invalidated_at is null
    join users owner on owner.id=grant_row.owner_user_id and owner.disabled_at is null and owner.deleted_at is null
    join teams team on team.id=grant_row.team_id and team.lifecycle='active' and team.entitlement_status in ('active','grace')
    join team_memberships membership on membership.team_id=team.id and membership.user_id=owner.id
      and membership.status='enabled' and membership.disabled_at is null
    join team_workspaces workspace on workspace.id=grant_row.team_workspace_id and workspace.team_id=team.id
      and workspace.lifecycle='active' and workspace.archived_at is null
    join team_workspace_access_grants access on access.team_id=team.id and access.team_workspace_id=workspace.id
      and access.user_id=owner.id and access.access='write' and access.can_share_owned_memory and access.disabled_at is null
    join device_credentials publisher on publisher.id=rule.publisher_credential_id and publisher.owner_user_id=owner.id
      and publisher.revoked_at is null and (publisher.expires_at is null or publisher.expires_at>now())
      and publisher.operation_families @> ARRAY['share_grant_management','sync']::text[]
    join source_owner_representation_policies owner_current on owner_current.logical_memory_id=grant_row.logical_memory_id
      and owner_current.source_owner_principal_id=grant_row.owner_principal_id and owner_current.superseded_at is null
    join team_representation_policies team_current on team_current.team_id=team.id and team_current.superseded_at is null
    join workspace_representation_policies workspace_current on workspace_current.team_id=team.id
      and workspace_current.team_workspace_id=workspace.id and workspace_current.superseded_at is null
    where grant_row.id=$4 and grant_row.owner_user_id=$1 and grant_row.lifecycle in ('active','unavailable') and grant_row.revoked_at is null
      and ${grantAuthorizesRepresentationSql("original.representation", "rule")}
      and ${cumulativeRepresentationAuthorizationSql(
        "original.representation",
        {
          grant: "grant_row",
          consent: "consent",
          ownerPolicy: "owner_current",
          teamPolicy: "team_current",
          workspacePolicy: "workspace_current"
        }
      )}`,
      [
        input.ownerUserId,
        input.ruleId,
        input.reasonId,
        input.shareGrantId,
        input.representationId
      ]
    )
  ).rows[0] ?? null;

/** Trusted repository aliases only. A historical preparation can change policy
 * bindings, but its source must be the exact source of this reason's publication. */
export const retainedReasonPreviewSql = (
  preview = "preview",
  grant = "g"
) => `exists (
  select 1 from team_memory_reason_publications retained_publication
  join team_memory_representations retained_representation
    on retained_representation.id=retained_publication.representation_id
   and retained_representation.share_grant_id=retained_publication.share_grant_id
   and retained_representation.consent_id=retained_publication.consent_id
   and retained_representation.logical_memory_id=${preview}.logical_memory_id
   and retained_representation.team_id=${preview}.team_id
   and retained_representation.team_workspace_id=${preview}.team_workspace_id
   and retained_representation.source_revision=${preview}.source_revision
   and retained_representation.representation=${preview}.representation
  join shared_source_previews retained_preview
    on retained_preview.id=retained_representation.source_preview_id
   and retained_preview.source_artifact_id=retained_representation.source_artifact_id
   and retained_preview.logical_memory_id=retained_representation.logical_memory_id
   and retained_preview.source_revision=retained_representation.source_revision
   and retained_preview.source_revision_id=retained_representation.source_revision_id
   and retained_preview.representation=retained_representation.representation
   and retained_preview.invalidated_at is null
  where retained_publication.reason_id=${grant}.sharing_reason_id
    and retained_publication.share_grant_id=${grant}.id
    and retained_publication.consent_id=${grant}.consent_id
    and (
      (${preview}.id=retained_preview.id
        and ${preview}.source_artifact_id=retained_preview.source_artifact_id)
      or exists (
        select 1 from team_memory_reason_preparations historical
        join team_memory_sharing_rules historical_rule on historical_rule.id=${grant}.sharing_rule_id
          and historical_rule.owner_user_id=${grant}.owner_user_id
          and historical_rule.team_id=${preview}.team_id
          and historical_rule.team_workspace_id=${preview}.team_workspace_id
          and historical_rule.state in ('active','paused') and historical_rule.content_policy_version>0
        join source_owner_representation_consents historical_consent on historical_consent.id=historical.consent_id
          and historical_consent.state in ('active','paused') and historical_consent.revoked_at is null
          and (historical_consent.expires_at is null or historical_consent.expires_at>now())
        where historical.reason_id=retained_publication.reason_id
          and historical.share_grant_id=retained_publication.share_grant_id
          and historical.consent_id=retained_publication.consent_id
          and historical.retained_representation_id=retained_representation.id
          and historical.preview_id=${preview}.id
          and historical.source_revision=${preview}.source_revision
          and historical.rule_version=historical_rule.authority_version
          and historical.consent_version=historical_consent.consent_version
          and historical.grant_version=${grant}.grant_version
          and historical.publisher_credential_id=historical_rule.publisher_credential_id
          and historical.publisher_fence=historical_rule.publisher_fence
          and historical.effective_privacy_policy_hash=historical_rule.effective_privacy_policy_hash
          and ${preview}.owner_user_id=retained_preview.owner_user_id
          and ${preview}.owner_principal_id=retained_preview.owner_principal_id
          and ${preview}.source_revision_id=retained_preview.source_revision_id
          and ${preview}.source_hash=retained_preview.source_hash
          and ${preview}.source_content_hash=retained_preview.source_content_hash
          and ${preview}.remote_replica_id is not distinct from retained_preview.remote_replica_id
      )
    )
)`;

/** Policy overrides exist only for an explicitly anchored, current preparation.
 * Ordinary source preparation keeps its consent's original policy bindings. */
const currentHistoricalPreparationSql = (preview: string, grant: string) => `
  select preparation.retained_representation_id
  from team_memory_reason_preparations preparation
  join team_memory_sharing_rules current_rule on current_rule.id=${grant}.sharing_rule_id
    and current_rule.owner_user_id=${grant}.owner_user_id
    and current_rule.state in ('active','paused') and current_rule.content_policy_version>0
    and current_rule.team_id=${preview}.team_id and current_rule.team_workspace_id=${preview}.team_workspace_id
  join source_owner_representation_consents current_consent on current_consent.id=preparation.consent_id
    and current_consent.state in ('active','paused') and current_consent.revoked_at is null
    and (current_consent.expires_at is null or current_consent.expires_at>now())
  join device_credentials publisher on publisher.id=preparation.publisher_credential_id
    and publisher.owner_user_id=${grant}.owner_user_id and publisher.revoked_at is null
    and (publisher.expires_at is null or publisher.expires_at>now())
    and publisher.operation_families @> ARRAY['share_grant_management','sync']::text[]
  where preparation.reason_id=${grant}.sharing_reason_id and preparation.share_grant_id=${grant}.id
    and preparation.consent_id=${grant}.consent_id and preparation.preview_id=${preview}.id
    and preparation.retained_representation_id is not null
    and preparation.rule_version=current_rule.authority_version
    and preparation.consent_version=current_consent.consent_version
    and preparation.grant_version=${grant}.grant_version
    and preparation.publisher_credential_id=current_rule.publisher_credential_id
    and preparation.publisher_fence=current_rule.publisher_fence
    and preparation.effective_privacy_policy_hash=current_rule.effective_privacy_policy_hash
    and ${retainedReasonPreviewSql(preview, grant)}
  offset 0`;

export const historicalPreparationJoinSql = (
  preview = "preview",
  grant = "g"
) =>
  `left join lateral (${currentHistoricalPreparationSql(preview, grant)}) historical_authority on true`;

export const historicalPreparationExistsSql = (
  preview = "preview",
  grant = "g"
) => `exists (${currentHistoricalPreparationSql(preview, grant)})`;

export const preparationPolicyColumnSql = (
  column:
    | "source_owner_policy_id"
    | "source_owner_policy_version"
    | "team_policy_id"
    | "team_policy_version"
    | "workspace_policy_id"
    | "workspace_policy_version",
  grant = "g",
  artifact = "artifact"
) => `(case when historical_authority.retained_representation_id is not null
  then ${artifact}.${column} else ${grant}.${column} end)`;
