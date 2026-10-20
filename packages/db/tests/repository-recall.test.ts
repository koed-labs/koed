import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createMemoryEngine } from "@koed/core";
import {
  personalMemoryNodeSelectionSql,
  personalCuratedMemorySelectionSql
} from "../src/personal-derived-selection-sql.js";
import {
  authorizedPersonalRawEvidence,
  resolvePersonalSourceSelection
} from "../src/personal-selection-sql.js";
import {
  createPdsRepositoryAssignment,
  repositoryScopeId,
  snapshotPinnedPersonalSelection,
  personalGitContextSchema,
  type RepositoryIdentity
} from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository,
  updateSessionRepositoryOverride
} from "../src/index.js";
const databaseUrl = process.env.DATABASE_URL;
const identity = (
  key: string
): Extract<RepositoryIdentity, { kind: "portable_repository" }> => ({
  kind: "portable_repository",
  key: `gr_${key}`,
  root: `/fixture/${key}`,
  branch: "main",
  reason: "origin",
  checkoutId: `checkout_${key}`,
  originatingDeviceId: "fixture_device",
  selectedRemote: "origin",
  anchorDisplay: `example.test/team/${key}`
});

type RecallRepository = ReturnType<typeof createMemorySourceRepository>;
const correctGit = async (
  repo: RecallRepository,
  actor: { userId: string },
  sessionId: string,
  input: Parameters<RecallRepository["moveCapturedSessionToProject"]>[2]
) => {
  const expectedVersion = input.expectedAssignmentVersion!;
  const review = await repo.previewPersonalSourceCorrection(actor, sessionId, {
    axis: "git",
    action: "set",
    repository: personalGitContextSchema.parse(input.repositoryIdentity),
    expectedVersion
  });
  await repo.applyPersonalSourceCorrection(
    actor,
    sessionId,
    review.preview.reviewId,
    { expectedVersion }
  );
  return repo.getCapturedSession(actor, sessionId);
};
const resetGit = async (
  repo: RecallRepository,
  actor: { userId: string },
  sessionId: string,
  expectedVersion: number
) => {
  const review = await repo.previewPersonalSourceCorrection(actor, sessionId, {
    axis: "git",
    action: "reset",
    expectedVersion
  });
  await repo.applyPersonalSourceCorrection(
    actor,
    sessionId,
    review.preview.reviewId,
    { expectedVersion }
  );
  return repo.getCapturedSession(actor, sessionId);
};

describe.skipIf(!databaseUrl)(
  "effective repository recall in PostgreSQL",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await pool?.end();
    });
    it("applies one owner selection before inventory limits and graph expansion", async () => {
      const repo = createMemorySourceRepository(pool);
      const actor = {
        userId: (
          await repo.createUser({
            email: `inventory-${randomUUID()}@example.test`
          })
        ).id
      };
      const foreign = {
        userId: (
          await repo.createUser({
            email: `inventory-foreign-${randomUUID()}@example.test`
          })
        ).id
      };
      const a = identity(`inventory_a_${randomUUID()}`),
        b = identity(`inventory_b_${randomUUID()}`);
      const threadId = randomUUID();
      const capture = async (
        owner: typeof actor,
        repositoryIdentity: RepositoryIdentity,
        thread = randomUUID()
      ) => {
        const session = await repo.createCapturedSession(owner, {
          externalSessionId: randomUUID(),
          repositoryIdentity,
          cwd: repositoryIdentity.root!,
          metadata: { threadName: "Inventory Conversation" }
        });
        await pool.query(
          "update sessions set external_session_id=$2 where id=$1",
          [session.id, thread]
        );
        const event = await repo.createMemoryEvent(owner, {
          projectId: "legacy-inventory",
          sessionId: session.id,
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: `inventory ${session.id}`,
          idempotencyKey: randomUUID()
        });
        const node = await repo.createMemoryNode(owner, {
          visibility: "personal",
          summaryText: `inventory summary ${session.id}`,
          sourceHash: randomUUID()
        });
        await pool.query(
          "update memory_nodes set source_event_count=1,lcm_algorithm_version='fixture-leaf' where id=$1",
          [node.id]
        );
        await pool.query(
          "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0)",
          [node.id, event.id]
        );
        return { session, event, node };
      };
      const first = await capture(actor, a, threadId);
      const second = await capture(actor, a, threadId);
      const denied = await capture(actor, b);
      const foreignSource = await capture(foreign, a);
      const personalSelection = snapshotPinnedPersonalSelection(actor.userId, {
        search_domain: "project",
        project_id: repositoryScopeId(a),
        repository_context: a
      });
      const selected = { personalSelection };
      const foreignSelection = {
        personalSelection: snapshotPinnedPersonalSelection(foreign.userId, {
          search_domain: "global",
          repository_context: null
        })
      };
      await expect(
        repo.listLcmGraphThreads(actor, foreignSelection)
      ).rejects.toThrow();
      await expect(
        repo.listLcmGraphNodes(actor, foreignSelection)
      ).rejects.toThrow();
      await expect(
        repo.getCapturedSession(actor, first.session.id, foreignSelection)
      ).rejects.toThrow();
      const expectedSessions = [first.session.id, second.session.id].sort();
      const threads = await repo.listLcmGraphThreads(actor, {
        ...selected,
        limit: 1
      });
      expect(threads).toHaveLength(1);
      expect(threads[0]!.threads).toHaveLength(1);
      expect(
        threads[0]!.threads[0]!.sourceReferences?.map(
          (ref) => ref.sessionId
        ).sort()
      ).toEqual(expectedSessions);
      expect(
        threads[0]!.threads[0]!.sourceReferences?.every(
          (ref) => ref.logicalSessionId
        )
      ).toBe(true);
      expect(
        await repo.listLcmGraphThreads(actor, {
          ...selected,
          offset: 1,
          limit: 1
        })
      ).toEqual([]);
      const events = await repo.listLcmGraphEvents(actor, {
        ...selected,
        canonicalCapturedSessionEventsOnly: true,
        limit: 1
      });
      expect(events).toHaveLength(1);
      expect(expectedSessions).toContain(events[0]!.sessionId);
      const nodes = await repo.listLcmGraphNodes(actor, {
        ...selected,
        limit: 1
      });
      expect(nodes).toHaveLength(1);
      expect([first.node.id, second.node.id]).toContain(nodes[0]!.id);
      expect(
        await repo.getLcmGraphNode(actor, denied.node.id, selected)
      ).toBeNull();
      expect(
        await repo.getLcmGraphNode(actor, foreignSource.node.id, selected)
      ).toBeNull();
      expect(
        await repo.getLcmGraphEvent(actor, denied.event.id, {
          ...selected,
          includeRaw: true
        })
      ).toBeNull();
      expect(
        await repo.getLcmGraphEvent(actor, foreignSource.event.id, {
          ...selected,
          includeRaw: true
        })
      ).toBeNull();
      expect(
        await repo.getCapturedSession(actor, denied.session.id, selected)
      ).toBeNull();
      expect(
        await repo.getCapturedSessionSummary(actor, denied.session.id, selected)
      ).toBeNull();
      expect(
        await repo.listCapturedSessionSummaries(actor, {
          ...selected,
          limit: 1
        })
      ).toHaveLength(1);
      expect(
        (await repo.listVisibleMemoryNodes(actor, undefined, selected))
          .map((node) => node.id)
          .sort()
      ).toEqual([first.node.id, second.node.id].sort());
      expect(
        await repo.getVisibleMemoryNode(actor, denied.node.id, selected)
      ).toBeNull();
      expect(
        await repo.listMemoryBrowserItems(actor, {
          ...selected,
          query: "inventory",
          limit: 1
        })
      ).toHaveLength(1);
      await pool.query(
        "update memory_nodes set source_items_json=$2 where id=$1",
        [
          first.node.id,
          JSON.stringify([
            {
              kind: "memory_event",
              sourceId: first.event.id,
              text: "STALE_RETAINED_SECRET",
              position: 0
            }
          ])
        ]
      );
      const detail = await repo.getLcmGraphNode(actor, first.node.id, selected);
      expect(JSON.stringify(detail?.sourceItems)).not.toContain(
        "STALE_RETAINED_SECRET"
      );
      expect(JSON.stringify(detail?.sourceItems)).toContain(
        `inventory ${first.session.id}`
      );
      const overview = await repo.getLcmGraphOverview(actor, selected);
      expect(overview).toMatchObject({ capturedEvents: 2, leafNodes: 2 });
      const raw = await authorizedPersonalRawEvidence(
        pool,
        resolvePersonalSourceSelection(actor.userId, selected),
        [first, second, denied, foreignSource].map((value) => ({
          source_type: "memory_event",
          source_id: value.event.id
        })),
        null,
        null
      );
      expect([...raw].sort()).toEqual(
        [first, second].map((value) => `memory_event:${value.event.id}`).sort()
      );
      const unknown = { projectId: `unknown-${randomUUID()}` };
      expect(await repo.listLcmGraphThreads(actor, unknown)).toEqual([]);
      expect(await repo.listLcmGraphNodes(actor, unknown)).toEqual([]);
      expect(
        await repo.getLcmGraphNode(actor, first.node.id, unknown)
      ).toBeNull();
      expect(
        await repo.getCapturedSession(actor, first.session.id, unknown)
      ).toBeNull();
      expect(await repo.getLcmGraphOverview(actor, unknown)).toMatchObject({
        capturedEvents: 0,
        leafNodes: 0,
        rollupNodes: 0
      });
      await pool.query(
        "update sessions set personal_deleted_at=now() where id=any($1::uuid[])",
        [expectedSessions]
      );
      expect(await repo.listLcmGraphThreads(actor, selected)).toEqual([]);
      expect(await repo.listLcmGraphNodes(actor, selected)).toEqual([]);
      expect(
        await repo.getCapturedSession(actor, first.session.id, selected)
      ).toBeNull();
      expect(
        await repo.getLcmGraphNode(actor, first.node.id, selected)
      ).toBeNull();
      // Owner history is explicit and still obeys the exact selected target.
      expect(
        await repo.getLcmGraphNode(actor, first.node.id, {
          ...selected,
          includeInvalidated: true
        })
      ).not.toBeNull();
      expect(
        await repo.getLcmGraphNode(actor, denied.node.id, {
          ...selected,
          includeInvalidated: true
        })
      ).toBeNull();
    });
    it("checks all recursive sources, keeps safe raw expansion, and rejects retained deleted text", async () => {
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `derived-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id };
      const a = identity(`derived_a_${randomUUID()}`),
        b = identity(`derived_b_${randomUUID()}`);
      const capture = async (
        repositoryIdentity: RepositoryIdentity,
        content: string
      ) => {
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          cwd: repositoryIdentity.root!,
          repositoryIdentity
        });
        const event = await repo.createMemoryEvent(actor, {
          sessionId: session.id,
          projectId: "legacy",
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content,
          idempotencyKey: randomUUID()
        });
        const node = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: `Summary ${content}`,
          sourceHash: randomUUID()
        });
        await pool.query(
          "update memory_nodes set source_event_count=1,lcm_algorithm_version='fixture-leaf' where id=$1",
          [node.id]
        );
        await pool.query(
          "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0)",
          [node.id, event.id]
        );
        return { session, event, node };
      };
      const first = await capture(a, "SAFE_ALPHA_EVIDENCE");
      const second = await capture(b, "SECRET_BRAVO_EVIDENCE");
      const root = await repo.createMemoryNode(actor, {
        visibility: "personal",
        summaryText: "MIXED_SUMMARY_SECRET_BRAVO_EVIDENCE",
        sourceHash: randomUUID()
      });
      await pool.query(
        "update memory_nodes set kind='rollup',source_event_count=2,source_items_json=$2 where id=$1",
        [
          root.id,
          JSON.stringify([
            {
              kind: "lcm_child",
              nodeId: second.node.id,
              text: "RETAINED_SECRET_BRAVO",
              position: 0
            }
          ])
        ]
      );
      await pool.query(
        "insert into memory_node_children(parent_memory_node_id,child_memory_node_id,child_order) values($1,$2,0),($1,$3,1)",
        [root.id, first.node.id, second.node.id]
      );
      const selected = snapshotPinnedPersonalSelection(actor.userId, {
        search_domain: "project",
        project_id: repositoryScopeId(a),
        repository_context: a
      });
      const selectedScope = resolvePersonalSourceSelection(actor.userId, {
        personalSelection: selected
      });
      const globalScope = resolvePersonalSourceSelection(actor.userId, {
        searchDomain: "global"
      });
      const permitted = async (
        id: string,
        selection: typeof selectedScope,
        after: string | null = null,
        before: string | null = null
      ) =>
        (
          await pool.query<{ allowed: boolean }>(
            `select ${personalMemoryNodeSelectionSql("n.id", "$2", "$3", "$4")} as allowed from memory_nodes n where n.id=$1`,
            [id, JSON.stringify(selection), after, before]
          )
        ).rows[0]!.allowed;
      expect(await permitted(first.node.id, selectedScope)).toBe(true);
      expect(await permitted(second.node.id, selectedScope)).toBe(false);
      expect(await permitted(root.id, selectedScope)).toBe(false);
      expect(await permitted(root.id, globalScope)).toBe(true);
      expect(
        await permitted(root.id, globalScope, "2040-01-01T00:00:00.000Z")
      ).toBe(false);
      const bounded = await pool.query<{ id: string }>(
        `select n.id from memory_nodes n where n.id=any($1::uuid[]) and ${personalMemoryNodeSelectionSql("n.id", "$2", "$3", "$4")} order by n.created_at desc limit 1`,
        [
          [first.node.id, second.node.id, root.id],
          JSON.stringify(selectedScope),
          null,
          null
        ]
      );
      expect(bounded.rows.map((row) => row.id)).toEqual([first.node.id]);
      const expanded = await repo.expandMemoryNode(root.id, actor, {
        searchDomain: "global",
        personalSelection: selected
      });
      expect(expanded.sources.map((source) => source.id)).toEqual([
        first.event.id
      ]);
      expect(JSON.stringify(expanded)).toContain("SAFE_ALPHA_EVIDENCE");
      expect(JSON.stringify(expanded)).not.toContain("BRAVO");
      expect(
        expanded.sourceItems.some((item) => item.nodeId === first.node.id)
      ).toBe(true);

      await pool.query(
        "update memory_events set include_in_embedding=false where id=$1",
        [first.event.id]
      );
      expect(await permitted(first.node.id, selectedScope)).toBe(true);
      await pool.query(
        "update memory_events set include_in_embedding=true,include_in_lcm=false where id=$1",
        [first.event.id]
      );
      expect(await permitted(first.node.id, selectedScope)).toBe(false);
      await pool.query(
        "update memory_events set include_in_lcm=true where id=$1",
        [first.event.id]
      );

      const safeRoot = await repo.createMemoryNode(actor, {
        visibility: "personal",
        summaryText: "ALPHA decision only",
        sourceHash: randomUUID()
      });
      await pool.query(
        "update memory_nodes set kind='rollup',source_event_count=1 where id=$1",
        [safeRoot.id]
      );
      await pool.query(
        "insert into memory_node_children(parent_memory_node_id,child_memory_node_id,child_order) values($1,$2,0)",
        [safeRoot.id, first.node.id]
      );
      for (const [nodeId, body] of [
        [root.id, "ALPHA decision SECRET_BRAVO_EVIDENCE"],
        [safeRoot.id, "ALPHA decision only"]
      ]) {
        await repo.updateLcmNodeSummary({
          nodeId: nodeId!,
          summaryText: body!,
          summaryModel: "fixture-client",
          summaryTokenEstimate: 8,
          summaryPromptVersion: "fixture",
          summaryStructuredJson: {
            schema_version: "lcm-semantic-summary-v1",
            title: "Alpha decision",
            summary_text: body!,
            lexical_anchors: []
          },
          summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
        });
        const source = await repo.getEmbeddableSource("memory_node", nodeId!);
        expect(source).not.toBeNull();
        const vector = Array.from({ length: 1024 }, (_, index) =>
          index === 0
            ? nodeId === root.id
              ? 1
              : 0.8
            : index === 1 && nodeId !== root.id
              ? 0.6
              : 0
        );
        await repo.upsertSourceEmbedding({
          source: source!,
          model: "qwen3-0.6b",
          dimensions: 1024,
          version: "qwen3-0.6b",
          vector,
          modelArtifactHash: "a".repeat(64),
          tokenizer: "qwen3-embedding-0.6b-gguf",
          inputTransform: "qwen3-retrieval-document-v1",
          pooling: "last",
          normalization: "l2"
        });
      }
      const searchSummaries = async (personalSelection?: typeof selected) => {
        const previousUrl = process.env.EMBEDDING_SERVICE_URL;
        const previousLimit = process.env.MEMORY_RAG_ROLLUP_CANDIDATE_LIMIT;
        vi.stubEnv("EMBEDDING_SERVICE_URL", "http://derived.fixture");
        vi.stubEnv("MEMORY_RAG_ROLLUP_CANDIDATE_LIMIT", "1");
        const mock = vi.spyOn(globalThis, "fetch").mockImplementation(
          async () =>
            new Response(
              JSON.stringify({
                model: "qwen3-0.6b",
                dimensions: 1024,
                vectors: [
                  Array.from({ length: 1024 }, (_, index) =>
                    index === 0 ? 1 : 0
                  )
                ]
              }),
              { status: 200 }
            )
        );
        try {
          return await createMemoryEngine(repo).searchMemory({
            requesterContext: actor,
            query: "ALPHA decision",
            scope: "personal",
            searchDomain: "global",
            personalSelection,
            retrievalStage: "rollup_search",
            limit: 1
          });
        } finally {
          mock.mockRestore();
          vi.stubEnv("EMBEDDING_SERVICE_URL", previousUrl);
          vi.stubEnv("MEMORY_RAG_ROLLUP_CANDIDATE_LIMIT", previousLimit);
        }
      };
      expect((await searchSummaries()).results[0]?.sourceId).toBe(root.id);
      const scopedSummaries = await searchSummaries(selected);
      expect(scopedSummaries.results.map((row) => row.sourceId)).toEqual([
        safeRoot.id
      ]);
      expect(JSON.stringify(scopedSummaries)).not.toContain("BRAVO");

      const proposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "Mixed Alpha Bravo claim",
        evidenceMemoryEventIds: [first.event.id, second.event.id]
      });
      const curated = await repo.processCuratedMemoryProposal(actor, {
        proposalId: proposal.id,
        decision: "store",
        assertion: {
          assertionText: "MIXED_CURATED_SECRET_BRAVO",
          sources: [
            {
              sourceType: "memory_event",
              sourceRole: "primary_evidence",
              memoryEventId: first.event.id
            },
            {
              sourceType: "memory_event",
              sourceRole: "supporting_evidence",
              memoryEventId: second.event.id
            }
          ]
        }
      });
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "MIXED_CURATED",
            personalSelection: selected
          })
        ).map((row) => row.id)
      ).not.toContain(curated.assertionId);
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "MIXED_CURATED",
            searchDomain: "global"
          })
        ).map((row) => row.id)
      ).toContain(curated.assertionId);
      expect(
        (
          await repo.expandMemoryNode(curated.assertionId!, actor, {
            personalSelection: selected
          })
        )?.sources.map((source) => source.id)
      ).toEqual([first.event.id]);
      const assertionAllowed = async () =>
        (
          await pool.query<{ allowed: boolean }>(
            `select ${personalCuratedMemorySelectionSql("cma", "$2", "$3", "$4")} as allowed from curated_memory_assertions cma where cma.id=$1`,
            [curated.assertionId, JSON.stringify(globalScope), null, null]
          )
        ).rows[0]!.allowed;
      expect(await assertionAllowed()).toBe(true);
      const pureProposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "PURE_ALPHA_CLAIM",
        evidenceMemoryEventIds: [first.event.id]
      });
      const pure = await repo.processCuratedMemoryProposal(actor, {
        proposalId: pureProposal.id,
        decision: "store",
        assertion: {
          assertionText: "PURE_ALPHA_CLAIM",
          sources: [
            {
              sourceType: "memory_event",
              sourceRole: "primary_evidence",
              memoryEventId: first.event.id
            }
          ]
        }
      });
      const auxiliary = await repo.createMemoryNode(actor, {
        visibility: "personal",
        summaryText: "AUXILIARY_SECRET_BRAVO",
        sourceHash: randomUUID()
      });
      await pool.query(
        "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0),($1,$3,1)",
        [auxiliary.id, first.event.id, second.event.id]
      );
      await repo.reconcileCuratedMemorySources(actor);
      expect(
        (
          await pool.query(
            "select id from curated_memory_sources where assertion_id=$1 and lcm_node_id=$2 and source_role='derived_summary'",
            [pure.assertionId, auxiliary.id]
          )
        ).rowCount
      ).toBe(1);
      const pureSelected = await repo.searchCuratedMemoryAssertions(actor, {
        query: "PURE_ALPHA_CLAIM",
        personalSelection: selected
      });
      expect(pureSelected.map((row) => row.id)).toContain(pure.assertionId);
      expect(
        pureSelected
          .find((row) => row.id === pure.assertionId)
          ?.sources.some((source) => source.lcmNodeId === auxiliary.id)
      ).toBe(false);
      // Keep the parent and its snapshots deliberately intact to test source checks independently of cleanup.
      await pool.query(
        "update memory_events set personal_deleted_at=now() where id=$1",
        [second.event.id]
      );
      expect(await permitted(root.id, globalScope)).toBe(false);
      expect(
        (await searchSummaries()).results.map((row) => row.sourceId)
      ).toEqual([safeRoot.id]);
      expect(await assertionAllowed()).toBe(false);
      const pureAfterDeletion = await repo.searchCuratedMemoryAssertions(
        actor,
        { query: "PURE_ALPHA_CLAIM" }
      );
      expect(pureAfterDeletion.map((row) => row.id)).toContain(
        pure.assertionId
      );
      expect(
        pureAfterDeletion
          .find((row) => row.id === pure.assertionId)
          ?.sources.some((source) => source.lcmNodeId === auxiliary.id)
      ).toBe(false);
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "MIXED_CURATED"
          })
        ).map((row) => row.id)
      ).not.toContain(curated.assertionId);
      const retained = await repo.expandMemoryNode(root.id, actor);
      expect(retained.sources.map((source) => source.id)).toEqual([
        first.event.id
      ]);
      expect(JSON.stringify(retained)).not.toContain("BRAVO");
      await pool.query(
        "delete from memory_node_children where parent_memory_node_id=$1 and child_memory_node_id=$2",
        [root.id, second.node.id]
      );
      expect(await permitted(root.id, globalScope)).toBe(false);
      expect(
        (await searchSummaries()).results.map((row) => row.sourceId)
      ).toEqual([safeRoot.id]);
      const outsider = await repo.createUser({
        email: `derived-outsider-${randomUUID()}@example.test`
      });
      await expect(
        repo.expandMemoryNode(
          root.id,
          { userId: outsider.id },
          { personalSelection: selected }
        )
      ).rejects.toThrow("another owner");
      await pool.query(
        "insert into memory_node_children(parent_memory_node_id,child_memory_node_id,child_order) values($1,$2,0)",
        [first.node.id, root.id]
      );
      expect(await permitted(root.id, globalScope)).toBe(false);
      expect(
        JSON.stringify(await repo.expandMemoryNode(root.id, actor))
      ).not.toContain("BRAVO");
    });
    it("expands current message records and never revives retained message snapshots", async () => {
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `message-expansion-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id };
      const context = identity(`message_${randomUUID()}`);
      const session = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        cwd: context.root!,
        repositoryIdentity: context
      });
      const message = (
        await pool.query<{ id: string }>(
          "insert into messages(session_id,owner_user_id,visibility,role,content,source_runtime,capture_method) values($1,$2,'personal','user','CURRENT_MESSAGE_BODY','codex','transcript') returning id",
          [session.id, owner.id]
        )
      ).rows[0]!;
      const node = await repo.createMemoryNode(actor, {
        visibility: "personal",
        summaryText: "Message summary",
        sourceHash: randomUUID()
      });
      await pool.query(
        "update memory_nodes set source_event_count=1,lcm_algorithm_version='fixture-leaf',source_items_json=$2 where id=$1",
        [
          node.id,
          JSON.stringify([
            {
              kind: "message",
              sourceId: message.id,
              text: "STALE_MESSAGE_SNAPSHOT",
              payload: { sessionId: session.id },
              position: 0
            }
          ])
        ]
      );
      await pool.query(
        "insert into memory_node_sources(memory_node_id,message_id,source_order) values($1,$2,0)",
        [node.id, message.id]
      );
      const selection = snapshotPinnedPersonalSelection(actor.userId, {
        search_domain: "project",
        project_id: repositoryScopeId(context),
        repository_context: context
      });
      const expanded = await repo.expandMemoryNode(node.id, actor, {
        personalSelection: selection
      });
      expect(expanded.sourceItems).toContainEqual(
        expect.objectContaining({
          kind: "message",
          sourceId: message.id,
          text: "CURRENT_MESSAGE_BODY"
        })
      );
      expect(JSON.stringify(expanded)).not.toContain("STALE_MESSAGE_SNAPSHOT");
      await pool.query(
        "update messages set recall_eligible=false where id=$1",
        [message.id]
      );
      expect(
        (
          await repo.expandMemoryNode(node.id, actor, {
            personalSelection: selection
          })
        ).sourceItems
      ).toEqual([]);
    });
    it("enforces equality, device provenance and unresolved overrides in the shared SQL boundary", async () => {
      const a = identity("a");
      const local = {
        ...a,
        kind: "device_local_repository" as const,
        key: "dl_fixture"
      };
      const matches = async (
        value: RepositoryIdentity | null,
        target: RepositoryIdentity
      ) =>
        (
          await pool.query<{ matches: boolean }>(
            "select repository_scope_matches($1, $2) as matches",
            [value, repositoryScopeId(target)]
          )
        ).rows[0]?.matches;
      expect(
        await matches(a, {
          ...a,
          root: "/clone",
          originatingDeviceId: "another_device"
        })
      ).toBe(true);
      expect(await matches(a, identity("b"))).toBe(false);
      expect(
        await matches(local, {
          ...local,
          originatingDeviceId: "another_device"
        })
      ).toBe(false);
      expect(await matches(null, a)).toBe(false);
      expect(await matches({ ...a, kind: "unresolved", key: null }, a)).toBe(
        false
      );
    });

    it("rejects retired bulk replacement beyond the Desktop page limit without changing source facts", async () => {
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `named-project-${randomUUID()}@example.test`
      });
      const other = await repo.createUser({
        email: `named-project-other-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id };
      const source: RepositoryIdentity = {
        ...identity(randomUUID()),
        kind: "non_git_project",
        reason: "non_git"
      };
      const named: RepositoryIdentity = {
        kind: "local_project",
        key: `project_${randomUUID()}`,
        originatingDeviceId: "fixture_device",
        root: null,
        branch: null,
        checkoutId: null,
        selectedRemote: null,
        anchorDisplay: null,
        reason: "manual"
      };
      const captured = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        cwd: source.root!,
        repositoryIdentity: source
      });
      const event = await repo.createMemoryEvent(actor, {
        sessionId: captured.id,
        actor: "user",
        visibility: "personal",
        eventType: "captured",
        content: "Cobalt named Project checklist",
        projectId: repositoryScopeId(source),
        rawEventType: "user_message",
        idempotencyKey: randomUUID()
      });
      const inserted = await pool.query<{ id: string }>(
        `insert into sessions (owner_user_id, source_runtime, capture_method, repository_automatic_identity, repository_assignment_state) select $1, 'codex', 'transcript', $2::jsonb, 'recorded' from generate_series(1,505) returning id`,
        [owner.id, source]
      );
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        inserted.rows[0]!.id
      ]);
      await pool.query(
        "update sessions set personal_deleted_at=now() where id=$1",
        [inserted.rows[1]!.id]
      );
      await updateSessionRepositoryOverride(pool, {
        ownerUserId: owner.id,
        sessionId: inserted.rows[2]!.id,
        expectedVersion: 1,
        identity: identity("already-moved")
      });
      const otherSession = await repo.createCapturedSession(
        { userId: other.id },
        { repositoryIdentity: source }
      );
      const project = {
        id: repositoryScopeId(named),
        name: "Planning",
        path: null,
        repositoryIdentity: named
      };
      const facts = () =>
        pool.query(
          "select id,repository_automatic_identity,repository_override_identity,repository_assignment_version from sessions where owner_user_id=$1 order by id",
          [owner.id]
        );
      const before = (await facts()).rows;
      await expect(
        repo.moveProjectConversations(actor, {
          sourceProjectId: repositoryScopeId(source),
          project
        })
      ).rejects.toMatchObject({
        statusCode: 410,
        code: "personal_legacy_write_retired"
      });
      expect((await facts()).rows).toEqual(before);
      expect(
        (await repo.getCapturedSession({ userId: other.id }, otherSession.id))
          ?.repositoryAssignment?.effective
      ).toEqual(source);
      expect(
        (await repo.getCapturedSession(actor, captured.id))
          ?.repositoryAssignment
      ).toMatchObject({ automatic: source, effective: source, version: 1 });
      expect(
        await repo.getLatestCapturedSessionForProject(actor, {
          projectId: project.id
        })
      ).toBeNull();
      expect(
        (
          await pool.query("select id from memory_events where id=$1", [
            event.id
          ])
        ).rowCount
      ).toBe(1);
      await expect(
        repo.resetCapturedSessionProject(actor, captured.id, 1)
      ).rejects.toMatchObject({ statusCode: 410 });
      const later = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: source
      });
      expect(later.repositoryAssignment).toMatchObject({
        automatic: source,
        effective: source,
        version: 1
      });
      const localScope = repositoryScopeId(named);
      expect(
        (
          await pool.query<{ matches: boolean }>(
            "select repository_scope_matches($1,$2) as matches",
            [{ ...named, originatingDeviceId: "other_device" }, localScope]
          )
        ).rows[0]?.matches
      ).toBe(false);
    }, 30_000);

    it("rejects a retired bulk move while concurrent captures keep their actual source", async () => {
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `project-routing-race-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id },
        source = identity(randomUUID()),
        target = identity(randomUUID());
      await repo.createCapturedSession(actor, { repositoryIdentity: source });
      const captures = Array.from({ length: 12 }, () =>
        repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity: source
        })
      );
      const move = repo.moveProjectConversations(actor, {
        sourceProjectId: repositoryScopeId(source),
        project: {
          id: repositoryScopeId(target),
          name: "Destination",
          path: target.root,
          repositoryIdentity: target
        }
      });
      const [completed] = await Promise.all([
        Promise.all(captures),
        expect(move).rejects.toMatchObject({
          statusCode: 410,
          code: "personal_legacy_write_retired"
        })
      ]);
      for (const session of completed)
        expect(
          (await repo.getCapturedSession(actor, session.id))
            ?.repositoryAssignment
        ).toMatchObject({ automatic: source, effective: source });
    });

    it("does not redirect recall or assign unresolved history through retired routing", async () => {
      const repo = createMemorySourceRepository(pool);
      const actor = {
        userId: (
          await repo.createUser({
            email: `retired-routing-${randomUUID()}@example.test`
          })
        ).id
      };
      const source = identity(randomUUID()),
        target = identity(randomUUID());
      const captured = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: source
      });
      await expect(
        repo.moveProjectConversations(actor, {
          sourceProjectId: repositoryScopeId(source),
          project: {
            id: repositoryScopeId(target),
            name: "Retired target",
            path: target.root,
            repositoryIdentity: target
          }
        })
      ).rejects.toMatchObject({ statusCode: 410 });
      expect(
        await repo.resolveProjectRouting(actor, repositoryScopeId(source))
      ).toBeNull();
      const continued = await repo.createCapturedSession(actor, {
        externalSessionId: captured.externalSessionId!,
        repositoryIdentity: target
      });
      expect(continued.repositoryAssignment?.effective).toEqual(source);
      const old = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        importObservedAt: new Date().toISOString()
      });
      const historical = await repo.createCapturedSession(actor, {
        externalSessionId: old.externalSessionId!,
        repositoryIdentity: source
      });
      expect(historical.repositoryAssignment?.effective).toBeNull();
      await expect(
        repo.moveProjectConversations(actor, {
          sourceProjectId: "unassigned",
          project: {
            id: repositoryScopeId(target),
            name: "Retired target",
            path: target.root,
            repositoryIdentity: target
          }
        })
      ).rejects.toMatchObject({ statusCode: 410 });
      expect(await repo.resolveProjectRouting(actor, "unassigned")).toBeNull();
    });

    it("rejects retired replacement even when a source has exhausted its assignment version", async () => {
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `atomic-project-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id },
        source = identity(randomUUID()),
        target = identity(randomUUID());
      const first = await repo.createCapturedSession(actor, {
        repositoryIdentity: source
      });
      const second = await repo.createCapturedSession(actor, {
        repositoryIdentity: source
      });
      await pool.query(
        "update sessions set repository_assignment_version=2147483647 where id=$1",
        [second.id]
      );
      await expect(
        repo.moveProjectConversations(actor, {
          sourceProjectId: repositoryScopeId(source),
          project: {
            id: repositoryScopeId(target),
            name: "Destination",
            path: target.root,
            repositoryIdentity: target
          }
        })
      ).rejects.toThrow();
      expect(
        (await repo.getCapturedSession(actor, first.id))?.repositoryAssignment
      ).toMatchObject({ effective: source, version: 1 });
      expect(
        (await repo.getCapturedSession(actor, second.id))?.repositoryAssignment
          ?.effective
      ).toEqual(source);
      expect(
        await repo.resolveProjectRouting(actor, repositoryScopeId(source))
      ).toBeNull();
    });

    it("filters raw search, nodes, graph, curated search and expansion using current assignments", async () => {
      const repo = createMemorySourceRepository(pool);
      const user = await repo.createUser({
        email: `repository-recall-${randomUUID()}@example.test`
      });
      const actor = { userId: user.id };
      const a = identity("a"),
        b = identity("b");
      const scope = repositoryScopeId(a);
      const capture = async (repositoryIdentity: RepositoryIdentity) => {
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          cwd: `${repositoryIdentity.root}/subdirectory`,
          repositoryIdentity
        });
        const event = await repo.createMemoryEvent(actor, {
          sessionId: session.id,
          projectId: "legacy-wrong-value",
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: "The distinctive cobalt release uses a copper checklist.",
          idempotencyKey: randomUUID()
        });
        const node = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: "Cobalt release copper checklist",
          sourceHash: randomUUID()
        });
        await pool.query("update memory_nodes set kind='leaf' where id=$1", [
          node.id
        ]);
        await pool.query(
          "insert into memory_node_sources(memory_node_id, memory_event_id, source_order) values($1,$2,0)",
          [node.id, event.id]
        );
        return { session, event, node };
      };
      const first = await capture(a);
      const clone = await capture({
        ...a,
        root: "/another-checkout",
        checkoutId: "checkout_clone"
      });
      const other = await capture(b);
      expect([first.session.id, clone.session.id]).toContain(
        (
          await repo.getLatestCapturedSessionForProject(actor, {
            projectId: scope
          })
        )?.id
      );
      const nodes = await repo.listLcmGraphNodes(actor, { projectId: scope });
      expect(new Set(nodes.map((node) => node.id))).toEqual(
        new Set([first.node.id, clone.node.id])
      );
      expect(
        (await repo.listMemoryBrowserItems(actor, { projectId: scope })).map(
          (node) => node.id
        )
      ).not.toContain(other.node.id);
      expect(
        (await repo.listMemoryBrowserItems(actor, { projectId: scope })).find(
          (node) => node.id === first.node.id
        )
      ).toMatchObject({ projectId: scope, projectPath: a.root });
      expect(
        (
          await repo.expandMemoryNode(first.node.id, actor, {
            searchDomain: "project",
            projectId: scope
          })
        ).sources.map((event) => event.id)
      ).toEqual([first.event.id]);
      expect(
        (
          await repo.expandMemoryNode(other.node.id, actor, {
            searchDomain: "project",
            projectId: scope
          })
        ).sources
      ).toEqual([]);
      const grouped = await repo.listLcmGraphThreads(actor, {
        projectId: scope
      });
      expect(grouped).toHaveLength(1);
      expect(grouped[0]?.id).toBe(scope);
      expect(
        new Set(grouped[0]?.threads.map((thread) => thread.sessionId))
      ).toEqual(new Set([first.session.id, clone.session.id]));
      expect(grouped[0]?.threads[0]?.repositoryAssignment?.version).toBe(1);
      const proposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "Cobalt release copper checklist",
        evidenceMemoryEventIds: [first.event.id, other.event.id]
      });
      const curated = await repo.processCuratedMemoryProposal(actor, {
        proposalId: proposal.id,
        decision: "store",
        assertion: {
          assertionText: "Cobalt release copper checklist",
          sources: [
            {
              sourceType: "memory_event",
              sourceRole: "primary_evidence",
              memoryEventId: first.event.id
            },
            {
              sourceType: "memory_event",
              sourceRole: "supporting_evidence",
              memoryEventId: other.event.id
            }
          ]
        }
      });
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "cobalt",
            searchDomain: "project",
            projectId: scope
          })
        ).map((entry) => entry.id)
      ).not.toContain(curated.assertionId);
      const expanded = await repo.expandMemoryNode(
        curated.assertionId!,
        actor,
        { searchDomain: "project", projectId: scope }
      );
      expect(expanded.sources.map((source) => source.id)).toEqual([
        first.event.id
      ]);
      const vector = Array.from({ length: 1024 }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://embedding.fixture");
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen3-0.6b",
              dimensions: 1024,
              vectors: [vector]
            }),
            { status: 200 }
          )
      );
      const sources = await repo.listSourcesNeedingEmbeddings(10000);
      const ids = new Set([first.event.id, clone.event.id, other.event.id]);
      for (const source of sources.filter((source) => ids.has(source.sourceId)))
        await repo.upsertSourceEmbedding({
          source,
          model: "qwen3-0.6b",
          dimensions: 1024,
          version: "qwen3-0.6b",
          vector,
          modelArtifactHash: "a".repeat(64),
          tokenizer: "qwen3-embedding-0.6b-gguf",
          inputTransform: "qwen3-retrieval-document-v1",
          pooling: "last",
          normalization: "l2"
        });
      expect(sources.filter((source) => ids.has(source.sourceId)).length).toBe(
        3
      );
      const search = await createMemoryEngine(repo).searchMemory({
        requesterContext: actor,
        query: "cobalt copper",
        scope: "personal",
        searchDomain: "project",
        projectId: scope,
        retrievalStage: "raw_fallback_search",
        limit: 10
      });
      expect(
        search.results.some(
          (entry) =>
            entry.sourceId === first.event.id ||
            entry.sourceId === clone.event.id
        ),
        JSON.stringify(search.metadata)
      ).toBe(true);
      expect(JSON.stringify(search)).not.toContain(other.event.id);
      const pinnedSelection = snapshotPinnedPersonalSelection(actor.userId, {
        search_domain: "project",
        project_id: scope,
        repository_context: a
      });
      const broadened = await createMemoryEngine(repo).searchMemory({
        requesterContext: actor,
        query: "cobalt copper",
        scope: "personal",
        searchDomain: "global",
        personalSelection: pinnedSelection,
        retrievalStage: "raw_fallback_search",
        limit: 10
      });
      expect(
        broadened.results.some(
          (entry) =>
            entry.sourceId === first.event.id ||
            entry.sourceId === clone.event.id
        )
      ).toBe(true);
      expect(JSON.stringify(broadened)).not.toContain(other.event.id);
      const previousRawLimit =
        process.env.MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT;
      vi.stubEnv("MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT", "1");
      try {
        const bounded = await createMemoryEngine(repo).searchMemory({
          requesterContext: actor,
          query: "cobalt copper",
          scope: "personal",
          searchDomain: "global",
          personalSelection: pinnedSelection,
          retrievalStage: "raw_fallback_search",
          limit: 1
        });
        expect(bounded.results).toHaveLength(1);
        expect([first.event.id, clone.event.id]).toContain(
          bounded.results[0]?.sourceId
        );
      } finally {
        vi.stubEnv("MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT", previousRawLimit);
      }
      await expect(
        createMemoryEngine(repo).searchMemory({
          requesterContext: { userId: randomUUID() },
          query: "cobalt copper",
          scope: "personal",
          searchDomain: "global",
          personalSelection: pinnedSelection,
          retrievalStage: "raw_fallback_search",
          limit: 10
        })
      ).rejects.toThrow("another owner");
      const moved = await correctGit(repo, actor, first.session.id, {
        id: repositoryScopeId(b),
        name: "Project B",
        path: b.root,
        repositoryIdentity: b,
        expectedAssignmentVersion: 1
      });
      expect(moved?.repositoryAssignment?.effective).toEqual(b);
      const authorizedAfterMove = await authorizedPersonalRawEvidence(
        pool,
        resolvePersonalSourceSelection(actor.userId, {
          personalSelection: pinnedSelection
        }),
        [first.event, clone.event].map((event) => ({
          source_type: "memory_event",
          source_id: event.id
        })),
        null,
        null
      );
      expect(authorizedAfterMove.has(`memory_event:${first.event.id}`)).toBe(
        false
      );
      expect(authorizedAfterMove.has(`memory_event:${clone.event.id}`)).toBe(
        true
      );
      await expect(
        correctGit(repo, actor, first.session.id, {
          id: scope,
          name: "Stale move",
          path: a.root,
          repositoryIdentity: a,
          expectedAssignmentVersion: 1
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await repo.listLcmGraphNodes(actor, { projectId: scope })).map(
          (node) => node.id
        )
      ).not.toContain(first.node.id);
      expect(
        (
          await repo.expandMemoryNode(first.node.id, actor, {
            searchDomain: "project",
            projectId: scope
          })
        ).sources
      ).toEqual([]);
      const reset = await resetGit(repo, actor, first.session.id, 2);
      expect(reset?.repositoryAssignment?.effective).toEqual(a);
      expect(
        (
          await repo.listLcmGraphThreads(actor, { projectId: scope })
        )[0]?.threads.map((thread) => thread.sessionId)
      ).toContain(first.session.id);
      const outsider = await repo.createUser({
        email: `scope-outsider-${randomUUID()}@example.test`
      });
      await expect(
        correctGit(repo, { userId: outsider.id }, first.session.id, {
          id: repositoryScopeId(b),
          name: "Unauthorized",
          path: b.root,
          repositoryIdentity: b,
          expectedAssignmentVersion: 3
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      await correctGit(repo, actor, first.session.id, {
        id: repositoryScopeId(b),
        name: "Project B",
        path: b.root,
        repositoryIdentity: b,
        expectedAssignmentVersion: 3
      });
      await updateSessionRepositoryOverride(pool, {
        ownerUserId: actor.userId,
        sessionId: clone.session.id,
        expectedVersion: 1,
        identity: {
          ...a,
          kind: "unresolved",
          key: null,
          reason: "selection_missing"
        }
      });
      expect(await repo.listLcmGraphNodes(actor, { projectId: scope })).toEqual(
        []
      );
      const unknown = (await repo.listMemoryBrowserItems(actor)).find(
        (node) => node.id === clone.node.id
      );
      expect(unknown).toMatchObject({
        projectId: "unassigned",
        projectName: "Unresolved history",
        projectPath: null
      });
      for (const domain of ["global", "session"] as const) {
        const unresolvedRecall = await createMemoryEngine(repo).searchMemory({
          requesterContext: actor,
          query: "cobalt copper",
          scope: "personal",
          searchDomain: domain,
          ...(domain === "session" ? { sessionId: clone.session.id } : {}),
          retrievalStage: "raw_fallback_search",
          limit: 10
        });
        expect(JSON.stringify(unresolvedRecall), domain).toContain(
          clone.event.id
        );
        if (domain === "session")
          expect(
            unresolvedRecall.results.map((entry) => entry.sourceId)
          ).not.toContain(other.event.id);
      }
    });
    it("bounds Global pools, recovers current evidence, and keeps stronger foreign and unknown evidence honest", async () => {
      const repo = createMemorySourceRepository(pool);
      const user = await repo.createUser({
        email: `global-recall-${randomUUID()}@example.test`
      });
      const actor = { userId: user.id };
      const a = identity("global_a"),
        b = identity("global_b");
      const queryVector: number[] = Array.from({ length: 1024 }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://embedding.fixture");
      vi.stubEnv("MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT", "4");
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen3-0.6b",
              dimensions: 1024,
              vectors: [queryVector]
            }),
            { status: 200 }
          )
      );
      const capture = async (
        context: RepositoryIdentity | null,
        score: number,
        owner = actor
      ) => {
        const session = await repo.createCapturedSession(owner, {
          externalSessionId: randomUUID(),
          cwd: a.root!,
          ...(context ? { repositoryIdentity: context } : {})
        });
        const event = await repo.createMemoryEvent(owner, {
          sessionId: session.id,
          projectId: repositoryScopeId(a)!,
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: "Release checklist decision and rationale.",
          idempotencyKey: randomUUID()
        });
        const sources = await repo.listSourcesNeedingEmbeddings(10000);
        const source = sources.find((source) => source.sourceId === event.id)!;
        const vector = [...queryVector];
        vector[0] = score;
        vector[1] = Math.sqrt(1 - score * score);
        await repo.upsertSourceEmbedding({
          source,
          model: "qwen3-0.6b",
          dimensions: 1024,
          version: "qwen3-0.6b",
          vector,
          modelArtifactHash: "a".repeat(64),
          tokenizer: "qwen3-embedding-0.6b-gguf",
          inputTransform: "qwen3-retrieval-document-v1",
          pooling: "last",
          normalization: "l2"
        });
        return { session, event };
      };
      const foreign = await Promise.all(
        Array.from({ length: 5 }, () => capture(b, 0.61))
      );
      const current = await capture(a, 0.6);
      const search = async (
        context: RepositoryIdentity | null,
        maxSearchPasses?: 1 | 2,
        limit = 1
      ) =>
        createMemoryEngine(repo).searchMemory({
          requesterContext: actor,
          query: "release checklist rationale",
          scope: "personal",
          searchDomain: "global",
          repositoryContext: context,
          maxSearchPasses,
          retrievalStage: "raw_fallback_search",
          limit
        });
      expect((await search(null)).results[0]?.sourceId).not.toBe(
        current.event.id
      );
      fetchMock.mockClear();
      const recovered = await search(a);
      expect(recovered.results[0]?.sourceId, JSON.stringify(recovered)).toBe(
        current.event.id
      );
      expect(recovered.results[0]?.provenance).toMatchObject({
        project: { classification: "current", branch: "main" },
        repositoryPreference: { repository: 0.04, branch: 0.01 }
      });
      expect(recovered.metadata).toMatchObject({
        searchPasses: 2,
        globalCandidateCount: 3,
        currentRepositoryCandidateCount: 1
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await search(a, 1)).results[0]?.sourceId).not.toBe(
        current.event.id
      );
      const stronger = await capture(b, 0.9);
      const strongest = await search(a, undefined, 4);
      expect(strongest.results[0]?.sourceId).toBe(stronger.event.id);
      expect(strongest.results[0]?.provenance).toMatchObject({
        project: { classification: "other", label: b.anchorDisplay },
        repositoryPreference: { repository: 0, branch: 0 }
      });
      expect(
        strongest.results.filter((row) => row.sourceId === current.event.id)
      ).toHaveLength(1);
      const unknown = await capture(null, 0.88);
      const withUnknown = await search(a, undefined, 4);
      expect(
        withUnknown.results.find((row) => row.sourceId === unknown.event.id)
          ?.provenance
      ).toMatchObject({
        project: { classification: "unknown" },
        repositoryPreference: { repository: 0, branch: 0 }
      });
      const outsider = await repo.createUser({
        email: `global-outsider-${randomUUID()}@example.test`
      });
      const denied = await capture(a, 1, { userId: outsider.id });
      expect(JSON.stringify(await search(a, undefined, 4))).not.toContain(
        denied.event.id
      );
      const equallyRelevantForeign = await capture(b, 0.95);
      const overlap = await capture(a, 0.95);
      const overlapped = await search(a, undefined, 4);
      const preferred = overlapped.results.find(
        (row) => row.sourceId === overlap.event.id
      )!;
      expect(preferred.provenance).toMatchObject({
        repositoryPreference: { repository: 0.04, branch: 0.01 }
      });
      expect(overlapped.results[0]?.sourceId).toBe(overlap.event.id);
      expect(
        overlapped.results.some(
          (row) => row.sourceId === equallyRelevantForeign.event.id
        )
      ).toBe(true);
      expect(preferred.observedReferences).toHaveLength(2);
      expect(
        overlapped.results.filter((row) => row.sourceId === overlap.event.id)
      ).toHaveLength(1);
      expect(overlapped.metadata.hydrationCount).toBeLessThanOrEqual(3);
      await correctGit(repo, actor, overlap.session.id, {
        id: repositoryScopeId(b)!,
        name: "Moved Project",
        path: b.root,
        repositoryIdentity: b,
        expectedAssignmentVersion: 1
      });
      const reassigned = (await search(a, undefined, 4)).results.find(
        (row) => row.sourceId === overlap.event.id
      )!;
      expect(reassigned.provenance?.sourceAssignments).toContainEqual({
        sessionId: overlap.session.id,
        assignmentSource: "manual_override",
        capturedProjectLabel: a.anchorDisplay,
        effectiveProjectLabel: b.anchorDisplay
      });
      expect(reassigned.provenance?.project).toMatchObject({
        classification: "other",
        label: b.anchorDisplay,
        branch: null
      });
      await resetGit(repo, actor, overlap.session.id, 2);
      const outOfWindow = await createMemoryEngine(repo).searchMemory({
        requesterContext: actor,
        query: "release checklist rationale",
        scope: "personal",
        searchDomain: "global",
        repositoryContext: a,
        retrievalStage: "raw_fallback_search",
        sourceAfter: "2040-01-01T00:00:00.000Z",
        limit: 4
      });
      expect(outOfWindow.results).toEqual([]);
      expect(outOfWindow.metadata).toMatchObject({
        globalCandidateCount: 0,
        currentRepositoryCandidateCount: 0
      });
      const mixed = await repo.createMemoryNode(actor, {
        visibility: "personal",
        summaryText: "Release checklist decision across Projects",
        sourceHash: randomUUID()
      });
      await pool.query(
        "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0),($1,$3,1)",
        [mixed.id, current.event.id, foreign[0]!.event.id]
      );
      await pool.query("update memory_nodes set kind='rollup' where id=$1", [
        mixed.id
      ]);
      const mixedSource = (await repo.listSourcesNeedingEmbeddings(10000)).find(
        (source) => source.sourceId === mixed.id
      )!;
      await repo.upsertSourceEmbedding({
        source: mixedSource,
        model: "qwen3-0.6b",
        dimensions: 1024,
        version: "qwen3-0.6b",
        vector: queryVector,
        modelArtifactHash: "a".repeat(64),
        tokenizer: "qwen3-embedding-0.6b-gguf",
        inputTransform: "qwen3-retrieval-document-v1",
        pooling: "last",
        normalization: "l2"
      });
      const summaries = await createMemoryEngine(repo).searchMemory({
        requesterContext: actor,
        query: "release checklist rationale",
        scope: "personal",
        searchDomain: "global",
        repositoryContext: a,
        retrievalStage: "rollup_search",
        limit: 4
      });
      const provenance = summaries.results.find(
        (row) => row.sourceId === mixed.id
      )?.provenance;
      expect(provenance).toMatchObject({
        project: { classification: "unknown" },
        repositoryPreference: { repository: 0, branch: 0 }
      });
      expect(provenance?.lineageSessionIds).toEqual(
        expect.arrayContaining([current.session.id, foreign[0]!.session.id])
      );
      expect(provenance?.projectSources).toContainEqual({
        classification: "current",
        label: a.anchorDisplay,
        branch: "main"
      });
      expect(provenance?.projectSources).toContainEqual({
        classification: "other",
        label: b.anchorDisplay,
        branch: "main"
      });
      expect(foreign).toHaveLength(5);
      const pds = await capture(a, 0.999);
      const sourceAssignment = (branchObservation: string | null) =>
        createPdsRepositoryAssignment(
          pds.session.repositoryAssignment!,
          "1",
          Buffer.alloc(32, 17).toString("base64url"),
          { branchObservation }
        );
      const setPdsSnapshot = async (branchObservation: string | null) =>
        pool.query(
          "update sessions set metadata=jsonb_set(metadata,'{pds}',jsonb_build_object('repositoryAssignment',$2::jsonb)) where id=$1",
          [pds.session.id, JSON.stringify(sourceAssignment(branchObservation))]
        );
      // A verified PDS snapshot can deliberately omit a branch even though its
      // imported automatic identity retains the source's original branch.
      await setPdsSnapshot(null);
      expect((await search(a)).results[0]?.provenance).toMatchObject({
        project: { classification: "current", branch: null },
        repositoryPreference: { repository: 0.04, branch: 0 }
      });
      await setPdsSnapshot("main");
      expect((await search(a)).results[0]?.provenance).toMatchObject({
        project: { classification: "current", branch: "main" },
        repositoryPreference: { repository: 0.04, branch: 0.01 }
      });
      await updateSessionRepositoryOverride(pool, {
        ownerUserId: actor.userId,
        sessionId: pds.session.id,
        expectedVersion: 1,
        identity: b
      });
      expect((await search(b)).results[0]?.provenance).toMatchObject({
        project: { classification: "current", branch: null },
        repositoryPreference: { repository: 0.04, branch: 0 }
      });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
  }
);
