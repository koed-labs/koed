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
          model: "Qwen/Qwen3-Embedding-0.6B-GGUF",
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
      model: "Qwen/Qwen3-Embedding-0.6B-GGUF",
      dimensions: 1024,
      error: "Embedding service token rejected"
    });
    expect(new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get(
      "x-koed-embedding-token"
    )).toBe("api-token");
  });

  it("reports embedding health as healthy when token authentication succeeds", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_TOKEN = "api-token";
    const repo = createMemorySourceRepository({} as pg.Pool);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "Qwen/Qwen3-Embedding-0.6B-GGUF",
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
      model: "Qwen/Qwen3-Embedding-0.6B-GGUF",
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
    const originalEmbeddingServiceToken = process.env.EMBEDDING_SERVICE_TOKEN;
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.RERANKING_ENABLED = "true";
    process.env.EMBEDDING_SERVICE_TOKEN = "test-embedding-token";

    try {
      const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
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
              model:
                process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B-GGUF",
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
