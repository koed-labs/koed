import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCollaborationRepository,
  createMemorySourceRepository,
  createProjectApiRepository,
  createProjectSourceRepository,
  createProjectSourceRemovalRepository,
  createSharedMemoryRepository,
  runDbMigrations
} from "@koed/db";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  personalDesktopNoteSchema
} from "@koed/shared";
import { createProjectSourceIngestionService } from "./source-ingestion-service.js";
import { extractProjectSourceTextBounded } from "@koed/worker/project-source-extractor-client";
import { projectPersonalNoteToMemory } from "../collaboration/personal-note-memory.js";

const testUrl =
  process.env.KOED_HQ209_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
describe.skipIf(!testUrl)("Project Source real Note ingestion", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const owner = randomUUID();
  const other = randomUUID();
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64url")
  );
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq209_ingest_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query(`insert into users(id,email) values($1,$2),($3,$4)`, [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    await pool.query(
      `insert into deployment_identities(protocol_deployment_id,locality,profile)
      values($1,'local','developer')`,
      [randomUUID()]
    );
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database ${quote(database)}`);
    await admin?.end();
  });

  it("encrypts an exact 25 MiB original and rejects oversized or noncanonical bytes", async () => {
    const projects = createProjectApiRepository(pool);
    const sources = createProjectSourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const project = await projects.create(owner, {
      name: "Maximum original proof",
      idempotencyKey: "maximum-original-proof"
    });
    const original = Buffer.alloc(25 * 1024 * 1024, 65);
    const input = {
      name: "Maximum.txt",
      mediaType: "text/plain",
      bytesBase64: original.toString("base64"),
      idempotencyKey: "maximum-original"
    };
    const uploaded = await sources.uploadDocument(owner, project.id, input);
    expect(uploaded.attempt.byteLength).toBe(original.length);
    const claimed = await sources.claimDocumentAttempt();
    expect(claimed?.id).toBe(uploaded.attempt.id);
    expect(claimed?.bytes.equals(original)).toBe(true);
    await expect(
      sources.uploadDocument(owner, project.id, {
        ...input,
        name: "Too-large.txt",
        idempotencyKey: "too-large-original",
        bytesBase64: Buffer.alloc(original.length + 1, 65).toString("base64")
      })
    ).rejects.toThrow("exceeds 25 MB");
    for (const bytesBase64 of ["YQ=", "YQ=$", "YR=="]) {
      await expect(
        sources.uploadDocument(owner, project.id, {
          ...input,
          name: "Malformed.txt",
          idempotencyKey: randomUUID(),
          bytesBase64
        })
      ).rejects.toThrow("canonical base64");
    }
  }, 120_000);

  it("ingests real PDF/DOCX and >32 KiB text into one event per actual Note revision", async () => {
    const projects = createProjectApiRepository(pool);
    const sources = createProjectSourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const collaboration = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const memory = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const project = await projects.create(owner, {
      name: "Source proof",
      idempotencyKey: "hq209-proof"
    });
    const ingest = async (name: string, bytes: Buffer, key: string) => {
      const uploaded = await sources.uploadDocument(owner, project.id, {
        name,
        mediaType: "application/octet-stream",
        bytesBase64: bytes.toString("base64"),
        idempotencyKey: key
      });

      const service = createProjectSourceIngestionService({
        repository: sources,
        intervalMs: 3_600_000,
        projectNote: async ({ ownerUserId, note }) => {
          await projectPersonalNoteToMemory(
            {
              repository: { ...memory, ...collaboration },
              enqueueEmbedding: async () => ({
                queued: false,
                inline: false,
                reason: "test"
              })
            },
            { ownerUserId, note }
          );
        }
      });
      await service.runNow();
      await service.close();
      const current = (await sources.list(owner, project.id)).find(
        (source) => source.id === uploaded.source.id
      )!;
      expect(current.status, current.failureReason ?? "unknown failure").toBe(
        "ready"
      );
      const read = await sources.readDocument(owner, project.id, current.id);
      expect(read.text.length).toBeGreaterThan(0);
      const note = await collaboration.getPersonalNote(
        { userId: owner },
        { noteId: read.noteId }
      );
      expect(note?.revisionId).toBe(read.noteRevisionId);
      expect(note?.body).toBe(read.text);
      expect(
        personalDesktopNoteSchema.parse({ ...note, event: null }).body
      ).toBe(read.text);
      await expect(
        sources.readDocument(other, project.id, current.id)
      ).rejects.toThrow();
      const again = await sources.uploadDocument(owner, project.id, {
        name,
        mediaType: "application/octet-stream",
        bytesBase64: bytes.toString("base64"),
        idempotencyKey: key
      });
      expect(again.attempt.id).toBe(uploaded.attempt.id);
      return read;
    };
    const fixture = async (name: string) =>
      readFile(
        fileURLToPath(
          new URL(`../../../worker/test-fixtures/${name}`, import.meta.url)
        )
      );
    expect(
      await extractProjectSourceTextBounded({
        name: "Syllabus.pdf",
        bytes: await fixture("Syllabus.pdf")
      })
    ).toContain("Course syllabus");
    await ingest("Syllabus.pdf", await fixture("Syllabus.pdf"), "pdf-one");
    await ingest("Plan.docx", await fixture("Plan.docx"), "docx-one");
    const body = Buffer.from(
      "HQ-209 verified sentence.\n".repeat(2_000),
      "utf8"
    );
    const first = await ingest("Notes.txt", body, "text-one");
    expect(first.text.length).toBeGreaterThan(32_768);
    const second = await ingest(
      "Notes.txt",
      Buffer.from(`${body.toString("utf8")}revision two`),
      "text-two"
    );
    expect(second.noteId).toBe(first.noteId);
    expect(second.noteRevisionId).not.toBe(first.noteRevisionId);
    const events = await pool.query<{
      id: string;
      invalidated_at: Date | null;
    }>(
      `select event.id,event.invalidated_at from personal_note_revisions revision
         join memory_events event on event.id=revision.memory_event_id
        where revision.note_id=$1 order by revision.revision`,
      [first.noteId]
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]!.invalidated_at).not.toBeNull();
    expect(events.rows[1]!.invalidated_at).toBeNull();
    const recalled = await memory.getPersonalNoteRevisionMemoryEvent(
      { userId: owner },
      { noteId: second.noteId, revision: 2 }
    );
    expect(recalled?.content).toBe(second.text);
    expect(
      await memory.getPersonalNoteRevisionMemoryEvent(
        { userId: other },
        { noteId: second.noteId, revision: 2 }
      )
    ).toBeNull();
    await expect(
      memory.createMemoryEvent(
        { userId: owner },
        {
          projectId: "unassigned",
          actor: "user",
          eventType: "captured",
          rawEventType: "personal_note_revision",
          content: "forged different body",
          metadata: {
            semanticUnitType: "personal_note",
            sourceAdapterVersion: "project-sources-v1",
            projectSourceRevisionId: second.sourceRevisionId,
            personalNoteId: second.noteId,
            personalNoteRevisionId: second.noteRevisionId,
            personalNoteRevision: 2,
            personalNoteContentHash: (await collaboration.getPersonalNote(
              { userId: owner },
              { noteId: second.noteId }
            ))!.contentHash
          },
          visibility: "personal",
          captureMethod: "api"
        }
      )
    ).rejects.toThrow("binding");
    const staleNote = (await collaboration.getPersonalNote(
      { userId: owner },
      { noteId: second.noteId }
    ))!;
    const forgot = await sources.forgetDocumentNoteRevision(
      owner,
      second.noteRevisionId
    );
    expect(forgot).toBe(true);
    let staleEnqueues = 0;
    await expect(
      projectPersonalNoteToMemory(
        {
          repository: { ...memory, ...collaboration },
          enqueueEmbedding: async () => {
            staleEnqueues += 1;
            return { queued: false, inline: false, reason: "test" };
          }
        },
        { ownerUserId: owner, note: staleNote }
      )
    ).rejects.toThrow("binding");
    expect(staleEnqueues).toBe(0);
    await expect(
      sources.readDocument(owner, project.id, second.sourceId)
    ).rejects.toThrow();
    expect(
      await collaboration.getPersonalNote(
        { userId: owner },
        { noteId: second.noteId }
      )
    ).toBeNull();
    expect(
      await memory.getPersonalNoteRevisionMemoryEvent(
        { userId: owner },
        { noteId: second.noteId, revision: 2 }
      )
    ).toBeNull();
    const erased = await pool.query(
      `select 1 from encrypted_field_payloads where source_table='project_source_revisions'
      and source_id=$1 and invalidated_at is null`,
      [second.sourceRevisionId]
    );
    expect(erased.rowCount).toBe(0);
    const older = await pool.query(
      `select 1 from encrypted_field_payloads where source_table='project_source_revisions'
      and source_id=$1 and invalidated_at is null`,
      [first.sourceRevisionId]
    );
    expect(older.rowCount).toBe(1);
    const longRun = await ingest(
      "Long-run.txt",
      Buffer.from("a".repeat(32_768)),
      "long-run-one"
    );
    expect(longRun.text).toHaveLength(32_768);
    const boundedCounter = await pool.query<{ token_counter: string }>(
      `select event.token_counter from personal_note_revisions revision
         join memory_events event on event.id=revision.memory_event_id
        where revision.id=$1`,
      [longRun.noteRevisionId]
    );
    expect(boundedCounter.rows[0]?.token_counter).toContain("heuristic");
    await pool.query(
      `update encrypted_field_payloads set invalidated_at=now()
      where source_table='personal_note_revisions' and source_id=$1
        and source_column='body'`,
      [longRun.noteRevisionId]
    );
    const titleOnlyPage = await collaboration.listPersonalNotes({
      userId: owner
    });
    const longRunSummary = titleOnlyPage.notes.find(
      (note) => note.noteId === longRun.noteId
    );
    expect(longRunSummary).toMatchObject({ noteId: longRun.noteId });
    expect(longRunSummary).not.toHaveProperty("body");
    const crashUpload = await sources.uploadDocument(owner, project.id, {
      name: "Recovery.txt",
      mediaType: "text/plain",
      bytesBase64: Buffer.from(
        "Recover the same projected Note event."
      ).toString("base64"),
      idempotencyKey: "recovery-one"
    });
    let embeddingCalls = 0;
    let failAfterProjection = true;
    const recoveryService = createProjectSourceIngestionService({
      repository: sources,
      intervalMs: 3_600_000,
      projectNote: async ({ ownerUserId, note }) => {
        await projectPersonalNoteToMemory(
          {
            repository: { ...memory, ...collaboration },
            enqueueEmbedding: async () => {
              embeddingCalls += 1;
              return { queued: false, inline: false, reason: "test" };
            }
          },
          { ownerUserId, note }
        );
        if (failAfterProjection) {
          failAfterProjection = false;
          throw new Error("simulated crash after projection");
        }
      },
      onError: () => undefined
    });
    await recoveryService.runNow();
    await pool.query(
      `update project_source_revisions set updated_at=now()-interval '3 minutes'
      where id=$1`,
      [crashUpload.attempt.id]
    );
    await recoveryService.runNow();
    await recoveryService.close();
    expect(embeddingCalls).toBe(2);
    const recoveryRead = await sources.readDocument(
      owner,
      project.id,
      crashUpload.source.id
    );
    const recoveryEvents = await pool.query(
      `select event.id from personal_note_revisions revision
         join memory_events event on event.id=revision.memory_event_id
        where revision.id=$1`,
      [recoveryRead.noteRevisionId]
    );
    expect(recoveryEvents.rowCount).toBe(1);
    const trashFirst = await ingest(
      "Trash.txt",
      Buffer.from("Forget after Source trash."),
      "trash-one"
    );
    const sentinelSessionId = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
         automatic_personal_project_id)
       values($1,$2,'codex-cli','api',$3)`,
      [sentinelSessionId, owner, project.id]
    );
    const removals = createProjectSourceRemovalRepository(pool);
    const removal = await removals.begin(
      owner,
      project.id,
      trashFirst.sourceId
    );
    await removals.complete(
      owner,
      project.id,
      trashFirst.sourceId,
      removal.batchId
    );
    expect(
      (await removals.latest(owner, project.id, trashFirst.sourceId))?.state
    ).toBe("complete");
    const retainedSession = await pool.query<{
      personal_deleted_at: Date | null;
    }>("select personal_deleted_at from sessions where id=$1", [
      sentinelSessionId
    ]);
    expect(retainedSession.rows[0]?.personal_deleted_at).toBeNull();
    for (const noteId of [trashFirst.noteId, recoveryRead.noteId]) {
      const oneNoteAndEvent = await pool.query<{
        revisions: number;
        events: number;
      }>(
        `select count(distinct revision.id)::int as revisions,
                count(distinct event.id)::int as events
           from personal_note_revisions revision
           left join memory_events event on event.id=revision.memory_event_id
          where revision.note_id=$1`,
        [noteId]
      );
      expect(oneNoteAndEvent.rows[0]).toEqual({ revisions: 1, events: 1 });
    }
    expect(
      await sources.forgetDocumentNoteRevision(owner, trashFirst.noteRevisionId)
    ).toBe(true);
    const cancelSource = await ingest(
      "Cancel.txt",
      Buffer.from("Retain through cancel."),
      "cancel-one"
    );
    const reservation = await removals.begin(
      owner,
      project.id,
      cancelSource.sourceId
    );
    expect(
      (await removals.begin(owner, project.id, cancelSource.sourceId)).batchId
    ).toBe(reservation.batchId);
    await expect(
      sources.uploadDocument(owner, project.id, {
        name: "Cancel.txt",
        mediaType: "text/plain",
        bytesBase64: Buffer.from("new content").toString("base64"),
        idempotencyKey: "cancel-two"
      })
    ).rejects.toThrow("pending");
    await removals.requestCancel(
      owner,
      project.id,
      cancelSource.sourceId,
      reservation.batchId
    );
    await expect(
      sources.uploadDocument(owner, project.id, {
        name: "Cancel.txt",
        mediaType: "text/plain",
        bytesBase64: Buffer.from("new content").toString("base64"),
        idempotencyKey: "cancel-two"
      })
    ).rejects.toThrow("pending");
    await removals.cancel(
      owner,
      project.id,
      cancelSource.sourceId,
      reservation.batchId
    );
    const afterCancel = await sources.uploadDocument(owner, project.id, {
      name: "Cancel.txt",
      mediaType: "text/plain",
      bytesBase64: Buffer.from("new content").toString("base64"),
      idempotencyKey: "cancel-two"
    });
    expect(afterCancel.attempt.id).not.toBe(cancelSource.sourceRevisionId);
    await ingest("Cancel.txt", Buffer.from("new content"), "cancel-two");
    const projectFirst = await ingest(
      "Project.txt",
      Buffer.from("Forget after Project delete."),
      "project-one"
    );
    const beforeDelete = await projects.get(owner, project.id);
    const preview = await projects.deletePreview(owner, project.id);
    const batchId = randomUUID();
    await projects.beginDelete(owner, project.id, {
      version: beforeDelete.version,
      batchId,
      executionSetHash: preview.executionSetHash
    });
    await projects.markDeleteReady(owner, project.id, batchId);
    await projects.completeDelete(owner, project.id, batchId);
    expect(
      await sources.forgetDocumentNoteRevision(
        owner,
        projectFirst.noteRevisionId
      )
    ).toBe(true);
    const deleted = await projects.get(owner, project.id);
    await projects.restore(owner, project.id, {
      version: deleted.version,
      batchId
    });
    await expect(
      sources.readDocument(owner, project.id, projectFirst.sourceId)
    ).rejects.toThrow();
  }, 120_000);

  it("holds, seals, and cancels admission for an exact owner Note root, even after forget", async () => {
    const projects = createProjectApiRepository(pool);
    const sources = createProjectSourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const collaboration = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const memory = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const project = await projects.create(owner, {
      name: "Note admission proof",
      idempotencyKey: "note-admission-proof"
    });
    const uploaded = await sources.uploadDocument(owner, project.id, {
      name: "Bound.txt",
      mediaType: "text/plain",
      bytesBase64: Buffer.from("Exact Note admission root.").toString("base64"),
      idempotencyKey: "note-admission-source"
    });
    const service = createProjectSourceIngestionService({
      repository: sources,
      intervalMs: 3_600_000,
      projectNote: async ({ ownerUserId, note }) => {
        await projectPersonalNoteToMemory(
          {
            repository: { ...memory, ...collaboration },
            enqueueEmbedding: async () => ({
              queued: false,
              inline: false,
              reason: "test"
            })
          },
          { ownerUserId, note }
        );
      }
    });
    await service.runNow();
    await service.close();
    const read = await sources.readDocument(
      owner,
      project.id,
      uploaded.source.id
    );
    const note = (await collaboration.getPersonalNote(
      { userId: owner },
      { noteId: read.noteId }
    ))!;
    const root = note.logicalMemoryId;
    const deployment = await pool.query<{ protocol_deployment_id: string }>(
      "select protocol_deployment_id from deployment_identities where locality='local' limit 1"
    );
    const protocolDeploymentId = deployment.rows[0]!.protocol_deployment_id;
    const deviceCredentialId = randomUUID();
    await pool.query(
      `insert into device_credentials
      (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
       verifier_kind,verifier_hash,operation_families,metadata)
      values($1,$2,$3,'team-note-proof',$4,'secret_hash',$5,
        array['share_grant_management'],$6::jsonb)`,
      [
        deviceCredentialId,
        owner,
        `hq209-${randomUUID()}`,
        randomUUID(),
        "a".repeat(64),
        JSON.stringify({ protocolDeploymentId, sourceOwnerPrincipalId: owner })
      ]
    );
    const shared = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: async () => {
        throw new Error("unused");
      },
      resolveOwnerPrivateReplicaEncryptionProvider: async () => {
        throw new Error("unused");
      },
      resolvePersonalEncryptionProvider: async () => {
        throw new Error("unused");
      }
    });
    const source = {
      kind: "personal_note" as const,
      noteId: read.noteId,
      noteRevision: note.revision,
      memoryEventId: note.memoryEventId!,
      logicalMemoryId: root
    };
    const provenance = {
      source,
      sourceDeploymentProtocolId: protocolDeploymentId,
      sourceOwnerPrincipalId: owner,
      deviceCredentialId
    };
    expect(
      await shared.inspectSourceAdmissionProvenance(
        { userId: owner },
        provenance
      )
    ).toBe(true);
    await expect(
      shared.inspectSourceAdmissionProvenance({ userId: other }, provenance)
    ).rejects.toThrow();
    await expect(
      shared.inspectSourceAdmissionProvenance(
        { userId: owner },
        {
          ...provenance,
          source: { ...source, noteId: randomUUID() }
        }
      )
    ).rejects.toThrow();
    const firstBatch = randomUUID();
    const held = await shared.changeSourceAdmission(
      { userId: owner },
      {
        ...provenance,
        logicalMemoryId: root,
        batchId: firstBatch,
        expectedGeneration: 0,
        expectedHoldVersion: 0,
        operation: "prepare"
      }
    );
    expect(held).toMatchObject({
      generation: 1,
      holdVersion: 1,
      heldBatchId: firstBatch,
      activeUnfrozenGrants: 0
    });
    const sealed = await shared.changeSourceAdmission(
      { userId: owner },
      {
        ...provenance,
        logicalMemoryId: root,
        batchId: firstBatch,
        expectedGeneration: 1,
        expectedHoldVersion: 1,
        operation: "seal"
      }
    );
    expect(sealed).toMatchObject({ sealed: true, holdVersion: 2 });
    const canceled = await shared.changeSourceAdmission(
      { userId: owner },
      {
        ...provenance,
        logicalMemoryId: root,
        batchId: firstBatch,
        expectedGeneration: 1,
        expectedHoldVersion: 2,
        operation: "cancel"
      }
    );
    expect(canceled).toMatchObject({ heldBatchId: null, holdVersion: 3 });
    await sources.forgetDocumentNoteRevision(owner, read.noteRevisionId);
    expect(
      await shared.inspectSourceAdmissionProvenance(
        { userId: owner },
        provenance
      )
    ).toBe(true);
    const secondBatch = randomUUID();
    const afterForget = await shared.changeSourceAdmission(
      { userId: owner },
      {
        ...provenance,
        logicalMemoryId: root,
        batchId: secondBatch,
        expectedGeneration: 1,
        expectedHoldVersion: 3,
        operation: "prepare"
      }
    );
    expect(afterForget).toMatchObject({ heldBatchId: secondBatch });
    await shared.changeSourceAdmission(
      { userId: owner },
      {
        ...provenance,
        logicalMemoryId: root,
        batchId: secondBatch,
        expectedGeneration: afterForget.generation,
        expectedHoldVersion: afterForget.holdVersion,
        operation: "cancel"
      }
    );
  });
});
