import type pg from "pg";
import {
  personalFolderHintRequestSchema,
  personalOwnerIdSchema,
  type PersonalFolderHintEvidence
} from "@koed-labs/shared";
import type { ActorContext } from "./types.js";

export type PersonalFolderHintEvidenceRepository = {
  getPersonalFolderHintEvidence(
    actor: ActorContext,
    raw: unknown
  ): Promise<PersonalFolderHintEvidence>;
};

type EvidenceRow = {
  id: string;
  folder_assignment: unknown;
  cwd: string | null;
  first_at: Date | null;
  remote: string | null;
  replica: boolean;
  git_known: boolean;
  source_runtime: string | null;
  external_session_id: string | null;
};

/** Read-only recorded facts for advisory Folder hints. This never records a
 * Folder observation or changes an assignment. Only the owner's personal
 * Conversations are returned; any other id is silently absent. */
export const createPersonalFolderHintEvidenceRepository = (
  pool: pg.Pool
): PersonalFolderHintEvidenceRepository => ({
  async getPersonalFolderHintEvidence(
    actor: ActorContext,
    raw: unknown
  ): Promise<PersonalFolderHintEvidence> {
    const ownerUserId = personalOwnerIdSchema.parse(actor.userId);
    const { sessionIds } = personalFolderHintRequestSchema.parse(raw);
    const result = await pool.query<EvidenceRow>(
      `select s.id, s.folder_assignment, s.cwd, s.source_runtime, s.external_session_id,
         (select min(coalesce(e.source_event_time, e.captured_at))
            from memory_events e where e.session_id = s.id) as first_at,
         case when s.repository_automatic_identity->>'kind' = 'portable_repository'
              then s.repository_automatic_identity->>'key' end as remote,
         exists (select 1 from pds_logical_replicas r
                  where r.local_session_id = s.id
                    and r.owner_user_id = s.owner_user_id) as replica,
         coalesce(coalesce(s.repository_override_identity, s.repository_automatic_identity)->>'kind'
           in ('portable_repository', 'device_local_repository'), false) as git_known
       from sessions s
       where s.owner_user_id = $1 and s.visibility = 'personal'
         and s.invalidated_at is null and s.personal_deleted_at is null
         and s.id = any($2::uuid[])
       order by s.id`,
      [ownerUserId, sessionIds]
    );
    return {
      ownerUserId,
      evidence: result.rows.map((row) => ({
        sessionId: row.id,
        folderAssignment: row.folder_assignment as never,
        recordedCwd: row.cwd,
        firstConversationAt: row.first_at ? row.first_at.toISOString() : null,
        recordedRemoteFingerprint: row.remote,
        capturedOnThisDevice: !row.replica,
        gitAnchorKnown: row.git_known,
        sourceRuntime: row.source_runtime,
        externalSessionId: row.external_session_id
      }))
    };
  }
});
