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
  presentMemoryText,
  type MemorySourceRepository
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const runDbTests = Boolean(databaseUrl);
const originalFreshEventTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;

const describeDb = runDbTests ? describe : describe.skip;

describe("memory presentation helpers", () => {
  const provenance = {
    project_name: "/Users/jacobo/Coding/koed",
    project_path: "/Users/jacobo/Coding/koed"
  };

  it("does not expose raw tool input JSON as memory text", () => {
    const text = presentMemoryText(
      JSON.stringify({
        toolInput: {
          command: "node --input-type=module <<'EOF'\nconsole.log('secret')\nEOF"
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
      metadata?: Record<string, unknown>;
    }
  ) =>
    engine.capturePersonalEvent({
      requesterContext: { userId },
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: "user",
      eventType: "user_prompt",
      content: input.content,
      metadata: input.metadata
    });

  const embedPendingSources = async () => {
    const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
    const vector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const sources = await repo.listSourcesNeedingEmbeddings(500);
    for (const source of sources) {
      await repo.upsertSourceEmbedding({
        source,
        model: process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B-GGUF",
        dimensions,
        version:
          process.env.EMBEDDING_VERSION ?? "local-qwen3-embedding-0.6b-gguf-v1",
        vector
      });
    }
  };

  beforeAll(async () => {
    process.env.MEMORY_LCM_FRESH_EVENT_TAIL = "0";
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
          provider_configs,
          api_tokens,
          memory_embeddings_3072,
          memory_embeddings_1536,
          memory_embeddings_1024,
          memory_embeddings_384,
          memory_embeddings,
          memory_node_children,
          memory_node_sources,
          memory_nodes,
          memory_events,
          tool_events,
          messages,
          turns,
          sessions,
          workspaces,
          team_members,
          teams,
          user_sessions,
          users
        restart identity cascade
      `
    );
  });

  afterAll(async () => {
    if (originalFreshEventTail === undefined) {
      delete process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
    } else {
      process.env.MEMORY_LCM_FRESH_EVENT_TAIL = originalFreshEventTail;
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

  it("rejects team memory writes from solo users", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });

    await expect(
      repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "team",
          summaryText: "No team target"
        }
      )
    ).rejects.toThrow("Team visibility requires a teamId");
  });

  it("rejects team memory writes from non-members", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam({
      name: "Research",
      createdByUserId: bob.id
    });

    await expect(
      repo.createMemoryNode(
        { userId: alice.id },
        {
          visibility: "team",
          teamId: team.id,
          summaryText: "Alice should not be able to write here"
        }
      )
    ).rejects.toThrow("User is not an active member");
  });

  it("allows team members to read team memory", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-${randomUUID()}@example.com`
    });
    const outsider = await repo.createUser({
      email: `outsider-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam({
      name: "Research",
      createdByUserId: alice.id
    });
    await repo.addTeamMember(team.id, bob.id);

    await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "team",
        teamId: team.id,
        summaryText: "Shared team memory",
        captureMethod: "mcp"
      }
    );

    const aliceMemories = await repo.listVisibleMemoryNodes(
      { userId: alice.id },
      "team"
    );
    const bobMemories = await repo.listVisibleMemoryNodes(
      { userId: bob.id },
      "team"
    );
    const outsiderMemories = await repo.listVisibleMemoryNodes(
      { userId: outsider.id },
      "team"
    );

    expect(aliceMemories).toHaveLength(1);
    expect(bobMemories).toHaveLength(1);
    expect(bobMemories[0]?.summaryText).toBe("Shared team memory");
    expect(outsiderMemories).toHaveLength(0);
  });

  it("stores provider API keys encrypted and returns only redacted configs publicly", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const saved = await repo.createProviderConfig(
      { userId: alice.id },
      {
        visibility: "personal",
        provider: "openai-compatible",
        apiKey: "sk-secret-test",
        config: {
          baseUrl: "https://models.example.test/v1",
          embedding_model: "embed-model",
          summary_model: "summary-model",
          answer_model: "answer-model",
          embedding_dimensions: 1536,
          enabled: true
        }
      }
    );

    const raw = await pool.query<{
      encrypted_api_key: Buffer;
      config: Record<string, unknown>;
    }>("select encrypted_api_key, config from provider_configs where id = $1", [
      saved.id
    ]);
    const listed = await repo.listProviderConfigs({ userId: alice.id });
    const runtime = await repo.getRuntimeProviderConfig(
      { userId: alice.id },
      { provider: "openai-compatible" }
    );

    expect(raw.rows[0]?.encrypted_api_key.toString("utf8")).not.toContain(
      "sk-secret-test"
    );
    expect(raw.rows[0]?.config.apiKey).toBeUndefined();
    expect(listed[0]?.config.apiKey).toBeUndefined();
    expect(listed[0]?.config.apiKeyConfigured).toBe(true);
    expect(runtime?.apiKey).toBe("sk-secret-test");
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

    const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
    const firstVector = Array.from({ length: dimensions }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const secondVector = Array.from({ length: dimensions }, (_, index) =>
      index === 1 ? 1 : 0
    );
    const model =
      process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B-GGUF";
    const version =
      process.env.EMBEDDING_VERSION ?? "local-qwen3-embedding-0.6b-gguf-v1";

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

  it("keeps non-rerankable vector hits when summary reranking is enabled", async () => {
    const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
    const originalRerankingEnabled = process.env.RERANKING_ENABLED;
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.RERANKING_ENABLED = "true";

    try {
      const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
      const queryVector = Array.from({ length: dimensions }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const endpoint = String(url);
        if (endpoint.endsWith("/embed")) {
          return new Response(
            JSON.stringify({
              model:
                process.env.EMBEDDING_MODEL ??
                "Qwen/Qwen3-Embedding-0.6B-GGUF",
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
      const model =
        process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B-GGUF";
      const version =
        process.env.EMBEDDING_VERSION ?? "local-qwen3-embedding-0.6b-gguf-v1";
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
      if (originalRerankingEnabled === undefined) {
        delete process.env.RERANKING_ENABLED;
      } else {
        process.env.RERANKING_ENABLED = originalRerankingEnabled;
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

  it("retrieves team-visible captured conversation for a teammate", async () => {
    const alice = await repo.createUser({
      email: `alice-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam({
      name: "Research",
      createdByUserId: alice.id
    });
    await repo.addTeamMember(team.id, bob.id);
    const engine = createMemoryEngine(repo);

    for (let index = 1; index <= 5; index += 1) {
      await repo.createMemoryEvent(
        { userId: alice.id },
        {
          workspaceId: "workspace-team",
          actor: "user",
          eventType: "captured",
          rawEventType: "user_prompt",
          visibility: "team",
          teamId: team.id,
          content: `Team fact ${index}: release train owner is Bob.`
        }
      );
    }
    await engine.scheduleCompaction({
      requesterContext: { userId: alice.id },
      visibility: "team",
      teamId: team.id
    });
    await embedPendingSources();

    const teammateSearch = await engine.searchMemory({
      requesterContext: { userId: bob.id },
      query: "release train owner",
      scope: "team"
    });

    expect(teammateSearch.results.length).toBeGreaterThan(0);
    expect(teammateSearch.results[0]?.summaryText).toContain(
      "release train owner is Bob"
    );
    expect(teammateSearch.results[0]?.citation.visibility).toBe("team");
  });
});
