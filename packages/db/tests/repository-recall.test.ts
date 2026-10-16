import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createMemoryEngine } from "@koed/core";
import {
  createPdsRepositoryAssignment,
  repositoryScopeId,
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

    it("moves a whole fallback Project beyond the Desktop page limit into a rootless identity", async () => {
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
      expect(
        await repo.moveProjectConversations(actor, {
          sourceProjectId: repositoryScopeId(source),
          project
        })
      ).toEqual({ movedCount: 503, projectId: project.id });
      const counts = await pool.query<{ count: number }>(
        "select count(*)::int as count from sessions where owner_user_id=$1 and repository_scope_matches(repository_override_identity,$2)",
        [owner.id, project.id]
      );
      expect(counts.rows[0]?.count).toBe(503);
      expect(
        (await repo.listLcmGraphThreads(actor, { projectId: project.id }))[0]
          ?.path
      ).toBeNull();
      expect(
        (await repo.getCapturedSession({ userId: other.id }, otherSession.id))
          ?.repositoryAssignment?.effective
      ).toEqual(source);
      expect(
        (await repo.getCapturedSession(actor, captured.id))
          ?.repositoryAssignment
      ).toMatchObject({ automatic: source, effective: named, version: 2 });
      expect(
        (
          await repo.getLatestCapturedSessionForProject(actor, {
            projectId: project.id
          })
        )?.repositoryAssignment?.effective
      ).toEqual(named);
      expect(
        await repo.getLatestCapturedSessionForProject(actor, {
          projectId: repositoryScopeId(source)
        })
      ).toBeNull();
      expect(
        (
          await pool.query("select id from memory_events where id=$1", [
            event.id
          ])
        ).rowCount
      ).toBe(1);
      expect(
        await repo.moveProjectConversations(actor, {
          sourceProjectId: repositoryScopeId(source),
          project
        })
      ).toEqual({ movedCount: 0, projectId: project.id });
      expect(
        (await repo.resetCapturedSessionProject(actor, captured.id, 2))
          ?.repositoryAssignment
      ).toMatchObject({ effective: source, version: 3 });
      const later = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: source
      });
      expect(later.repositoryAssignment).toMatchObject({
        automatic: source,
        effective: named,
        version: 2
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

    it("serializes a Project move with concurrent capture so no new Conversation escapes its route", async () => {
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
      const completed = await Promise.all(captures);
      await move;
      for (const session of completed)
        expect(
          (await repo.getCapturedSession(actor, session.id))
            ?.repositoryAssignment
        ).toMatchObject({ automatic: source, effective: target });
    });

    it("flattens future routing and preserves explicit resets and unresolved history", async () => {
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `project-routes-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id },
        source = identity(randomUUID());
      const named = (name: string): RepositoryIdentity => ({
        kind: "local_project",
        key: name,
        reason: "manual",
        root: null,
        branch: null,
        checkoutId: null,
        selectedRemote: null,
        anchorDisplay: null,
        originatingDeviceId: "fixture"
      });
      const b = named("project_b"),
        c = named("project_c");
      const target = (value: RepositoryIdentity) => ({
        id: repositoryScopeId(value),
        name: value.key!,
        path: value.root,
        repositoryIdentity: value
      });
      await repo.createCapturedSession(actor, { repositoryIdentity: source });
      await repo.moveProjectConversations(actor, {
        sourceProjectId: repositoryScopeId(source),
        project: target(b)
      });
      await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: source
      });
      expect(
        await repo.moveProjectConversations(actor, {
          sourceProjectId: repositoryScopeId(b),
          project: target(c)
        })
      ).toMatchObject({ movedCount: 2, projectId: repositoryScopeId(c) });
      expect(
        await repo.resolveProjectRouting(actor, repositoryScopeId(source))
      ).toMatchObject({ repositoryIdentity: c });
      await expect(
        repo.moveProjectConversations(actor, {
          sourceProjectId: repositoryScopeId(c),
          project: target(source)
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      const next = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: source
      });
      expect(next.repositoryAssignment).toMatchObject({
        automatic: source,
        effective: c
      });
      await repo.resetCapturedSessionProject(actor, next.id, 2);
      const continued = await repo.createCapturedSession(actor, {
        externalSessionId: next.externalSessionId!,
        repositoryIdentity: source
      });
      expect(continued.repositoryAssignment).toMatchObject({
        override: null,
        effective: source,
        version: 3
      });
      const old = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID()
      });
      await pool.query(
        "update sessions set repository_assignment_state='historical_unresolved', repository_automatic_identity=null where id=$1",
        [old.id]
      );
      const historical = await repo.createCapturedSession(actor, {
        externalSessionId: old.externalSessionId!,
        repositoryIdentity: source
      });
      expect(historical.repositoryAssignment?.effective).toBeNull();
      await repo.moveProjectConversations(actor, {
        sourceProjectId: "unassigned",
        project: target(c)
      });
      expect(await repo.resolveProjectRouting(actor, "unassigned")).toBeNull();
      expect(
        (await repo.resetCapturedSessionProject(actor, old.id, 2))
          ?.repositoryAssignment?.effective
      ).toBeNull();
    });

    it("rolls back a whole Project move if any member cannot advance its version", async () => {
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
      await repo.moveCapturedSessionToProject(actor, overlap.session.id, {
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
      await repo.resetCapturedSessionProject(actor, overlap.session.id, 2);
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
