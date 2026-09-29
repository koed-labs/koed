CREATE OR REPLACE VIEW "shared_memory_candidate_preview_records" AS
SELECT candidate.id, candidate.preview_hash, candidate.preview_revision,
       candidate.authority_source, candidate.authority_reference_id,
       candidate.owner_user_id, candidate.logical_memory_id,
       candidate.team_id, candidate.team_workspace_id,
       candidate.representation,
       candidate.mode, candidate.source_revision, candidate.source_hash,
       candidate.redacted_content_hash, candidate.item_count,
       candidate.excluded_item_count, candidate.candidate_manifest,
       candidate.candidate_manifest_hash, candidate.byte_count,
       candidate.representation_policy_revision,
       candidate.representation_policy_hash, candidate.content_policy_version,
       candidate.content_policy_hash, candidate.classifier_version,
       candidate.classifier_hash, candidate.share_expires_at,
       candidate.expires_at, candidate.created_at, candidate.invalidated_at,
       candidate.invalidation_reason, candidate.maximum_fidelity,
       candidate.include_curated_memory, candidate.source_revision_id,
       candidate.source_capabilities, candidate.activation_representation,
       binding.source_kind,
       binding.source_session_id, binding.source_note_id,
       binding.source_memory_event_id, candidate.retention_enabled,
       candidate.retention_policy_enabled, candidate.member_retention_version
  FROM shared_memory_candidate_previews candidate
  JOIN logical_memory_source_revision_bindings binding
    ON binding.source_revision_id = candidate.source_revision_id;--> statement-breakpoint

CREATE OR REPLACE VIEW "source_owner_representation_consent_records" AS
SELECT consent.id, consent.logical_memory_id,
       consent.remote_replica_id, consent.source_owner_principal_id,
       consent.team_id, consent.team_workspace_id,
       consent.source_owner_policy_id, consent.source_owner_policy_version,
       consent.team_policy_id, consent.team_policy_version,
       consent.workspace_policy_id, consent.workspace_policy_version,
       consent.mode, consent.state, consent.consent_version,
       consent.preview_id, consent.preview_revision, consent.preview_hash,
       consent.source_revision, consent.maximum_authorized_source_revision,
       consent.source_hash, consent.content_policy_version,
       consent.content_policy_hash, consent.classifier_version,
       consent.classifier_hash,
       consent.created_at, consent.updated_at, consent.activated_at,
       consent.paused_at, consent.revoked_at, consent.expires_at,
       consent.state_reason_code, consent.maximum_fidelity,
       consent.include_curated_memory, consent.fidelity_policy_revision,
       consent.fidelity_policy_hash, consent.source_content_hash,
       consent.source_revision_id,
       consent.source_capabilities, consent.activation_representation,
       binding.source_kind,
       binding.source_session_id, binding.source_note_id,
       binding.source_memory_event_id, consent.retention_enabled,
       consent.retention_policy_enabled, consent.member_retention_version
  FROM source_owner_representation_consents consent
  JOIN logical_memory_source_revision_bindings binding
    ON binding.source_revision_id = consent.source_revision_id;--> statement-breakpoint

CREATE OR REPLACE VIEW "team_memory_share_grant_records" AS
SELECT grant_row.id, grant_row.logical_grant_id, grant_row.logical_memory_id,
       grant_row.source_revision_id, grant_row.remote_replica_id,
       grant_row.owner_user_id, grant_row.owner_principal_id,
       grant_row.display_title, grant_row.display_title_source_revision,
       grant_row.team_id, grant_row.team_workspace_id, grant_row.consent_id,
       grant_row.source_owner_policy_id, grant_row.source_owner_policy_version,
       grant_row.team_policy_id, grant_row.team_policy_version,
       grant_row.workspace_policy_id, grant_row.workspace_policy_version,
       grant_row.source_capabilities, grant_row.activation_representation,
       grant_row.mode, grant_row.maximum_fidelity,
       grant_row.include_curated_memory, grant_row.fidelity_policy_revision,
       grant_row.content_policy_version, grant_row.classifier_version,
       grant_row.source_revision, grant_row.grant_version,
       grant_row.revocation_epoch, grant_row.lifecycle,
       grant_row.creator_authority, grant_row.granted_by_user_id,
       grant_row.created_at, grant_row.updated_at, grant_row.revoked_at,
       grant_row.revoked_by_user_id, grant_row.revocation_reason,
       grant_row.personal_deleted_at, grant_row.personal_deleted_by_user_id,
       grant_row.personal_deletion_reason, grant_row.retained_by_team_at,
       grant_row.retention_reason, grant_row.retention_policy_id,
       grant_row.retention_policy_version, grant_row.retention_triggered_at,
       grant_row.retain_until, grant_row.active_retention_decision_id,
       grant_row.active_purge_job_id, grant_row.tombstoned_at,
       grant_row.purge_completed_at, binding.source_kind,
       binding.source_session_id, binding.source_note_id,
       binding.source_memory_event_id, grant_row.retention_enabled,
       grant_row.retention_policy_enabled, grant_row.member_retention_version,
       grant_row.source_updates_stopped_at,
       grant_row.source_updates_stopped_by_user_id
  FROM team_memory_share_grants grant_row
  JOIN logical_memory_source_revision_bindings binding
    ON binding.source_revision_id = grant_row.source_revision_id;
