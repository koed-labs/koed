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
      "preserves existing Memory, embeddings and LCM through $kind, replay and compression with encryption=$encrypted",
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
          const projectCaptured = async () => {
            const response = await app.inject({
              method: "POST",
              url: "/v1/memory/conversation-items/project",
              headers: { authorization: `Bearer ${token}` },
              payload: { limit: 1000 }
            });
            expect(response.statusCode, response.body).toBe(200);
          };
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
          // Finalize a legacy turnless assistant tail before snapshotting its Memory.
          vi.stubEnv("MEMORY_AGENT_TURN_STALE_MS", "0");
          await projectCaptured();
          const memoryEventIds = async () =>
            (
              await pool.query<{ id: string }>(
                "select id from memory_events where session_id=$1 order by id",
                [initial.artifact.sessionId]
              )
            ).rows.map((event) => event.id);
          const originalEventIds = await memoryEventIds();
          expect(originalEventIds.length).toBeGreaterThan(0);
          const buildPendingLcm = async () => {
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
          };
          await buildPendingLcm();
          const originalNodeIds = (
            await pool.query<{ id: string }>(
              "select id from memory_nodes where session_id=$1 order by id",
              [initial.artifact.sessionId]
            )
          ).rows.map((node) => node.id);
          expect(originalNodeIds.length).toBeGreaterThan(0);
          // Work discovery is global; scope real SQL candidates before key-specific hydration.
          const queueRepo = createMemorySourceRepository(
            new Proxy(pool, {
              get(target, property, receiver): unknown {
                if (property !== "query")
                  return Reflect.get(target, property, receiver) as unknown;
                return async (query: string, values?: unknown[]) => {
                  const result = await target.query<{ owner_user_id?: string }>(
                    query,
                    values
                  );
                  return query.includes("with sources as (") &&
                    query.includes("limit $4")
                    ? {
                        ...result,
                        rows: result.rows.filter(
                          (row) => row.owner_user_id === owner.id
                        )
                      }
                    : result;
                };
              }
            }),
            { envelopeEncryptionProvider: provider }
          );
          const pendingEmbeddings = async () =>
            (await queueRepo.listSourcesNeedingEmbeddings(10_000)).filter(
              (source) => source.ownerUserId === owner.id
            );
          const embedSources = async (
            sources: Awaited<ReturnType<typeof pendingEmbeddings>>
          ) => {
            for (const source of sources) {
              // Distinct deterministic fixtures exercise vector preservation, not model quality.
              const digest = createHash("sha256").update(source.text).digest();
              const slope = digest.readUInt32BE(0) / 0xffffffff / 10;
              const length = Math.sqrt(1 + slope * slope);
              const sourceVector = Array<number>(1024).fill(0);
              sourceVector[0] = 1 / length;
              sourceVector[1] = slope / length;
              await repo.replaceSourceEmbeddings({
                source,
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
                    vector: sourceVector,
                    chunkIndex: 0,
                    chunkCount: 1,
                    inputTokenCount: 4,
                    sourceText: source.text
                  }
                ]
              });
            }
          };
          const originalSources = await pendingEmbeddings();
          expect(
            originalSources
              .filter((source) => source.sourceType === "memory_event")
              .map((source) => source.sourceId)
              .sort()
          ).toEqual(originalEventIds);
          expect(
            originalSources.some(
              (source) => source.sourceType === "memory_node"
            )
          ).toBe(true);
          await embedSources(originalSources);
          expect(await pendingEmbeddings()).toEqual([]);
          const preservedEmbeddings = async () =>
            (
              await pool.query<{ row: unknown; vector: string | null }>(
                `select to_jsonb(me) as row, v.embedding::text as vector
                 from memory_embeddings me
                 left join memory_embeddings_1024 v on v.memory_embedding_id=me.id
                where me.memory_event_id=any($1::uuid[])
                   or me.memory_node_id=any($2::uuid[])
                order by me.id`,
                [originalEventIds, originalNodeIds]
              )
            ).rows;
          const preservedMemory = async () => ({
            events: (
              await pool.query<{ row: unknown }>(
                "select to_jsonb(me) as row from memory_events me where id=any($1::uuid[]) order by id",
                [originalEventIds]
              )
            ).rows,
            nodes: (
              await pool.query<{ row: unknown }>(
                "select to_jsonb(mn) as row from memory_nodes mn where id=any($1::uuid[]) order by id",
                [originalNodeIds]
              )
            ).rows,
            lcmLinks: (
              await pool.query<{ row: unknown }>(
                "select to_jsonb(ms) as row from memory_node_sources ms where memory_node_id=any($1::uuid[]) order by memory_node_id,source_order",
                [originalNodeIds]
              )
            ).rows,
            embeddings: await preservedEmbeddings(),
            embeddingInputs: await Promise.all(
              originalSources.map((source) =>
                repo.getEmbeddableSource(source.sourceType, source.sourceId)
              )
            ),
            encryptedCompanions: (
              await pool.query<{ row: unknown }>(
                `select to_jsonb(efp) as row from encrypted_field_payloads efp
                where owner_user_id=$1
                  and (
                    (source_table='memory_events' and source_id=any($2::uuid[]))
                    or (source_table='memory_nodes' and source_id=any($3::uuid[]))
                    or (source_table='memory_embeddings' and source_id in (
                      select id from memory_embeddings
                       where memory_event_id=any($2::uuid[])
                          or memory_node_id=any($3::uuid[])
                    ))
                  )
                order by id`,
                [owner.id, originalEventIds, originalNodeIds]
              )
            ).rows
          });
          const originalMemory = await preservedMemory();
          expect(originalMemory.embeddings).toHaveLength(
            originalSources.length
          );
          expect(
            originalMemory.embeddings.every(
              (entry) => typeof entry.vector === "string"
            )
          ).toBe(true);
          expect(originalMemory.lcmLinks.length).toBeGreaterThan(0);
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
          const migratedSuffix = kind === "revert" ? migrated.slice(1) : [];
          if (kind === "revert") migrated = migrated.slice(0, 1);
          writeFileSync(file, encode(migrated));
          const rewritten = await capture(migrated);
          await projectCaptured();
          expect(await memoryEventIds()).toEqual(originalEventIds);
          expect(await preservedMemory()).toEqual(originalMemory);
          expect(await pendingEmbeddings()).toEqual([]);
          await capture(migrated);
          expect(await preservedMemory()).toEqual(originalMemory);
          expect(await pendingEmbeddings()).toEqual([]);
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
          if (migratedSuffix.length) {
            appendFileSync(file, encode(migratedSuffix));
            migrated = [...migrated, ...migratedSuffix];
            await capture(migrated);
            await projectCaptured();
            expect(await preservedMemory()).toEqual(originalMemory);
            await embedSources(await pendingEmbeddings());
            expect(await pendingEmbeddings()).toEqual([]);
          }
          const preFutureEventIds = await memoryEventIds();
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
          await projectCaptured();
          expect(await preservedMemory()).toEqual(originalMemory);
          const newEventIds = (await memoryEventIds()).filter(
            (id) => !preFutureEventIds.includes(id)
          );
          expect(newEventIds).toHaveLength(2);
          const newSources = await pendingEmbeddings();
          expect(newSources.map((source) => source.sourceId).sort()).toEqual(
            newEventIds
          );
          expect(
            newSources.every((source) => source.sourceType === "memory_event")
          ).toBe(true);
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
          await embedSources(newSources);
          expect(await pendingEmbeddings()).toEqual([]);
          expect(await preservedEmbeddings()).toEqual(
            originalMemory.embeddings
          );
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
          expect(embeddingCounts.rows[0]?.count).toBe(
            String(expectedMessageCount)
          );
          expect(await pendingEmbeddings()).toEqual([]);
          expect(await preservedEmbeddings()).toEqual(
            originalMemory.embeddings
          );
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
          await buildPendingLcm();
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
