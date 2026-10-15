import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createMemoryEngine } from "@koed/core";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository,
  updateSessionRepositoryOverride
} from "../src/index.js";
const databaseUrl = process.env.DATABASE_URL;
const identity = (key: string): RepositoryIdentity => ({
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
      ).toContain(curated.assertionId);
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
      const moved = await repo.moveCapturedSessionToProject(
        actor,
        first.session.id,
        {
          id: repositoryScopeId(b),
          name: "Project B",
          path: b.root,
          repositoryIdentity: b,
          expectedAssignmentVersion: 1
        }
      );
      expect(moved?.repositoryAssignment?.effective).toEqual(b);
      expect(
        await repo.moveCapturedSessionToProject(actor, first.session.id, {
          id: scope,
          name: "Stale move",
          path: a.root,
          repositoryIdentity: a,
          expectedAssignmentVersion: 1
        })
      ).toBeNull();
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
      const reset = await repo.resetCapturedSessionProject(
        actor,
        first.session.id,
        2
      );
      expect(reset?.repositoryAssignment?.effective).toEqual(a);
      expect(
        (
          await repo.listLcmGraphThreads(actor, { projectId: scope })
        )[0]?.threads.map((thread) => thread.sessionId)
      ).toContain(first.session.id);
      const outsider = await repo.createUser({
        email: `scope-outsider-${randomUUID()}@example.test`
      });
      expect(
        await repo.moveCapturedSessionToProject(
          { userId: outsider.id },
          first.session.id,
          {
            id: repositoryScopeId(b),
            name: "Unauthorized",
            path: b.root,
            repositoryIdentity: b,
            expectedAssignmentVersion: 3
          }
        )
      ).toBeNull();
      await repo.moveCapturedSessionToProject(actor, first.session.id, {
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
  }
);
