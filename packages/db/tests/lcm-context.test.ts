import { randomUUID } from "node:crypto";
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
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  type MemorySourceRepository
} from "../src/index.js";
import { invalidateDerivedMemoryForMemoryEvents } from "../src/derived-memory-invalidation.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("LCM immediate next-event context", () => {
  let pool: pg.Pool;
  let repo: MemorySourceRepository;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
    repo = createMemorySourceRepository(pool);
  }, 120_000);
  afterAll(async () => pool?.end());
  afterEach(() => vi.unstubAllEnvs());

  const fixture = async (count = 4, encrypted = false) => {
    vi.stubEnv("MEMORY_LCM_LEAF_EVENT_THRESHOLD", "2");
    vi.stubEnv("MEMORY_LCM_LEAF_TOKEN_THRESHOLD", "6000");
    vi.stubEnv("MEMORY_LCM_FRESH_EVENT_TAIL", "2");
    vi.stubEnv("MEMORY_LCM_DEPTH1_FANOUT", "2");
    const repository = encrypted
      ? createMemorySourceRepository(pool, {
          envelopeEncryptionProvider:
            createLocalTestKeyEnvelopeEncryptionProvider(
              Buffer.alloc(32, 61).toString("base64")
            )
        })
      : repo;
    if (encrypted) {
      vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "koed_managed_cloud");
      vi.stubEnv("KOED_MANAGED_CLOUD_RELEASE_STAGE", "paid");
    }
    const owner = await repository.createUser({
      email: `lcm-context-${randomUUID()}@example.com`
    });
    const actor = { userId: owner.id };
    const session = await repository.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      sourceRuntime: "codex",
      captureMethod: "transcript"
    });
    const eventIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const event = await repository.createMemoryEvent(actor, {
        visibility: "personal",
        projectId: "lcm-context-test",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_prompt",
        content: `Context fixture statement ${index}`,
        captureMethod: "api",
        idempotencyKey: randomUUID()
      });
      eventIds.push(event.id);
      await pool.query(
        `update memory_events set session_id=$2,captured_at=$3 where id=$1`,
        [event.id, session.id, new Date(Date.UTC(2026, 0, 1, 0, 0, index))]
      );
    }
    return { repository, actor, session, eventIds };
  };

  it("uses one fresh-tail event without covering or consuming the tail", async () => {
    const { repository, actor, session, eventIds } = await fixture();
    const result = await repository.createLcmNodes(actor, {
      visibility: "personal",
      sessionId: session.id
    });
    expect(result.leafNodeIds).toHaveLength(1);
    const node = await repository.getVisibleLcmNodeForSummarization(
      actor,
      result.leafNodeIds[0]!
    );
    expect(node?.sourceItems.map((item) => item.sourceId)).toEqual(
      eventIds.slice(0, 2)
    );
    expect(node?.contextItems?.map((item) => item.sourceId)).toEqual([
      eventIds[2]
    ]);
    const coverage = await pool.query<{ memory_event_id: string }>(
      `select memory_event_id from memory_node_sources where memory_node_id=$1 order by source_order`,
      [node!.id]
    );
    expect(coverage.rows.map((row) => row.memory_event_id)).toEqual(
      eventIds.slice(0, 2)
    );
    const other = await repository.createUser({
      email: `lcm-context-other-${randomUUID()}@example.com`
    });
    expect(
      await repository.getVisibleLcmNodeForSummarization(
        { userId: other.id },
        node!.id
      )
    ).toBeNull();
  });

  it.each(["excluded", "metadata_excluded", "deleted", "invalidated"])(
    "does not substitute a later event when the immediate neighbor is %s",
    async (state) => {
      const { repository, actor, session, eventIds } = await fixture(5);
      if (state === "excluded") {
        await pool.query(
          "update memory_events set include_in_lcm=false where id=$1",
          [eventIds[2]]
        );
      } else if (state === "metadata_excluded") {
        await pool.query(
          "update memory_events set payload=jsonb_set(payload,'{metadata}',coalesce(payload->'metadata','{}'::jsonb)||'{\"includeInLcm\":false}'::jsonb) where id=$1",
          [eventIds[2]]
        );
      } else if (state === "deleted") {
        await pool.query(
          "update memory_events set personal_deleted_at=now() where id=$1",
          [eventIds[2]]
        );
      } else {
        await pool.query(
          "update memory_events set invalidated_at=now() where id=$1",
          [eventIds[2]]
        );
      }
      const result = await repository.createLcmNodes(actor, {
        visibility: "personal",
        sessionId: session.id
      });
      const node = await repository.getVisibleLcmNodeForSummarization(
        actor,
        result.leafNodeIds[0]!
      );
      expect(node?.sourceItems.map((item) => item.sourceId)).toEqual(
        eventIds.slice(0, 2)
      );
      expect(node?.contextItems).toEqual([]);
    }
  );

  it("hydrates encrypted context without storing its content in the dependency", async () => {
    const { repository, actor, session } = await fixture(4, true);
    const result = await repository.createLcmNodes(actor, {
      visibility: "personal",
      sessionId: session.id
    });
    const node = await repository.getVisibleLcmNodeForSummarization(
      actor,
      result.leafNodeIds[0]!
    );
    expect(node?.contextItems?.[0]?.text).toBe("Context fixture statement 2");
    const stored = await pool.query(
      `select node.source_items_json,dependency.* from memory_nodes node join memory_node_context_events dependency on dependency.memory_node_id=node.id where node.id=$1`,
      [node!.id]
    );
    expect(JSON.stringify(stored.rows)).not.toContain(
      "Context fixture statement"
    );
  });

  it("rejects a summary claim when only context input changes", async () => {
    const { repository, actor, session, eventIds } = await fixture();
    await repository.createLcmNodes(actor, {
      visibility: "personal",
      sessionId: session.id
    });
    const [claim] = await repository.claimLcmNodesForSummarization(actor, {
      claimantId: "context-test",
      compatibilityContractHash: "a".repeat(64),
      leaseMs: 60_000,
      limit: 1
    });
    expect(claim).toBeDefined();
    await pool.query(
      `update memory_events set payload=jsonb_set(payload,'{content}','"Changed boundary continuation"') where id=$1`,
      [eventIds[2]]
    );
    await expect(
      repository.updateLcmNodeSummary({
        nodeId: claim!.node.id,
        summaryText: "Boundary summary",
        summaryModel: "codex:test",
        summaryPromptVersion: "lcm-context-test",
        summaryTokenEstimate: 5,
        summaryStructuredJson: {
          schema_version: "lcm-semantic-summary-v1",
          title: "Boundary",
          summary_text: "Boundary summary",
          lexical_anchors: []
        },
        summaryStructuredSchemaVersion: "lcm-semantic-summary-v1",
        claim: {
          ownerUserId: actor.userId,
          claimId: claim!.claimId,
          claimToken: claim!.claimToken,
          claimGeneration: claim!.claimGeneration,
          inputRevisionHash: claim!.inputRevisionHash,
          compatibilityContractHash: claim!.compatibilityContractHash
        }
      })
    ).rejects.toMatchObject({ name: "LcmSummaryInputStaleError" });
  });

  it("invalidates dependent leaves, rollups and embeddings on context deletion", async () => {
    const { repository, actor, session, eventIds } = await fixture(6);
    const result = await repository.createLcmNodes(actor, {
      visibility: "personal",
      sessionId: session.id
    });
    expect(result.leafNodeIds).toHaveLength(2);
    expect(result.rollupNodeId).toBeTruthy();
    const nodeIds = [...result.leafNodeIds, result.rollupNodeId!];
    for (const nodeId of nodeIds) {
      await pool.query(
        `insert into memory_embeddings (memory_node_id,owner_user_id,visibility,embedding_model,embedding_dimensions,embedding_version,source_text,source_hash,embedding_source_content_hash,embedding_input_hash) values ($1,$2,'personal','test',1024,'test','Boundary summary',$3,$3,$3)`,
        [nodeId, actor.userId, randomUUID()]
      );
    }
    await pool.query(
      "update memory_events set personal_deleted_at=now() where id=$1",
      [eventIds[4]]
    );
    await invalidateDerivedMemoryForMemoryEvents(pool, [eventIds[4]!]);
    const nodes = await pool.query<{ id: string; invalidated_at: Date | null }>(
      "select id,invalidated_at from memory_nodes where id=any($1::uuid[])",
      [nodeIds]
    );
    expect(
      nodes.rows.find((row) => row.id === result.leafNodeIds[0])?.invalidated_at
    ).toBeNull();
    expect(
      nodes.rows.find((row) => row.id === result.leafNodeIds[1])?.invalidated_at
    ).toBeInstanceOf(Date);
    expect(
      nodes.rows.find((row) => row.id === result.rollupNodeId)?.invalidated_at
    ).toBeInstanceOf(Date);
    const embeddings = await pool.query<{ count: number }>(
      "select count(*)::int as count from memory_embeddings where memory_node_id=any($1::uuid[]) and invalidated_at is not null",
      [nodeIds]
    );
    expect(embeddings.rows[0]?.count).toBe(2);
    expect(
      await repository.getVisibleLcmNodeForSummarization(
        actor,
        result.leafNodeIds[1]!
      )
    ).toBeNull();
  });
});
