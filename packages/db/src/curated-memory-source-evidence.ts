import { decryptAuthorizedEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import type { CuratedMemoryRepository } from "./curated-memory-repository.js";
import {
  requireEncryptionProvider,
  type CuratedMemoryRepositoryContext
} from "./curated-memory-support.js";

export const createCuratedMemorySourceEvidenceMethods = ({
  pool,
  envelopeEncryptionProvider
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  "hydrateCuratedProjectSourceEvidence"
> => ({
  async hydrateCuratedProjectSourceEvidence(actor, input) {
    const client = await pool.connect();
    try {
      if (input.sourceType === "project_work_item") {
        const result = await client.query<{
          id: string;
          project_id: string;
          title: string;
          goal: string;
        }>(
          `select item.id,item.project_id,item.title,item.goal
             from project_work_items item
             join projects project on project.id=item.project_id
               and project.owner_user_id=item.owner_user_id
            where item.id=$1 and item.owner_user_id=$2
              and item.deleted_at is null
              and project.lifecycle='active' and project.deletion_phase is null`,
          [input.sourceId, actor.userId]
        );
        const row = result.rows[0];
        return row
          ? {
              sourceType: input.sourceType,
              sourceId: row.id,
              projectId: row.project_id,
              text: `${row.title}\n${row.goal}`
            }
          : null;
      }
      const result = await client.query<{
        id: string;
        project_id: string;
        note_revision_id: string;
      }>(
        `select revision.id,source.project_id,revision.note_revision_id
           from project_source_revisions revision
           join project_sources source on source.id=revision.source_id
             and source.owner_user_id=revision.owner_user_id
           join projects project on project.id=source.project_id
             and project.owner_user_id=source.owner_user_id
           join personal_note_revisions note_revision
             on note_revision.id=revision.note_revision_id
            and note_revision.owner_user_id=revision.owner_user_id
           join personal_notes note on note.id=note_revision.note_id
             and note.owner_user_id=note_revision.owner_user_id
          where revision.id=$1 and revision.owner_user_id=$2
            and revision.state='ready' and source.kind='doc'
            and source.status='ready' and source.deleted_at is null
            and source.remove_batch_id is null
            and project.lifecycle='active' and project.deletion_phase is null
            and note_revision.projection_state='available'
            and note_revision.forgotten_at is null and note.lifecycle='active'`,
        [input.sourceId, actor.userId]
      );
      const row = result.rows[0];
      if (!row) return null;
      const payload = await decryptAuthorizedEncryptedFieldPayloadWithClient(
        client,
        actor,
        requireEncryptionProvider(envelopeEncryptionProvider),
        {
          sourceTable: "personal_note_revisions",
          sourceId: row.note_revision_id,
          sourceColumn: "body"
        }
      );
      return typeof payload?.plaintext === "string"
        ? {
            sourceType: input.sourceType,
            sourceId: row.id,
            projectId: row.project_id,
            text: payload.plaintext
          }
        : null;
    } finally {
      client.release();
    }
  }
});
