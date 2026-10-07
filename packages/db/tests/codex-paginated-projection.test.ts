import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import type { ConversationItemInput } from "../src/index.js";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import {
  buildCodexTranscriptConversationItems,
  parseTranscriptJournalBytes
} from "../../mcp-server/src/codex-transcript-parser.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "Codex paginated capture through PostgreSQL Projection",
  () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    beforeAll(() => runDbMigrations(pool), 60_000);
    afterAll(() => pool.end());

    it.each([
      { encrypted: false, migrated: false },
      { encrypted: true, migrated: false },
      { encrypted: false, migrated: true },
      { encrypted: true, migrated: true }
    ])(
      "projects one logical prompt and answer with encryption=$encrypted and migrated IDs=$migrated across replay",
      async ({ encrypted, migrated }) => {
        const repo = createMemorySourceRepository(
          pool,
          encrypted
            ? {
                envelopeEncryptionProvider:
                  createLocalTestKeyEnvelopeEncryptionProvider(
                    Buffer.alloc(32, 37).toString("base64")
                  )
              }
            : {}
        );
        const owner = await repo.createUser({
          email: `paginated-${randomUUID()}@example.com`
        });
        const stranger = await repo.createUser({
          email: `paginated-other-${randomUUID()}@example.com`
        });
        const actor = { userId: owner.id };
        const threadId = randomUUID();
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: threadId,
          sourceRuntime: "codex",
          captureMethod: "api",
          projectId: "/fixture/paginated"
        });
        const timestamp = new Date().toISOString();
        const records = [
          {
            type: "session_meta",
            payload: { id: threadId, history_mode: "paginated" }
          },
          {
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1" }
          },
          {
            type: "event_msg",
            payload: {
              type: "item_completed",
              thread_id: threadId,
              turn_id: "turn-1",
              item: {
                type: "UserMessage",
                id: "user-1",
                content: [
                  { type: "text", text: "Remember paginated capture decision" }
                ]
              }
            }
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Injected setup context" }]
            }
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              id: "agent-1",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Confirmed paginated capture decision"
                }
              ]
            }
          },
          {
            type: "event_msg",
            payload: {
              type: "item_completed",
              thread_id: threadId,
              turn_id: "turn-1",
              item: {
                type: "AgentMessage",
                id: migrated ? "item-2" : "agent-1",
                content: [
                  { type: "Text", text: "Confirmed paginated capture decision" }
                ]
              }
            }
          },
          {
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-1" }
          }
        ].map((entry, ordinal) => ({ ...entry, timestamp, ordinal }));
        const parsed = parseTranscriptJournalBytes({
          bytes: Buffer.from(
            records.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
          ),
          absoluteStartOffset: 0,
          lineIndexOffset: 0
        });
        const requests = buildCodexTranscriptConversationItems({
          records: parsed.records,
          sessionId: session.id,
          sourceSessionId: threadId,
          sourceTransport: "transcript",
          threadKind: "conversation"
        });
        await repo.createConversationItems(actor, {
          items: requests as ConversationItemInput[]
        });
        await repo.projectPendingConversationItems(actor, { limit: 100 });
        const evidence = await repo.listLcmGraphEvents(actor, {
          includeContent: true,
          limit: 100
        });
        expect(evidence.map((entry) => entry.content)).toContain(
          "Remember paginated capture decision"
        );
        expect(evidence.map((entry) => entry.content).join("\n")).toContain(
          "Confirmed paginated capture decision"
        );
        expect(evidence.map((entry) => entry.content).join("\n")).not.toContain(
          "Injected setup context"
        );
        const counts = await pool.query<{ messages: string; events: string }>(
          `select (select count(*) from messages where session_id=$1)::text as messages,
        (select count(*) from memory_events where session_id=$1)::text as events`,
          [session.id]
        );
        expect(counts.rows[0]).toEqual({ messages: "2", events: "2" });
        await repo.createConversationItems(actor, {
          items: requests as ConversationItemInput[]
        });
        const replay = await repo.projectPendingConversationItems(actor, {
          limit: 100
        });
        expect(replay.messagesCreated).toBe(0);
        expect(replay.memoryEventsCreated).toBe(0);
        const stable = await pool.query<{ count: string }>(
          "select count(*)::text as count from conversation_items where session_id=$1 and canonical_stable_item_id=$2",
          [session.id, migrated ? "item-2" : "agent-1"]
        );
        expect(stable.rows[0]?.count).toBe("1");
        expect(
          await repo.listLcmGraphEvents(
            { userId: stranger.id },
            { includeContent: true, limit: 100 }
          )
        ).toEqual([]);
      }
    );
  }
);
