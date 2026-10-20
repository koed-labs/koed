import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { createMemoryEngine } from "@koed/core";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  repositoryScopeId,
  type PersonalSelectionSnapshot,
  type RepositoryIdentity
} from "@koed/shared";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository,
  createMemoryAnswerTaskRepository
} from "../src/index.js";
import {
  pinMemoryAnswerTaskSelection,
  validateMemoryAnswerTaskCompletion
} from "../src/memory-answer-task-request.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 91).toString("base64")
  )
};
const selected = (
  ownerUserId: string,
  projectId: string
): PersonalSelectionSnapshot => ({
  version: 1,
  ownerUserId,
  target: { kind: "project", project: { ownerUserId, projectId } },
  callerRepositoryContext: null
});
const git = (
  key: string
): Extract<RepositoryIdentity, { kind: "portable_repository" }> => ({
  kind: "portable_repository",
  key: `gr_${key}`,
  root: `/fixture/${key}`,
  branch: "main",
  reason: "origin",
  checkoutId: `checkout_${key}`,
  originatingDeviceId: "membership_fixture",
  selectedRemote: "origin",
  anchorDisplay: `example.test/${key}`
});

describe.skipIf(!databaseUrl)(
  "named Personal Project membership in PostgreSQL",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    afterAll(async () => {
      await pool?.end();
    });
    const user = async () => ({
      userId: (
        await createMemorySourceRepository(pool, options).createUser({
          email: `membership-${randomUUID()}@example.test`
        })
      ).id
    });
    it("persists empty Projects and retained inclusion history with owner and stale-write protection", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      let p = await repo.createNamedPersonalProject(actor, { name: "Launch" });
      const equal = await repo.createNamedPersonalProject(actor, {
        name: "Launch"
      });
      const foreign = await repo.createNamedPersonalProject(other, {
        name: "Launch"
      });
      expect(
        new Set([p.projectId, equal.projectId, foreign.projectId]).size
      ).toBe(3);
      expect(
        (await repo.listNamedPersonalProjects(actor)).map(
          (row) => row.projectId
        )
      ).toEqual([p.projectId, equal.projectId]);
      expect(
        await repo.listLcmGraphThreads(actor, {
          personalSelection: selected(actor.userId, p.projectId)
        })
      ).toEqual([]);
      const session = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: git(randomUUID()),
        metadata: { threadName: "Original Conversation" }
      });
      const foreignSession = await repo.createCapturedSession(other, {
        externalSessionId: randomUUID()
      });
      await repo.upsertCapturePolicy(actor, {
        targetType: "global",
        captureState: "disabled",
        visibility: "personal",
        pauseUntil: new Date("2030-01-01T00:00:00.000Z")
      });
      const policiesBefore = await repo.listCapturePolicies(actor);
      const before = await repo.getCapturedSession(actor, session.id);
      await expect(
        repo.addPersonalProjectSession(actor, p.projectId, {
          sessionId: foreignSession.id,
          expectedVersion: p.version
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        repo.addPersonalProjectSession(actor, foreign.projectId, {
          sessionId: session.id,
          expectedVersion: foreign.version
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        repo.createNamedPersonalProject(actor, {
          name: "Nested",
          parentProjectId: p.projectId
        } as { name: string })
      ).rejects.toThrow();
      await expect(
        repo.addPersonalProjectSession(actor, p.projectId, {
          sessionId: equal.projectId,
          expectedVersion: p.version
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      const first = await repo.addPersonalProjectSession(actor, p.projectId, {
        sessionId: session.id,
        expectedVersion: p.version
      });
      p = first.project;
      expect(first.membership.logicalSessionId).toBe(session.logicalSessionId);
      expect(first.membership.logicalSessionId).not.toBe(session.id);
      expect(first.membership.sourceReference).toBeNull();
      const duplicate = await repo.addPersonalProjectSession(
        actor,
        p.projectId,
        { sessionId: session.id, expectedVersion: p.version }
      );
      expect(duplicate).toEqual(first);
      await expect(
        repo.updateNamedPersonalProject(actor, p.projectId, {
          name: "Stale",
          expectedVersion: p.version - 1
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      p = await repo.updateNamedPersonalProject(actor, p.projectId, {
        name: "Release",
        expectedVersion: p.version
      });
      expect(p.projectId).toBe(first.project.projectId);
      const removed = await repo.removePersonalProjectInclusion(
        actor,
        p.projectId,
        first.membership.inclusionId,
        { expectedVersion: p.version }
      );
      p = removed.project;
      expect(removed.membership.removedAt).not.toBeNull();
      expect(
        await repo.listPersonalProjectMemberships(actor, p.projectId)
      ).toEqual([]);
      expect(await repo.getCapturedSession(actor, session.id)).toEqual(before);
      const addedBack = await repo.addPersonalProjectSession(
        actor,
        p.projectId,
        { sessionId: session.id, expectedVersion: p.version }
      );
      p = addedBack.project;
      expect(addedBack.membership.inclusionId).toBe(
        first.membership.inclusionId
      );
      expect(addedBack.membership.version).toBe(3);
      const journal = await pool.query<{
        operation: string;
        revision_id: string;
        replaces: string[];
      }>(
        "select operation,revision_id,replaces from personal_membership_changes where owner_user_id=$1 and project_id=$2 order by sequence",
        [actor.userId, p.projectId]
      );
      expect(journal.rows.map((row) => row.operation)).toEqual([
        "set_project",
        "include_session",
        "set_project",
        "remove_inclusion",
        "include_session"
      ]);
      expect(journal.rows[4]!.replaces).toEqual([
        removed.membership.headRevisionId
      ]);
      await expect(
        pool.query(
          "update personal_membership_changes set value='{}' where revision_id=$1",
          [first.membership.headRevisionId]
        )
      ).rejects.toThrow("immutable");
      const reconnected = createDbPool({ connectionString: databaseUrl });
      try {
        const restarted = createMemorySourceRepository(reconnected, options);
        expect(await restarted.listNamedPersonalProjects(actor)).toContainEqual(
          p
        );
        expect(
          await restarted.listPersonalProjectMemberships(actor, p.projectId)
        ).toEqual([addedBack.membership]);
      } finally {
        await reconnected.end();
      }
      const deleted = await repo.deleteNamedPersonalProject(
        actor,
        p.projectId,
        { expectedVersion: p.version }
      );
      expect(await repo.listCapturePolicies(actor)).toEqual(policiesBefore);
      expect(
        (
          await pool.query(
            "select 1 from personal_project_routes where owner_user_id=$1",
            [actor.userId]
          )
        ).rowCount
      ).toBe(0);
      expect(deleted.deletedAt).not.toBeNull();
      expect(
        (await repo.listNamedPersonalProjects(actor)).map(
          (row) => row.projectId
        )
      ).toEqual([equal.projectId]);
      expect(await repo.getCapturedSession(actor, session.id)).toEqual(before);
      expect(
        (
          await pool.query(
            "select 1 from personal_project_inclusions where inclusion_id=$1",
            [first.membership.inclusionId]
          )
        ).rowCount
      ).toBe(1);
    });

    it("recalls one Conversation through two Projects while Git attribution and live source checks stay independent", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user();
      const contexts = [git("koed"), git(randomUUID()), git(randomUUID())];
      const sources: Array<{
        session: Awaited<ReturnType<typeof repo.createCapturedSession>>;
        event: Awaited<ReturnType<typeof repo.createMemoryEvent>>;
        node: Awaited<ReturnType<typeof repo.createMemoryNode>>;
      }> = [];
      for (const [index, context] of contexts.entries()) {
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity: context,
          metadata: {
            threadName:
              index === 0
                ? "Koed repository decision"
                : `Unrelated repository decision ${index}`
          }
        });
        const event = await repo.createMemoryEvent(actor, {
          projectId: "legacy",
          sessionId: session.id,
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: `COBALT_DECISION_${index}`,
          idempotencyKey: randomUUID()
        });
        const node = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: `COBALT_SUMMARY_${index}`,
          sourceHash: randomUUID()
        });
        await pool.query(
          "update memory_nodes set source_event_count=1,lcm_algorithm_version='fixture' where id=$1",
          [node.id]
        );
        await pool.query(
          "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0)",
          [node.id, event.id]
        );
        await repo.updateLcmNodeSummary({
          nodeId: node.id,
          summaryText: `COBALT_SUMMARY_${index}`,
          summaryModel: "fixture-client",
          summaryTokenEstimate: 8,
          summaryPromptVersion: "fixture",
          summaryStructuredJson: {
            schema_version: "lcm-semantic-summary-v1",
            title: "Cobalt decision",
            summary_text: `COBALT_SUMMARY_${index}`,
            lexical_anchors: []
          },
          summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
        });
        sources.push({ session, event, node });
      }
      let p = await repo.createNamedPersonalProject(actor, { name: "Release" }),
        q = await repo.createNamedPersonalProject(actor, { name: "Research" });
      const directP = await repo.addPersonalProjectSession(actor, p.projectId, {
        sessionId: sources[0]!.session.id,
        expectedVersion: p.version
      });
      p = directP.project;
      p = (
        await repo.addPersonalProjectSession(actor, p.projectId, {
          sessionId: sources[1]!.session.id,
          expectedVersion: p.version
        })
      ).project;
      q = (
        await repo.addPersonalProjectSession(actor, q.projectId, {
          sessionId: sources[0]!.session.id,
          expectedVersion: q.version
        })
      ).project;
      q = (
        await repo.addPersonalProjectSession(actor, q.projectId, {
          sessionId: sources[2]!.session.id,
          expectedVersion: q.version
        })
      ).project;
      const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://membership.fixture");
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
      for (const source of sources)
        for (const [sourceType, sourceId] of [
          ["memory_event", source.event.id],
          ["memory_node", source.node.id]
        ] as const) {
          const embeddable = await repo.getEmbeddableSource(
            sourceType,
            sourceId
          );
          expect(embeddable).not.toBeNull();
          await repo.upsertSourceEmbedding({
            source: embeddable!,
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
      const recall = async (
        personalSelection: PersonalSelectionSnapshot,
        stage: "raw_fallback_search" | "leaf_search"
      ) =>
        (
          await createMemoryEngine(repo).searchMemory({
            requesterContext: actor,
            query: "Cobalt decision",
            scope: "personal",
            personalSelection,
            retrievalStage: stage,
            limit: 50
          })
        ).results
          .map((row) => row.sourceId)
          .sort();
      expect(
        await recall(selected(actor.userId, p.projectId), "raw_fallback_search")
      ).toEqual([sources[0]!.event.id, sources[1]!.event.id].sort());
      expect(
        await recall(selected(actor.userId, q.projectId), "raw_fallback_search")
      ).toEqual([sources[0]!.event.id, sources[2]!.event.id].sort());
      expect(
        await recall(selected(actor.userId, p.projectId), "leaf_search")
      ).toEqual([sources[0]!.node.id, sources[1]!.node.id].sort());
      const gitSelection: PersonalSelectionSnapshot = {
        version: 1,
        ownerUserId: actor.userId,
        target: { kind: "repository", repository: contexts[0]! },
        callerRepositoryContext: null
      };
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual([
        sources[0]!.event.id
      ]);
      const proposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "COBALT_COMBINED_CLAIM",
        evidenceMemoryEventIds: [sources[0]!.event.id, sources[1]!.event.id]
      });
      const curated = await repo.processCuratedMemoryProposal(actor, {
        proposalId: proposal.id,
        decision: "store",
        assertion: {
          assertionText: "COBALT_COMBINED_CLAIM",
          sources: sources.slice(0, 2).map((source) => ({
            sourceType: "memory_event" as const,
            sourceRole: "primary_evidence" as const,
            memoryEventId: source.event.id
          }))
        }
      });
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "COBALT_COMBINED_CLAIM",
            personalSelection: selected(actor.userId, p.projectId)
          })
        ).map((row) => row.id)
      ).toContain(curated.assertionId);
      expect(
        await repo.searchCuratedMemoryAssertions(actor, {
          query: "COBALT_COMBINED_CLAIM",
          personalSelection: selected(actor.userId, q.projectId)
        })
      ).toEqual([]);
      const expanded = await repo.expandMemoryNode(
        curated.assertionId!,
        actor,
        { personalSelection: selected(actor.userId, q.projectId) }
      );
      expect(expanded.sources.map((row) => row.id)).toEqual([
        sources[0]!.event.id
      ]);
      const exact = await repo.listLcmGraphEvents(actor, {
        personalSelection: selected(actor.userId, p.projectId),
        sessionId: sources[0]!.session.id,
        canonicalCapturedSessionEventsOnly: true
      });
      expect(exact.map((row) => row.id)).toEqual([sources[0]!.event.id]);
      const inventory = await repo.listLcmGraphThreads(actor, {
        personalSelection: selected(actor.userId, p.projectId),
        groupBySession: true
      });
      expect(
        inventory
          .flatMap((group) => group.threads.map((thread) => thread.sessionId))
          .sort()
      ).toEqual([sources[0]!.session.id, sources[1]!.session.id].sort());
      p = await repo.updateNamedPersonalProject(actor, p.projectId, {
        name: "Renamed Release",
        expectedVersion: p.version
      });
      expect(
        await recall(selected(actor.userId, p.projectId), "raw_fallback_search")
      ).toEqual([sources[0]!.event.id, sources[1]!.event.id].sort());
      // Start real durable work before its Project loses a source. The
      // accepted target remains pinned, while every read checks live membership.
      const tasks = createMemoryAnswerTaskRepository(pool, options);
      const accepted = await tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        invocationKey: randomUUID(),
        maxQueued: 16,
        request: {
          requestVersion: 1,
          selection: selected(actor.userId, p.projectId),
          input: {
            query: "Cobalt decision",
            search_domain: "project",
            project_id: p.projectId,
            repository_context: null
          },
          caller: { cwd: "/fixture/unrelated-worker-directory" }
        }
      });
      let running = (
        await tasks.claimMemoryAnswerTask(actor, {
          leaseOwner: "membership-removal-worker",
          leaseMs: 60_000
        })
      ).task!;
      expect(running.id).toBe(accepted.id);
      const pinned = running.request.selection as PersonalSelectionSnapshot;
      expect(pinned).toEqual(selected(actor.userId, p.projectId));
      let releaseEmbedding!: () => void;
      let signalEmbedding!: () => void;
      const embeddingStarted = new Promise<void>((resolve) => {
        signalEmbedding = resolve;
      });
      const embeddingReleased = new Promise<void>((resolve) => {
        releaseEmbedding = resolve;
      });
      vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
        signalEmbedding();
        await embeddingReleased;
        return new Response(
          JSON.stringify({
            model: "qwen3-0.6b",
            dimensions: 1024,
            vectors: [vector]
          }),
          { status: 200 }
        );
      });
      const searchingDuringRemoval = recall(pinned, "raw_fallback_search");
      await embeddingStarted;
      p = (
        await repo.removePersonalProjectInclusion(
          actor,
          p.projectId,
          directP.membership.inclusionId,
          { expectedVersion: p.version }
        )
      ).project;
      releaseEmbedding();
      expect(await searchingDuringRemoval).toEqual([sources[1]!.event.id]);
      expect(
        await recall(selected(actor.userId, p.projectId), "raw_fallback_search")
      ).toEqual([sources[1]!.event.id]);
      expect(
        await recall(selected(actor.userId, p.projectId), "leaf_search")
      ).toEqual([sources[1]!.node.id]);
      expect(
        await repo.getLcmGraphNode(actor, sources[0]!.node.id, {
          personalSelection: selected(actor.userId, p.projectId)
        })
      ).toBeNull();
      expect(
        (
          await repo.expandMemoryNode(curated.assertionId!, actor, {
            personalSelection: selected(actor.userId, p.projectId)
          })
        ).sources.map((row) => row.id)
      ).toEqual([sources[1]!.event.id]);
      expect(
        await repo.searchCuratedMemoryAssertions(actor, {
          query: "COBALT_COMBINED_CLAIM",
          personalSelection: selected(actor.userId, p.projectId)
        })
      ).toEqual([]);
      await pool.query(
        "update memory_answer_tasks set lease_until=now()-interval '1 second' where id=$1",
        [running.id]
      );
      const replacementWorker = createMemoryAnswerTaskRepository(pool, options);
      const recovered = (
        await replacementWorker.claimMemoryAnswerTask(actor, {
          leaseOwner: "replacement-after-removal",
          leaseMs: 60_000
        })
      ).task!;
      expect(recovered.request).toEqual(running.request);
      running = recovered;
      const liveResult = await recall(pinned, "raw_fallback_search");
      expect(liveResult).toEqual([sources[1]!.event.id]);
      await tasks.completeMemoryAnswerTask(actor, {
        taskId: running.id,
        leaseOwner: running.leaseOwner,
        fenceGeneration: running.fenceGeneration,
        finalQuestion: {
          idempotencyKey: randomUUID(),
          query: "Cobalt decision",
          searchDomain: "project",
          projectId: p.projectId,
          status: "answered",
          answerMarkdown: "The remaining source records the cobalt decision."
        },
        result: { sourceIds: liveResult }
      });
      const restartedTasks = createMemoryAnswerTaskRepository(pool, options);
      expect(
        (await restartedTasks.getMemoryAnswerTask(actor, running.id))?.result
      ).toMatchObject({ sourceIds: [sources[1]!.event.id] });
      expect(
        (await restartedTasks.getMemoryAnswerTask(actor, running.id))?.result
      ).toEqual((await tasks.getMemoryAnswerTask(actor, running.id))?.result);
      expect(
        await recall(selected(actor.userId, q.projectId), "raw_fallback_search")
      ).toEqual([sources[0]!.event.id, sources[2]!.event.id].sort());
      await repo.deleteNamedPersonalProject(actor, p.projectId, {
        expectedVersion: p.version
      });
      expect(
        await recall(selected(actor.userId, p.projectId), "raw_fallback_search")
      ).toEqual([]);
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual([
        sources[0]!.event.id
      ]);
      const global = await createMemoryEngine(repo).searchMemory({
        requesterContext: actor,
        query: "Cobalt decision",
        scope: "personal",
        personalSelection: {
          version: 1,
          ownerUserId: actor.userId,
          target: { kind: "global" },
          callerRepositoryContext: contexts[0]!
        },
        retrievalStage: "raw_fallback_search",
        limit: 50
      });
      expect(global.results.map((row) => row.sourceId).sort()).toEqual(
        sources.map((source) => source.event.id).sort()
      );
      expect(
        global.results.find((row) => row.sourceId === sources[0]!.event.id)
          ?.provenance
      ).toMatchObject({ project: { classification: "current" } });
      expect(
        global.results.find((row) => row.sourceId === sources[1]!.event.id)
          ?.provenance
      ).toMatchObject({ project: { classification: "other" } });
      const later = await repo.createMemoryEvent(actor, {
        projectId: "legacy",
        sessionId: sources[0]!.session.id,
        actor: "user",
        visibility: "personal",
        eventType: "captured",
        rawEventType: "user_message",
        content: "LATER_COBALT_DECISION",
        idempotencyKey: randomUUID()
      });
      expect(
        (
          await repo.listLcmGraphEvents(actor, {
            personalSelection: selected(actor.userId, q.projectId),
            sessionId: sources[0]!.session.id,
            canonicalCapturedSessionEventsOnly: true
          })
        ).map((row) => row.id)
      ).toContain(later.id);
      for (const [index, source] of sources.entries())
        expect(
          (await repo.getCapturedSession(actor, source.session.id))
            ?.repositoryAssignment?.effective
        ).toEqual(contexts[index]);
      expect(
        (
          await repo.listLcmGraphThreads(actor, {
            projectId: repositoryScopeId(contexts[0]!)
          })
        ).flatMap((group) => group.threads).length
      ).toBe(1);
      // Physical source removal is a separate boundary from organization edits.
      const deletionSelection = selected(actor.userId, q.projectId);
      const deletionTask = await tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        invocationKey: randomUUID(),
        maxQueued: 16,
        request: {
          requestVersion: 1,
          selection: deletionSelection,
          input: {
            query: "Cobalt decision",
            search_domain: "project",
            project_id: q.projectId,
            repository_context: null
          }
        }
      });
      const deletionClaim = (
        await tasks.claimMemoryAnswerTask(actor, {
          leaseOwner: "source-deletion-worker",
          leaseMs: 60_000
        })
      ).task!;
      expect(deletionClaim.id).toBe(deletionTask.id);
      let releaseDeletionSearch!: () => void;
      let signalDeletionSearch!: () => void;
      const deletionSearchStarted = new Promise<void>((resolve) => {
        signalDeletionSearch = resolve;
      });
      const deletionSearchReleased = new Promise<void>((resolve) => {
        releaseDeletionSearch = resolve;
      });
      vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
        signalDeletionSearch();
        await deletionSearchReleased;
        return new Response(
          JSON.stringify({
            model: "qwen3-0.6b",
            dimensions: 1024,
            vectors: [vector]
          }),
          { status: 200 }
        );
      });
      const duringDeletion = recall(deletionSelection, "raw_fallback_search");
      await deletionSearchStarted;
      await pool.query(
        "update sessions set personal_deleted_at=now(),personal_deleted_by_user_id=$2,personal_deletion_reason='fixture_removed_during_answer' where id=$1",
        [sources[0]!.session.id, actor.userId]
      );
      releaseDeletionSearch();
      const deletionResult = await duringDeletion;
      expect(deletionResult).toEqual([sources[2]!.event.id]);
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual([]);
      await expect(
        repo.expandMemoryNode(curated.assertionId!, actor, {
          personalSelection: deletionSelection
        })
      ).rejects.toThrow("Memory node not found or not visible");
      expect(
        await repo.getLcmGraphNode(actor, sources[0]!.node.id, {
          personalSelection: deletionSelection
        })
      ).toBeNull();
      expect(
        await repo.listLcmGraphEvents(actor, {
          personalSelection: deletionSelection,
          sessionId: sources[0]!.session.id,
          canonicalCapturedSessionEventsOnly: true
        })
      ).toEqual([]);
      await tasks.completeMemoryAnswerTask(actor, {
        taskId: deletionTask.id,
        leaseOwner: deletionClaim.leaseOwner,
        fenceGeneration: deletionClaim.fenceGeneration,
        finalQuestion: {
          idempotencyKey: randomUUID(),
          query: "Cobalt decision",
          searchDomain: "project",
          projectId: q.projectId,
          status: "answered",
          answerMarkdown: "Only the unrelated surviving source remains."
        },
        result: { sourceIds: deletionResult }
      });
      expect(
        (await tasks.getMemoryAnswerTask(actor, deletionTask.id))?.result
      ).toMatchObject({ sourceIds: [sources[2]!.event.id] });
    });

    it("serializes concurrent stale writes and retains one direct inclusion", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user();
      const p = await repo.createNamedPersonalProject(actor, {
          name: "Concurrent"
        }),
        session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID()
        });
      const results = await Promise.allSettled([
        repo.addPersonalProjectSession(actor, p.projectId, {
          sessionId: session.id,
          expectedVersion: 1
        }),
        repo.addPersonalProjectSession(actor, p.projectId, {
          sessionId: session.id,
          expectedVersion: 1
        })
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(
        rejected?.status === "rejected" ? rejected.reason : null
      ).toMatchObject({ statusCode: 409 });
      expect(
        await repo.listPersonalProjectMemberships(actor, p.projectId)
      ).toHaveLength(1);
      expect(
        (
          await pool.query(
            "select 1 from personal_membership_changes where owner_user_id=$1 and project_id=$2 and operation='include_session'",
            [actor.userId, p.projectId]
          )
        ).rowCount
      ).toBe(1);
    });

    it("pins named Project Ask scope and rejects retry or thread scope changes", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      const p = await repo.createNamedPersonalProject(actor, {
        name: "Decision history"
      });
      const idempotencyKey = randomUUID();
      const ask = await repo.createPendingDesktopAsk(actor, {
        namedProjectId: p.projectId,
        idempotencyKey,
        query: "What did we decide?"
      });
      expect(ask).toMatchObject({
        searchDomain: "project",
        projectId: p.projectId
      });
      await expect(
        repo.createPendingDesktopAsk(actor, { idempotencyKey, query: "Retry" })
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        repo.createPendingDesktopAsk(actor, {
          askThreadId: ask.askThreadId!,
          idempotencyKey: randomUUID(),
          query: "Global follow-up"
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        repo.createPendingDesktopAsk(other, {
          namedProjectId: p.projectId,
          idempotencyKey: randomUUID(),
          query: "Foreign"
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      const snapshot = {
        requestVersion: 1,
        selection: selected(actor.userId, p.projectId),
        input: {
          query: "What did we decide?",
          search_domain: "project",
          project_id: p.projectId,
          repository_context: null
        }
      };
      expect(pinMemoryAnswerTaskSelection(snapshot, actor.userId)).toEqual(
        snapshot
      );
      expect(() =>
        validateMemoryAnswerTaskCompletion(snapshot, null, {
          query: "What did we decide?",
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: p.projectId
        })
      ).not.toThrow();
    });
  }
);
