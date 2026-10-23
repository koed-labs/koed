import type pg from "pg";

export type ShareOriginSource =
  | { originKind: "conversation"; conversationId: string }
  | { originKind: "share_window"; conversationId?: null };

export interface PersonalShareOriginRepository {
  recordInvitation(input: {
    ownerUserId: string;
    teamBackendId: string;
    inviteId: string;
    source: ShareOriginSource;
  }): Promise<void>;
  recordWorkspaceAccess(input: {
    ownerUserId: string;
    teamBackendId: string;
    teamWorkspaceId: string;
    teamUserId: string;
    accessGrantVersion: number;
    source: ShareOriginSource;
  }): Promise<void>;
  linkAcceptedInvitation(input: {
    ownerUserId: string;
    teamBackendId: string;
    inviteId: string;
    teamWorkspaceId: string;
    teamUserId: string;
    accessGrantVersion: number;
  }): Promise<boolean>;
}

/** Personal-only provenance. Callers derive owner and backend from authenticated custody. */
export const createPersonalShareOriginRepository = (
  pool: pg.Pool
): PersonalShareOriginRepository => ({
  async recordInvitation(input) {
    await pool.query(
      `insert into share_origins(owner_user_id,team_backend_id,target_kind,invite_id,origin_kind,conversation_id)
       values($1,$2,'invitation',$3,$4,$5)
       on conflict (owner_user_id,team_backend_id,invite_id) where target_kind='invitation' do nothing`,
      [
        input.ownerUserId,
        input.teamBackendId,
        input.inviteId,
        input.source.originKind,
        input.source.conversationId ?? null
      ]
    );
  },
  async recordWorkspaceAccess(input) {
    await pool.query(
      `insert into share_origins(owner_user_id,team_backend_id,target_kind,team_workspace_id,team_user_id,access_grant_version,origin_kind,conversation_id)
       values($1,$2,'workspace_access',$3,$4,$5,$6,$7)
       on conflict (owner_user_id,team_backend_id,team_workspace_id,team_user_id,access_grant_version)
       where target_kind='workspace_access' do nothing`,
      [
        input.ownerUserId,
        input.teamBackendId,
        input.teamWorkspaceId,
        input.teamUserId,
        input.accessGrantVersion,
        input.source.originKind,
        input.source.conversationId ?? null
      ]
    );
  },
  async linkAcceptedInvitation(input) {
    const result = await pool.query(
      `insert into share_origins(owner_user_id,team_backend_id,target_kind,team_workspace_id,team_user_id,access_grant_version,source_invite_id,origin_kind,conversation_id)
       select owner_user_id,team_backend_id,'workspace_access',$4,$5,$6,$3,origin_kind,conversation_id
         from share_origins
        where owner_user_id=$1 and team_backend_id=$2 and target_kind='invitation' and invite_id=$3
       on conflict (owner_user_id,team_backend_id,team_workspace_id,team_user_id,access_grant_version)
       where target_kind='workspace_access' do nothing`,
      [
        input.ownerUserId,
        input.teamBackendId,
        input.inviteId,
        input.teamWorkspaceId,
        input.teamUserId,
        input.accessGrantVersion
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }
});
