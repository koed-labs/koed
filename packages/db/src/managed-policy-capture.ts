import type pg from "pg";

/** Apply only an immutable managed-execution snapshot made before capture. */
export const stampManagedPolicyCapture = async (
  client: pg.PoolClient,
  ownerUserId: string,
  logicalSessionId: string
): Promise<void> => {
  await client.query(
    `update sessions session
        set automatic_personal_project_id=project.id,
            project_share_capture_policy_version=execution.share_policy_capture_version,
            project_share_capture_workspace_project_id=execution.share_policy_capture_workspace_project_id,
            project_share_capture_device_credential_id=execution.share_policy_capture_device_credential_id,
            project_share_capture_link_epoch=execution.share_policy_capture_link_epoch,
            project_share_capture_context_version=1,
            project_share_capture_prepared_at=execution.share_policy_capture_prepared_at,
            updated_at=now()
       from managed_conversation_executions execution
       join projects project on project.id::text=execution.project_id
         and project.owner_user_id=execution.owner_user_id
      where session.owner_user_id=$1 and session.logical_session_id=$2
        and execution.owner_user_id=$1 and execution.logical_session_id=$2
        and execution.is_project_hq=false
        and execution.share_policy_capture_version is not null
        and execution.share_policy_capture_workspace_project_id is not null
        and execution.share_policy_capture_device_credential_id is not null
        and execution.share_policy_capture_link_epoch is not null
        and execution.share_policy_capture_prepared_at is not null
        and execution.created_at<=session.created_at
        and execution.share_policy_capture_prepared_at<=session.created_at
        and project.lifecycle='active' and project.deletion_phase is null
        and project.project_share_policy_version=execution.share_policy_capture_version
        and project.workspace_project_id=execution.share_policy_capture_workspace_project_id
        and project.project_share_policy_device_credential_id=execution.share_policy_capture_device_credential_id
        and project.share_policy_link_epoch=execution.share_policy_capture_link_epoch
        and project.project_share_policy_enabled_at<=execution.share_policy_capture_prepared_at
        and session.visibility='personal' and session.source_kind is not null
        and session.source_adapter_version is not null
        and coalesce(session.external_thread_id,session.external_session_id) is not null
        and session.project_share_capture_policy_version is null
        and (session.automatic_personal_project_id is null
          or session.automatic_personal_project_id=project.id)
        and session.project_override_at is null
        and session.project_override_personal_project_id is null
        and session.project_override_id is null
        and session.project_share_private_at is null
        and session.project_share_private_pending_at is null
        and session.project_share_move_pending_at is null
        and session.personal_deleted_at is null and session.invalidated_at is null
        and session.trashed_at is null and session.delete_batch_id is null
        and session.forget_batch_id is null
        and not exists(select 1 from project_share_private_conversations private
          where private.owner_user_id=session.owner_user_id
            and private.source_runtime=session.source_runtime
            and private.source_kind=session.source_kind
            and private.source_adapter_version=session.source_adapter_version
            and private.external_conversation_id=coalesce(
              session.external_thread_id,session.external_session_id))`,
    [ownerUserId, logicalSessionId]
  );
};
