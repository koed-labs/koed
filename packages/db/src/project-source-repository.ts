import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  createProjectSourceSchema,
  type EnvelopeEncryptionProvider,
  type CreateProjectSource,
  type ProjectSource
} from "@koed/shared";
import {
  ProjectConflictError,
  ProjectNotFoundError,
  ProjectCapabilityError
} from "./project-api-repository.js";
import { appendProjectActivityWithClient } from "./project-activity-repository.js";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import { writeProjectSourcePersonalNoteWithClient } from "./collaboration-repository.js";
import { invalidateDerivedMemoryForMemoryEvents } from "./derived-memory-invalidation.js";
import { suppressCuratedMemoryWithoutActiveEvidenceWithClient } from "./curated-memory-repository.js";

export const PROJECT_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const sourceAttempt = (row: Row) => ({
  id: String(row.id),
  sourceId: String(row.source_id),
  state: String(row.state),
  failureReason: nullableText(row.failure_reason),
  noteRevisionId: nullableText(row.note_revision_id),
  leaseGeneration: Number(row.lease_generation),
  contentHash: String(row.content_hash),
  byteLength: Number(row.byte_length),
  mediaType: String(row.media_type)
});

type Row = Record<string, unknown>;
const iso = (value: unknown) =>
  value == null ? null : new Date(value as Date).toISOString();
const nullableText = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value !== "string")
    throw new TypeError("Expected Project Source text");
  return value;
};
const map = (row: Row): ProjectSource => ({
  id: String(row.id),
  projectId: String(row.project_id),
  kind: row.kind as ProjectSource["kind"],
  name: String(row.name),
  uri: nullableText(row.uri),
  currentRevisionId: nullableText(row.current_revision_id),
  status: row.status as ProjectSource["status"],
  failureReason: row.failure_reason as ProjectSource["failureReason"],
  addedBy: String(row.added_by),
  uses: Number(row.uses),
  deletedAt: iso(row.deleted_at),
  createdAt: iso(row.created_at)!
});

export const createProjectSourceRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider } = {}
) => {
  const project = async (
    client: pg.PoolClient | pg.Pool,
    ownerUserId: string,
    projectId: string,
    lock = false,
    linked?: { teamBackendId: string; workspaceProjectId: string } | true
  ) => {
    const found = await client.query<Row>(
      `select * from projects where owner_user_id=$1 and id=$2 ${lock ? "for update" : ""}`,
      [ownerUserId, projectId]
    );
    if (!found.rows[0]) throw new ProjectNotFoundError("Project not found");
    if (
      found.rows[0].lifecycle !== "active" ||
      found.rows[0].deletion_phase != null
    )
      throw new ProjectConflictError("Project is unavailable during deletion");
    if (
      linked &&
      linked !== true &&
      (found.rows[0].team_backend_id !== linked.teamBackendId ||
        found.rows[0].workspace_project_id !== linked.workspaceProjectId)
    )
      throw new ProjectCapabilityError(
        "Linked Project source authority changed"
      );
    if (
      !linked &&
      (found.rows[0].team_backend_id != null ||
        found.rows[0].workspace_project_id != null ||
        found.rows[0].team_workspace_id != null)
    )
      throw new ProjectCapabilityError(
        "Linked Project sources require Team authority"
      );
  };
  const transaction = async <T>(
    work: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const uploadDocument = async (
    ownerUserId: string,
    projectId: string,
    input: {
      name: string;
      mediaType: string;
      bytesBase64: string;
      idempotencyKey: string;
    },
    linked?: { teamBackendId: string; workspaceProjectId: string }
  ) => {
    const provider = options.envelopeEncryptionProvider;
    if (!provider)
      throw new ProjectCapabilityError(
        "Project Source encryption is unavailable"
      );
    const name = input.name.trim();
    if (!name || name.length > 200 || input.idempotencyKey.length > 512)
      throw new TypeError("Invalid Project Source upload metadata");
    if (input.bytesBase64.length % 4 !== 0)
      throw new TypeError("Project Source bytes are not canonical base64");
    const bytes = Buffer.from(input.bytesBase64, "base64");
    if (bytes.length > PROJECT_SOURCE_MAX_BYTES)
      throw new ProjectCapabilityError("Project Source exceeds 25 MB");
    if (bytes.toString("base64") !== input.bytesBase64)
      throw new TypeError("Project Source bytes are not canonical base64");
    const contentHash = sha256(bytes);
    const keyHash = sha256(`project-source-upload:v1\n${input.idempotencyKey}`);
    return transaction(async (client) => {
      await project(client, ownerUserId, projectId, true, linked);
      const existing = await client.query<Row>(
        `select * from project_sources where owner_user_id=$1 and project_id=$2
            and kind='doc' and name=$3 and deleted_at is null
            order by created_at,id limit 1 for update`,
        [ownerUserId, projectId, name]
      );
      let source = existing.rows[0];
      if (source?.remove_batch_id != null)
        throw new ProjectConflictError("Project Source removal is pending");
      if (!source) {
        const inserted = await client.query<Row>(
          `insert into project_sources
              (owner_user_id,project_id,kind,name,status,added_by)
             values ($1,$2,'doc',$3,'uploading',$1) returning *`,
          [ownerUserId, projectId, name]
        );
        source = inserted.rows[0]!;
        await appendProjectActivityWithClient(client, {
          ownerUserId,
          projectId,
          actorUserId: ownerUserId,
          kind: "source_added",
          ref: String(source.id)
        });
      }
      const repeated = await client.query<Row>(
        `select * from project_source_revisions where owner_user_id=$1
            and source_id=$2 and idempotency_key_hash=$3`,
        [ownerUserId, source.id, keyHash]
      );
      if (repeated.rows[0]) {
        if (repeated.rows[0].content_hash !== contentHash)
          throw new ProjectConflictError(
            "Project Source upload idempotency key changed content"
          );
        return {
          source: map(source),
          attempt: sourceAttempt(repeated.rows[0])
        };
      }
      if (source.pending_revision_id != null)
        throw new ProjectConflictError(
          "Project Source upload is already pending"
        );
      const latest = await client.query<{ revision: number }>(
        `select coalesce(max(revision),0)::integer as revision
             from project_source_revisions where owner_user_id=$1 and source_id=$2`,
        [ownerUserId, source.id]
      );
      const attemptId = randomUUID();
      const attempt = await client.query<Row>(
        `insert into project_source_revisions
             (id,owner_user_id,source_id,revision,idempotency_key_hash,
              content_hash,byte_length,media_type,state)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'uploading') returning *`,
        [
          attemptId,
          ownerUserId,
          source.id,
          (latest.rows[0]?.revision ?? 0) + 1,
          keyHash,
          contentHash,
          bytes.length,
          input.mediaType
        ]
      );
      await upsertEncryptedFieldPayloadWithClient(
        client,
        { userId: ownerUserId },
        provider,
        {
          sourceTable: "project_source_revisions",
          sourceId: attemptId,
          sourceColumn: "original_binary",
          plaintext: input.bytesBase64,
          plaintextContentType: "application/octet-stream",
          plaintextEncoding: "base64",
          scope: { objectClass: "project_source_revision", projectId },
          rowFamily: "project_source_revision",
          aad: {
            ownerUserId,
            projectId,
            sourceId: String(source.id),
            contentHash
          }
        }
      );
      const updated = await client.query<Row>(
        `update project_sources set pending_revision_id=$3,status='extracting',
             failure_reason=null,updated_at=now()
            where owner_user_id=$1 and id=$2 returning *`,
        [ownerUserId, source.id, attemptId]
      );
      return {
        source: map(updated.rows[0]!),
        attempt: sourceAttempt(attempt.rows[0]!)
      };
    });
  };
  return {
    uploadDocument: (
      ownerUserId: string,
      projectId: string,
      input: {
        name: string;
        mediaType: string;
        bytesBase64: string;
        idempotencyKey: string;
      }
    ) => uploadDocument(ownerUserId, projectId, input),
    uploadLinkedDocument: (
      ownerUserId: string,
      projectId: string,
      input: {
        name: string;
        mediaType: string;
        bytesBase64: string;
        idempotencyKey: string;
      },
      linked: { teamBackendId: string; workspaceProjectId: string }
    ) => uploadDocument(ownerUserId, projectId, input, linked),
    async claimDocumentAttempt() {
      const provider = options.envelopeEncryptionProvider;
      if (!provider) return null;
      return transaction(async (client) => {
        const found = await client.query<Row>(
          `select revision.*,source.name as source_name from project_source_revisions revision
             join project_sources source on source.id=revision.source_id
               and source.owner_user_id=revision.owner_user_id
             join projects project on project.id=source.project_id
               and project.owner_user_id=source.owner_user_id
            where source.pending_revision_id=revision.id
              and source.deleted_at is null
              and source.remove_batch_id is null
              and project.lifecycle='active' and project.deletion_phase is null
              and (revision.state='uploading' or
                (revision.state='extracting' and revision.updated_at < now() - interval '2 minutes'))
            order by revision.created_at,revision.id
            limit 1 for update of revision skip locked`
        );
        const row = found.rows[0];
        if (!row) return null;
        const claimed = await client.query<Row>(
          `update project_source_revisions set state='extracting',
             lease_generation=lease_generation+1,updated_at=now()
            where id=$1 and owner_user_id=$2 returning *`,
          [row.id, row.owner_user_id]
        );
        const encrypted =
          await decryptAuthorizedEncryptedFieldPayloadWithClient(
            client,
            { userId: String(row.owner_user_id) },
            provider,
            {
              sourceTable: "project_source_revisions",
              sourceId: String(row.id),
              sourceColumn: "original_binary"
            }
          );
        if (typeof encrypted?.plaintext !== "string")
          throw new ProjectCapabilityError(
            "Project Source original is unavailable"
          );
        const bytes = Buffer.from(encrypted.plaintext, "base64");
        if (
          bytes.length !== Number(row.byte_length) ||
          sha256(bytes) !== row.content_hash
        )
          throw new ProjectConflictError(
            "Project Source original hash changed"
          );
        return {
          ...sourceAttempt(claimed.rows[0]!),
          ownerUserId: String(row.owner_user_id),
          name: String(row.source_name),
          bytes,
          contentHash: String(row.content_hash)
        };
      });
    },
    async completeDocumentAttempt(input: {
      ownerUserId: string;
      attemptId: string;
      leaseGeneration: number;
      text: string;
    }) {
      const provider = options.envelopeEncryptionProvider;
      if (!provider)
        throw new ProjectCapabilityError(
          "Project Source encryption is unavailable"
        );
      return transaction(async (client) => {
        const identity = await client.query<{ project_id: string }>(
          `select source.project_id from project_source_revisions revision
             join project_sources source on source.id=revision.source_id
              and source.owner_user_id=revision.owner_user_id
            where revision.id=$1 and revision.owner_user_id=$2`,
          [input.attemptId, input.ownerUserId]
        );
        if (!identity.rows[0])
          throw new ProjectNotFoundError("Project Source attempt not found");
        await project(
          client,
          input.ownerUserId,
          identity.rows[0].project_id,
          true,
          true
        );
        const found = await client.query<Row>(
          `select source.*,revision.lease_generation,
                  revision.note_revision_id
             from project_source_revisions revision
             join project_sources source on source.id=revision.source_id
                and source.owner_user_id=revision.owner_user_id
            where revision.id=$1 and revision.owner_user_id=$2
            for update of source,revision`,
          [input.attemptId, input.ownerUserId]
        );
        const source = found.rows[0];
        if (
          !source ||
          source.deleted_at != null ||
          source.remove_batch_id != null ||
          source.pending_revision_id !== input.attemptId ||
          Number(source.lease_generation) !== input.leaseGeneration
        )
          throw new ProjectConflictError("Project Source attempt was fenced");
        let oldNoteId: string | null = null;
        if (source.current_revision_id) {
          const old = await client.query<{
            note_id: string;
            lifecycle: string;
            forgotten_at: Date | null;
          }>(
            `select revision.note_id,note.lifecycle,revision.forgotten_at
               from personal_note_revisions revision
               join personal_notes note on note.id=revision.note_id and note.owner_user_id=revision.owner_user_id
              where revision.id=$1 and revision.owner_user_id=$2`,
            [source.current_revision_id, input.ownerUserId]
          );
          if (!old.rows[0])
            throw new ProjectConflictError(
              "Project Source Note binding changed"
            );
          oldNoteId =
            old.rows[0].lifecycle === "active" &&
            old.rows[0].forgotten_at == null
              ? old.rows[0].note_id
              : null;
        }
        if (source.note_revision_id != null && !oldNoteId)
          throw new ProjectConflictError(
            "Project Source attempt Note revision was forgotten"
          );
        const note = await writeProjectSourcePersonalNoteWithClient(
          client,
          provider,
          {
            ownerUserId: input.ownerUserId,
            sourceRevisionId: input.attemptId,
            sourceName: String(source.name),
            body: input.text,
            existingNoteId: oldNoteId
          }
        );
        await client.query(
          `update project_source_revisions set note_revision_id=$3,updated_at=now()
            where id=$1 and owner_user_id=$2`,
          [input.attemptId, input.ownerUserId, note.revisionId]
        );
        await client.query(
          `update project_sources set current_revision_id=$3,updated_at=now()
            where id=$1 and owner_user_id=$2`,
          [source.id, input.ownerUserId, note.revisionId]
        );
        return {
          sourceId: String(source.id),
          projectId: String(source.project_id),
          note
        };
      });
    },
    async finishDocumentAttempt(input: {
      ownerUserId: string;
      attemptId: string;
      leaseGeneration: number;
      failureReason?: ProjectSource["failureReason"];
    }) {
      return transaction(async (client) => {
        const identity = await client.query<{ project_id: string }>(
          `select source.project_id from project_source_revisions revision
             join project_sources source on source.id=revision.source_id
              and source.owner_user_id=revision.owner_user_id
            where revision.id=$1 and revision.owner_user_id=$2`,
          [input.attemptId, input.ownerUserId]
        );
        if (!identity.rows[0])
          throw new ProjectNotFoundError("Project Source attempt not found");
        await project(
          client,
          input.ownerUserId,
          identity.rows[0].project_id,
          true,
          true
        );
        const result = await client.query<Row>(
          `select source.*,revision.note_revision_id from project_source_revisions revision
            join project_sources source on source.id=revision.source_id
             and source.owner_user_id=revision.owner_user_id
           where revision.id=$1 and revision.owner_user_id=$2
             and revision.lease_generation=$3
             and source.pending_revision_id=revision.id
             and source.deleted_at is null
           for update of source,revision`,
          [input.attemptId, input.ownerUserId, input.leaseGeneration]
        );
        const source = result.rows[0];
        if (!source)
          throw new ProjectConflictError("Project Source attempt was fenced");
        if (source.remove_batch_id != null)
          throw new ProjectConflictError("Project Source removal is pending");
        const next = input.failureReason ? "failed" : "ready";
        if (next === "ready") {
          const projected = await client.query(
            `select 1 from personal_note_revisions where id=$1
              and owner_user_id=$2 and projection_state='available'
              and memory_event_id is not null`,
            [source.note_revision_id, input.ownerUserId]
          );
          if (!projected.rows[0])
            throw new ProjectConflictError(
              "Project Source Note projection is not available"
            );
        } else if (source.note_revision_id != null) {
          throw new ProjectConflictError(
            "Projected Project Source cannot be marked as a parse failure"
          );
        }
        await client.query(
          `update project_source_revisions set state=$3,failure_reason=$4,updated_at=now()
           where id=$1 and owner_user_id=$2`,
          [
            input.attemptId,
            input.ownerUserId,
            next,
            input.failureReason ?? null
          ]
        );
        const changed = await client.query<Row>(
          `update project_sources set status=$3,failure_reason=$4,
             pending_revision_id=null,updated_at=now()
           where id=$1 and owner_user_id=$2 returning *`,
          [source.id, input.ownerUserId, next, input.failureReason ?? null]
        );
        await appendProjectActivityWithClient(client, {
          ownerUserId: input.ownerUserId,
          projectId: String(source.project_id),
          actorUserId: input.ownerUserId,
          kind: next === "ready" ? "source_ready" : "source_failed",
          ref: input.attemptId
        });
        return map(changed.rows[0]!);
      });
    },
    async list(ownerUserId: string, projectId: string) {
      await project(pool, ownerUserId, projectId);
      const result = await pool.query<Row>(
        `select * from project_sources where owner_user_id=$1 and project_id=$2 and deleted_at is null order by created_at desc,id desc`,
        [ownerUserId, projectId]
      );
      return result.rows.map(map);
    },
    async create(
      ownerUserId: string,
      projectId: string,
      input: CreateProjectSource
    ) {
      const validated = createProjectSourceSchema.parse(input);
      return transaction(async (client) => {
        await project(client, ownerUserId, projectId, true);
        // HQ-209 owns binary storage, extraction, and Personal Note revisions.
        if (validated.kind === "doc")
          throw new ProjectCapabilityError(
            "Document Sources require binary upload through /v1/projects/:id/sources/upload"
          );
        const created = await client.query<Row>(
          `insert into project_sources(owner_user_id,project_id,kind,name,uri,status,failure_reason,added_by)
           values($1,$2,$3,$4,$5,$6,$7,$1) returning *`,
          [
            ownerUserId,
            projectId,
            validated.kind,
            validated.name,
            validated.uri ?? null,
            "ready",
            null
          ]
        );
        await appendProjectActivityWithClient(client, {
          ownerUserId,
          projectId,
          actorUserId: ownerUserId,
          kind: "source_added",
          ref: String(created.rows[0]!.id)
        });
        return map(created.rows[0]!);
      });
    },
    async remove(ownerUserId: string, projectId: string, sourceId: string) {
      return transaction(async (client) => {
        await project(client, ownerUserId, projectId, true);
        const found = await client.query<Row>(
          `select * from project_sources where owner_user_id=$1 and project_id=$2 and id=$3 for update`,
          [ownerUserId, projectId, sourceId]
        );
        if (!found.rows[0] || found.rows[0].deleted_at)
          throw new ProjectNotFoundError("Project Source not found");
        if (found.rows[0].remove_batch_id != null)
          throw new ProjectConflictError("Project Source removal is pending");
        if (found.rows[0].current_revision_id)
          throw new ProjectCapabilityError(
            "Note-backed Project Source trash requires grant freeze"
          );
        const changed = await client.query<Row>(
          `update project_sources set deleted_at=now(),updated_at=now() where owner_user_id=$1 and project_id=$2 and id=$3 returning *`,
          [ownerUserId, projectId, sourceId]
        );
        return map(changed.rows[0]!);
      });
    },
    async retry(ownerUserId: string, projectId: string, sourceId: string) {
      return transaction(async (client) => {
        await project(client, ownerUserId, projectId, true);
        const found = await client.query<Row>(
          `select * from project_sources where owner_user_id=$1 and project_id=$2
             and id=$3 and deleted_at is null for update`,
          [ownerUserId, projectId, sourceId]
        );
        const source = found.rows[0];
        if (!source) throw new ProjectNotFoundError("Project Source not found");
        if (source.remove_batch_id != null)
          throw new ProjectConflictError("Project Source removal is pending");
        if (source.status !== "failed" || source.kind !== "doc")
          throw new ProjectConflictError(
            "Project Source is not a failed document"
          );
        const failed = await client.query<Row>(
          `select * from project_source_revisions where owner_user_id=$1
             and source_id=$2 and state='failed'
             order by revision desc limit 1 for update`,
          [ownerUserId, sourceId]
        );
        if (!failed.rows[0])
          throw new ProjectConflictError(
            "Failed Project Source attempt is unavailable"
          );
        await client.query(
          `update project_source_revisions set state='uploading',failure_reason=null,
             updated_at=now() where id=$1 and owner_user_id=$2`,
          [failed.rows[0].id, ownerUserId]
        );
        const changed = await client.query<Row>(
          `update project_sources set status='extracting',failure_reason=null,
             pending_revision_id=$3,updated_at=now()
            where owner_user_id=$1 and id=$2 returning *`,
          [ownerUserId, sourceId, failed.rows[0].id]
        );
        return map(changed.rows[0]!);
      });
    },
    async readDocument(
      ownerUserId: string,
      projectId: string,
      sourceId: string,
      linked?: { teamBackendId: string; workspaceProjectId: string }
    ) {
      const provider = options.envelopeEncryptionProvider;
      if (!provider)
        throw new ProjectCapabilityError(
          "Project Source encryption is unavailable"
        );
      return transaction(async (client) => {
        await project(client, ownerUserId, projectId, true, linked);
        const result = await client.query<{
          source_id: string;
          source_revision_id: string;
          note_id: string;
          note_revision_id: string;
          name: string;
          status: string;
        }>(
          `select source.id as source_id,attempt.id as source_revision_id,
                revision.note_id,attempt.note_revision_id,source.name,source.status
           from project_sources source
           join project_source_revisions attempt
             on attempt.note_revision_id=source.current_revision_id
            and attempt.owner_user_id=source.owner_user_id
            and attempt.source_id=source.id
           join personal_note_revisions revision
             on revision.id=attempt.note_revision_id
            and revision.owner_user_id=attempt.owner_user_id
          where source.owner_user_id=$1 and source.project_id=$2
            and source.id=$3 and source.deleted_at is null
            and source.status='ready'
          for update of source,attempt`,
          [ownerUserId, projectId, sourceId]
        );
        const row = result.rows[0];
        if (!row)
          throw new ProjectNotFoundError("Readable Project Source not found");
        const noteState = await client.query(
          `select 1 from personal_note_revisions revision
          join personal_notes note on note.id=revision.note_id
           and note.owner_user_id=revision.owner_user_id
         where revision.id=$1 and revision.owner_user_id=$2
           and revision.projection_state='available'
           and note.lifecycle='active' and revision.forgotten_at is null
         for update of note,revision`,
          [row.note_revision_id, ownerUserId]
        );
        if (!noteState.rows[0])
          throw new ProjectConflictError("Project Source Note is unavailable");
        const body = await decryptAuthorizedEncryptedFieldPayloadWithClient(
          client,
          { userId: ownerUserId },
          provider,
          {
            sourceTable: "personal_note_revisions",
            sourceId: row.note_revision_id,
            sourceColumn: "body"
          }
        );
        if (typeof body?.plaintext !== "string")
          throw new ProjectConflictError(
            "Project Source Note revision was forgotten"
          );
        return {
          sourceId: row.source_id,
          sourceRevisionId: row.source_revision_id,
          noteId: row.note_id,
          noteRevisionId: row.note_revision_id,
          name: row.name,
          text: body.plaintext
        };
      });
    },
    // Owner-scoped exact Note revision forget works after Source or Project
    // trash. It does not change Source lifecycle or any Team grant.
    async forgetDocumentNoteRevision(
      ownerUserId: string,
      noteRevisionId: string
    ) {
      return transaction(async (client) => {
        const note = await client.query<{
          note_id: string;
          memory_event_id: string | null;
          forgotten_at: Date | null;
          revision: number;
          current_revision: number;
          attempt_id: string;
        }>(
          `select revision.note_id,revision.memory_event_id,revision.forgotten_at,
                  revision.revision,note.current_revision,attempt.id as attempt_id
             from personal_note_revisions revision
             join personal_notes note on note.id=revision.note_id and note.owner_user_id=revision.owner_user_id
             join project_source_revisions attempt on attempt.note_revision_id=revision.id
               and attempt.owner_user_id=revision.owner_user_id
            where revision.id=$1 and revision.owner_user_id=$2
            for update of note,revision`,
          [noteRevisionId, ownerUserId]
        );
        if (!note.rows[0])
          throw new ProjectNotFoundError(
            "Project Source Note revision not found"
          );
        if (note.rows[0].forgotten_at != null) return false;
        const pending = await client.query(
          `select 1 from project_sources where pending_revision_id=$1 and owner_user_id=$2 limit 1`,
          [note.rows[0].attempt_id, ownerUserId]
        );
        if (pending.rows[0])
          throw new ProjectConflictError(
            "Project Source Note projection must settle before forgetting"
          );
        await client.query(
          `update personal_note_revisions set forgotten_at=now()
          where id=$1 and owner_user_id=$2`,
          [noteRevisionId, ownerUserId]
        );
        if (note.rows[0].revision === note.rows[0].current_revision)
          await client.query(
            `update personal_notes set lifecycle='deleted',deleted_at=now(),updated_at=now()
            where id=$1 and owner_user_id=$2 and lifecycle='active'`,
            [note.rows[0].note_id, ownerUserId]
          );
        const events = await client.query<{ id: string }>(
          `update memory_events event set invalidated_at=coalesce(event.invalidated_at,now()),
             invalidation_reason='source_event_deleted',updated_at=now()
           from personal_note_revisions revision
          where revision.id=$1 and revision.owner_user_id=$2
            and revision.memory_event_id=event.id and event.owner_user_id=$2
            and event.visibility='personal' returning event.id`,
          [noteRevisionId, ownerUserId]
        );
        await invalidateDerivedMemoryForMemoryEvents(
          client,
          events.rows.map((event) => event.id)
        );
        await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
          client,
          { userId: ownerUserId },
          options.envelopeEncryptionProvider
        );
        await client.query(
          `delete from encrypted_field_payloads
          where owner_user_id=$1 and source_table='personal_note_revisions'
            and source_id=$2 and source_column='body'`,
          [ownerUserId, noteRevisionId]
        );
        await client.query(
          `delete from encrypted_field_payloads
          where owner_user_id=$1 and source_table='project_source_revisions'
            and source_id=$2 and source_column='original_binary'`,
          [ownerUserId, note.rows[0].attempt_id]
        );
        if (note.rows[0].revision === note.rows[0].current_revision)
          await client.query(
            `delete from encrypted_field_payloads
            where owner_user_id=$1 and source_table='personal_notes' and source_id=$2 and source_column='title'`,
            [ownerUserId, note.rows[0].note_id]
          );
        await client.query(`select pg_notify('koed_graph_updates',$1)`, [
          JSON.stringify({
            table: "personal_notes",
            operation: "UPDATE",
            id: note.rows[0].note_id,
            ownerUserId,
            visibility: "personal",
            changedAt: new Date().toISOString()
          })
        ]);
        return true;
      });
    },
    // Trusted runtime producer only. A renderer/API client cannot call this.
    async recordTrustedUse(input: {
      ownerUserId: string;
      projectId: string;
      sourceId: string;
      capturedSessionId: string;
      turnId: string;
      provenance: "citation" | "tool_read";
    }) {
      return transaction(async (client) => {
        await project(client, input.ownerUserId, input.projectId, true);
        const source = await client.query<Row>(
          `select id from project_sources where owner_user_id=$1 and project_id=$2 and id=$3 and deleted_at is null for update`,
          [input.ownerUserId, input.projectId, input.sourceId]
        );
        if (!source.rows[0])
          throw new ProjectNotFoundError("Project Source not found");
        const session = await client.query(
          `select 1 from sessions where owner_user_id=$1 and id=$2 and visibility='personal'
             and personal_deleted_at is null and trashed_at is null and invalidated_at is null
             and (case when project_override_id is not null then project_override_personal_project_id
                       else automatic_personal_project_id end)=$3`,
          [input.ownerUserId, input.capturedSessionId, input.projectId]
        );
        if (!session.rows[0])
          throw new ProjectCapabilityError(
            "Trusted turn does not belong to the Project"
          );
        const inserted = await client.query(
          `insert into project_source_turn_uses(owner_user_id,source_id,captured_session_id,turn_id,provenance)
           values($1,$2,$3,$4,$5) on conflict do nothing returning source_id`,
          [
            input.ownerUserId,
            input.sourceId,
            input.capturedSessionId,
            input.turnId,
            input.provenance
          ]
        );
        if (inserted.rows[0])
          await client.query(
            `update project_sources set uses=uses+1,updated_at=now() where owner_user_id=$1 and id=$2`,
            [input.ownerUserId, input.sourceId]
          );
        return Boolean(inserted.rows[0]);
      });
    }
  };
};
export type ProjectSourceRepository = ReturnType<
  typeof createProjectSourceRepository
>;
