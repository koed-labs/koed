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
  personalFolderScopeId,
  type PersonalFolderObservation,
  type PersonalFolderReference,
  type PersonalSelectionSnapshot,
  type PersonalGitContext
} from "@koed/shared";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 94).toString("base64")
  )
};
const folder = (
  path: string,
  identity: Partial<PersonalFolderObservation["identity"]> = {}
): PersonalFolderObservation => ({
  identity: {
    folderId: randomUUID(),
    originatingDeploymentId: "deployment",
    originatingDeviceId: "device",
    originatingProfileId: "profile",
    directoryIncarnationId: randomUUID(),
    ...identity
  },
  normalizedPath: path,
  capturedPath: `${path}/.`,
  observedAt: new Date().toISOString()
});
const git: PersonalGitContext = {
  kind: "portable_repository",
  key: "gr_folder_rule",
  root: "/repo",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/repo"
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

describe.skipIf(!databaseUrl)(
  "exact Folder inclusion rules in PostgreSQL",
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
          email: `folder-rule-${randomUUID()}@example.test`
        })
      ).id
    });

    it("requires established owned context and retains Folder provenance and removal history after source deletion", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      const observed = folder("/repo/sub"),
        reference = { ...observed.identity, ownerUserId: actor.userId };
      let project = await repo.createNamedPersonalProject(actor, {
        name: "Release"
      });
      await expect(
        repo.addPersonalProjectFolderRule(actor, project.projectId, {
          expectedVersion: project.version,
          folder: reference
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        repo.addPersonalProjectFolderRule(actor, project.projectId, {
          expectedVersion: project.version,
          folder: { ...reference, ownerUserId: other.userId }
        })
      ).rejects.toMatchObject({ statusCode: 403 });
      const source = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        folderObservation: observed,
        repositoryIdentity: git
      });
      const initial = await repo.addPersonalProjectFolderRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, folder: reference }
      );
      project = initial.project;
      expect(initial.rule.folderContext).toEqual({
        reference,
        normalizedPath: observed.normalizedPath,
        capturedPath: observed.capturedPath
      });
      expect(initial.rule.target).toEqual({
        kind: "folder",
        folder: reference
      });
      expect(
        await repo.addPersonalProjectFolderRule(actor, project.projectId, {
          expectedVersion: project.version,
          folder: reference
        })
      ).toEqual(initial);
      expect(
        await repo.getPersonalProjectFolderRuleContext(
          actor,
          project.projectId,
          reference
        )
      ).toEqual(initial.rule.folderContext);
      expect(
        await repo.listPersonalProjectRules(other, project.projectId)
      ).toEqual([]);
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
      project = removed.project;
      await pool.query(
        "update sessions set personal_deleted_at=now() where id=$1",
        [source.id]
      );
      const back = await repo.addPersonalProjectFolderRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, folder: reference }
      );
      expect(back.rule.inclusionId).toBe(initial.rule.inclusionId);
      expect(back.rule.version).toBe(3);
      expect(back.rule.folderContext).toEqual(initial.rule.folderContext);
      expect(
        await repo.getCapturedSession(actor, source.id, {
          personalSelection: selected(actor.userId, project.projectId)
        })
      ).toBeNull();
      const changes = await pool.query<{
        revision_id: string;
        replaces: string[];
        operation: string;
      }>(
        "select revision_id,replaces,operation from personal_membership_changes where owner_user_id=$1 and entity_id=$2 order by sequence",
        [actor.userId, initial.rule.inclusionId]
      );
      expect(changes.rows.map((row) => row.operation)).toEqual([
        "include_folder",
        "remove_inclusion",
        "include_folder"
      ]);
      expect(changes.rows[1]!.replaces).toEqual([changes.rows[0]!.revision_id]);
      expect(changes.rows[2]!.replaces).toEqual([changes.rows[1]!.revision_id]);
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
      const foreign = { ...reference, ownerUserId: other.userId };
      await expect(
        pool.query(
          "insert into personal_project_rules(owner_user_id,project_id,target,target_scope,head_revision_id) values($1,$2,$3,$4,$5)",
          [
            actor.userId,
            project.projectId,
            { kind: "folder", folder: foreign },
            personalFolderScopeId(foreign),
            randomUUID()
          ]
        )
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("selects only the exact origin across inventory, raw/derived recall, future capture and expansion", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user();
      const parent = folder("/repo"),
        exact = folder("/repo/sub");
      const contexts: Array<PersonalFolderObservation | undefined> = [
        parent,
        exact,
        folder("/repo/sub/child"),
        folder(exact.normalizedPath, {
          ...exact.identity,
          originatingDeviceId: "another_device"
        }),
        folder(exact.normalizedPath, {
          ...exact.identity,
          originatingProfileId: "another_profile"
        }),
        folder(exact.normalizedPath, {
          ...exact.identity,
          directoryIncarnationId: randomUUID()
        }),
        undefined
      ];
      const makeSource = async (
        context: PersonalFolderObservation | undefined,
        label: string,
        repository = git
      ) => {
        const session = await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          folderObservation: context,
          repositoryIdentity: repository,
          cwd: context?.capturedPath ?? exact.capturedPath,
          importObservedAt: context ? undefined : new Date().toISOString()
        });
        const event = await repo.createMemoryEvent(actor, {
          sessionId: session.id,
          projectId: "legacy",
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: `FOLDER_RULE_DECISION_${label}`,
          idempotencyKey: randomUUID()
        });
        const node = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: `FOLDER_RULE_SUMMARY_${label}`,
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
          summaryText: `FOLDER_RULE_SUMMARY_${label}`,
          summaryModel: "fixture-client",
          summaryTokenEstimate: 8,
          summaryPromptVersion: "fixture",
          summaryStructuredJson: {
            schema_version: "lcm-semantic-summary-v1",
            title: label,
            summary_text: `FOLDER_RULE_SUMMARY_${label}`,
            lexical_anchors: []
          },
          summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
        });
        return { session, event, node };
      };
      const sources: Array<Awaited<ReturnType<typeof makeSource>>> = [];
      for (const [index, context] of contexts.entries())
        sources.push(await makeSource(context, String(index)));
      const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://folder-rule.fixture");
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
      const reference: PersonalFolderReference = {
        ...exact.identity,
        ownerUserId: actor.userId
      };
      const before = await Promise.all(
        sources.map((source) =>
          repo.getCapturedSession(actor, source.session.id)
        )
      );
      const added = await repo.addPersonalProjectFolderRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, folder: reference }
      );
      project = added.project;
      expect(
        await Promise.all(
          sources.map((source) =>
            repo.getCapturedSession(actor, source.session.id)
          )
        )
      ).toEqual(before);
      const picked = selected(actor.userId, project.projectId),
        folderSelection: PersonalSelectionSnapshot = {
          version: 1,
          ownerUserId: actor.userId,
          target: { kind: "folder", folder: reference },
          callerRepositoryContext: null
        },
        gitSelection: PersonalSelectionSnapshot = {
          version: 1,
          ownerUserId: actor.userId,
          target: { kind: "repository", repository: git },
          callerRepositoryContext: null
        };
      const recall = async (
        personalSelection: PersonalSelectionSnapshot,
        stage: "raw_fallback_search" | "leaf_search"
      ) =>
        (
          await createMemoryEngine(repo).searchMemory({
            requesterContext: actor,
            query: "Folder rule decision",
            scope: "personal",
            personalSelection,
            retrievalStage: stage,
            limit: 50
          })
        ).results
          .map((row) => row.sourceId)
          .sort();
      expect(await recall(picked, "raw_fallback_search")).toEqual([
        sources[1]!.event.id
      ]);
      expect(await recall(picked, "leaf_search")).toEqual([
        sources[1]!.node.id
      ]);
      expect(
        (
          await repo.listLcmGraphThreads(actor, {
            personalSelection: picked,
            groupBySession: true
          })
        ).flatMap((group) => group.threads.map((thread) => thread.sessionId))
      ).toEqual([sources[1]!.session.id]);
      const reasons = await repo.listPersonalProjectMembershipReasons(
        actor,
        project.projectId,
        sources.map((source) => source.session.id)
      );
      expect(reasons).toEqual([
        {
          sessionId: sources[1]!.session.id,
          logicalSessionId: sources[1]!.session.logicalSessionId,
          reasons: [
            {
              inclusionId: added.rule.inclusionId,
              revisionId: added.rule.headRevisionId,
              kind: "folder"
            }
          ]
        }
      ]);
      const future = await makeSource(exact, "future", {
        ...git,
        key: "gr_changed_anchor"
      });
      await embed(future);
      expect(await recall(picked, "raw_fallback_search")).toEqual(
        [sources[1]!.event.id, future.event.id].sort()
      );
      expect(await recall(folderSelection, "raw_fallback_search")).toEqual(
        [sources[1]!.event.id, future.event.id].sort()
      );
      expect(await recall(gitSelection, "raw_fallback_search")).toEqual(
        sources.map((source) => source.event.id).sort()
      );
      const proposal = await repo.createCuratedMemoryProposal(actor, {
        proposedClaim: "EXACT_FOLDER_RULE_CLAIM",
        evidenceMemoryEventIds: [sources[1]!.event.id, future.event.id]
      });
      const curated = await repo.processCuratedMemoryProposal(actor, {
        proposalId: proposal.id,
        decision: "store",
        assertion: {
          assertionText: "EXACT_FOLDER_RULE_CLAIM",
          sources: [sources[1]!, future].map((source) => ({
            sourceType: "memory_event" as const,
            sourceRole: "primary_evidence" as const,
            memoryEventId: source.event.id
          }))
        }
      });
      expect(
        (
          await repo.searchCuratedMemoryAssertions(actor, {
            query: "EXACT_FOLDER_RULE_CLAIM",
            personalSelection: picked
          })
        ).map((row) => row.id)
      ).toContain(curated.assertionId);
      project = (
        await repo.addPersonalProjectSession(actor, project.projectId, {
          expectedVersion: project.version,
          sessionId: sources[1]!.session.id
        })
      ).project;
      const both = await repo.listPersonalProjectMembershipReasons(
        actor,
        project.projectId,
        [sources[1]!.session.id]
      );
      expect(both[0]!.reasons.map((reason) => reason.kind).sort()).toEqual([
        "folder",
        "session"
      ]);
      await repo.removePersonalProjectRule(
        actor,
        project.projectId,
        added.rule.inclusionId,
        { expectedVersion: project.version }
      );
      expect(await recall(picked, "raw_fallback_search")).toEqual([
        sources[1]!.event.id
      ]);
      expect(await recall(picked, "leaf_search")).toEqual([
        sources[1]!.node.id
      ]);
      expect(
        await repo.searchCuratedMemoryAssertions(actor, {
          query: "EXACT_FOLDER_RULE_CLAIM",
          personalSelection: picked
        })
      ).toEqual([]);
      expect(
        (
          await repo.expandMemoryNode(curated.assertionId!, actor, {
            personalSelection: picked
          })
        ).sources.map((row) => row.id)
      ).toEqual([sources[1]!.event.id]);
      expect(await recall(folderSelection, "raw_fallback_search")).toEqual(
        [sources[1]!.event.id, future.event.id].sort()
      );
      expect(
        await repo.getCapturedSession(actor, sources[2]!.session.id, {
          personalSelection: picked
        })
      ).toBeNull();
    });

    it("returns all direct, Git and Folder reasons once per source and obeys live context corrections", async () => {
      const repo = createMemorySourceRepository(pool, options),
        actor = await user(),
        other = await user();
      const observed = folder("/repo/sub"),
        reference = { ...observed.identity, ownerUserId: actor.userId };
      const source = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: git,
        folderObservation: observed
      });
      let project = await repo.createNamedPersonalProject(actor, {
        name: "Release"
      });
      project = (
        await repo.addPersonalProjectSession(actor, project.projectId, {
          expectedVersion: project.version,
          sessionId: source.id
        })
      ).project;
      const gitRule = await repo.addPersonalProjectRepositoryRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, repository: git }
      );
      project = gitRule.project;
      const folderRule = await repo.addPersonalProjectFolderRule(
        actor,
        project.projectId,
        { expectedVersion: project.version, folder: reference }
      );
      project = folderRule.project;
      const reasons = () =>
        repo.listPersonalProjectMembershipReasons(actor, project.projectId, [
          source.id,
          source.id
        ]);
      expect(
        (await reasons())[0]!.reasons.map((reason) => reason.kind).sort()
      ).toEqual(["folder", "repository", "session"]);
      expect(
        await repo.listPersonalProjectMembershipReasons(
          other,
          project.projectId,
          [source.id]
        )
      ).toEqual([]);
      await pool.query("update sessions set folder_assignment=$2 where id=$1", [
        source.id,
        {
          ...source.folderAssignment!,
          revision: 2,
          correction: {
            state: "corrected",
            revisionId: randomUUID(),
            value: { state: "unresolved", reason: "explicit_unresolved" }
          }
        }
      ]);
      expect(
        (await reasons())[0]!.reasons.map((reason) => reason.kind).sort()
      ).toEqual(["repository", "session"]);
      project = (
        await repo.removePersonalProjectRule(
          actor,
          project.projectId,
          gitRule.rule.inclusionId,
          { expectedVersion: project.version }
        )
      ).project;
      expect(
        (await reasons())[0]!.reasons.map((reason) => reason.kind)
      ).toEqual(["session"]);
      await pool.query("update sessions set folder_assignment=$2 where id=$1", [
        source.id,
        { ...source.folderAssignment!, revision: 3 }
      ]);
      expect(
        (await reasons())[0]!.reasons.map((reason) => reason.kind).sort()
      ).toEqual(["folder", "session"]);
    });
  }
);
