import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import type {
  ConversationItemInput,
  EmbeddableSourceRecord
} from "../src/index.js";
import {
  buildCodexTranscriptConversationItems,
  parseTranscriptJournalBytes
} from "../../mcp-server/src/codex-transcript-parser.js";

const databaseUrl = process.env.DATABASE_URL;
const prompt = "Remember that the fixture release uses the green channel.";
const summary = "Check the fixture release channel before answering.";
const answer = "The fixture release uses the green channel.";
const privateReasoning = "Private synthetic reasoning retained as provenance.";
const timestamp = "2026-10-07T00:00:00.000Z";

describe.skipIf(!databaseUrl)("Fresh Codex history embedding parity", () => {
  const pool = createDbPool({ connectionString: databaseUrl });
  beforeAll(() => runDbMigrations(pool), 60_000);
  afterAll(() => pool.end());

  it.each([false, true])(
    "projects equivalent legacy and paginated histories with encryption=%s",
    async (encrypted) => {
      const repo = createMemorySourceRepository(
        pool,
        encrypted
          ? {
              envelopeEncryptionProvider:
                createLocalTestKeyEnvelopeEncryptionProvider(
                  Buffer.alloc(32, 53).toString("base64")
                )
            }
          : {}
      );
      const owners: string[] = [];
      const snapshots = [];
      const model = resolveSupportedEmbeddingModelConfig(
        process.env.EMBEDDING_MODEL
      );
      const contract = {
        model: model.key,
        modelArtifactHash: model.defaultArtifactSha256,
        dimensions: model.dimensions,
        version: model.key,
        tokenizer: model.tokenizer,
        inputTransform: model.inputTransform,
        pooling: model.pooling,
        normalization: model.normalization
      };
      for (const paginated of [false, true]) {
        const owner = await repo.createUser({
          email: `history-parity-${randomUUID()}@example.com`
        });
        owners.push(owner.id);
        const actor = { userId: owner.id };
        const threadId = randomUUID();
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: threadId,
          sourceRuntime: "codex",
          captureMethod: "api",
          projectId: "/fixture/history-parity"
        });
        const completed = (item: unknown) => ({
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: threadId,
            turn_id: "turn-1",
            item
          }
        });
        const response = (payload: unknown) => ({
          type: "response_item",
          payload
        });
        const records = [
          {
            type: "session_meta",
            payload: {
              id: threadId,
              ...(paginated ? { history_mode: "paginated" } : {})
            }
          },
          {
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1" }
          },
          ...(paginated
            ? [
                completed({
                  type: "UserMessage",
                  id: "user-1",
                  content: [{ type: "text", text: prompt }]
                }),
                completed({
                  type: "Reasoning",
                  id: "reason-1",
                  summary_text: [summary],
                  raw_content: [privateReasoning]
                }),
                completed({
                  type: "CommandExecution",
                  id: "command-1",
                  command: ["printf", "green"],
                  status: "completed",
                  aggregated_output: "green",
                  exit_code: 0
                }),
                completed({
                  type: "AgentMessage",
                  id: "agent-1",
                  content: [{ type: "Text", text: answer }]
                })
              ]
            : [
                {
                  type: "event_msg",
                  payload: { type: "user_message", message: prompt }
                },
                response({
                  type: "reasoning",
                  id: "reason-1",
                  summary: [summary],
                  content: [privateReasoning]
                }),
                response({
                  type: "function_call",
                  id: "command-1",
                  call_id: "command-1",
                  name: "exec_command",
                  arguments: JSON.stringify({ cmd: ["printf", "green"] }),
                  status: "completed"
                }),
                response({
                  type: "function_call_output",
                  call_id: "command-1",
                  output: JSON.stringify({ output: "green", exitCode: 0 }),
                  status: "completed"
                }),
                response({
                  type: "message",
                  id: "agent-1",
                  role: "assistant",
                  content: [{ type: "output_text", text: answer }]
                })
              ]),
          {
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-1" }
          }
        ].map((record, ordinal) => ({
          ...record,
          timestamp: new Date(
            Date.parse(timestamp) + ordinal * 1000
          ).toISOString(),
          ...(paginated ? { ordinal } : {})
        }));
        const parsed = parseTranscriptJournalBytes({
          bytes: Buffer.from(
            records.map((record) => JSON.stringify(record)).join("\n") + "\n"
          ),
          absoluteStartOffset: 0,
          lineIndexOffset: 0
        });
        const items = buildCodexTranscriptConversationItems({
          records: parsed.records,
          sessionId: session.id,
          sourceSessionId: threadId,
          sourceTransport: "transcript",
          threadKind: "conversation"
        }) as ConversationItemInput[];
        await repo.createConversationItems(actor, { items });
        await repo.projectPendingConversationItems(actor, { limit: 100 });
        const events = await repo.listLcmGraphEvents(actor, {
          includeContent: true,
          canonicalCapturedSessionEventsOnly: true,
          limit: 100
        });
        expect(events).toHaveLength(2);
        const eventSources: EmbeddableSourceRecord[] = [];
        for (const event of events) {
          const source = await repo.getEmbeddableSource(
            "memory_event",
            event.id
          );
          expect(source?.ownerUserId).toBe(owner.id);
          if (source) eventSources.push(source);
        }
        expect(eventSources).toHaveLength(2);
        const semantics = events
          .map((event) => {
            const manifest = event.metadata.semanticItemManifest as Array<{
              actor: string;
              kind: string;
              toolName?: string;
              offsetStart: number;
              offsetEnd: number;
              includeInEmbedding: boolean;
              includeInLcm: boolean;
            }>;
            return {
              actor: event.actor,
              eventType: event.eventType,
              content: event.content,
              embeddingText: eventSources.find(
                (source) => source.sourceId === event.id
              )?.text,
              manifest: manifest.map((item) => ({
                actor: item.actor,
                kind: item.kind,
                toolName: item.toolName,
                content: event.content!.slice(item.offsetStart, item.offsetEnd),
                includeInEmbedding: item.includeInEmbedding,
                includeInLcm: item.includeInLcm
              }))
            };
          })
          .sort((left, right) =>
            `${left.actor}:${left.content}`.localeCompare(
              `${right.actor}:${right.content}`
            )
          );
        expect(semantics.find((event) => event.actor === "user")?.content).toBe(
          prompt
        );
        const agentItems = semantics
          .flatMap((event) => event.manifest)
          .filter((item) => item.actor !== "user");
        expect(agentItems.map((item) => item.kind).sort()).toEqual([
          "agent_message",
          "reasoning_summary",
          "tool_call",
          "tool_result"
        ]);
        expect(agentItems.map((item) => item.content)).toContain(summary);
        expect(agentItems.map((item) => item.content)).toContain(answer);
        for (const event of semantics) {
          expect(event.eventType).toBe(
            event.actor === "user" ? "user_turn" : "agent_turn"
          );
          expect(event.content).not.toContain(privateReasoning);
          expect(event.manifest.every((item) => item.includeInEmbedding)).toBe(
            true
          );
          expect(event.manifest.every((item) => item.includeInLcm)).toBe(true);
          expect(event.embeddingText).toBe(event.content);
          expect(event.embeddingText).not.toContain(privateReasoning);
        }
        const stored = [];
        for (const source of eventSources) {
          // Text-derived synthetic vectors test input parity, not model quality.
          const digest = createHash("sha256").update(source.text).digest();
          const vector = Array.from(
            { length: model.dimensions },
            (_, index) => (digest[index % digest.length]! - 128) / 128
          );
          const embedding = await repo.upsertSourceEmbedding({
            ...contract,
            source,
            vector
          });
          const result = await pool.query<{
            embedding_input_hash: string;
            embedding_source_content_hash: string;
            embedding: string;
          }>(
            `select me.embedding_input_hash, me.embedding_source_content_hash,
                    vector.embedding::text as embedding
             from memory_embeddings me
             join memory_embeddings_${model.dimensions} vector
               on vector.memory_embedding_id = me.id
             where me.id = $1 and me.owner_user_id = $2`,
            [embedding.id, owner.id]
          );
          expect(result.rows).toHaveLength(1);
          expect(JSON.parse(result.rows[0]!.embedding)).toEqual(vector);
          stored.push({ text: source.text, contract, ...result.rows[0] });
        }
        snapshots.push({
          semantics,
          embeddings: stored.sort((left, right) =>
            left.text.localeCompare(right.text)
          )
        });
        await repo.createConversationItems(actor, { items });
        const replay = await repo.projectPendingConversationItems(actor, {
          limit: 100
        });
        expect(replay.memoryEventsCreated).toBe(0);
      }
      expect(snapshots[1]!.semantics).toEqual(snapshots[0]!.semantics);
      expect(snapshots[1]!.embeddings).toEqual(snapshots[0]!.embeddings);
      const embeddings = await pool.query<{ count: number }>(
        "select count(*)::integer as count from memory_embeddings where owner_user_id = any($1::uuid[]) and invalidated_at is null",
        [owners]
      );
      expect(embeddings.rows[0]?.count).toBe(4);
    }
  );
});
