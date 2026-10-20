import type pg from "pg";

/** The old route's only remaining runtime purpose is Capture Target
 * compatibility. It never writes Git, Folder or Project membership. */
export const preserveRoutedCaptureTarget = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string
) => {
  await client.query(
    `insert into personal_capture_target_bindings(owner_user_id,session_id,logical_session_id,
    origin,route_source_scope,original_target_id,original_target_name,original_target_path,target_id,legacy_detached_at)
    select s.owner_user_id,s.id,s.logical_session_id,'legacy_route',r.source_scope,r.target_id,r.target_name,r.target_path,r.target_id,now()
    from sessions s join personal_capture_target_routes r on r.owner_user_id=s.owner_user_id
      and r.source_scope=repository_scope_id(s.repository_automatic_identity)
    where s.id=$2 and s.owner_user_id=$1 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
      and s.repository_assignment_state='recorded' and s.repository_override_identity is null and s.project_override_id is null
    on conflict(owner_user_id,session_id) do nothing`,
    [ownerUserId, sessionId]
  );
};
