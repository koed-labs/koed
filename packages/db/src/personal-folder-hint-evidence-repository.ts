import type pg from "pg";
import {
  effectivePersonalSourceFact,
  personalFolderAssignmentSchema,
  personalFolderHintRequestSchema,
  personalFolderObservationRecordSchema,
  personalOwnerIdSchema,
  type PersonalFolderHintEvidence
} from "@koed-labs/shared";
import { folderObservationHash } from "./folder-assignment.js";
import type { ActorContext } from "./types.js";

export type PersonalFolderHintEvidenceRepository = {
  getPersonalFolderHintEvidence(
    actor: ActorContext,
    raw: unknown
  ): Promise<PersonalFolderHintEvidence>;
  recordPersonalFolderObservation(
    actor: ActorContext,
    sessionId: string,
    raw: unknown
  ): Promise<{ recorded: boolean }>;
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
         (s.repository_automatic_identity->>'kind' = 'portable_repository'
           or s.repository_override_identity is not null) as git_known
       from sessions s
       where s.owner_user_id = $1 and s.visibility = 'personal'
         and s.invalidated_at is null and s.id = any($2::uuid[])
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
  },
  async recordPersonalFolderObservation(
    actor: ActorContext,
    sessionId: string,
    raw: unknown
  ): Promise<{ recorded: boolean }> {
    const ownerUserId = personalOwnerIdSchema.parse(actor.userId);
    const { observation } = personalFolderObservationRecordSchema.parse(raw);
    const found = await pool.query<{
      folder_assignment: unknown;
      cwd: string | null;
      replica: boolean;
    }>(
      `select s.folder_assignment, s.cwd,
         exists (select 1 from pds_logical_replicas r
                  where r.local_session_id = s.id
                    and r.owner_user_id = s.owner_user_id) as replica
       from sessions s
       where s.id = $1 and s.owner_user_id = $2 and s.visibility = 'personal'
         and s.invalidated_at is null and s.personal_deleted_at is null`,
      [sessionId, ownerUserId]
    );
    const row = found.rows[0];
    if (!row)
      throw Object.assign(new Error("Conversation not found"), {
        statusCode: 404
      });
    const assignment = personalFolderAssignmentSchema.parse(
      row.folder_assignment
    );
    const original = assignment.original;
    // Only a Folder-less Conversation captured here. The observation comes from
    // the owner's own device (a worktree's main checkout is a different directory
    // from the Conversation's), and only adds evidence the owner can then choose.
    if (
      row.replica ||
      effectivePersonalSourceFact(assignment).state !== "unresolved" ||
      original.state !== "unresolved" ||
      (original.reason !== "missing" &&
        original.reason !== "historical_unresolved")
    )
      throw Object.assign(
        new Error("This Conversation cannot record that Folder"),
        { statusCode: 409 }
      );
    const inserted = await pool.query(
      `insert into session_folder_observations (session_id,owner_user_id,observation_hash,observation)
       values ($1,$2,$3,$4) on conflict (session_id,observation_hash) do nothing`,
      [sessionId, ownerUserId, folderObservationHash(observation), observation]
    );
    return { recorded: (inserted.rowCount ?? 0) > 0 };
  }
});
