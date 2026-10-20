import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryQuestionRepository } from "../src/memory-question-repository.js";
import { runDbMigrations } from "../src/migrate.js";

const databaseUrl = process.env.HQ306_PERSONAL_CITATION_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "current Personal managed citation detail",
  () => {
    let pool: pg.Pool;
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    );
    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("reads current owned source content and denies stale or forgotten sources", async () => {
      const repository = createMemoryQuestionRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const ownerId = randomUUID();
      const otherOwnerId = randomUUID();
      const sessionId = randomUUID();
      const nodeId = randomUUID();
      const otherNodeId = randomUUID();
      const eventId = randomUUID();
      const messageId = randomUUID();
      const itemId = randomUUID();
      const assertionId = randomUUID();
      await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
        ownerId,
        `${ownerId}@example.test`,
        otherOwnerId,
        `${otherOwnerId}@example.test`
      ]);
      await pool.query(
        `insert into sessions(id,owner_user_id,source_runtime,capture_method)
       values($1,$2,'codex','api')`,
        [sessionId, ownerId]
      );
      await pool.query(
        `insert into memory_nodes(id,owner_user_id,visibility,kind,summary_text,capture_method,session_id)
       values($1,$2,'personal','leaf','Current node summary','api',$3)`,
        [nodeId, ownerId, sessionId]
      );
      await pool.query(
        `insert into memory_nodes(id,owner_user_id,visibility,kind,summary_text,capture_method)
       values($1,$2,'personal','leaf','Other owner summary','api')`,
        [otherNodeId, otherOwnerId]
      );
      await pool.query(
        `insert into memory_events(id,owner_user_id,visibility,event_type,capture_method,session_id,payload)
       values($1,$2,'personal','captured','api',$3,$4::jsonb)`,
        [
          eventId,
          ownerId,
          sessionId,
          JSON.stringify({ content: "Current event content" })
        ]
      );
      await pool.query(
        `insert into messages(id,session_id,owner_user_id,visibility,role,content,source_runtime,capture_method)
       values($1,$2,$3,'personal','user','Current message content','codex','api')`,
        [messageId, sessionId, ownerId]
      );
      await pool.query(
        `insert into conversation_items
       (id,owner_user_id,visibility,session_id,source_kind,source_adapter_version,
        source_transport,source_record_type,raw_json,source_hash,idempotency_key,canonical_item_key)
       values($1,$2,'personal',$3,'test','1','api','message','{}'::jsonb,$4,$5,$6)`,
        [itemId, ownerId, sessionId, "a".repeat(64), randomUUID(), randomUUID()]
      );
      await pool.query(
        `insert into curated_memory_assertions
       (id,owner_user_id,visibility,assertion_text,normalized_assertion,status,kind)
       values($1,$2,'personal','Current decision','current decision','current','decision')`,
        [assertionId, ownerId]
      );
      await pool.query(
        `insert into curated_memory_sources
       (assertion_id,source_type,source_role,conversation_item_id)
       values($1,'conversation_item','primary_evidence',$2)`,
        [assertionId, itemId]
      );
      const sourceIds = [assertionId, nodeId, eventId, messageId, otherNodeId];
      const sourceTypes = [
        "curated_memory",
        "memory_node",
        "memory_event",
        "message",
        "memory_node"
      ];
      const question = await repository.createFinalMemoryQuestion(
        { userId: ownerId },
        {
          idempotencyKey: randomUUID(),
          query: "What do you know?",
          searchDomain: "global",
          status: "answered",
          answerMarkdown: "Retained answer",
          citations: sourceIds.map((sourceId, index) => ({
            sourceType: sourceTypes[index],
            sourceId,
            title: "Stale question snapshot"
          }))
        }
      );
      const detail = (ordinal: number, userId = ownerId) =>
        repository.getManagedPersonalQuestionCitation(
          { userId },
          { questionId: question.id, ordinal }
        );
      expect((await detail(0))?.title).toBe("Current decision");
      expect((await detail(0))?.kind).toBe("decision");
      expect((await detail(1))?.summary).toBe("Current node summary");
      expect((await detail(2))?.summary).toBe("Current event content");
      expect((await detail(3))?.summary).toBe("Current message content");
      expect((await detail(3))?.messageLink).toBeNull();
      expect(await detail(4)).toBeNull();
      expect(await detail(0, otherOwnerId)).toBeNull();
      const teamId = randomUUID();
      const teamWorkspaceId = randomUUID();
      await pool.query("insert into teams(id,name) values($1,'Legacy Team')", [
        teamId
      ]);
      await pool.query(
        "insert into team_workspaces(id,team_id,name) values($1,$2,'Legacy Workspace')",
        [teamWorkspaceId, teamId]
      );
      await pool.query(
        "update memory_questions set team_workspace_id=$2 where id=$1",
        [question.id, teamWorkspaceId]
      );
      expect(await detail(1)).toBeNull();
      await pool.query(
        "update memory_questions set team_workspace_id=null where id=$1",
        [question.id]
      );
      const originalQuestion = repository.getMemoryQuestionForManagedCitation;
      const ordinaryQuestion = await originalQuestion(
        { userId: ownerId },
        question.id
      );
      repository.getMemoryQuestionForManagedCitation = async () =>
        ordinaryQuestion
          ? {
              ...ordinaryQuestion,
              retrievalScope: "team" as never,
              teamAuthorized: false
            }
          : null;
      expect(await detail(1)).toBeNull();
      repository.getMemoryQuestionForManagedCitation = originalQuestion;
      for (const column of ["delete_batch_id", "forget_batch_id"] as const) {
        await pool.query(`update sessions set ${column}=$2 where id=$1`, [
          sessionId,
          randomUUID()
        ]);
        expect(await detail(1)).toBeNull();
        expect(await detail(2)).toBeNull();
        expect(await detail(3)).toBeNull();
        await pool.query(`update sessions set ${column}=null where id=$1`, [
          sessionId
        ]);
        expect((await detail(1))?.summary).toBe("Current node summary");
        expect((await detail(2))?.summary).toBe("Current event content");
        expect((await detail(3))?.summary).toBe("Current message content");
      }
      await pool.query(
        "update memory_nodes set summary_text='Updated node summary' where id=$1",
        [nodeId]
      );
      expect((await detail(1))?.summary).toBe("Updated node summary");
      await pool.query(
        "update curated_memory_assertions set status='suppressed',suppressed_at=now() where id=$1",
        [assertionId]
      );
      expect(await detail(0)).toBeNull();
      await pool.query(
        "update memory_nodes set personal_deleted_at=now() where id=$1",
        [nodeId]
      );
      expect(await detail(1)).toBeNull();
      await pool.query(
        "update sessions set personal_deleted_at=now() where id=$1",
        [sessionId]
      );
      expect(await detail(2)).toBeNull();
      expect(await detail(3)).toBeNull();
    });
  }
);
