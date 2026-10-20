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
  type PersonalGitContext,
  type PersonalSelectionSnapshot
} from "@koed/shared";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 93).toString("base64")
  )
};
const git = (
  key: string,
  changes: Partial<PersonalGitContext> = {}
): PersonalGitContext => ({
  kind: "portable_repository",
  key: `gr_${key}`,
  root: `/fixture/${key}`,
  branch: "main",
  reason: "origin",
  checkoutId: `checkout_${key}`,
  originatingDeviceId: "rule_device",
  selectedRemote: "origin",
  anchorDisplay: `example.test/${key}`,
  ...changes
});
const selection = (
  ownerUserId: string,
  projectId: string
): PersonalSelectionSnapshot => ({
  version: 1,
  ownerUserId,
  target: { kind: "project", project: { ownerUserId, projectId } },
  callerRepositoryContext: null
});

describe.skipIf(!databaseUrl)(
  "Git Anchor inclusion rules in PostgreSQL",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    const user = async () => ({
      userId: (
        await createMemorySourceRepository(pool, options).createUser({
          email: `rule-${randomUUID()}@example.test`
        })
      ).id
    });

    it("keeps device-local Git rules bound to one device and rejects non-Git targets", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user();
      let project = await repo.createNamedPersonalProject(actor, {
        name: "Local work"
      });
      const local = git("local", {
        kind: "device_local_repository",
        reason: "local_fallback",
        selectedRemote: null,
        anchorDisplay: null
      });
      const contexts = [
        local,
        { ...local, originatingDeviceId: "other_device" },
        git("local")
      ];
      const sessions = [];
      for (const repository of contexts) {
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity: repository
        });
        await repo.createMemoryEvent(actor, {
          sessionId: session.id,
          projectId: "legacy",
          visibility: "personal",
          actor: "user",
          eventType: "captured",
          rawEventType: "user_message",
          content: "Local decision",
          idempotencyKey: randomUUID()
        });
        sessions.push(session);
      }
      project = (
        await repo.addPersonalProjectRepositoryRule(actor, project.projectId, {
          expectedVersion: project.version,
          repository: local
        })
      ).project;
      const picked = selection(actor.userId, project.projectId);
      expect(
        await repo.getCapturedSession(actor, sessions[0]!.id, {
          personalSelection: picked
        })
      ).not.toBeNull();
      expect(
        await repo.getCapturedSession(actor, sessions[1]!.id, {
          personalSelection: picked
        })
      ).toBeNull();
      expect(
        await repo.getCapturedSession(actor, sessions[2]!.id, {
          personalSelection: picked
        })
      ).toBeNull();
      project = (
        await repo.addPersonalProjectRepositoryRule(actor, project.projectId, {
          expectedVersion: project.version,
          repository: git("local")
        })
      ).project;
      expect(
        await repo.getCapturedSession(actor, sessions[2]!.id, {
          personalSelection: picked
        })
      ).not.toBeNull();
      for (const kind of ["non_git_project", "unresolved", "local_project"])
        await expect(
          repo.addPersonalProjectRepositoryRule(actor, project.projectId, {
            expectedVersion: project.version,
            repository: { ...local, kind } as PersonalGitContext
          })
        ).rejects.toThrow();
      expect(
        await repo.listPersonalProjectRules(actor, project.projectId)
      ).toHaveLength(2);
    });

    it("retains versioned rule identities, owner isolation, causal removals and duplicate/re-add behavior", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      let project = await repo.createNamedPersonalProject(actor, {
        name: "Release"
      });
      const initial = await repo.addPersonalProjectRepositoryRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, repository: git("b") }
      );
      project = initial.project;
      expect(initial.rule.version).toBe(1);
      const cloned = git("b", {
        root: "/another/clone",
        originatingDeviceId: "another_device",
        checkoutId: "another_checkout"
      });
      expect(
        await repo.addPersonalProjectRepositoryRule(actor, project.projectId, {
          expectedVersion: project.version,
          repository: cloned
        })
      ).toEqual(initial);
      expect(
        await repo.listPersonalProjectRules(actor, project.projectId)
      ).toEqual([initial.rule]);
      expect(
        await repo.listPersonalProjectRules(other, project.projectId)
      ).toEqual([]);
      await expect(
        repo.addPersonalProjectRepositoryRule(other, project.projectId, {
          expectedVersion: project.version,
          repository: cloned
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        repo.removePersonalProjectRule(
          actor,
          project.projectId,
          initial.rule.inclusionId,
          { expectedVersion: project.version - 1 }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      const removed = await repo.removePersonalProjectRule(
        actor,
        project.projectId,
        initial.rule.inclusionId,
        { expectedVersion: project.version }
      );
      expect(removed.rule.removedAt).not.toBeNull();
      expect(
        await repo.listPersonalProjectRules(actor, project.projectId)
      ).toEqual([]);
      const back = await repo.addPersonalProjectRepositoryRule(
        actor,
        project.projectId,
        { expectedVersion: removed.project.version, repository: cloned }
      );
      expect(back.rule.inclusionId).toBe(initial.rule.inclusionId);
      expect(back.rule.version).toBe(3);
      const journal = await pool.query<{
        revision_id: string;
        replaces: string[];
        operation: string;
      }>(
        "select revision_id,replaces,operation from personal_membership_changes where owner_user_id=$1 and entity_id=$2 order by sequence",
        [actor.userId, initial.rule.inclusionId]
      );
      expect(journal.rows.map((row) => row.operation)).toEqual([
        "include_repository",
        "remove_inclusion",
        "include_repository"
      ]);
      expect(journal.rows[1]!.replaces).toEqual([journal.rows[0]!.revision_id]);
      expect(journal.rows[2]!.replaces).toEqual([journal.rows[1]!.revision_id]);
      const reconnect = createDbPool({ connectionString: databaseUrl });
      try {
        expect(
          await createMemorySourceRepository(
            reconnect,
            options
          ).listPersonalProjectRules(actor, project.projectId)
        ).toEqual([back.rule]);
      } finally {
        await reconnect.end();
      }
      await repo.deleteNamedPersonalProject(actor, project.projectId, {
        expectedVersion: back.project.version
      });
      expect(
        await repo.listPersonalProjectRules(actor, project.projectId)
      ).toEqual([]);
      expect(
        (
          await pool.query(
            "select inclusion_id from personal_project_rules where owner_user_id=$1",
            [actor.userId]
          )
        ).rows
      ).toHaveLength(1);
    });

    it("includes existing and future matching clones without changing sources, embeddings, or independent Git recall", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user();
      const a = git("a"),
        b = git("b"),
        clone = git("b", {
          root: "/another/b",
          originatingDeviceId: "device_two",
          checkoutId: "clone_two"
        }),
        alias = git("other", { anchorDisplay: b.anchorDisplay });
      const makeSource = async (
        repository: PersonalGitContext | undefined,
        label: string
      ) => {
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity: repository,
          cwd: repository?.root ?? "/fixture/b",
          metadata: { threadName: label, remoteAliases: [b.anchorDisplay] }
        });
        const event = await repo.createMemoryEvent(actor, {
          sessionId: session.id,
          projectId: "legacy",
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: `RULE_DECISION_${label}`,
          idempotencyKey: randomUUID()
        });
        const node = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: `RULE_SUMMARY_${label}`,
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
          summaryText: `RULE_SUMMARY_${label}`,
          summaryModel: "fixture-client",
          summaryTokenEstimate: 8,
          summaryPromptVersion: "fixture",
          summaryStructuredJson: {
            schema_version: "lcm-semantic-summary-v1",
            title: label,
            summary_text: `RULE_SUMMARY_${label}`,
            lexical_anchors: []
          },
          summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
        });
        return { session, event, node };
      };
      const sources = [
        await makeSource(a, "a"),
        await makeSource(b, "b"),
        await makeSource(clone, "clone"),
        await makeSource(alias, "alias"),
        await makeSource(undefined, "unknown")
      ];
      const vector = Array.from({ length: 1024 }, (_, index) =>
        index === 0 ? 1 : 0
      );
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://rule.fixture");
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
      const embed = async (source: (typeof sources)[number]) => {
        for (const [type, id] of [
          ["memory_event", source.event.id],
          ["memory_node", source.node.id]
        ] as const) {
          const embeddable = await repo.getEmbeddableSource(type, id);
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
      };
      for (const source of sources) await embed(source);
      let project = await repo.createNamedPersonalProject(actor, {
        name: "Release"
      });
      for (const source of sources.slice(0, 2))
        project = (
          await repo.addPersonalProjectSession(actor, project.projectId, {
            expectedVersion: project.version,
            sessionId: source.session.id
          })
        ).project;
      const before = await Promise.all(
        sources.map((source) =>
          repo.getCapturedSession(actor, source.session.id)
        )
      );
      const embeddingCount = (
        await pool.query<{ count: number }>(
          "select count(*)::int as count from memory_embeddings"
        )
      ).rows[0]!.count;
      const added = await repo.addPersonalProjectRepositoryRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, repository: b }
      );
      project = added.project;
      expect(
        await Promise.all(
          sources.map((source) =>
            repo.getCapturedSession(actor, source.session.id)
          )
        )
      ).toEqual(before);
      expect(
        (
          await pool.query<{ count: number }>(
            "select count(*)::int as count from memory_embeddings"
          )
        ).rows[0]!.count
      ).toBe(embeddingCount);
      const picked = selection(actor.userId, project.projectId),
        gitSelection: PersonalSelectionSnapshot = {
          version: 1,
          ownerUserId: actor.userId,
          target: { kind: "repository", repository: b },
          callerRepositoryContext: null
        };
      const recall = async (
        personalSelection: PersonalSelectionSnapshot,
        stage: "raw_fallback_search" | "leaf_search"
      ) =>
        (
          await createMemoryEngine(repo).searchMemory({
            requesterContext: actor,
            query: "Rule decision",
            scope: "personal",
            personalSelection,
            retrievalStage: stage,
            limit: 50
          })
        ).results
          .map((row) => row.sourceId)
          .sort();
      expect(await recall(picked, "raw_fallback_search")).toEqual(
        sources
          .slice(0, 3)
          .map((source) => source.event.id)
          .sort()
      );
      expect(await recall(picked, "leaf_search")).toEqual(
        sources
          .slice(0, 3)
          .map((source) => source.node.id)
          .sort()
      );
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual(
        sources
          .slice(1, 3)
          .map((source) => source.event.id)
          .sort()
      );
      const proposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "RULE_COMBINED_CLAIM",
        evidenceMemoryEventIds: sources
          .slice(1, 3)
          .map((source) => source.event.id)
      });
      const curated = await repo.processCuratedMemoryProposal(actor, {
        proposalId: proposal.id,
        decision: "store",
        assertion: {
          assertionText: "RULE_COMBINED_CLAIM",
          sources: sources.slice(1, 3).map((source) => ({
            sourceType: "memory_event" as const,
            sourceRole: "primary_evidence" as const,
            memoryEventId: source.event.id
          }))
        }
      });
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "RULE_COMBINED_CLAIM",
            personalSelection: picked
          })
        ).map((row) => row.id)
      ).toContain(curated.assertionId);
      const future = await makeSource(
        git("b", {
          root: "/new/clone",
          originatingDeviceId: "device_three",
          checkoutId: "future_checkout"
        }),
        "future"
      );
      await embed(future);
      expect(await recall(picked, "raw_fallback_search")).toEqual(
        [
          ...sources.slice(0, 3).map((source) => source.event.id),
          future.event.id
        ].sort()
      );
      expect(
        (
          await repo.listLcmGraphThreads(actor, {
            personalSelection: picked,
            groupBySession: true
          })
        )
          .flatMap((group) => group.threads.map((thread) => thread.sessionId))
          .sort()
      ).toEqual(
        [
          ...sources.slice(0, 3).map((source) => source.session.id),
          future.session.id
        ].sort()
      );
      project = (
        await repo.removePersonalProjectRule(
          actor,
          project.projectId,
          added.rule.inclusionId,
          { expectedVersion: project.version }
        )
      ).project;
      expect(await recall(picked, "raw_fallback_search")).toEqual(
        sources
          .slice(0, 2)
          .map((source) => source.event.id)
          .sort()
      );
      expect(
        await repo.searchCuratedMemoryAssertions(actor, {
          query: "RULE_COMBINED_CLAIM",
          personalSelection: picked
        })
      ).toEqual([]);
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "RULE_COMBINED_CLAIM",
            personalSelection: gitSelection
          })
        ).map((row) => row.id)
      ).toContain(curated.assertionId);
      expect(
        (
          await repo.expandMemoryNode(curated.assertionId!, actor, {
            personalSelection: picked
          })
        ).sources.map((row) => row.id)
      ).toEqual([sources[1]!.event.id]);
      expect(await recall(picked, "leaf_search")).toEqual(
        sources
          .slice(0, 2)
          .map((source) => source.node.id)
          .sort()
      );
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual(
        [
          ...sources.slice(1, 3).map((source) => source.event.id),
          future.event.id
        ].sort()
      );
      expect(
        await repo.listPersonalProjectMemberships(actor, project.projectId)
      ).toHaveLength(2);
      const back = await repo.addPersonalProjectRepositoryRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, repository: b }
      );
      expect(back.rule.inclusionId).toBe(added.rule.inclusionId);
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        sources[2]!.session.id
      ]);
      await pool.query(
        "update sessions set personal_deleted_at=now() where id=$1",
        [future.session.id]
      );
      expect(await recall(picked, "raw_fallback_search")).toEqual(
        sources
          .slice(0, 2)
          .map((source) => source.event.id)
          .sort()
      );
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual([
        sources[1]!.event.id
      ]);
      expect(
        await repo.getCapturedSession(actor, sources[3]!.session.id, {
          personalSelection: picked
        })
      ).toBeNull();
      expect(
        await repo.getCapturedSession(actor, sources[4]!.session.id, {
          personalSelection: picked
        })
      ).toBeNull();
    });
  }
);
