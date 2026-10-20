import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createChatDeleteRepository } from "./chat-delete-repository.js";
import { createChatForgetRepository } from "./chat-forget-repository.js";
import { createCuratedMemoryRepository } from "./curated-memory-repository.js";
import { persistCuratedMemoryPayload } from "./curated-memory-support.js";
import {
  activeCuratedMemoryEvidencePredicate,
  suppressCuratedMemoryWithoutActiveEvidenceWithClient
} from "./curated-memory-policy.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { runDbMigrations } from "./migrate.js";
import { createMemorySourceRepository } from "./repository.js";

const testUrl = process.env.KOED_HQ106_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const vector = [1, ...Array<number>(1023).fill(0)];
const embedEvent = async (
  memory: ReturnType<typeof createMemorySourceRepository>,
  ownerUserId: string,
  event: { id: string; content: string }
) => {
  await memory.upsertSourceEmbedding({
    source: {
      sourceType: "memory_event",
      sourceId: event.id,
      ownerUserId,
      visibility: "personal",
      text: event.content,
      sourceHash: randomUUID()
    },
    model: "qwen3-0.6b",
    modelArtifactHash: "a".repeat(64),
    dimensions: 1024,
    version: "qwen3-0.6b",
    tokenizer: "qwen3-embedding-0.6b-gguf",
    inputTransform: "qwen3-retrieval-document-v1",
    pooling: "last",
    normalization: "l2",
    vector
  });
};
const embedNode = async (
  pool: pg.Pool,
  memory: ReturnType<typeof createMemorySourceRepository>,
  ownerUserId: string,
  node: { id: string; summaryText: string }
) => {
  const revision = await pool.query<{ source_hash: string }>(
    `select encode(digest(
       coalesce(source_hash,id::text) || ':lcm-summary-embedding-anchors-v1:'
         || summary_embedding_revision::text,'sha256'), 'hex') as source_hash
       from memory_nodes where id=$1`,
    [node.id]
  );
  await memory.upsertSourceEmbedding({
    source: {
      sourceType: "memory_node",
      sourceId: node.id,
      ownerUserId,
      visibility: "personal",
      text: node.summaryText,
      sourceHash: revision.rows[0]!.source_hash
    },
    model: "qwen3-0.6b",
    modelArtifactHash: "a".repeat(64),
    dimensions: 1024,
    version: "qwen3-0.6b",
    tokenizer: "qwen3-embedding-0.6b-gguf",
    inputTransform: "qwen3-retrieval-document-v1",
    pooling: "last",
    normalization: "l2",
    vector
  });
};

describe.skipIf(!testUrl)("HQ-106 chat lifecycle", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq106_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen3-0.6b",
              dimensions: 1024,
              vectors: [vector]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database if exists ${quote(database)}`);
    await admin?.end();
    vi.unstubAllGlobals();
  });

  it("keeps owned recall after trash, excludes navigation, and restores within 30 days", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-${randomUUID()}@example.test`
    });
    const other = await memory.createUser({
      email: `hq106-${randomUUID()}@example.test`
    });
    const session = await memory.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex",
        captureMethod: "transcript"
      }
    );
    const event = await memory.createMemoryEvent(
      { userId: owner.id },
      {
        projectId: "hq106-recall",
        sessionId: session.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content: "The exact chat recall sentinel is kingfisher.",
        visibility: "personal"
      }
    );
    const node = await memory.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "The exact chat recall sentinel is kingfisher.",
        sourceHash: `hq106-${randomUUID()}`
      }
    );
    await pool.query(
      `insert into memory_node_sources(memory_node_id,memory_event_id,source_order)
      values($1,$2,0)`,
      [node.id, event.id]
    );
    await embedEvent(memory, owner.id, event);
    const recall = () =>
      memory.searchMemoryNodes(
        { userId: owner.id },
        {
          scope: "personal",
          query: "kingfisher",
          searchDomain: "global",
          retrievalStage: "raw_fallback_search",
          limit: 10
        }
      );
    expect(
      (await recall()).results.some((item) => item.sourceId === event.id)
    ).toBe(true);
    const configuredBackendId = randomUUID();
    const deletion = createChatDeleteRepository(pool, {
      configuredBackendIds: () => [configuredBackendId]
    });
    const batchId = randomUUID();
    await expect(
      deletion.beginChatDelete(other.id, session.id, randomUUID())
    ).rejects.toThrow();
    const started = await deletion.beginChatDelete(
      owner.id,
      session.id,
      batchId
    );
    expect(started.sources[0]?.backends).toEqual([]);
    const forget = createChatForgetRepository(pool);
    await expect(forget.beginForgetChat(owner.id, session.id)).rejects.toThrow(
      "Conversation deletion is still pending"
    );
    expect(
      (await deletion.listPendingChatDeletes(owner.id)).map(
        (item) => item.batchId
      )
    ).toContain(batchId);
    await deletion.markChatDeleteReady(owner.id, session.id, batchId);
    await deletion.completeChatDelete(owner.id, session.id, batchId);
    await expect(
      memory.expandMemoryNode(node.id, { userId: owner.id })
    ).resolves.toBeDefined();
    // Completed trash and Personal Forget are deliberately independent.
    const forgotten = await forget.beginForgetChat(owner.id, session.id);
    await forget.completeForgetChat(owner.id, session.id, forgotten.batch_id);
    await forget.undoForgetChat(owner.id, session.id, forgotten.batch_id);
    expect(
      (await memory.listLcmGraphThreads({ userId: owner.id }, { limit: 50 }))
        .flatMap((project) => project.threads)
        .some((item) => item.sessionId === session.id)
    ).toBe(false);
    expect(
      (await recall()).results.some((item) => item.sourceId === event.id)
    ).toBe(true);
    await pool.query(
      `update sessions set trashed_at=now() - interval '31 days' where id=$1`,
      [session.id]
    );
    await expect(
      deletion.restoreChat(owner.id, session.id, batchId)
    ).rejects.toThrow("Conversation restore window expired");
    await pool.query(`update sessions set trashed_at=now() where id=$1`, [
      session.id
    ]);
    await deletion.restoreChat(owner.id, session.id);
    expect(
      (await memory.listLcmGraphThreads({ userId: owner.id }, { limit: 50 }))
        .flatMap((project) => project.threads)
        .some((item) => item.sessionId === session.id)
    ).toBe(true);
  });

  it("forgets only Personal evidence and restores exact evidence on Undo", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-${randomUUID()}@example.test`
    });
    const session = await memory.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex",
        captureMethod: "transcript"
      }
    );
    const event = await memory.createMemoryEvent(
      { userId: owner.id },
      {
        projectId: "hq106-forget",
        sessionId: session.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content: "The forget sentinel is redstart.",
        visibility: "personal"
      }
    );
    const node = await memory.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "The forget sentinel is redstart.",
        sourceHash: `hq106-${randomUUID()}`
      }
    );
    await pool.query(
      `insert into memory_node_sources(memory_node_id,memory_event_id,source_order)
      values($1,$2,0)`,
      [node.id, event.id]
    );
    await embedEvent(memory, owner.id, event);
    const assertionId = randomUUID();
    await pool.query(
      `insert into curated_memory_assertions
       (id,owner_user_id,visibility,assertion_text,normalized_assertion)
       values ($1,$2,'personal',$3,$4)`,
      [
        assertionId,
        owner.id,
        "The sentinel is redstart",
        `redstart-${assertionId}`
      ]
    );
    await pool.query(
      `insert into curated_memory_sources
       (assertion_id,source_type,source_role,memory_event_id)
       values ($1,'memory_event','primary_evidence',$2)`,
      [assertionId, event.id]
    );
    const recall = () =>
      memory.searchMemoryNodes(
        { userId: owner.id },
        {
          scope: "personal",
          query: "redstart",
          searchDomain: "global",
          retrievalStage: "raw_fallback_search",
          limit: 10
        }
      );
    expect(
      (await recall()).results.some((item) => item.sourceId === event.id)
    ).toBe(true);
    const forget = createChatForgetRepository(pool);
    const started = await forget.beginForgetChat(owner.id, session.id);
    const operation = await forget.completeForgetChat(
      owner.id,
      session.id,
      started.batch_id
    );
    const suppressed = await pool.query<{
      status: string;
      suppressed_at: Date | null;
    }>(
      `select status,suppressed_at from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    expect(suppressed.rows[0]?.status).toBe("suppressed");
    expect(operation.suppressedAssertionIds).toContain(assertionId);
    expect(
      (await recall()).results.some((item) => item.sourceId === event.id)
    ).toBe(false);
    await forget.undoForgetChat(owner.id, session.id, operation.batchId);
    const restored = await pool.query<{
      status: string;
      suppressed_at: Date | null;
    }>(
      `select status,suppressed_at from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    expect(restored.rows[0]).toMatchObject({
      status: "current",
      suppressed_at: null
    });
    expect(
      (await recall()).results.some((item) => item.sourceId === event.id)
    ).toBe(true);
    const second = await forget.beginForgetChat(owner.id, session.id);
    await forget.completeForgetChat(owner.id, session.id, second.batch_id);
    await pool.query(
      `update curated_memory_assertions set suppression_reason='manual newer decision',
              updated_at=clock_timestamp() + interval '1 second'
        where id=$1`,
      [assertionId]
    );
    await forget.undoForgetChat(owner.id, session.id, second.batch_id);
    const keptManual = await pool.query<{
      status: string;
      suppression_reason: string;
    }>(
      `select status,suppression_reason from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    expect(keptManual.rows[0]).toMatchObject({
      status: "suppressed",
      suppression_reason: "manual newer decision"
    });
    const expired = await forget.beginForgetChat(owner.id, session.id);
    await forget.completeForgetChat(owner.id, session.id, expired.batch_id);
    await pool.query(
      `update chat_forget_operations
          set forgotten_at=now() - interval '8 days' where batch_id=$1`,
      [expired.batch_id]
    );
    await expect(
      forget.undoForgetChat(owner.id, session.id, expired.batch_id)
    ).rejects.toThrow("Forget Undo window expired");
  });

  it("paginates all Deleted chats when the cutoff shares microsecond timestamps", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-pagination-${randomUUID()}@example.test`
    });
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,trashed_at)
       select gen_random_uuid(),$1,'codex','transcript',
              date_trunc('second',now()) + interval '123456 microseconds'
       from generate_series(1,201)`,
      [owner.id]
    );
    const first = await memory.listTrashedCapturedSessions({
      userId: owner.id
    });
    expect(first.sessions).toHaveLength(200);
    expect(first.nextBefore?.trashedAt).toMatch(/\.123456Z$/);
    const second = await memory.listTrashedCapturedSessions(
      { userId: owner.id },
      first.nextBefore!
    );
    expect(second.sessions).toHaveLength(1);
    expect(second.nextBefore).toBeNull();
    expect(
      new Set(
        [...first.sessions, ...second.sessions].map((item) => item.sessionId)
      ).size
    ).toBe(201);
  });

  it("Undo restores encrypted Curated status and its matching payload only", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-encrypted-${randomUUID()}@example.test`
    });
    const session = await memory.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex",
        captureMethod: "transcript"
      }
    );
    const event = await memory.createMemoryEvent(
      { userId: owner.id },
      {
        projectId: "hq106-encrypted",
        sessionId: session.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content: "The encrypted Curated sentinel is redstart.",
        visibility: "personal"
      }
    );
    const assertionId = randomUUID();
    await pool.query(
      `insert into curated_memory_assertions
       (id,owner_user_id,visibility,assertion_text,normalized_assertion)
       values ($1,$2,'personal',$3,$4)`,
      [
        assertionId,
        owner.id,
        "[koed encrypted curated memory]",
        `encrypted-${assertionId}`
      ]
    );
    const source = await pool.query<{ id: string }>(
      `insert into curated_memory_sources
       (assertion_id,source_type,source_role,memory_event_id)
       values ($1,'memory_event','primary_evidence',$2) returning id`,
      [assertionId, event.id]
    );
    const priorProfile = process.env.KOED_DEPLOYMENT_PROFILE;
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    try {
      process.env.KOED_DEPLOYMENT_PROFILE = "private_vps";
      await persistCuratedMemoryPayload(pool, { userId: owner.id }, provider, {
        sourceTable: "curated_memory_assertions",
        sourceId: assertionId,
        plaintext: {
          assertionText: "The encrypted Curated sentinel is redstart."
        }
      });
      await persistCuratedMemoryPayload(pool, { userId: owner.id }, provider, {
        sourceTable: "curated_memory_sources",
        sourceId: source.rows[0]!.id,
        plaintext: { metadata: {} }
      });
      const forget = createChatForgetRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const started = await forget.beginForgetChat(owner.id, session.id);
      const completed = await forget.completeForgetChat(
        owner.id,
        session.id,
        started.batch_id
      );
      expect(completed.suppressedAssertionIds).toContain(assertionId);
      const curated = createCuratedMemoryRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      expect(
        await curated.getCuratedMemoryAssertion(
          { userId: owner.id },
          assertionId
        )
      ).toMatchObject({
        status: "suppressed",
        suppressionReason: "Final active source evidence was deleted"
      });
      await forget.undoForgetChat(owner.id, session.id, completed.batchId);
      expect(
        await curated.getCuratedMemoryAssertion(
          { userId: owner.id },
          assertionId
        )
      ).toMatchObject({
        status: "current",
        suppressionReason: null
      });
    } finally {
      if (priorProfile === undefined)
        delete process.env.KOED_DEPLOYMENT_PROFILE;
      else process.env.KOED_DEPLOYMENT_PROFILE = priorProfile;
    }
  });

  it("rejects late chat evidence for Curated recall while preserving sessionless Personal evidence", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-late-${randomUUID()}@example.test`
    });
    const chat = await memory.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex",
        captureMethod: "transcript"
      }
    );
    const forget = createChatForgetRepository(pool);
    const started = await forget.beginForgetChat(owner.id, chat.id);
    await forget.completeForgetChat(owner.id, chat.id, started.batch_id);
    const itemId = randomUUID();
    const noteItemId = randomUUID();
    for (const [id, sessionId] of [
      [itemId, chat.id],
      [noteItemId, null]
    ] as const) {
      await pool.query(
        `insert into conversation_items
         (id,owner_user_id,visibility,session_id,source_kind,source_adapter_version,
          source_transport,source_record_type,raw_json,source_hash,idempotency_key,canonical_item_key)
         values($1,$2,'personal',$3,'test','1','local','message','{}'::jsonb,$4,$5,$6)`,
        [id, owner.id, sessionId, randomUUID(), `late-${id}`, `canonical-${id}`]
      );
    }
    const eventId = randomUUID();
    await pool.query(
      `insert into memory_events
       (id,owner_user_id,visibility,event_type,capture_method,session_id,payload)
       values($1,$2,'personal','captured','transcript',$3,'{}'::jsonb)`,
      [eventId, owner.id, chat.id]
    );
    const assertions = [
      { id: randomUUID(), type: "conversation_item", sourceId: itemId },
      { id: randomUUID(), type: "memory_event", sourceId: eventId },
      { id: randomUUID(), type: "conversation_item", sourceId: noteItemId }
    ] as const;
    for (const assertion of assertions) {
      await pool.query(
        `insert into curated_memory_assertions
         (id,owner_user_id,visibility,assertion_text,normalized_assertion)
         values($1,$2,'personal','Late evidence',$3)`,
        [assertion.id, owner.id, `late-${assertion.id}`]
      );
      await pool.query(
        `insert into curated_memory_sources
         (assertion_id,source_type,source_role,conversation_item_id,memory_event_id)
         values($1,$2,'primary_evidence',$3,$4)`,
        [
          assertion.id,
          assertion.type,
          assertion.type === "conversation_item" ? assertion.sourceId : null,
          assertion.type === "memory_event" ? assertion.sourceId : null
        ]
      );
    }
    const active = async () => {
      const result = await pool.query<{ id: string; active: boolean }>(
        `select cma.id,${activeCuratedMemoryEvidencePredicate("cma")} as active
         from curated_memory_assertions cma where cma.id=any($1::uuid[])`,
        [assertions.map((assertion) => assertion.id)]
      );
      return new Map(result.rows.map((row) => [row.id, row.active]));
    };
    const forgotten = await active();
    expect(forgotten.get(assertions[0].id)).toBe(false);
    expect(forgotten.get(assertions[1].id)).toBe(false);
    expect(forgotten.get(assertions[2].id)).toBe(true);
    await forget.undoForgetChat(owner.id, chat.id, started.batch_id);
    const restored = await active();
    expect(restored.get(assertions[0].id)).toBe(true);
    expect(restored.get(assertions[1].id)).toBe(true);
    expect(restored.get(assertions[2].id)).toBe(true);
  });

  it("hides mixed summaries, ancestors, direct nodes and legacy messages while retaining independent chat recall", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-mixed-${randomUUID()}@example.test`
    });
    const chatA = await memory.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex",
        captureMethod: "transcript"
      }
    );
    const chatB = await memory.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex",
        captureMethod: "transcript"
      }
    );
    const eventA = await memory.createMemoryEvent(
      { userId: owner.id },
      {
        projectId: "hq106-mixed",
        sessionId: chatA.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content: "Chat A private albatross detail.",
        visibility: "personal"
      }
    );
    const eventB = await memory.createMemoryEvent(
      { userId: owner.id },
      {
        projectId: "hq106-mixed",
        sessionId: chatB.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content: "Chat B independent otter detail.",
        visibility: "personal"
      }
    );
    const mixed = await memory.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "albatross and otter together",
        sourceHash: randomUUID()
      }
    );
    const independentB = await memory.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "otter independent",
        sourceHash: randomUUID()
      }
    );
    const parent = await memory.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "parent albatross and otter",
        sourceHash: randomUUID()
      }
    );
    const directA = await memory.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "direct albatross",
        sourceHash: randomUUID()
      }
    );
    await pool.query(
      `insert into memory_node_sources(memory_node_id,memory_event_id,source_order)
       values ($1,$2,0),($1,$3,1),($4,$3,0)`,
      [mixed.id, eventA.id, eventB.id, independentB.id]
    );
    await pool.query(
      `insert into memory_node_children(parent_memory_node_id,child_memory_node_id,child_order)
       values($1,$2,0)`,
      [parent.id, mixed.id]
    );
    await pool.query("update memory_nodes set session_id=$2 where id=$1", [
      directA.id,
      chatA.id
    ]);
    await embedNode(pool, memory, owner.id, mixed);
    await embedNode(pool, memory, owner.id, independentB);
    const messageA = randomUUID();
    const messageB = randomUUID();
    await pool.query(
      `insert into messages(id,session_id,owner_user_id,role,content,source_runtime,capture_method)
       values($1,$3,$5,'user','legacy albatross message','codex','transcript'),
             ($2,$4,$5,'user','legacy otter message','codex','transcript')`,
      [messageA, messageB, chatA.id, chatB.id, owner.id]
    );
    for (const [id, text] of [
      [messageA, "legacy albatross message"],
      [messageB, "legacy otter message"]
    ] as const) {
      await memory.upsertSourceEmbedding({
        source: {
          sourceType: "message",
          sourceId: id,
          ownerUserId: owner.id,
          visibility: "personal",
          text,
          sourceHash: randomUUID()
        },
        model: "qwen3-0.6b",
        modelArtifactHash: "a".repeat(64),
        dimensions: 1024,
        version: "qwen3-0.6b",
        tokenizer: "qwen3-embedding-0.6b-gguf",
        inputTransform: "qwen3-retrieval-document-v1",
        pooling: "last",
        normalization: "l2",
        vector
      });
    }
    const assertionId = randomUUID();
    await pool.query(
      `insert into curated_memory_assertions(id,owner_user_id,visibility,assertion_text,normalized_assertion)
       values($1,$2,'personal','Parent mixed fact',$3)`,
      [assertionId, owner.id, `mixed-${assertionId}`]
    );
    await pool.query(
      `insert into curated_memory_sources(assertion_id,source_type,source_role,lcm_node_id)
       values($1,'lcm_summary','primary_evidence',$2)`,
      [assertionId, parent.id]
    );
    const search = (stage: "leaf_search" | "raw_fallback_search") =>
      memory.searchMemoryNodes(
        { userId: owner.id },
        {
          scope: "personal",
          query: "albatross otter",
          searchDomain: "global",
          retrievalStage: stage,
          limit: 20
        }
      );
    expect(
      (await search("leaf_search")).results.map((row) => row.sourceId)
    ).toContain(mixed.id);
    expect(
      (await search("raw_fallback_search")).results.map((row) => row.sourceId)
    ).toContain(messageA);
    const forget = createChatForgetRepository(pool);
    const operationA = await forget.beginForgetChat(owner.id, chatA.id);
    const completeA = await forget.completeForgetChat(
      owner.id,
      chatA.id,
      operationA.batch_id
    );
    expect(completeA.suppressedAssertionIds).toContain(assertionId);
    const hidden = await pool.query<{
      id: string;
      personal_deleted_at: Date | null;
    }>(
      `select id,personal_deleted_at from memory_nodes where id=any($1::uuid[])`,
      [[mixed.id, parent.id, directA.id, independentB.id]]
    );
    expect(
      hidden.rows
        .filter((row) => row.personal_deleted_at)
        .map((row) => row.id)
        .sort()
    ).toEqual([mixed.id, parent.id, directA.id].sort());
    expect(
      (await search("leaf_search")).results.map((row) => row.sourceId)
    ).not.toContain(mixed.id);
    expect(
      (await search("leaf_search")).results.map((row) => row.sourceId)
    ).toContain(independentB.id);
    const rawAfterA = (await search("raw_fallback_search")).results.map(
      (row) => row.sourceId
    );
    expect(rawAfterA).not.toContain(messageA);
    expect(rawAfterA).toContain(messageB);
    const operationB = await forget.beginForgetChat(owner.id, chatB.id);
    await forget.completeForgetChat(owner.id, chatB.id, operationB.batch_id);
    await forget.undoForgetChat(owner.id, chatA.id, completeA.batchId);
    expect(
      (await search("leaf_search")).results.map((row) => row.sourceId)
    ).not.toContain(mixed.id);
    await expect(
      memory.expandMemoryNode(mixed.id, { userId: owner.id })
    ).rejects.toThrow("Memory node not found or not visible");
    await expect(
      memory.expandMemoryNode(parent.id, { userId: owner.id })
    ).rejects.toThrow("Memory node not found or not visible");
    const activeWhileBIsForgotten = await pool.query<{ active: boolean }>(
      `select ${activeCuratedMemoryEvidencePredicate("cma")} as active
       from curated_memory_assertions cma where id=$1`,
      [assertionId]
    );
    expect(activeWhileBIsForgotten.rows[0]?.active).toBe(false);
    const deferred = await pool.query<{
      status: string;
      suppressed_at: string;
    }>(
      `select status,suppressed_at::text as suppressed_at
       from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    expect(deferred.rows[0]?.status).toBe("suppressed");
    const reconcileClient = await pool.connect();
    try {
      await reconcileClient.query("begin");
      expect(
        await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
          reconcileClient,
          { userId: owner.id },
          undefined,
          [assertionId]
        )
      ).toEqual([]);
      await reconcileClient.query("commit");
    } catch (error) {
      await reconcileClient.query("rollback");
      throw error;
    } finally {
      reconcileClient.release();
    }
    const afterReconcile = await pool.query<{
      status: string;
      suppressed_at: string;
    }>(
      `select status,suppressed_at::text as suppressed_at
       from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    expect(afterReconcile.rows[0]).toEqual(deferred.rows[0]);
    await forget.undoForgetChat(owner.id, chatB.id, operationB.batch_id);
    const afterBothUndo = await pool.query<{
      status: string;
      suppression_reason: string | null;
    }>(
      `select status,suppression_reason from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    expect(afterBothUndo.rows[0]).toEqual({
      status: "current",
      suppression_reason: null
    });
    await expect(
      memory.expandMemoryNode(mixed.id, { userId: owner.id })
    ).resolves.toBeDefined();
    await expect(
      memory.expandMemoryNode(parent.id, { userId: owner.id })
    ).resolves.toBeDefined();
    expect(
      (await search("leaf_search")).results.map((row) => row.sourceId)
    ).toContain(mixed.id);
    expect(
      (await search("raw_fallback_search")).results.map((row) => row.sourceId)
    ).toContain(messageA);
  });

  it("serializes concurrent Undo of chats sharing a deferred Curated assertion", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-concurrent-${randomUUID()}@example.test`
    });
    const sessions = await Promise.all(
      [0, 1].map(() =>
        memory.createCapturedSession(
          { userId: owner.id },
          {
            externalSessionId: randomUUID(),
            sourceRuntime: "codex",
            captureMethod: "transcript"
          }
        )
      )
    );
    const events = await Promise.all(
      sessions.map((session, index) =>
        memory.createMemoryEvent(
          { userId: owner.id },
          {
            projectId: "hq106-concurrent",
            sessionId: session.id,
            actor: "user",
            eventType: "captured",
            rawEventType: "user_message",
            content: `Shared source ${index}`,
            visibility: "personal"
          }
        )
      )
    );
    const mixed = await memory.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "Shared summary",
        sourceHash: randomUUID()
      }
    );
    await pool.query(
      `insert into memory_node_sources(memory_node_id,memory_event_id,source_order)
       values($1,$2,0),($1,$3,1)`,
      [mixed.id, events[0]!.id, events[1]!.id]
    );
    const assertionId = randomUUID();
    await pool.query(
      `insert into curated_memory_assertions
       (id,owner_user_id,visibility,assertion_text,normalized_assertion)
       values($1,$2,'personal','Shared concurrent fact',$3)`,
      [assertionId, owner.id, `concurrent-${assertionId}`]
    );
    await pool.query(
      `insert into curated_memory_sources(assertion_id,source_type,source_role,lcm_node_id)
       values($1,'lcm_summary','primary_evidence',$2)`,
      [assertionId, mixed.id]
    );
    const forget = createChatForgetRepository(pool);
    const batches: string[] = [];
    for (const session of sessions) {
      const begun = await forget.beginForgetChat(owner.id, session.id);
      await forget.completeForgetChat(owner.id, session.id, begun.batch_id);
      batches.push(begun.batch_id);
    }
    await Promise.all(
      sessions.map((session, index) =>
        forget.undoForgetChat(owner.id, session.id, batches[index]!)
      )
    );
    const assertion = await pool.query<{
      status: string;
      suppression_reason: string | null;
    }>(
      `select status,suppression_reason from curated_memory_assertions where id=$1`,
      [assertionId]
    );
    expect(assertion.rows[0]).toEqual({
      status: "current",
      suppression_reason: null
    });
  });

  it("reserves Forget before stopping an active execution and fences late prompts", async () => {
    const memory = createMemorySourceRepository(pool);
    const owner = await memory.createUser({
      email: `hq106-${randomUUID()}@example.test`
    });
    const logicalSessionId = randomUUID();
    const session = await memory.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: randomUUID(),
        logicalSessionId,
        sourceRuntime: "codex",
        captureMethod: "transcript"
      }
    );
    const executionId = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions
       (id,owner_user_id,project_id,state,state_version,logical_session_id,
        provider_thread_id,fencing_token_hash,runner_deployment_id,
        runner_device_id,ai_client_instance_id,model,permission_mode,runner_kind)
       values ($1,$2,$3,'running',1,$4,$5,$6,$7,$8,'client','model',
               'supervised','local_device')`,
      [
        executionId,
        owner.id,
        `local-${randomUUID()}`,
        logicalSessionId,
        "provider-thread",
        "a".repeat(64),
        randomUUID(),
        randomUUID()
      ]
    );
    const forget = createChatForgetRepository(pool);
    const operation = await forget.beginForgetChat(owner.id, session.id);
    await expect(
      createChatDeleteRepository(pool).beginChatDelete(
        owner.id,
        session.id,
        randomUUID()
      )
    ).rejects.toThrow("Conversation Forget is already in progress");
    expect(operation.execution_manifest).toEqual([
      { id: executionId, executionGeneration: 1 }
    ]);
    const managed = createManagedConversationRepository(pool, {});
    await expect(
      managed.enqueueManagedConversationPrompt(
        { userId: owner.id },
        {
          executionId,
          executionGeneration: 1,
          idempotencyKey: `forget-blocked-${randomUUID()}`,
          clientUserMessageId: randomUUID(),
          prompt: "Late command"
        }
      )
    ).rejects.toThrow("Conversation lifecycle blocks new work");
    const stop = await managed.enqueueManagedConversationControl(
      { userId: owner.id },
      {
        executionId,
        executionGeneration: 1,
        idempotencyKey: `chat-forget:${operation.batch_id}:${executionId}`,
        commandKind: "stop"
      }
    );
    expect(stop.commandKind).toBe("stop");
    await expect(
      forget.completeForgetChat(owner.id, session.id, operation.batch_id)
    ).rejects.toThrow("Execution stop acknowledgments are incomplete");
    await pool.query(
      `update managed_conversation_executions
         set state='stopped',state_version=2,stopped_at=now()
       where owner_user_id=$1 and id=$2`,
      [owner.id, executionId]
    );
    await forget.recordForgetRuntimeAck(
      owner.id,
      session.id,
      operation.batch_id,
      {
        executionId,
        executionGeneration: 1,
        state: "stopped",
        stateVersion: 2
      }
    );
    await forget.completeForgetChat(owner.id, session.id, operation.batch_id);
  });
});
