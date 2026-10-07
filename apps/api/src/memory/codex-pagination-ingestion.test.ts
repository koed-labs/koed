import { createHash, randomUUID, sign } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "@koed/db";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  generateConversationSourceReplicationOriginKeyPair
} from "@koed/shared";
import {
  MemoryApiClient,
  defaultConfig
} from "../../../../packages/mcp-server/src/index.js";
import { CodexCompressedTranscriptReader } from "../../../../packages/mcp-server/src/codex-compressed-transcript.js";
import { ingestCodexTranscriptJournal } from "../../../../packages/mcp-server/src/codex-transcript-journal.js";
import { extractTranscriptSessionMetadata } from "../../../../packages/mcp-server/src/codex-transcript-parser.js";
import { buildServer } from "../server/index.js";

const databaseUrl = process.env.DATABASE_URL;
const fixtureThreadId = randomUUID();
vi.mock("node-pty", () => ({
  spawn: () => {
    throw new Error("Unexpected terminal launch in capture test");
  }
}));
const encode = (rows: unknown[]) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
type FixtureRow = {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
  ordinal?: number;
};
const readNativeFixture = (directory: string, name: string): FixtureRow[] => {
  const rows: unknown[] = readFileSync(join(directory, name), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      !("timestamp" in row) ||
      typeof row.timestamp !== "string" ||
      !("type" in row) ||
      typeof row.type !== "string" ||
      !("payload" in row) ||
      !row.payload ||
      typeof row.payload !== "object"
    )
      throw new Error("Invalid synthetic native fixture row");
  }
  return rows as FixtureRow[];
};

const fixtureMessages = (rows: FixtureRow[]) => {
  const native = rows.flatMap((row) => {
    const item = row.payload.item;
    if (
      row.type !== "event_msg" ||
      row.payload.type !== "item_completed" ||
      !item ||
      typeof item !== "object" ||
      !("type" in item) ||
      !["UserMessage", "AgentMessage"].includes(String(item.type))
    )
      return [];
    if (
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("content" in item) ||
      !Array.isArray(item.content)
    )
      throw new Error("Synthetic native message identity is incomplete");
    const text = item.content
      .map((part: unknown) => {
        if (
          !part ||
          typeof part !== "object" ||
          !("text" in part) ||
          typeof part.text !== "string"
        )
          throw new Error("Synthetic native message content is invalid");
        return part.text;
      })
      .join("");
    return [{ stableItemId: item.id, text }];
  });
  if (native.length) return native;
  return rows.flatMap((row) =>
    row.type === "event_msg" &&
    ["user_message", "agent_message"].includes(String(row.payload.type)) &&
    typeof row.payload.message === "string"
      ? [{ stableItemId: null, text: row.payload.message }]
      : []
  );
};

describe.skipIf(!databaseUrl)(
  "Codex capture through API, journal and PostgreSQL",
  () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    beforeAll(() => runDbMigrations(pool), 60_000);
    afterAll(() => pool.end());

    it.each([
      { encrypted: false, kind: "migration" },
      { encrypted: true, kind: "migration" },
      { encrypted: false, kind: "revert" },
      { encrypted: true, kind: "revert" }
    ])(
      "retains one conversation through $kind, replay and compression with encryption=$encrypted",
      async ({ encrypted, kind }) => {
        const home = mkdtempSync(join(tmpdir(), "koed-pagination-api-"));
        vi.stubEnv("KOED_HOME", home);
        vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "developer");
        vi.stubEnv("API_TOKEN_PEPPER", "synthetic-pagination-test-pepper");
        vi.stubEnv("EMBEDDING_SERVICE_URL", "http://embedding.fixture");
        vi.stubEnv("EMBEDDING_MODEL", "qwen3-0.6b");
        vi.stubEnv("RERANKER_KEY", "");
        const provider = encrypted
          ? createLocalTestKeyEnvelopeEncryptionProvider(
              Buffer.alloc(32, 27).toString("base64")
            )
          : undefined;
        const repo = createMemorySourceRepository(pool, {
          envelopeEncryptionProvider: provider
        });
        const owner = await repo.createUser({
          email: `pagination-api-${randomUUID()}@example.test`
        });
        const token = `fixture-${randomUUID()}`;
        await repo.createApiToken({
          ownerUserId: owner.id,
          name: "Synthetic capture",
          tokenHash: createHash("sha256")
            .update(`synthetic-pagination-test-pepper${token}`)
            .digest("hex"),
          tokenPrefix: token.slice(0, 12)
        });
        const deploymentId = randomUUID();
        const deviceInstanceId = randomUUID();
        const originKeys = new Map<
          string,
          ReturnType<typeof generateConversationSourceReplicationOriginKeyPair>
        >();
        const app = await buildServer({
          repository: repo,
          envelopeEncryptionProvider: provider,
          runMemoryJobsInlineForTests: true,
          inspectDeploymentIdentity: () => ({
            health: "healthy",
            deploymentId,
            deviceInstanceId,
            remoteOperationsAllowed: true,
            message: "Synthetic identity",
            platformProtection: "verified"
          }),
          conversationSourceSignerFactory: ({
            sourceGenerationId,
            originKeyId
          }) => {
            const keys =
              originKeys.get(sourceGenerationId) ??
              generateConversationSourceReplicationOriginKeyPair();
            originKeys.set(sourceGenerationId, keys);
            return {
              deploymentId,
              deviceInstanceId,
              keyId: originKeyId,
              publicKey: keys.publicKeyBase64url,
              sign: (bytes) =>
                sign(null, bytes, keys.privateKey).toString("base64url")
            };
          }
        });
        const compressed = new CodexCompressedTranscriptReader(home);
        // Keep the local-only journal API while exercising hosted encrypted storage.
        if (encrypted)
          vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "team_self_hosted");
        let vectorsAvailable = false;
        const vector = Array<number>(1024).fill(0);
        vector[0] = 1;
        try {
          vi.stubGlobal(
            "fetch",
            async (url: string | URL | Request, init?: RequestInit) => {
              const target = new URL(
                typeof url === "string"
                  ? url
                  : url instanceof URL
                    ? url.href
                    : url.url
              );
              if (
                target.origin === "http://embedding.fixture" &&
                target.pathname === "/embed"
              ) {
                return vectorsAvailable
                  ? Response.json({
                      model: "qwen3-0.6b",
                      dimensions: 1024,
                      vectors: [vector],
                      measuredTokens: 4
                    })
                  : Response.json(
                      { detail: "Synthetic lexical-only stage" },
                      { status: 503 }
                    );
              }
              if (target.origin !== "http://api.fixture")
                throw new Error(
                  "Unexpected external request in isolated capture test"
                );
              const response = await app.inject({
                method: (init?.method ?? "GET") as "GET" | "POST",
                url: `${target.pathname}${target.search}`,
                headers: Object.fromEntries(new Headers(init?.headers)),
                ...(init?.body ? { payload: String(init.body) } : {})
              });
              return new Response(response.body, {
                status: response.statusCode,
                headers: response.headers as HeadersInit
              });
            }
          );
          const client = new MemoryApiClient(
            defaultConfig({
              MEMORY_API_URL: "http://api.fixture",
              MEMORY_API_TOKEN: token
            })
          );
          const nativeFixture =
            kind === "revert"
              ? process.env.KOED_CODEX_NATIVE_REVERT_FIXTURE
              : process.env.KOED_CODEX_NATIVE_MIGRATION_FIXTURE;
          const nativeBefore = nativeFixture
            ? readNativeFixture(
                nativeFixture,
                kind === "revert"
                  ? "revert-before.jsonl"
                  : "migration-before.jsonl"
              )
            : undefined;
          const nativeAfter = nativeFixture
            ? readNativeFixture(
                nativeFixture,
                kind === "revert"
                  ? "revert-after.jsonl"
                  : "migration-after.jsonl"
              )
            : undefined;
          const threadId = nativeBefore
            ? String(nativeBefore[0]?.payload.id)
            : fixtureThreadId;
          const recallPhrase = nativeBefore
            ? kind === "revert"
              ? "Synthetic fork prompt"
              : "Synthetic legacy prompt"
            : "paginated compatibility decision";
          const timestamp = new Date().toISOString();
          const event = (payload: Record<string, unknown>) => ({
            timestamp,
            type: "event_msg",
            payload
          });
          const legacy: FixtureRow[] = nativeBefore ?? [
            {
              timestamp,
              type: "session_meta",
              payload: { id: threadId, timestamp, cwd: "/fixture/project" }
            },
            event({ type: "task_started", turn_id: "turn-1" }),
            event({
              type: "user_message",
              message: "Remember paginated compatibility decision",
              text_elements: []
            }),
            {
              timestamp,
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                id: "raw-assistant-1",
                content: [
                  {
                    type: "output_text",
                    text: "Confirmed paginated compatibility decision"
                  }
                ]
              }
            },
            event({
              type: "agent_message",
              message: "Confirmed paginated compatibility decision",
              phase: null
            }),
            event({ type: "task_complete", turn_id: "turn-1" })
          ];
          const physicalParent =
            nativeAfter && kind === "revert"
              ? String(
                  (
                    nativeAfter[0]!.payload.history_base as Record<
                      string,
                      unknown
                    >
                  ).thread_id
                )
              : threadId;
          let file = join(
            home,
            kind === "revert"
              ? `rollout-2026-01-01T00-00-00-${physicalParent}.jsonl`
              : "rollout.jsonl"
          );
          const capture = async (rows: unknown[], transcriptPath = file) =>
            ingestCodexTranscriptJournal({
              client,
              sourceSession: {
                externalSessionId: threadId,
                idempotencyKey: `fixture-thread:${threadId}`,
                sourceRuntime: "codex-cli",
                captureMethod: "api",
                cwd: "/fixture/project",
                metadata: { threadKind: "conversation" }
              },
              sourceSessionId: threadId,
              transcriptPath,
              redactedSourceLabel: basename(file),
              context: extractTranscriptSessionMetadata(rows),
              maxBytesPerBatch: 1_000_000,
              liveStartOffset: 0,
              liveStartLine: 0
            });
          let migrated =
            nativeAfter ??
            legacy.map((row, ordinal) => {
              if (ordinal === 0)
                return {
                  ...row,
                  ordinal,
                  payload: { ...row.payload, history_mode: "paginated" }
                };
              if (ordinal !== 2 && ordinal !== 4) return { ...row, ordinal };
              return {
                ...event({
                  type: "item_completed",
                  thread_id: threadId,
                  turn_id: "turn-1",
                  started_at_ms: null,
                  completed_at_ms: Date.parse(timestamp),
                  item:
                    ordinal === 2
                      ? {
                          type: "UserMessage",
                          id: "item-1",
                          content: [
                            {
                              type: "text",
                              text: "Remember paginated compatibility decision",
                              text_elements: []
                            }
                          ]
                        }
                      : {
                          type: "AgentMessage",
                          id: "item-2",
                          content: [
                            {
                              type: "Text",
                              text: "Confirmed paginated compatibility decision"
                            }
                          ]
                        }
                }),
                ordinal
              };
            });
          const previous =
            kind === "revert" ? (nativeBefore ?? migrated) : legacy;
          const previousFile = file;
          const previousBytes = encode(previous);
          writeFileSync(file, previousBytes);
          const initial = await capture(previous);
          if (kind === "revert") {
            const prefix = previous.slice(0, 2);
            migrated = nativeAfter ?? [
              {
                ...previous[0]!,
                ordinal: 2,
                payload: {
                  ...previous[0]!.payload,
                  history_base: {
                    thread_id: physicalParent,
                    end_ordinal_exclusive: 2,
                    end_byte_offset: encode(prefix).length
                  }
                }
              }
            ];
            file = join(
              home,
              `rollout-2026-01-01T00-00-00-${threadId}_${randomUUID()}.jsonl`
            );
          }
          writeFileSync(file, encode(migrated));
          const rewritten = await capture(migrated);
          expect(rewritten.artifact).toMatchObject({
            sessionId: initial.artifact.sessionId,
            priorGenerationClosure: {
              sourceGenerationId: initial.artifact.sourceGenerationId
            }
          });
          expect(rewritten.artifact.sourceGenerationId).not.toBe(
            initial.artifact.sourceGenerationId
          );
          const bootstrap = await client.getConversationSourceCursor(
            rewritten.artifact.id,
            "canonical_live"
          );
          expect(bootstrap.cursor).toMatchObject({
            sourceOffset: rewritten.canonicalCursorOffset,
            parserState: { historyMode: "paginated" }
          });
          const storedCheckpoint = bootstrap.cursor as Record<string, unknown>;
          await expect(
            client.advanceConversationSourceCursor(rewritten.artifact.id, {
              expectedSourceOffset: rewritten.canonicalCursorOffset,
              consumerKind: "canonical_live",
              sourceOffset: storedCheckpoint.sourceOffset,
              sourceLine: storedCheckpoint.sourceLine,
              segmentIndex: storedCheckpoint.segmentIndex,
              lastVerifiedDigest: storedCheckpoint.lastVerifiedDigest,
              parserState: storedCheckpoint.parserState
            })
          ).rejects.toMatchObject({ status: 409 });
          if (kind === "revert")
            expect(readFileSync(previousFile)).toEqual(previousBytes);
          const nextOrdinal = (migrated.at(-1)?.ordinal ?? -1) + 1;
          const future = [
            {
              ...event({ type: "task_started", turn_id: "turn-2" }),
              ordinal: nextOrdinal
            },
            {
              ...event({
                type: "item_completed",
                thread_id: threadId,
                turn_id: "turn-2",
                item: {
                  type: "UserMessage",
                  id: "future-user",
                  content: [
                    {
                      type: "text",
                      text: "Next paginated capture decision",
                      text_elements: []
                    }
                  ]
                }
              }),
              ordinal: nextOrdinal + 1
            },
            {
              ...event({
                type: "item_completed",
                thread_id: threadId,
                turn_id: "turn-2",
                item: {
                  type: "AgentMessage",
                  id: "future-agent",
                  content: [
                    {
                      type: "Text",
                      text: "Confirmed next paginated capture decision"
                    }
                  ]
                }
              }),
              ordinal: nextOrdinal + 2
            },
            {
              ...event({ type: "task_complete", turn_id: "turn-2" }),
              ordinal: nextOrdinal + 3
            }
          ];
          appendFileSync(file, encode(future));
          const expectedMessages = [
            ...fixtureMessages(previous),
            ...fixtureMessages(
              migrated.slice(rewritten.artifact.liveStartLine)
            ),
            ...fixtureMessages(future)
          ];
          const expectedMessageCount = expectedMessages.length;
          const canonicalIdentities = async () =>
            (
              await pool.query<{
                canonical_item_key: string;
                canonical_stable_item_id: string | null;
              }>(
                "select canonical_item_key,canonical_stable_item_id from conversation_items where session_id=$1 order by canonical_item_key",
                [initial.artifact.sessionId]
              )
            ).rows;
          await capture([...migrated, ...future]);
          const capturedIdentities = await canonicalIdentities();
          for (const message of expectedMessages) {
            if (message.stableItemId !== null)
              expect(
                capturedIdentities.filter(
                  (item) =>
                    item.canonical_stable_item_id === message.stableItemId
                )
              ).toHaveLength(1);
          }
          await capture([...migrated, ...future]);
          expect(await canonicalIdentities()).toEqual(capturedIdentities);
          const zst = `${file}.zst`;
          writeFileSync(
            zst,
            zstdCompressSync(encode([...migrated, ...future]))
          );
          await capture(
            [...migrated, ...future],
            await compressed.materialize(zst)
          );
          expect(await canonicalIdentities()).toEqual(capturedIdentities);
          // Drive the existing background catch-up stage without waiting 15 minutes
          // for a legacy turnless assistant tail to become stale.
          vi.stubEnv("MEMORY_AGENT_TURN_STALE_MS", "0");
          const catchUp = await app.inject({
            method: "POST",
            url: "/v1/memory/conversation-items/project",
            headers: { authorization: `Bearer ${token}` },
            payload: { limit: 1000 }
          });
          expect(catchUp.statusCode, catchUp.body).toBe(200);
          const counts = await pool.query<{ messages: string; events: string }>(
            "select (select count(*) from messages where session_id=$1)::text as messages, (select count(*) from memory_events where session_id=$1)::text as events",
            [initial.artifact.sessionId]
          );
          expect(counts.rows[0]).toEqual({
            messages: String(expectedMessageCount),
            events: String(expectedMessageCount)
          });
          const recall = await app.inject({
            method: "POST",
            url: "/v1/memory/answer",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              query: recallPhrase,
              search_domain: "session",
              session_id: initial.artifact.sessionId
            }
          });
          expect(recall.statusCode, recall.body).toBe(200);
          expect(recall.json()).toHaveProperty("evidenceBundle");
          expect(recall.body).toContain(recallPhrase);
          const projected = await pool.query<{ id: string }>(
            "select id from memory_events where session_id=$1",
            [initial.artifact.sessionId]
          );
          let embeddedCount = 0;
          for (const event of projected.rows) {
            const source = await repo.getEmbeddableSource(
              "memory_event",
              event.id
            );
            if (!source) continue;
            embeddedCount++;
            await repo.replaceSourceEmbeddings({
              source: source!,
              model: "qwen3-0.6b",
              dimensions: 1024,
              version: "qwen3-0.6b",
              modelArtifactHash: "a".repeat(64),
              tokenizer: "qwen3-embedding-0.6b-gguf",
              inputTransform: "qwen3-retrieval-document-v1",
              pooling: "last",
              normalization: "l2",
              chunks: [
                {
                  vector,
                  chunkIndex: 0,
                  chunkCount: 1,
                  inputTokenCount: 4,
                  sourceText: source.text
                }
              ]
            });
          }
          expect(embeddedCount).toBeGreaterThan(0);
          vectorsAvailable = true;
          const vectorRecall = await app.inject({
            method: "POST",
            url: "/v1/memory/answer",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              query: recallPhrase,
              search_domain: "session",
              session_id: initial.artifact.sessionId
            }
          });
          expect(vectorRecall.statusCode, vectorRecall.body).toBe(200);
          expect(
            vectorRecall.json<{ retrieval: { vectorHitsCount: number } }>()
              .retrieval.vectorHitsCount
          ).toBeGreaterThan(0);
          await capture([...migrated, ...future]);
          const embeddingCounts = await pool.query<{ count: string }>(
            "select count(*)::text as count from memory_embeddings where memory_event_id in (select id from memory_events where session_id=$1)",
            [initial.artifact.sessionId]
          );
          expect(embeddingCounts.rows[0]?.count).toBe(String(embeddedCount));
          const graphEvents = await repo.listLcmGraphEvents(
            { userId: owner.id },
            { includeContent: true, limit: 100 }
          );
          expect(graphEvents).toHaveLength(expectedMessageCount);
          for (const message of expectedMessages)
            expect(
              graphEvents.filter((event) =>
                event.content?.includes(message.text)
              )
            ).toHaveLength(1);
          const scopes = await repo.listPendingLcmDispatchScopes({
            ownerUserId: owner.id
          });
          expect(scopes.length).toBeGreaterThan(0);
          for (const scope of scopes) {
            await repo.createLcmNodes(
              { userId: owner.id },
              {
                visibility: "personal",
                workClass: scope.workClass,
                sessionId: initial.artifact.sessionId,
                finalize: true
              }
            );
          }
          const lcmSources = await pool.query<{ count: string }>(
            "select count(*)::text as count from memory_node_sources where memory_event_id in (select id from memory_events where session_id=$1)",
            [initial.artifact.sessionId]
          );
          expect(lcmSources.rows[0]?.count).toBe(String(expectedMessageCount));
          const claimPayload = {
            claimantId: "synthetic-capture-client",
            compatibilityContractHash: "b".repeat(64),
            leaseMs: 60_000,
            limit: 10
          };
          const claims = await app.inject({
            method: "POST",
            url: "/v1/memory/lcm/summary-claims",
            headers: { authorization: `Bearer ${token}` },
            payload: claimPayload
          });
          expect(claims.statusCode, claims.body).toBe(200);
          expect(claims.json<{ count: number }>().count).toBeGreaterThan(0);
          await capture([...migrated, ...future]);
          const repeatedClaims = await app.inject({
            method: "POST",
            url: "/v1/memory/lcm/summary-claims",
            headers: { authorization: `Bearer ${token}` },
            payload: { ...claimPayload, claimantId: "competing-client" }
          });
          expect(repeatedClaims.statusCode, repeatedClaims.body).toBe(200);
          expect(repeatedClaims.json<{ count: number }>().count).toBe(0);
          if (encrypted) {
            const raw = await pool.query(
              "select raw_text, raw_json, metadata from conversation_items where session_id=$1",
              [initial.artifact.sessionId]
            );
            expect(JSON.stringify(raw.rows)).not.toContain(recallPhrase);
            const events = await pool.query(
              "select payload from memory_events where session_id=$1",
              [initial.artifact.sessionId]
            );
            expect(JSON.stringify(events.rows)).not.toContain(recallPhrase);
          }
          const outsider = await repo.createUser({
            email: `pagination-outsider-${randomUUID()}@example.test`
          });
          expect(
            await repo.listLcmGraphEvents(
              { userId: outsider.id },
              { includeContent: true, limit: 100 }
            )
          ).toEqual([]);
        } finally {
          await compressed.close();
          await app.close();
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
          rmSync(home, { recursive: true, force: true });
        }
      },
      60_000
    );
  }
);
