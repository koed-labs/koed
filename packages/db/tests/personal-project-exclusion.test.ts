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
  type PersonalFolderObservation,
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

describe.skipIf(!databaseUrl)("Project exclusions in PostgreSQL", () => {
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
  it("retains all reasons, isolates exclusions, and atomically restores only a reviewed current revision", async () => {
    const repo = createMemorySourceRepository(pool, options);
    const actor = {
      userId: (
        await repo.createUser({ email: `exclude-${randomUUID()}@example.test` })
      ).id
    };
    const other = {
      userId: (
        await repo.createUser({ email: `exclude-${randomUUID()}@example.test` })
      ).id
    };
    const observed = folder("/repo/sub"),
      reference = { ...observed.identity, ownerUserId: actor.userId };
    const source = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: git,
      folderObservation: observed
    });
    const event = await repo.createMemoryEvent(actor, {
      projectId: "legacy",
      sessionId: source.id,
      actor: "user",
      visibility: "personal",
      eventType: "captured",
      rawEventType: "user_message",
      content: "EXCLUSION_DECISION",
      idempotencyKey: randomUUID()
    });
    const node = await repo.createMemoryNode(actor, {
      visibility: "personal",
      summaryText: "EXCLUSION_SUMMARY",
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
      summaryText: "EXCLUSION_SUMMARY",
      summaryModel: "fixture-client",
      summaryTokenEstimate: 8,
      summaryPromptVersion: "fixture",
      summaryStructuredJson: {
        schema_version: "lcm-semantic-summary-v1",
        title: "Exclusion",
        summary_text: "EXCLUSION_SUMMARY",
        lexical_anchors: []
      },
      summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
    });
    const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    vi.stubEnv("EMBEDDING_SERVICE_URL", "http://exclusion.fixture");
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
    for (const [type, id] of [
      ["memory_event", event.id],
      ["memory_node", node.id]
    ] as const) {
      const embeddable = await repo.getEmbeddableSource(type, id);
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
    const proposal = await repo.createCuratedMemoryProposal(actor, {
      proposedClaim: "EXCLUSION_CLAIM",
      evidenceMemoryEventIds: [event.id]
    });
    const curated = await repo.processCuratedMemoryProposal(actor, {
      proposalId: proposal.id,
      decision: "store",
      assertion: {
        assertionText: "EXCLUSION_CLAIM",
        sources: [
          {
            sourceType: "memory_event",
            sourceRole: "primary_evidence",
            memoryEventId: event.id
          }
        ]
      }
    });
    let project = await repo.createNamedPersonalProject(actor, {
      name: "Release"
    });
    const direct = await repo.addPersonalProjectSession(
      actor,
      project.projectId,
      { expectedVersion: project.version, sessionId: source.id }
    );
    project = direct.project;
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
    const another = await repo.createNamedPersonalProject(actor, {
      name: "Research"
    });
    await repo.addPersonalProjectSession(actor, another.projectId, {
      expectedVersion: another.version,
      sessionId: source.id
    });
    const picked = selected(actor.userId, project.projectId);
    const inspect = () =>
      repo.explainPersonalProjectSession(actor, project.projectId, {
        expectedVersion: project.version,
        sessionId: source.id
      });
    const recall = async (
      selection: PersonalSelectionSnapshot,
      stage: "raw_fallback_search" | "leaf_search"
    ) =>
      (
        await createMemoryEngine(repo).searchMemory({
          requesterContext: actor,
          query: "EXCLUSION_DECISION",
          scope: "personal",
          personalSelection: selection,
          retrievalStage: stage,
          limit: 10
        })
      ).results.map((row) => row.sourceId);
    expect(
      (await inspect()).explanation.reasons.map((reason) => reason.kind).sort()
    ).toEqual(["folder", "repository", "session"]);
    project = (
      await repo.removePersonalProjectInclusion(
        actor,
        project.projectId,
        direct.membership.inclusionId,
        { expectedVersion: project.version }
      )
    ).project;
    expect(
      (await inspect()).explanation.reasons.map((reason) => reason.kind).sort()
    ).toEqual(["folder", "repository"]);
    expect(await recall(picked, "raw_fallback_search")).toEqual([event.id]);
    const excluded = await repo.excludePersonalProjectSession(
      actor,
      project.projectId,
      { expectedVersion: project.version, sessionId: source.id }
    );
    project = excluded.project;
    expect(excluded.explanation.included).toBe(false);
    expect(excluded.explanation.reasons).toHaveLength(2);
    const exclusion = excluded.explanation.exclusion!;
    expect(
      await repo.listPersonalProjectMembershipReasons(
        actor,
        project.projectId,
        [source.id]
      )
    ).toEqual([]);
    expect(await recall(picked, "raw_fallback_search")).toEqual([]);
    expect(await recall(picked, "leaf_search")).toEqual([]);
    expect(
      await repo.getCapturedSession(actor, source.id, {
        personalSelection: picked
      })
    ).toBeNull();
    expect(
      (
        await repo.listLcmGraphThreads(actor, {
          personalSelection: picked,
          groupBySession: true
        })
      ).flatMap((g) => g.threads)
    ).toEqual([]);
    expect(
      await repo.searchCuratedMemoryAssertions(actor, {
        query: "EXCLUSION_CLAIM",
        personalSelection: picked
      })
    ).toEqual([]);
    expect(
      (
        await repo.expandMemoryNode(node.id, actor, {
          personalSelection: picked
        })
      ).sources
    ).toEqual([]);
    await expect(
      repo.expandMemoryNode(curated.assertionId!, actor, {
        personalSelection: picked
      })
    ).rejects.toThrow("Memory node not found or not visible");
    for (const target of [
      { kind: "repository" as const, repository: git },
      { kind: "folder" as const, folder: reference },
      { kind: "global" as const },
      {
        kind: "project" as const,
        project: { ownerUserId: actor.userId, projectId: another.projectId }
      }
    ]) {
      const independent: PersonalSelectionSnapshot = {
        version: 1,
        ownerUserId: actor.userId,
        target,
        callerRepositoryContext: null
      };
      expect(await recall(independent, "raw_fallback_search")).toEqual([
        event.id
      ]);
      expect(await recall(independent, "leaf_search")).toEqual([node.id]);
    }
    await expect(
      repo.addPersonalProjectSession(actor, project.projectId, {
        expectedVersion: project.version,
        sessionId: source.id
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "project_session_excluded"
    });
    await expect(
      repo.explainPersonalProjectSession(other, project.projectId, {
        expectedVersion: project.version,
        sessionId: source.id
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    for (const rule of [gitRule.rule, folderRule.rule])
      project = (
        await repo.removePersonalProjectRule(
          actor,
          project.projectId,
          rule.inclusionId,
          { expectedVersion: project.version }
        )
      ).project;
    expect((await inspect()).explanation).toMatchObject({
      included: false,
      reasons: [],
      exclusion: { headRevisionId: exclusion.headRevisionId, clearedAt: null }
    });
    const restore = {
      sessionId: source.id,
      exclusionId: exclusion.exclusionId,
      expectedExclusionRevisionId: exclusion.headRevisionId,
      expectedVersion: project.version
    };
    await expect(
      repo.restorePersonalProjectSession(actor, project.projectId, {
        ...restore,
        expectedVersion: excluded.project.version
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const restored = await repo.restorePersonalProjectSession(
      actor,
      project.projectId,
      restore
    );
    project = restored.project;
    expect(restored.explanation.included).toBe(true);
    expect(restored.explanation.reasons.map((reason) => reason.kind)).toEqual([
      "session"
    ]);
    expect(restored.membership.inclusionId).toBe(direct.membership.inclusionId);
    expect(restored.explanation.exclusion!.clearedAt).not.toBeNull();
    expect(restored.explanation.exclusion!.version).toBe(2);
    expect(await recall(picked, "leaf_search")).toEqual([node.id]);
    const excludedAgain = await repo.excludePersonalProjectSession(
      actor,
      project.projectId,
      { expectedVersion: project.version, sessionId: source.id }
    );
    project = excludedAgain.project;
    expect(excludedAgain.explanation.exclusion).toMatchObject({
      exclusionId: exclusion.exclusionId,
      version: 3,
      clearedAt: null
    });
    await expect(
      repo.restorePersonalProjectSession(actor, project.projectId, {
        ...restore,
        expectedVersion: project.version
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const changes = await pool.query<{
      operation: string;
      revision_id: string;
      replaces: string[];
    }>(
      "select operation,revision_id,replaces from personal_membership_changes where owner_user_id=$1 and entity_id=$2 order by sequence",
      [actor.userId, exclusion.exclusionId]
    );
    expect(changes.rows.map((row) => row.operation)).toEqual([
      "exclude",
      "clear_exclusion",
      "exclude"
    ]);
    expect(changes.rows[1]!.replaces).toEqual([changes.rows[0]!.revision_id]);
    expect(changes.rows[2]!.replaces).toEqual([changes.rows[1]!.revision_id]);
    const reconnect = createDbPool({ connectionString: databaseUrl });
    try {
      expect(
        (
          await createMemorySourceRepository(
            reconnect,
            options
          ).explainPersonalProjectSession(actor, project.projectId, {
            expectedVersion: project.version,
            sessionId: source.id
          })
        ).explanation.exclusion
      ).toEqual(excludedAgain.explanation.exclusion);
    } finally {
      await reconnect.end();
    }
    expect(await repo.getCapturedSession(actor, source.id)).not.toBeNull();
  });
});
