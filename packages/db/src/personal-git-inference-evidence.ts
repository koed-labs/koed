// These SQL fragments share the eligibility rule between advisory evidence and
// the restricted correction's write predicate. Both use the owned session (s).
export const personalGitInferenceEvidenceJoins = `
  left join lateral (
    select case when min(a.source_created_at) = max(a.source_created_at)
                then min(a.source_created_at) end as first_at,
           coalesce(bool_or(h.id is not null), false) as imported,
           array_agg(jsonb_build_object(
             'artifactId', a.id, 'importSourceId', h.id,
             'deploymentId', a.origin_deployment_id, 'deviceId', a.origin_device_id,
             'startedAt', to_char(a.source_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           )) filter (where h.id is not null and a.replica_role = 'origin_local') as local_imports
    from conversation_source_artifacts a
    left join historical_import_sources h on h.artifact_id = a.id
      and h.owner_user_id = a.owner_user_id and h.ai_client = 'codex'
      and a.live_start_offset > 0 and h.raw_ingested_record_count > 0
    where a.session_id = s.id and a.owner_user_id = s.owner_user_id
      and a.external_session_id = s.external_session_id
      and a.source_kind = 'codex' and a.artifact_format = 'codex_rollout_jsonl'
      and a.source_adapter_version in ('codex-transcript-v1', 'codex-transcript-v2')
      and a.artifact_format_version = 1
      and a.source_component_id = 'main' and a.source_component_role = 'primary'
      and a.journal_start_offset = 0 and a.journal_start_line = 0
      and a.prior_generation_closure is null and isfinite(a.source_created_at)
      and a.lifecycle in ('active', 'finalizing', 'finalized')
  ) native on true
  cross join lateral (
    select exists (
      select 1 from pds_logical_replicas r
      where r.local_session_id = s.id and r.owner_user_id = s.owner_user_id
    ) or exists (
      select 1 from conversation_source_artifacts a
      where a.session_id = s.id and a.owner_user_id = s.owner_user_id
        and a.replica_role <> 'origin_local'
    ) as known_copy
  ) provenance`;

// Codex's initial rollout artifact uses the native session header timestamp.
// Rewrite generations and other clients can populate creation time with a
// fallback. Registration, even origin_local, only proves the importing device.
// The imported prefix identifies historical ingestion, not where it was recorded.
export const personalGitHistoricalImportProvenance = `native.imported and native.first_at is not null and not provenance.known_copy`;

// The sentinel alone does not distinguish a historical import from delayed live capture.
export const personalGitMissingHistoryMarker = `s.repository_automatic_identity @>
  '{"kind":"unresolved","key":null,"reason":"probe_ambiguous","originatingDeviceId":"historical_unknown_device","checkoutId":null}'::jsonb`;

// Do not choose an importing authority when multiple artifacts qualify.
export const personalGitInferenceLocalImport = `case
  when not provenance.known_copy and cardinality(native.local_imports) = 1
  then native.local_imports[1] end`;

// Previously published originals are immutable. Only the matching local import
// authority may use the legacy unresolved baseline for this guarded correction.
const legacyBoundImport = `(
  ${personalGitMissingHistoryMarker}
  and b.git_original = '{"state":"unresolved","reason":"unreliable"}'::jsonb
  and cardinality(b.git_frontier) = 1
  and b.originating_deployment_id = (${personalGitInferenceLocalImport})->>'deploymentId'
  and b.originating_device_id = (${personalGitInferenceLocalImport})->>'deviceId'
)`;

// Preserve actual source pins; the Codex watcher's missing-history sentinel is not one.
const inferenceEligible = (allowLegacyBoundImport: boolean) => `(
  ${personalGitHistoricalImportProvenance}
  and (s.repository_automatic_identity is null or ${personalGitMissingHistoryMarker})
  and s.repository_override_identity is null
  and s.repository_assignment_version = 1
  and s.repository_assignment_revision_id is null
  and not exists (
    select 1 from personal_source_context_changes c
    where c.owner_user_id = s.owner_user_id
      and c.logical_session_id = s.logical_session_id and c.axis = 'git'
  )
  and not exists (
    select 1 from personal_source_bindings b
    where b.owner_user_id = s.owner_user_id and b.local_session_id = s.id
      and (b.availability = 'pending' or (b.context_version = 1 and (
        b.git_state <> 'available' or b.folder_state = 'conflict'
        or (b.git_original->>'reason' is distinct from 'historical_unresolved'
          ${allowLegacyBoundImport ? `and ${legacyBoundImport} is not true` : ""})
        or b.git_assignment->'correction'->>'state' is distinct from 'original'
      )))
  )
)`;

export const personalGitInferenceEligible = inferenceEligible(true);

const eligibilityQuery = (eligible: string) => `
  select ${personalGitInferenceLocalImport} as local_import from sessions s
  ${personalGitInferenceEvidenceJoins}
  where s.id = $2 and s.owner_user_id = $1 and ${eligible}`;

export const personalGitInferenceEligibilityQuery = eligibilityQuery(
  inferenceEligible(false)
);
const localImportEligibilityQuery = eligibilityQuery(
  personalGitInferenceEligible
);

export const personalGitInferenceLocalImportPreviewQuery = `
  select 1 from (${localImportEligibilityQuery}) eligible
  where eligible.local_import = $3::jsonb`;

export const personalGitInferenceLocalImportMatchQuery = `
  select 1 from (${localImportEligibilityQuery}) eligible
  where eligible.local_import = $5::jsonb`;
