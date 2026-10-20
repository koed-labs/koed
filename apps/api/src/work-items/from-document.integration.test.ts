import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  storeDesktopLocalCredential
} from "@koed/shared";
import {
  runDbMigrations,
  createManagedConversationRepository,
  createProjectSourceRepository,
  createWorkItemRepository,
  createCollaborationRepository,
  createMemorySourceRepository
} from "@koed/db";
import { projectPersonalNoteToMemory } from "../collaboration/personal-note-memory.js";
import { registerWorkItemsFromDocumentRoutes } from "./from-document-routes.js";

const testUrl = process.env.KOED_HQ406_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)(
  "Document Work Items from real Personal Notes",
  () => {
    let admin: pg.Pool;
    let pool: pg.Pool;
    let database: string;
    const owner = randomUUID();
    const other = randomUUID();
    const projectId = randomUUID();
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    );
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: testUrl });
      database = `hq406_${randomUUID().replaceAll("-", "")}`;
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
        `insert into projects(id,owner_user_id,name,key) values($1,$2,'Syllabus','CLASS')`,
        [projectId, owner]
      );
      await pool.query(
        `insert into deployment_identities(protocol_deployment_id,locality,profile)
      values($1,'local','developer')`,
        [randomUUID()]
      );
      await pool.query(
        `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name,enabled)
      values($1,'codex.syllabus','codex','Syllabus',true)`,
        [owner]
      );
    }, 120_000);
    afterAll(async () => {
      await pool?.end();
      if (admin && database)
        await admin.query(`drop database if exists ${quote(database)}`);
      await admin?.end();
    });

    it("uses exact non-checkbox syllabus evidence, preserves duplicates across changed revisions, and denies stale lease", async () => {
      const sources = createProjectSourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const items = createWorkItemRepository(pool);
      const managed = createManagedConversationRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const source = await sources.uploadDocument(owner, projectId, {
        name: "Syllabus.txt",
        mediaType: "text/plain",
        bytesBase64: Buffer.from(
          "Seminar paper due 22 Oct 2026\nPrepare lab report by 30 Oct 2026"
        ).toString("base64"),
        idempotencyKey: randomUUID()
      });
      const claim = await sources.claimDocumentAttempt();
      expect(claim?.id).toBe(source.attempt.id);
      const note = await sources.completeDocumentAttempt({
        ownerUserId: owner,
        attemptId: claim!.id,
        leaseGeneration: claim!.leaseGeneration,
        text: "Seminar paper due 22 Oct 2026\nPrepare lab report by 30 Oct 2026"
      });
      await projectPersonalNoteToMemory(
        {
          repository: {
            ...createMemorySourceRepository(pool, {
              envelopeEncryptionProvider: provider
            }),
            ...createCollaborationRepository(pool, {
              envelopeEncryptionProvider: provider
            })
          },
          enqueueEmbedding: async () => ({
            queued: false,
            inline: false,
            reason: "test"
          })
        },
        { ownerUserId: owner, note: note.note }
      );
      await sources.finishDocumentAttempt({
        ownerUserId: owner,
        attemptId: claim!.id,
        leaseGeneration: claim!.leaseGeneration
      });
      const read = await sources.readDocument(
        owner,
        projectId,
        source.source.id
      );
      expect(read.noteRevisionId).toBe(note.note.revisionId);
      await expect(
        sources.readDocument(other, projectId, source.source.id)
      ).rejects.toThrow();
      const created = await managed.createManagedConversation(
        { userId: owner },
        {
          projectId,
          contextKind: "project",
          provider: "codex",
          aiClientInstanceId: "codex.syllabus",
          model: "gpt-test",
          permissionMode: "supervised",
          runnerKind: "local_device",
          runnerDeploymentId: randomUUID(),
          runnerDeviceId: randomUUID(),
          idempotencyKey: randomUUID(),
          initialPrompt: "Make Work Items from the syllabus"
        }
      );
      const leaseToken = randomUUID();
      await pool.query(
        `update managed_conversation_commands set state='dispatching',lease_token=$2,
      lease_expires_at=now()+interval '2 minutes',blocked_on_kind=null,blocked_on_id=null where id=$1`,
        [created.command.id, leaseToken]
      );
      const request = {
        ownerUserId: owner,
        projectId,
        sourceId: source.source.id,
        sourceRevisionId: read.sourceRevisionId,
        noteRevisionId: read.noteRevisionId,
        sourceText: read.text,
        executionId: created.execution.id,
        executionGeneration: created.execution.executionGeneration,
        commandId: created.command.id,
        leaseToken,
        proposals: [
          {
            lineNumber: 1,
            sourceLine: "Seminar paper due 22 Oct 2026",
            title: "Write seminar paper",
            goal: "Complete the seminar paper",
            dueOn: "2026-10-22"
          }
        ]
      };
      const first = await items.createFromDocument(request);
      expect(first).toMatchObject({ created: 1, alreadyExisting: 0 });
      expect(first.items[0]).toMatchObject({
        kind: "todo",
        title: "Write seminar paper",
        origin: "plan",
        dueOn: "2026-10-22"
      });
      const rerun = await items.createFromDocument({
        ...request,
        proposals: [
          {
            ...request.proposals[0]!,
            title: "Different AI title",
            goal: "Different AI goal"
          }
        ]
      });
      expect(rerun).toMatchObject({ created: 0, alreadyExisting: 1 });
      expect(rerun.items[0]?.id).toBe(first.items[0]?.id);
      // A concurrent human prompt owns this execution before it reads the
      // Project. Document apply must release its Project lock immediately,
      // rather than deadlock while waiting in the opposite order.
      const concurrentPrompt = await pool.connect();
      try {
        await concurrentPrompt.query("begin");
        await concurrentPrompt.query(
          "select id from managed_conversation_executions where id=$1 for update",
          [request.executionId]
        );
        await expect(items.createFromDocument(request)).rejects.toThrow(
          "Agent command is busy"
        );
        expect(
          (
            await concurrentPrompt.query(
              "select count(*)::int as count from project_work_items where project_id=$1",
              [projectId]
            )
          ).rows[0]?.count
        ).toBe(1);
      } finally {
        await concurrentPrompt.query("rollback");
        concurrentPrompt.release();
      }
      expect(await items.createFromDocument(request)).toMatchObject({
        created: 0,
        alreadyExisting: 1
      });
      const home = mkdtempSync(join(tmpdir(), "hq406-api-"));
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write",
          "managed_execution"
        ]
      });
      const app = Fastify();
      registerWorkItemsFromDocumentRoutes(app, {
        managed: createMemorySourceRepository(pool, {
          envelopeEncryptionProvider: provider
        }),
        sources,
        items,
        auth: {} as never,
        deploymentProfile: "developer",
        koedHome: home,
        readRateLimit: async () => undefined,
        writeRateLimit: async () => undefined
      } as never);
      try {
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const url = `${address}/v1/managed-conversations/${created.execution.id}/work-items-from-doc`;
        const discovered = await fetch(
          `${url}/list?executionGeneration=${request.executionGeneration}&cursor=0`,
          { headers: { authorization: credential.authorization } }
        );
        expect(discovered.status).toBe(200);
        expect(await discovered.json()).toEqual({
          documents: [
            {
              sourceId: source.source.id,
              name: "Syllabus.txt",
              noteRevisionId: read.noteRevisionId
            }
          ],
          nextCursor: null
        });
        const staged = await fetch(
          `${url}/read?sourceId=${source.source.id}&executionGeneration=${request.executionGeneration}&cursor=0`,
          { headers: { authorization: credential.authorization } }
        );
        expect(staged.status).toBe(200);
        const page = (await staged.json()) as {
          sourceRevisionId: string;
          noteRevisionId: string;
          lines: Array<{ lineNumber: number; text: string }>;
        };
        expect(page).toMatchObject({
          sourceRevisionId: read.sourceRevisionId,
          noteRevisionId: read.noteRevisionId
        });
        expect(page.lines[0]).toEqual({
          lineNumber: 1,
          text: request.proposals[0]!.sourceLine
        });
        const applied = await fetch(`${url}/apply`, {
          method: "POST",
          headers: {
            authorization: credential.authorization,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            commandId: request.commandId,
            leaseToken,
            executionGeneration: request.executionGeneration,
            sourceId: request.sourceId,
            sourceRevisionId: request.sourceRevisionId,
            noteRevisionId: request.noteRevisionId,
            timeZone: "Europe/Oslo",
            proposals: [
              {
                lineNumber: 1,
                sourceLine: request.proposals[0]!.sourceLine,
                title: "Agent varies the title",
                goal: "Still the seminar paper",
                dueText: "22 Oct 2026"
              }
            ]
          })
        });
        expect(applied.status).toBe(200);
        expect(await applied.json()).toMatchObject({
          created: 0,
          alreadyExisting: 1
        });
        await pool.query(
          `update managed_conversation_commands set state='completed',lease_token=null,
             lease_expires_at=null where id=$1`,
          [created.command.id]
        );
        const active = await managed.enqueueManagedConversationPrompt(
          { userId: owner },
          {
            executionId: created.execution.id,
            executionGeneration: created.execution.executionGeneration,
            idempotencyKey: randomUUID(),
            clientUserMessageId: randomUUID(),
            prompt: "Turn Syllabus.txt into to-dos"
          }
        );
        const activeLease = randomUUID();
        await pool.query(
          `update managed_conversation_commands set state='dispatching',lease_token=$2,
             lease_expires_at=now()+interval '2 minutes',blocked_on_kind=null,
             blocked_on_id=null where id=$1`,
          [active.id, activeLease]
        );
        const activeList = await fetch(
          `${url}/list?executionGeneration=${request.executionGeneration}&cursor=0`,
          { headers: { authorization: credential.authorization } }
        );
        expect(activeList.status).toBe(200);
        expect((await activeList.json()).documents[0].sourceId).toBe(
          source.source.id
        );
        const activeRead = await fetch(
          `${url}/read?sourceId=${source.source.id}&executionGeneration=${request.executionGeneration}&cursor=0`,
          { headers: { authorization: credential.authorization } }
        );
        expect(activeRead.status).toBe(200);
        expect((await activeRead.json()).lines[0].text).toBe(
          request.proposals[0]!.sourceLine
        );
        const activeApply = await fetch(`${url}/apply`, {
          method: "POST",
          headers: {
            authorization: credential.authorization,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            commandId: active.id,
            leaseToken: activeLease,
            executionGeneration: request.executionGeneration,
            sourceId: request.sourceId,
            sourceRevisionId: request.sourceRevisionId,
            noteRevisionId: request.noteRevisionId,
            timeZone: "Europe/Oslo",
            proposals: [
              {
                lineNumber: 1,
                sourceLine: request.proposals[0]!.sourceLine,
                title: "A third AI title",
                goal: "Still the same task",
                dueText: "22 Oct 2026"
              }
            ]
          })
        });
        expect(activeApply.status).toBe(200);
        expect(await activeApply.json()).toMatchObject({
          created: 0,
          alreadyExisting: 1
        });
        await pool.query(
          `update managed_conversation_commands set
          lease_expires_at=now()-interval '1 second' where id=$1`,
          [active.id]
        );
        const staleList = await fetch(
          `${url}/list?executionGeneration=${request.executionGeneration}&cursor=0`,
          { headers: { authorization: credential.authorization } }
        );
        expect(staleList.status).toBe(409);
        await pool.query(
          `update managed_conversation_commands set
          lease_expires_at=now()+interval '2 minutes' where id=$1`,
          [active.id]
        );
        request.commandId = active.id;
        request.leaseToken = activeLease;
      } finally {
        await app.close();
        rmSync(home, { recursive: true, force: true });
      }
      await expect(
        items.createFromDocument({
          ...request,
          proposals: [{ ...request.proposals[0]!, sourceLine: "Invented task" }]
        })
      ).rejects.toThrow("evidence");
      await expect(
        items.createFromDocument({ ...request, ownerUserId: other })
      ).rejects.toThrow();
      await expect(
        items.createFromDocument({ ...request, sourceId: randomUUID() })
      ).rejects.toThrow("revision changed");
      const second = await sources.uploadDocument(owner, projectId, {
        name: "Syllabus.txt",
        mediaType: "text/plain",
        bytesBase64: Buffer.from(read.text).toString("base64"),
        idempotencyKey: randomUUID()
      });
      const newClaim = await sources.claimDocumentAttempt();
      expect(newClaim?.id).toBe(second.attempt.id);
      const newerNote = await sources.completeDocumentAttempt({
        ownerUserId: owner,
        attemptId: newClaim!.id,
        leaseGeneration: newClaim!.leaseGeneration,
        text: read.text
      });
      await projectPersonalNoteToMemory(
        {
          repository: {
            ...createMemorySourceRepository(pool, {
              envelopeEncryptionProvider: provider
            }),
            ...createCollaborationRepository(pool, {
              envelopeEncryptionProvider: provider
            })
          },
          enqueueEmbedding: async () => ({
            queued: false,
            inline: false,
            reason: "test"
          })
        },
        { ownerUserId: owner, note: newerNote.note }
      );
      await sources.finishDocumentAttempt({
        ownerUserId: owner,
        attemptId: newClaim!.id,
        leaseGeneration: newClaim!.leaseGeneration
      });
      await expect(items.createFromDocument(request)).rejects.toThrow(
        "revision changed"
      );
      const newRead = await sources.readDocument(
        owner,
        projectId,
        source.source.id
      );
      await sources.create(owner, projectId, {
        kind: "repo",
        name: "github.com/team/repo",
        uri: "github.com/team/repo"
      });
      const revised = await items.createFromDocument({
        ...request,
        sourceRevisionId: newRead.sourceRevisionId,
        noteRevisionId: newRead.noteRevisionId
      });
      expect(revised.created).toBe(1);
      expect(revised.items[0]).toMatchObject({
        kind: "ticket",
        key: "CLASS-1"
      });
      await pool.query(
        `update managed_conversation_commands set lease_expires_at=now()-interval '1 second' where id=$1`,
        [request.commandId]
      );
      await expect(
        items.createFromDocument({
          ...request,
          sourceRevisionId: newRead.sourceRevisionId,
          noteRevisionId: newRead.noteRevisionId
        })
      ).rejects.toThrow("lease");
    }, 120_000);
  }
);
