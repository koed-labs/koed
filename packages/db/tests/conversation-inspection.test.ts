import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.CONVERSATION_INSPECTION_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "Conversation inspection message metadata",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    }, 60_000);
    afterAll(async () => {
      await pool?.end();
    });

    it("preserves source identities across pages and ignores another owner's matching source key", async () => {
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `inspector-${randomUUID()}@example.test`
      });
      const other = await repo.createUser({
        email: `inspector-other-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id };
      const session = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex-cli"
      });
      const items = await repo.createConversationItems(actor, {
        items: Array.from({ length: 3 }, (_, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-transcript-v1",
          sourceTransport: "transcript" as const,
          externalSessionId: session.externalSessionId!,
          externalThreadId: session.externalSessionId!,
          externalTurnId: `turn-${index}`,
          canonicalStableItemId: `item-${index}`,
          sourceRecordType: "event_msg",
          sourceEventType: "user_message",
          sourceSequence: index + 1,
          eventTime: `2026-11-01T12:00:0${index}.000Z`,
          rawJson: {
            type: "event_msg",
            payload: { type: "user_message", message: `Message ${index}` }
          },
          rawText: `Message ${index}`,
          sourceHash: randomUUID(),
          idempotencyKey: randomUUID(),
          metadata: {
            transcriptType: "user_message",
            clientUserMessageId: `client-${index}`
          }
        }))
      });
      await repo.projectPendingConversationItems(actor, { limit: 10 });

      const otherSession = await repo.createCapturedSession(
        { userId: other.id },
        { externalSessionId: randomUUID() }
      );
      const [foreignItem] = await repo.createConversationItems(
        { userId: other.id },
        {
          items: [
            {
              sessionId: otherSession.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-transcript-v1",
              sourceTransport: "transcript",
              sourceRecordType: "event_msg",
              rawJson: {},
              sourceHash: randomUUID(),
              idempotencyKey: randomUUID(),
              metadata: { clientUserMessageId: "foreign-source" }
            }
          ]
        }
      );
      // A colliding source key must never supply another owner's metadata, even
      // when it sorts before the actual source. Exercise legacy key fallback too.
      await pool.query(
        `update conversation_items set metadata=metadata || jsonb_build_object(
         'canonicalConversationItemKey', (select substring(idempotency_key from 9)
           from messages where session_id=$1 order by source_event_time desc limit 1)),
         created_at='2000-01-01' where id=$2`,
        [session.id, foreignItem!.id]
      );
      await pool.query(
        "update conversation_items set metadata=metadata-'canonicalConversationItemKey' where id=$1",
        [items[0]!.id]
      );
      const input = {
        sessionId: session.id,
        threadId: session.externalSessionId!,
        includeContent: true,
        limit: 2
      };
      const first = await repo.listLcmGraphEvents(actor, input);
      expect(first.map((event) => event.content)).toEqual([
        "Message 2",
        "Message 1"
      ]);
      expect(first.map((event) => event.metadata)).toEqual([
        expect.objectContaining({
          sourceTable: "messages",
          providerTurnId: "turn-2",
          providerItemId: "item-2",
          clientUserMessageId: "client-2"
        }),
        expect.objectContaining({
          sourceTable: "messages",
          providerTurnId: "turn-1",
          providerItemId: "item-1",
          clientUserMessageId: "client-1"
        })
      ]);
      const cursor = first.at(-1)!;
      const second = await repo.listLcmGraphEvents(actor, {
        ...input,
        cursorId: cursor.id,
        cursorTimestamp: cursor.timestamp,
        cursorSourceSequence: cursor.sourceSequence ?? undefined
      });
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        content: "Message 0",
        metadata: { providerTurnId: "turn-0", clientUserMessageId: "client-0" }
      });
      expect(new Set([...first, ...second].map((event) => event.id)).size).toBe(
        3
      );
      expect(
        await repo.listLcmGraphEvents({ userId: other.id }, input)
      ).toEqual([]);
    });
  }
);
