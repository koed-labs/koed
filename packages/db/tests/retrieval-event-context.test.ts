import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { retrieveCanonicalEventContext } from "../src/retrieval-event-context.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("canonical retrieval event context", () => {
  const pool = createDbPool({ connectionString: databaseUrl });
  const repo = createMemorySourceRepository(pool);
  beforeAll(() => runDbMigrations(pool));
  afterAll(() => pool.end());

  it("discards selected event and node embeddings invalidated before canonical hydration", async () => {
    const owner = await repo.createUser({
      email: `context-race-${randomUUID()}@example.com`
    });
    const event = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        projectId: "context-race",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        content: "Original selected content",
        visibility: "personal"
      }
    );
    const node = await repo.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "Selected node",
        captureMethod: "transcript",
        sourceRuntime: "codex"
      }
    );
    await pool.query(
      "insert into memory_node_sources (memory_node_id,memory_event_id,source_order) values ($1,$2,0)",
      [node.id, event.id]
    );
    const hits = [];
    for (const sourceType of ["memory_event", "memory_node"]) {
      const sourceId = sourceType === "memory_event" ? event.id : node.id;
      const embedding = await pool.query<{ id: string }>(
        `insert into memory_embeddings
          (memory_event_id,memory_node_id,owner_user_id,visibility,embedding_model,
           embedding_dimensions,embedding_version,source_hash,
           embedding_source_content_hash,embedding_input_hash)
         values ($1,$2,$3,'personal','context-race',1024,'context-race','selected','content','input') returning id`,
        [
          sourceType === "memory_event" ? event.id : null,
          sourceType === "memory_node" ? node.id : null,
          owner.id
        ]
      );
      hits.push({
        nodeId: sourceId,
        sourceId,
        sourceType,
        embeddingId: embedding.rows[0]!.id
      });
    }
    const input = {
      userId: owner.id,
      hits,
      searchDomain: "global",
      sourceAfter: null,
      sourceBefore: null
    };
    const hydrate = async <T>(event: T) => event;
    expect(
      (await retrieveCanonicalEventContext(pool, input, hydrate)).size
    ).toBe(2);
    await pool.query(
      "update memory_events set payload=jsonb_set(payload,'{content}','\"Unrelated replacement content\"') where id=$1",
      [event.id]
    );
    await pool.query(
      "update memory_embeddings set invalidated_at=now() where id=any($1::uuid[])",
      [hits.map((hit) => hit.embeddingId)]
    );
    expect(await retrieveCanonicalEventContext(pool, input, hydrate)).toEqual(
      new Map()
    );
  });

  it("returns full events, deduplicates overlapping neighbors, and respects true filtered adjacency", async () => {
    const owner = await repo.createUser({
      email: `context-${randomUUID()}@example.com`
    });
    const stranger = await repo.createUser({
      email: `context-stranger-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        sourceRuntime: "codex-cli",
        externalSessionId: randomUUID()
      }
    );
    const otherSession = await repo.createCapturedSession(
      { userId: owner.id },
      {
        sourceRuntime: "codex-cli",
        externalSessionId: randomUUID()
      }
    );
    const contents = [
      "Earlier distant event",
      "Hidden adjacent event",
      "Fact 4254 is the complete canonical value.",
      "Following assistant response",
      "Last event"
    ];
    const events = [];
    for (const [index, content] of contents.entries()) {
      events.push(
        await repo.createMemoryEvent(
          { userId: owner.id },
          {
            projectId: "retrieval-context",
            sessionId: session.id,
            actor: index === 3 ? "assistant" : "user",
            eventType: "captured",
            rawEventType: "user_prompt",
            content,
            visibility: "personal",
            capturedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
            sourceEventTime: new Date(
              Date.UTC(2030 - index, 0, 1)
            ).toISOString()
          }
        )
      );
    }
    await repo.createMemoryEvent(
      { userId: owner.id },
      {
        projectId: "retrieval-context",
        sessionId: otherSession.id,
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        content: "Different Conversation",
        visibility: "personal"
      }
    );
    await pool.query(
      "update memory_events set personal_deleted_at = now() where id = $1",
      [events[1]!.id]
    );
    const hits = [events[2]!, events[3]!].map((event) => ({
      nodeId: event.id,
      sourceId: event.id,
      sourceType: "memory_event"
    }));
    const input = {
      userId: owner.id,
      hits,
      searchDomain: "session",
      sessionId: session.id,
      sourceAfter: null,
      sourceBefore: null
    };
    const hydrate = async <T>(event: T) => event;
    const context = await retrieveCanonicalEventContext(pool, input, hydrate);
    const first = context.get(`memory_event:${events[2]!.id}`)!;
    expect(first.map((item) => item.sourceId)).toEqual([
      events[2]!.id,
      events[3]!.id
    ]);
    expect(first[0]).toMatchObject({
      text: contents[2],
      actor: "user",
      provenance: { contextRole: "matched", matchedSourceIds: [events[2]!.id] }
    });
    expect(first[1]).toMatchObject({ text: contents[3], actor: "assistant" });
    expect(first.map((item) => item.sourceId)).not.toContain(events[0]!.id);
    expect(
      await retrieveCanonicalEventContext(
        pool,
        { ...input, userId: stranger.id },
        hydrate
      )
    ).toEqual(new Map());
    expect(
      await retrieveCanonicalEventContext(
        pool,
        { ...input, sessionId: otherSession.id },
        hydrate
      )
    ).toEqual(new Map());
    const windowed = await retrieveCanonicalEventContext(
      pool,
      {
        ...input,
        sourceAfter: new Date("2028-01-01T00:00:00Z"),
        sourceBefore: new Date("2029-01-01T00:00:00Z")
      },
      hydrate
    );
    expect(
      windowed
        .get(`memory_event:${events[2]!.id}`)
        ?.map((item) => item.sourceId)
    ).toEqual([events[2]!.id]);

    const node = await repo.createMemoryNode(
      { userId: owner.id },
      {
        visibility: "personal",
        summaryText: "Canonical events",
        captureMethod: "transcript",
        sourceRuntime: "codex"
      }
    );
    await pool.query(
      "insert into memory_node_sources (memory_node_id, memory_event_id, source_order) values ($1,$2,0),($1,$3,1)",
      [node.id, events[2]!.id, events[3]!.id]
    );
    const nodeContext = await retrieveCanonicalEventContext(
      pool,
      {
        ...input,
        hits: [
          { nodeId: node.id, sourceType: "memory_node", sourceId: node.id }
        ]
      },
      hydrate
    );
    expect(
      nodeContext.get(`memory_node:${node.id}`)?.map((item) => item.sourceId)
    ).toEqual([events[2]!.id, events[3]!.id, events[4]!.id]);
    expect(
      nodeContext.get(`memory_node:${node.id}`)?.[1]?.provenance
    ).toMatchObject({
      contextRole: "matched"
    });
    await pool.query(
      "update memory_events set include_in_embedding=false,include_in_lcm=false where id=$1",
      [events[3]!.id]
    );
    const excludedNeighbor = await retrieveCanonicalEventContext(
      pool,
      {
        ...input,
        hits: [hits[0]!]
      },
      hydrate
    );
    expect(
      excludedNeighbor
        .get(`memory_event:${events[2]!.id}`)
        ?.map((item) => item.sourceId)
    ).toEqual([events[2]!.id]);
    await pool.query(
      "update memory_events set include_in_embedding=true,include_in_lcm=true where id=$1",
      [events[3]!.id]
    );
    await pool.query(
      "update memory_events set captured_at = '2026-01-01T00:00:00Z' where session_id = $1",
      [session.id]
    );
    const tieOrder = events.map((event) => event.id).sort();
    const expectedIds = new Set<string>();
    for (const event of [events[2]!, events[3]!]) {
      const position = tieOrder.indexOf(event.id);
      for (const id of tieOrder.slice(
        Math.max(0, position - 1),
        position + 2
      )) {
        if (id !== events[1]!.id) expectedIds.add(id);
      }
    }
    const tied = await retrieveCanonicalEventContext(
      pool,
      {
        ...input,
        hits: [
          { nodeId: node.id, sourceType: "memory_node", sourceId: node.id }
        ]
      },
      hydrate
    );
    expect(
      tied.get(`memory_node:${node.id}`)?.map((item) => item.sourceId)
    ).toEqual(tieOrder.filter((id) => expectedIds.has(id)));
  });
});
