import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type pg from "pg";
import { createMemoryEngine } from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  localRerankingEnabled,
  presentMemoryText,
  type MemorySourceRepository
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const runDbTests = Boolean(databaseUrl);
const originalLeafEventThreshold = process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
const originalLeafTokenThreshold = process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
const originalFreshEventTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
const originalDepthOneFanout = process.env.MEMORY_LCM_DEPTH1_FANOUT;
const originalMemoryEventMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
const originalEmbeddingMaxTokens = process.env.EMBEDDING_MAX_TOKENS;

const describeDb = runDbTests ? describe : describe.skip;

describe("memory presentation helpers", () => {
  it("keeps reranking disabled by default and honors the documented root key", () => {
    expect(localRerankingEnabled({})).toBe(false);
    expect(
      localRerankingEnabled({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b"
      })
    ).toBe(true);
    expect(
      localRerankingEnabled({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        RERANKER_KEY: ""
      })
    ).toBe(false);
    expect(
      localRerankingEnabled({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        RERANKER_KEY: "qwen3-reranker-0.6b"
      })
    ).toBe(true);
  });

  const provenance = {
    project_name: "/Users/jacobo/Coding/koed",
    project_path: "/Users/jacobo/Coding/koed"
  };

  it("does not expose raw tool input JSON as memory text", () => {
    const text = presentMemoryText(
      JSON.stringify({
        toolInput: {
          command:
            "node --input-type=module <<'EOF'\nconsole.log('secret')\nEOF"
        }
      }),
      provenance
    );

    expect(text).toBe("Development activity captured in koed.");
    expect(text).not.toContain("toolInput");
    expect(text).not.toContain("node --input-type");
  });

  it("does not expose malformed tool payload text as memory text", () => {
    const text = presentMemoryText(
      `{"toolInput": {"command": "sed -n '1,140p' deploy/deploy-vps.sh"}, "toolResponse": "partial output...`,
      provenance
    );

    expect(text).toBe("Development activity captured in koed.");
    expect(text).not.toContain("toolResponse");
    expect(text).not.toContain("deploy-vps.sh");
  });

  it("unwraps LCM source outlines without showing internal scaffolding", () => {
    const text = presentMemoryText(
      [
        "LCM depth 0 leaf summary",
        "Source items: 1",
        "",
        "Exact ordered source outline:",
        "- [event memory_events:abc] user: Jacobo prefers concise memory cards."
      ].join("\n"),
      provenance
    );

    expect(text).toBe("Jacobo prefers concise memory cards.");
  });

  it("shows the Codex request instead of uploaded-file boilerplate", () => {
    const text = presentMemoryText(
      [
        "# Files mentioned by the user:",
        "",
        "## CleanShot.png: /Users/jacobo/Library/Application Support/CleanShot/media/file.png",
        "",
        "## My request for Codex:",
        "Can you please find out what is missing on the setup?",
        "<image name=[Image #1]>raw image metadata</image>"
      ].join("\n"),
      provenance
    );

    expect(text).toBe("Can you please find out what is missing on the setup?");
  });
});

describe("local embedding status", () => {
  const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
  const originalEmbeddingServiceToken = process.env.EMBEDDING_SERVICE_TOKEN;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEmbeddingServiceUrl === undefined) {
      delete process.env.EMBEDDING_SERVICE_URL;
    } else {
      process.env.EMBEDDING_SERVICE_URL = originalEmbeddingServiceUrl;
    }
    if (originalEmbeddingServiceToken === undefined) {
      delete process.env.EMBEDDING_SERVICE_TOKEN;
    } else {
      process.env.EMBEDDING_SERVICE_TOKEN = originalEmbeddingServiceToken;
    }
  });

  it("reports embedding health as unhealthy when the service rejects the configured token", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_TOKEN = "api-token";
    const repo = createMemorySourceRepository({} as pg.Pool);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "qwen3-0.6b",
          dimensions: 1024,
          authRequired: true,
          authValid: false
        }),
        { status: 200 }
      )
    );

    await expect(repo.getLocalEmbeddingStatus()).resolves.toMatchObject({
      enabled: true,
      healthy: false,
      model: "qwen3-0.6b",
      dimensions: 1024,
      error: "Embedding service token rejected"
    });
    expect(
      new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get(
        "x-koed-embedding-token"
      )
    ).toBe("api-token");
  });

  it("reports embedding health as healthy when token authentication succeeds", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_TOKEN = "api-token";
    const repo = createMemorySourceRepository({} as pg.Pool);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "qwen3-0.6b",
          dimensions: 1024,
          authRequired: true,
          authValid: true
        }),
        { status: 200 }
      )
    );

    await expect(repo.getLocalEmbeddingStatus()).resolves.toMatchObject({
      enabled: true,
      healthy: true,
      model: "qwen3-0.6b",
      dimensions: 1024
    });
  });
});

describeDb("memory repository visibility", () => {
  let pool: pg.Pool;
  let repo: MemorySourceRepository;

  const captureUserEvent = (
    engine: ReturnType<typeof createMemoryEngine>,
    userId: string,
    input: {
      workspaceId: string;
      content: string;
      sessionId?: string;
      actor?: "user" | "assistant" | "agent" | "subagent" | "tool" | "system";
      visibility?: "personal";
      metadata?: Record<string, unknown>;
    }
  ) =>
    engine.capturePersonalEvent({
      requesterContext: { userId },
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: input.actor ?? "user",
      eventType: "user_prompt",
      content: input.content,
      visibility: input.visibility,
      metadata: input.metadata
    });

  const embedPendingSources = async () => {
    const dimensions = 1024;
    const vector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const sources = await repo.listSourcesNeedingEmbeddings(500);
    for (const source of sources) {
      await repo.upsertSourceEmbedding({
        source,
        model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        dimensions,
        version: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        vector
      });
    }
  };

  const mockEmbeddingQuery = () => {
    const dimensions = 1024;
    const vector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
          dimensions,
          vectors: [vector]
        }),
        { status: 200 }
      )
    );
  };

  beforeAll(async () => {
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "5";
    process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = "6000";
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";
    process.env.MEMORY_LCM_DEPTH1_FANOUT = "2";
    pool = createDbPool({ connectionString: databaseUrl });
    repo = createMemorySourceRepository(pool);

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(currentDir, "migrations");
    const migrations = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const migrationFile of migrations) {
      const migration = await readFile(
        join(migrationsDir, migrationFile),
        "utf8"
      );
      await pool.query(migration);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query(
      `
        truncate table
          audit_events,
          api_tokens,
          memory_questions,
          memory_embeddings_3072,
          memory_embeddings_1536,
          memory_embeddings_1024,
          memory_embeddings_384,
          memory_embeddings,
          memory_node_children,
          memory_node_sources,
          memory_event_sources,
          workflow_token_usage_source_references,
          workflow_token_usage,
          memory_nodes,
          memory_events,
          conversation_items,
          tool_events,
          messages,
          turns,
          sessions,
          workspaces,
          user_sessions,
          users
        restart identity cascade
      `
    );
  });

  afterAll(async () => {
    if (originalLeafEventThreshold === undefined) {
      delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    } else {
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = originalLeafEventThreshold;
    }
    if (originalLeafTokenThreshold === undefined) {
      delete process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
    } else {
      process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = originalLeafTokenThreshold;
    }
    if (originalFreshEventTail === undefined) {
      delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    } else {
      process.env.MEMORY_LCM_FRESH_EVENT_TAIL = originalFreshEventTail;
    }
    if (originalDepthOneFanout === undefined) {
      delete process.env.MEMORY_LCM_DEPTH1_FANOUT;
    } else {
      process.env.MEMORY_LCM_DEPTH1_FANOUT = originalDepthOneFanout;
    }
    if (originalMemoryEventMaxTokens === undefined) {
      delete process.env.MEMORY_EVENT_MAX_TOKENS;
    } else {
      process.env.MEMORY_EVENT_MAX_TOKENS = originalMemoryEventMaxTokens;
    }
    if (originalEmbeddingMaxTokens === undefined) {
      delete process.env.EMBEDDING_MAX_TOKENS;
    } else {
      process.env.EMBEDDING_MAX_TOKENS = originalEmbeddingMaxTokens;
    }
    await pool?.end();
  });

  it("filters personal memory to the owning user", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-${randomUUID()}@example.com`
    });

    await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Alice private memory",
        captureMethod: "hook",
        sourceRuntime: "codex",
        codexTranscriptPath: "/tmp/codex/transcript.jsonl",
        idempotencyKey: `hook:${randomUUID()}`,
        sourceHash: randomUUID()
      }
    );

    const aliceMemories = await repo.listVisibleMemoryNodes({
      userId: alice.id
    });
    const bobMemories = await repo.listVisibleMemoryNodes({ userId: bob.id });

    expect(aliceMemories).toHaveLength(1);
    expect(aliceMemories[0]?.summaryText).toBe("Alice private memory");
    expect(bobMemories).toHaveLength(0);
  });

  it("keeps personal memory boundaries across read, delete, export, and expansion paths", async () => {
    const alice = await repo.createUser({
      email: `alice-boundary-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    const aliceEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: "workspace-personal-boundary",
      content: "Alice-only source evidence."
    });
    const bobEvent = await captureUserEvent(engine, bob.id, {
      workspaceId: "workspace-personal-boundary",
      content: "Bob source evidence must not leak through Alice expansion."
    });
    const invalidatedAliceEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: "workspace-personal-boundary",
      content: "Invalidated Alice evidence must not expand."
    });
    await repo.invalidateLcmGraphEvent(
      { userId: alice.id },
      invalidatedAliceEvent.id
    );

    const aliceNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Alice-only memory node",
        captureMethod: "hook",
        sourceRuntime: "codex"
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($1, $3, 1), ($1, $4, 2)
      `,
      [aliceNode.id, aliceEvent.id, bobEvent.id, invalidatedAliceEvent.id]
    );

    expect(
      await repo.getVisibleMemoryNode({ userId: bob.id }, aliceNode.id)
    ).toBeNull();
    expect(await repo.deleteMemory({ userId: bob.id }, aliceNode.id)).toBe(
      false
    );
    expect(
      await repo.updateMemoryPresentation({ userId: bob.id }, aliceNode.id, {
        summaryText: "Bob rewrite attempt"
      })
    ).toBeNull();
    await expect(
      engine.expandMemoryNode(aliceNode.id, { userId: bob.id })
    ).rejects.toThrow("Memory node not found or not visible");

    const bobExport = await repo.exportMemoryRecords({ userId: bob.id });
    expect(bobExport.nodes.map((node) => node.id)).not.toContain(aliceNode.id);
    expect(bobExport.events.map((event) => event.id)).not.toContain(
      aliceEvent.id
    );

    const aliceExpanded = await engine.expandMemoryNode(aliceNode.id, {
      userId: alice.id
    });
    expect(aliceExpanded.sources.map((source) => source.content)).toEqual([
      "Alice-only source evidence."
    ]);
  });

  it("captures personal facts, compacts, searches, answers, and expands a cited node", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 10; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-personal",
        content: `Personal fact ${index}: Alice project codename is Aurora-${index}.`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    expect(compacted.leafNodeIds).toHaveLength(2);
    expect(compacted.rollupNodeId).not.toBeNull();
    await embedPendingSources();

    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "Aurora",
      scope: "personal",
      limit: 10
    });
    expect(search.results[0]?.citation.visibility).toBe("personal");

    const answer = await engine.answerMemory({
      requesterContext: { userId: alice.id },
      query: "Aurora",
      scope: "personal",
      limit: 10
    });
    expect(answer.answer).toContain("Personal fact");
    expect(answer.citations[0]?.visibility).toBe("personal");

    const expanded = await engine.expandMemoryNode(search.results[0]!.nodeId, {
      userId: alice.id
    });
    expect(
      expanded.sourceItems.some(
        (item) =>
          item.kind === "memory_event" && item.sourceTable === "memory_events"
      )
    ).toBe(true);
    expect(
      expanded.sources.some((source) =>
        source.content.startsWith("Personal fact ")
      )
    ).toBe(true);
    expect(expanded.sources.map((source) => source.content)).toEqual(
      [...expanded.sources]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((source) => source.content)
    );
  });

  it("packs LCM leaves on semantic memory event boundaries without crossing the token threshold", async () => {
    const previousLeafEventThreshold =
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    const previousLeafTokenThreshold =
      process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
    const previousFreshTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    const previousFanout = process.env.MEMORY_LCM_DEPTH1_FANOUT;
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "100";
    process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = "120";
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";
    process.env.MEMORY_LCM_DEPTH1_FANOUT = "20";

    try {
      const alice = await repo.createUser({
        email: `alice-lcm-boundary-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const content = (index: number) =>
        `Semantic memory event ${index}: ${"boundary ".repeat(80)}`;

      for (let index = 1; index <= 3; index += 1) {
        await captureUserEvent(engine, alice.id, {
          workspaceId: "workspace-lcm-boundary",
          content: content(index),
          metadata: { index }
        });
      }

      const compacted = await engine.scheduleCompaction({
        requesterContext: { userId: alice.id },
        visibility: "personal"
      });
      expect(compacted.leafNodeIds).toHaveLength(2);

      const leaves = await pool.query<{
        id: string;
        source_event_count: number;
        source_token_estimate: number;
        source_items_json: unknown;
      }>(
        `
          select id, source_event_count, source_token_estimate, source_items_json
          from memory_nodes
          where id = any($1::uuid[])
          order by created_at asc, id asc
        `,
        [compacted.leafNodeIds]
      );

      expect(leaves.rows.map((row) => row.source_event_count)).toEqual([1, 1]);
      expect(leaves.rows.every((row) => row.source_token_estimate <= 120)).toBe(
        true
      );
      let sourceItemCount = 0;
      for (const row of leaves.rows) {
        if (Array.isArray(row.source_items_json)) {
          sourceItemCount += row.source_items_json.length;
        }
      }
      expect(sourceItemCount).toBe(2);
    } finally {
      if (previousLeafEventThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD =
          previousLeafEventThreshold;
      }
      if (previousLeafTokenThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD =
          previousLeafTokenThreshold;
      }
      if (previousFreshTail === undefined) {
        delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
      } else {
        process.env.MEMORY_LCM_FRESH_EVENT_TAIL = previousFreshTail;
      }
      if (previousFanout === undefined) {
        delete process.env.MEMORY_LCM_DEPTH1_FANOUT;
      } else {
        process.env.MEMORY_LCM_DEPTH1_FANOUT = previousFanout;
      }
    }
  });

  it("uses semantic source text rather than provenance payloads for LCM token estimates", async () => {
    const previousLeafEventThreshold =
      process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
    const previousLeafTokenThreshold =
      process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
    const previousFreshTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD = "1";
    process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD = "6000";
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";

    try {
      const alice = await repo.createUser({
        email: `alice-lcm-token-text-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-lcm-token-text",
        content: "Small semantic source text.",
        metadata: {
          provenanceNoise: "metadata noise ".repeat(10_000)
        }
      });

      const compacted = await engine.scheduleCompaction({
        requesterContext: { userId: alice.id },
        visibility: "personal"
      });
      const node = await pool.query<{
        source_token_estimate: number;
        source_items_json: unknown;
      }>(
        `
          select source_token_estimate, source_items_json
          from memory_nodes
          where id = $1
        `,
        [compacted.leafNodeIds[0]]
      );

      expect(node.rows[0]?.source_token_estimate).toBeLessThan(100);
      expect(JSON.stringify(node.rows[0]?.source_items_json)).toContain(
        event.id
      );
      expect(JSON.stringify(node.rows[0]?.source_items_json)).toContain(
        "provenanceNoise"
      );
    } finally {
      if (previousLeafEventThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD =
          previousLeafEventThreshold;
      }
      if (previousLeafTokenThreshold === undefined) {
        delete process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
      } else {
        process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD =
          previousLeafTokenThreshold;
      }
      if (previousFreshTail === undefined) {
        delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
      } else {
        process.env.MEMORY_LCM_FRESH_EVENT_TAIL = previousFreshTail;
      }
    }
  });

  it("stores multiple embedding chunks for one logical source", async () => {
    const alice = await repo.createUser({
      email: `alice-chunks-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId: "workspace-chunks",
      content: "Chunkable source text alpha beta gamma."
    });
    const source = await repo.getEmbeddableSource("memory_event", event.id);
    expect(source).not.toBeNull();

    const dimensions = 1024;
    const firstVector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const secondVector = Array.from({ length: dimensions }, (_, index) =>
      index === 1 ? 1 : 0
    );
    const model = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
    const version = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";

    await repo.upsertSourceEmbedding({
      source: source!,
      model,
      dimensions,
      version,
      vector: firstVector,
      chunkIndex: 0,
      chunkCount: 2,
      sourceText: "Chunkable source text alpha."
    });
    await repo.upsertSourceEmbedding({
      source: source!,
      model,
      dimensions,
      version,
      vector: secondVector,
      chunkIndex: 1,
      chunkCount: 2,
      sourceText: "Chunkable source text beta gamma."
    });

    const stored = await pool.query<{
      source_chunk_index: number;
      source_chunk_count: number;
      source_text: string;
    }>(
      `
        select source_chunk_index, source_chunk_count, source_text
        from memory_embeddings
        where memory_event_id = $1
        order by source_chunk_index asc
      `,
      [event.id]
    );
    expect(stored.rows).toEqual([
      {
        source_chunk_index: 0,
        source_chunk_count: 2,
        source_text: "Chunkable source text alpha."
      },
      {
        source_chunk_index: 1,
        source_chunk_count: 2,
        source_text: "Chunkable source text beta gamma."
      }
    ]);

    const pending = await repo.listSourcesNeedingEmbeddings(50);
    expect(pending.some((candidate) => candidate.sourceId === event.id)).toBe(
      false
    );
  });

  it("displays stored LCM summaries instead of node embedding chunk text", async () => {
    const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";

    try {
      const dimensions = 1024;
      const queryVector = Array.from({ length: dimensions }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
            dimensions,
            vectors: [queryVector]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );

      const alice = await repo.createUser({
        email: `alice-lcm-display-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-lcm-display",
        content: "Koed is being run in Docker for local testing."
      });
      const node = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText:
            "Clean LCM summary: Koed is being run in Docker for local testing.",
          summaryModel: "codex:test"
        }
      );
      await pool.query(
        "insert into memory_node_sources (memory_node_id, memory_event_id, source_order) values ($1, $2, 0)",
        [node.id, event.id]
      );
      const source = await repo.getEmbeddableSource("memory_node", node.id);
      expect(source).not.toBeNull();

      await repo.upsertSourceEmbedding({
        source: source!,
        model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        dimensions,
        version: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
        vector: queryVector,
        sourceText: [
          "LCM depth 0 leaf summary",
          "Source items: 100",
          "",
          "Exact ordered source outline:",
          "- [memory_event abc] tool: Tool call internal outline text"
        ].join("\n")
      });

      const search = await engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "Is Koed running in Docker?",
        scope: "personal",
        searchDomain: "global",
        limit: 1
      });

      expect(search.results[0]?.sourceType).toBe("memory_node");
      expect(search.results[0]?.summaryText).toBe(
        "Clean LCM summary: Koed is being run in Docker for local testing."
      );
      expect(search.results[0]?.summaryText).not.toContain(
        "Exact ordered source outline"
      );
    } finally {
      if (originalEmbeddingServiceUrl === undefined) {
        delete process.env.EMBEDDING_SERVICE_URL;
      } else {
        process.env.EMBEDDING_SERVICE_URL = originalEmbeddingServiceUrl;
      }
    }
  });

  it("keeps non-rerankable vector hits when summary reranking is enabled", async () => {
    const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
    const originalRerankerKey = process.env.RERANKER_KEY;
    const originalEmbeddingServiceToken = process.env.EMBEDDING_SERVICE_TOKEN;
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.RERANKER_KEY = "qwen3-reranker-0.6b";
    process.env.EMBEDDING_SERVICE_TOKEN = "test-embedding-token";

    try {
      const dimensions = 1024;
      const queryVector = Array.from({ length: dimensions }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const endpoint = String(url);
        if (endpoint.endsWith("/embed")) {
          const headers = new Headers(init?.headers);
          expect(headers.get("x-koed-embedding-token")).toBe(
            "test-embedding-token"
          );
          expect(headers.get("x-koed-embedding-priority")).toBe("interactive");
          return new Response(
            JSON.stringify({
              model: process.env.EMBEDDING_MODEL ?? "qwen3-0.6b",
              dimensions,
              vectors: [queryVector]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }
        if (endpoint.endsWith("/rerank")) {
          expect(new Headers(init?.headers).get("x-koed-embedding-token")).toBe(
            "test-embedding-token"
          );
          const request = JSON.parse(String(init?.body ?? "{}")) as {
            documents?: string[];
          };
          expect(request.documents).toEqual([
            "Completed summary about archived preferences."
          ]);
          return new Response(
            JSON.stringify({
              model: "test-reranker",
              scores: [0.1]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }
        return new Response(JSON.stringify({ detail: "unexpected endpoint" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      });

      const alice = await repo.createUser({
        email: `alice-rerank-${randomUUID()}@example.com`
      });
      const engine = createMemoryEngine(repo);
      const completedNode = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText: "Completed summary about archived preferences.",
          summaryModel: "codex:test"
        }
      );
      const freshEvent = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-rerank",
        content:
          "Fresh raw event says the favourite footballer is Paul McGrath."
      });
      const nodeSource = await repo.getEmbeddableSource(
        "memory_node",
        completedNode.id
      );
      const eventSource = await repo.getEmbeddableSource(
        "memory_event",
        freshEvent.id
      );
      expect(nodeSource).not.toBeNull();
      expect(eventSource).not.toBeNull();
      const model = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
      const version = process.env.EMBEDDING_MODEL ?? "qwen3-0.6b";
      await repo.upsertSourceEmbedding({
        source: nodeSource!,
        model,
        dimensions,
        version,
        vector: queryVector
      });
      await repo.upsertSourceEmbedding({
        source: eventSource!,
        model,
        dimensions,
        version,
        vector: queryVector
      });

      const search = await engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "Who is the favourite footballer?",
        scope: "personal",
        searchDomain: "global",
        limit: 2
      });

      expect(search.metadata.retrievalMode).toBe("semantic_vector_reranked");
      expect(search.metadata.rerankedCount).toBe(1);
      expect(search.results.map((result) => result.sourceType)).toContain(
        "memory_event"
      );
      expect(search.results.map((result) => result.summaryText)).toContain(
        "Fresh raw event says the favourite footballer is Paul McGrath."
      );
    } finally {
      if (originalEmbeddingServiceUrl === undefined) {
        delete process.env.EMBEDDING_SERVICE_URL;
      } else {
        process.env.EMBEDDING_SERVICE_URL = originalEmbeddingServiceUrl;
      }
      if (originalRerankerKey === undefined) {
        delete process.env.RERANKER_KEY;
      } else {
        process.env.RERANKER_KEY = originalRerankerKey;
      }
      if (originalEmbeddingServiceToken === undefined) {
        delete process.env.EMBEDDING_SERVICE_TOKEN;
      } else {
        process.env.EMBEDDING_SERVICE_TOKEN = originalEmbeddingServiceToken;
      }
    }
  });

  it("does not duplicate identical LCM summary and body text for node embeddings", async () => {
    const alice = await repo.createUser({
      email: `alice-node-source-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 5; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-node-source",
        content: `Node source fact ${index}: Paul McGrath was mentioned.`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    const nodeId = compacted.leafNodeIds[0];
    expect(nodeId).toBeTruthy();

    const source = await repo.getEmbeddableSource("memory_node", nodeId!);
    expect(source).not.toBeNull();
    const text = source!.text;
    const firstIndex = text.indexOf("Node source fact 1");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Node source fact 1", firstIndex + 1)).toBe(-1);
  });

  it("stores child links and ordered source outlines for LCM rollups", async () => {
    const alice = await repo.createUser({
      email: `alice-rollup-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 20; index += 1) {
      await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-rollup",
        content: `Rollup source ${index}`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    expect(compacted.rollupNodeId).not.toBeNull();

    const childLinks = await pool.query<{ count: string }>(
      "select count(*) as count from memory_node_children where parent_memory_node_id = $1",
      [compacted.rollupNodeId]
    );
    expect(Number(childLinks.rows[0]?.count)).toBeGreaterThan(0);

    const expanded = await engine.expandMemoryNode(compacted.rollupNodeId!, {
      userId: alice.id
    });
    expect(expanded.sourceItems.some((item) => item.kind === "lcm_child")).toBe(
      true
    );
    expect(expanded.sources.map((source) => source.content)).toHaveLength(10);
    expect(expanded.sources[0]?.content).toMatch(/^Rollup source /);
  });

  it("filters hierarchical retrieval by source event time and only uses raw fallback when needed", async () => {
    const alice = await repo.createUser({
      email: `alice-recent-rag-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    const oldEventIds: string[] = [];
    const recentEventIds: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-recent-rag",
        content:
          index <= 5
            ? `Old-only temporal evidence ${index}.`
            : `Recent temporal evidence ${index}.`,
        metadata: { index }
      });
      if (index <= 5) {
        oldEventIds.push(event.id);
      } else {
        recentEventIds.push(event.id);
      }
    }

    await pool.query(
      "update memory_events set captured_at = now() - interval '45 days', created_at = now() where id = any($1::uuid[])",
      [oldEventIds]
    );
    await pool.query(
      "update memory_events set captured_at = now() - interval '2 days', created_at = now() where id = any($1::uuid[])",
      [recentEventIds]
    );

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });
    expect(compacted.rollupNodeId).not.toBeNull();
    await embedPendingSources();

    const oldLeaf = await pool.query<{ memory_node_id: string }>(
      `
        select mns.memory_node_id
        from memory_node_sources mns
        join memory_nodes mn on mn.id = mns.memory_node_id
        where mns.memory_event_id = $1
          and mn.kind = 'leaf'
        limit 1
      `,
      [oldEventIds[0]]
    );
    const recentLeaf = await pool.query<{ memory_node_id: string }>(
      `
        select mns.memory_node_id
        from memory_node_sources mns
        join memory_nodes mn on mn.id = mns.memory_node_id
        where mns.memory_event_id = $1
          and mn.kind = 'leaf'
        limit 1
      `,
      [recentEventIds[0]]
    );
    const oldLeafId = oldLeaf.rows[0]!.memory_node_id;
    const recentLeafId = recentLeaf.rows[0]!.memory_node_id;

    mockEmbeddingQuery();
    const recentSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "temporal evidence",
      scope: "personal",
      recentDays: 30,
      limit: 10
    });

    const resultNodeIds = recentSearch.results.map((result) => result.nodeId);
    expect(resultNodeIds).toContain(compacted.rollupNodeId);
    expect(resultNodeIds).toContain(recentLeafId);
    expect(resultNodeIds).not.toContain(oldLeafId);
    expect(
      recentSearch.results.some((result) =>
        result.summaryText.includes("Recent temporal evidence")
      )
    ).toBe(true);
    expect(
      recentSearch.results.some((result) =>
        result.summaryText.includes("Old-only temporal evidence")
      )
    ).toBe(false);
    expect(recentSearch.metadata.temporalFilter).toMatchObject({
      recentDays: 30
    });
    expect(recentSearch.metadata.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rollup_search",
          used: true,
          temporalFilterApplied: true
        }),
        expect.objectContaining({
          name: "raw_fallback_search",
          ran: true
        })
      ])
    );
    const expandedRecent = await engine.expandMemoryNode(
      compacted.rollupNodeId!,
      { userId: alice.id },
      { recentDays: 30 }
    );
    expect(
      expandedRecent.sourceItems.some((item) =>
        item.text?.includes("Recent temporal evidence")
      )
    ).toBe(true);
    expect(
      expandedRecent.sourceItems.some((item) =>
        item.text?.includes("Old-only temporal evidence")
      )
    ).toBe(false);
    expect(
      expandedRecent.sources.some((source) =>
        source.content.includes("Old-only temporal evidence")
      )
    ).toBe(false);

    mockEmbeddingQuery();
    const boundedSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "temporal evidence",
      scope: "personal",
      sourceAfter: new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000
      ).toISOString(),
      limit: 1
    });
    expect(boundedSearch.results[0]?.retrievalStage).toBe("rollup_search");
    expect(
      boundedSearch.metadata.stages?.find(
        (stage) => stage.name === "raw_fallback_search"
      )
    ).toMatchObject({ ran: true, used: false, selectedCount: 0 });

    mockEmbeddingQuery();
    const unboundedSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "temporal evidence",
      scope: "personal",
      limit: 10
    });
    expect(unboundedSearch.results.map((result) => result.nodeId)).toContain(
      oldLeafId
    );
    expect(unboundedSearch.metadata.temporalFilter).toBeUndefined();
  });

  it("requires the same node source to satisfy project and temporal filters", async () => {
    const alice = await repo.createUser({
      email: `alice-project-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const projectA = `workspace-project-a-${randomUUID()}`;
    const projectB = `workspace-project-b-${randomUUID()}`;

    const oldProjectA = await captureUserEvent(engine, alice.id, {
      workspaceId: projectA,
      content: "Boundary correlation project A old only.",
      metadata: { project: "a", age: "old" }
    });
    const recentProjectB = await captureUserEvent(engine, alice.id, {
      workspaceId: projectB,
      content: "Boundary correlation project B recent only.",
      metadata: { project: "b", age: "recent" }
    });
    const recentProjectA = await captureUserEvent(engine, alice.id, {
      workspaceId: projectA,
      content: "Boundary correlation project A recent valid.",
      metadata: { project: "a", age: "recent" }
    });

    await pool.query(
      "update memory_events set captured_at = now() - interval '45 days', created_at = now() where id = $1",
      [oldProjectA.id]
    );
    await pool.query(
      "update memory_events set captured_at = now() - interval '2 days', created_at = now() where id = any($1::uuid[])",
      [[recentProjectB.id, recentProjectA.id]]
    );

    const mixedNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText:
          "Mixed project boundary node: project A old plus project B recent.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `mixed-project-boundary-${randomUUID()}`
      }
    );
    const validNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Valid project boundary node: project A recent valid.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `valid-project-boundary-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($1, $3, 1), ($4, $5, 0)
      `,
      [
        mixedNode.id,
        oldProjectA.id,
        recentProjectB.id,
        validNode.id,
        recentProjectA.id
      ]
    );

    await embedPendingSources();
    mockEmbeddingQuery();
    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "boundary correlation project",
      scope: "personal",
      searchDomain: "project",
      workspaceId: projectA,
      recentDays: 30,
      limit: 10
    });

    expect(search.results.map((result) => result.nodeId)).toContain(
      validNode.id
    );
    expect(search.results.map((result) => result.nodeId)).not.toContain(
      mixedNode.id
    );

    const expanded = await engine.expandMemoryNode(
      mixedNode.id,
      { userId: alice.id },
      { searchDomain: "project", workspaceId: projectA, recentDays: 30 }
    );
    expect(expanded.sources).toHaveLength(0);
    expect(
      expanded.sourceItems.some((item) =>
        item.text?.includes("Boundary correlation")
      )
    ).toBe(false);
  });

  it("requires the same node source to satisfy session and temporal filters", async () => {
    const alice = await repo.createUser({
      email: `alice-session-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-session-boundary-${randomUUID()}`;
    const sessionA = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `session-a-${randomUUID()}`,
        idempotencyKey: `session-a-${randomUUID()}`
      }
    );
    const sessionB = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `session-b-${randomUUID()}`,
        idempotencyKey: `session-b-${randomUUID()}`
      }
    );

    const oldSessionA = await captureUserEvent(engine, alice.id, {
      workspaceId,
      sessionId: sessionA.id,
      content: "Boundary correlation session A old only.",
      metadata: { session: "a", age: "old" }
    });
    const recentSessionB = await captureUserEvent(engine, alice.id, {
      workspaceId,
      sessionId: sessionB.id,
      content: "Boundary correlation session B recent only.",
      metadata: { session: "b", age: "recent" }
    });
    const recentSessionA = await captureUserEvent(engine, alice.id, {
      workspaceId,
      sessionId: sessionA.id,
      content: "Boundary correlation session A recent valid.",
      metadata: { session: "a", age: "recent" }
    });

    await pool.query(
      "update memory_events set captured_at = now() - interval '45 days', created_at = now() where id = $1",
      [oldSessionA.id]
    );
    await pool.query(
      "update memory_events set captured_at = now() - interval '2 days', created_at = now() where id = any($1::uuid[])",
      [[recentSessionB.id, recentSessionA.id]]
    );

    const mixedNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText:
          "Mixed session boundary node: session A old plus session B recent.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `mixed-session-boundary-${randomUUID()}`
      }
    );
    const validNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Valid session boundary node: session A recent valid.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `valid-session-boundary-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($1, $3, 1), ($4, $5, 0)
      `,
      [
        mixedNode.id,
        oldSessionA.id,
        recentSessionB.id,
        validNode.id,
        recentSessionA.id
      ]
    );

    await embedPendingSources();
    mockEmbeddingQuery();
    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "boundary correlation session",
      scope: "personal",
      searchDomain: "session",
      sessionId: sessionA.id,
      recentDays: 30,
      limit: 10
    });

    expect(search.results.map((result) => result.nodeId)).toContain(
      validNode.id
    );
    expect(search.results.map((result) => result.nodeId)).not.toContain(
      mixedNode.id
    );

    const expanded = await engine.expandMemoryNode(
      mixedNode.id,
      { userId: alice.id },
      { searchDomain: "session", sessionId: sessionA.id, recentDays: 30 }
    );
    expect(expanded.sources).toHaveLength(0);
    expect(
      expanded.sourceItems.some((item) =>
        item.text?.includes("Boundary correlation")
      )
    ).toBe(false);
  });

  it("retrieves full lexical evidence from unembedded fresh memory only when lexical is requested", async () => {
    const alice = await repo.createUser({
      email: `alice-lexical-fresh-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-lexical-fresh-${randomUUID()}`;
    const filler = Array.from(
      { length: 260 },
      (_, index) => `The quiet lamp story filler passage ${index}.`
    ).join(" ");
    const story = [
      filler,
      "Only at the end did the keeper of the lamp reveal her name: Seraphina."
    ].join(" ");
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId,
      content: story,
      metadata: { kind: "long-story-tail-name" }
    });

    const embeddingFetch = mockEmbeddingQuery();
    const scan = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "Who was the keeper of the lamp named Seraphina?",
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "score_scan",
      limit: 1
    });
    const lexicalStage = scan.metadata.stages?.find(
      (stage) => stage.name === "lexical_search"
    );
    expect(scan.results).toHaveLength(0);
    expect(lexicalStage).toBeUndefined();

    embeddingFetch.mockClear();
    const lexical = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "Seraphina",
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "lexical_search",
      strictLimit: true,
      limit: 1
    });
    expect(lexical.results).toHaveLength(1);
    expect(lexical.results[0]?.sourceType).toBe("memory_event");
    expect(lexical.results[0]?.sourceId).toBe(event.id);
    expect(lexical.results[0]?.summaryText).toContain("Seraphina");
    expect(embeddingFetch).not.toHaveBeenCalled();

    await expect(
      engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "Seraphina",
        scope: "personal",
        searchDomain: "project",
        workspaceId,
        retrievalStage: "lexical_search",
        strictLimit: true,
        limit: 2
      })
    ).rejects.toThrow("above threshold");
  });

  it("ranks original lexical story evidence above later question and tool echoes", async () => {
    const alice = await repo.createUser({
      email: `alice-lexical-echo-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-lexical-echo-${randomUUID()}`;
    const query =
      "What was the name of the keeper of the lamp in the story about the city by the sea?";
    const story = [
      "At dawn, the city woke without bells.",
      "The keeper of the lamp watched the sea and kept the city visible.",
      "The story ended by revealing the keeper's name.",
      "Her name was Mara."
    ].join(" ");
    const storyEvent = await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "agent",
      content: story,
      metadata: { kind: "story-source" }
    });
    await captureUserEvent(engine, alice.id, {
      workspaceId,
      content: `This question failed before: "${query}"`,
      metadata: { kind: "question-echo" }
    });
    await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "tool",
      content: `Tool output from diagnostics repeated the prompt: ${query}`,
      metadata: { kind: "tool-echo" }
    });

    const lexical = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query,
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "lexical_search",
      strictLimit: true,
      limit: 3
    });

    expect(lexical.results[0]).toMatchObject({
      sourceType: "memory_event",
      sourceId: storyEvent.id,
      retrievalStage: "lexical_search"
    });
    expect(lexical.results[0]?.summaryText).toContain("Her name was Mara.");
  });

  it("filters lexical node evidence to the requested project boundary", async () => {
    const alice = await repo.createUser({
      email: `alice-lexical-boundary-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const inScopeWorkspaceId = `workspace-lexical-in-${randomUUID()}`;
    const outOfScopeWorkspaceId = `workspace-lexical-out-${randomUUID()}`;
    const inScopeEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: inScopeWorkspaceId,
      content: "Project alpha visible banana context.",
      metadata: { kind: "in-scope-source" }
    });
    const outOfScopeEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: outOfScopeWorkspaceId,
      content: "Project beta secret moonbase context.",
      metadata: { kind: "out-of-scope-source" }
    });
    const mixedNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText:
          "Mixed summary mentions visible banana and secret moonbase context.",
        bodyText:
          "Mixed body also mentions visible banana and secret moonbase context.",
        captureMethod: "mcp",
        sourceRuntime: "codex",
        sourceHash: `lexical-boundary-${randomUUID()}`
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($1, $3, 1)
      `,
      [mixedNode.id, inScopeEvent.id, outOfScopeEvent.id]
    );

    const outOfScopeSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "secret moonbase",
      scope: "personal",
      searchDomain: "project",
      workspaceId: inScopeWorkspaceId,
      retrievalStage: "lexical_search",
      limit: 1
    });
    expect(
      outOfScopeSearch.results.some(
        (result) => result.sourceId === mixedNode.id
      )
    ).toBe(false);
    expect(JSON.stringify(outOfScopeSearch.results)).not.toContain(
      "secret moonbase"
    );

    const inScopeSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "visible banana",
      scope: "personal",
      searchDomain: "project",
      workspaceId: inScopeWorkspaceId,
      retrievalStage: "lexical_search",
      limit: 5
    });
    const nodeResult = inScopeSearch.results.find(
      (result) => result.sourceId === mixedNode.id
    );
    expect(nodeResult?.summaryText).toContain("visible banana");
    expect(nodeResult?.summaryText).not.toContain("secret moonbase");
  });

  it("can inspect fresh embedded memory events before LCM nodes exist", async () => {
    const alice = await repo.createUser({
      email: `alice-fresh-event-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-fresh-event-${randomUUID()}`;
    const event = await captureUserEvent(engine, alice.id, {
      workspaceId,
      content:
        "Fresh unsummarized story memory says the lamp keeper is Seraphina.",
      metadata: { kind: "fresh-unsummarized" }
    });
    await embedPendingSources();
    mockEmbeddingQuery();

    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "lamp keeper Seraphina",
      scope: "personal",
      searchDomain: "project",
      workspaceId,
      retrievalStage: "fresh_pending_search",
      strictLimit: true,
      limit: 1
    });

    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({
      sourceType: "memory_event",
      sourceId: event.id,
      retrievalStage: "fresh_pending_search"
    });
    expect(search.results[0]?.summaryText).toContain("Seraphina");
  });

  it("keeps generic raw and fresh fallback evidence focused on non-tool memory", async () => {
    const alice = await repo.createUser({
      email: `alice-non-tool-fallback-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const workspaceId = `workspace-non-tool-fallback-${randomUUID()}`;
    const agentEvent = await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "agent",
      content:
        "Fresh unsummarized story memory says the lamp keeper is Seraphina.",
      metadata: { kind: "story-source" }
    });
    await captureUserEvent(engine, alice.id, {
      workspaceId,
      actor: "tool",
      content:
        "Tool output repeated diagnostics saying the lamp keeper is Seraphina.",
      metadata: { kind: "tool-diagnostic-echo" }
    });
    await embedPendingSources();
    mockEmbeddingQuery();

    for (const stage of [
      "fresh_pending_search",
      "raw_fallback_search"
    ] as const) {
      const search = await engine.searchMemory({
        requesterContext: { userId: alice.id },
        query: "lamp keeper Seraphina",
        scope: "personal",
        searchDomain: "project",
        workspaceId,
        retrievalStage: stage,
        strictLimit: true,
        limit: 1
      });

      expect(search.results).toHaveLength(1);
      expect(search.results[0]).toMatchObject({
        sourceType: "memory_event",
        sourceId: agentEvent.id,
        retrievalStage: stage
      });
      expect(search.results[0]?.summaryText).toContain("story memory");
    }
  });

  it("caps rollup evidence so scoped leaves are not crowded out", async () => {
    const alice = await repo.createUser({
      email: `alice-rollup-cap-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 12; index += 1) {
      const event = await captureUserEvent(engine, alice.id, {
        workspaceId: "workspace-rollup-cap",
        content: `Rollup cap source ${index}: scoped leaf detail ${index}.`,
        metadata: { index }
      });
      const leaf = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText: `Scoped leaf detail ${index}.`,
          captureMethod: "mcp",
          sourceRuntime: "codex",
          sourceHash: `leaf-rollup-cap-${index}-${randomUUID()}`
        }
      );
      const rollup = await repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "personal",
          summaryText: `Broad rollup route ${index}.`,
          captureMethod: "mcp",
          sourceRuntime: "codex",
          sourceHash: `rollup-cap-${index}-${randomUUID()}`
        }
      );
      await pool.query(
        "update memory_nodes set kind = 'rollup', depth = 1 where id = $1",
        [rollup.id]
      );
      await pool.query(
        `
          insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
          values ($1, $2, 0), ($3, $2, 0)
        `,
        [leaf.id, event.id, rollup.id]
      );
      await pool.query(
        `
          insert into memory_node_children (parent_memory_node_id, child_memory_node_id, child_order)
          values ($1, $2, 0)
        `,
        [rollup.id, leaf.id]
      );
    }

    await embedPendingSources();
    mockEmbeddingQuery();

    const search = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "rollup cap scoped leaf detail",
      scope: "personal",
      limit: 10
    });

    const rollupResults = search.results.filter(
      (result) => result.retrievalStage === "rollup_search"
    );
    const scopedLeafResults = search.results.filter(
      (result) => result.retrievalStage === "scoped_leaf_search"
    );
    expect(rollupResults.length).toBeLessThanOrEqual(5);
    expect(scopedLeafResults.length).toBeGreaterThan(0);
    expect(search.metadata.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rollup_search",
          candidateCount: 12
        }),
        expect.objectContaining({
          name: "scoped_leaf_search",
          used: true
        })
      ])
    );

    const explicitRollupSearch = await engine.searchMemory({
      requesterContext: { userId: alice.id },
      query: "rollup cap scoped leaf detail",
      scope: "personal",
      retrievalStage: "rollup_search",
      strictLimit: true,
      limit: 10
    });
    expect(explicitRollupSearch.results).toHaveLength(10);
    expect(
      explicitRollupSearch.results.every(
        (result) => result.retrievalStage === "rollup_search"
      )
    ).toBe(true);
  });

  it("does not mix sessions when creating LCM leaves or rollups", async () => {
    const alice = await repo.createUser({
      email: `alice-session-lcm-${randomUUID()}@example.com`
    });
    const engine = createMemoryEngine(repo);
    const firstWorkspaceId = randomUUID();
    const secondWorkspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values
          ($1, $3, 'personal', 'Session A'),
          ($2, $3, 'personal', 'Session B')
      `,
      [firstWorkspaceId, secondWorkspaceId, alice.id]
    );
    const firstSession = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId: firstWorkspaceId,
        externalSessionId: `session-a-${randomUUID()}`,
        idempotencyKey: `session-a-${randomUUID()}`
      }
    );
    const secondSession = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId: secondWorkspaceId,
        externalSessionId: `session-b-${randomUUID()}`,
        idempotencyKey: `session-b-${randomUUID()}`
      }
    );

    for (let index = 1; index <= 20; index += 1) {
      const session = index % 2 === 0 ? secondSession : firstSession;
      await captureUserEvent(engine, alice.id, {
        workspaceId:
          session.id === firstSession.id ? firstWorkspaceId : secondWorkspaceId,
        sessionId: session.id,
        content: `Session ${session.id} source ${index}`,
        metadata: { index }
      });
    }

    const compacted = await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "personal"
    });

    expect(compacted.leafNodeIds).toHaveLength(4);
    expect(compacted.rollupNodeId).not.toBeNull();

    const nodeSessions = await pool.query<{
      memory_node_id: string;
      session_count: string;
      sessions: string;
    }>(
      `
        select
          mns.memory_node_id,
          count(distinct me.session_id)::text as session_count,
          string_agg(distinct me.session_id::text, ',') as sessions
        from memory_node_sources mns
        join memory_events me on me.id = mns.memory_event_id
        where mns.memory_node_id = any($1::uuid[])
        group by mns.memory_node_id
        order by mns.memory_node_id
      `,
      [[...compacted.leafNodeIds, compacted.rollupNodeId!]]
    );

    expect(nodeSessions.rows).toHaveLength(5);
    expect(
      nodeSessions.rows.every((row) => Number(row.session_count) === 1)
    ).toBe(true);
    expect(new Set(nodeSessions.rows.map((row) => row.sessions)).size).toBe(2);
  });

  it("persists personal memory questions as shells and hydrated detail", async () => {
    const alice = await repo.createUser({
      email: `alice-question-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-question-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Question Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `question-session-${randomUUID()}`,
        idempotencyKey: `question-session-${randomUUID()}`
      }
    );
    const created = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        query: "What did we decide about memory questions?",
        searchDomain: "session",
        workspaceId,
        projectName: "Question Project",
        projectPath: "/tmp/question-project",
        sessionId: session.id,
        threadId: "thread-1",
        threadName: "Question Thread",
        localMemoryWorkerConfig: {
          provider: "codex",
          model: "gpt-5.4",
          reasoningEffort: "medium",
          timeoutMs: 150000,
          maxAttempts: 4
        }
      }
    );

    expect(created.status).toBe("pending");
    expect(created.answerMarkdown).toBeNull();
    expect(created.processingLeaseUntil).toBeNull();

    const claimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: created.id, limit: 1, leaseSeconds: 120 }
    );
    const claimedAgain = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: created.id, limit: 1, leaseSeconds: 120 }
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: created.id,
      status: "pending",
      attemptCount: 1,
      localMemoryWorkerConfig: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 150000,
        maxAttempts: 4
      }
    });
    expect(claimed[0]?.processingStartedAt).toBeTruthy();
    expect(claimed[0]?.processingLeaseUntil).toBeTruthy();
    expect(claimedAgain).toEqual([]);
    await pool.query(
      `
        update memory_questions
        set processing_lease_until = now() - interval '1 second'
        where id = $1
      `,
      [created.id]
    );
    const reclaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: created.id, limit: 1, leaseSeconds: 120 }
    );
    const staleCompletion = await repo.updateMemoryQuestion(
      { userId: alice.id },
      created.id,
      {
        status: "answered",
        attemptCount: claimed[0]!.attemptCount,
        answerMarkdown: "This stale worker should not win."
      }
    );
    expect(reclaimed[0]?.attemptCount).toBe(2);
    expect(staleCompletion).toBeNull();

    const retryCreated = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        query: "Can a failed local answer retry later?",
        searchDomain: "global"
      }
    );
    const retryClaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: retryCreated.id, limit: 1, leaseSeconds: 120 }
    );
    const retryReleased = await repo.updateMemoryQuestion(
      { userId: alice.id },
      retryCreated.id,
      {
        status: "pending",
        attemptCount: retryClaimed[0]!.attemptCount,
        lastErrorMessage: "Codex unavailable",
        response: { markdown: "raw fallback must not become the answer" },
        retrieval: { mode: "test" },
        localMemoryWorker: {
          usedFallback: true,
          skippedReason: "codex_failed"
        }
      }
    );
    const retryReclaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: retryCreated.id, limit: 1, leaseSeconds: 120 }
    );

    expect(retryReleased).toMatchObject({
      id: retryCreated.id,
      status: "pending",
      answerMarkdown: null,
      errorMessage: null,
      processingStartedAt: null,
      processingLeaseUntil: null,
      lastErrorMessage: "Codex unavailable"
    });
    expect(retryReleased?.answeredAt).toBeNull();
    expect(retryReclaimed).toHaveLength(1);
    expect(retryReclaimed[0]?.attemptCount).toBe(
      retryClaimed[0]!.attemptCount + 1
    );
    expect(retryReclaimed[0]?.lastErrorMessage).toBeNull();

    const updated = await repo.updateMemoryQuestion(
      { userId: alice.id },
      created.id,
      {
        status: "answered",
        attemptCount: reclaimed[0]!.attemptCount,
        answerMarkdown: "Memory questions are persisted separately.",
        evidence: [{ id: "source-1" }],
        citations: [{ id: "citation-1" }],
        retrieval: { searchDomain: "session" },
        localMemoryWorker: { status: "ok" },
        response: { markdown: "Memory questions are persisted separately." }
      }
    );
    const shells = await repo.listMemoryQuestions(
      { userId: alice.id },
      { searchDomain: "session", sessionId: session.id }
    );
    const detail = await repo.getMemoryQuestion(
      { userId: alice.id },
      created.id
    );
    const hidden = await repo.getMemoryQuestion({ userId: bob.id }, created.id);
    expect(updated).toMatchObject({
      id: created.id,
      status: "answered",
      localMemoryWorkerConfig: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 150000,
        maxAttempts: 4
      }
    });
    expect(detail).toMatchObject({
      id: created.id,
      answerMarkdown: "Memory questions are persisted separately.",
      localMemoryWorkerConfig: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 150000,
        maxAttempts: 4
      },
      evidenceCount: 1
    });
    const slowCreated = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        query: "Can a slow local answer still complete?",
        searchDomain: "global"
      }
    );
    const slowClaimed = await repo.claimPendingMemoryQuestions(
      { userId: alice.id },
      { questionId: slowCreated.id, limit: 1, leaseSeconds: 120 }
    );
    await pool.query(
      `
        update memory_questions
        set processing_lease_until = now() - interval '1 second'
        where id = $1
      `,
      [slowCreated.id]
    );
    const slowCompletion = await repo.updateMemoryQuestion(
      { userId: alice.id },
      slowCreated.id,
      {
        status: "answered",
        attemptCount: slowClaimed[0]!.attemptCount,
        answerMarkdown: "Slow answers complete if no newer attempt exists."
      }
    );

    expect(updated?.status).toBe("answered");
    expect(updated?.processingLeaseUntil).toBeNull();
    expect(updated?.lastErrorMessage).toBeNull();
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatchObject({
      id: created.id,
      answerPreview: "Memory questions are persisted separately.",
      evidenceCount: 1,
      sessionId: session.id
    });
    expect(detail?.evidence).toEqual([{ id: "source-1" }]);
    expect(hidden).toBeNull();
    expect(slowCompletion?.status).toBe("answered");
    expect(slowCompletion?.answerMarkdown).toBe(
      "Slow answers complete if no newer attempt exists."
    );
  });

  it("returns the original memory event for duplicate capture keys", async () => {
    const alice = await repo.createUser({
      email: `alice-duplicate-event-${randomUUID()}@example.com`
    });
    const sourceHash = `source-hash-${randomUUID()}`;
    const idempotencyKey = `idempotency-${randomUUID()}`;
    const input = {
      workspaceId: "workspace-duplicate-event",
      actor: "user" as const,
      eventType: "captured" as const,
      rawEventType: "user_prompt",
      visibility: "personal" as const,
      content: "Duplicate capture should return the first event",
      idempotencyKey,
      sourceHash
    };

    const first = await repo.createMemoryEvent({ userId: alice.id }, input);
    const duplicateBySourceHash = await repo.createMemoryEvent(
      { userId: alice.id },
      { ...input, idempotencyKey: `other-${randomUUID()}` }
    );
    const duplicateByIdempotencyKey = await repo.createMemoryEvent(
      { userId: alice.id },
      { ...input, sourceHash: `other-${randomUUID()}` }
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      { query: "Duplicate capture", includeInvalidated: false }
    );

    expect(duplicateBySourceHash.id).toBe(first.id);
    expect(duplicateByIdempotencyKey.id).toBe(first.id);
    expect(events.map((event) => event.id)).toEqual([first.id]);
  });

  it("loads standalone memory events from thread rows", async () => {
    const alice = await repo.createUser({
      email: `alice-standalone-thread-${randomUUID()}@example.com`
    });
    const event = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-standalone-thread",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Standalone memory event should open from the graph thread",
        metadata: {
          projectName: "Standalone Project",
          projectPath: "/tmp/standalone-project"
        }
      }
    );

    const projects = await repo.listLcmGraphThreads(
      { userId: alice.id },
      { projectId: "workspace-standalone-thread", limit: 10 }
    );
    const thread = projects[0]?.threads[0];
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: "workspace-standalone-thread",
        threadId: thread?.id,
        limit: 10
      }
    );

    expect(thread?.id).toBe(event.id);
    expect(thread?.name).toBe("Untitled conversation");
    expect(events.map((graphEvent) => graphEvent.id)).toEqual([event.id]);
  });

  it("projects hook-only fallback payloads into semantic memory", async () => {
    const alice = await repo.createUser({
      email: `alice-hook-fallback-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Hook Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `hook-fallback-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `hook-fallback-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "hook-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "UserPromptSubmit",
            sourceSequence: 1,
            rawJson: {
              hook_event_name: "UserPromptSubmit",
              prompt: "Hook-only prompt should be retained."
            },
            rawText: "Hook-only prompt should be retained.",
            sourceHash: `hook-prompt-${randomUUID()}`,
            idempotencyKey: `hook-prompt-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Hook Project" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "hook-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "Stop",
            sourceSequence: 2,
            rawJson: {
              hook_event_name: "Stop",
              last_assistant_message:
                "Hook-only assistant reply should be retained."
            },
            rawText: "Hook-only assistant reply should be retained.",
            sourceHash: `hook-stop-${randomUUID()}`,
            idempotencyKey: `hook-stop-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Hook Project" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );

    expect(projection.memoryEventsCreated).toBe(2);
    expect(events.map((event) => event.contentPreview)).toEqual([
      "Hook-only assistant reply should be retained.",
      "Hook-only prompt should be retained."
    ]);
  });

  it("exposes transcript source chronology for projected graph events", async () => {
    const alice = await repo.createUser({
      email: `alice-source-chronology-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Source Chronology Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `source-chronology-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `source-chronology-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "source-chronology-turn",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourceSequence: 1,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: "Older source prompt"
              }
            },
            rawText: "Older source prompt",
            sourceHash: `source-chronology-prompt-${randomUUID()}`,
            idempotencyKey: `source-chronology-prompt-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Source Chronology Project" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "source-chronology-turn",
            sourceRecordType: "response_item",
            sourceEventType: "message",
            sourceSequence: 2,
            eventTime: "2026-04-01T12:00:00.000Z",
            rawJson: {
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: "Older source reply"
              }
            },
            rawText: "Older source reply",
            sourceHash: `source-chronology-reply-${randomUUID()}`,
            idempotencyKey: `source-chronology-reply-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Source Chronology Project" }
          }
        ]
      }
    );

    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const firstPage = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 1
      }
    );
    const secondPage = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 1,
        cursorTimestamp: firstPage[0]!.timestamp,
        cursorSourceSequence: firstPage[0]!.sourceSequence ?? undefined,
        cursorId: firstPage[0]!.id
      }
    );
    const legacyCursorPage = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 1,
        cursorTimestamp: firstPage[0]!.timestamp,
        cursorId: firstPage[0]!.id
      }
    );
    const threadIndex = await repo.listLcmGraphThreads(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );

    expect(firstPage[0]).toMatchObject({
      contentPreview: "Older source reply",
      sourceEventTime: "2026-04-01T12:00:00.000Z",
      sourceSequence: 2_000_000,
      timestamp: "2026-04-01T12:00:00.000Z"
    });
    expect(secondPage[0]).toMatchObject({
      contentPreview: "Older source prompt",
      sourceEventTime: "2026-04-01T12:00:00.000Z",
      sourceSequence: 1_000_000
    });
    expect(legacyCursorPage[0]?.id).toBe(secondPage[0]!.id);
    expect(firstPage[0]!.createdAt).not.toBe(firstPage[0]!.timestamp);
    expect(threadIndex[0]?.threads[0]).toMatchObject({
      latestAt: "2026-04-01T12:00:00.000Z",
      sample: "Older source reply"
    });
  });

  it("projects hook-only tool payloads into semantic memory and tool events", async () => {
    const alice = await repo.createUser({
      email: `alice-hook-tool-fallback-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Hook Tool Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `hook-tool-fallback-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        idempotencyKey: `hook-tool-fallback-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "hook-tool-turn-1",
            sourceRecordType: "hook_payload",
            sourceEventType: "PostToolUse",
            sourceSequence: 1,
            rawJson: {
              hook_event_name: "PostToolUse",
              tool_use_id: "toolu-hook-1",
              tool_name: "exec_command",
              tool_input: { cmd: "git status --short" },
              tool_response: "clean"
            },
            sourceHash: `hook-tool-${randomUUID()}`,
            idempotencyKey: `hook-tool-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Hook Tool Project" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "hook-tool-turn-2",
            sourceRecordType: "hook_payload",
            sourceEventType: "PostToolUse",
            sourceSequence: 2,
            rawJson: {
              hook_event_name: "PostToolUse",
              tool_use_id: "toolu-hook-2",
              tool_name: "exec_command",
              tool_input: { cmd: "git status --branch" }
            },
            sourceHash: `hook-tool-missing-response-${randomUUID()}`,
            idempotencyKey: `hook-tool-missing-response-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { projectName: "Hook Tool Project" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );
    const memoryEvents = await pool.query<{
      actor: string | null;
      content: string;
      semantic_unit_type: string | null;
    }>(
      `
        select
          payload ->> 'actor' as actor,
          payload ->> 'content' as content,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type
        from memory_events
        where session_id = $1
        order by created_at asc, id asc
      `,
      [session.id]
    );
    const toolEvents = await pool.query<{
      tool_name: string;
      tool_input: unknown;
      tool_response: unknown;
    }>(
      `
        select tool_name, tool_input, tool_response
        from tool_events
        where session_id = $1
        order by transcript_item_id asc nulls last, id asc
      `,
      [session.id]
    );

    expect(projection.memoryEventsCreated).toBe(2);
    expect(projection.toolEventsCreated).toBe(2);
    expect(events.map((event) => event.contentPreview)).toHaveLength(2);
    expect(events.map((event) => event.contentPreview)).toEqual(
      expect.arrayContaining([
        'Tool result: exec_command Input: {"cmd":"git status --short"} Output: clean',
        'Tool result: exec_command Input: {"cmd":"git status --branch"}'
      ])
    );
    expect(memoryEvents.rows).toEqual([
      {
        actor: "tool",
        semantic_unit_type: "agent_turn",
        content: [
          "Tool result: exec_command",
          "",
          'Input:\n{"cmd":"git status --short"}',
          "",
          "Output:\nclean"
        ].join("\n")
      },
      {
        actor: "tool",
        semantic_unit_type: "agent_turn",
        content: [
          "Tool result: exec_command",
          "",
          'Input:\n{"cmd":"git status --branch"}'
        ].join("\n")
      }
    ]);
    expect(toolEvents.rows).toEqual([
      {
        tool_name: "exec_command",
        tool_input: { cmd: "git status --short" },
        tool_response: "clean"
      },
      {
        tool_name: "exec_command",
        tool_input: { cmd: "git status --branch" },
        tool_response: null
      }
    ]);
  });

  it("bundles complete agent turns across projection limits in source order", async () => {
    const alice = await repo.createUser({
      email: `alice-complete-turn-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Complete Turn Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `complete-turn-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `complete-turn-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-limit-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 3,
            rawJson: {
              method: "item/completed",
              params: { item: { type: "agentMessage", text: "third" } }
            },
            rawText: "third",
            sourceHash: `complete-third-${randomUUID()}`,
            idempotencyKey: `complete-third-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-limit-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 1,
            rawJson: {
              method: "item/completed",
              params: { item: { type: "agentMessage", text: "first" } }
            },
            rawText: "first",
            sourceHash: `complete-first-${randomUUID()}`,
            idempotencyKey: `complete-first-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-limit-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 2,
            rawJson: {
              method: "item/completed",
              params: { item: { type: "agentMessage", text: "second" } }
            },
            rawText: "second",
            sourceHash: `complete-second-${randomUUID()}`,
            idempotencyKey: `complete-second-${randomUUID()}`,
            projectionStatus: "pending",
            metadata: { transcriptType: "agent_message" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      {
        projectId: workspaceId,
        threadId: session.externalSessionId ?? undefined,
        limit: 10
      }
    );
    const statuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        where session_id = $1
        group by projection_status
      `,
      [session.id]
    );
    const eventContent = await pool.query<{ content: string }>(
      `
        select payload ->> 'content' as content
        from memory_events
        where session_id = $1
        order by captured_at asc, id asc
      `,
      [session.id]
    );

    expect(projection.rawItemsScanned).toBe(3);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(events.map((event) => event.contentPreview)).toEqual([
      "first second third"
    ]);
    expect(eventContent.rows.map((row) => row.content)).toEqual([
      "first\n\nsecond\n\nthird"
    ]);
    expect(statuses.rows).toEqual([
      { projection_status: "projected", count: "3" }
    ]);
  });

  it("stores raw conversation items idempotently and links projected memory events to sources", async () => {
    const alice = await repo.createUser({
      email: `alice-raw-conversation-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Raw Conversation Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `codex-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `session-${randomUUID()}`
      }
    );
    const idempotencyKey = `raw-item-${randomUUID()}`;
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: "codex-thread-1",
            externalThreadId: "codex-thread-1",
            externalTurnId: "turn-1",
            externalItemId: "item-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/agentMessage/delta",
            sourceSequence: 1,
            eventTime: new Date().toISOString(),
            rawJson: {
              method: "item/agentMessage/delta",
              params: { delta: "Hello from raw Codex output." }
            },
            rawText: "Hello from raw Codex output.",
            sourceHash: `source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "pending",
            metadata: { workflow: "test" }
          }
        ]
      }
    );
    const [duplicateRawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: "codex-thread-1",
            externalThreadId: "codex-thread-1",
            externalTurnId: "turn-1",
            externalItemId: "item-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/agentMessage/delta",
            sourceSequence: 1,
            rawJson: { duplicate: true },
            sourceHash: `other-source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "projected"
          }
        ]
      }
    );
    const projected = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        sessionId: session.id,
        actor: "assistant",
        eventType: "captured",
        rawEventType: "agent_message",
        visibility: "personal",
        content: "Hello from raw Codex output.",
        idempotencyKey: `projected-${randomUUID()}`,
        sourceHash: `projected-source-${randomUUID()}`,
        metadata: { rawConversationItemId: rawItem!.id }
      }
    );
    const rawCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from conversation_items where idempotency_key = $1",
      [idempotencyKey]
    );
    const rawStatus = await pool.query<{
      projection_status: string;
      turn_id: string | null;
      turn_index: number | null;
    }>(
      `
        select ci.projection_status, ci.turn_id, t.turn_index
        from conversation_items ci
        left join turns t on t.id = ci.turn_id
        where ci.id = $1
      `,
      [rawItem!.id]
    );
    const links = await pool.query<{
      memory_event_id: string;
      conversation_item_id: string;
      source_order: number;
    }>(
      `
        select memory_event_id, conversation_item_id, source_order
        from memory_event_sources
        where memory_event_id = $1
      `,
      [projected.id]
    );

    expect(rawItem?.id).toBeTruthy();
    expect(duplicateRawItem?.id).toBe(rawItem?.id);
    expect(rawCount.rows[0]?.count).toBe("1");
    expect(rawStatus.rows[0]?.projection_status).toBe("pending");
    expect(rawStatus.rows[0]?.turn_id).toBeTruthy();
    expect(rawStatus.rows[0]?.turn_index).toBe(0);
    expect(links.rows).toEqual([
      {
        memory_event_id: projected.id,
        conversation_item_id: rawItem!.id,
        source_order: 0
      }
    ]);

    const bob = await repo.createUser({
      email: `bob-raw-item-${randomUUID()}@example.com`
    });
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-codex-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            rawJson: { owner: "bob" },
            sourceHash: `bob-source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "pending"
          }
        ]
      }
    );
    expect(bobRawItem?.id).toBeTruthy();
    expect(bobRawItem?.id).not.toBe(rawItem?.id);
  });

  it("sanitizes storage-unsafe strings in raw conversation items before storage and projection", async () => {
    const alice = await repo.createUser({
      email: `alice-raw-nul-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Raw NUL Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `nul-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `nul-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const idempotencyKey = `nul-raw-${randomUUID()}`;
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "nul-turn",
            externalItemId: "nul-item",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourcePath: `/tmp/a${"\u0000"}b.jsonl`,
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: `The captured text is a${"\u0000"}b${"\uD800"}c.`
                },
                nested: [{ value: `nested-${"\u0000"}value` }]
              }
            },
            rawText: `Raw text 你好 🚀\nline a${"\u0000"}b`,
            sourceHash: `source-${idempotencyKey}`,
            idempotencyKey,
            projectionStatus: "pending",
            metadata: {
              workspaceId,
              transcriptType: "agent_message",
              label: `metadata a${"\u0000"}b`,
              valid: "Cafe\u0301",
              nested: {
                [`key${"\u0000"}name`]: `value${"\u0000"}text${"\uDC00"}`
              }
            }
          }
        ]
      }
    );
    const [duplicateRawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            rawJson: { duplicate: true },
            sourceHash: `other-source-${idempotencyKey}`,
            idempotencyKey
          }
        ]
      }
    );
    const transportIdempotencyKey = `nul-transport-text-${randomUUID()}`;
    const [transportTextItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            rawJson: { transportChunk: true },
            logicalSourceId: `logical-${transportIdempotencyKey}`,
            transportChunkIndex: 0,
            transportChunkCount: 1,
            transportChunkText: `Transport a${"\u0000"}b${"\uDC00"}c`,
            transportChunkEncoding: "test-plain-text",
            sourceHash: `source-${transportIdempotencyKey}`,
            idempotencyKey: transportIdempotencyKey,
            projectionStatus: "projected"
          }
        ]
      }
    );
    const stored = await pool.query<{
      raw_json_text: string;
      raw_payload_text: string | null;
      raw_text: string | null;
      source_path: string | null;
      metadata: Record<string, unknown>;
    }>(
      `
        select
          raw_json::text as raw_json_text,
          raw_json #>> '{params,item,text}' as raw_payload_text,
          raw_text,
          source_path,
          metadata
        from conversation_items
        where id = $1
      `,
      [rawItem!.id]
    );
    const storedTransport = await pool.query<{
      transport_chunk_text: string | null;
      metadata: Record<string, unknown>;
    }>(
      "select transport_chunk_text, metadata from conversation_items where id = $1",
      [transportTextItem!.id]
    );
    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const event = await pool.query<{
      content: string;
      metadata: Record<string, unknown>;
    }>(
      "select payload ->> 'content' as content, payload -> 'metadata' as metadata from memory_events limit 1"
    );

    expect(rawItem?.id).toBeTruthy();
    expect(duplicateRawItem?.id).toBe(rawItem?.id);
    expect(stored.rows[0]?.raw_payload_text).toBe(
      "The captured text is a�b�c."
    );
    expect(stored.rows[0]?.raw_text).toBe("Raw text 你好 🚀\nline a�b");
    expect(stored.rows[0]?.source_path).toBe("/tmp/a�b.jsonl");
    expect(stored.rows[0]?.metadata).toMatchObject({
      transcriptType: "agent_message",
      valid: "Cafe\u0301",
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 7
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 2
        }
      }
    });
    expect(storedTransport.rows[0]?.transport_chunk_text).toBe(
      "Transport a�b�c"
    );
    expect(storedTransport.rows[0]?.metadata).toMatchObject({
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 1
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 1
        }
      }
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain("\u0000");
    expect(JSON.stringify(stored.rows[0])).not.toContain("\\u0000");
    expect(projection.memoryEventsCreated).toBe(1);
    expect(event.rows[0]?.content).toBe("Raw text 你好 🚀\nline a�b");
    expect(event.rows[0]?.content).not.toContain("\\u0000");
    expect(JSON.stringify(event.rows[0]?.metadata)).toContain(
      '"replacementCount":7'
    );
  });

  it("does not link memory events to raw source rows outside caller ownership", async () => {
    const workspaceId = randomUUID();
    const alice = await repo.createUser({
      email: `alice-source-link-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-source-link-${randomUUID()}@example.com`
    });
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Bob Source Link Project')
      `,
      [workspaceId, bob.id]
    );
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-source-link-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-source-link-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-hook-v1",
            sourceTransport: "hook",
            sourceRecordType: "hook_payload",
            rawJson: { owner: "bob" },
            sourceHash: `bob-private-raw-${randomUUID()}`,
            idempotencyKey: `bob-private-raw-${randomUUID()}`,
            projectionStatus: "pending"
          }
        ]
      }
    );

    const projected = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        actor: "assistant",
        eventType: "captured",
        rawEventType: "agent_message",
        visibility: "personal",
        content: "Alice projected event",
        idempotencyKey: `alice-projected-${randomUUID()}`,
        sourceHash: `alice-projected-source-${randomUUID()}`,
        metadata: { rawConversationItemId: bobRawItem!.id }
      }
    );
    const links = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources where memory_event_id = $1",
      [projected.id]
    );

    expect(links.rows[0]?.count).toBe("0");
  });

  it("rejects raw conversation items attached to sessions or turns outside caller scope", async () => {
    const workspaceId = randomUUID();
    const alice = await repo.createUser({
      email: `alice-raw-scope-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-raw-scope-${randomUUID()}@example.com`
    });
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Raw Scope Project')
      `,
      [workspaceId, bob.id]
    );
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-raw-scope-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-raw-scope-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "bob-turn-1",
            sourceRecordType: "app_server_notification",
            rawJson: { owner: "bob" },
            sourceHash: `bob-raw-scope-${randomUUID()}`,
            idempotencyKey: `bob-raw-scope-${randomUUID()}`
          }
        ]
      }
    );

    await expect(
      repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: bobSession.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              rawJson: { owner: "alice" },
              sourceHash: `alice-bob-session-${randomUUID()}`,
              idempotencyKey: `alice-bob-session-${randomUUID()}`
            }
          ]
        }
      )
    ).rejects.toThrow("Session not found or not visible");

    await expect(
      repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              turnId: bobRawItem!.turnId!,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              sourceRecordType: "app_server_notification",
              rawJson: { owner: "alice" },
              sourceHash: `alice-bob-turn-${randomUUID()}`,
              idempotencyKey: `alice-bob-turn-${randomUUID()}`
            }
          ]
        }
      )
    ).rejects.toThrow("Turn not found or not visible");
  });

  it("rejects token usage linked to sources outside caller scope", async () => {
    const workspaceId = randomUUID();
    const alice = await repo.createUser({
      email: `alice-token-scope-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-token-scope-${randomUUID()}@example.com`
    });
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Token Scope Project')
      `,
      [workspaceId, bob.id]
    );
    const bobSession = await repo.createCapturedSession(
      { userId: bob.id },
      {
        workspaceId,
        externalSessionId: `bob-token-scope-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `bob-token-scope-session-${randomUUID()}`
      }
    );
    const [bobRawItem] = await repo.createConversationItems(
      { userId: bob.id },
      {
        items: [
          {
            sessionId: bobSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "bob-token-turn-1",
            sourceRecordType: "app_server_notification",
            rawJson: { owner: "bob" },
            sourceHash: `bob-token-scope-${randomUUID()}`,
            idempotencyKey: `bob-token-scope-${randomUUID()}`
          }
        ]
      }
    );

    await expect(
      repo.recordWorkflowTokenUsage(
        { userId: alice.id },
        {
          workflowType: "memory_question",
          sessionId: bobSession.id,
          totalTokens: 1
        }
      )
    ).rejects.toThrow("Session not found or not visible");

    await expect(
      repo.recordWorkflowTokenUsage(
        { userId: alice.id },
        {
          workflowType: "memory_question",
          turnId: bobRawItem!.turnId!,
          totalTokens: 1
        }
      )
    ).rejects.toThrow("Turn not found or not visible");

    await expect(
      repo.recordWorkflowTokenUsage(
        { userId: alice.id },
        {
          workflowType: "memory_question",
          conversationItemId: bobRawItem!.id,
          totalTokens: 1
        }
      )
    ).rejects.toThrow("Conversation item not found or not visible");

    const bobQuestion = await repo.createMemoryQuestion(
      { userId: bob.id },
      {
        query: "What did we decide?",
        searchDomain: "global"
      }
    );
    const bobNode = await repo.createMemoryNode(
      { userId: bob.id },
      {
        visibility: "personal",
        summaryText: "Bob private LCM node",
        captureMethod: "mcp"
      }
    );
    const bobEvent = await repo.createMemoryEvent(
      { userId: bob.id },
      {
        workspaceId: "bob-workspace",
        actor: "user",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "Bob private event",
        idempotencyKey: `bob-event-${randomUUID()}`,
        sourceHash: `bob-event-${randomUUID()}`
      }
    );
    const bobMessage = await pool.query<{ id: string }>(
      `
        insert into messages (
          session_id, turn_id, owner_user_id, visibility, role, content,
          source_runtime, capture_method
        )
        values ($1, $2, $3, 'personal', 'user', 'Bob private message', 'codex', 'hook')
        returning id
      `,
      [bobSession.id, bobRawItem!.turnId, bob.id]
    );
    const bobTool = await pool.query<{ id: string }>(
      `
        insert into tool_events (
          session_id, turn_id, owner_user_id, visibility, tool_name,
          source_runtime, capture_method
        )
        values ($1, $2, $3, 'personal', 'Bash', 'codex', 'hook')
        returning id
      `,
      [bobSession.id, bobRawItem!.turnId, bob.id]
    );

    for (const reference of [
      { type: "question" as const, id: bobQuestion.id },
      { type: "lcm_node" as const, id: bobNode.id },
      { type: "message" as const, id: bobMessage.rows[0]!.id },
      { type: "tool_event" as const, id: bobTool.rows[0]!.id },
      { type: "memory_event" as const, id: bobEvent.id }
    ]) {
      await expect(
        repo.recordWorkflowTokenUsage(
          { userId: alice.id },
          {
            workflowType: "memory_question",
            sourceReferences: [reference],
            totalTokens: 1
          }
        )
      ).rejects.toThrow(
        `${reference.type} source reference not found or not visible`
      );
    }
  });

  it("persists local memory agent settings per user and flow", async () => {
    const alice = await repo.createUser({
      email: `alice-local-agent-settings-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-local-agent-settings-${randomUUID()}@example.com`
    });

    const created = await repo.upsertLocalMemoryAgentSetting(
      { userId: alice.id },
      {
        flowKey: "mcp_memory_answer",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
        timeoutMs: 180000,
        maxAttempts: 3
      }
    );
    const updated = await repo.upsertLocalMemoryAgentSetting(
      { userId: alice.id },
      {
        flowKey: "mcp_memory_answer",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        timeoutMs: 120000,
        maxAttempts: 2
      }
    );
    await repo.upsertLocalMemoryAgentSetting(
      { userId: alice.id },
      {
        flowKey: "lcm_summary",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        timeoutMs: 90000,
        maxAttempts: 4
      }
    );

    expect(created.flowKey).toBe("mcp_memory_answer");
    expect(updated).toMatchObject({
      ownerUserId: alice.id,
      flowKey: "mcp_memory_answer",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      timeoutMs: 120000,
      maxAttempts: 2
    });
    expect(
      await repo.listLocalMemoryAgentSettings({ userId: alice.id })
    ).toHaveLength(2);
    expect(await repo.listLocalMemoryAgentSettings({ userId: bob.id })).toEqual(
      []
    );
  });

  it("stores validated token usage source references", async () => {
    const alice = await repo.createUser({
      email: `alice-token-source-references-${randomUUID()}@example.com`
    });
    const question = await repo.createMemoryQuestion(
      { userId: alice.id },
      {
        query: "What did we decide?",
        searchDomain: "global"
      }
    );
    const node = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Alice LCM node",
        captureMethod: "mcp"
      }
    );
    const event = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "alice-workspace",
        actor: "user",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "Alice private event",
        idempotencyKey: `alice-event-${randomUUID()}`,
        sourceHash: `alice-event-${randomUUID()}`
      }
    );
    const usage = await repo.recordWorkflowTokenUsage(
      { userId: alice.id },
      {
        workflowType: "memory_question",
        workflowId: question.id,
        questionId: question.id,
        answerJobId: question.id,
        lcmNodeId: node.id,
        memoryEventId: event.id,
        totalTokens: 3,
        idempotencyKey: `source-refs-${randomUUID()}`
      }
    );
    const references = await pool.query<{
      source_type: string;
      source_id: string;
    }>(
      `
        select source_type, source_id
        from workflow_token_usage_source_references
        where workflow_token_usage_id = $1
        order by source_type
      `,
      [usage.id]
    );

    expect(references.rows).toEqual([
      { source_type: "answer_job", source_id: question.id },
      { source_type: "lcm_node", source_id: node.id },
      { source_type: "memory_event", source_id: event.id },
      { source_type: "question", source_id: question.id }
    ]);
  });

  it("reprojects pending raw conversation items into messages, semantic events, and token usage", async () => {
    const alice = await repo.createUser({
      email: `alice-reproject-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Reproject Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `reproject-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `reproject-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: { type: "agentMessage", text: "Projected answer" }
              }
            },
            sourceHash: `raw-message-${randomUUID()}`,
            idempotencyKey: `raw-message-${randomUUID()}`,
            metadata: { workspaceId, transcriptType: "agent_message" }
          },
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "thread/tokenUsage/updated",
            sourceSequence: 1,
            rawJson: {
              method: "thread/tokenUsage/updated",
              params: {
                tokenUsage: {
                  modelContextWindow: 1000,
                  last: {
                    totalTokens: 7,
                    inputTokens: 4,
                    cachedInputTokens: 2,
                    outputTokens: 3,
                    reasoningOutputTokens: 1
                  }
                }
              }
            },
            sourceHash: `raw-token-${randomUUID()}`,
            idempotencyKey: `raw-token-${randomUUID()}`,
            metadata: { workflow: "memory_question", questionId: "question-1" }
          },
          {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 2,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "LCM summary worker output should not become a chat event"
                }
              }
            },
            sourceHash: `raw-lcm-output-${randomUUID()}`,
            idempotencyKey: `raw-lcm-output-${randomUUID()}`,
            metadata: {
              workflow: "lcm_summary",
              nodeId: randomUUID(),
              transcriptType: "agent_message"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const secondProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages order by created_at asc"
    );
    const events = await pool.query<{ id: string; content: string }>(
      "select id, payload ->> 'content' as content from memory_events order by created_at asc"
    );
    const links = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources"
    );
    const usage = await pool.query<{
      workflow_type: string;
      workflow_id: string | null;
      usage_source: string;
      usage_accuracy: string;
      usage_kind: string;
      total_tokens: number | null;
    }>(
      "select workflow_type, workflow_id, usage_source, usage_accuracy, usage_kind, total_tokens from workflow_token_usage"
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_version: string | null;
    }>(
      "select projection_status, projection_version from conversation_items order by source_sequence asc"
    );
    const embeddable = await repo.listSourcesNeedingEmbeddings(20);

    expect(projection.rawItemsProjected).toBe(3);
    expect(projection.messagesCreated).toBe(1);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(projection.tokenUsageRowsCreated).toBe(1);
    expect(secondProjection.rawItemsScanned).toBe(0);
    expect(messages.rows.map((row) => row.content)).toEqual([
      "Projected answer"
    ]);
    expect(events.rows.map((row) => row.content)).toEqual(["Projected answer"]);
    expect(links.rows[0]?.count).toBe("1");
    expect(usage.rows).toEqual([
      {
        workflow_type: "memory_question",
        workflow_id: "question-1",
        usage_source: "app_server",
        usage_accuracy: "provider_reported",
        usage_kind: "turn_delta",
        total_tokens: 7
      }
    ]);
    expect(
      statuses.rows.map((row) => ({
        projection_status: row.projection_status,
        projection_version: row.projection_version
      }))
    ).toEqual([
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      }
    ]);
    expect(embeddable.some((source) => source.sourceType === "message")).toBe(
      false
    );
    expect(
      embeddable.some((source) => source.sourceType === "memory_event")
    ).toBe(true);
  });

  it("projects Codex transcript token_count rows into token usage without semantic memory", async () => {
    const alice = await repo.createUser({
      email: `alice-token-count-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Transcript Token Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `token-count-session-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `token-count-session-${randomUUID()}`,
        metadata: {
          workspaceId,
          threadKind: "subagent",
          parentThreadId: "parent-thread",
          parentSessionId: "parent-session"
        }
      }
    );
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            externalTurnId: "token-count-turn",
            sourceRecordType: "token_count",
            sourceEventType: "token_count",
            sourcePath: "/tmp/codex/transcript.jsonl",
            sourceSequence: 9,
            rawJson: {
              type: "token_count",
              input_tokens: 11,
              cached_input_tokens: 3,
              output_tokens: 7,
              reasoning_output_tokens: 5,
              total_tokens: 26,
              model: "gpt-5-codex"
            },
            sourceHash: `raw-token-count-${randomUUID()}`,
            idempotencyKey: `raw-token-count-${randomUUID()}`,
            metadata: {
              threadKind: "subagent",
              parentThreadId: "parent-thread",
              parentSessionId: "parent-session"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const usage = await pool.query<{
      workflow_type: string;
      workflow_id: string | null;
      conversation_item_id: string | null;
      usage_source: string;
      usage_accuracy: string;
      usage_kind: string;
      connector_client: string | null;
      model: string | null;
      input_tokens: number | null;
      cached_input_tokens: number | null;
      output_tokens: number | null;
      reasoning_output_tokens: number | null;
      total_tokens: number | null;
      metadata: Record<string, unknown>;
    }>(
      `
        select
          workflow_type, workflow_id, conversation_item_id, usage_source,
          usage_accuracy, usage_kind, connector_client, model, input_tokens,
          cached_input_tokens, output_tokens, reasoning_output_tokens,
          total_tokens, metadata
        from workflow_token_usage
      `
    );
    const events = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_events"
    );

    expect(projection.tokenUsageRowsCreated).toBe(1);
    expect(projection.memoryEventsCreated).toBe(0);
    expect(events.rows[0]?.count).toBe("0");
    expect(usage.rows).toEqual([
      expect.objectContaining({
        workflow_type: "subagent_turn",
        workflow_id: rawItem?.turnId,
        conversation_item_id: rawItem?.id,
        usage_source: "transcript",
        usage_accuracy: "provider_reported",
        usage_kind: "turn_delta",
        connector_client: "codex",
        model: "gpt-5-codex",
        input_tokens: 11,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_output_tokens: 5,
        total_tokens: 26
      })
    ]);
    expect(usage.rows[0]?.metadata).toMatchObject({
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      parentSessionId: "parent-session",
      transcriptPath: "/tmp/codex/transcript.jsonl",
      sourceLineNumber: 9
    });
  });

  it("uses input plus output as transcript total fallback", async () => {
    const alice = await repo.createUser({
      email: `alice-token-count-fallback-${randomUUID()}@example.com`
    });
    const [rawItem] = await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "hook",
            sourceRecordType: "token_count",
            sourceEventType: "token_count",
            rawJson: {
              type: "token_count",
              input_tokens: 11,
              cached_input_tokens: 3,
              output_tokens: 7,
              reasoning_output_tokens: 5
            },
            sourceHash: `raw-token-count-fallback-${randomUUID()}`,
            idempotencyKey: `raw-token-count-fallback-${randomUUID()}`
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const usage = await pool.query<{ total_tokens: number | null }>(
      "select total_tokens from workflow_token_usage where conversation_item_id = $1",
      [rawItem?.id]
    );

    expect(projection.tokenUsageRowsCreated).toBe(1);
    expect(usage.rows[0]?.total_tokens).toBe(18);
  });

  it("keeps estimate rows out of spend rollups unless requested", async () => {
    const alice = await repo.createUser({
      email: `alice-token-rollup-${randomUUID()}@example.com`
    });

    await repo.recordWorkflowTokenUsage(
      { userId: alice.id },
      {
        workflowType: "memory_question",
        workflowId: "question-provider",
        usageSource: "app_server",
        usageAccuracy: "provider_reported",
        usageKind: "turn_delta",
        connectorClient: "codex",
        model: "gpt-5-codex",
        inputTokens: 4,
        cachedInputTokens: 1,
        outputTokens: 2,
        totalTokens: 6,
        metadata: { appServerThreadId: "thread-provider" },
        idempotencyKey: `provider-${randomUUID()}`
      }
    );
    const estimate = await repo.recordWorkflowTokenUsage(
      { userId: alice.id },
      {
        workflowType: "memory_question",
        workflowId: "question-estimate",
        usageSource: "local_estimate",
        usageAccuracy: "local_estimate",
        usageKind: "estimate",
        connectorClient: "codex",
        tokenizerPackage: "js-tiktoken",
        tokenizerEncoding: "o200k_base",
        tokenizerModel: "gpt-5-codex",
        tokenizerExactModelMatch: true,
        tokenizerHeuristicFallback: false,
        tokenizerVersion: "test",
        model: "gpt-5-codex",
        inputTokens: 70,
        outputTokens: 30,
        totalTokens: 100,
        metadata: { executionThreadId: "thread-estimate" },
        idempotencyKey: `estimate-${randomUUID()}`
      }
    );

    const spendOnly = await repo.listWorkflowTokenUsageRollups(
      { userId: alice.id },
      { groupBy: ["workflow"], includeEstimates: false }
    );
    const estimateAware = await repo.listWorkflowTokenUsageRollups(
      { userId: alice.id },
      { groupBy: ["workflow"], includeEstimates: true }
    );
    const threadRollup = await repo.listWorkflowTokenUsageRollups(
      { userId: alice.id },
      { groupBy: ["thread"], includeEstimates: true }
    );

    expect(estimate.tokenizerPackage).toBe("js-tiktoken");
    expect(estimate.tokenizerEncoding).toBe("o200k_base");
    expect(estimate.tokenizerExactModelMatch).toBe(true);
    expect(estimate.tokenizerHeuristicFallback).toBe(false);
    expect(spendOnly).toEqual([
      expect.objectContaining({
        group: { workflow: "memory_question" },
        rowCount: 1,
        totalTokens: 6
      })
    ]);
    expect(estimateAware).toEqual([
      expect.objectContaining({
        group: { workflow: "memory_question" },
        rowCount: 2,
        totalTokens: 106
      })
    ]);
    expect(threadRollup).toEqual([
      expect.objectContaining({
        group: { thread: "thread-estimate" },
        totalTokens: 100
      }),
      expect.objectContaining({
        group: { thread: "thread-provider" },
        totalTokens: 6
      })
    ]);
  });

  it("does not automatically reproject stale projection-version rows", async () => {
    const alice = await repo.createUser({
      email: `alice-stale-projection-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Stale Projection Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `stale-projection-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `stale-projection-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "Already projected under an older derivation policy"
                }
              }
            },
            sourceHash: `stale-projection-raw-${randomUUID()}`,
            idempotencyKey: `stale-projection-raw-${randomUUID()}`,
            projectionStatus: "projected",
            projectionVersion: "conversation-projection-v1",
            metadata: { transcriptType: "agent_message" }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_version: string | null;
    }>("select projection_status, projection_version from conversation_items");

    expect(projection.rawItemsScanned).toBe(0);
    expect(statuses.rows).toEqual([
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v1"
      }
    ]);
  });

  it("projects only allowlisted transcript records into semantic memory", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-policy-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Projection Policy Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `projection-policy-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-policy-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const rows = [
      {
        transcriptType: "user_message",
        text: "Please inspect the projection policy.",
        sourceHash: `projection-policy-user-${randomUUID()}`
      },
      {
        transcriptType: "agent_message",
        text: "The projection policy keeps raw audit data separate.",
        sourceHash: `projection-policy-agent-${randomUUID()}`
      },
      {
        transcriptType: "reasoning_summary",
        text: "Reasoning summary: compare transcript type against policy.",
        sourceHash: `projection-policy-reasoning-${randomUUID()}`
      },
      {
        transcriptType: "reasoning",
        text: "Raw reasoning content should not be projected.",
        sourceHash: `projection-policy-reasoning-item-${randomUUID()}`,
        rawJson: {
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              summary: [
                {
                  type: "summary_text",
                  text: "Readable reasoning summary: choose the projection policy."
                }
              ],
              content: ["Raw reasoning content should not be projected."]
            }
          }
        }
      },
      {
        transcriptType: "reasoning_raw_content",
        text: "Raw reasoning content should stay raw-only.",
        sourceHash: `projection-policy-raw-reasoning-${randomUUID()}`
      },
      {
        transcriptType: "reasoning",
        text: "Unsummarized reasoning item should stay raw-only.",
        sourceHash: `projection-policy-unsummarized-reasoning-${randomUUID()}`,
        rawJson: {
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              content: ["Unsummarized reasoning item should stay raw-only."]
            }
          }
        }
      },
      {
        transcriptType: "function_call",
        text: "Tool call: exec_command",
        sourceHash: `projection-policy-tool-${randomUUID()}`
      },
      {
        transcriptType: "system_message",
        text: "System instruction should stay raw-only.",
        sourceHash: `projection-policy-system-${randomUUID()}`
      },
      {
        transcriptType: "developer_message",
        text: "Developer instruction should stay raw-only.",
        sourceHash: `projection-policy-developer-${randomUUID()}`
      },
      {
        transcriptType: "rolling_context",
        text: "Rolling context package should stay raw-only.",
        sourceHash: `projection-policy-context-${randomUUID()}`
      }
    ];
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: rows.map((row, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalTurnId: "turn-1",
          sourceRecordType: "app_server_notification",
          sourceEventType: "item/completed",
          sourceSequence: index,
          rawJson: row.rawJson ?? {
            method: "item/completed",
            params: {
              item: {
                type: row.transcriptType,
                text: row.text
              }
            }
          },
          rawText: row.text,
          sourceHash: row.sourceHash,
          idempotencyKey: row.sourceHash,
          metadata: { workspaceId, transcriptType: row.transcriptType }
        }))
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages order by created_at asc"
    );
    const events = await pool.query<{
      actor: string | null;
      content: string;
      semantic_unit_type: string | null;
    }>(
      `
        select
          payload ->> 'actor' as actor,
          payload ->> 'content' as content,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type
        from memory_events
        order by created_at asc
      `
    );
    const toolEvents = await pool.query<{ count: string }>(
      "select count(*)::text as count from tool_events"
    );
    const rawStatuses = await pool.query<{
      projection_status: string;
      count: string;
    }>(
      `
        select projection_status, count(*)::text as count
        from conversation_items
        group by projection_status
      `
    );

    expect(projection.rawItemsProjected).toBe(rows.length);
    expect(projection.memoryEventsCreated).toBe(3);
    expect(projection.messagesCreated).toBe(5);
    expect(projection.toolEventsCreated).toBe(1);
    expect(toolEvents.rows[0]?.count).toBe("1");
    expect(messages.rows.map((row) => row.content)).toEqual([
      "Please inspect the projection policy.",
      "The projection policy keeps raw audit data separate.",
      "Reasoning summary: compare transcript type against policy.",
      "Readable reasoning summary: choose the projection policy.",
      "Tool call: exec_command"
    ]);
    expect(
      events.rows.map((row) => ({
        actor: row.actor,
        semanticUnitType: row.semantic_unit_type,
        content: row.content
      }))
    ).toEqual([
      {
        actor: "user",
        semanticUnitType: "user_turn",
        content: "Please inspect the projection policy."
      },
      {
        actor: "agent",
        semanticUnitType: "agent_turn",
        content: [
          "The projection policy keeps raw audit data separate.",
          "",
          "Reasoning summary: compare transcript type against policy.",
          "",
          "Readable reasoning summary: choose the projection policy."
        ].join("\n")
      },
      {
        actor: "tool",
        semanticUnitType: "agent_turn",
        content: "Tool call: exec_command"
      }
    ]);
    expect(messages.rows.map((row) => row.content).join("\n")).not.toContain(
      "System instruction"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Developer instruction"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Raw reasoning content"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Unsummarized reasoning item"
    );
    expect(events.rows.map((row) => row.content).join("\n")).not.toContain(
      "Rolling context"
    );
    expect(rawStatuses.rows).toEqual([
      { projection_status: "projected", count: String(rows.length) }
    ]);
  });

  it("treats user interruptions as semantic boundaries inside an agent turn", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-interrupt-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-interrupt-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-interrupt-session-${randomUUID()}`
      }
    );
    const items = [
      {
        transcriptType: "agent_message",
        text: "I am checking the original implementation.",
        sourceHash: `projection-interrupt-agent-before-${randomUUID()}`
      },
      {
        transcriptType: "user_message",
        text: "Actually treat this interruption as a new semantic break.",
        sourceHash: `projection-interrupt-user-${randomUUID()}`
      },
      {
        transcriptType: "agent_message",
        text: "I am continuing with the interruption in mind.",
        sourceHash: `projection-interrupt-agent-after-${randomUUID()}`
      }
    ];
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: items.map((item, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalTurnId: "turn-with-interrupt",
          sourceRecordType: "app_server_notification",
          sourceEventType: "item/completed",
          sourceSequence: index,
          rawJson: {
            method: "item/completed",
            params: {
              item: {
                type: item.transcriptType,
                text: item.text
              }
            }
          },
          rawText: item.text,
          sourceHash: item.sourceHash,
          idempotencyKey: item.sourceHash,
          metadata: { transcriptType: item.transcriptType }
        }))
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await pool.query<{
      content: string;
      semantic_unit_type: string | null;
    }>(
      `
        select
          payload ->> 'content' as content,
          payload #>> '{metadata,semanticUnitType}' as semantic_unit_type
        from memory_events
        order by created_at asc
      `
    );

    expect(projection.memoryEventsCreated).toBe(3);
    expect(events.rows).toEqual([
      {
        semantic_unit_type: "agent_turn",
        content: "I am checking the original implementation."
      },
      {
        semantic_unit_type: "user_turn",
        content: "Actually treat this interruption as a new semantic break."
      },
      {
        semantic_unit_type: "agent_turn",
        content: "I am continuing with the interruption in mind."
      }
    ]);
  });

  it("keeps tool spans separate from agent prose while preserving turn order", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-tool-bundle-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-tool-bundle-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-tool-bundle-session-${randomUUID()}`
      }
    );
    const agentItems = [
      {
        transcriptType: "agent_message",
        text: "I will inspect the repository.",
        sourceHash: `projection-tool-agent-start-${randomUUID()}`
      },
      {
        transcriptType: "function_call",
        text: "Tool call: rg -n projection",
        sourceHash: `projection-tool-call-${randomUUID()}`,
        metadata: {
          toolName: "exec_command",
          toolCall: {
            kind: "call",
            name: "exec_command",
            input: { cmd: "rg -n projection" }
          }
        }
      },
      {
        transcriptType: "function_call_output",
        text: "Tool output: projection entry point found",
        sourceHash: `projection-tool-output-${randomUUID()}`,
        metadata: {
          toolName: "exec_command",
          toolCall: {
            kind: "output",
            name: "exec_command",
            output: "projection entry point found"
          }
        }
      },
      {
        transcriptType: "agent_message",
        text: "The search confirms the projection entry point.",
        sourceHash: `projection-tool-agent-final-${randomUUID()}`
      }
    ];
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: agentItems.map((item, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalTurnId: "tool-heavy-turn",
          sourceRecordType: "app_server_notification",
          sourceEventType: "item/completed",
          sourceSequence: index,
          rawJson: {
            method: "item/completed",
            params: {
              item: {
                type: item.transcriptType,
                text: item.text
              }
            }
          },
          rawText: item.text,
          sourceHash: item.sourceHash,
          idempotencyKey: item.sourceHash,
          metadata: { transcriptType: item.transcriptType, ...item.metadata }
        }))
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const events = await pool.query<{
      id: string;
      actor: string | null;
      content: string;
    }>(
      `
        select id, payload ->> 'actor' as actor, payload ->> 'content' as content
        from memory_events
        where payload #>> '{metadata,semanticUnitType}' = 'agent_turn'
        order by created_at asc
      `
    );
    const sourceLinks = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources where memory_event_id = $1",
      [events.rows[1]?.id]
    );
    const toolEvents = await pool.query<{
      tool_name: string;
      tool_input: unknown;
      tool_response: unknown;
      transcript_item_id: string | null;
    }>(
      `
        select tool_name, tool_input, tool_response, transcript_item_id
        from tool_events
        order by transcript_item_id asc nulls last, id asc
      `
    );

    expect(projection.memoryEventsCreated).toBe(3);
    expect(projection.toolEventsCreated).toBe(2);
    expect(events.rows.map((row) => row.actor)).toEqual([
      "agent",
      "tool",
      "agent"
    ]);
    expect(events.rows.map((row) => row.content)).toEqual([
      "I will inspect the repository.",
      [
        "Tool call: rg -n projection",
        "",
        "Tool output: projection entry point found"
      ].join("\n"),
      "The search confirms the projection entry point."
    ]);
    expect(sourceLinks.rows[0]?.count).toBe("2");
    expect(toolEvents.rows).toHaveLength(2);
    expect(toolEvents.rows[0]?.tool_name).toBe("exec_command");
    expect(toolEvents.rows[0]?.tool_input).toEqual({ cmd: "rg -n projection" });
    expect(toolEvents.rows[0]?.tool_response).toBeNull();
    expect(toolEvents.rows[1]?.tool_input).toBeNull();
    expect(toolEvents.rows[1]?.tool_response).toBe(
      "projection entry point found"
    );
  });

  it("keeps delayed tool output names linked to the original call id", async () => {
    const alice = await repo.createUser({
      email: `alice-projection-delayed-tool-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `projection-delayed-tool-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `projection-delayed-tool-session-${randomUUID()}`
      }
    );
    const callId = `call-delayed-${randomUUID()}`;
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "response_item",
            sourceEventType: "function_call",
            sourceSequence: 1,
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: callId,
                name: "exec_command",
                arguments: { cmd: "date -u +%s" }
              }
            },
            rawText: "Tool call: exec_command",
            sourceHash: `projection-delayed-tool-call-${randomUUID()}`,
            idempotencyKey: `projection-delayed-tool-call-${randomUUID()}`,
            metadata: {
              transcriptType: "function_call",
              toolName: "exec_command",
              toolCall: {
                kind: "call",
                id: callId,
                name: "exec_command",
                input: { cmd: "date -u +%s" }
              }
            }
          }
        ]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "response_item",
            sourceEventType: "function_call_output",
            sourceSequence: 2,
            rawJson: {
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: callId,
                output: "1780026861"
              }
            },
            rawText: "Tool output: 1780026861",
            sourceHash: `projection-delayed-tool-output-${randomUUID()}`,
            idempotencyKey: `projection-delayed-tool-output-${randomUUID()}`,
            metadata: {
              transcriptType: "function_call_output",
              toolCall: {
                kind: "output",
                id: callId,
                output: "1780026861"
              }
            }
          }
        ]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 1 }
    );

    const toolEvents = await pool.query<{
      tool_name: string;
      tool_input: unknown;
      tool_response: unknown;
      transcript_item_id: string | null;
    }>(
      `
        select tool_name, tool_input, tool_response, transcript_item_id
        from tool_events
        where session_id = $1
        order by transcript_item_id asc nulls last, id asc
      `,
      [session.id]
    );

    expect(toolEvents.rows).toHaveLength(2);
    expect(toolEvents.rows[0]).toMatchObject({
      tool_name: "exec_command",
      tool_input: { cmd: "date -u +%s" },
      tool_response: null
    });
    expect(toolEvents.rows[1]).toMatchObject({
      tool_name: "exec_command",
      tool_input: null,
      tool_response: "1780026861"
    });
  });

  it("splits an oversized semantic source only after reconstructing clean text", async () => {
    const previousMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
    process.env.MEMORY_EVENT_MAX_TOKENS = "25";
    try {
      const alice = await repo.createUser({
        email: `alice-projection-large-tool-${randomUUID()}@example.com`
      });
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          externalSessionId: `projection-large-tool-session-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `projection-large-tool-session-${randomUUID()}`
        }
      );
      const text = `Tool output: ${"semantic projection boundary ".repeat(80)}`;
      const sourceHash = `projection-large-tool-${randomUUID()}`;
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "large-tool-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 0,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type: "function_call",
                    text
                  }
                }
              },
              rawText: text,
              sourceHash,
              idempotencyKey: sourceHash,
              metadata: { transcriptType: "function_call" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await pool.query<{
        id: string;
        actor: string | null;
        content: string;
      }>(
        "select id, payload ->> 'actor' as actor, payload ->> 'content' as content from memory_events order by created_at asc"
      );
      const sourceLinks = await pool.query<{ count: string }>(
        "select count(*)::text as count from memory_event_sources"
      );

      expect(projection.memoryEventsCreated).toBeGreaterThan(1);
      expect(new Set(events.rows.map((row) => row.actor))).toEqual(
        new Set(["tool"])
      );
      expect(events.rows.some((row) => row.content.startsWith("Tool:"))).toBe(
        false
      );
      expect(events.rows.map((row) => row.content).join(" ")).toContain(
        "semantic projection boundary"
      );
      expect(sourceLinks.rows[0]?.count).toBe(String(events.rows.length));
    } finally {
      if (previousMaxTokens === undefined) {
        delete process.env.MEMORY_EVENT_MAX_TOKENS;
      } else {
        process.env.MEMORY_EVENT_MAX_TOKENS = previousMaxTokens;
      }
    }
  });

  it("defaults semantic projection chunks below the Qwen operational cap", async () => {
    const previousMaxTokens = process.env.MEMORY_EVENT_MAX_TOKENS;
    const previousEmbeddingMaxTokens = process.env.EMBEDDING_MAX_TOKENS;
    delete process.env.MEMORY_EVENT_MAX_TOKENS;
    delete process.env.EMBEDDING_MAX_TOKENS;
    try {
      const alice = await repo.createUser({
        email: `alice-projection-default-chunk-${randomUUID()}@example.com`
      });
      const session = await repo.createCapturedSession(
        { userId: alice.id },
        {
          externalSessionId: `projection-default-chunk-session-${randomUUID()}`,
          sourceRuntime: "codex",
          idempotencyKey: `projection-default-chunk-session-${randomUUID()}`
        }
      );
      const text = `Agent analysis: ${"default semantic split boundary ".repeat(2600)}`;
      const sourceHash = `projection-default-chunk-${randomUUID()}`;
      await repo.createConversationItems(
        { userId: alice.id },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "codex",
              sourceAdapterVersion: "codex-app-server-v1",
              sourceTransport: "app_server",
              externalTurnId: "default-chunk-turn",
              sourceRecordType: "app_server_notification",
              sourceEventType: "item/completed",
              sourceSequence: 0,
              rawJson: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    text
                  }
                }
              },
              rawText: text,
              sourceHash,
              idempotencyKey: sourceHash,
              metadata: { transcriptType: "agent_message" }
            }
          ]
        }
      );

      const projection = await repo.projectPendingConversationItems(
        { userId: alice.id },
        { limit: 10 }
      );
      const events = await pool.query<{ content: string }>(
        "select payload ->> 'content' as content from memory_events order by created_at asc"
      );

      expect(projection.memoryEventsCreated).toBeGreaterThan(1);
      expect(events.rows.map((row) => row.content).join(" ")).toContain(
        "default semantic split boundary"
      );
    } finally {
      if (previousMaxTokens === undefined) {
        delete process.env.MEMORY_EVENT_MAX_TOKENS;
      } else {
        process.env.MEMORY_EVENT_MAX_TOKENS = previousMaxTokens;
      }
      if (previousEmbeddingMaxTokens === undefined) {
        delete process.env.EMBEDDING_MAX_TOKENS;
      } else {
        process.env.EMBEDDING_MAX_TOKENS = previousEmbeddingMaxTokens;
      }
    }
  });

  it("reconstructs oversized transport chunks before semantic projection", async () => {
    const alice = await repo.createUser({
      email: `alice-transport-chunks-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'Transport Chunk Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `transport-chunk-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `transport-chunk-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const logicalSourceId = `transport-logical-${randomUUID()}`;
    const reconstructedText =
      "This clean reconstructed answer should be embedded without transport JSON.";
    const rawJson = {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          text: reconstructedText
        }
      }
    };
    const envelope = JSON.stringify({
      rawJson,
      rawText: reconstructedText
    });
    const midpoint = Math.floor(envelope.length / 2);
    const chunks = [envelope.slice(0, midpoint), envelope.slice(midpoint)];

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: chunks.map((chunk, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalTurnId: "turn-transport",
          sourceRecordType: "app_server_notification",
          sourceEventType: "item/completed",
          sourceSequence: 100 + index,
          rawJson: {
            transportChunk: true,
            sourceItemHash: logicalSourceId,
            chunkIndex: index,
            chunkCount: chunks.length
          },
          logicalSourceId,
          transportChunkIndex: index,
          transportChunkCount: chunks.length,
          transportChunkText: chunk,
          transportChunkEncoding: "conversation-item-json-v1",
          sourceHash: `${logicalSourceId}-chunk-${index}`,
          idempotencyKey: `${logicalSourceId}-chunk-${index}`,
          metadata: {
            workspaceId,
            transcriptType: "agent_message",
            sourceItemHash: logicalSourceId,
            sourceChunkIndex: index,
            sourceChunkCount: chunks.length
          }
        }))
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const secondProjection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const messages = await pool.query<{ content: string }>(
      "select content from messages order by created_at asc"
    );
    const events = await pool.query<{ id: string; content: string }>(
      "select id, payload ->> 'content' as content from memory_events order by created_at asc"
    );
    const links = await pool.query<{ count: string }>(
      "select count(*)::text as count from memory_event_sources"
    );
    const statuses = await pool.query<{
      projection_status: string;
      projection_version: string | null;
    }>(
      "select projection_status, projection_version from conversation_items order by transport_chunk_index asc"
    );

    expect(projection.rawItemsScanned).toBe(1);
    expect(projection.rawItemsProjected).toBe(2);
    expect(projection.messagesCreated).toBe(1);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(secondProjection.rawItemsScanned).toBe(0);
    expect(messages.rows.map((row) => row.content)).toEqual([
      reconstructedText
    ]);
    expect(events.rows.map((row) => row.content)).toEqual([reconstructedText]);
    expect(events.rows[0]?.content).not.toContain("transportChunk");
    expect(events.rows[0]?.content).not.toContain("rawJson");
    expect(links.rows[0]?.count).toBe("2");
    expect(statuses.rows).toEqual([
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v3"
      }
    ]);
  });

  it("sanitizes storage-unsafe strings after decoding transport chunk envelopes", async () => {
    const alice = await repo.createUser({
      email: `alice-nul-transport-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    await pool.query(
      `
        insert into workspaces (id, owner_user_id, visibility, name)
        values ($1, $2, 'personal', 'NUL Transport Project')
      `,
      [workspaceId, alice.id]
    );
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `nul-transport-session-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `nul-transport-session-${randomUUID()}`,
        metadata: { workspaceId }
      }
    );
    const logicalSourceId = `nul-transport-logical-${randomUUID()}`;
    const reconstructedText = `Chunked decoded text is 你好 c${"\u0000"}d${"\uD800"}e.`;
    const envelope = JSON.stringify({
      rawJson: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            text: reconstructedText
          }
        }
      },
      rawText: reconstructedText
    });
    const midpoint = Math.floor(envelope.length / 2);
    const chunks = [envelope.slice(0, midpoint), envelope.slice(midpoint)];

    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: chunks.map((chunk, index) => ({
          sessionId: session.id,
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalTurnId: "turn-nul-transport",
          sourceRecordType: "app_server_notification",
          sourceEventType: "item/completed",
          sourceSequence: 120 + index,
          rawJson: {
            transportChunk: true,
            sourceItemHash: logicalSourceId,
            chunkIndex: index,
            chunkCount: chunks.length
          },
          logicalSourceId,
          transportChunkIndex: index,
          transportChunkCount: chunks.length,
          transportChunkText: chunk,
          transportChunkEncoding: "conversation-item-json-v1",
          sourceHash: `${logicalSourceId}-chunk-${index}`,
          idempotencyKey: `${logicalSourceId}-chunk-${index}`,
          metadata: {
            workspaceId,
            transcriptType: "agent_message",
            sourceItemHash: logicalSourceId,
            sourceChunkIndex: index,
            sourceChunkCount: chunks.length
          }
        }))
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 20 }
    );
    const events = await pool.query<{ content: string; metadata: unknown }>(
      "select payload ->> 'content' as content, payload -> 'metadata' as metadata from memory_events order by created_at asc"
    );

    expect(projection.rawItemsProjected).toBe(2);
    expect(projection.memoryEventsCreated).toBe(1);
    expect(events.rows[0]?.content).toBe("Chunked decoded text is 你好 c�d�e.");
    expect(events.rows[0]?.content).not.toContain("\u0000");
    expect(events.rows[0]?.content).not.toContain("\\u0000");
    expect(events.rows[0]?.metadata).toMatchObject({
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 2
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 2
        }
      }
    });
  });

  it("keeps projected app-server threads under the canonical session project", async () => {
    const alice = await repo.createUser({
      email: `alice-canonical-project-${randomUUID()}@example.com`
    });
    const cwd = "/workspace/koed";
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        cwd,
        externalSessionId: `canonical-project-${randomUUID()}`,
        sourceRuntime: "codex",
        idempotencyKey: `canonical-project-session-${randomUUID()}`
      }
    );
    await repo.createConversationItems(
      { userId: alice.id },
      {
        items: [
          {
            sessionId: session.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalSessionId: session.externalSessionId ?? undefined,
            externalThreadId: session.externalSessionId ?? undefined,
            externalTurnId: "turn-1",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceSequence: 0,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "Canonical project message"
                }
              }
            },
            sourceHash: `canonical-project-raw-${randomUUID()}`,
            idempotencyKey: `canonical-project-raw-${randomUUID()}`,
            metadata: {
              workspaceId: session.id,
              transcriptType: "agent_message"
            }
          }
        ]
      }
    );

    const projection = await repo.projectPendingConversationItems(
      { userId: alice.id },
      { limit: 10 }
    );
    const projects = await repo.listLcmGraphThreads(
      { userId: alice.id },
      { limit: 10 }
    );

    expect(projection.memoryEventsCreated).toBe(1);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe(cwd);
    expect(projects[0]?.threads).toHaveLength(1);
  });

  it("preserves manual session titles across idempotent capture upserts", async () => {
    const alice = await repo.createUser({
      email: `alice-manual-title-upsert-${randomUUID()}@example.com`
    });
    const idempotencyKey = `manual-title-session-${randomUUID()}`;
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `manual-title-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey,
        metadata: {
          threadName: "Original Hook Title",
          threadNameSource: "provisional"
        }
      }
    );
    await repo.updateCapturedSessionTitle({ userId: alice.id }, session.id, {
      title: "Manual Rename Wins"
    });

    const upserted = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: session.externalSessionId ?? undefined,
        sourceRuntime: "codex-cli",
        idempotencyKey,
        metadata: {
          threadName: "Original Hook Title",
          threadNameSource: "provisional",
          projectName: "Updated Project"
        }
      }
    );

    expect(upserted.id).toBe(session.id);
    expect(upserted.metadata).toMatchObject({
      projectName: "Updated Project",
      threadName: "Manual Rename Wins",
      threadNameSource: "manual"
    });
  });

  it("uses capture-hook subagent actors for generated title eligibility", async () => {
    const alice = await repo.createUser({
      email: `alice-subagent-title-${randomUUID()}@example.com`
    });
    const workspaceId = randomUUID();
    const session = await repo.createCapturedSession(
      { userId: alice.id },
      {
        workspaceId,
        externalSessionId: `subagent-title-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `subagent-title-session-${randomUUID()}`,
        metadata: {
          threadName: "subagent-title-thread",
          threadNameSource: "provisional",
          threadKind: "subagent"
        }
      }
    );
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        sessionId: session.id,
        actor: "agent",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "Please inspect the session rename implementation.",
        idempotencyKey: `subagent-title-agent-${randomUUID()}`,
        sourceHash: `subagent-title-agent-${randomUUID()}`
      }
    );
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId,
        sessionId: session.id,
        actor: "subagent",
        eventType: "captured",
        rawEventType: "message",
        visibility: "personal",
        content: "The implementation should cover manual title precedence.",
        idempotencyKey: `subagent-title-reply-${randomUUID()}`,
        sourceHash: `subagent-title-reply-${randomUUID()}`
      }
    );

    const candidates = await repo.listCapturedSessionsNeedingTitles(
      { userId: alice.id },
      { minUserEvents: 1, limit: 5 }
    );
    const candidate = candidates.find((item) => item.id === session.id);

    expect(candidate).toMatchObject({
      id: session.id,
      eventCount: 1
    });
    expect(candidate?.sourceItems.map((item) => item.actor)).toEqual([
      "agent",
      "subagent"
    ]);
  });

  it("stores concrete parent session linkage for subagent sessions", async () => {
    const alice = await repo.createUser({
      email: `alice-subagent-parent-${randomUUID()}@example.com`
    });
    const parent = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `parent-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `parent-session-${randomUUID()}`
      }
    );
    const child = await repo.createCapturedSession(
      { userId: alice.id },
      {
        externalSessionId: `child-thread-${randomUUID()}`,
        sourceRuntime: "codex-cli",
        idempotencyKey: `child-session-${randomUUID()}`,
        metadata: {
          threadKind: "subagent",
          parentThreadId: parent.externalSessionId
        }
      }
    );
    const row = await pool.query<{ parent_session_id: string | null }>(
      "select parent_session_id from sessions where id = $1",
      [child.id]
    );

    expect(row.rows[0]?.parent_session_id).toBe(parent.id);
  });

  it("fetches an exact LCM graph node when newer summaries mention the node id", async () => {
    const alice = await repo.createUser({
      email: `alice-exact-lcm-node-${randomUUID()}@example.com`
    });
    const target = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Target LCM node summary",
        summaryModel: "codex:test"
      }
    );
    await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: `Newer rollup summary mentions node ${target.id}`,
        summaryModel: "codex:test"
      }
    );

    const fetched = await repo.getLcmGraphNode({ userId: alice.id }, target.id);

    expect(fetched?.id).toBe(target.id);
    expect(fetched?.summaryText).toBe("Target LCM node summary");
  });

  it("persists structured LCM summary data beside summary text", async () => {
    const alice = await repo.createUser({
      email: `alice-structured-lcm-${randomUUID()}@example.com`
    });
    const node = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "personal",
        summaryText: "Pending placeholder"
      }
    );
    const structured = {
      summary_text: "Structured summary text",
      facts: ["The worker returned strict JSON."],
      unresolved_questions: []
    };

    await repo.updateLcmNodeSummary({
      nodeId: node.id,
      summaryText: "Structured summary text",
      summaryModel: "codex:test",
      summaryPromptVersion: "lcm-codex-summary-json-v2",
      summaryTokenEstimate: 17,
      summaryStructuredJson: structured,
      summaryStructuredSchemaVersion: "lcm-structured-summary-v1"
    });

    const fetched = await repo.getLcmNodeForSummarization(node.id);
    const visible = await repo.getVisibleLcmNodeForSummarization(
      { userId: alice.id },
      node.id
    );
    const graphNode = await repo.getLcmGraphNode({ userId: alice.id }, node.id);

    expect(fetched?.summaryText).toBe("Structured summary text");
    expect(fetched?.summaryStructuredJson).toEqual(structured);
    expect(fetched?.summaryStructuredSchemaVersion).toBe(
      "lcm-structured-summary-v1"
    );
    expect(visible?.summaryStructuredJson).toEqual(structured);
    expect(graphNode?.summaryStructuredJson).toEqual(structured);
    expect(graphNode?.summaryStructuredSchemaVersion).toBe(
      "lcm-structured-summary-v1"
    );
  });

  it("prefers idempotency key matches over source hash matches", async () => {
    const alice = await repo.createUser({
      email: `alice-duplicate-priority-${randomUUID()}@example.com`
    });
    const firstIdempotencyKey = `idempotency-${randomUUID()}`;
    const firstSourceHash = `source-hash-${randomUUID()}`;
    const secondIdempotencyKey = `idempotency-${randomUUID()}`;
    const secondSourceHash = `source-hash-${randomUUID()}`;
    const first = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-duplicate-priority",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "First duplicate priority event",
        idempotencyKey: firstIdempotencyKey,
        sourceHash: firstSourceHash
      }
    );
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-duplicate-priority",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Second duplicate priority event",
        idempotencyKey: secondIdempotencyKey,
        sourceHash: secondSourceHash
      }
    );

    const mismatchedRetry = await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-duplicate-priority",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Mismatched duplicate priority event",
        idempotencyKey: firstIdempotencyKey,
        sourceHash: secondSourceHash
      }
    );

    expect(mismatchedRetry.id).toBe(first.id);
  });

  it("returns a conflict for duplicate keys outside caller visibility", async () => {
    const alice = await repo.createUser({
      email: `alice-hidden-duplicate-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-hidden-duplicate-${randomUUID()}@example.com`
    });
    const sourceHash = `source-hash-${randomUUID()}`;
    await repo.createMemoryEvent(
      { userId: alice.id },
      {
        workspaceId: "workspace-hidden-duplicate",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        visibility: "personal",
        content: "Hidden duplicate source",
        sourceHash
      }
    );

    await expect(
      repo.createMemoryEvent(
        { userId: bob.id },
        {
          workspaceId: "workspace-hidden-duplicate",
          actor: "user",
          eventType: "captured",
          rawEventType: "user_prompt",
          visibility: "personal",
          content: "Hidden duplicate retry",
          sourceHash
        }
      )
    ).rejects.toMatchObject({
      message:
        "Duplicate memory event conflicts with memory outside caller visibility",
      statusCode: 409
    });
  });

  it("handles concurrent duplicate capture submissions", async () => {
    const alice = await repo.createUser({
      email: `alice-concurrent-duplicate-${randomUUID()}@example.com`
    });
    const sourceHash = `source-hash-${randomUUID()}`;
    const idempotencyKey = `idempotency-${randomUUID()}`;
    const captures = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.createMemoryEvent(
          { userId: alice.id },
          {
            workspaceId: "workspace-concurrent-duplicate",
            actor: "user",
            eventType: "captured",
            rawEventType: "user_prompt",
            visibility: "personal",
            content: "Concurrent duplicate capture",
            idempotencyKey,
            sourceHash
          }
        )
      )
    );
    const events = await repo.listLcmGraphEvents(
      { userId: alice.id },
      { query: "Concurrent duplicate capture", includeInvalidated: false }
    );

    expect(new Set(captures.map((event) => event.id)).size).toBe(1);
    expect(events.map((event) => event.id)).toEqual([captures[0]!.id]);
  });
});
