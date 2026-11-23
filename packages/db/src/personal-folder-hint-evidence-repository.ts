import type pg from "pg";
import {
  personalFolderHintEvidenceRequestSchema,
  personalOwnerIdSchema,
  type PersonalFolderHintEvidence
} from "@koed-labs/shared";
import { findKnownFolderCorrectionReferences } from "./personal-source-correction-context.js";
import {
  personalGitInferenceEvidenceJoins,
  personalGitInferenceEligible
} from "./personal-git-inference-evidence.js";
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
  known_copy: boolean;
  git_eligible: boolean;
  git_known: boolean;
  git_revision: number;
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
    const { sessionIds, proposedFolders } =
      personalFolderHintEvidenceRequestSchema.parse(raw);
    const result = await pool.query<EvidenceRow>(
      `select s.id, s.folder_assignment, s.cwd, s.source_runtime, s.external_session_id,
         native.first_at, provenance.known_copy,
         ${personalGitInferenceEligible} as git_eligible,
         case when s.repository_automatic_identity->>'kind' = 'portable_repository'
              then s.repository_automatic_identity->>'key' end as remote,
         coalesce(coalesce(s.repository_override_identity, s.repository_automatic_identity)->>'kind'
           in ('portable_repository', 'device_local_repository'), false) as git_known,
         s.repository_assignment_version as git_revision
       from sessions s
       ${personalGitInferenceEvidenceJoins}
       where s.owner_user_id = $1 and s.visibility = 'personal'
         and s.invalidated_at is null and s.personal_deleted_at is null
         and s.id = any($2::uuid[])
       order by s.id`,
      [ownerUserId, sessionIds]
    );
    return {
      ownerUserId,
      ...(proposedFolders
        ? {
            knownFolders: result.rows.length
              ? await findKnownFolderCorrectionReferences(
                  pool,
                  ownerUserId,
                  proposedFolders
                )
              : []
          }
        : {}),
      evidence: result.rows.map((row) => ({
        sessionId: row.id,
        folderAssignment: row.folder_assignment as never,
        recordedCwd: row.cwd,
        firstConversationAt: row.first_at ? row.first_at.toISOString() : null,
        recordedRemoteFingerprint: row.remote,
        capturedOnThisDevice: false,
        recordingDeviceProvenance: row.known_copy ? "known-copy" : "unknown",
        gitInferenceEligibility: row.git_eligible,
        gitAnchorKnown: row.git_known,
        gitRevision: row.git_revision,
        sourceRuntime: row.source_runtime,
        externalSessionId: row.external_session_id
      }))
    };
  }
});
