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
const originalLeafEventThreshold = process.env.MEMORY_LCM_LEAF_EVENT_THRESHOLD;
const originalLeafTokenThreshold = process.env.MEMORY_LCM_LEAF_TOKEN_THRESHOLD;
const originalFreshEventTail = process.env.MEMORY_LCM_FRESH_EVENT_TAIL;
const originalDepthOneFanout = process.env.MEMORY_LCM_DEPTH1_FANOUT;

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
      visibility?: "personal" | "team";
      teamId?: string;
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
      visibility: input.visibility,
      teamId: input.teamId,
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
          workflow_token_usage,
          memory_nodes,
          memory_events,
          conversation_items,
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

  it("keeps Team Memory graph, search, and export scoped to team membership", async () => {
    const alice = await repo.createUser({
      email: `alice-team-boundary-${randomUUID()}@example.com`
    });
    const bob = await repo.createUser({
      email: `bob-team-boundary-${randomUUID()}@example.com`
    });
    const outsider = await repo.createUser({
      email: `outsider-team-boundary-${randomUUID()}@example.com`
    });
    const aliceTeam = await repo.createTeam({
      name: "Alpha Research",
      createdByUserId: alice.id
    });
    const bobTeam = await repo.createTeam({
      name: "Beta Research",
      createdByUserId: bob.id
    });
    const engine = createMemoryEngine(repo);

    const aliceEvent = await captureUserEvent(engine, alice.id, {
      workspaceId: "workspace-team-alpha",
      visibility: "team",
      teamId: aliceTeam.id,
      content: "Alpha team source evidence."
    });
    const bobEvent = await captureUserEvent(engine, bob.id, {
      workspaceId: "workspace-team-beta",
      visibility: "team",
      teamId: bobTeam.id,
      content: "Beta team source evidence."
    });
    const aliceNode = await repo.createMemoryNode(
      { userId: alice.id },
      {
        visibility: "team",
        teamId: aliceTeam.id,
        summaryText: "Alpha team memory node"
      }
    );
    const bobNode = await repo.createMemoryNode(
      { userId: bob.id },
      {
        visibility: "team",
        teamId: bobTeam.id,
        summaryText: "Beta team memory node"
      }
    );
    await pool.query(
      `
        insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
        values ($1, $2, 0), ($3, $4, 0)
      `,
      [aliceNode.id, aliceEvent.id, bobNode.id, bobEvent.id]
    );
    await embedPendingSources();

    const bobGraphNodes = await repo.listLcmGraphNodes(
      { userId: bob.id },
      { visibility: "team", includeInvalidated: true }
    );
    expect(bobGraphNodes.map((node) => node.id)).toContain(bobNode.id);
    expect(bobGraphNodes.map((node) => node.id)).not.toContain(aliceNode.id);

    const bobGraphEvents = await repo.listLcmGraphEvents(
      { userId: bob.id },
      { visibility: "team", includeContent: true, includeRaw: true }
    );
    expect(bobGraphEvents.map((event) => event.id)).toContain(bobEvent.id);
    expect(bobGraphEvents.map((event) => event.id)).not.toContain(
      aliceEvent.id
    );

    const bobSearch = await engine.searchMemory({
      requesterContext: { userId: bob.id },
      query: "team source evidence",
      scope: "team",
      limit: 10
    });
    expect(bobSearch.results.map((result) => result.nodeId)).toContain(
      bobNode.id
    );
    expect(bobSearch.results.map((result) => result.nodeId)).not.toContain(
      aliceNode.id
    );

    const bobExport = await repo.exportMemoryRecords({ userId: bob.id });
    expect(bobExport.nodes.map((node) => node.id)).toContain(bobNode.id);
    expect(bobExport.nodes.map((node) => node.id)).not.toContain(aliceNode.id);
    expect(bobExport.events.map((event) => event.id)).toContain(bobEvent.id);
    expect(bobExport.events.map((event) => event.id)).not.toContain(
      aliceEvent.id
    );

    const outsiderExport = await repo.exportMemoryRecords({
      userId: outsider.id
    });
    expect(outsiderExport.nodes).toHaveLength(0);
    expect(outsiderExport.events).toHaveLength(0);
  });

  it("requires admin or owner role to modify existing Team Memory", async () => {
    const owner = await repo.createUser({
      email: `owner-${randomUUID()}@example.com`
    });
    const admin = await repo.createUser({
      email: `admin-${randomUUID()}@example.com`
    });
    const member = await repo.createUser({
      email: `member-${randomUUID()}@example.com`
    });
    const team = await repo.createTeam({
      name: "Permissions",
      createdByUserId: owner.id
    });
    await repo.addTeamMember(team.id, admin.id, "admin");
    await repo.addTeamMember(team.id, member.id);
    const memory = await repo.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "team",
        teamId: team.id,
        summaryText: "Team-governed memory",
        captureMethod: "mcp"
      }
    );
    const personalMemory = await repo.createMemoryNode(
      { userId: member.id },
      {
        visibility: "personal",
        summaryText: "Member personal memory",
        captureMethod: "mcp"
      }
    );

    await expect(
      repo.updateLcmGraphNode({ userId: member.id }, memory.id, {
        summaryText: "Member edit"
      })
    ).rejects.toThrow("User is not allowed to modify Team Memory");
    await expect(
      repo.deleteMemory({ userId: member.id }, memory.id)
    ).rejects.toThrow("User is not allowed to modify Team Memory");

    await expect(
      repo.updateLcmGraphNode({ userId: member.id }, personalMemory.id, {
        summaryText: "Member personal edit"
      })
    ).resolves.toMatchObject({ summaryText: "Member personal edit" });
    await expect(
      repo.updateLcmGraphNode({ userId: admin.id }, memory.id, {
        summaryText: "Admin edit"
      })
    ).resolves.toMatchObject({ summaryText: "Admin edit" });
    await expect(
      repo.deleteMemory({ userId: owner.id }, memory.id)
    ).resolves.toBe(true);
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
          expect(new Headers(init?.headers).get("x-koed-embedding-token")).toBe(
            "test-embedding-token"
          );
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
        threadName: "Question Thread"
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
      attemptCount: 1
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

  it("rejects token usage linked to sessions, turns, or raw items outside caller scope", async () => {
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
      total_tokens: number | null;
    }>(
      "select workflow_type, workflow_id, total_tokens from workflow_token_usage"
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
        projection_version: "conversation-projection-v2"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v2"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v2"
      }
    ]);
    expect(embeddable.some((source) => source.sourceType === "message")).toBe(
      false
    );
    expect(
      embeddable.some((source) => source.sourceType === "memory_event")
    ).toBe(true);
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
    const events = await pool.query<{ content: string }>(
      "select payload ->> 'content' as content from memory_events order by created_at asc"
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
    expect(projection.memoryEventsCreated).toBe(5);
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
    expect(events.rows.map((row) => row.content)).toEqual([
      "Please inspect the projection policy.",
      "The projection policy keeps raw audit data separate.",
      "Reasoning summary: compare transcript type against policy.",
      "Readable reasoning summary: choose the projection policy.",
      "Tool call: exec_command"
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
        projection_version: "conversation-projection-v2"
      },
      {
        projection_status: "projected",
        projection_version: "conversation-projection-v2"
      }
    ]);
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
